#!/usr/bin/env bash
# build-node-addon-require-builtin.sh —— 用 NDK 编 node-addon-require-builtin 的 android 变体
#
# 源码来源（已镜像进仓库）：native/require-builtin-src.zip
#   上游：deepseek-ai/dsh-node-addon-require-builtin@master
#   packages/native/**            原生实现（52 个文件，165 KB）
#   packages/require-builtin/entry/**   JS 包装（仅供对照，不参与编译）
#
# 编译配置照 binding.gyp 的 **napi 后端**分支抄：
#   sources: node_api_addon/debug_trace/native_types/runtime_symbol
#            runtime_context/{helper,platform,darwin_arm64,darwin_x64,linux_arm64,linux_x64,
#                             win32_arm64,win32_x64,win32_ia32}
#            runtime_probe/{helper,platform,getter_decoder,posix,win32_common,
#                           darwin_arm64,darwin_x64,linux_arm64,linux_x64,
#                           win32_arm64,win32_x64,win32_ia32}
#            require_builtin_probe
#            + napi 分支：runtime_context/{embedder_data,runtime_profile,runtime_profile_napi}
#                          runtime_compat_napi
#   defines: NAPI_VERSION=9 NODE_ADDON_API_DISABLE_CPP_EXCEPTIONS NARB_BACKEND=1
#   cflags : -std=c++17 -fno-exceptions -fvisibility=hidden -static-libstdc++
#
# ⚠️ 平台判定用的是 `__linux__`（见 runtime_probe/platform.cc），Android 也命中它，
#    于是走 linux_arm64 的 V8 getter 解析器。能不能在 bionic + Termux node 上真跑，
#    要真机验证（加载器会校验 getNativeBindingInfo 的 product/abi）。
#
# 用法：
#   ANDROID_NDK_HOME=/path/to/ndk ./tools/build-node-addon-require-builtin.sh
#   EXTERNAL_ADDON=/path/android-arm64-napi-v9.node ./tools/build-node-addon-require-builtin.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS="${APP_ASSETS:-$ROOT/app/src/main/assets}"
OUT="${OUT:-$ASSETS/node-addon-android-arm64.zip}"
SRC_DIR="${SRC_DIR:-$ROOT/native/require-builtin-src}"
SRC_ZIP="${SRC_ZIP:-$ROOT/native/require-builtin-src.zip}"
EXTERNAL_ADDON="${EXTERNAL_ADDON:-}"
ENGINE_DIR="${ENGINE_DIR:-/tmp/dsh-engine-0.2.1-rc.3}"
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

# ---------- 模式 1：源码（目录或镜像 zip） ----------
SRC_ROOT=""
if [ -d "$SRC_DIR/packages/native/src" ]; then
  SRC_ROOT="$SRC_DIR"
elif [ -s "$SRC_ZIP" ]; then
  echo "== 解包镜像源码 $SRC_ZIP"
  mkdir -p "$WORK/src"
  python3 -m zipfile -e "$SRC_ZIP" "$WORK/src"
  SRC_ROOT="$WORK/src"
fi

if [ -n "$SRC_ROOT" ]; then
  echo "== 模式 1：从源码编译（$SRC_ROOT）"
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
  NODE_INC="$WORK/node-v$NODE_HEADERS_VERSION/include/node"

  ADDON_API="$ENGINE_DIR/node_modules/node-addon-api"
  if [ ! -d "$ADDON_API" ]; then
    echo "   node-addon-api 不在引擎副本里，npm 现取"
    ( cd "$WORK" && npm init -y >/dev/null 2>&1 && npm i --ignore-scripts --no-audit --no-fund node-addon-api >/dev/null 2>&1 )
    ADDON_API="$WORK/node_modules/node-addon-api"
  fi
  echo "   node-addon-api ← $ADDON_API"

  N="$SRC_ROOT/packages/native/src"
  SOURCES=(
    "$N/node_api_addon.cc" "$N/debug_trace.cc" "$N/native_types.cc" "$N/runtime_symbol.cc"
    "$N/runtime_context/helper.cc" "$N/runtime_context/platform.cc"
    "$N/runtime_context/darwin_arm64.cc" "$N/runtime_context/darwin_x64.cc"
    "$N/runtime_context/linux_arm64.cc" "$N/runtime_context/linux_x64.cc"
    "$N/runtime_context/win32_arm64.cc" "$N/runtime_context/win32_x64.cc" "$N/runtime_context/win32_ia32.cc"
    "$N/runtime_probe/helper.cc" "$N/runtime_probe/platform.cc" "$N/runtime_probe/getter_decoder.cc"
    "$N/runtime_probe/posix.cc" "$N/runtime_probe/win32_common.cc"
    "$N/runtime_probe/darwin_arm64.cc" "$N/runtime_probe/darwin_x64.cc"
    "$N/runtime_probe/linux_arm64.cc" "$N/runtime_probe/linux_x64.cc"
    "$N/runtime_probe/win32_arm64.cc" "$N/runtime_probe/win32_x64.cc" "$N/runtime_probe/win32_ia32.cc"
    "$N/require_builtin_probe.cc"
    "$N/runtime_context/embedder_data.cc" "$N/runtime_context/runtime_profile.cc"
    "$N/runtime_context/runtime_profile_napi.cc" "$N/runtime_compat_napi.cc"
  )
  for f in "${SOURCES[@]}"; do
    [ -f "$f" ] || { echo "❌ 缺少源码 $f"; exit 1; }
  done

  echo "   编译 ${#SOURCES[@]} 个 .cc（napi 后端）"
  "$CXX" -shared -fPIC -O2 -std=c++17 -fno-exceptions -fvisibility=hidden \
    -static-libstdc++ -Wl,--build-id=none \
    -DNAPI_VERSION=9 -DNODE_ADDON_API_DISABLE_CPP_EXCEPTIONS -DNARB_BACKEND=1 \
    -I "$NODE_INC" -I "$ADDON_API" \
    -o "$WORK/addon.node" "${SOURCES[@]}"

  if command -v nm >/dev/null 2>&1; then
    nm -D "$WORK/addon.node" | grep -q 'napi_register_module_v1' || { echo "❌ 不是合法 N-API 模块"; exit 1; }
    echo "   ✅ 导出 napi_register_module_v1"
  fi
  if command -v readelf >/dev/null 2>&1; then
    echo "   NEEDED: $(readelf -d "$WORK/addon.node" | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p' | tr '\n' ' ')"
  fi
  ls -l "$WORK/addon.node"
  package_node "$WORK/addon.node" "built-from-vendored-source"
  echo "✅ 完成（源码模式）"
  exit 0
fi

# ---------- 模式 2：外部产物 ----------
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
  package_node "$EXTERNAL_ADDON" "external"
  echo "✅ 完成（外部产物模式）"
  exit 0
fi

echo "::warning::源码与外部产物都没有（native/require-builtin-src.zip 缺失？），跳过"
exit 0