#!/usr/bin/env bash
# build-node-addon-require-builtin.sh —— 用镜像进来的上游源码编 requireBuiltin 的 android 变体
#
# 源码来自上游 deepseek-ai/dsh-node-addon-require-builtin @HEAD：
# 本机直连 github.com:443 不通，走 jsDelivr 镜像；已打成 native/require-builtin-src.zip。
#
# 三种模式：源码（目录或 zip）/ 外部产物 / 明确跳过。
#
# ⚠️ Android 现实：platform.cc 用 `#elif defined(__linux__) && defined(__aarch64__)`
#    路由到 **Linux/glibc** 探针（解析 glibc loader/malloc 内部布局）。bionic 与 glibc 不同源，
#    **能编译不代表能工作** —— 运行期由加载器 getNativeBindingInfo() 校验、引擎 try/catch 兜底。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS="${APP_ASSETS:-$ROOT/app/src/main/assets}"
OUT="${OUT:-$ASSETS/node-addon-android-arm64.zip}"
SRC_DIR="${SRC_DIR:-$ROOT/native/require-builtin-src}"
SRC_ZIP="${SRC_ZIP:-$ROOT/native/require-builtin-src.zip}"
EXTERNAL_ADDON="${EXTERNAL_ADDON:-}"
NODE_HEADERS_VERSION="${NODE_HEADERS_VERSION:-26.12.1}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$ASSETS"

resolve_ndk() {
  if [ -n "${ANDROID_NDK_HOME:-}" ] && [ -d "$ANDROID_NDK_HOME" ]; then echo "$ANDROID_NDK_HOME"; return; fi
  if [ -n "${ANDROID_NDK_ROOT:-}" ] && [ -d "$ANDROID_NDK_ROOT" ]; then echo "$ANDROID_NDK_ROOT"; return; fi
  for base in "${ANDROID_SDK_ROOT:-}" "${ANDROID_HOME:-}" /usr/local/lib/android/sdk "$HOME/Android/Sdk"; do
    [ -n "$base" ] || continue
    if [ -d "$base/ndk" ]; then ls -d "$base/ndk"/* 2>/dev/null | sort -V | tail -1; return; fi
  done
  return 1
}

package_node() {
  local node_file="$1" origin="$2"
  python3 - "$node_file" "$OUT" "$origin" <<'PY'
import json, sys, zipfile
node, out, origin = sys.argv[1], sys.argv[2], sys.argv[3]
pkg = {'name': 'node-addon-require-builtin-android-arm64', 'version': '0.1.9-selfbuilt',
       'description': 'Android arm64 requireBuiltin binding (mirrored source build)',
       'os': ['android'], 'cpu': ['arm64'], 'license': 'MIT', 'dshOrigin': origin}
prebuilds = {'platform': 'android-arm64',
             'binaries': [{'backend': 'napi', 'abi': 'napi-v9', 'binaryTag': 'napi-v9',
                           'node': '>=20', 'path': 'prebuilt/android-arm64-napi-v9.node'}]}
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    zi = zipfile.ZipInfo('prebuilt/android-arm64-napi-v9.node')
    zi.external_attr = 0o755 << 16
    zi.compress_type = zipfile.ZIP_DEFLATED
    with open(node, 'rb') as f:
        z.writestr(zi, f.read())
    z.writestr('prebuilds.json', json.dumps(prebuilds, ensure_ascii=False, indent=2))
    z.writestr('package.json', json.dumps(pkg, ensure_ascii=False, indent=2))
print('   prebuilt/android-arm64-napi-v9.node + prebuilds.json + package.json')
PY
  ls -lh "$OUT"
}

NATIVE=""
if [ -d "$SRC_DIR/packages/native" ]; then
  NATIVE="$SRC_DIR/packages/native"
  echo "== 源码：本地目录 $NATIVE"
elif [ -s "$SRC_ZIP" ]; then
  echo "== 源码：解压 $SRC_ZIP"
  mkdir -p "$WORK/src"
  python3 - "$SRC_ZIP" "$WORK/src" <<'PY'
import sys, zipfile
zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])
PY
  NATIVE="$WORK/src/packages/native"
fi

if [ -n "$NATIVE" ] && [ -f "$NATIVE/binding.gyp" ]; then
  echo "== 模式 1：源码编译（$NATIVE）"
  NDK="$(resolve_ndk)" || { echo "❌ 找不到 NDK"; exit 1; }
  TC="$(ls -d "$NDK"/toolchains/llvm/prebuilt/* | head -1)"
  CXX="$TC/bin/aarch64-linux-android26-clang++"
  [ -x "$CXX" ] || { echo "❌ 没有 $CXX"; exit 1; }

  echo "== Node 头文件 v$NODE_HEADERS_VERSION"
  for base in https://npmmirror.com/mirrors/node https://nodejs.org/dist; do
    if curl -4 -fsS -L -m 300 -o "$WORK/hdr.tgz" "$base/v$NODE_HEADERS_VERSION/node-v$NODE_HEADERS_VERSION-headers.tar.gz"; then
      echo "   来源：$base"; break
    fi
  done
  [ -s "$WORK/hdr.tgz" ] || { echo "❌ 头文件下载失败"; exit 1; }
  tar -xzf "$WORK/hdr.tgz" -C "$WORK"
  NODE_INC="$WORK/node-v$NODE_HEADERS_VERSION/include/node"

  mkdir -p "$WORK/napi"
  ( cd "$WORK/napi" && npm init -y >/dev/null 2>&1 \
    && npm i --ignore-scripts --no-audit --no-fund node-addon-api@8 >/dev/null 2>&1 )
  NAPI_INC="$WORK/napi/node_modules/node-addon-api"

  python3 - "$NATIVE" > "$WORK/sources.txt" <<'PY'
import os, re, sys
root = sys.argv[1]
gyp = open(os.path.join(root, 'binding.gyp'), encoding='utf-8').read()
paths = re.findall(r'"([^"]+\.cc)"', gyp)
seen, out = set(), []
for p in paths:
    if p in seen or 'nodeabi' in p:
        continue
    seen.add(p)
    if os.path.isfile(os.path.join(root, p)):
        out.append(p)
    else:
        print(f'# MISSING {p}', file=sys.stderr)
print('\n'.join(out))
PY
  echo "   源文件 $(grep -c . "$WORK/sources.txt" || true) 个"

  mkdir -p "$WORK/obj"
  FAIL=0
  while read -r f; do
    [ -z "$f" ] && continue
    o="$WORK/obj/$(echo "$f" | tr '/' '_').o"
    if ! "$CXX" -c -fPIC -O2 -Wall -Wno-unused-parameter -fno-exceptions -fvisibility=hidden \
        -std=c++17 -DNAPI_VERSION=9 -DNAPI_DISABLE_CPP_EXCEPTIONS -DNODE_ADDON_API_DISABLE_CPP_EXCEPTIONS \
        -DNARB_BACKEND=1 -DNARB_PRODUCT=1 \
        -I "$NODE_INC" -I "$NAPI_INC" -I "$NATIVE/src" \
        -o "$o" "$NATIVE/$f" 2> "$WORK/err.txt"; then
      echo "❌ 编译失败：$f"
      head -12 "$WORK/err.txt"
      FAIL=1
      break
    fi
  done < "$WORK/sources.txt"

  if [ "$FAIL" -ne 0 ]; then
    echo "::warning::require-builtin 源码在 bionic 下编译失败（见上方首个错误）—— 跳过"
    exit 0
  fi

  "$CXX" -shared -static-libstdc++ -Wl,--build-id=none -o "$WORK/addon.node" "$WORK"/obj/*.o
  if command -v nm >/dev/null 2>&1; then
    nm -D "$WORK/addon.node" | grep -q 'napi_register_module_v1' \
      || { echo "::warning::产物未导出 napi_register_module_v1 —— 跳过"; exit 0; }
  fi
  if command -v readelf >/dev/null 2>&1; then
    echo "   NEEDED: $(readelf -d "$WORK/addon.node" | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p' | tr '\n' ' ')"
  fi
  package_node "$WORK/addon.node" "mirrored-source"
  echo "✅ 完成（源码模式）"
  exit 0
fi

if [ -n "$EXTERNAL_ADDON" ]; then
  [ -s "$EXTERNAL_ADDON" ] || { echo "❌ EXTERNAL_ADDON 不存在：$EXTERNAL_ADDON"; exit 1; }
  echo "== 模式 2：校验外部产物"
  python3 - "$EXTERNAL_ADDON" <<'PY'
import struct, sys
b = open(sys.argv[1], 'rb').read(64)
if b[:4] != b'\x7fELF':
    sys.exit('❌ 不是 ELF')
if struct.unpack('<H', b[18:20])[0] != 183:
    sys.exit('❌ 不是 AArch64')
print('   ✅ ELF / AArch64')
PY
  package_node "$EXTERNAL_ADDON" "external"
  echo "✅ 完成（外部产物模式）"
  exit 0
fi

cat <<'WARN'
::warning::node-addon-android-arm64.zip 未生成
   补齐二选一：① 放 native/require-builtin-src/ 或 .zip（源码模式）
              ② EXTERNAL_ADDON=/path/android-arm64-napi-v9.node
   详见 docs/agents/node-addon-require-builtin.md
WARN
echo "（跳过，资产覆盖停在 27/28）"
exit 0