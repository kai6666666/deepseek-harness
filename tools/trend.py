#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从验收表生成趋势报表（docs/agents/trend.md）。

用法：
    python3 tools/trend.py            # 打印 + 写本地 docs/agents/trend.md
    python3 tools/trend.py --push     # 另推送远端

数据源只有一处：docs/agents/mobile-ui-verification.md（17 列）。
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
ROOT = "/storage/emulated/0/MT2/apks/deepseek harness/DSHAPP-main"
DOC = f"{ROOT}/docs/agents/mobile-ui-verification.md"
OUT = f"{ROOT}/docs/agents/trend.md"
REMOTE = "docs/agents/trend.md"
TOKEN = "/tmp/gh_token"


def token():
    with open(TOKEN) as f:
        return f.read().strip()


def api(method, path, body=None):
    data = json.dumps(body).encode() if body else None
    r = urllib.request.Request(API + path, data=data, method=method)
    r.add_header("Authorization", f"Bearer {token()}")
    r.add_header("User-Agent", "dsh-trend")
    if data:
        r.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(r, timeout=90) as x:
        raw = x.read().decode()
        return json.loads(raw) if raw.strip() else None


def rows():
    out = []
    for line in open(DOC, encoding="utf-8"):
        m = re.match(r"\|\s*(\d+\.\d+\.\d+-\d+)\s*\|", line)
        if not m:
            continue
        c = [x.strip() for x in line.strip().strip("|").split("|")]
        if len(c) < 17:
            continue
        apk = re.search(r"([\d.]+)\s*MB", c[3])
        ms = re.search(r"([\d.]+)s", c[12])
        out.append({
            "ver": c[0],
            "apk": float(apk.group(1)) if apk else None,
            "client": c[4],
            "ms": float(ms.group(1)) if ms else None,
            "round": c[10],
            "retry": c[11],
            "drift": c[15],
            "state": c[16],
        })
    return out


def vkey(v):
    m = re.match(r"(\d+)\.(\d+)\.(\d+)-(\d+)", v)
    return tuple(int(x) for x in m.groups()) if m else (0, 0, 0, 0)


def fmt_delta(d, unit=""):
    if d is None:
        return "—"
    sign = "+" if d > 0 else ""
    return f"{sign}{d:.1f}{unit}"


def build(rs):
    rs = sorted(rs, key=lambda r: vkey(r["ver"]))
    lines = []
    prev = None
    for r in rs:
        dapk = None if (prev is None or r["apk"] is None or prev["apk"] is None) else round(r["apk"] - prev["apk"], 1)
        dms = None if (prev is None or r["ms"] is None or prev["ms"] is None) else round(r["ms"] - prev["ms"], 1)
        r["dapk"], r["dms"] = dapk, dms
        prev = r

    n = len(rs)
    apks = [r["apk"] for r in rs if r["apk"]]
    mss = [r["ms"] for r in rs if r["ms"]]
    latest = rs[-1] if rs else None
    green = sum(1 for r in rs if r["state"] == "✅")

    lines.append("# 移动端 UI 插件 · 发布趋势\n")
    lines.append("由 `tools/trend.py` 从 [`mobile-ui-verification.md`](mobile-ui-verification.md) 自动生成，勿手改。\n")
    if latest:
        lines.append(f"最新版本 **{latest['ver']}**｜共 {n} 次记录｜✅ {green} 次｜"
                     f"APK 均值 {sum(apks) / len(apks):.1f} MB｜取证均值 {sum(mss) / len(mss):.1f} s\n" if apks and mss
                     else f"最新版本 **{latest['ver']}**｜共 {n} 次记录\n")
    lines.append("| 版本 | APK (MB) | ΔAPK | 取证 (s) | Δ取证 | 轮次 | 重试 | 漂移 | 状态 |")
    lines.append("|---|---|---|---|---|---|---|---|---|")
    for r in sorted(rs, key=lambda x: vkey(x["ver"]), reverse=True):
        apk = "—" if r["apk"] is None else f"{r['apk']:.1f}"
        ms = "—" if r["ms"] is None else f"{r['ms']:.1f}"
        lines.append(f"| {r['ver']} | {apk} | {fmt_delta(r['dapk'])} | {ms} | "
                     f"{fmt_delta(r['dms'], 's')} | {r['round']} | {r['retry']} | {r['drift']} | {r['state']} |")
    lines.append("")
    lines.append("## 判读\n")
    lines.append("- **ΔAPK**：相对上一个版本的体积变化，突增通常意味着资源或依赖被带进来。")
    lines.append("- **Δ取证**：相对上一个版本的取证耗时变化，连续变慢先怀疑设备负载或 CDP 超时。")
    lines.append("- **轮次 / 重试**：`1 / r0` 表示首轮一次通过；出现 `2` 或 `×2` 说明重试救过一次。")
    lines.append("- **漂移 / 状态**：`0/9 · ✅` 干净；`·fixK` 自愈、`·chgN` 发布期变更、`·waitN` 等待期扰动，`⚠` 表示过程被操作过。")
    lines.append("")
    return "\n".join(lines) + "\n", rs


def push(text):
    try:
        sha = api("GET", f"/contents/{REMOTE}?ref=main").get("sha")
    except Exception:
        sha = None
    body = {"message": "docs: 刷新发布趋势", "content": base64.b64encode(text.encode()).decode(), "branch": "main"}
    if sha:
        body["sha"] = sha
    api("PUT", f"/contents/{REMOTE}", body)
    print(f"[trend] 已推送 {REMOTE}")


def main():
    rs = rows()
    if not rs:
        raise SystemExit("[trend] 验收表里没有可解析的行")
    text, rs = build(rs)
    open(OUT, "w", encoding="utf-8").write(text)
    print(f"[trend] 本地已写 {OUT}（{len(rs)} 版）")
    print(text)
    if "--push" in sys.argv:
        push(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())