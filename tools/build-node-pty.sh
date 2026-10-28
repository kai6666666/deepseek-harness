#!/usr/bin/env bash
# build-node-pty.sh —— 用 NDK 编 node-pty 的 android-arm64 绑定
#
# 为什么必须自己编：node-pty 的 prebuilds/ 只有 darwin/linux/win32，
# 而 lib/utils.js 按 `prebuilds/${process.platform}-${process.arch}` 找目录 →
# Android 上找 prebuilds/android-arm64/pty.node → 终端面板直接
# "Failed to load native module: pty.node"。上游源码一行都不用改。
#
# ⚠️ **必须 -static-libstdc++**：默认动态链会引入 libc++_shared.so，Termux 里没有
#    这个库，加载即失败。静态链后 readelf -d 只剩 libc / libm / libdl。
#
# 产物 zip 的条目是 `node-pty/prebuilds/android-arm64/pty.node`（相对 node_modules），
# 与 EngineManager.ensureNodePty() 的解包布局一致。
#
# 用法：
#   ANDROID_NDK_HOME=/path/to/ndk ENGINE_DIR=/tmp/dsh-engine-0.2.1-rc.3 ./tools/build-node-pty.sh
#   NODE_HEADERS_VERSION=26.12.1 ./tools/build-node-pty.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS="${APP_ASSETS:-$ROOT/app/src/main/assets}"
OUT="${OUT:-$ASSETS/node-pty-android-arm64.zip}"
ENGINE_DIR="${ENGINE_DIR:-/tmp/dsh-engine-0.2.2-alpha.2}"
NODE_HEADERS_VERSION="${NODE_HEADERS_VERSION:-26.12.1}"

mkdir -p "$ASSETS"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

resolve_ndk() {
  if [ -n "${ANDROID_NDK_HOME:-}" ] && [ -d "$ANDROID_NDK_HOME" ]; then echo "$ANDROID_NDK_HOME"; return; fi
  if [ -n "${ANDROID_NDK_ROOT:-}" ] && [ -d "$ANDROID_NDK_ROOT" ]; then echo "$ANDROID_NDK_ROOT"; return; fi
  for base in "${ANDROID_SDK_ROOT:-}" "${ANDROID_HOME:-}" /usr/local/lib/android/sdk "$HOME/Android/Sdk"; do
    [ -n "$base" ] || continue
    if [ -d "$base/ndk" ]; then
      ndk="$(ls -d "$base/ndk"/* 2>/dev/null | sort -V | tail -1)"
      [ -n "$ndk" ] && { echo "$ndk"; return; }
    fi
  done
  return 1
}

NDK="$(resolve_ndk)" || { echo "❌ 找不到 NDK"; exit 1; }
CXX="$(ls -d "$NDK"/toolchains/llvm/prebuilt/* | head -1)/bin/aarch64-linux-android26-clang++"
[ -x "$CXX" ] || { echo "❌ 没有 $CXX"; exit 1; }

echo "== 1/4 取源码（优先用已装好的引擎副本）"
PTY_SRC=""
ADDON_API=""
if [ -d "$ENGINE_DIR/node_modules/node-pty" ]; then
  PTY_SRC="$ENGINE_DIR/node_modules/node-pty"
  echo "   node-pty ← $PTY_SRC"
else
  echo "   引擎副本不存在，npm 现取"
  ( cd "$WORK" && npm init -y >/dev/null 2>&1 && npm i node-pty node-addon-api --ignore-scripts --no-audit --no-fund >/dev/null 2>&1 )
  PTY_SRC="$WORK/node_modules/node-pty"
fi
[ -f "$PTY_SRC/src/unix/pty.cc" ] || { echo "❌ 找不到 pty.cc"; exit 1; }

if [ -d "$ENGINE_DIR/node_modules/node-addon-api" ]; then
  ADDON_API="$ENGINE_DIR/node_modules/node-addon-api"
elif [ -d "$WORK/node_modules/node-addon-api" ]; then
  ADDON_API="$WORK/node_modules/node-addon-api"
else
  ( cd "$WORK" && npm i node-addon-api --ignore-scripts --no-audit --no-fund >/dev/null 2>&1 )
  ADDON_API="$WORK/node_modules/node-addon-api"
fi
echo "   node-addon-api ← $ADDON_API"

echo "== 2/4 Node 头文件 v$NODE_HEADERS_VERSION（必须与运行时同 ABI）"
HDR_TGZ="$WORK/node-headers.tgz"
for base in https://npmmirror.com/mirrors/node https://nodejs.org/dist; do
  u="$base/v$NODE_HEADERS_VERSION/node-v$NODE_HEADERS_VERSION-headers.tar.gz"
  if curl -4 -fsS -L -m 300 -o "$HDR_TGZ" "$u"; then echo "   来源：$base"; break; fi
done
[ -s "$HDR_TGZ" ] || { echo "❌ 头文件下载失败"; exit 1; }
tar -xzf "$HDR_TGZ" -C "$WORK"

echo "== 3/4 编译 pty.node"
PTY_OUT="$WORK/pty.node"
"$CXX" -shared -fPIC -O2 -std=c++17 -static-libstdc++ -Wl,--build-id=none \
  -I "$WORK/node-v$NODE_HEADERS_VERSION/include/node" \
  -I "$ADDON_API" \
  -o "$PTY_OUT" "$PTY_SRC/src/unix/pty.cc"
ls -l "$PTY_OUT"

echo "== 4/4 依赖体检（不得出现 libc++_shared）"
if command -v readelf >/dev/null 2>&1; then
  DEPS="$(readelf -d "$PTY_OUT" | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p' | tr '\n' ' ')"
  echo "   NEEDED: $DEPS"
  case "$DEPS" in
    *libc++_shared*)
      echo "❌ 仍在动态链接 libc++_shared（缺 -static-libstdc++）"; exit 1 ;;
  esac
fi

python3 - "$PTY_OUT" "$OUT" <<'PY'
import sys, zipfile
src, out = sys.argv[1], sys.argv[2]
entry = 'node-pty/prebuilds/android-arm64/pty.node'
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    zi = zipfile.ZipInfo(entry)
    zi.external_attr = 0o755 << 16
    zi.compress_type = zipfile.ZIP_DEFLATED
    with open(src, 'rb') as f:
        z.writestr(zi, f.read())
print(f'   {entry}')
PY

ls -lh "$OUT"
echo "✅ 完成：$OUT"