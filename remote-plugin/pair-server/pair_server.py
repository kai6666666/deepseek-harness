#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-pair —— 面向大众客户的「配对」服务。

## 它解决什么

客户装完插件，机器上没有任何隧道、没有域名、没有令牌。这个服务负责：

1. 校验**激活码**（防止白嫖 Cloudflare 配额）；
2. 在 Cloudflare 上为这台电脑建一条**专属隧道** + 一条 DNS 记录；
3. 把「子域名 + 隧道 token + 访问令牌」三样下发；
4. 让客户机器上的 `cloudflared` 用隧道 token 连上来。

之后两端就靠「手机发消息 → 隧道 → 电脑」通信，公网只跑那几行字。

## 为什么用隧道 token 而不是证书

Cloudflare 的 `POST /cfd_tunnel` 会在响应里直接带回 `token` 字段
（实测：建完立刻可用，不需要再调 `/token` 接口）。客户机器上只要
`cloudflared tunnel run --token <token>` 就能连，**不需要任何证书文件**。
这是面向大众客户的关键：零文件分发。

## 激活码存哪

`CODES_PATH`（JSON）。一个码 = 一台电脑 = 一条隧道。用过后
`usedBy` 记下隧道 id，**不能再用第二次**（除非管理脚本显式重置）。

## 安全边界

- 服务只监听 `127.0.0.1:18901`，对外由 `dsh-mux` 按 `/pair/` 前缀转发；
- 注册接口需要激活码；管理接口需要 `ADMIN_SECRET`；
- **Cloudflare token 只存在服务器上**，绝不下发给客户机（下发的只是
  那条隧道自己的 token，作用域仅限那一条隧道）。

@module dsh-pair
"""

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------------------------------------------------------------- 配置

STATE_DIR = os.environ.get("PAIR_STATE_DIR", "/workspace/dsh-pair")
CODES_PATH = os.path.join(STATE_DIR, "codes.json")
RECORDS_PATH = os.path.join(STATE_DIR, "records.json")

CF_API = "https://api.cloudflare.com/client/v4"
CF_TOKEN = os.environ.get("CF_API_TOKEN", "")
CF_ACCOUNT = os.environ.get("CF_ACCOUNT_ID", "")
CF_ZONE = os.environ.get("CF_ZONE_ID", "")
CF_ZONE_NAME = os.environ.get("CF_ZONE_NAME", "jiulingssh.xyz")

ADMIN_SECRET = os.environ.get("PAIR_ADMIN_SECRET", "")
LISTEN_HOST = os.environ.get("PAIR_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("PAIR_PORT", "18901"))

# 管理面板 HTML —— 与脚本同目录，`dsh-mux` 已把 `/pair/` 整段转进来，
# 所以不需要为它单开端口，也不需要改 mux 的分流表。
ADMIN_PAGE_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "admin_page.html"
)

# 启动自检（见 `_assert_xff_trustworthy`）探测用的**公网入口**。
# 默认就是插件里写死的那个域名 —— 自检必须走**真实的公网链路**才有意义
#（打 127.0.0.1 的话中间没有任何代理，永远看不到 Cloudflare 的行为）。
PAIR_PUBLIC_HEALTH = os.environ.get("PAIR_PUBLIC_HEALTH", "https://pair.jiulingssh.xyz")

# 客户电脑上的 cloudflared 连到本服务的 ingress 目标。
# 客户机器上的 DSH 中继固定监听 17890（见 dsh-jiuling-remote-desktop）。
RELAY_SERVICE = os.environ.get("PAIR_RELAY_SERVICE", "http://localhost:17890")

# cloudflared 分发包所在目录，以及允许分发的文件名白名单。
# ⚠️ 白名单是硬约束：这是唯一一处把服务器上的文件按名字读出来吐给公网的地方，
#    不白名单就等于把整个目录暴露出去（路径穿越也不用试了）。
CLOUDFLARED_DIR = os.environ.get("PAIR_CLOUDFLARED_DIR", os.path.join(STATE_DIR, "cloudflared"))
CLOUDFLARED_FILES = {
    "cloudflared-windows-amd64.exe",
    "cloudflared-linux-amd64",
    "cloudflared-darwin-amd64",
    "cloudflared-darwin-arm64",
}

# 子域名前缀形态：dsh-<8 位小写字母数字>
SUB_PREFIX = "dsh-"
SUB_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
SUB_RANDOM_LEN = 8

# ---- 资源上限（外部审计 P2-9）------------------------------------------
#
# 这台机器是**单点**：它一挂，全部客户的配对/重配/隧道分发同时不可用。
# 所以三个「无界」都必须封住 —— 它们的共同点是**都不需要任何凭据**就能触发：
#
#  1. 请求体长度：`Content-Length: 10^11` 就能按声明长度一直往内存里读。
#  2. socket 超时：slowloris —— 连上、发一半、永远不发完，线程一个个被占住。
#  3. 并发线程数：`ThreadingHTTPServer` 默认**每个连接一个线程、无上限**，
#     配合上面两条就是线程/内存双爆。
#
# 全部取「远大于真实用量、远小于危险量级」的值：
#  - 接口全是小 JSON，64 KiB 已是巨量（最大的 body 是 `code` + `clientSecret`）。
#  - 客户机下 cloudflared 是 55 MB，走的是**流式**发送（见 `_serve_cloudflared`），
#    不再受 body 上限约束，也不进内存。
#  - 并发 32 对「几十个客户偶尔配对」有巨大余量；真打满时新连接排队而不是爆内存。
MAX_BODY_BYTES = 64 * 1024
SOCKET_TIMEOUT = 20
MAX_CONCURRENT_REQUESTS = 32

# cloudflared 分发的**每 IP 限流**（外部审计 P2-9）。
#
# ⚠️ 这一条是**限速**，不是鉴权 —— 为什么不加鉴权见 `_serve_cloudflared` 的注释。
# 一台客户机正常装一次只下一次（之后走本机缓存），所以 10 次/小时极宽松；
# 而「加随机 query 强制回源」那种刷法会立刻被挡在这里。
CLOUDFLARED_MAX_PER_HOUR = 10
CLOUDFLARED_WINDOW = 3600
_cloudflared_hits = {}
_cloudflared_lock = threading.Lock()

_LOCK = threading.Lock()

# 「正在注册中」的激活码集合（**内存态，不落盘** —— 理由见 `register` 的 docstring）。
#
# 用途：`register` 的新建分支要在**锁外**打 3 次 Cloudflare（最长 ~75s）。
# 没有这个占位的话，同一个激活码的两个并发请求会**都**判定成「需要新建」，
# 各建一条隧道 —— 其中一条永远没人用还一直计费。
_REGISTER_INFLIGHT = set()
_REGISTER_INFLIGHT_LOCK = threading.Lock()


# ---------------------------------------------------------------- 工具


def log(msg):
    print("[%s] %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg), flush=True)


def read_json(path, default):
    """读 JSON；文件不存在或损坏时返回默认值（服务绝不因状态文件而挂）。"""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return default


def write_json(path, value):
    """原子写：先写临时文件再 rename，避免半截文件。

    ⚠️ 权限 0600（外部审计 P1-5「最小权限」）：这些文件里有令牌，
    默认的 0644 意味着**同机任何用户**都能读。
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    # ⚠️ 用 `os.open` 指定 mode 而不是「先建再 chmod」：后者有一个
    # 「文件已存在、权限未改」的窗口，同机其他用户可以趁那个窗口读到内容。
    handle = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(handle, "w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


# ---------------------------------------------------------------- 记录加密
#
# 外部审计 P1-5：`records.json` 里**全部客户**的 `accessToken` / `tunnelToken` /
# `clientSecret` 都是明文。而 §3.3 指出这台机器上同时跑着文档服务与诊断上传，
# `/workspace` 很可能也是某个 agent 的工作目录 —— 也就是说，**一次普通的
# 文件读取（不需要提权）就能拿到全部客户的电脑控制权**。
#
# 做法：**敏感字段逐个 AES-GCM 静态加密**，文件里不再出现任何明文令牌。
#
# 为什么是「逐字段加密」而不是「整份加密」：
#  - 运维/审计要能 `cat records.json` 看「有几条、绑的什么域名、什么时候注册的」
#    —— 那些字段**不是秘密**，也正是不加密时唯一有价值的部分；
#  - 出事时要能一眼看出「哪条记录的令牌被换了」，整份加密后连这个都看不出来。
#
# ⚠️ 密钥来源（按优先级）：
#  1. `PAIR_RECORD_KEY`（推荐）：独立的 32 字节 hex。**换掉它 = 旧记录全部解不开**，
#     所以要像 `admin.secret` 一样备份。
#  2. 由 `PAIR_ADMIN_SECRET` 经 scrypt 派生（兜底，保证不配也能跑）。
#     ⚠️ 这意味着**改管理口令会让所有记录解不开** —— 但它至少不比明文更差，
#     而且会在日志里明确警告。
#
# ⚠️ **拿不到 crypto 一律拒绝写**（fail-closed）：宁可在启动时明确报错，
# 也不要「悄悄退回明文」—— 那正是这条审计项要消灭的状态。
try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM as _AESGCM
except ImportError:  # pragma: no cover —— 部署环境有 cryptography
    _AESGCM = None

# 加密字段白名单：**只加真正是凭据的那几个**。
# ⚠️ 加字段时注意：解出来必须还是字符串，否则调用方（比如 `hmac.compare_digest`）
# 会因为类型不对而行为异常。
SECRET_FIELDS = ("accessToken", "tunnelToken", "clientSecret")
_ENC_PREFIX = "v1:"


def _record_key():
    """取（并缓存）记录加密密钥。

    @returns 32 字节密钥，或 `None`（拿不到 —— 调用方必须 fail-closed）。
    """
    global _RECORD_KEY
    if _RECORD_KEY is not None:
        return _RECORD_KEY
    raw = os.environ.get("PAIR_RECORD_KEY", "").strip()
    if raw:
        try:
            key = bytes.fromhex(raw)
        except ValueError:
            log("[WARN] PAIR_RECORD_KEY 不是合法的 hex，改由 PAIR_ADMIN_SECRET 派生")
            key = b""
        if len(key) == 32:
            _RECORD_KEY = key
            return _RECORD_KEY
        if key:
            log("[WARN] PAIR_RECORD_KEY 长度不是 32 字节（%d），改由 PAIR_ADMIN_SECRET 派生" % len(key))
    if ADMIN_SECRET == "":
        return None
    # ⚠️ 固定 salt 是**有意**的：密钥必须能从环境变量**确定性**重建，
    # 否则进程重启后就解不开自己的记录。这里的 salt 不是「防彩虹表」用的
    #（口令本身就是高熵随机串，不是人选的密码），只是 scrypt 的参数入口。
    _RECORD_KEY = hashlib.scrypt(
        ADMIN_SECRET.encode("utf-8"),
        salt=b"dsh-pair-records-v1",
        n=2 ** 14,
        r=8,
        p=1,
        dklen=32,
    )
    log("[WARN] 未设置 PAIR_RECORD_KEY，记录密钥由 PAIR_ADMIN_SECRET 派生。改管理口令会导致旧记录解不开。")
    return _RECORD_KEY


_RECORD_KEY = None


def _seal(value):
    """加密一个敏感字段值。

    @param value - 明文（或空串/None）。
    @returns 形如 `v1:<base64(nonce+密文)>` 的字符串；空值原样返回。
    """
    if not isinstance(value, str) or value == "":
        return value
    if value.startswith(_ENC_PREFIX):
        return value  # 已经加密过（幂等）
    key = _record_key()
    if key is None or _AESGCM is None:
        raise RuntimeError(
            "记录加密不可用（缺 cryptography 或密钥）：拒绝以明文写入凭据。"
            "请安装 cryptography 并设置 PAIR_RECORD_KEY。"
        )
    nonce = secrets.token_bytes(12)
    sealed = _AESGCM(key).encrypt(nonce, value.encode("utf-8"), None)
    return _ENC_PREFIX + base64.b64encode(nonce + sealed).decode("ascii")


def _open(value):
    """解密一个敏感字段值；解不开就原样返回（兼容加密前的老记录）。

    ⚠️ **解不开不能抛**：那会让一次「老记录还没迁移」变成整个服务 500。
    调用方拿到的仍是那个字符串（`v1:...`），凭据比对自然失败 ⇒ 安全上等价于
    「不认识这个凭据」，而这正是正确的结果。
    """
    if not isinstance(value, str) or not value.startswith(_ENC_PREFIX):
        return value
    key = _record_key()
    if key is None or _AESGCM is None:
        return value
    try:
        blob = base64.b64decode(value[len(_ENC_PREFIX):])
        return _AESGCM(key).decrypt(blob[:12], blob[12:], None).decode("utf-8")
    except Exception:  # noqa: BLE001 —— 解不开就是「不认识」，见 docstring
        return value


def load_records():
    """读记录表，**并解密敏感字段**。

    ⚠️ 所有读 `records.json` 的地方都必须走这里，不能直接 `read_json` ——
    直接读拿到的是 `v1:...`，于是 `client_secret_matches` 永远不匹配，
    症状是「所有客户突然都要重新配对」，而且完全不报错。

    @returns `{激活码: 记录}`。
    """
    raw = read_json(RECORDS_PATH, None)
    if not isinstance(raw, dict):
        return {}
    for record in raw.values():
        if isinstance(record, dict):
            for field in SECRET_FIELDS:
                if field in record:
                    record[field] = _open(record[field])
    return raw


def save_records(records):
    """写记录表，**并加密敏感字段**。

    ⚠️ 会**就地改动**传入的 dict 吗？不会 —— 是在一份副本上加密的，
    调用方手里的记录仍是明文（后续还要用）。
    """
    sealed = {}
    for code, record in records.items():
        if not isinstance(record, dict):
            sealed[code] = record
            continue
        copy = dict(record)
        for field in SECRET_FIELDS:
            if field in copy:
                copy[field] = _seal(copy[field])
        sealed[code] = copy
    write_json(RECORDS_PATH, sealed)


def cf_request(method, path, body=None, timeout=25):
    """调 Cloudflare API。

    @returns `(ok, payload)`；`payload` 是解析后的 JSON（或错误文本）。
    """
    url = CF_API + path
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Authorization", "Bearer " + CF_TOKEN)
    request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return True, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        try:
            return False, json.loads(raw)
        except ValueError:
            return False, {"raw": raw, "status": error.code}
    except Exception as error:  # noqa: BLE001 —— 网络异常统一成 (False, ...)
        return False, {"raw": repr(error)}


def cf_errors(payload):
    """把 Cloudflare 的错误结构压成一行人类可读文本。"""
    errors = payload.get("errors") if isinstance(payload, dict) else None
    if not errors:
        return json.dumps(payload, ensure_ascii=False)[:400]
    return "; ".join(
        "%s: %s" % (item.get("code"), item.get("message")) for item in errors
    )


def new_subdomain():
    """生成一个随机子域名（8 位小写字母数字）。"""
    body = "".join(secrets.choice(SUB_ALPHABET) for _ in range(SUB_RANDOM_LEN))
    return SUB_PREFIX + body


# ---------------------------------------------------------------- 业务


def device_fingerprint(device_label):
    """把客户端报的机器标识折成一个稳定的指纹。

    ⚠️ **这不是身份认证，是「同机判据」**。客户端报什么就是什么，能被伪造 ——
    它的作用只是把「客户重装插件」与「别人拿泄露的码来换令牌」分开。
    攻击者若同时拿到激活码**和**目标机器的主机名，仍能冒充；但那是两个信息，
    比单靠一个激活码的门槛高得多。

    ⚠️ **不要在这里加盐或哈希成不可读的值**：运维时要能一眼看出「这台还是那台」，
    哈希了反而查不动。主机名本身不是机密。

    @param device_label - 客户端报的机器标识（通常 `os.hostname()`）。
    @returns 归一化后的指纹；拿不到就是空串。
    """
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", as_text(device_label).strip())[:64]


def as_text(value):
    """把请求体里的字段收敛成字符串。

    ⚠️ **不这么做的后果是「无响应」而不是报错**：`{"code": 12345}` 会让
    `(activation_code or "").strip()` 抛 `AttributeError`，`BaseHTTPRequestHandler`
    不接这个异常 ⇒ 连接被直接关掉（curl 看到 `000`）。外部审计 L1。
    客户端拿到的是「网络错误」，排查时会往网络方向查，非常费时间。

    @param value - 请求体里的任意值。
    @returns 字符串（非字符串一律折成空串，交给下面的「必填」判据拒绝）。
    """
    return value if isinstance(value, str) else ""


def new_client_secret():
    """生成一把设备凭据（`clientSecret`）。"""
    return secrets.token_hex(32)


def client_secret_matches(record, provided):
    """比对设备凭据。

    ⚠️ 用 `hmac.compare_digest` 而不是 `==`：明文 `==` 会在第一个不同的字节
    处提前返回，理论上可被逐字节爆破。长度不等时先返回 False（`compare_digest`
    对不等长会抛，不能让异常把 401 变成 500）。

    @param record - 服务端记录（可能没有 `clientSecret`，见 `claim_legacy`）。
    @param provided - 客户端报上来的凭据。
    @returns 是否匹配。
    """
    expected = record.get("clientSecret", "")
    got = provided if isinstance(provided, str) else ""
    if expected == "" or got == "":
        return False
    return hmac.compare_digest(expected, got)


def record_needs_migration(record):
    """这条记录是不是「无设备凭据」的老记录（1.0.16 之前注册的）。

    ## ⚠️ 这里**只判形态，不放行**（外部审计 3.1，第二轮整改）

    第一版写过一个 `legacy_claim()`：老记录只要带**任意非空 `device`** 就放行
    一次。那是**静默接管**漏洞 —— 攻击者拿一个激活码就能拿到受害者**正在用**
    的那个 `accessToken`，而且**不轮换**，所以受害者毫无感知（隧道照跑、手机
    照连），唯一的症状是本人下次注册时被 `device-mismatch` 挡住 —— 那时已经
    太晚了。

    根因是「兼容老客户」这个动机本身：线上 7 条记录都没有 `clientSecret`，
    而它们的 `deviceFingerprint` **也全是空的**，于是那条判据只能退化成
    「激活码 + 客户端自己报的主机名」——**两样都是攻击者可控的**。
    换句话说，这条路径的安全性**不可能**高于 1.0.15，而 1.0.15 正是被审计
    打穿的那版。**加一层「一次性」并没有改变判据强度，只是让接管更难被发现。**

    所以现在**彻底删掉放行分支**：老记录一律 `legacy-needs-migration` 拒绝，
    由管理员用 `pair_admin.py migrate <码>` 显式迁移（补发 `clientSecret` +
    **轮换** `accessToken`，旧令牌立即失效）。客户机因此需要重新配对一次 ——
    这是「零客户」现状下可以接受的代价，也远好过「谁拿到码谁就能静默接管」。

    @param record - 服务端记录。
    @returns 是否是需要迁移的老记录。
    """
    return record.get("clientSecret", "") == ""


def migrate_record(activation_code):
    """给一条老记录补发设备凭据（管理端显式操作）。

    ## 为什么要轮换 `accessToken`

    `legacy_claim` 被删掉之前，任何拿到激活码的人都可能已经**静默取走**过这个
    令牌。既然无法判断有没有发生过，迁移时就必须**假定已经泄露**并换一把新的
    —— 这也是「迁移」相对「认领」唯一实质性的改进。

    老机器手里的旧令牌随即失效，它下次注册会走 `clientSecret` 路径（管理员把
    新凭据交付给客户后），或由客户重新配对。

    @param activation_code - 激活码。
    @returns `(ok, payload)`；成功时 payload 含新的 `clientSecret` 与 `accessToken`。
    """
    code = as_text(activation_code).strip()
    with _LOCK:
        records = load_records()
        record = records.get(code)
        if record is None:
            return False, {"error": "not-registered", "message": "这个激活码还没注册过"}
        if not record_needs_migration(record):
            return False, {
                "error": "already-migrated",
                "message": "这条记录已经有设备凭据了，无需迁移",
            }
        record["clientSecret"] = new_client_secret()
        record["accessToken"] = secrets.token_hex(32)
        record["migratedAt"] = int(time.time())
        records[code] = record
        save_records(records)
        log("迁移老记录 code=%s sub=%s（已轮换令牌）" % (code[:8], record.get("subdomain")))
        return True, {
            "subdomain": record["subdomain"],
            "hostname": record["hostname"],
            "clientSecret": record["clientSecret"],
            "accessToken": record["accessToken"],
        }


def register(activation_code, device_label, client_secret=None, allow_rebind=False):
    """用激活码注册一台电脑。

    幂等性：**同一个激活码重复注册会返回同一条隧道**，不会越建越多。
    这对客户很重要 —— 重装插件、改配置、App 崩溃重启都会再调一次。

    ## ⚠️ 安全边界（这条是后补的，之前是个真漏洞）

    原实现「复用已有记录时原样返回 `accessToken`」。于是**激活码本身就等于
    电脑的完全控制权** —— 谁会知道你的激活码（视频里露了、客服记录里有、
    微信聊天记录被翻），谁就能拿它调一次 `/pair/register`，把 `accessToken`
    取走，然后用那个令牌 `prompt`（在目标机上跑任意 Agent 指令）、
    `listSessions`、`fileRead`。**激活码原本只是「开通额度」的凭证，
    不该同时是「访问凭据」。**

    现在改成：**同一台机器**（指纹一致）才复用并下发凭据；换了机器就拒绝，
    除非管理员显式 `--reuse`。

    ⚠️ 复用时**不下发 `tunnelToken`**：那东西只在首次建隧道时给客户端起
    `cloudflared`，之后客户端已经存在 `pair.json` 里。每次都给等于把它也变成
    一个「凭激活码即可领取」的长期凭据。

    @param activation_code - 客户手里的激活码。
    @param device_label - 客户机标识（用于隧道命名 + 同机判据）。
    @param client_secret - 客户机上已存的设备凭据（首次注册时为 None）。
    @param allow_rebind - 允许换机器复用（管理端显式放行）。
    @returns `(ok, payload)`。

    ## ⚠️ 结构：三段式，Cloudflare 调用**在锁外**（外部审计 P2-9）

    原来整个函数（含 **3 次 CF API 调用，各 25s 超时**）都在 `with _LOCK:` 里。
    于是一次「有效但未注册」的注册请求能让**全部** `claim` / `handshake` /
    `rotate` 停摆最长 ~75s —— 任何人都能用一个未使用的激活码反复触发它。
    这是**可用性**问题，不是安全问题，但后果一样：客户配不上对。

    现在拆成三段：

    ```
    锁内  ①  读状态 + 判定（bad-code / revoked / 复用）+ 抢「注册中」占位
    锁外  ②  3 次 CF 调用（建隧道 / 配置 ingress / 建 DNS）—— 最长 ~75s，不持锁
    锁内  ③  写回记录 + 标记激活码已用
    ```

    ⚠️ **阶段 ① 的占位不能省**：不占位的话，同一个激活码的两个并发请求会**都**
    走「新建」分支，各建一条隧道 —— 其中一条永远没人用、还一直计费。
    占位是**内存态**（`_REGISTER_INFLIGHT`），不写进 `records.json`：
    写盘的话 `claim` / `handshake` / `lookup` 都会读到一条半成品记录，
    那些地方就得全部加「pending 判据」—— 一个内存集合便宜得多，也不会
    因为进程被杀而在磁盘上留下垃圾。

    ⚠️ **阶段 ③ 必须重新读 `records`**：锁外的几十秒里管理员可能已经
    `unregister` 或 `revoke` 了这条码。那种情况下刚建的隧道要**删掉**再报错，
    否则留下一条谁也指不到的孤儿隧道（§3.3 说的那个「一直计费」）。
    """
    code = as_text(activation_code).strip()
    if code == "":
        return False, {"error": "missing-code", "message": "请填写激活码"}

    with _LOCK:
        codes = read_json(CODES_PATH, {})
        entry = codes.get(code)
        if entry is None:
            return False, {"error": "bad-code", "message": "激活码无效"}
        if entry.get("revoked"):
            return False, {"error": "revoked", "message": "这个激活码已被停用"}

        records = load_records()
        existing = records.get(code)
        if existing is not None:
            # 已注册过。凭据的判据只有两条：
            #   ① 设备凭据匹配     → 就是这台机器（换主机名也认）
            #   ② 管理员显式放行   → --rebind
            # ⚠️ **没有第三条**。「老记录凭激活码认领」这条已在第二轮整改中
            # **彻底删除**（外部审计 3.1 的静默接管）—— 它唯一的凭据是
            # 「激活码 + 客户端自己报的主机名」，两者都不可信；而线上老记录的
            # `deviceFingerprint` 全是空的，那条判据实际退化成了「激活码即通行」。
            # 老记录现在一律拒绝，由 `pair_admin.py migrate` 显式迁移。
            #
            # ⚠️ **这里必须是 fail-closed 的**。1.0.15 写的是
            # `if was != "" and now != "" and was != now`，于是 `device` 传空串
            # 就把整条判据短路掉了（外部审计 S2）。
            now = device_fingerprint(device_label)
            matched = client_secret_matches(existing, client_secret)

            if not matched and not allow_rebind:
                if record_needs_migration(existing):
                    log("拒绝复用：老记录待迁移 code=%s" % code[:8])
                    return False, {
                        "error": "legacy-needs-migration",
                        "message": (
                            "这个激活码是旧版本注册的，出于安全考虑需要管理员"
                            "迁移后才能继续使用。请联系服务方处理。"
                        ),
                    }
                log(
                    "拒绝复用：凭据不符 code=%s 原=%s 现=%s"
                    % (code[:8], existing.get("deviceFingerprint", ""), now or "<空>")
                )
                return False, {
                    "error": "device-mismatch",
                    "message": (
                        "这个激活码已经绑定过另一台电脑（%s）。"
                        "如果换机是正常的，请让管理员解绑后重试。" % existing.get("deviceLabel", "未知")
                    ),
                }

            # 复用：不再消耗 Cloudflare 配额。
            log(
                "复用已有配对 code=%s sub=%s 凭据=%s"
                % (
                    code[:8],
                    existing.get("subdomain"),
                    "设备凭据" if matched else "管理员放行",
                )
            )
            # ⚠️ 轮换 `accessToken` 的判据是「**凭据可能已经外泄**」：
            #  - `matched`（设备凭据）：说明这是原机器，旧令牌没有外泄 ⇒ **不轮换**，
            #    否则会在用户无感升级时把他**已经配对好的手机**踢下线。
            #  - `allow_rebind`（管理员显式放行换机）：旧机器不该再持有令牌 ⇒ 轮换。
            if allow_rebind and not matched:
                existing["accessToken"] = secrets.token_hex(32)
            # 设备凭据同样轮换：换机时发新的，老的立刻失效。
            existing["clientSecret"] = new_client_secret()
            existing["deviceFingerprint"] = now or existing.get("deviceFingerprint", "")
            existing["deviceLabel"] = (as_text(device_label) or existing.get("deviceLabel") or "pc")[:64]
            existing["reboundAt"] = int(time.time())
            records[code] = existing
            save_records(records)
            return True, {
                "subdomain": existing["subdomain"],
                "hostname": existing["hostname"],
                "tunnelId": existing["tunnelId"],
                # ⚠️ 不返回 tunnelToken（见 docstring）。
                "accessToken": existing["accessToken"],
                "clientSecret": existing["clientSecret"],
                "reused": True,
                "rebound": True,
            }

        # ---- 新建分支：先抢「注册中」占位，锁外再打 Cloudflare ----
        with _REGISTER_INFLIGHT_LOCK:
            if code in _REGISTER_INFLIGHT:
                log("拒绝重复注册：另一请求正在注册 code=%s" % code[:8])
                return False, {
                    "error": "register-in-flight",
                    "message": "这个激活码正在注册中，请稍候重试",
                }
            _REGISTER_INFLIGHT.add(code)
        # ⚠️ 子域名去重用的快照：必须在锁内取（锁外 `records` 会变）。
        taken_subdomains = {item.get("subdomain") for item in records.values()}

    # ================= 锁外：3 次 Cloudflare 调用 =================
    try:
        subdomain = None
        for _ in range(12):
            candidate = new_subdomain()
            if candidate not in taken_subdomains:
                subdomain = candidate
                break
        if subdomain is None:
            return False, {"error": "no-subdomain", "message": "子域名生成失败，请重试"}

        hostname = "%s.%s" % (subdomain, CF_ZONE_NAME)
        label = re.sub(r"[^A-Za-z0-9_-]+", "-", (as_text(device_label) or "pc"))[:24] or "pc"

        ok, payload = cf_request(
            "POST",
            "/accounts/%s/cfd_tunnel" % CF_ACCOUNT,
            {
                "name": "dsh-%s-%s" % (subdomain, label),
                "config_src": "cloudflare",
            },
        )
        if not ok:
            return False, {
                "error": "tunnel-create-failed",
                "message": "创建隧道失败：" + cf_errors(payload),
            }
        tunnel = payload.get("result") or {}
        tunnel_id = tunnel.get("id")
        tunnel_token = tunnel.get("token")
        if not tunnel_id or not tunnel_token:
            return False, {
                "error": "tunnel-token-missing",
                "message": "隧道已建但没拿到 token，请稍后重试",
            }

        # 隧道 ingress 配置：客户机器上的 cloudflared 拉这份配置，
        # 把公网流量转给本机 17890（DSH 中继）。
        ok, payload = cf_request(
            "PUT",
            "/accounts/%s/cfd_tunnel/%s/configurations" % (CF_ACCOUNT, tunnel_id),
            {
                "config": {
                    "ingress": [
                        {"hostname": hostname, "service": RELAY_SERVICE},
                        {"service": "http_status:404"},
                    ]
                }
            },
        )
        if not ok:
            cf_request(
                "DELETE", "/accounts/%s/cfd_tunnel/%s" % (CF_ACCOUNT, tunnel_id)
            )
            return False, {
                "error": "tunnel-config-failed",
                "message": "配置隧道失败：" + cf_errors(payload),
            }

        ok, payload = cf_request(
            "POST",
            "/zones/%s/dns_records" % CF_ZONE,
            {
                "type": "CNAME",
                "name": hostname,
                "content": "%s.cfargotunnel.com" % tunnel_id,
                "proxied": True,
                "comment": "dsh-pair %s" % code[:8],
            },
        )
        if not ok:
            cf_request(
                "DELETE", "/accounts/%s/cfd_tunnel/%s" % (CF_ACCOUNT, tunnel_id)
            )
            return False, {
                "error": "dns-create-failed",
                "message": "创建域名失败：" + cf_errors(payload),
            }
        dns_id = (payload.get("result") or {}).get("id")

        # ================= 锁内：写回 =================
        with _LOCK:
            # ⚠️ **重新读**：锁外的这几十秒里状态可能已经变了。
            records = load_records()
            codes = read_json(CODES_PATH, {})
            entry = codes.get(code)
            # 三种「这几十秒里出事了」的情形，都得把刚建的隧道删掉再报错，
            # 不能留下一条谁也指不到的孤儿隧道。
            if entry is None or entry.get("revoked"):
                cf_request("DELETE", "/accounts/%s/cfd_tunnel/%s" % (CF_ACCOUNT, tunnel_id))
                log("注册期间激活码被撤销/删除，已回滚隧道 code=%s" % code[:8])
                return False, {"error": "revoked", "message": "这个激活码已被停用"}
            if code in records:
                # 极端并发（不同进程 / 重启后占位丢了）：已被别人注册完。
                cf_request("DELETE", "/accounts/%s/cfd_tunnel/%s" % (CF_ACCOUNT, tunnel_id))
                log("注册期间该码已被另一个请求完成，已回滚隧道 code=%s" % code[:8])
                return False, {"error": "register-in-flight", "message": "这个激活码刚刚已被注册，请重试"}

            access_token = secrets.token_hex(32)
            # 设备凭据：注册成功时下发**一次**，之后所有涉及凭据的调用都要它。
            # 这样「激活码」就退回成「开通额度的一次性凭证」，不再等于电脑控制权。
            issued_secret = new_client_secret()
            records[code] = {
                "subdomain": subdomain,
                "hostname": hostname,
                "tunnelId": tunnel_id,
                "tunnelToken": tunnel_token,
                "accessToken": access_token,
                "clientSecret": issued_secret,
                "dnsRecordId": dns_id,
                "deviceLabel": label,
                # ⚠️ 指纹是**诊断信息**，不再参与任何放行判定。它曾经是老记录
                # 一次性认领的判据，但那条路径（`legacy_claim`）已被删除 ——
                # 客户端报什么就是什么，**不能**拿它当认证用。
                "deviceFingerprint": device_fingerprint(device_label),
                "createdAt": int(time.time()),
            }
            save_records(records)

            entry["usedBy"] = tunnel_id
            entry["usedAt"] = int(time.time())
            codes[code] = entry
            write_json(CODES_PATH, codes)

        log("新建配对 code=%s sub=%s tunnel=%s" % (code[:8], subdomain, tunnel_id))
        return True, {
            "subdomain": subdomain,
            "hostname": hostname,
            "tunnelId": tunnel_id,
            "tunnelToken": tunnel_token,
            "accessToken": access_token,
            "clientSecret": issued_secret,
            "reused": False,
        }
    finally:
        # ⚠️ 无论成功、失败、抛异常，占位都必须释放 —— 卡住的话这条激活码
        # 就再也注册不了了（而且症状是「正在注册中」，极难排查）。
        with _REGISTER_INFLIGHT_LOCK:
            _REGISTER_INFLIGHT.discard(code)


def rotate_token(activation_code, client_secret=None, admin=False):
    """换一把访问令牌（隧道与域名不动）。

    用途：客户怀疑令牌泄露时，改完两端各刷一次即可，不用重建隧道。

    ## ⚠️ 鉴权（这条是后补的，之前是个真漏洞）

    原实现**不校验任何凭据** —— 只要知道激活码就能调，而且响应里还带着
    `tunnelToken`。于是「激活码泄露 ⇒ 拿到隧道凭据 + 拿到新令牌」，
    比 `register` 那条还直接。现在必须**设备凭据匹配**（或管理员放行）。

    ## ⚠️ `admin=True` 是外部审计 P1-7 要的「令牌泄露时能一键轮换」

    客户报「我怀疑令牌泄露了」时，他手机/电脑上的凭据可能**正是**已经被拿走
    的那份 —— 那时候让客户端自己证明身份是矛盾的（有凭据的人不需要轮换，
    需要轮换的人可能已经没有可信凭据了）。所以管理端必须能直接换：
    `pair_admin.py rotate <激活码>`。它走 admin 头，不需要 `clientSecret`。

    ⚠️ **轮换一律同时换 `clientSecret` 吗？不。** 管理端轮换只换
    `accessToken`，`clientSecret` 保持不变 —— 否则客户机上的 `pair.json`
    会立刻失效，一次「预防性轮换」变成一次「必须重新配对」。
    真要作废设备，路径是 `unregister`。

    ⚠️ 响应里**永远不带 `tunnelToken`**：那东西只在首次建隧道时给一次，
    客户端已经存在 `pair.json` 里。

    @param activation_code - 激活码。
    @param client_secret - 设备凭据（`admin=True` 时忽略）。
    @param admin - 管理员放行（跳过设备凭据校验）。
    @returns `(ok, payload)`。
    """
    code = as_text(activation_code).strip()
    with _LOCK:
        records = load_records()
        record = records.get(code)
        if record is None:
            return False, {"error": "not-registered", "message": "这个激活码还没注册过"}
        if not admin and not client_secret_matches(record, client_secret):
            # ⚠️ 老记录（没有 clientSecret）也不放行：先走上层「重新注册」那条路
            # 认领一次设备凭据，再来轮换。这里不做隐式升级 —— 否则等于把
            # 「凭激活码即可轮换」这条原样留着。
            log("拒绝轮换：凭据不符 code=%s" % code[:8])
            return False, {"error": "unauthorized", "message": "设备凭据不符，请重新配对"}
        record["accessToken"] = secrets.token_hex(32)
        # ⚠️ 留痕：事后要能看出「这个令牌是什么时候被换掉的」，否则
        # 「客户说被轮换过」和「其实没人轮换、是他自己丢了」分不清。
        record["rotatedAt"] = int(time.time())
        record["rotatedBy"] = "admin" if admin else "device"
        records[code] = record
        save_records(records)
        log("轮换访问令牌 code=%s sub=%s" % (code[:8], record["subdomain"]))
        return True, {
            "subdomain": record["subdomain"],
            "hostname": record["hostname"],
            "tunnelId": record["tunnelId"],
            "accessToken": record["accessToken"],
            "reused": True,
        }


def unregister(activation_code):
    """彻底注销：删隧道 + 删 DNS 记录 + 清记录（激活码可再次使用）。

    @param activation_code - 激活码。
    @returns `(ok, payload)`。
    """
    code = as_text(activation_code).strip()
    with _LOCK:
        records = load_records()
        record = records.pop(code, None)
        if record is None:
            return False, {"error": "not-registered", "message": "这个激活码还没注册过"}
        save_records(records)

        codes = read_json(CODES_PATH, {})
        if code in codes:
            codes[code].pop("usedBy", None)
            codes[code].pop("usedAt", None)
            write_json(CODES_PATH, codes)

        if record.get("dnsRecordId"):
            cf_request(
                "DELETE",
                "/zones/%s/dns_records/%s" % (CF_ZONE, record["dnsRecordId"]),
            )
        cf_request(
            "DELETE",
            "/accounts/%s/cfd_tunnel/%s" % (CF_ACCOUNT, record["tunnelId"]),
        )
        log("注销 code=%s sub=%s" % (code[:8], record["subdomain"]))
        return True, {"removed": record["subdomain"]}


def release_record(activation_code, client_secret=None):
    """客户机主动解绑：**清掉服务端记录**，让同一激活码可以重新注册。

    ## 为什么需要（外部审计 4.3）

    客户在电脑上点「解绑」时，原来只清本机 `pair.json` + 换本机令牌 + 停隧道，
    **不通知服务器**。而服务端对已有 `clientSecret` 的记录是 fail-closed 的
    （`legacy_claim` 已删），于是客户机再也注册不上 —— 唯一的出路是管理员
    `unregister`，而那会**连隧道一起删掉**。UI 上那句「如需重连请重新配对」
    实际做不到。

    ## 凭据要求

    必须带 `clientSecret`（与 `rotate` / `handshake` 同强度）：否则任何知道
    激活码的人都能把别人的机器解绑 = 服务级 DoS。

    ## 为什么不删隧道

    只**清掉 `clientSecret` 并轮换 `accessToken`**，隧道与 DNS 记录留着。
    客户重新配对时 `register` 会走「新建」分支？—— 不会：记录还在，
    但 `clientSecret` 已被清空 ⇒ 会命中 `legacy-needs-migration`。
    所以这里**直接把记录删掉**，让下一次注册走完整的新建流程（复用同一条
    隧道不可能 —— 记录没了就查不到 tunnelId）。

    ⚠️ 取舍：删记录会**连隧道一起删**（否则会留下孤儿隧道，永远计费）。
    这正是客户主动解绑时应有的语义：「我不用了」。

    @param activation_code - 激活码。
    @param client_secret - 设备凭据。
    @returns `(ok, payload)`。
    """
    code = as_text(activation_code).strip()
    with _LOCK:
        records = load_records()
        record = records.get(code)
        if record is None:
            # ⚠️ **幂等**：记录已经不在（管理员先删过 / 重复调用）也算成功。
            # 客户机那边解绑动作不该因为「服务端说没有」而报错卡住。
            return True, {"released": True, "already": True}
        if not client_secret_matches(record, client_secret):
            log("拒绝解绑：凭据不符 code=%s" % code[:8])
            return False, {"error": "unauthorized", "message": "设备凭据不符"}

    # 走既有的注销路径（删隧道 + 删 DNS + 清记录），它自己会再取一次锁。
    ok, payload = unregister(code)
    if not ok:
        return False, payload
    log("客户机主动解绑 code=%s sub=%s" % (code[:8], record.get("subdomain")))
    return True, {"released": True, "removed": payload.get("removed")}


HANDSHAKE_PATH = os.path.join(STATE_DIR, "handshakes.json")

# 配对码有效期（秒）。够客户从电脑走到手机输完，又不至于长期挂在网上。
HANDSHAKE_TTL = int(os.environ.get("PAIR_HANDSHAKE_TTL", "600"))

# ---------------------------------------------------------------- 失败限流
#
# ⚠️ **为什么需要**：配对码只有 6 位，字符集 31 个（去掉了 0/O/1/I/L），
# 空间约 8.9e8。看着不小，但 `/pair/claim` 原本**没有任何次数限制** ——
# 一个脚本可以每秒打上千次。而配对码的有效期是 600 秒，所以只要在这 10 分钟
# 窗口里打进去 ~90 万次就能撞上一个（算上多个码同时在世，命中率还要高）。
# 对一个「要分发给大众」的服务，这是必须堵的。
#
# 做法：**按来源 IP 记失败次数**，超阈值就冷却。只统计**失败**，
# 成功不计数 —— 正常客户输错一两次不该被拦。
#
# ⚠️ 阈值不能太紧：客户手输 6 位码打错字是常态，而且**所有客户都经过
# 同一个 Cloudflare 隧道入口**，如果取 `X-Forwarded-For` 失败就可能把
# 所有人算成一个 IP 而误伤。所以取一个宽松的阈值（默认 20 次/10 分钟），
# 并同时保留一个「全局失败速率」上限兜底。
CLAIM_MAX_FAILURES = int(os.environ.get("PAIR_CLAIM_MAX_FAILURES", "20"))
CLAIM_WINDOW = int(os.environ.get("PAIR_CLAIM_WINDOW", "600"))
CLAIM_GLOBAL_MAX = int(os.environ.get("PAIR_CLAIM_GLOBAL_MAX", "600"))

# {ip: [失败时间戳, ...]}
_claim_failures = {}
# 全局失败时间戳（不分 IP）：只用来**告警**，不参与封禁（见 claim_rate_limited）。
_claim_failures_all = []
# 全局告警的「已经报过一次」标记，避免刷屏。
_global_warned = [False]


def _prune(times, now):
    """丢掉窗口外的时间戳，返回窗口内的那些。"""
    cutoff = now - CLAIM_WINDOW
    return [t for t in times if t > cutoff]


def claim_rate_limited(client_ip):
    """这个来源现在是不是已经被限流了。

    @param client_ip - 来源标识（见 `_client_ip`）。
    @returns `(limited, retry_after_seconds)`。
    """
    now = int(time.time())
    with _LOCK:
        mine = _prune(_claim_failures.get(client_ip, []), now)
        _claim_failures[client_ip] = mine
        global_recent = _prune(_claim_failures_all, now)
        _claim_failures_all[:] = global_recent

        if len(mine) >= CLAIM_MAX_FAILURES:
            oldest = min(mine)
            return True, max(1, oldest + CLAIM_WINDOW - now)
        # ⚠️ **全局桶只告警、不封禁**（外部审计 M5）：原来全局超限也返回
        # `limited=True`，而这是**所有客户共用的一个桶** —— 任何一个攻击者
        # 打 600 次错误码，就能让全世界的客户 10 分钟配不上对（服务级 DoS）。
        # 现在只在日志里告警，真正的拦截交给按 IP 的桶。
        if len(global_recent) >= CLAIM_GLOBAL_MAX and not _global_warned[0]:
            _global_warned[0] = True
            # ⚠️ 文案用纯 ASCII：`log()` 直写 stdout，控制台编码（Windows GBK）
            # 撑不住 emoji，会抛 UnicodeEncodeError 把整个请求打崩。
            log(
                "[WARN] claim failures spike: %d in %ds (alert only, not blocking)"
                % (len(global_recent), CLAIM_WINDOW)
            )
        elif len(global_recent) == 0:
            _global_warned[0] = False
        return False, 0


def note_claim_failure(client_ip):
    """记一次失败（只统计失败，成功不计数）。"""
    now = int(time.time())
    with _LOCK:
        bucket = _prune(_claim_failures.get(client_ip, []), now)
        bucket.append(now)
        _claim_failures[client_ip] = bucket
        _claim_failures_all.append(now)
        # 别让字典无限长大：过期的 IP 顺手清掉。
        if len(_claim_failures) > 4096:
            for key in [k for k, v in _claim_failures.items() if not _prune(v, now)]:
                _claim_failures.pop(key, None)


def _client_ip(handler):
    """取来源 IP 用于限流。

    ⚠️ **`X-Forwarded-For` 可以伪造**，所以它只用来**分桶**，不能当身份。

    ⚠️ 取 XFF 的**最后一跳**而不是第一个：服务在 Cloudflare 隧道之后，
    链路上最后一跳是可信的那一跳，第一个是客户端自己写的（最容易被伪造）。

    ## ⚠️ 这条安全**完全依赖**「最后一跳可信且会追加真 IP」

    这是本函数唯一的前提，而它不在本进程的控制范围内 —— 换掉 Cloudflare、
    或在前面再加一层会**追加** XFF 的代理，桶键就会退化成常数
    （所有来源共用一个桶）⇒ 任意一个攻击者打满 21 次失败就锁死**全世界**
    客户的配对 10 分钟。

    ⚠️ **所以「换一个伪造 XFF 就能换桶」不是可依赖的防护**。外部审计 P2-10
    专门指出：我原来那句「分桶被绕过时还有全局上限兜底」是**错的** ——
    全局桶在 M5 之后**只告警不封禁**（那正是为了避免全球连坐），
    所以它**兜不住**任何东西。

    现在这条依赖不是靠注释，而是靠**启动时断言**（`_assert_xff_trustworthy`）：
    部署后若那层代理变了，服务会在启动日志里明确报出来，而不是等到
    某天全部客户被锁死 10 分钟才发现。

    @param handler - HTTP 处理器（读它的 headers 与 client_address）。
    @returns 分桶用的来源标识。
    """
    forwarded = handler.headers.get("X-Forwarded-For", "")
    if forwarded:
        parts = [p.strip() for p in forwarded.split(",") if p.strip()]
        if parts:
            return parts[-1]
    return handler.client_address[0] if handler.client_address else "unknown"


def _assert_xff_trustworthy():
    """启动时确认「最后一跳真的会追加真 IP」（外部审计 P2-10）。

    ## 判据

    按 IP 的限流能成立，**只因为**最后一跳（Cloudflare）会把真实来源 IP
    **追加**到 `X-Forwarded-For` 末尾，而 `_client_ip` 取的正是最后一位。
    若那一层变了（换 CF、前面再加一层只透传 XFF 的代理），最后一位就变成
    **客户端自己写的值** ⇒ 桶键退化成可任意指定 ⇒ 攻击者换一个伪造 XFF
    就换一个桶，**21 次失败锁死全世界客户**。

    ## 做法：发一个**带唯一伪造 XFF** 的探测，再在本进程里看它落进了哪个桶

    关键点是**不需要任何回显接口、也不需要任何凭据**：探测进程与服务进程是
    **同一个进程**，所以直接读限流字典就够了。

    1. 造一个唯一且不可能的伪造 IP（文档保留段 `203.0.113.0/24` + 随机末位）；
    2. 带 `X-Forwarded-For: <那个 IP>` 打一次**公网入口**的 `/pair/claim`，
       故意用错配对码 —— 这会触发 `note_claim_failure(桶键)`；
    3. 回来看 `_claim_failures`：
       - 键里**有**那个伪造 IP ⇒ 没有人追加 ⇒ ⚠️ 分桶被架空；
       - 键是**别的值**（真实出口 IP）⇒ 追加生效 ⇒ ✅。

    ⚠️ 探测**必须走公网入口**（`PAIR_PUBLIC_HEALTH`）：打 `127.0.0.1` 的话中间
    没有任何代理，永远看不到 Cloudflare 的行为，结论没有意义。

    ## ⚠️ 为什么是「告警」而不是「拒绝启动」

    这描述的是**防护被削弱**，不是**服务不可用**。而配对服务一旦拒启动，
    正在配对的客户立刻就卡住 —— 那比一个「可能被绕过的限流」严重得多。
    所以只打一条带明确结论的 WARN，让运维能在日志里第一眼看到。

    ⚠️ 这个自检只在启动时跑一次（独立 daemon 线程，2 秒后发起），
    失败、超时、抛异常都**只记一行日志**，绝不影响服务本身。
    """
    probe_ip = "203.0.113.%d" % (secrets.randbelow(254) + 1)
    # ⚠️ 先放进一个「空的桶」占位不重要 —— 我们靠**它有没有被写入**来判断，
    # 所以这里不预置任何东西，只看探测后字典里出现了什么。
    #
    # ⚠️ **`HTTPError` 必须当成「探测成功」而不是失败**：探测用的是错配对码，
    # 服务端**本来就该回 400**，而 `urlopen` 对 4xx/5xx 一律抛异常。
    # 第一版就栽在这里 —— 它把 400 当成了「连不上」，于是**永远走「跳过」分支**，
    # 既不打通过也不打失败。那是最糟的失效形态：日志里看着自检在跑，
    # 实际上什么都没验。判据只能是「**有没有到服务端**」，不是「状态码是不是 2xx」。
    reached = False
    try:
        request = urllib.request.Request(
            "%s/pair/claim" % PAIR_PUBLIC_HEALTH.rstrip("/"),
            data=json.dumps({"pairCode": "XFFPROBE"}).encode("utf-8"),
            method="POST",
            headers={"X-Forwarded-For": probe_ip, "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=15) as response:
            response.read()
        reached = True
    except urllib.error.HTTPError as error:
        # 4xx/5xx：请求**确实到了**服务端（我们预期的就是 400）。
        try:
            error.read()
        except Exception:  # noqa: BLE001
            pass
        reached = True
    except Exception as error:  # noqa: BLE001 —— 真的连不上/超时
        log("XFF 自检跳过（连不上 %s：%r）" % (PAIR_PUBLIC_HEALTH, error))
        return

    if not reached:
        log("XFF 自检跳过（探测 %s 未到达服务端）" % PAIR_PUBLIC_HEALTH)
        return

    # ⚠️ 探测由**另一个线程**处理，写入计数与这里读之间没有 happens-before。
    # 请求返回只说明「响应发出去了」，不保证计数那行已经执行完（`finally` 里
    # 关连接、日志 flush 都排在它之后）。所以轮询几次，别只读一遍 ——
    # 读早了就会把「暂时没看到」误判成「没有落进伪造桶」= 假通过。
    landed = False
    for _ in range(20):
        with _LOCK:
            landed = probe_ip in _claim_failures
            if landed:
                _claim_failures.pop(probe_ip, None)
                break
        time.sleep(0.1)

    if landed:
        log(
            "[WARN] XFF 自检失败：伪造的 X-Forwarded-For 原样成了桶键（%s）——"
            "说明最后一跳**没有**追加真实来源 IP，按 IP 的限流已退化成"
            "「客户端可任意指定桶」。请检查 Cloudflare / 反代配置。" % probe_ip
        )
        return
    log(
        "XFF 自检通过：伪造的 XFF 没有成为桶键（探测值 %s 未出现在桶里），"
        "说明最后一跳覆盖/追加了真实来源 IP" % probe_ip
    )


# ---------------------------------------------------------------- 注册限流
#
# ⚠️ **为什么 `/pair/register` 也需要限流**（外部审计 3.2）
#
# 它原来**完全无鉴权、无限流、无审计**，于是同时是两件事：
#   - **存在性 oracle**：`bad-code` / `revoked` / `device-mismatch` / 成功
#     四种响应把「这个码存不存在、绑没绑过」全说了出来；
#   - **枚举器**：命中**未注册**的码会直接建隧道 + 建 DNS，消耗 CF 配额，
#     并且**把该码永久绑到攻击者的主机名**上 —— 真客户首次安装就
#     `device-mismatch`，属于交付级故障。
#
# 32 bit 的码空间纯爆破约 74 天（1000 并发），所以**随机爆破不现实**；真实威胁
# 是「码泄漏 + 零告警」。限流的目的是把「泄漏之后还能无限试」变成「试几十次
# 就被挡住并且留下记录」。
#
# 阈值比 claim 宽：正常客户重装插件、改主机名都会打这个接口。
REGISTER_MAX_FAILURES = int(os.environ.get("PAIR_REGISTER_MAX_FAILURES", "30"))
REGISTER_WINDOW = int(os.environ.get("PAIR_REGISTER_WINDOW", "600"))
# 全局桶：与 claim 不同，这个**真的封禁**（见 register_rate_limited 的取舍说明）。
REGISTER_GLOBAL_MAX = int(os.environ.get("PAIR_REGISTER_GLOBAL_MAX", "300"))

# {ip: [失败时间戳, ...]}
_register_failures = {}
_register_failures_all = []
_register_global_warned = [False]


def register_rate_limited(client_ip):
    """这个来源现在是不是已经被限流了。

    ## ⚠️ 与 `claim_rate_limited` 的取舍**相反**，这是故意的

    claim 的全局桶**只告警不封禁**：它保护的是「客户配不上对」，而 claim 是
    客户每天正常要走的路径，误封代价高、攻击收益低（配对码 6 位、TTL 600 秒）。

    这里反过来：`register` 是**一次性**动作（一台电脑一辈子走一两次），正常
    客户几乎不可能在 10 分钟内失败 300 次。而它一旦被枚举成功，后果是
    「**付费客户首次安装直接报废**」+ 消耗 CF 配额。所以宁可误封（客户等
    10 分钟，或找管理员），也不能让枚举跑下去。

    @param client_ip - 来源标识（见 `_client_ip`）。
    @returns `(limited, retry_after_seconds)`。
    """
    now = int(time.time())
    with _LOCK:
        mine = _prune(_register_failures.get(client_ip, []), now)
        _register_failures[client_ip] = mine
        global_recent = _prune(_register_failures_all, now)
        _register_failures_all[:] = global_recent

        if len(mine) >= REGISTER_MAX_FAILURES:
            oldest = min(mine)
            return True, max(1, oldest + REGISTER_WINDOW - now)
        if len(global_recent) >= REGISTER_GLOBAL_MAX:
            if not _register_global_warned[0]:
                _register_global_warned[0] = True
                log(
                    "[WARN] register failures spike: %d in %ds (blocking)"
                    % (len(global_recent), REGISTER_WINDOW)
                )
            return True, REGISTER_WINDOW
        if len(global_recent) == 0:
            _register_global_warned[0] = False
        return False, 0


def note_register_failure(client_ip):
    """记一次注册失败。"""
    now = int(time.time())
    with _LOCK:
        bucket = _prune(_register_failures.get(client_ip, []), now)
        bucket.append(now)
        _register_failures[client_ip] = bucket
        _register_failures_all.append(now)
        if len(_register_failures) > 4096:
            for key in [k for k, v in _register_failures.items() if not _prune(v, now)]:
                _register_failures.pop(key, None)


# ---------------------------------------------------------------- 审计
#
# ⚠️ 审计**独立于限流**（外部审计 3.5）：限流是实时的、状态在内存里、重启即失；
# 审计是留痕的、要能事后回答「谁在什么时候注册/迁移了哪台机器」。
# 之前的 `claim_handshake` 只记一句「配对码 %s 已被领取」，**不记 IP / UA** ——
# 一旦发生接管，事后无法定位、无法回溯受影响设备。
#
# 只追加、每行一条 JSON，不参与任何判定（写失败也不能影响主流程）。
AUDIT_PATH = os.path.join(STATE_DIR, "audit.jsonl")


def audit(event, **fields):
    """记一条审计事件（尽力而为，绝不抛错）。"""
    try:
        row = {"at": int(time.time()), "event": event}
        row.update(fields)
        with open(AUDIT_PATH, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    except OSError:
        pass


def request_origin(handler):
    """取审计用的来源信息（IP + User-Agent）。"""
    return {
        "ip": _client_ip(handler),
        "ua": (handler.headers.get("User-Agent", "") or "")[:200],
    }


# 配对码字符集：去掉了 0/O/1/I/L 这些看着会认错的。
HANDSHAKE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
HANDSHAKE_LEN = 6


def make_handshake(activation_code, client_secret=None):
    """电脑端拿到凭据后，换一个**短配对码**给手机用。

    ## 为什么要多这一跳

    电脑端手里的 `{hostname, accessToken}` 直接编码进二维码会很长，
    手输更不可能（64 位十六进制）。所以让服务器把它换成 6 位码：
    二维码和手输都变得可行，而**凭据本身不经过二维码**。

    ## 一次性

    `claim` 成功后立即删除。所以就算码被旁人瞥见，也只有极短的时间窗
    可以抢先使用；客户发现不对劲重新生成一次即可。

    ## ⚠️ 鉴权（这条是后补的，之前是个真漏洞）

    原实现**不校验任何凭据**。于是外部审计这条链成立：激活码泄露 ⇒
    `handshake` 拿配对码 ⇒ `claim` 拿到 accessToken ⇒ 打中继在受害者电脑上
    跑 agent。更糟的是它**不轮换令牌**，所以受害者那边连掉线都不会发生 ——
    完全静默。现在必须**设备凭据匹配**（或管理员放行）。

    配对码本身也**绑定发起 handshake 的那台机器**（见 `clientSecret` 校验 +
    `claim_handshake` 里的一次性销毁），所以「拿别人的码去 claim」这条也不成立。

    @param activation_code - 激活码（用来定位是哪台电脑）。
    @param client_secret - 设备凭据。
    @returns `(ok, payload)`；成功时 payload 含 `pairCode` 与 `expiresIn`。
    """
    code = as_text(activation_code).strip()
    with _LOCK:
        records = load_records()
        record = records.get(code)
        if record is None:
            return False, {"error": "not-registered", "message": "这个激活码还没注册过"}
        if not client_secret_matches(record, client_secret):
            log("拒绝生成配对码：凭据不符 code=%s" % code[:8])
            return False, {"error": "unauthorized", "message": "设备凭据不符，请重新配对"}

        now = int(time.time())
        store = read_json(HANDSHAKE_PATH, {})
        # 顺手清掉过期的，避免文件无限增长。
        store = {
            key: value
            for key, value in store.items()
            if int(value.get("expiresAt", 0)) > now
        }
        pair_code = None
        for _ in range(50):
            candidate = "".join(
                secrets.choice(HANDSHAKE_ALPHABET) for _ in range(HANDSHAKE_LEN)
            )
            if candidate not in store:
                pair_code = candidate
                break
        if pair_code is None:
            return False, {"error": "no-code", "message": "配对码生成失败，请重试"}

        store[pair_code] = {
            "activationCode": code,
            "expiresAt": now + HANDSHAKE_TTL,
            "createdAt": now,
        }
        write_json(HANDSHAKE_PATH, store)
        log("生成配对码 %s（%d 秒有效）" % (pair_code, HANDSHAKE_TTL))
        return True, {
            "pairCode": pair_code,
            "expiresIn": HANDSHAKE_TTL,
            "hostname": record["hostname"],
        }


def claim_handshake(pair_code, origin=None):
    """手机端用配对码换取连接凭据（一次性）。

    @param pair_code - 电脑端显示的那个 6 位码。
    @param origin - 领取来源 `{ip, ua}`（外部审计 P1-7）。会**写进记录**而不只
        写进审计日志：`/pair/devices` 要靠它回答「哪台手机什么时候绑上的」。
    @returns `(ok, payload)`；成功时含 `hostname` 与 `accessToken`。
    """
    key = as_text(pair_code).strip().upper().replace(" ", "").replace("-", "")
    if key == "":
        return False, {"error": "missing-code", "message": "请填写配对码"}

    with _LOCK:
        store = read_json(HANDSHAKE_PATH, {})
        entry = store.get(key)
        if entry is None:
            return False, {"error": "bad-code", "message": "配对码无效或已过期"}
        if int(entry.get("expiresAt", 0)) <= int(time.time()):
            store.pop(key, None)
            write_json(HANDSHAKE_PATH, store)
            return False, {"error": "expired", "message": "配对码已过期，请在电脑上重新生成"}

        records = load_records()
        record = records.get(entry["activationCode"])
        if record is None:
            return False, {"error": "not-registered", "message": "这台电脑的配对已被注销"}

        # 一次性：换完即焚。
        store.pop(key, None)
        write_json(HANDSHAKE_PATH, store)

        # ⚠️ 留痕（外部审计 P1-7）：手机每次绑上电脑都记一笔。这是事后回答
        # 「谁的手机连过哪台机器」的唯一线索，而 `audit.jsonl` 会被轮转/清理，
        # 记录文件才跟着配对生命周期一起活。
        if origin:
            record["lastClaimAt"] = int(time.time())
            record["lastClaimIp"] = as_text(origin.get("ip"))[:64]
            record["lastClaimUa"] = as_text(origin.get("ua"))[:200]
            record["claimCount"] = int(record.get("claimCount", 0)) + 1
        records[entry["activationCode"]] = record
        save_records(records)

        log("配对码 %s 已被领取 → %s" % (key, record["subdomain"]))
        return True, {
            "hostname": record["hostname"],
            "accessToken": record["accessToken"],
            "subdomain": record["subdomain"],
        }


def list_devices():
    """列出所有已配对设备（管理用，**绝不含任何凭据**）。

    外部审计 P1-7：原来只有「一个个 `lookup` 激活码」这一条路，运维没法一眼
    看出「现在到底有哪些机器配着、最近什么时候被连过」。这个函数就是那份列表。

    ⚠️ **返回值里不能有 `accessToken` / `tunnelToken` / `clientSecret`** ——
    这是整个服务里唯一一个「一次拿到全部记录」的接口，加错一个字段就等于
    把 §3.3 那个「单点拿到全部客户」重新造出来。
    只回指纹级别的信息：有没有设备凭据、轮换过几次、最近谁连过。

    @returns `{"count": N, "devices": [...]}`。
    """
    codes = read_json(CODES_PATH, {})
    records = load_records()
    devices = []
    for code, record in sorted(records.items()):
        entry = codes.get(code) or {}
        devices.append(
            {
                # ⚠️ 只回前 8 位：列表会被粘进客服对话/工单，
                # 完整激活码外流就等于 §3.1 那条路径的入口。
                "code": code[:8],
                "subdomain": record.get("subdomain"),
                "hostname": record.get("hostname"),
                "deviceLabel": record.get("deviceLabel"),
                "hasDeviceSecret": bool(record.get("clientSecret")),
                "revoked": bool(entry.get("revoked")),
                "createdAt": record.get("createdAt"),
                "reboundAt": record.get("reboundAt"),
                "rotatedAt": record.get("rotatedAt"),
                "rotatedBy": record.get("rotatedBy"),
                "lastClaimAt": record.get("lastClaimAt"),
                "lastClaimIp": record.get("lastClaimIp"),
                "claimCount": record.get("claimCount", 0),
            }
        )
    return {"count": len(devices), "devices": devices}


def lookup(activation_code):
    """查一个激活码的状态（管理用，不含 token）。"""
    code = as_text(activation_code).strip()
    codes = read_json(CODES_PATH, {})
    records = load_records()
    entry = codes.get(code)
    record = records.get(code)
    return {
        "code": code,
        "exists": entry is not None,
        "revoked": bool(entry and entry.get("revoked")),
        "note": (entry or {}).get("note", ""),
        "registered": record is not None,
        "subdomain": (record or {}).get("subdomain"),
        "hostname": (record or {}).get("hostname"),
        "tunnelId": (record or {}).get("tunnelId"),
        "createdAt": (record or {}).get("createdAt"),
    }


def admin_codes():
    """管理面板用：激活码全表（码 + 状态 + 注册摘要）。

    ## 为什么要有它

    `list_devices()` 只遍历 **records**（已注册的），而运维真正要看的是一张
    「我发出去多少码、哪些还没用、哪些正在用」的**全集**表。之前只能在服务器上
    跑 `pair_admin.py list`（直接读 JSON 文件），远程就没法看了。

    ## ⚠️ 与 `list_devices()` 的取舍不同

    `list_devices()` 只回激活码**前 8 位**，理由是那份列表会被粘进工单。
    这个接口是**管理面板专用**（要的就是能核对完整码、能点复制发给客户），
    所以回完整码 —— 但它和 `/pair/devices` 同级别，**必须 admin**。
    凭据字段（`accessToken` / `tunnelToken` / `clientSecret`）一个都不回。

    状态四态与 `pair_admin.py list` 完全对齐：
    `revoked` 已停用 / `legacy` 待迁移 / `registered` 已注册 / `unused` 未使用。

    @returns `{"count": N, "codes": [...]}`。
    """
    with _LOCK:
        codes = read_json(CODES_PATH, {})
        records = load_records()

    items = []
    for code in sorted(codes):
        entry = codes.get(code) or {}
        record = records.get(code) or {}
        if entry.get("revoked"):
            state = "revoked"
        elif record and not record.get("clientSecret"):
            # 老记录：现在注册会被直接拒（见 register），必须 migrate。
            state = "legacy"
        elif record:
            state = "registered"
        else:
            state = "unused"
        items.append(
            {
                "code": code,
                "state": state,
                "note": entry.get("note", ""),
                "issuedAt": entry.get("createdAt"),
                "subdomain": record.get("subdomain"),
                "hostname": record.get("hostname"),
                "deviceLabel": record.get("deviceLabel"),
                "lastClaimAt": record.get("lastClaimAt"),
                "claimCount": record.get("claimCount", 0),
            }
        )
    # 面板上「最近发出去的排最前面」比字典序有用得多。
    items.sort(key=lambda item: item.get("issuedAt") or 0, reverse=True)
    return {"count": len(items), "codes": items}


def admin_tunnel():
    """管理面板用：这台服务器自己的隧道 / 转发入口状态 + 已注册客户机清单。

    ## 探的是什么

    * **cloudflared** —— 服务器上那个把外网流量接进来的进程。它挂了，整个
      `/pair/*` 与 DSH 网页都会失联（而 SSH 走的是另一条，所以还能进去救）。
    * **mux** —— `dsh-mux.py`，按前缀把 `/logs/` `/pair/` 和其余分流到
      18900 / 18901 / 3080。它挂了同样会失联。
    * **客户机** —— 只看 records 里的 `hostname` / `deviceLabel`，**不发探测请求**。
      主动探测会把「这个服务在扫自己的客户机」暴露给对方，而且客户机大多在
      家宽 NAT 后面，探测失败不代表隧道坏了。

    ## ⚠️ 只读

    这里**不做**重启。重启 cloudflared 一旦失败，正在看的这个页面自己就断了，
    等于把唯一的图形入口也一起关掉。要重启请走 SSH。

    @returns `{"zone", "tunnel", "mux", "clients"}`。
    """
    tunnel_id = ""
    try:
        with open("/root/dsh/pair/tunnel-id.txt", "r", encoding="utf-8") as handle:
            tunnel_id = handle.read().strip()
    except OSError:
        tunnel_id = ""

    with _LOCK:
        records = load_records()

    clients = []
    for code in sorted(records):
        record = records.get(code) or {}
        clients.append(
            {
                # 面板上要对得上客户，所以这里也给完整码（同样 admin 级）。
                "code": code,
                "hostname": record.get("hostname"),
                "deviceLabel": record.get("deviceLabel"),
            }
        )

    return {
        "zone": CF_ZONE_NAME,
        "tunnel": {
            "running": _process_running("cloudflared"),
            "tunnelId": tunnel_id,
        },
        "mux": {
            "running": _process_running("dsh-mux.py"),
            "port": 2222,
        },
        "clients": clients,
    }


def _process_running(needle):
    """扫 `/proc/*/cmdline` 判断某个进程在不在（不依赖 pid 文件，不依赖 ps）。

    用 `/proc` 直接读的好处：容器里常常没有 `ps`/`pgrep`，而 `/proc` 永远在。
    `needle` 用子串匹配，命中即返回 True。
    """
    try:
        entries = os.listdir("/proc")
    except OSError:
        return False
    for entry in entries:
        if not entry.isdigit():
            continue
        try:
            with open("/proc/%s/cmdline" % entry, "rb") as handle:
                raw = handle.read()
        except OSError:
            continue
        if needle.encode("utf-8") in raw:
            return True
    return False


# ---------------------------------------------------------------- HTTP


class Handler(BaseHTTPRequestHandler):
    """极简 HTTP 处理器。只服务 `/pair/` 前缀下的几个 JSON 接口。"""

    server_version = "dsh-pair/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # noqa: A003 —— 覆盖基类，走统一日志
        log("[http] " + (fmt % args))

    def _send(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _serve_admin_page(self):
        """返回管理面板 HTML（`GET /pair/admin`）。

        ⚠️ **这个路由故意不要求 `X-Pair-Admin`。** 浏览器直接打开链接时没有
        任何地方能附自定义请求头，若在这里就要求，页面会永远 401、永远进不去。
        页面自己有一张登录卡片：口令在浏览器里输、存 `sessionStorage`，
        之后所有**数据**请求（`/pair/admin/codes` 等）才带 header。

        HTML 本身不含任何数据（没有码、没有 hostname、没有令牌），所以对公网
        暴露它等于暴露一个空表单，没有信息价值。真正的门在数据接口上。
        """
        try:
            with open(ADMIN_PAGE_PATH, "rb") as handle:
                body = handle.read()
        except OSError as error:
            log("admin page missing: %r" % (error,))
            self._send(
                500,
                {"error": "admin-page-missing", "message": "管理页面文件缺失"},
            )
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        """读请求体。

        ⚠️ **加上限**（外部审计 P2-9）：原来只有 `Content-Length` 就照读，
        一个 `Content-Length: 99999999999` 的请求就能让这台机器按声明长度
        一直往内存里读（slowloris 的内存版）。接口全是小 JSON，64 KiB 有巨大余量。

        ⚠️ 超限**不能只回 413 就完事**：必须把连接关掉（`close_connection`），
        否则 keep-alive 下剩下的字节会被当成下一个请求来解析（请求走私的味道）。
        """
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self.close_connection = True
            return {}
        if length <= 0:
            return {}
        if length > MAX_BODY_BYTES:
            log("拒绝超大请求体: %d 字节 > %d" % (length, MAX_BODY_BYTES))
            self.close_connection = True
            self._send(413, {"error": "payload-too-large", "message": "请求体过大"})
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            return {}

    def _admin_ok(self):
        """管理接口鉴权：`X-Pair-Admin` 头必须等于 `PAIR_ADMIN_SECRET`。

        ⚠️ 用 `hmac.compare_digest` 而不是 `==`（外部审计 L2）：明文 `==`
        在第一个不同的字节处提前返回，理论上可被逐字节爆破。
        `compare_digest` 要求两边都是 ASCII 字符串，非 ASCII 会抛 —— 包一层
        try，异常一律当作不匹配，别把 401 变成 500。
        """
        if ADMIN_SECRET == "":
            return False
        provided = self.headers.get("X-Pair-Admin", "")
        try:
            return hmac.compare_digest(provided, ADMIN_SECRET)
        except TypeError:
            return False

    def _send_binary(self, status, body, content_type, filename=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=86400")
        if filename is not None:
            self.send_header("Content-Disposition", 'attachment; filename="%s"' % filename)
        self.end_headers()
        self.wfile.write(body)

    def _cloudflared_allowed(self):
        """cloudflared 分发的每 IP 限速（见 `CLOUDFLARED_MAX_PER_HOUR`）。

        ⚠️ IP 取自 `_client_ip()`，它的可信性依赖「最后一跳会追加真 IP」
        （Cloudflare 会），所以这里同样受那条前提约束 —— 与限流桶同源，
        不另立一套判据。

        @returns 是否放行。
        """
        ip = _client_ip(self)
        now = time.time()
        with _cloudflared_lock:
            hits = [at for at in _cloudflared_hits.get(ip, []) if now - at < CLOUDFLARED_WINDOW]
            if len(hits) >= CLOUDFLARED_MAX_PER_HOUR:
                _cloudflared_hits[ip] = hits
                log("cloudflared 分发被限速 ip=%s 次数=%d" % (ip, len(hits)))
                return False
            hits.append(now)
            _cloudflared_hits[ip] = hits
            # ⚠️ 顺手清掉完全过期的键：这是个**无上限增长的字典**，
            # 不清理的话「谁都能往里面塞 IP」就变成内存泄漏（同类问题）。
            if len(_cloudflared_hits) > 4096:
                for key in [k for k, v in _cloudflared_hits.items() if not v or now - max(v) > CLOUDFLARED_WINDOW]:
                    _cloudflared_hits.pop(key, None)
            return True

    def _serve_cloudflared(self, name):
        """分发 cloudflared 可执行文件（**流式**，外部审计 P2-9）。

        ## 为什么由我们中转，而不是让客户去 GitHub 下

        实测：**国内服务器直连 github.com 是不通的**（`curl` 返回 000），
        客户电脑大概率同样。插件自己去 GitHub 下载 ⇒ 大量客户卡在这一步，
        而这一步失败的表现是「隧道起不来」，用户完全看不出是网络问题。

        所以由我们这台已经能出网的服务器中转一次，插件只认我们这一个地址。

        ## ⚠️ 为什么改成流式：原来是「整个读进内存」

        原来 `handle.read()` 把 **55 MB 整个读进内存**再 `wfile.write`。
        CF 边缘缓存命中是天然缓解（`cf-cache-status: HIT`），但审计指出
        **加一个随机 query 就能强制回源** ⇒ N 并发 = N × 55 MB 的 RSS。
        这台机器同时还跑着文档服务和诊断上传，内存爆掉就是全部客户一起不可用。

        现在按 1 MiB 分块读、分块写：**任何时刻只占 1 MiB**，无论多少并发。
        同时用 `Content-Length`（`os.path.getsize`）而不是 chunked ——
        客户端要显示下载进度（见 `pair.js` 的 `download.received/total`），
        没有长度就没法算百分比。

        ## ⚠️ 为什么这里**不加鉴权**（审计建议了，我明确不采纳）

        审计建议「加鉴权」。但这条路径的**唯一调用者**是 `ensureCloudflared()`，
        而那正是**配对之前**的一步 —— 客户此时**还没有任何凭据**
        （`clientSecret` 是 `register` 成功后才下发的）。要求凭据就变成
        「没配对就不能下 cloudflared → 没 cloudflared 就起不了隧道 → 配不成对」，
        死锁。

        那用激活码当凭据行不行？不行：激活码在**注册之前**就要用，而这台机器
        按激活码查不到「这是个合法客户」以外的信息，等于把激活码的存在性 oracle
        又多开一个入口（§3.2 那条已经够了）。

        **真正解决这个问题的是客户端侧的哈希校验**（P1-6，已实现于 `pair.js`
        的 `CLOUDFLARED_SHA256`）：这个文件是**公开的官方二进制**，
        它的保密性没有价值；**它的完整性**才是。所以这里做限流（防刷）、
        客户端做校验（防篡改）—— 各管一头。

        分发本身**不记 audit**：它是静态文件下载，正常运行下每次安装一次，
        记进去只会把审计日志淹掉（真正的安全事件是 register/claim/release）。

        @param name - 请求的文件名，必须白名单里的那一个。
        """
        if name not in CLOUDFLARED_FILES:
            self._send(404, {"error": "not-found", "message": "不支持的平台"})
            return
        path = os.path.join(CLOUDFLARED_DIR, name)
        try:
            size = os.path.getsize(path)
            handle = open(path, "rb")
        except OSError:
            log("分发失败：%s 不存在" % path)
            self._send(503, {"error": "unavailable", "message": "该平台暂未提供，请稍后再试"})
            return
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "public, max-age=86400")
            self.send_header("Content-Disposition", 'attachment; filename="%s"' % name)
            self.end_headers()
            # ⚠️ 每块 1 MiB：够大（55 块发完 55 MB，系统调用不多）又够小
            #（并发 32 时峰值也只有 32 MiB，而不是 32 × 55 MB）。
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
            log("分发 cloudflared: %s (%d 字节)" % (name, size))
        except (BrokenPipeError, ConnectionResetError):
            # 客户中途取消（关窗口/断网）是**常态**，不是错误，别刷警告。
            log("分发中断（客户端断开）: %s" % name)
        finally:
            handle.close()

    def do_GET(self):  # noqa: N802 —— 基类接口名
        path = self.path.split("?", 1)[0]
        if path == "/pair/admin":
            self._serve_admin_page()
            return
        if path == "/pair/admin/codes":
            # 激活码全表。与 `/pair/devices` 同级（admin-only）——
            # 它回的是**完整**激活码，级别高于 devices 那份打码列表。
            if not self._admin_ok():
                self._send(401, {"error": "unauthorized"})
                return
            self._send(200, admin_codes())
            return
        if path == "/pair/admin/tunnel":
            if not self._admin_ok():
                self._send(401, {"error": "unauthorized"})
                return
            self._send(200, admin_tunnel())
            return
        if path == "/pair/health":
            self._send(200, {"ok": True, "zone": CF_ZONE_NAME})
            return
        if path.startswith("/pair/cloudflared/"):
            name = path[len("/pair/cloudflared/"):]
            if not self._cloudflared_allowed():
                self._send(
                    429,
                    {
                        "error": "rate-limited",
                        "message": "下载过于频繁，请 %d 分钟后再试" % (CLOUDFLARED_WINDOW // 60),
                    },
                )
                return
            self._serve_cloudflared(name)
            return
        if path == "/pair/cloudflared":
            # 给插件一个「我这个平台该下哪个」的清单，省得两端各写一份映射。
            self._send(200, {"files": sorted(CLOUDFLARED_FILES)})
            return
        if path == "/pair/devices":
            # 已配对设备列表（外部审计 P1-7，管理接口）。
            # ⚠️ 必须 admin —— 它一次回**全部**记录（虽然只有指纹，没有凭据），
            # 对公网开放等于给攻击者一份「有哪些机器、最近谁连过」的侦察报告。
            if not self._admin_ok():
                self._send(401, {"error": "unauthorized"})
                return
            self._send(200, list_devices())
            return
        if path == "/pair/lookup":
            if not self._admin_ok():
                self._send(401, {"error": "unauthorized"})
                return
            query = self.path.split("?", 1)[1] if "?" in self.path else ""
            code = ""
            for pair in query.split("&"):
                if pair.startswith("code="):
                    code = pair[5:]
            self._send(200, lookup(code))
            return
        self._send(404, {"error": "not-found"})

    def do_POST(self):  # noqa: N802
        path = self.path.split("?", 1)[0]
        body = self._read_body()
        if body is None:
            # `_read_body` 已经回过 413 并关了连接。
            return

        if path == "/pair/register":
            # ⚠️ `allow_rebind` **绝不能**从请求体读 —— 那等于把这个开关
            # 直接交给公网（传 `allowRebind:true` 就绕过全部同机判据）。
            # 它只给管理端 CLI 用（`pair_admin.py --reuse`，本地直调函数）。
            #
            # ⚠️ 限流 + 审计（外部审计 3.2 / 3.5）：这个接口无鉴权，且响应
            # 区分 `bad-code`/`revoked`/`device-mismatch`/成功 ⇒ 存在性 oracle。
            origin = request_origin(self)
            limited, retry_after = register_rate_limited(origin["ip"])
            if limited:
                log("注册被限流 ip=%s 冷却=%ds" % (origin["ip"], retry_after))
                audit("register.rate-limited", ip=origin["ip"], ua=origin["ua"])
                self._send(
                    429,
                    {
                        "error": "rate-limited",
                        "message": "尝试次数过多，请 %d 分钟后再试" % max(1, retry_after // 60),
                    },
                )
                return
            code_for_audit = as_text(body.get("code")).strip()
            ok, payload = register(
                body.get("code"),
                body.get("device"),
                body.get("clientSecret"),
                allow_rebind=False,
            )
            # ⚠️ **只记前 8 位**：审计文件会长期留存，不能把完整激活码写进去
            # —— 那等于把「凭激活码即可接管」的东西换个地方存着。
            if ok:
                audit(
                    "register.ok",
                    code=code_for_audit[:8],
                    hostname=payload.get("hostname"),
                    reused=payload.get("reused"),
                    ip=origin["ip"],
                    ua=origin["ua"],
                )
            else:
                note_register_failure(origin["ip"])
                audit(
                    "register.fail",
                    code=code_for_audit[:8],
                    reason=payload.get("error"),
                    ip=origin["ip"],
                    ua=origin["ua"],
                )
            self._send(200 if ok else 400, payload)
            return

        if path == "/pair/release":
            # 客户机主动解绑（外部审计 4.3）：清掉服务端记录，让同一激活码可再注册。
            # ⚠️ 要设备凭据 —— 否则知道激活码就能解绑别人的机器（服务级 DoS）。
            ok, payload = release_record(body.get("code"), body.get("clientSecret"))
            audit(
                "release.%s" % ("ok" if ok else "fail"),
                code=as_text(body.get("code")).strip()[:8],
                reason=None if ok else payload.get("error"),
                **request_origin(self),
            )
            self._send(200 if ok else 400, payload)
            return

        if path == "/pair/rotate":
            # ⚠️ 两条路共用一个 URL，靠 admin 头分流：
            #  - 带 admin 头：管理端「一键轮换」（外部审计 P1-7），不需要设备凭据 ——
            #    需要轮换的人往往正是**已经丢了凭据**的那个人，让他自证是矛盾的。
            #  - 不带：客户端自助轮换，必须设备凭据匹配。
            admin = self._admin_ok()
            ok, payload = rotate_token(
                body.get("code"), body.get("clientSecret"), admin=admin
            )
            audit(
                "rotate.%s" % ("ok" if ok else "fail"),
                by="admin" if admin else "device",
                code=as_text(body.get("code")).strip()[:8],
                reason=None if ok else payload.get("error"),
                **request_origin(self),
            )
            self._send(200 if ok else 400, payload)
            return

        if path == "/pair/handshake":
            # 电脑端：拿到凭据后换一个短配对码给手机。
            ok, payload = make_handshake(body.get("code"), body.get("clientSecret"))
            self._send(200 if ok else 400, payload)
            return

        if path == "/pair/claim":
            # 手机端：用配对码换连接凭据（一次性）。
            #
            # ⚠️ 这是**唯一一个不需要任何凭据就能打**的接口（配对码就是凭据
            # 本身），所以也是唯一的暴力破解面 —— 必须限流（见 CLAIM_* 常量）。
            client_ip = _client_ip(self)
            limited, retry_after = claim_rate_limited(client_ip)
            if limited:
                log("配对码领取被限流 ip=%s 冷却=%ds" % (client_ip, retry_after))
                self._send(
                    429,
                    {
                        "error": "rate-limited",
                        "message": "尝试次数过多，请 %d 分钟后再试" % max(1, retry_after // 60),
                    },
                )
                return
            ok, payload = claim_handshake(body.get("pairCode"), request_origin(self))
            if not ok:
                note_claim_failure(client_ip)
            # ⚠️ 审计**成功也要记**（外部审计 3.5）：配对码被领取是「一台手机
            # 绑上了一台电脑」这个动作，是事后回溯「谁的手机连过哪台机器」的
            # 唯一线索。原来只记「配对码 %s 已被领取」，没有 IP/UA。
            audit(
                "claim.%s" % ("ok" if ok else "fail"),
                code=as_text(body.get("pairCode")).strip(),
                reason=None if ok else payload.get("error"),
                **request_origin(self),
            )
            self._send(200 if ok else 400, payload)
            return

        if path == "/pair/unregister":
            if not self._admin_ok():
                self._send(401, {"error": "unauthorized"})
                return
            ok, payload = unregister(body.get("code"))
            audit(
                "unregister",
                code=as_text(body.get("code")).strip()[:8],
                ok=ok,
                **request_origin(self),
            )
            self._send(200 if ok else 400, payload)
            return

        if path == "/pair/migrate":
            # 老记录迁移（外部审计 3.1 / 修复清单 P0-3）：给无 `clientSecret` 的
            # 记录补发设备凭据并**轮换** `accessToken`。
            #
            # ⚠️ 必须是**管理接口**（要 admin 头）：如果它对公网开放，那就等于
            # 把刚删掉的 `legacy_claim` 原样搬回来 —— 凭激活码就能拿令牌。
            if not self._admin_ok():
                self._send(401, {"error": "unauthorized"})
                return
            ok, payload = migrate_record(body.get("code"))
            audit(
                "migrate",
                code=as_text(body.get("code")).strip()[:8],
                ok=ok,
                reason=None if ok else payload.get("error"),
                **request_origin(self),
            )
            self._send(200 if ok else 400, payload)
            return

        if path == "/pair/codes":
            # 批量生成激活码（管理接口）。
            if not self._admin_ok():
                self._send(401, {"error": "unauthorized"})
                return
            count = int(body.get("count") or 1)
            count = max(1, min(count, 100))
            note = str(body.get("note") or "")
            with _LOCK:
                codes = read_json(CODES_PATH, {})
                made = []
                while len(made) < count:
                    # ⚠️ **16 字节 = 128 bit 熵**（外部审计 3.2 要求 ≥64 bit）。
                    # 原来是 `token_hex(4)` = 4 字节 = **32 bit** —— 纯爆破约 74 天，
                    # 看着还行，但那个估算假设攻击者被限流；而限流是这一轮才加的。
                    # 更关键的是：激活码会以**截图 / 客服记录 / 微信**形式外流，
                    # 一旦外流，32 bit 与 128 bit 的差别就是「试到就中」与「试不动」。
                    # 老码（8 位）仍可用 —— `register` 只是查表，不校验长度。
                    candidate = secrets.token_hex(16).upper()
                    if candidate in codes:
                        continue
                    codes[candidate] = {"note": note, "createdAt": int(time.time())}
                    made.append(candidate)
                write_json(CODES_PATH, codes)
            log("生成 %d 个激活码" % len(made))
            self._send(200, {"codes": made})
            return

        if path == "/pair/revoke":
            if not self._admin_ok():
                self._send(401, {"error": "unauthorized"})
                return
            code = as_text(body.get("code")).strip()
            with _LOCK:
                codes = read_json(CODES_PATH, {})
                if code not in codes:
                    self._send(400, {"error": "bad-code"})
                    return
                codes[code]["revoked"] = bool(body.get("revoked", True))
                write_json(CODES_PATH, codes)
            log("激活码 %s revoked=%s" % (code, body.get("revoked", True)))
            self._send(200, {"code": code, "revoked": codes[code]["revoked"]})
            return

        self._send(404, {"error": "not-found"})


def main():
    os.makedirs(STATE_DIR, exist_ok=True)
    for required, label in (
        (CF_TOKEN, "CF_API_TOKEN"),
        (CF_ACCOUNT, "CF_ACCOUNT_ID"),
        (CF_ZONE, "CF_ZONE_ID"),
        (ADMIN_SECRET, "PAIR_ADMIN_SECRET"),
    ):
        if not required:
            log("⚠️ 缺少环境变量 %s，服务仍会启动但相关接口不可用" % label)

    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    # ---- 抗 slowloris / 抗内存耗尽（外部审计 P2-9）----------------------
    #
    # 三个都要设，少一个都能被打穿：
    #
    # 1. `timeout`（socket 级）：一个连接读/写超过 20s 没进展就断。
    #    没有它，攻击者连上之后**永远不发完请求头**，线程就一直挂在那里 ——
    #    这是 slowloris 的标准打法，而它**不需要任何凭据**。
    # 2. `daemon_threads = True`：进程退出时不被残留线程拖住（否则 `kill`
    #    之后要等几十秒，运维时很痛）。
    # 3. `MAX_CONCURRENT_REQUESTS`：`ThreadingHTTPServer` **默认无上限**
    #    —— 每个连接开一个线程。配上 socket 超时，攻击者仍能用
    #    「大量并发慢连接」把线程数堆到几千。这里用小信号量封顶，
    #    超出的请求**排队**（短暂等待）而不是直接拒绝 —— 正常客户的下一次
    #    请求通常排在几毫秒内，不该因为有人在刷就被拒。
    server.timeout = SOCKET_TIMEOUT
    server.daemon_threads = True
    server.request_queue_size = 64

    # ⚠️ 这里必须是 `process_request` 而不是在 handler 里计数：
    # handler 在**线程已经开了之后**才跑，那时线程/TCP 连接已经建好，
    # 挡不住「开线程」这个动作本身。`process_request` 是 accept 之后、
    # 开线程之前的那个钩子。
    original_process_request = server.process_request
    slots = threading.Semaphore(MAX_CONCURRENT_REQUESTS)

    def capped_process_request(request, client_address):
        if not slots.acquire(timeout=SOCKET_TIMEOUT):
            log("并发上限已满（%d），拒绝连接 %s" % (MAX_CONCURRENT_REQUESTS, client_address[0]))
            try:
                request.close()
            except OSError:
                pass
            return
        original_process_request(request, client_address)

    server.process_request = capped_process_request

    # 包一层 `process_request_thread`：线程结束才释放槽位，不能提前放。
    original_thread = server.process_request_thread

    def releasing_thread(request, client_address):
        try:
            original_thread(request, client_address)
        finally:
            slots.release()

    server.process_request_thread = releasing_thread

    log(
        "dsh-pair listening on %s:%d (zone=%s) body<=%dKB timeout=%ds concurrency<=%d"
        % (LISTEN_HOST, LISTEN_PORT, CF_ZONE_NAME, MAX_BODY_BYTES // 1024, SOCKET_TIMEOUT, MAX_CONCURRENT_REQUESTS)
    )
    # ⚠️ 在**独立线程**里跑自检：它会向本机发一个 HTTP 请求，而主线程此时
    # 还没进 `serve_forever()` —— 直接同步调用会自己把自己堵死（经典自锁）。
    # 加一点延迟，等 `serve_forever` 真的开始收连接。
    def _deferred_assert():
        time.sleep(2)
        _assert_xff_trustworthy()

    threading.Thread(target=_deferred_assert, name="xff-assert", daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
