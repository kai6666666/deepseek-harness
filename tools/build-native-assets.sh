#!/usr/bin/env bash
# build-native-assets.sh —— 在 CI（x86_64 + NDK）上重建「能从源码造出来」的资产
#
# 覆盖 4 项（对应 docs/agents/regen-assets.md 里手工敲的那些命令）：
#   boosandbox.bin        LD_PRELOAD 沙箱（-shared -fPIC -ldl）
#   boo-sandbox-run.bin   沙箱启动器（可执行）
#   linkcompat.bin        link/rename 转译层（-shared -fPIC -ldl）
#   pnpm-android-arm64.zip  纯 JS，取 npm 上的 pnpm 11.28.3（条目不带顶层目录）
#
# 不覆盖（需要本机私有产物或额外工具链）：
#   node-pty / sharp / 各 tool 插件 / mobile-ui / preset / market / ripgrep …
#
# 用法：
#   ANDROID_NDK_HOME=/path/to/ndk/27.0.12077973 ./tools/build-native-assets.sh
#   SKIP_NATIVE=1 ./tools/build-native-assets.sh      # 只重建 pnpm
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JNI="$ROOT/app/src/main/jni"
ASSETS="${APP_ASSETS:-$ROOT/app/src/main/assets}"
PNPM_VERSION="${PNPM_VERSION:-11.28.3}"

mkdir -p "$ASSETS"

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

if [ "${SKIP_NATIVE:-0}" != "1" ]; then
  NDK="$(resolve_ndk)" || { echo "❌ 找不到 NDK（设 ANDROID_NDK_HOME 或装 ndk;27.0.12077973）"; exit 1; }
  TOOLCHAIN="$(ls -d "$NDK"/toolchains/llvm/prebuilt/* 2>/dev/null | head -1)"
  CC="$TOOLCHAIN/bin/aarch64-linux-android26-clang"
  [ -x "$CC" ] || { echo "❌ 没有 $CC"; exit 1; }
  echo "== 1/2 原生三元组（NDK: $NDK）"

  # -Wl,--build-id=none：让产物可复现（同源码两次编译字节一致）
  "$CC" -shared -fPIC -O2 -Wall -Wl,--build-id=none \
    -o "$ASSETS/boosandbox.bin" "$JNI/boosandbox.c" -ldl
  "$CC" -O2 -Wall -Wl,--build-id=none \
    -o "$ASSETS/boo-sandbox-run.bin" "$JNI/boo-sandbox-run.c"
  "$CC" -shared -fPIC -O2 -Wall -Wl,--build-id=none \
    -o "$ASSETS/linkcompat.bin" "$JNI/linkcompat.c" -ldl

  ls -l "$ASSETS/boosandbox.bin" "$ASSETS/boo-sandbox-run.bin" "$ASSETS/linkcompat.bin"
else
  echo "== 1/2 跳过原生（SKIP_NATIVE=1）"
fi

echo "== 2/2 pnpm $PNPM_VERSION"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
TGZ="$WORK/pnpm.tgz"
for base in https://registry.npmmirror.com https://registry.npmjs.org; do
  if curl -4 -fsS -L -m 300 -o "$TGZ" "$base/pnpm/-/pnpm-$PNPM_VERSION.tgz"; then
    echo "   来源：$base"
    break
  fi
done
[ -s "$TGZ" ] || { echo "❌ pnpm tarball 下载失败"; exit 1; }
tar -xzf "$TGZ" -C "$WORK"

python3 - "$WORK/package" "$ASSETS/pnpm-android-arm64.zip" <<'PY'
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
n = 0
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for dirpath, _, files in os.walk(src):
        for f in files:
            p = os.path.join(dirpath, f)
            rel = os.path.relpath(p, src)
            zi = zipfile.ZipInfo(rel)
            zi.external_attr = (0o755 if rel.startswith('bin/') else 0o644) << 16
            zi.compress_type = zipfile.ZIP_DEFLATED
            with open(p, 'rb') as fh:
                z.writestr(zi, fh.read())
            n += 1
print(f'   条目 {n} 个')
PY

ls -lh "$ASSETS/pnpm-android-arm64.zip"

echo "== 体检"
python3 - "$ASSETS/pnpm-android-arm64.zip" <<'PY'
import zipfile, sys
with zipfile.ZipFile(sys.argv[1]) as z:
    names = z.namelist()
assert 'bin/pnpm.mjs' in names, f"条目名不对，前 3 个：{names[:3]}"
print('   ✅ 条目名正确（bin/pnpm.mjs）')
PY
echo "✅ 完成"
