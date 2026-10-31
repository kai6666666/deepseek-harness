#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把某次装机取证（/sdcard/Download/verify-<ver>.txt）追加进仓库的验收登记表。

用法：
    python3 tools/record.py 1.1.0-146
"""
import base64
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
DOC = f"{WORKSPACE}/docs/agents/mobile-ui-verification.md"
LOG_DIR = "/storage/emulated/0/Download"
EXPECTED = ["复制会话为 Markdown", "下载 Session 日志", "浏览更多插件", "创建你的插件", "反馈", "轨迹", "刷新"]
HEADER = """# 移动端 UI 插件 · 发布验收记录

每次发布按 `tools/push.sh <ver>` → `sh /sdcard/Download/install-<ver>.sh` → `python3 tools/record.py <ver>` 追加一行。

| 版本 | 设备戳 | 七行菜单 | 创造模式 | 文案一致 | 消息数 | 截图 | 记录时间 |
|---|---|---|---|---|---|---|---|
"""


def token():
    with open("/tmp/gh_token") as f:
        return f.read().strip()


def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(API + path, data=data, method=method)
    r.add_header("Authorization", f"Bearer {token()}")
    r.add_header("Accept", "application/vnd.github+json")
    r.add_header("User-Agent", "dsh-record")
    if data:
        r.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(r, timeout=120) as resp:
        raw = resp.read().decode()
        return json.loads(raw) if raw.strip() else None


def _load_ev(lines, key):
    """从 `evN: RESULT {...}` 这行里做两次 json 解码，取到浏览器里返回的对象。"""
    line = next((l for l in lines if l.startswith(key + ":")), None)
    if not line:
        return None
    payload = line.split("RESULT ", 1)[1] if "RESULT " in line else line.split(":", 1)[1]
    try:
        outer = json.loads(payload)
        value = outer["result"]["value"]
        return json.loads(value) if isinstance(value, str) else value
    except Exception:
        return None


def parse(version):
    txt = f"{LOG_DIR}/verify-{version}.txt"
    js = f"{LOG_DIR}/verify-{version}.json"
    if not os.path.exists(txt) and not os.path.exists(js):
        raise SystemExit(f"[record] 找不到 {txt} / {js}，先跑 install-{version}.sh")

    lines = []
    if os.path.exists(txt):
        lines = open(txt, encoding="utf-8", errors="replace").read().splitlines()

    src = "txt"
    if os.path.exists(js):
        try:
            obj = json.load(open(js, encoding="utf-8"))
            if isinstance(obj.get("items"), list) and "ok" in obj:
                src = "json"
        except Exception:
            obj = None
    else:
        obj = None

    if src == "json":
        items = obj.get("items") or []
        mode = obj.get("mode")
        match = bool(obj.get("match"))
        msgs = obj.get("msgs", -1)
    else:
        vline = next((l for l in lines if l.startswith("verify: ")), None)
        if vline:
            try:
                obj = json.loads(vline.split("verify: ", 1)[1])
            except Exception:
                obj = None
        if obj:
            items = obj.get("items") or []
            mode = obj.get("mode")
            match = bool(obj.get("match"))
            msgs = obj.get("msgs", -1)
        else:
            ev2 = _load_ev(lines, "ev2") or {}
            ev3 = _load_ev(lines, "ev3") or {}
            items = ev2.get("items") or []
            mode = ev3.get("mode")
            match = bool(ev3.get("match"))
            msgs = ev3.get("msgs", -1)

    stamp = next((l.split("=", 1)[1] for l in lines if l.startswith("stamp=")), "?")
    shot = next((l.split("=", 1)[1] for l in lines if l.startswith("shot=")),
                f"/sdcard/Download/dsh-{version}-ui.png")
    return {
        "src": src,
        "items": items,
        "items_ok": items == EXPECTED,
        "mode": mode,
        "match": match,
        "msgs": msgs,
        "stamp": stamp,
        "shot": shot,
    }


def row(version, d):
    ok = lambda b: "✅" if b else "❌"
    return (f"| {version} | {d['stamp']} | {ok(d['items_ok'])} ({len(d['items'])}) | {d['mode']} | "
            f"{ok(d['match'])} | {d['msgs']} | {os.path.basename(d['shot'])} | "
            f"{time.strftime('%Y-%m-%d %H:%M')} |\n")


def write_local(version, d):
    os.makedirs(os.path.dirname(DOC), exist_ok=True)
    text = open(DOC, encoding="utf-8").read() if os.path.exists(DOC) else HEADER
    line = row(version, d)
    if f"| {version} |" in text:
        text = "\n".join(l for l in text.splitlines() if not l.startswith(f"| {version} |")) + "\n"
        if not text.endswith("\n"):
            text += "\n"
    text += line
    open(DOC, "w", encoding="utf-8").write(text)
    print(f"[record] 本地已写入 {DOC}")
    return text


def push_doc(text):
    try:
        cur = req("GET", "/contents/docs/agents/mobile-ui-verification.md?ref=main")
        sha = cur.get("sha")
    except Exception:
        sha = None
    body = {
        "message": "docs: 追加移动端 UI 验收记录",
        "content": base64.b64encode(text.encode()).decode(),
        "branch": "main",
    }
    if sha:
        body["sha"] = sha
    req("PUT", "/contents/docs/agents/mobile-ui-verification.md", body)
    print("[record] 已推送 docs/agents/mobile-ui-verification.md")


def main():
    if len(sys.argv) < 2:
        raise SystemExit("用法：python3 tools/record.py 1.1.0-146")
    version = sys.argv[1]
    d = parse(version)
    rpath = f"{LOG_DIR}/verify-{version}.record.json"
    with open(rpath, "w") as f:
        json.dump({"version": version, **d}, f, ensure_ascii=False, indent=2)
    print(f"[record] 解析结果（来源 {d['src']}）{rpath}")
    print("[record]", json.dumps(d, ensure_ascii=False))
    text = write_local(version, d)
    push_doc(text)
    print(row(version, d).strip())


if __name__ == "__main__":
    main()