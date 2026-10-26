#!/usr/bin/env bash
# build-node-addon-require-builtin.sh —— 最后一个资产的「可填充插槽」
#
# 为什么 CI 造不出：
#   node-addon-require-builtin 的 npm 包只发 JS（lib/index.js + index.d.ts），
#   原生实现只以各平台预编译 .node 形式发布（linux-arm64-gnu / darwin…），
#   没有 android 变体，也没有 C/C++ 源码。
#
#   接口（由 node-addon-native-custom-loader 校验）要求导出：
#       requireBuiltin(id) / isAllowedInternalId(id) / getNativeBindingInfo()
#   实现它必须访问 Node 内部 builtin 表，这不是 N-API 能力 —— 上游是在 Node 源码树里编的。
#
# 三种模式：源码模式 / 外部产物模式 / 明确跳过（exit 0）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS="${APP_ASSETS:-$ROOT/app/src/main/assets}"
OUT="${OUT:-$ASSETS/node-addon-android-arm64.zip}"
SRC_DIR="${SRC_DIR:-$ROOT/native/require-builtin/src}"
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
pkg = {
    'name': 'node-addon-require-builtin-android-arm64',
    'version': '0.0.0-selfbuilt',
    'description': 'Android arm64 requireBuiltin binding (see docs/agents/node-addon-require-builtin.md)',
    'os': ['android'], 'cpu': ['arm64'], 'license': 'MIT',
    'dshOrigin': origin,
}
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

if compgen -G "$SRC_DIR/*.c*" >/dev/null; then
  echo "== 模式 1：从本地源码编译（$SRC_DIR）"
  NDK="$(resolve_ndk)" || { echo "❌ 找不到 NDK"; exit 1; }
  TC="$(ls -d "$NDK"/toolchains/llvm/prebuilt/* | head -1)"
  CXX="$TC/bin/aarch64-linux-android26-clang++"
  [ -x "$CXX" ] || { echo "❌ 没有 $CXX"; exit 1; }
  echo "   Node 头文件 v$NODE_HEADERS_VERSION"
  for base in https://npmmirror.com/mirrors/node https://nodejs.org/dist; do
    if curl -4 -fsS -L -m 300 -o "$WORK/hdr.tgz" "$base/v$NODE_HEADERS_VERSION/node-v$NODE_HEADERS_VERSION-headers.tar.gz"; then
      echo "   来源：$base"; break
    fi
  done
  [ -s "$WORK/hdr.tgz" ] || { echo "❌ 头文件下载失败"; exit 1; }
  tar -xzf "$WORK/hdr.tgz" -C "$WORK"
  "$CXX" -shared -fPIC -O2 -std=c++17 -static-libstdc++ -Wl,--build-id=none \
    -I "$WORK/node-v$NODE_HEADERS_VERSION/include/node" -I "$SRC_DIR" \
    -o "$WORK/addon.node" $(find "$SRC_DIR" -maxdepth 1 -name '*.c*' -print)
  if command -v nm >/dev/null 2>&1; then
    nm -D "$WORK/addon.node" | grep -q 'napi_register_module_v1' || { echo "❌ 不是合法 N-API 模块"; exit 1; }
  fi
  package_node "$WORK/addon.node" "built-from-source"
  echo "✅ 完成（源码模式）"
  exit 0
fi

if [ -n "$EXTERNAL_ADDON" ]; then
  [ -s "$EXTERNAL_ADDON" ] || { echo "❌ EXTERNAL_ADDON 不存在：$EXTERNAL_ADDON"; exit 1; }
  echo "== 模式 2：校验外部产物 $EXTERNAL_ADDON"
  python3 - "$EXTERNAL_ADDON" <<'PY'
import struct, sys
b = open(sys.argv[1], 'rb').read(64)
if b[:4] != b'\x7fELF':
    sys.exit('❌ 不是 ELF（期望 .node）')
m = struct.unpack('<H', b[18:20])[0]
if m != 183:
    sys.exit(f'❌ e_machine={m}，不是 AArch64（183）')
print('   ✅ ELF / AArch64')
PY
  if command -v readelf >/dev/null 2>&1; then
    echo "   NEEDED: $(readelf -d "$EXTERNAL_ADDON" | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p' | tr '\n' ' ')"
  fi
  package_node "$EXTERNAL_ADDON" "external"
  echo "✅ 完成（外部产物模式）"
  exit 0
fi

cat <<'WARN'
::warning::node-addon-android-arm64.zip 未生成（CI 缺少上游源码）
   原因：npm 包只发 JS，原生实现无源码；requireBuiltin 必须链接 Node 内部符号。
   补齐二选一：
     ① 把上游 src/ 镜像到 native/require-builtin/src/ 后重跑（模式 1）
     ② EXTERNAL_ADDON=/path/android-arm64-napi-v9.node 重跑（模式 2）
   详见 docs/agents/node-addon-require-builtin.md
WARN
echo "（跳过，资产覆盖停在 27/28；exit 0，不阻塞出包）"
exit 0
