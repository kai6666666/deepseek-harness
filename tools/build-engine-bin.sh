#!/usr/bin/env bash
# build-engine-bin.sh —— 把指定版本的 @deepseek-ai/dsh 打成 APK 资产 engine.bin
#
# 为什么不直接 zip 整个 node_modules：rc.3 完整树 859 MB（含全平台 prebuilds），
# APK 塞不下。这里做三件事：装 → 裁剪 → 压缩。
#
# 用法：
#   VER=0.2.1-rc.3 ./tools/build-engine-bin.sh
#   VER=0.2.1-rc.3 OUT=dist/engine.bin ./tools/build-engine-bin.sh
#
# 产物：dist/engine.bin（默认），体积目标 = 与上一版同量级（rc.2 为 55 MB）。

set -euo pipefail

VER="${VER:?用法: VER=0.2.1-rc.3 $0}"
OUT="${OUT:-dist/engine.bin}"
WORK="${WORK:-/tmp/dsh-engine-$VER}"
REGISTRY="${REGISTRY:-https://registry.npmmirror.com}"

echo "== 1/4 安装 @deepseek-ai/dsh@$VER → $WORK"
if [ "${SKIP_INSTALL:-0}" = "1" ] && [ -d "$WORK/node_modules/@deepseek-ai/dsh" ]; then
  echo "（SKIP_INSTALL=1，复用已有 node_modules）"
  cd "$WORK"
else
  rm -rf "$WORK" && mkdir -p "$WORK" && cd "$WORK"
  npm init -y >/dev/null
  npm i "@deepseek-ai/dsh@$VER" --no-audit --no-fund --ignore-scripts --registry="$REGISTRY"
fi

echo "== 2/4 裁剪（非 arm64 prebuilds / sourcemap / 测试与文档）"
# 只留 linux-arm64 与通用（无平台后缀）的 prebuilds：proot 用 glibc linux-arm64，
# bionic 侧的原生模块是 App 自编译、不从 engine.bin 取。
find node_modules -type d -name prebuilds -print0 2>/dev/null | while IFS= read -r -d '' d; do
  find "$d" -mindepth 1 -maxdepth 1 -type d \
    ! -name 'linux-arm64' ! -name 'android-arm64' -exec rm -rf {} + 2>/dev/null || true
done
find node_modules -type f \( -name '*.map' -o -name '*.tsbuildinfo' \) -delete 2>/dev/null || true
find node_modules -type d \( -name test -o -name tests -o -name __tests__ -o -name docs \) \
  -prune -exec rm -rf {} + 2>/dev/null || true

# 移动端用不到的重包（默认只删最安全的三个；PRUNE_LIST 可覆盖）
#   libreoffice-kit-wasm   146 MB：Office→PDF，手机端几乎不用
#   sherpa-onnx-linux-arm64 39 MB：本地 TTS/ASR
#   dsh-experimental-inspector 26 MB：实验性 inspector
PRUNE_LIST="${PRUNE_LIST:-@deepseek-ai/libreoffice-kit-wasm @deepseek-ai/dsh-experimental-inspector sherpa-onnx-linux-arm64}"
for name in $PRUNE_LIST; do
  path="node_modules/$name"
  [ -e "$path" ] && { rm -rf "$path"; echo "  - 删除 $name"; }
done

echo "== 3/4 统计"
du -sh node_modules
BEFORE=$(du -sm node_modules | cut -f1)
echo "裁剪后: ${BEFORE} MB"

echo "== 4/4 打包 $OUT"
cd "$WORK"
rm -f "$OUT"
# 🔴 必须是 **gzip 的 tar**，不是 zip。
#    EngineManager.ensureExtracted 调的是 TarGz.extract()（GZIPInputStream + tar），
#    产出 zip 会在真机抛 `ZipException: Not in GZIP format`（2026-10-27 实测踩到）。
GZIP=-9 tar -czf "$OUT" node_modules package.json
ls -lh "$OUT"

echo
echo "下一步："
echo "  1) cp $OUT <repo>/app/src/main/assets/engine.bin"
echo "  2) 改 MainActivity.assetStamp = \"$VER-1\""
echo "  3) 上机跑 verify-c.sh 与 headless（见 docs/agents/engine-upgrade.md）"