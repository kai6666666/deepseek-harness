#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把一次不合格的取证现场归档到 docs/agents/failures/，并追加一行归档索引。

用法：
    python3 tools/archive_fail.py 1.1.0-146
    python3 tools/archive_fail.py --drift 1.1.0-146   # 环境漂移（drift_check 不合格）
    python3 tools/archive_fail.py --log 1.1.0-146 --file /tmp/ship-watch-1.1.0-146.log --count 2
    python3 tools/archive_fail.py --change 1.1.0-146     # 发布期间实际值变化（diff.json）
    python3 tools/archive_fail.py --perturb 1.1.0-146    # 发布过程扰动汇总（wait/chg/fix）
读取：
    /sdcard/Download/verify-<ver>-fail.json（优先）或 verify-<ver>.json
    /sdcard/Download/dsh-<ver>-fail.png（存在则一起归档）
产出：
    docs/agents/failures/verify-<ver>-<时间戳>.json
    docs/agents/failures/verify-<ver>-<时间戳>-ui.png（有截图时）
    docs/agents/failures/README.md（追加一行索引）
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
DOWNLOAD = "/storage/emulated/0/Download"
TOKEN_FILE = "/tmp/gh_token"
DIR = "docs/agents/failures"
README_PATH = f"{DIR}/README.md"

TEMPLATE = """# 失败现场归档

`tools/archive_fail.py <版本>` 在两轮取证都不合格后归档现场：证据 JSON（`stages` / `retries` / `attempt` / `ms`）与失败瞬间整屏截图。
合格记录进 `../mobile-ui-verification.md`，本目录只收失败。

## 归档索引

| 时间 | 版本 | 轮次 | 失败原因 | 证据 |
|---|---|---|---|---|
"""


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


def reasons(doc):
    out = []
    if not doc.get("clicked"):
        out.append("未点到「创建你的插件」")
    if not doc.get("match"):
        out.append("输入框文案不一致")
    if doc.get("msgs") != 0:
        out.append(f"消息数={doc.get('msgs')}")
    n = len(doc.get("items") or [])
    if n != 7:
        out.append(f"菜单行数={n}")
    stages = doc.get("stages") or {}
    bad = [k for k, v in stages.items() if not str(v).startswith("ok")]
    if bad:
        out.append("阶段失败:" + ",".join(bad))
    return "；".join(out) or "未分类"


def drift_reasons(doc):
    n = int(doc.get("drift", 0))
    failed = doc.get("failed") or []
    fixed = doc.get("fixed") or []
    s = f"环境漂移:{n}项"
    if failed:
        s += "（" + "；".join(failed[:2]) + "）"
    if fixed:
        s += f"；自愈{len(fixed)}项（" + "；".join(fixed[:2]) + "）"
    return s


def update_readme_drift(version, jname, doc):
    try:
        cur = req("GET", f"/contents/{README_PATH}?ref=main")
        text = base64.b64decode(cur["content"]).decode()
    except Exception:
        text = TEMPLATE
    rows = [l for l in text.splitlines()
            if l.startswith("| ") and not l.startswith("| 时间") and "---" not in l]
    nice = time.strftime("%Y-%m-%d %H:%M", time.localtime())
    rows = [r for r in rows if f"| {version} |" not in r]
    rows.append(f"| {nice} | {version} | — | {drift_reasons(doc)} | [json]({os.path.basename(jname)}) |")
    rows.sort(key=lambda r: r.split("|")[1].strip(), reverse=True)
    put(README_PATH, (TEMPLATE + "\n".join(rows) + "\n").encode(),
        f"drift: 归档 {version} 环境漂移并登记索引")
    print(f"[archive] {README_PATH}（{len(rows)} 行，漂移）")


def update_readme(version, ts, doc, jname, pname=None):
    try:
        cur = req("GET", f"/contents/{README_PATH}?ref=main")
        text = base64.b64decode(cur["content"]).decode()
    except Exception:
        text = TEMPLATE
    rows = [l for l in text.splitlines()
            if l.startswith("| ") and not l.startswith("| 时间") and "---" not in l]
    evidence = f"[json]({os.path.basename(jname)})"
    if pname:
        evidence += f" · [png]({os.path.basename(pname)})"
    nice = time.strftime("%Y-%m-%d %H:%M", time.localtime())
    rows = [r for r in rows if f"| {version} |" not in r]
    rows.append(f"| {nice} | {version} | {(doc.get('attempt') or 0) + 1} | {reasons(doc)} | {evidence} |")
    rows.sort(key=lambda r: r.split("|")[1].strip(), reverse=True)
    put(README_PATH, (TEMPLATE + "\n".join(rows) + "\n").encode(),
        f"fail: 归档 {version} 并登记索引")
    print(f"[archive] {README_PATH}（{len(rows)} 行）")


def update_readme_perturb(version, jname, doc):
    try:
        cur = req("GET", f"/contents/{README_PATH}?ref=main")
        text = base64.b64decode(cur["content"]).decode()
    except Exception:
        text = TEMPLATE
    rows = [l for l in text.splitlines()
            if l.startswith("| ") and not l.startswith("| 时间") and "---" not in l]
    nice = time.strftime("%Y-%m-%d %H:%M", time.localtime())
    rows = [r for r in rows if f"| {version} |" not in r]
    wt = int(doc.get("wait", 0) or 0)
    ch = doc.get("changed") or []
    fx = doc.get("fixed") or []
    reason = f"发布过程扰动：wait{wt} chg{len(ch)} fix{len(fx)}"
    if ch:
        reason += f"（{ch[0]['name']}：{ch[0]['from']}→{ch[0]['to']}）"
    rows.append(f"| {nice} | {version} | — | {reason} | [json]({os.path.basename(jname)}) |")
    rows.sort(key=lambda r: r.split("|")[1].strip(), reverse=True)
    put(README_PATH, (TEMPLATE + "\n".join(rows) + "\n").encode(),
        f"perturb: 归档 {version} 发布过程扰动")
    print(f"[archive] {README_PATH}（{len(rows)} 行，扰动汇总）")


def update_readme_change(version, jname, doc):
    try:
        cur = req("GET", f"/contents/{README_PATH}?ref=main")
        text = base64.b64decode(cur["content"]).decode()
    except Exception:
        text = TEMPLATE
    rows = [l for l in text.splitlines()
            if l.startswith("| ") and not l.startswith("| 时间") and "---" not in l]
    nice = time.strftime("%Y-%m-%d %H:%M", time.localtime())
    rows = [r for r in rows if f"| {version} |" not in r]
    ch = doc.get("changed") or []
    head = f"（{ch[0]['name']}：{ch[0]['from']}→{ch[0]['to']}）" if ch else ""
    rows.append(f"| {nice} | {version} | — | 发布期间实际值变化{len(ch)}项{head} | [json]({os.path.basename(jname)}) |")
    rows.sort(key=lambda r: r.split("|")[1].strip(), reverse=True)
    put(README_PATH, (TEMPLATE + "\n".join(rows) + "\n").encode(),
        f"change: 归档 {version} 发布期间变更清单")
    print(f"[archive] {README_PATH}（{len(rows)} 行，变更清单）")


def update_readme_log(version, lname, count):
    try:
        cur = req("GET", f"/contents/{README_PATH}?ref=main")
        text = base64.b64decode(cur["content"]).decode()
    except Exception:
        text = TEMPLATE
    rows = [l for l in text.splitlines()
            if l.startswith("| ") and not l.startswith("| 时间") and "---" not in l]
    nice = time.strftime("%Y-%m-%d %H:%M", time.localtime())
    rows = [r for r in rows if f"| {version} |" not in r]
    rows.append(f"| {nice} | {version} | — | 等待期状态变化{count}次（环境巡检日志） | [log]({os.path.basename(lname)}) |")
    rows.sort(key=lambda r: r.split("|")[1].strip(), reverse=True)
    put(README_PATH, (TEMPLATE + "\n".join(rows) + "\n").encode(),
        f"watch: 归档 {version} 等待期巡检日志")
    print(f"[archive] {README_PATH}（{len(rows)} 行，等待期日志）")


def main():
    if len(sys.argv) < 2:
        raise SystemExit("用法：python3 tools/archive_fail.py 1.1.0-146 | --drift 1.1.0-146")

    if sys.argv[1] == "--perturb":
        if len(sys.argv) < 3:
            raise SystemExit("用法：python3 tools/archive_fail.py --perturb 1.1.0-146")
        v = sys.argv[2]
        src = f"{DOWNLOAD}/verify-{v}.drift.json"
        if "--file" in sys.argv:
            j = sys.argv.index("--file")
            if j + 1 < len(sys.argv):
                src = sys.argv[j + 1]
        if not os.path.exists(src):
            raise SystemExit(f"[archive] 找不到漂移报告 {src}")
        doc = json.load(open(src, encoding="utf-8"))
        doc["_archived_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        ts = time.strftime("%Y%m%d-%H%M%S")
        jname = f"{DIR}/perturb-{v}-{ts}.json"
        put(jname, json.dumps(doc, ensure_ascii=False, indent=2).encode(),
            f"perturb: 归档 {v} 发布过程扰动")
        print(f"[archive] {jname}")
        update_readme_perturb(v, jname, doc)
        return

    if sys.argv[1] == "--change":
        if len(sys.argv) < 3:
            raise SystemExit("用法：python3 tools/archive_fail.py --change 1.1.0-146")
        v = sys.argv[2]
        src = f"{DOWNLOAD}/verify-{v}.diff.json"
        if "--file" in sys.argv:
            j = sys.argv.index("--file")
            if j + 1 < len(sys.argv):
                src = sys.argv[j + 1]
        if not os.path.exists(src):
            raise SystemExit(f"[archive] 找不到变更清单 {src}")
        doc = json.load(open(src, encoding="utf-8"))
        ts = time.strftime("%Y%m%d-%H%M%S")
        jname = f"{DIR}/change-{v}-{ts}.json"
        put(jname, json.dumps(doc, ensure_ascii=False, indent=2).encode(),
            f"change: 归档 {v} 发布期间变更清单")
        print(f"[archive] {jname}")
        update_readme_change(v, jname, doc)
        return

    if sys.argv[1] == "--log":
        if len(sys.argv) < 3:
            raise SystemExit("用法：python3 tools/archive_fail.py --log 1.1.0-146 --file /tmp/ship-watch-1.1.0-146.log --count 2")
        v = sys.argv[2]
        src = ""
        cnt = 0
        if "--file" in sys.argv:
            j = sys.argv.index("--file")
            if j + 1 < len(sys.argv):
                src = sys.argv[j + 1]
        if "--count" in sys.argv:
            j = sys.argv.index("--count")
            if j + 1 < len(sys.argv):
                cnt = int(sys.argv[j + 1] or 0)
        if not src or not os.path.exists(src):
            raise SystemExit(f"[archive] 找不到巡检日志 {src}")
        ts = time.strftime("%Y%m%d-%H%M%S")
        lname = f"{DIR}/watch-{v}-{ts}.log"
        put(lname, open(src, "rb").read(), f"watch: 归档 {v} 等待期巡检日志")
        print(f"[archive] {lname}")
        update_readme_log(v, lname, cnt)
        return

    if sys.argv[1] == "--drift":
        if len(sys.argv) < 3:
            raise SystemExit("用法：python3 tools/archive_fail.py --drift 1.1.0-146")
        v = sys.argv[2]
        ts = time.strftime("%Y%m%d-%H%M%S")
        src = f"{DOWNLOAD}/verify-{v}.drift.json"
        if "--file" in sys.argv:
            j = sys.argv.index("--file")
            if j + 1 < len(sys.argv):
                src = sys.argv[j + 1]
        if not os.path.exists(src):
            raise SystemExit(f"[archive] 找不到漂移报告 {src}")
        doc = json.load(open(src, encoding="utf-8"))
        doc["_archived_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        jname = f"{DIR}/drift-{v}-{ts}.json"
        put(jname, json.dumps(doc, ensure_ascii=False, indent=2).encode(),
            f"drift: 归档 {v} 环境漂移")
        print(f"[archive] {jname}")
        update_readme_drift(v, jname, doc)
        return

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
    jname = f"{DIR}/verify-{v}-{ts}.json"
    put(jname, blob, f"fail: 归档 {v} 不合格现场")
    print(f"[archive] {jname}")

    pname = None
    png = f"{DOWNLOAD}/dsh-{v}-fail.png"
    if os.path.exists(png):
        pname = f"{DIR}/verify-{v}-{ts}-ui.png"
        put(pname, open(png, "rb").read(), f"fail: 归档 {v} 失败截图")
        print(f"[archive] {pname}")

    update_readme(v, ts, doc, jname, pname)


if __name__ == "__main__":
    main()