#!/usr/bin/env python3
"""check-apk-assets.py —— 出包后的硬断言（把「构建成功」升级成「包是完整的」）

为什么需要：Gradle 的 BUILD SUCCESSFUL 只说明任务跑完，**不说明资产真的进包了**。
本仓库出过「zip 忘了打 / 名字写错 / 被 .gitignore 吞掉」的事故族（见 asset-stamps.md 的 b0fbb4b）。

断言四组：
  1. 30 项运行期资产都在 APK 里，且非空
  2. 「容器型」资产做深度断言：bootstrap 必须提供 node 的 soname、node-runtime 必须带 libcares
  3. AndroidManifest 存在，包名恰好 15 字符（Termux ELF 原地改写的硬约束）
  4. targetSdk ≤ 28（Android 10+ 禁止 execve 应用私有目录）

第 2 组是补的上一课的：清单里少了 bootstrap-aarch64.zip，28/28 依然全绿，
真机却是 `FileNotFoundException: bootstrap-aarch64.zip` + `libz.so.1 not found`。
「资产在」≠「资产齐」——所以两个 zip 要拆开看里面。 

用法：
    python3 tools/check-apk-assets.py app/build/outputs/apk/system/debug/app-system-debug.apk
"""
from __future__ import annotations

import io
import os
import re
import subprocess
import sys
import zipfile
from pathlib import Path

# 与 tools/ci-fetch-assets.sh 的 REQUIRED 保持同步（改了那边就要改这里）
REQUIRED = [
    "engine.bin", "node-runtime.bin", "bootstrap-aarch64.zip",
    "boo-sandbox-run.bin", "boosandbox.bin", "linkcompat.bin",
    "mobile-ui.zip", "webview-compat.zip",
    "node-addon-android-arm64.zip", "node-addon-system-android-arm64.zip",
    "agnes-multimodal.zip", "preset-razor.zip", "preset-skills.zip",
    "core-memory.zip", "market-plugin.zip",
    "ripgrep-android-arm64.zip", "sharp-wasm32.zip",
    "node-pty-android-arm64.zip", "pnpm-android-arm64.zip",
    "shell-tool.zip", "root-tool.zip", "bubble-tool.zip",
    "statusbar-tool.zip", "uiagent-tool.zip", "logs-tool.zip",
    "browser-tool.zip", "browser-pane.zip", "pet-bridge.zip",
    "adb-wireless-arm64.zip",
    # 开发环境脚本：由 EngineManager.ensureDevEnvScript() 落盘给插件宿主半调用
    "dsh-env.mjs",
]


def required_sonames() -> list[str]:
    """node 的 DT_NEEDED 里、由 bootstrap 提供的 soname（与生成脚本共用一份清单）。"""
    p = Path(__file__).with_name("bootstrap-required.txt")
    if not p.is_file():
        return ["libz.so.1", "libssl.so.3", "libcrypto.so.3", "libc++_shared.so"]
    return [ln.strip() for ln in p.read_text(encoding="utf-8").splitlines()
            if ln.strip() and not ln.lstrip().startswith("#")]


def check_nested(z: zipfile.ZipFile) -> list[str]:
    """拆开两个容器型资产看里面 —— 它们在，不等于它们齐。"""
    errs: list[str] = []
    want = required_sonames()

    key = "assets/bootstrap-aarch64.zip"
    if key in z.namelist():
        with zipfile.ZipFile(io.BytesIO(z.read(key))) as b:
            names = b.namelist()
            provided = {n[4:] for n in names if n.startswith("lib/")}
            if "SYMLINKS.txt" not in names:
                errs.append("bootstrap 缺 SYMLINKS.txt（libz.so.1 这类软链不会被重建）")
            else:
                sym = b.read("SYMLINKS.txt").decode("utf-8", "replace")
                for line in sym.splitlines():
                    if "←" in line:
                        right = line.split("←", 1)[1].strip().replace("./", "").strip("/")
                        provided.add(os.path.basename(right))
            lack = [w for w in want if w not in provided]
            if lack:
                errs.append(f"bootstrap 缺必需 soname：{lack}")
            else:
                print(f"bootstrap：{len(names)} 条目，必需 soname 全在（{', '.join(want)}）")

    key = "assets/node-runtime.bin"
    if key in z.namelist():
        with zipfile.ZipFile(io.BytesIO(z.read(key))) as n:
            names = n.namelist()
            libs = sorted(x[4:] for x in names if x.startswith("lib/"))
            if "bin/node" not in names:
                errs.append("node-runtime.bin 缺 bin/node")
            if "lib/libcares.so" not in names:
                errs.append("node-runtime.bin 缺 lib/libcares.so（node 的 DT_NEEDED 里有它）")
            if not any(x.startswith("libicu") for x in libs):
                errs.append("node-runtime.bin 缺 libicu*")
            print(f"node-runtime：{len(libs)} 个库（{', '.join(libs)}）")

    return errs


def find_aapt2() -> str | None:
    if os.environ.get("AAPT2"):
        return os.environ["AAPT2"]
    for root in (os.environ.get("ANDROID_SDK_ROOT"), os.environ.get("ANDROID_HOME"),
                 "/usr/local/lib/android/sdk"):
        if not root:
            continue
        base = Path(root) / "build-tools"
        if not base.is_dir():
            continue
        for ver in sorted(base.iterdir(), reverse=True):
            exe = ver / "aapt2"
            if exe.is_file():
                return str(exe)
    return None


def main() -> int:
    if len(sys.argv) < 2:
        print("用法: check-apk-assets.py <apk>", file=sys.stderr)
        return 2
    apk = Path(sys.argv[1])
    if not apk.is_file():
        print(f"❌ APK 不存在：{apk}", file=sys.stderr)
        return 2

    errors: list[str] = []
    with zipfile.ZipFile(apk) as z:
        names = set(z.namelist())
        if "AndroidManifest.xml" not in names:
            errors.append("缺少 AndroidManifest.xml")
        if "classes.dex" not in names:
            errors.append("缺少 classes.dex")
        for asset in REQUIRED:
            key = f"assets/{asset}"
            if key not in names:
                errors.append(f"缺少资产 {key}")
                continue
            if z.getinfo(key).file_size <= 0:
                errors.append(f"资产为空 {key}")

        print(f"APK {apk.name}：{apk.stat().st_size:,} 字节，{len(names)} 条目")
        missing = [a for a in REQUIRED if f"assets/{a}" not in names]
        print(f"资产 {len(REQUIRED) - len(missing)}/{len(REQUIRED)} 齐备"
              + (f"，缺：{missing}" if missing else ""))
        errors.extend(check_nested(z))

    aapt2 = find_aapt2()
    if aapt2:
        r = subprocess.run([aapt2, "dump", "badging", str(apk)], text=True, capture_output=True)
        out = (r.stdout or "") + (r.stderr or "")
        m = re.search(r"package: name='([^']+)'", out)
        sdk = re.search(r"sdkVersion:'(\d+)'", out)
        target = re.search(r"targetSdkVersion:'(\d+)'", out)
        if m:
            pkg = m.group(1)
            print(f"包名 {pkg}（{len(pkg)} 字符）minSdk={sdk.group(1) if sdk else '?'} "
                  f"targetSdk={target.group(1) if target else '?'}")
            if len(pkg) != 15:
                errors.append(f"applicationId 必须恰好 15 字符（现 {len(pkg)}：{pkg}）")
        else:
            errors.append("aapt2 读不出 package 名")
        if target and int(target.group(1)) > 28:
            errors.append(f"targetSdk={target.group(1)} > 28（Android 10+ 禁止 execve 私有目录）")
    else:
        print("⚠️ 没找到 aapt2，跳过 manifest 数值断言")

    if errors:
        for e in errors:
            print(f"::error::{e}")
        return 1
    print("✅ APK 断言全过")
    return 0


if __name__ == "__main__":
    sys.exit(main())