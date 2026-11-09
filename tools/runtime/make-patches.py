#!/usr/bin/env python3
"""从 EngineManager.kt 的常量生成构建期补丁（.diff + pins.json）。

只处理「纯字符串替换」类补丁：guard 文本 → anchor 文本。
用法：
    tools/runtime/make-patches.py --engine <rootfs>/opt/dsh --version 0.2.2-rc.1
"""
import argparse
import difflib
import hashlib
import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
EM = REPO / "app/src/main/java/com/dsh/android/EngineManager.kt"
OUT = REPO / "runtime/patches"

CONST_RE = re.compile(
    r'private\s+const\s+val\s+(\w+)\s*=\s*((?:\s*"(?:[^"\\]|\\.)*"\s*\+?)+)',
    re.S,
)
LIT_RE = re.compile(r'"((?:[^"\\]|\\.)*)"')

ESCAPES = {"t": "\t", "n": "\n", "r": "\r", '"': '"', "\\": "\\", "$": "$", "'": "'"}


def unescape(s: str) -> str:
    out, i = [], 0
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s):
            out.append(ESCAPES.get(s[i + 1], s[i + 1]))
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def load_constants() -> dict:
    text = EM.read_text(encoding="utf-8")
    consts = {}
    for m in CONST_RE.finditer(text):
        name = m.group(1)
        parts = [unescape(x) for x in LIT_RE.findall(m.group(2))]
        consts[name] = "".join(parts)
    return consts


PATCHES = [
    {
        "name": "deepseek-tool-order",
        "rel": "node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js",
        "pairs": [
            ("TOOL_ORDER_GUARD_HEAD", "TOOL_ORDER_ANCHOR_HEAD"),
            ("TOOL_ORDER_GUARD_TAIL", "TOOL_ORDER_ANCHOR_TAIL"),
        ],
    },
    {
        "name": "pi-ai-tool-call-id",
        "rel": "node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js",
        "pairs": [
            ("PI_AI_TOOLID_GUARD_START", "PI_AI_TOOLID_ANCHOR_START"),
            ("PI_AI_TOOLID_GUARD_END", "PI_AI_TOOLID_ANCHOR_END"),
        ],
    },
    {
        "name": "llm-tool-call-id-fallback",
        "rel": "node_modules/@deepseek-ai/dsh-llm/lib/index.js",
        "pairs": [("LLM_TOOLID_GUARD", "LLM_TOOLID_ANCHOR")],
    },
    {
        "name": "attachment-durability",
        "rel": "node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js",
        "pairs": [("ATTACH_SYNC_GUARD", "ATTACH_SYNC_ANCHOR")],
    },
    {
        "name": "fail-loud-exit",
        "rel": "node_modules/@deepseek-ai/dsh-app-boot/lib/index.js",
        "pairs": [("FAIL_LOUD_EXIT_GUARD", "FAIL_LOUD_ANDROID_ANCHOR")],
        "all": True,
    },
    {
        "name": "image-media-type",
        "rel": "node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js",
        "pairs": [("IMG_TYPE_GUARD", "IMG_TYPE_ANCHOR")],
    },
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True, help="引擎根目录（含 node_modules）")
    ap.add_argument("--version", required=True)
    ap.add_argument("--check", action="store_true", help="只校验，不写文件")
    args = ap.parse_args()

    consts = load_constants()
    engine = Path(args.engine)
    OUT.mkdir(parents=True, exist_ok=True)
    pins_path = OUT / "pins.json"
    pins = json.loads(pins_path.read_text()) if pins_path.is_file() else {"patches": {}}
    pins.setdefault("patches", {})

    failures = 0
    for spec in PATCHES:
        f = engine / spec["rel"]
        if not f.is_file():
            print(f"[SKIP] {spec['name']}: 缺 {spec['rel']}")
            continue
        before = f.read_text(encoding="utf-8")
        after = before
        ok = True
        for g, a in spec["pairs"]:
            guard, anchor = consts[g], consts[a]
            if after.count(anchor) > 0:
                continue
            n = after.count(guard)
            want_all = spec.get("all", False)
            if n < 1 or (not want_all and n != 1):
                print(f"[FAIL] {spec['name']}: guard {g} 命中 {n} 次")
                failures += 1
                ok = False
                break
            after = after.replace(guard, anchor) if want_all else after.replace(guard, anchor, 1)
        if not ok:
            continue
        if after == before:
            print(f"[OK]   {spec['name']}: 已是目标状态")
            continue
        diff = "".join(
            difflib.unified_diff(
                before.splitlines(keepends=True),
                after.splitlines(keepends=True),
                fromfile="a/" + spec["rel"],
                tofile="b/" + spec["rel"],
                n=3,
            )
        )
        if args.check:
            print(f"[WANT] {spec['name']}: 可应用")
            continue
        (OUT / f"{spec['name']}.diff").write_text(diff, encoding="utf-8")
        pins["patches"][f"{spec['name']}.diff"] = {
            args.version: {
                spec["rel"]: {
                    "before": hashlib.sha256(before.encode()).hexdigest(),
                    "after": hashlib.sha256(after.encode()).hexdigest(),
                }
            }
        }
        print(f"[GEN]  {spec['name']}.diff  {len(diff)} B")

    if failures:
        return 1
    if not args.check:
        pins_path.write_text(json.dumps(pins, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"pins: {pins_path} ({len(pins['patches'])} patches)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())