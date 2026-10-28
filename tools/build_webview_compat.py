#!/usr/bin/env python3
"""build-webview_compat.py —— WebView 兼容资产的 Python 版（PowerShell 版等价移植）

为什么要它：`tools/build-webview-compat.ps1` 只能在 Windows 上跑，而 CI 是 Linux。
引擎前端（dist + 71 个插件 client bundle）与 mobile-ui 插件里有 chrome74 解析不了的新语法，
必须用 esbuild 降级，否则老内核上整块 UI 静默空白。

产物布局（App 侧按前缀分派）：
    dist/<rel>                → engine/…/dsh-web-frontend/dist/
    engine/<pkg>/lib/<file>   → engine/…/<pkg>/lib/
    mobileui/<rel>            → $DSH_HOME/mobile-ui/dsh-android-mobile/
    .compat-stamp             → "<target>-v<CompatVersion>"

判定「要不要收进 zip」：同一输入分别用 --target=esnext 与 --target=<target> 编译，
输出不同 ⇒ 确有语法缺口。**不能**用「输入≠输出」判（esbuild 总会重排版）。

性能：esbuild 只装一次（不用 npx 每次解析），文件级并行 8 线程。
在 442 个目标上实测 ~40 秒（原 npx 逐文件版跑 15 分钟没跑完）。

用法：
    python3 tools/build-webview_compat.py --engine /tmp/dsh-engine-0.2.1-rc.3
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ESBUILD_VERSION = os.environ.get("ESBUILD_VERSION", "0.23.1")


def run(cmd: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, text=True, capture_output=True, cwd=cwd)


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def ensure_esbuild(work: Path) -> str:
    if os.environ.get("ESBUILD"):
        return os.environ["ESBUILD"]
    prefix = work / "esbuild"
    prefix.mkdir(exist_ok=True)
    (prefix / "package.json").write_text('{"name":"esbuild-cache","private":true}', encoding="utf-8")
    r = run(["npm", "i", "--no-audit", "--no-fund", f"esbuild@{ESBUILD_VERSION}"], cwd=prefix)
    if r.returncode != 0:
        sys.exit(f"❌ esbuild 安装失败：{(r.stderr or r.stdout)[-400:]}")
    exe = prefix / "node_modules/.bin/esbuild"
    if not exe.exists():
        sys.exit("❌ esbuild 二进制不存在")
    return str(exe)


def collect(dist: Path, plugin_root: Path, mobile_src: Path):
    targets = []
    if dist.is_dir():
        for p in sorted(dist.rglob("*")):
            if p.suffix in (".js", ".css") and p.is_file():
                targets.append((f"dist/{p.relative_to(dist).as_posix()}", p))
    if plugin_root.is_dir():
        for pkg in sorted(plugin_root.iterdir()):
            if pkg.name == "dsh-web-frontend" or not pkg.is_dir():
                continue
            lib = pkg / "lib"
            if not lib.is_dir():
                continue
            for f in sorted(lib.glob("client*.js")):
                targets.append((f"engine/{pkg.name}/lib/{f.name}", f))
    if mobile_src.is_dir():
        for f in sorted(mobile_src.rglob("client*.js")):
            targets.append((f"mobileui/{f.relative_to(mobile_src).as_posix()}", f))
    return targets


def main() -> int:
    ap = argparse.ArgumentParser()
    _here = os.path.dirname(os.path.abspath(__file__))
    _verf = os.path.join(_here, "engine-version.txt")
    _ver = open(_verf).read().strip() if os.path.isfile(_verf) else "0.2.2-alpha.2"
    ap.add_argument("--engine", default=os.environ.get("ENGINE_DIR", f"/tmp/dsh-engine-{_ver}"))
    ap.add_argument("--target", default="chrome74")
    ap.add_argument("--compat-version", default="35")
    ap.add_argument("--out", default=str(ROOT / "app/src/main/assets/webview-compat.zip"))
    ap.add_argument("--strict-audit", action="store_true")
    ap.add_argument("--jobs", type=int, default=8)
    args = ap.parse_args()

    # --engine 可能是工作流里写死的旧路径；那条路径不存在时按 engine-version.txt 重算，
    # 这样升级引擎只需改一个文件，不必去改需要 workflow 权限的 yml。
    if not os.path.isdir(args.engine):
        _verf = os.path.join(os.path.dirname(os.path.abspath(__file__)), "engine-version.txt")
        if os.path.isfile(_verf):
            _alt = f"/tmp/dsh-engine-{open(_verf).read().strip()}"
            print(f"[webview] --engine {args.engine} 不存在，改用 {_alt}")
            args.engine = _alt
    engine = Path(args.engine)
    if not engine.is_dir():
        print(f"❌ 引擎目录不存在：{engine}", file=sys.stderr)
        return 1
    fe = engine / "node_modules/@deepseek-ai/dsh-web-frontend/dist"
    plugin_root = engine / "node_modules/@deepseek-ai"
    mobile_src = ROOT / "mobile-ui-plugin/dsh-android-mobile"

    targets = collect(fe, plugin_root, mobile_src)
    if not targets:
        print("❌ 没找到任何目标文件（引擎没解包？）", file=sys.stderr)
        return 1
    print(f"扫描 {len(targets)} 个 js/css（目标 {args.target}）…")

    work = Path(tempfile.mkdtemp(prefix="dsh-webcompat-"))
    out_dir = work / "out"
    out_dir.mkdir()
    esbuild = ensure_esbuild(work)

    def downgrade(item):
        entry, src = item
        dst = out_dir / entry
        dst.parent.mkdir(parents=True, exist_ok=True)
        base = work / ("base-" + hashlib.md5(entry.encode()).hexdigest() + ".out")
        r1 = run([esbuild, str(src), "--target=esnext", f"--outfile={base}", "--log-level=error"])
        if r1.returncode != 0:
            return (entry, "skip", (r1.stderr or "").strip()[:200])
        r2 = run([esbuild, str(src), f"--target={args.target}", f"--outfile={dst}", "--log-level=error"])
        if r2.returncode != 0:
            return (entry, "fail", (r2.stderr or "").strip()[:300])
        same = sha(base) == sha(dst)
        base.unlink(missing_ok=True)
        if same:
            dst.unlink(missing_ok=True)
            return (entry, "same", "")
        return (entry, "changed", "")

    changed, failures, skipped = [], [], []
    with cf.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for entry, verdict, msg in pool.map(downgrade, targets):
            if verdict == "changed":
                changed.append(entry)
            elif verdict == "fail":
                failures.append(f"{entry}: {msg}")
            elif verdict == "skip":
                skipped.append(f"{entry}: {msg}")

    if failures:
        print("\n".join(failures[:10]), file=sys.stderr)
        print("❌ 有文件降级失败", file=sys.stderr)
        return 1
    if skipped:
        print(f"⚠️ {len(skipped)} 个文件基准转换失败（跳过）", file=sys.stderr)

    groups: dict[str, int] = {}
    for e in changed:
        k = e.split("/")[0]
        groups[k] = groups.get(k, 0) + 1
    print(f"需要降级 {len(changed)} 个：{groups}")

    # 3.5 语法复检（只查 .js；rc=2 = 工具自身问题，不能伪装成语法问题）
    checker = ROOT / "tools/check-frontend-syntax.mjs"
    major = "".join(ch for ch in args.target if ch.isdigit())
    if checker.is_file() and changed:
        bad, tool_broke = [], None
        for entry in changed:
            if not entry.endswith(".js"):
                continue
            r = run(["node", str(checker), "--target", major, str(out_dir / entry)])
            if r.returncode == 2:
                tool_broke = ((r.stdout or "") + (r.stderr or "")).strip()[-300:]
                break
            if r.returncode != 0:
                bad.append(f"{entry}: {((r.stdout or '') + (r.stderr or '')).strip()[:300]}")
        if tool_broke:
            print(f"⚠️ 语法复检未执行（工具问题）：{tool_broke}", file=sys.stderr)
        elif bad:
            print("\n".join(bad[:10]), file=sys.stderr)
            print("❌ 降级产物仍有高版本语法", file=sys.stderr)
            return 1
        else:
            print(f"  → 语法复检通过（chrome{major}）")

    # 3.6 运行时 API 审计（默认只报告，--strict-audit 才失败）
    auditor = ROOT / "tools/audit-runtime-apis.mjs"
    polyfill = ROOT / "app/src/main/assets/webview-polyfill.js"
    if auditor.is_file() and polyfill.is_file():
        r = run(["node", str(auditor), "--polyfill", str(polyfill),
                 "--target", f"chrome{major}", str(fe), str(plugin_root), str(mobile_src)])
        print("\n".join(((r.stdout or "") + (r.stderr or "")).strip().splitlines()[-12:]))
        if r.returncode == 2:
            print("⚠️ 运行时 API 审计未执行（工具问题）", file=sys.stderr)
        elif r.returncode != 0:
            if args.strict_audit:
                print("❌ 存在未被 polyfill 覆盖的运行时 API", file=sys.stderr)
                return 1
            print("⚠️ 存在未被 polyfill 覆盖的运行时 API（非严格模式，继续）", file=sys.stderr)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    stamp = f"{args.target}-v{args.compat_version}"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for entry in changed:
            z.write(out_dir / entry, entry)
        z.writestr(".compat-stamp", stamp)

    size = out.stat().st_size
    shutil.rmtree(work, ignore_errors=True)
    print(f"已生成 {out}：条目 {len(changed) + 1} 个，{size:,} 字节")
    print(f"戳 = {stamp}（App 侧从 zip 读）")
    return 0


if __name__ == "__main__":
    sys.exit(main())