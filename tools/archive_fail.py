#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把一次不合格的取证现场归档到仓库 docs/agents/failures/。

用法：
    python3 tools/archive_fail.py 1.1.0-146
读取：
    /sdcard/Download/verify-<ver>-fail.json（优先）或 verify-<ver>.json
    /sdcard/Download/dsh-<ver>-fail.png（存在则一起归档）
产出：
    docs/agents/failures/verify-<ver>-<时间戳>.json
    docs/agents/failures/verify-<ver>-<时间戳>-ui.png（有截图时）
"""
import base64
import json
import os
import sys
import time
import urllib.request

try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass

REPO = "kai6666666/deepseek-harness"
API = f"https://api.github.com/repos/{REPO}"
DOWNLOAD = "/storage/emulated/0/Download"
TOKEN_FILE = "/tmp/gh_token"


def token():
    with open(TOKEN_FILE) as f:
        return f.read().strip()


def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(API + path, data=data, method=method)
    r.add_header("Authorization", f"Bearer {token()}")
    r.add_header("Accept", "application/vnd.github+json")
    r.add_header("User-Agent", "dsh-archive")
    if data is not None:
        r.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(r, timeout=120) as resp:
        raw = resp.read().decode()
        return json.loads(raw) if raw.strip() else None


def put(path, blob, message):
    try:
        sha = req("GET", f"/contents/{path}?ref=main").get("sha")
    except Exception:
        sha = None
    body = {"message": message, "content": base64.b64encode(blob).decode(), "branch": "main"}
    if sha:
        body["sha"] = sha
    req("PUT", f"/contents/{path}", body)
    return True


def main():
    if len(sys.argv) < 2:
        raise SystemExit("用法：python3 tools/archive_fail.py 1.1.0-146")
    v = sys.argv[1]
    ts = time.strftime("%Y%m%d-%H%M%S")

    jpath = f"{DOWNLOAD}/verify-{v}-fail.json"
    if not os.path.exists(jpath):
        jpath = f"{DOWNLOAD}/verify-{v}.json"
    if not os.path.exists(jpath):
        raise SystemExit(f"[archive] 找不到 {v} 的证据 json")

    doc = json.load(open(jpath, encoding="utf-8"))
    doc["_archived_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    doc["_source"] = os.path.basename(jpath)
    blob = json.dumps(doc, ensure_ascii=False, indent=2).encode()
    jname = f"docs/agents/failures/verify-{v}-{ts}.json"
    put(jname, blob, f"fail: 归档 {v} 不合格现场")
    print(f"[archive] {jname}")

    png = f"{DOWNLOAD}/dsh-{v}-fail.png"
    if os.path.exists(png):
        pname = f"docs/agents/failures/verify-{v}-{ts}-ui.png"
        put(pname, open(png, "rb").read(), f"fail: 归档 {v} 失败截图")
        print(f"[archive] {pname}")


if __name__ == "__main__":
    main()