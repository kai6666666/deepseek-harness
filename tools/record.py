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

每次发布按 `bash tools/ship.sh <ver> --wait` → 设备侧 `sh /sdcard/Download/install-<ver>.sh` → 自动登记一行。

| 版本 | 设备戳 | CI run | APK | client | dex 戳 | 七行菜单 | 创造模式 | 文案一致 | 消息数 | 轮次 | 重试 | 耗时 | 截图 | 记录时间 | 漂移 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
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

    meta = {}
    mpath = f"{LOG_DIR}/verify-{version}.meta.json"
    if os.path.exists(mpath):
        try:
            meta = json.load(open(mpath, encoding="utf-8"))
        except Exception:
            meta = {}

    # 重试次数与耗时：优先取 CDP 结果里的 retries/ms，其次取 summary 行
    _retries = None
    _ms = None
    if isinstance(obj, dict):
        rr = obj.get("retries") or {}
        if rr:
            try:
                _retries = sum(int(x or 0) for x in rr.values())
            except Exception:
                _retries = None
        if obj.get("ms") is not None:
            try:
                _ms = int(obj["ms"])
            except Exception:
                _ms = None
    if _retries is None or _ms is None:
        sl = next((l for l in lines if l.startswith("summary: ") or l.startswith("stages=")), "")
        m = re.search(r"retries=(\d+)", sl)
        if _retries is None and m:
            _retries = int(m.group(1))
        m = re.search(r"\bms=(\d+)", sl)
        if _ms is None and m:
            _ms = int(m.group(1))

    # 第几轮取证才通过：0=首轮，1=重试轮
    _attempt = 0
    _attempt_src = None
    if isinstance(obj, dict) and obj.get("attempt") is not None:
        try:
            _attempt = int(obj["attempt"])
            _attempt_src = _attempt
        except Exception:
            _attempt = 0
    if _attempt_src is None:
        rounds = re.findall(r"verify\[(\d+)\]", "\n".join(lines))
        if rounds:
            _attempt = int(rounds[-1])
            _attempt_src = _attempt

    return {
        "src": src,
        "items": items,
        "items_ok": items == EXPECTED,
        "mode": mode,
        "match": match,
        "msgs": msgs,
        "stamp": stamp,
        "shot": shot,
        "run": str(meta.get("run_id") or "—"),
        "apk": (f"{meta['apk_mb']} MB" if meta.get("apk_mb") else "—"),
        "client": (f"{meta['client']:,} B" if meta.get("client") else "—"),
        "dex": (f"{meta['dex_hit']}/2" if meta.get("dex_hit") is not None else "—"),
        "round": ("—" if _attempt_src is None else str(_attempt_src + 1)),
        "retries": ("—" if _retries is None else f"r{_retries}" + (f" ×{_attempt + 1}" if _attempt > 0 else "")),
        "ms": ("—" if not _ms else f"{_ms / 1000:.1f}s"),
        "drift": _drift_cell(version),
    }


def _drift_cell(version):
    """读 verify-<ver>.drift.json：全绿显示 `0/9`，漂移显示 `🚩N`。"""
    p = f"{LOG_DIR}/verify-{version}.drift.json"
    if not os.path.exists(p):
        return "—"
    try:
        d = json.load(open(p, encoding="utf-8"))
    except Exception:
        return "—"
    n = int(d.get("drift", 0))
    return f"🚩{n}" if n else f"0/{d.get('total', 9)}"


def row(version, d):
    ok = lambda b: "✅" if b else "❌"
    return (f"| {version} | {d['stamp']} | {d['run']} | {d['apk']} | {d['client']} | {d['dex']} | "
            f"{ok(d['items_ok'])} ({len(d['items'])}) | {d['mode']} | "
            f"{ok(d['match'])} | {d['msgs']} | {d['round']} | {d['retries']} | {d['ms']} | "
            f"{os.path.basename(d['shot'])} | {time.strftime('%Y-%m-%d %H:%M')} | {d.get('drift', '—')} |\n")


def _migrate_cells(line):
    """老表列数补齐到 15 列：先补 run/apk/client/dex，再在截图前插 轮次/重试/耗时。"""
    cells = [c.strip() for c in line.strip().strip("|").split("|")]
    n = len(cells)
    if n == 8:
        cells = cells[:2] + ["—"] * 4 + cells[2:]
    elif n == 10:
        cells = cells[:4] + ["—", "—"] + cells[4:]
    if len(cells) == 12:
        cells = cells[:10] + ["—", "—", "—"] + cells[10:]
    elif len(cells) == 14:
        cells = cells[:10] + ["—"] + cells[10:]
    if len(cells) == 15:
        cells = cells + ["—"]
    if len(cells) != 16:
        return None
    return "| " + " | ".join(cells) + " |"


def write_local(version, d):
    os.makedirs(os.path.dirname(DOC), exist_ok=True)
    rows = []
    if os.path.exists(DOC):
        for line in open(DOC, encoding="utf-8").read().splitlines():
            if not line.startswith("| "):
                continue
            if "---" in line or line.startswith("| 版本"):
                continue
            fixed = _migrate_cells(line)
            if fixed:
                rows.append(fixed)
    rows = [r for r in rows if not r.startswith(f"| {version} |")]
    rows.append(row(version, d).strip())

    def _vkey(line):
        m = re.match(r"\|\s*(\d+)\.(\d+)\.(\d+)-(\d+)\s*\|", line)
        return tuple(int(x) for x in m.groups()) if m else (-1, -1, -1, -1)

    rows.sort(key=_vkey, reverse=True)
    text = HEADER + "\n".join(rows) + "\n"
    open(DOC, "w", encoding="utf-8").write(text)
    print(f"[record] 本地已写入 {DOC}（{len(rows) + 1} 行）")
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