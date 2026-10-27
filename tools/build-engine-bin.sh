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

echo "== 3/4 统计 + MANIFEST"
du -sh node_modules
BEFORE=$(du -sm node_modules | cut -f1)
echo "裁剪后: ${BEFORE} MB"

# MANIFEST.txt —— 给真机解包后的对账用（EngineManager.verifyEngineManifest）。
# 只声明 node_modules 下的**普通文件数**与**字节和**：这两个值 TarGz 边写边数，
# 能对上才算解全。为什么需要：2026-10-27 真机把 52 537 条只解出 2 463 条还报「完成」，
# 没有任何一处做过「解出来的东西 == 归档声明的东西」这个比对。
NM_FILES=$(find node_modules -type f | wc -l | tr -d ' ')
NM_BYTES=$(find node_modules -type f -printf '%s\n' | awk '{s+=$1} END{printf "%d", s+0}')
printf 'node_modules_files=%s\nnode_modules_bytes=%s\n' "$NM_FILES" "$NM_BYTES" > MANIFEST.txt
echo "MANIFEST: ${NM_FILES} 个文件 / ${NM_BYTES} 字节"

echo "== 4/4 打包 $OUT"
cd "$WORK"
rm -f "$OUT"
# 🔴 必须是 **gzip 的 tar**，不是 zip。
#    EngineManager.ensureExtracted 调的是 TarGz.extract()（GZIPInputStream + tar），
#    产出 zip 会在真机抛 `ZipException: Not in GZIP format`（2026-10-27 实测踩到）。
GZIP=-9 tar -czf "$OUT" node_modules package.json MANIFEST.txt
ls -lh "$OUT"

echo "== 体检（出包前自己先验一遍）"
# ⚠️ 一次 tar -tzf 落盘再查三遍：直接 `tar -tzf | grep -q` 会让 grep 提前关闭管道，
#   tar 收到 SIGPIPE（日志里的 `tar: stdout: write error`），pipefail 下整条流水线变成失败。
LIST=$(mktemp)
tar -tzf "$OUT" > "$LIST"
ENTRIES=$(wc -l < "$LIST" | tr -d ' ')
LONG=$(awk 'length($0) > 100' "$LIST" | wc -l | tr -d ' ')
echo "   条目 ${ENTRIES}（文件 ${NM_FILES}），>100 字符的路径 ${LONG} 条"
[ "$ENTRIES" -ge "$NM_FILES" ] || { rm -f "$LIST"; echo "❌ 条目数少于文件数，归档被截断"; exit 1; }
if [ "$LONG" -gt 0 ]; then
  echo "   ⚠️ ${LONG} 条路径超过 100 字符：GNU tar 会用 ././@LongLink 承载，"
  echo "      客户端 TarGz 必须支持 'L' 头（2026-10-27 就是因为没支持，解包停在 2463 条）"
fi
if grep -qxF 'node_modules/@deepseek-ai/dsh/lib/bin.js' "$LIST"; then
  echo "   引擎入口 @deepseek-ai/dsh/lib/bin.js 在归档里"
else
  rm -f "$LIST"; echo "❌ 归档里没有 @deepseek-ai/dsh/lib/bin.js"; exit 1
fi
rm -f "$LIST"

echo
echo "下一步："
echo "  1) cp $OUT <repo>/app/src/main/assets/engine.bin"
echo "  2) 改 MainActivity.assetStamp = \"$VER-1\""
echo "  3) 上机跑 verify-c.sh 与 headless（见 docs/agents/engine-upgrade.md）"