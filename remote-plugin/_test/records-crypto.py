#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""`records.json` 静态加密 + 管理端列表/轮换的验收（外部审计 P1-5 / P1-7）。

跑法（Windows 本机，**不联网**、**不碰线上**）：

    cd remote-plugin\\pair-server
    & "C:\\Users\\你的用户名\\AppData\\Local\\Python\\PythonCore-3.14-64\\python.exe" ..\\_test\\records-crypto.py

它把 `PAIR_STATE_DIR` 指到临时目录、把 Cloudflare 三件套留空，
然后 `import pair_server`。三层断言：

1. **加密往返**：`save_records` 之后**文件字节里搜不到任何明文令牌**
   （这是这条审计项唯一真正的判据 —— 「代码看起来加密了」不算数）；
   `load_records` 读回来必须与原值**逐字节相等**。
2. **fail-closed**：既没有 `PAIR_RECORD_KEY` 也没有 `PAIR_ADMIN_SECRET` 时，
   `_seal` **必须抛**，不能悄悄退回明文。
3. **管理面**（P1-7）：`list_devices` 的返回里不能出现任何凭据字段；
   `rotate_token(admin=True)` 能换掉令牌且**不动** `clientSecret`。

⚠️ 输出**只用 ASCII**：本机控制台是 GBK，`⇒` / `✅` 这种字符会让脚本自己崩
（与 `pair_server.log()` 同一个坑）。
"""

import json
import os
import shutil
import sys
import tempfile

FAILED = []
PASSED = [0]


def check(label, condition, detail=""):
    if condition:
        PASSED[0] += 1
        print("  ok   %s" % label)
    else:
        FAILED.append(label)
        print("  FAIL %s %s" % (label, detail))


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    server_dir = os.path.join(os.path.dirname(here), "pair-server")
    if not os.path.isfile(os.path.join(server_dir, "pair_server.py")):
        print("找不到 pair_server.py（%s）" % server_dir)
        return 1

    state = tempfile.mkdtemp(prefix="pair-records-")
    try:
        os.environ["PAIR_STATE_DIR"] = state
        os.environ["PAIR_RECORD_KEY"] = "11" * 32  # 32 字节的确定性测试密钥
        os.environ.pop("PAIR_ADMIN_SECRET", None)
        sys.path.insert(0, server_dir)
        import pair_server as srv

        print("[1] 加密往返")

        # ⚠️ 用**有辨识度的长串**当令牌：这样「文件里搜不到明文」这条断言才有
        # 意义 —— 短值（比如 "abc"）本来就可能偶然出现在 base64 里。
        access = "ACCESS-TOKEN-PLAINTEXT-MARKER-0123456789abcdef"
        tunnel = "TUNNEL-TOKEN-PLAINTEXT-MARKER-fedcba9876543210"
        secret = "CLIENT-SECRET-PLAINTEXT-MARKER-aaaabbbbccccdddd"
        # ⚠️ 激活码要**长于 8 位**：真码是 32 位 hex，而列表接口只回前 8 位。
        # 用 8 位的测试码时，「列表里没有完整激活码」这条断言恒假 ——
        # 那是测试数据的问题，不是代码的问题。
        code = "AAAABBBBCCCCDDDD"
        records = {
            code: {
                "subdomain": "calm-river-1234",
                "hostname": "calm-river-1234.jiulingssh.xyz",
                "tunnelId": "11111111-2222-3333-4444-555555555555",
                "accessToken": access,
                "tunnelToken": tunnel,
                "clientSecret": secret,
                "deviceLabel": "你的用户名",
                "createdAt": 1700000000,
            }
        }
        srv.save_records(records)

        raw = open(srv.RECORDS_PATH, "rb").read()
        text = raw.decode("utf-8")
        for label, value in (
            ("accessToken", access),
            ("tunnelToken", tunnel),
            ("clientSecret", secret),
        ):
            check(
                "文件里没有明文 %s" % label,
                value not in text,
                "（明文落盘了！）",
            )
        check("文件里出现加密前缀 v1:", "v1:" in text)
        # 非敏感字段必须保持可读 —— 否则运维 `cat records.json` 就失去了意义，
        # 而那正是「逐字段加密」而不是「整份加密」的理由。
        check("非敏感字段仍可读（subdomain）", "calm-river-1234" in text)

        # ⚠️ 调用方手里的记录不能被就地改动：`register` 拿到返回值之后还要用它
        # 去建隧道、回给客户端，被改成密文就全错了。
        check("save_records 没有就地改动入参", records[code]["accessToken"] == access)

        loaded = srv.load_records()
        got = loaded.get(code) or {}
        check("load 回 accessToken 一致", got.get("accessToken") == access)
        check("load 回 tunnelToken 一致", got.get("tunnelToken") == tunnel)
        check("load 回 clientSecret 一致", got.get("clientSecret") == secret)
        check("load 回非敏感字段一致", got.get("deviceLabel") == "你的用户名")

        # 幂等：加密过的值再 seal 一次不能被套两层（否则 load 出来是内层密文）。
        once = srv._seal(access)
        twice = srv._seal(once)
        check("_seal 幂等", once == twice)
        check("_open(_seal(x)) == x", srv._open(once) == access)
        check("_open 对空值原样返回", srv._open("") == "" and srv._open(None) is None)

        # ⚠️ 解不开必须**原样返回**而不是抛：老记录还没迁移时如果抛，
        # 整个服务会 500；返回密文则等价于「不认识这个凭据」，安全上正确。
        os.environ["PAIR_RECORD_KEY"] = "22" * 32
        srv._RECORD_KEY = None  # 清缓存，模拟「换了密钥后重启」
        broken = srv.load_records().get(code) or {}
        check(
            "换密钥后解不开 -> 原样返回（不抛）",
            isinstance(broken.get("accessToken"), str)
            and broken.get("accessToken") != access,
        )
        os.environ["PAIR_RECORD_KEY"] = "11" * 32
        srv._RECORD_KEY = None

        print("[2] fail-closed")
        os.environ.pop("PAIR_RECORD_KEY", None)
        srv._RECORD_KEY = None
        thrown = False
        try:
            srv._seal("something-secret")
        except RuntimeError:
            thrown = True
        check("无密钥时 _seal 抛错（拒绝明文落盘）", thrown)
        # 老记录读回原样，而不是崩掉。
        check("无密钥时 _open 不抛", srv._open("v1:whatever") == "v1:whatever")
        os.environ["PAIR_RECORD_KEY"] = "11" * 32
        srv._RECORD_KEY = None

        print("[3] 管理面：设备列表不含凭据")
        devices = srv.list_devices()
        check("count 与记录数一致", devices.get("count") == 1)
        row = (devices.get("devices") or [{}])[0]
        blob = json.dumps(devices, ensure_ascii=False)
        for field in ("accessToken", "tunnelToken", "clientSecret"):
            check("列表里没有 %s" % field, field not in blob)
        check("列表里没有完整激活码", code not in blob)
        check("列表里有 8 位截断码", row.get("code") == code[:8])
        check("列表标记了有设备凭据", row.get("hasDeviceSecret") is True)
        check("列表带上 hostname", row.get("hostname", "").endswith("jiulingssh.xyz"))

        print("[4] 管理端一键轮换不动 clientSecret")
        before = (srv.load_records().get(code) or {})
        ok, payload = srv.rotate_token(code, None, admin=True)
        check("admin 轮换成功（无需设备凭据）", ok is True)
        after = (srv.load_records().get(code) or {})
        check("accessToken 已换", after.get("accessToken") != before.get("accessToken"))
        check(
            "返回的新令牌与落盘一致",
            payload.get("accessToken") == after.get("accessToken"),
        )
        check("clientSecret 保持不变", after.get("clientSecret") == secret)
        check("留痕 rotatedBy=admin", after.get("rotatedBy") == "admin")
        check("响应里没有 tunnelToken", "tunnelToken" not in payload)

        # 没有 admin 且凭据不符 -> 必须拒绝。
        ok2, _ = srv.rotate_token(code, "wrong-secret")
        check("凭据不符时拒绝轮换", ok2 is False)
        # 带上正确设备凭据 -> 放行（客户端自助路径）。
        ok3, _ = srv.rotate_token(code, secret)
        check("设备凭据正确时放行", ok3 is True)

        print("[5] 领取留痕（P1-7）")
        _, hand = srv.make_handshake(code, secret)
        pair_code = hand.get("pairCode")
        ok4, _ = srv.claim_handshake(pair_code, {"ip": "203.0.113.9", "ua": "test-agent"})
        check("领取成功", ok4 is True)
        rec = srv.load_records().get(code) or {}
        check("记录了 lastClaimIp", rec.get("lastClaimIp") == "203.0.113.9")
        check("记录了 claimCount", rec.get("claimCount") == 1)
        row2 = (srv.list_devices().get("devices") or [{}])[0]
        check("列表能看出最近领取来源", row2.get("lastClaimIp") == "203.0.113.9")

        print()
        print("PASSED=%d FAILED=%d" % (PASSED[0], len(FAILED)))
        for item in FAILED:
            print("  - %s" % item)
        return 1 if FAILED else 0
    finally:
        shutil.rmtree(state, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
