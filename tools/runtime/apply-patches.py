#!/usr/bin/env python3
"""构建期补丁应用器：三态 + 双哈希 pin。

状态机（每个补丁）：
    cur == after   → already-applied（幂等）
    cur == before  → apply（patch -p1），再校验 == after
    其它           → mismatch，退出码 1（构建必须失败）

用法：
    tools/runtime/apply-patches.py --prefix <rootfs>/opt/dsh \
        --dsh-version 0.2.2-rc.1 --patches runtime/patches [--check]
"""
import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prefix", required=True)
    ap.add_argument("--dsh-version", required=True)
    ap.add_argument("--patches", default="runtime/patches")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    root = Path(args.prefix)
    pdir = Path(args.patches)
    pins = json.loads((pdir / "pins.json").read_text(encoding="utf-8"))["patches"]

    bad = 0
    for diff_name, by_ver in sorted(pins.items()):
        if args.dsh_version not in by_ver:
            print(f"[SKIP] {diff_name}: 没有 {args.dsh_version} 的 pin")
            continue
        for rel, pin in by_ver[args.dsh_version].items():
            f = root / rel
            if not f.is_file():
                print(f"[FAIL] {diff_name}: 缺 {rel}")
                bad += 1
                continue
            cur = sha(f)
            if cur == pin["after"]:
                print(f"[OK]   {diff_name}: 已应用")
                continue
            if cur != pin["before"]:
                print(f"[FAIL] {diff_name}: {rel}\n       现 {cur}\n       期 {pin['before']}")
                bad += 1
                continue
            if args.check:
                print(f"[WANT] {diff_name}: 可应用")
                continue
            r = subprocess.run(
                ["patch", "-p1", "--no-backup-if-mismatch", "-i", str((pdir / diff_name).resolve())],
                cwd=root,
                capture_output=True,
                text=True,
            )
            if r.returncode != 0:
                print(f"[FAIL] {diff_name}: patch 失败\n{r.stdout}{r.stderr}")
                bad += 1
                continue
            got = sha(f)
            if got != pin["after"]:
                print(f"[FAIL] {diff_name}: 应用后哈希不符\n       {got}")
                bad += 1
            else:
                print(f"[OK]   {diff_name}: 已应用（本次）")

    if bad:
        print(f"\n{bad} 个补丁问题 —— 构建必须失败")
        return 1
    print("\n全部补丁就绪")
    return 0


if __name__ == "__main__":
    sys.exit(main())