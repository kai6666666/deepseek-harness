#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一致性体检：远端版本 / 验收表最新行 / 设备版本戳 / client 字节数 / APK 体积。

用法：
    python3 tools/drift_check.py            # 表格输出，漂移时退出码 1
    python3 tools/drift_check.py --json     # 机器可读
数据来源：
    远端  EngineManager.kt 的 MOBILE_UI_VERSION、lib/client.js 的 size
    本地  tools/../mobile-ui-plugin/.../client.js（字节数 + sha256 前 16 位）
    验收表 docs/agents/mobile-ui-verification.md 的最新一行
    设备  /sdcard/Download/verify-<ver>.txt 里的 stamp=（最近一次取证快照）
    产物  /sdcard/Download/verify-<ver>.meta.json 与 dsh-ci-<ver>.apk
"""
import base64
import json
import os
import re
import sys
import urllib.request

try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass

REPO = "kai6666666/deepseek-harness"
API = f"https://api.github.com/repos/{REPO}"
WORKSPACE = "/storage/emulated/0/MT2/apks/deepseek harness/DSHAPP-main"
CLIENT = f"{WORKSPACE}/mobile-ui-plugin/dsh-android-mobile/lib/client.js"
DOC = f"{WORKSPACE}/docs/agents/mobile-ui-verification.md"
DOWNLOAD = "/storage/emulated/0/Download"
TOKEN_FILE = "/tmp/gh_token"


def token():
    with open(TOKEN_FILE) as f:
        return f.read().strip()


def api(path):
    r = urllib.request.Request(API + path)
    r.add_header("Authorization", f"Bearer {token()}")
    r.add_header("User-Agent", "dsh-drift")
    with urllib.request.urlopen(r, timeout=60) as resp:
        return json.loads(resp.read().decode())


def remote_version():
    d = api("/contents/app/src/main/java/com/dsh/android/EngineManager.kt?ref=main")
    txt = base64.b64decode(d["content"]).decode()
    m = re.search(r'const val MOBILE_UI_VERSION = "([^"]+)"', txt)
    return m.group(1) if m else None


def remote_client_size():
    d = api("/contents/mobile-ui-plugin/dsh-android-mobile/lib/client.js?ref=main")
    return d.get("size")


def local_client():
    blob = open(CLIENT, "rb").read()
    import hashlib
    return len(blob), hashlib.sha256(blob).hexdigest()[:16]


def latest_row():
    if not os.path.exists(DOC):
        return None
    best = None
    for line in open(DOC, encoding="utf-8"):
        m = re.match(r"\|\s*(\d+)\.(\d+)\.(\d+)-(\d+)\s*\|", line)
        if not m:
            continue
        key = tuple(int(x) for x in m.groups())
        if best is None or key > best[0]:
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            best = (key, cells)
    if not best:
        return None
    cells = best[1]
    return {
        "version": cells[0],
        "stamp": cells[1],
        "run": cells[2],
        "apk": cells[3],
        "client": cells[4],
        "dex": cells[5],
        "round": cells[10] if len(cells) > 10 else "?",
        "retries": cells[11] if len(cells) > 11 else "?",
    }


def device_stamp(version):
    p = f"{DOWNLOAD}/verify-{version}.txt"
    if not os.path.exists(p):
        return None
    for line in open(p, encoding="utf-8", errors="replace"):
        if line.startswith("stamp="):
            return line.split("=", 1)[1].strip() or None
    return None


def meta(version):
    p = f"{DOWNLOAD}/verify-{version}.meta.json"
    if not os.path.exists(p):
        return None
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return None


def apk_size(version):
    p = f"{DOWNLOAD}/dsh-ci-{version}.apk"
    return os.path.getsize(p) if os.path.exists(p) else None


def main():
    as_json = "--json" in sys.argv
    rv = remote_version()
    rsize = remote_client_size()
    lsize, lsha = local_client()
    row = latest_row() or {}
    lv = row.get("version")

    checks = []

    def add(name, expect, actual, ok):
        checks.append({"name": name, "expect": expect, "actual": actual, "ok": bool(ok)})

    add("远端版本 = 验收表最新版本", rv, lv, rv and lv and rv == lv)
    add("验收表设备戳 = 该行版本", lv, row.get("stamp"), lv and row.get("stamp") == lv)
    add("远端 client 字节 = 本地", rsize, lsize, rsize == lsize)
    if lv:
        m = meta(lv) or {}
        add("验收表 client = 本地 client", row.get("client"),
            f"{lsize:,} B", row.get("client") == f"{lsize:,} B")
        add("meta.client = 本地 client", m.get("client"), lsize, m.get("client") == lsize)
        add("meta.dex 命中 = 2", m.get("dex_hit"), 2, m.get("dex_hit") == 2)
        ds = device_stamp(lv)
        add("设备取证戳 = 最新版本", lv, ds, ds == lv)
        asz = apk_size(lv)
        add("APK 体积 = meta 记录", m.get("apk_size"), asz, asz is not None and m.get("apk_size") == asz)
        add("验收表轮次已记录", "≥1", row.get("round"),
            row.get("round") not in (None, "—", "?"))

    drift = [c for c in checks if not c["ok"]]

    if as_json:
        print(json.dumps({"remote": rv, "doc": lv, "client": {"local": lsize, "remote": rsize, "sha16": lsha},
                          "checks": checks, "drift": len(drift)}, ensure_ascii=False, indent=2))
    else:
        print(f"远端版本 {rv}｜验收表 {lv}｜client 本地 {lsize:,} B / 远端 {rsize:,} B（sha256 {lsha}）")
        print()
        for c in checks:
            print(f"{'✅' if c['ok'] else '❌'} {c['name']}：期望 {c['expect']}，实际 {c['actual']}")
        print()
        print("结论：" + ("全部一致" if not drift else f"{len(drift)} 项漂移"))
    return 0 if not drift else 1


if __name__ == "__main__":
    sys.exit(main())