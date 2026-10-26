#!/usr/bin/env bash
# build-node-addon-system.sh —— 用 NDK 编 @deepseek-ai/node-addon-system 的 android 变体
#
# 为什么必须自己编：官方平台包只有 darwin/linux（linux 还分 glibc/musl），
# 而 Android 上 process.platform === 'android'，flock.js 的白名单直接抛
# ERR_FLOCK_UNSUPPORTED_PLATFORM → SessionWriteLease 拿不到锁 → 每轮「本轮运行失败」。
#
# 源码就在包里（src/flock.c + src/main.c，纯 C，只用 node_api.h），bionic 支持 flock(2)，
# 照原样编即可。产物布局对齐官方平台包，落到
# node_modules/@deepseek-ai/node-addon-system-android-arm64：
#   bin/system.node / package.json / prebuilds.json
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS="${APP_ASSETS:-$ROOT/app/src/main/assets}"
OUT="${OUT:-$ASSETS/node-addon-system-android-arm64.zip}"
ENGINE_DIR="${ENGINE_DIR:-/tmp/dsh-engine-0.2.1-rc.3}"
NODE_HEADERS_VERSION="${NODE_HEADERS_VERSION:-26.12.1}"
PKG_DIR="$ENGINE_DIR/node_modules/@deepseek-ai/node-addon-system"

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

[ -f "$PKG_DIR/src/flock.c" ] || { echo "❌ 找不到 $PKG_DIR/src/flock.c（需要 engine 副本）"; exit 1; }

NDK="$(resolve_ndk)" || { echo "❌ 找不到 NDK"; exit 1; }
CC="$(ls -d "$NDK"/toolchains/llvm/prebuilt/* | head -1)/bin/aarch64-linux-android26-clang"
[ -x "$CC" ] || { echo "❌ 没有 $CC"; exit 1; }

echo "== 1/4 Node 头文件 v$NODE_HEADERS_VERSION"
for base in https://npmmirror.com/mirrors/node https://nodejs.org/dist; do
  if curl -4 -fsS -L -m 300 -o "$WORK/hdr.tgz" "$base/v$NODE_HEADERS_VERSION/node-v$NODE_HEADERS_VERSION-headers.tar.gz"; then
    echo "   来源：$base"
    break
  fi
done
[ -s "$WORK/hdr.tgz" ] || { echo "❌ 头文件下载失败"; exit 1; }
tar -xzf "$WORK/hdr.tgz" -C "$WORK"

echo "== 2/4 编译 system.node（flock.c + main.c）"
NODE_INC="$WORK/node-v$NODE_HEADERS_VERSION/include/node"
"$CC" -shared -fPIC -O2 -Wall -Wl,--build-id=none \
  -I "$NODE_INC" \
  -o "$WORK/system.node" \
  "$PKG_DIR/src/flock.c" "$PKG_DIR/src/main.c"
ls -l "$WORK/system.node"

echo "== 3/4 体检"
if command -v readelf >/dev/null 2>&1; then
  DEPS="$(readelf -d "$WORK/system.node" | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p' | tr '\n' ' ')"
  echo "   NEEDED: $DEPS"
  case "$DEPS" in
    *libc++_shared*) echo "❌ 出现 libc++_shared"; exit 1 ;;
  esac
fi
if command -v nm >/dev/null 2>&1; then
  nm -D "$WORK/system.node" | grep -q 'napi_register_module_v1' \
    || { echo "❌ 未导出 napi_register_module_v1"; exit 1; }
  echo "   ✅ 导出 napi_register_module_v1"
fi

echo "== 4/4 打 zip"
python3 - "$WORK/system.node" "$OUT" <<'PY'
import json, sys, zipfile

node, out = sys.argv[1], sys.argv[2]
pkg = {
    'name': '@deepseek-ai/node-addon-system-android-arm64',
    'version': '0.1.2',
    'description': 'Android arm64 system binaries: Node-API flock addon (self-built for bionic)',
    'os': ['android'], 'cpu': ['arm64'],
    'files': ['bin/', 'prebuilds.json'],
    'engines': {'node': '>=20'},
    'license': 'BSD-3-Clause',
}
prebuilds = {'platform': 'android-arm64',
             'binaries': [{'tool': 'flock', 'kind': 'node-api', 'napi': 8, 'path': 'bin/system.node'}]}
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    zi = zipfile.ZipInfo('bin/system.node')
    zi.external_attr = 0o755 << 16
    zi.compress_type = zipfile.ZIP_DEFLATED
    with open(node, 'rb') as fh:
        z.writestr(zi, fh.read())
    z.writestr('package.json', json.dumps(pkg, ensure_ascii=False, indent=2))
    z.writestr('prebuilds.json', json.dumps(prebuilds, ensure_ascii=False, indent=2))
with zipfile.ZipFile(out) as z:
    assert 'bin/system.node' in z.namelist()
print('   bin/system.node + package.json + prebuilds.json')
PY

ls -lh "$OUT"
echo "✅ 完成：$OUT"
