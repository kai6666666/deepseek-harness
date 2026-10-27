#!/usr/bin/env bash
# ci-fetch-assets.sh —— 给 CI 铺构建资产（幂等；没有 Release 也照样返回 0）
#
# 为什么资产不入库：engine.bin(96 MB) + node-runtime.bin + 十来个原生 zip 约 135 MB，
# 二进制大文件进 git 会让每次 clone 都变慢，而它们都能从 Release 或构建脚本复现。
#
# 用法（CI 里由 workflow 调用；本地也能跑）：
#   ASSETS_TAG=assets-v1 bash tools/ci-fetch-assets.sh
#   ASSETS_TAG=assets-v1 STRICT_ASSETS=1 bash tools/ci-fetch-assets.sh   # 缺一个就失败
#
# Release 里应放一个（或多个）`dsh-assets*.zip`，zip 内可直接是资产文件，
# 也可以是 `assets/` 前缀目录——两种布局都支持。
set -uo pipefail

APP_ASSETS="${APP_ASSETS:-app/src/main/assets}"
TAG="${ASSETS_TAG:-}"
STRICT="${STRICT_ASSETS:-0}"
WORK="${WORK:-/tmp/dsh-assets}"

# 运行期真的会 open 的资产（常量见 EngineManager.Companion / TermuxBootstrap）。
# 缺了不会编译失败，但对应能力会在真机上报错，所以这里显式列出来做体检。
REQUIRED=(
  engine.bin
  node-runtime.bin
  bootstrap-aarch64.zip
  boo-sandbox-run.bin
  boosandbox.bin
  linkcompat.bin
  mobile-ui.zip
  webview-compat.zip
  node-addon-android-arm64.zip
  node-addon-system-android-arm64.zip
  agnes-multimodal.zip
  preset-razor.zip
  preset-skills.zip
  core-memory.zip
  market-plugin.zip
  ripgrep-android-arm64.zip
  sharp-wasm32.zip
  node-pty-android-arm64.zip
  pnpm-android-arm64.zip
  shell-tool.zip
  root-tool.zip
  bubble-tool.zip
  statusbar-tool.zip
  uiagent-tool.zip
  logs-tool.zip
  browser-tool.zip
  browser-pane.zip
  pet-bridge.zip
  adb-wireless-arm64.zip
  dsh-env.mjs
)

mkdir -p "$APP_ASSETS"

if [ -z "$TAG" ]; then
  echo "::notice::未指定 ASSETS_TAG（仓库变量 ASSETS_RELEASE 或手动输入），跳过资产下载"
  echo "未指定 ASSETS_TAG：本包将不含引擎资产" > "$APP_ASSETS/ASSETS_MISSING.txt"
  exit 0
fi

echo "== 1/3 下载 Release 附件：$TAG"
rm -rf "$WORK" && mkdir -p "$WORK"
if command -v gh >/dev/null 2>&1; then
  gh release download "$TAG" --pattern 'dsh-assets*.zip' --dir "$WORK" --clobber 2>&1 || true
else
  echo "（没有 gh，改用 API）"
  API="https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/tags/$TAG"
  curl -fsSL -H "Authorization: Bearer ${GH_TOKEN:-}" "$API" \
    | python3 -c 'import json,sys; [print(a["browser_download_url"]) for a in json.load(sys.stdin).get("assets",[]) if a["name"].startswith("dsh-assets") and a["name"].endswith(".zip")]' \
    | while read -r u; do echo "  ← $u"; curl -fsSL -o "$WORK/$(basename "$u")" "$u"; done
fi

ZIPS=$(find "$WORK" -maxdepth 1 -name 'dsh-assets*.zip' | wc -l)
if [ "$ZIPS" -eq 0 ]; then
  echo "::warning::Release $TAG 里没找到 dsh-assets*.zip"
  echo "Release $TAG 缺少 dsh-assets*.zip" > "$APP_ASSETS/ASSETS_MISSING.txt"
  [ "$STRICT" = "1" ] && exit 1
  exit 0
fi

echo "== 2/3 解包到 $APP_ASSETS"
for z in "$WORK"/dsh-assets*.zip; do
  echo "  - $(basename "$z") $(du -h "$z" | cut -f1)"
  # zip 里可能是 `assets/xxx` 也可能直接是 `xxx`
  unzip -oq "$z" -d "$WORK/x"
done
if [ -d "$WORK/x/assets" ]; then
  cp -a "$WORK/x/assets/." "$APP_ASSETS/"
else
  cp -a "$WORK/x/." "$APP_ASSETS/"
fi
# 夹带进来的 README/清单不算资产，清掉避免打进 APK
find "$APP_ASSETS" -maxdepth 1 -type f \( -name '*.md' -o -name 'SHA256SUMS*' \) -delete

echo "== 3/3 体检"
MISSING=()
for f in "${REQUIRED[@]}"; do
  [ -s "$APP_ASSETS/$f" ] || MISSING+=("$f")
done

if [ ${#MISSING[@]} -eq 0 ]; then
  rm -f "$APP_ASSETS/ASSETS_MISSING.txt"
  echo "✅ 资产齐备：${#REQUIRED[@]} 项，总体积 $(du -sh "$APP_ASSETS" | cut -f1)"
  exit 0
fi

echo "::warning::缺少 ${#MISSING[@]} 项资产：${MISSING[*]}"
printf '%s\n' "${MISSING[@]}" > "$APP_ASSETS/ASSETS_MISSING.txt"
if [ "$STRICT" = "1" ]; then
  echo "STRICT_ASSETS=1 ⇒ 失败"
  exit 1
fi
echo "（非严格模式：继续出包，但 APK 内缺少上述能力）"
exit 0