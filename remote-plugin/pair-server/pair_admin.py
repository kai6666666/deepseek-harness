#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-pair 管理脚本 —— 在服务器上生成 / 查看 / 停用激活码。

用法（都跑在服务器上）：

    python3 pair_admin.py new 5 --note "微信群第一批"
    python3 pair_admin.py list
    python3 pair_admin.py show ABC12345
    python3 pair_admin.py revoke ABC12345
    python3 pair_admin.py restore ABC12345
    python3 pair_admin.py unregister ABC12345   # 删隧道 + 删 DNS，码可再用
    python3 pair_admin.py migrate ABC12345      # 老记录补发凭据 + 轮换令牌
    python3 pair_admin.py devices               # 已配对设备列表（不含任何凭据）
    python3 pair_admin.py rotate ABC12345       # 一键轮换访问令牌（令牌疑似泄露时用）

`new` 输出的激活码直接发给客户；客户在插件里填一次即可。

⚠️ `migrate` 只对 1.0.16 之前注册的**无设备凭据**记录有意义。这些记录以前走
「激活码 + 主机名」的一次性认领，那条路径是**静默接管**漏洞，已彻底删除；
现在必须由管理员显式迁移（会**轮换** `accessToken`，客户机需重新配对）。
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("PAIR_BASE", "http://127.0.0.1:18901")
SECRET_PATH = "/root/dsh/pair/admin.secret"


def secret():
    """读管理密钥；读不到就报错退出（绝不猜默认值）。"""
    try:
        with open(SECRET_PATH, "r", encoding="utf-8") as handle:
            return handle.read().strip()
    except OSError as error:
        print("读不到管理密钥 %s：%s" % (SECRET_PATH, error), file=sys.stderr)
        sys.exit(1)


def stamp(epoch):
    """把秒级时间戳打成人类可读的本地时间；无效值回 `-`。"""
    try:
        return time.strftime("%Y-%m-%d %H:%M", time.localtime(int(epoch)))
    except (TypeError, ValueError):
        return "-"


def call(path, body=None, method="POST"):
    """调管理接口，返回 `(ok, payload)`。"""
    url = BASE + path
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("X-Pair-Admin", secret())
    request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return True, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        try:
            return False, json.loads(raw)
        except ValueError:
            return False, {"raw": raw}


def main():
    parser = argparse.ArgumentParser(description="dsh-pair 激活码管理")
    sub = parser.add_subparsers(dest="command", required=True)

    new = sub.add_parser("new", help="生成激活码")
    new.add_argument("count", nargs="?", type=int, default=1)
    new.add_argument("--note", default="")

    show = sub.add_parser("show", help="查一个激活码的状态")
    show.add_argument("code")

    revoke = sub.add_parser("revoke", help="停用激活码")
    revoke.add_argument("code")

    restore = sub.add_parser("restore", help="恢复激活码")
    restore.add_argument("code")

    unregister = sub.add_parser("unregister", help="注销：删隧道 + 删 DNS，码可再用")
    unregister.add_argument("code")

    sub.add_parser("list", help="列出所有激活码")

    sub.add_parser("devices", help="列出已配对设备（不含任何凭据）")

    rotate = sub.add_parser(
        "rotate",
        help="一键轮换访问令牌（令牌疑似泄露时用；不影响设备凭据，无需重新配对）",
    )
    rotate.add_argument("code")

    migrate = sub.add_parser(
        "migrate", help="迁移老记录：补发设备凭据并轮换访问令牌（客户机需重新配对）"
    )
    migrate.add_argument("code")

    args = parser.parse_args()

    if args.command == "new":
        ok, payload = call("/pair/codes", {"count": args.count, "note": args.note})
        if not ok:
            print("失败：%s" % json.dumps(payload, ensure_ascii=False))
            sys.exit(1)
        print("新激活码（发给客户）：")
        for code in payload["codes"]:
            print("  " + code)
        return

    if args.command == "show":
        ok, payload = call("/pair/lookup?code=" + args.code, method="GET")
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return

    if args.command in ("revoke", "restore"):
        ok, payload = call(
            "/pair/revoke",
            {"code": args.code, "revoked": args.command == "revoke"},
        )
        print(json.dumps(payload, ensure_ascii=False))
        return

    if args.command == "unregister":
        ok, payload = call("/pair/unregister", {"code": args.code})
        print(json.dumps(payload, ensure_ascii=False))
        return

    if args.command == "migrate":
        # ⚠️ 迁移会**轮换 accessToken**：客户机上那把旧令牌立刻失效，
        # 必须让客户重新配对一次。这是「零客户」现状下可以接受的代价 ——
        # 换来的是彻底删掉「凭激活码即可静默接管」那条路径。
        ok, payload = call("/pair/migrate", {"code": args.code})
        if not ok:
            print("失败：%s" % json.dumps(payload, ensure_ascii=False))
            sys.exit(1)
        print("已迁移 %s（子域名 %s）" % (args.code, payload.get("subdomain")))
        print("新的 clientSecret（交付给客户机，或让客户重新配对）：")
        print("  " + str(payload.get("clientSecret")))
        print("⚠️ 旧 accessToken 已失效，客户机上的手机需要重新配对。")
        return

    if args.command == "devices":
        ok, payload = call("/pair/devices", method="GET")
        if not ok:
            print("失败：%s" % json.dumps(payload, ensure_ascii=False))
            sys.exit(1)
        devices = payload.get("devices", [])
        if not devices:
            print("还没有任何已配对设备。")
            return
        print("共 %d 台（激活码只显示前 8 位）：" % payload.get("count", len(devices)))
        for item in devices:
            flags = []
            if item.get("revoked"):
                flags.append("已停用")
            if not item.get("hasDeviceSecret"):
                flags.append("待迁移")
            if item.get("rotatedAt"):
                flags.append("轮换于 %s(%s)" % (stamp(item["rotatedAt"]), item.get("rotatedBy")))
            last_claim = item.get("lastClaimAt")
            print(
                "  %-10s %-28s %-16s %s"
                % (
                    item.get("code") or "-",
                    item.get("hostname") or "-",
                    item.get("deviceLabel") or "-",
                    # 「最近谁连过」是这张表最有用的一列：一台机器的令牌被
                    # 别人拿去用了，症状就是这里冒出一个陌生的 IP。
                    ("最近领取 %s 来自 %s（共 %d 次）"
                     % (stamp(last_claim), item.get("lastClaimIp") or "?", item.get("claimCount", 0)))
                    if last_claim
                    else "尚未被手机领取",
                )
            )
            if flags:
                print("             %s" % "；".join(flags))
        return

    if args.command == "rotate":
        # ⚠️ 走 admin 头（`/pair/rotate` 靠它分流到管理通道），
        # 所以**不需要 clientSecret** —— 这正是「令牌泄露后还能救」的关键。
        ok, payload = call("/pair/rotate", {"code": args.code})
        if not ok:
            print("失败：%s" % json.dumps(payload, ensure_ascii=False))
            sys.exit(1)
        print("已轮换 %s（子域名 %s）" % (args.code, payload.get("subdomain")))
        print("新的 accessToken（客户机需要更新，或让客户在插件里重新拉一次）：")
        print("  " + str(payload.get("accessToken")))
        print("⚠️ 客户端若已配对，本地 pair.json 里的旧令牌已失效 —— 手机端重新配对即可。")
        return

    if args.command == "list":
        # 没有列表接口，直接读状态文件（脚本和 server 在同一台机器上）。
        state = os.environ.get("PAIR_STATE_DIR", "/workspace/dsh-pair")
        try:
            with open(os.path.join(state, "codes.json"), encoding="utf-8") as handle:
                codes = json.load(handle)
            with open(os.path.join(state, "records.json"), encoding="utf-8") as handle:
                records = json.load(handle)
        except OSError as error:
            print("读状态失败：%s" % error, file=sys.stderr)
            sys.exit(1)
        print("%-10s %-8s %-22s %s" % ("激活码", "状态", "子域名", "备注"))
        for code, entry in sorted(codes.items()):
            record = records.get(code)
            if entry.get("revoked"):
                state_text = "已停用"
            elif record and not record.get("clientSecret"):
                # ⚠️ 老记录：**现在注册会直接被拒**（见 pair_server.register），
                # 必须 migrate。列在这里是为了让运维一眼看到还有几条没处理。
                state_text = "待迁移"
            elif record:
                state_text = "已注册"
            else:
                state_text = "未使用"
            print(
                "%-10s %-8s %-22s %s"
                % (code, state_text, (record or {}).get("subdomain", "-"), entry.get("note", ""))
            )
        return


if __name__ == "__main__":
    main()
