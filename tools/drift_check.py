#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一致性体检：远端版本 / 验收表最新行 / 设备版本戳 / client 字节数 / APK 体积。

用法：
    python3 tools/drift_check.py               # 表格输出，漂移时退出码 1
    python3 tools/drift_check.py --json        # 机器可读
    python3 tools/drift_check.py --save <ver>  # 另存 verify-<ver>.drift.json 供登记表引用
    python3 tools/drift_check.py --fix         # 能自愈的项直接修（meta 体积 / 表内 client），修完再体检
数据来源：
    远端  EngineManager.kt 的 MOBILE_UI_VERSION、lib/client.js 的 size
    本地  mobile-ui-plugin/.../client.js（字节数 + sha256 前 16 位）
    验收表 docs/agents/mobile-ui-verification.md 的最新一行
    设备  /sdcard/Download/verify-<ver>.txt 里的 stamp=（最近一次取证快照）
    产物  /sdcard/Download/verify-<ver>.meta.json 与 dsh-ci-<ver>.apk
"""
import base64
import hashlib
import json
import os
import re
import sys
import time
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
MB = 1024 * 1024


def token():
    with open(TOKEN_FILE) as f:
        return f.read().strip()


def api(path, method="GET", body=None):
    data = json.dumps(body).encode() if body else None
    r = urllib.request.Request(API + path, data=data, method=method)
    r.add_header("Authorization", f"Bearer {token()}")
    r.add_header("User-Agent", "dsh-drift")
    if data:
        r.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(r, timeout=90) as resp:
        raw = resp.read().decode()
        return json.loads(raw) if raw.strip() else None


def remote_version():
    d = api("/contents/app/src/main/java/com/dsh/android/EngineManager.kt?ref=main")
    txt = base64.b64decode(d["content"]).decode()
    m = re.search(r'const val MOBILE_UI_VERSION = "([^"]+)"', txt)
    return m.group(1) if m else None


def remote_client_size():
    return api("/contents/mobile-ui-plugin/dsh-android-mobile/lib/client.js?ref=main").get("size")


def local_client():
    blob = open(CLIENT, "rb").read()
    return len(blob), hashlib.sha256(blob).hexdigest()[:16]


def doc_lines():
    return open(DOC, encoding="utf-8").read().splitlines() if os.path.exists(DOC) else []


def latest_row():
    best = None
    for line in doc_lines():
        m = re.match(r"\|\s*(\d+)\.(\d+)\.(\d+)-(\d+)\s*\|", line)
        if not m:
            continue
        key = tuple(int(x) for x in m.groups())
        if best is None or key > best[0]:
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            best = (key, cells)
    if not best:
        return None
    c = best[1]
    return {"version": c[0], "stamp": c[1], "run": c[2], "apk": c[3], "client": c[4],
            "dex": c[5], "round": (c[10] if len(c) > 10 else "?"),
            "retries": (c[11] if len(c) > 11 else "?"),
            "drift": (c[15] if len(c) > 15 else "?")}


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


def collect():
    rv = remote_version()
    rsize = remote_client_size()
    lsize, lsha = local_client()
    row = latest_row() or {}
    lv = row.get("version")
    checks = []

    def add(name, expect, actual, ok, fixable=False):
        checks.append({"name": name, "expect": expect, "actual": actual, "ok": bool(ok), "fixable": fixable})

    add("远端版本 = 验收表最新版本", rv, lv, rv and lv and rv == lv)
    add("验收表设备戳 = 该行版本", lv, row.get("stamp"), lv and row.get("stamp") == lv)
    add("远端 client 字节 = 本地", rsize, lsize, rsize == lsize)
    if lv:
        m = meta(lv) or {}
        add("验收表 client = 本地 client", row.get("client"),
            f"{lsize:,} B", row.get("client") == f"{lsize:,} B", fixable=True)
        add("meta.client = 本地 client", m.get("client"), lsize, m.get("client") == lsize, fixable=True)
        add("meta.dex 命中 = 2", m.get("dex_hit"), 2, m.get("dex_hit") == 2)
        ds = device_stamp(lv)
        add("设备取证戳 = 最新版本", lv, ds, ds == lv)
        asz = apk_size(lv)
        add("APK 体积 = meta 记录", m.get("apk_size"), asz,
            asz is not None and m.get("apk_size") == asz, fixable=True)
        add("验收表轮次已记录", "≥1", row.get("round"), row.get("round") not in (None, "—", "?"))
    return {"rv": rv, "rsize": rsize, "lsize": lsize, "lsha": lsha, "row": row, "lv": lv, "checks": checks}


def push_doc(text):
    try:
        cur = api("/contents/docs/agents/mobile-ui-verification.md?ref=main")
        sha = cur.get("sha")
    except Exception:
        sha = None
    body = {"message": "fix: drift_check 自动校正验收表 client 字节", "content": base64.b64encode(text.encode()).decode(), "branch": "main"}
    if sha:
        body["sha"] = sha
    api("/contents/docs/agents/mobile-ui-verification.md", method="PUT", body=body)
    print("[drift] 已推送修正后的 docs/agents/mobile-ui-verification.md")


def apply_fix(data):
    """只修可安全重算的项：meta 体积/client、验收表当前行的 client 字节。"""
    fixed = []
    lv = data["lv"]
    if not lv:
        return fixed

    # ① meta：APK 体积与 client 字节按实盘/本地重算
    mp = f"{DOWNLOAD}/verify-{lv}.meta.json"
    m = meta(lv) or {}
    if m:
        before = dict(m)
        asz = apk_size(lv)
        if asz is not None and m.get("apk_size") != asz:
            m["apk_size"] = asz
            m["apk_mb"] = round(asz / MB, 1)
            fixed.append(f"meta.apk_size {before.get('apk_size')} → {asz}")
        if m.get("client") != data["lsize"]:
            m["client"] = data["lsize"]
            fixed.append(f"meta.client {before.get('client')} → {data['lsize']}")
        if m != before:
            json.dump(m, open(mp, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

    # ② 验收表：只改最新那一行的 client 格
    cells_ok = f"{data['lsize']:,} B"
    lines = doc_lines()
    changed = False
    for i, line in enumerate(lines):
        m2 = re.match(r"\|\s*" + re.escape(lv) + r"\s*\|", line)
        if not m2:
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) >= 5 and cells[4] != cells_ok:
            fixed.append(f"表内 client {cells[4]} → {cells_ok}")
            cells[4] = cells_ok
            lines[i] = "| " + " | ".join(cells) + " |"
            changed = True
    if changed:
        text = "\n".join(lines) + "\n"
        open(DOC, "w", encoding="utf-8").write(text)
        push_doc(text)
    return fixed


def main():
    as_json = "--json" in sys.argv
    do_fix = "--fix" in sys.argv

    save = None
    if "--save" in sys.argv:
        i = sys.argv.index("--save")
        if i + 1 < len(sys.argv):
            save = sys.argv[i + 1]

    data = collect()
    fixed = []
    if do_fix and any(not c["ok"] for c in data["checks"]):
        fixed = apply_fix(data)
        if fixed:
            print("[drift] 已自动修复 " + str(len(fixed)) + " 项：")
            for f in fixed:
                print("       ·", f)
            data = collect()

    checks = data["checks"]
    drift = [c for c in checks if not c["ok"]]

    if save:
        rec = {"version": save, "drift": len(drift), "total": len(checks), "ok": not drift,
               "failed": [c["name"] for c in drift], "head": (drift[0]["name"] if drift else ""),
               "fixed": fixed, "remote": data["rv"], "doc": data["lv"],
               "client": {"local": data["lsize"], "remote": data["rsize"], "sha16": data["lsha"]},
               "checks": checks, "at": time.strftime("%Y-%m-%d %H:%M:%S")}
        path = f"{DOWNLOAD}/verify-{save}.drift.json"
        json.dump(rec, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print(f"[drift] 已写 {path}")

    if as_json:
        print(json.dumps({"remote": data["rv"], "doc": data["lv"], "fixed": fixed,
                          "client": {"local": data["lsize"], "remote": data["rsize"], "sha16": data["lsha"]},
                          "checks": checks, "drift": len(drift)}, ensure_ascii=False, indent=2))
    else:
        print(f"远端版本 {data['rv']}｜验收表 {data['lv']}｜client 本地 {data['lsize']:,} B / 远端 {data['rsize']:,} B（sha256 {data['lsha']}）")
        print()
        for c in checks:
            print(f"{'✅' if c['ok'] else '❌'} {c['name']}：期望 {c['expect']}，实际 {c['actual']}"
                  + ("（可自愈）" if (not c["ok"] and c["fixable"]) else ""))
        print()
        print("结论：" + ("全部一致" if not drift else f"{len(drift)} 项漂移")
              + (f"｜本轮已修 {len(fixed)} 项" if fixed else ""))
    return 0 if not drift else 1


if __name__ == "__main__":
    sys.exit(main())