#!/usr/bin/env bash
# build-proot-android.sh —— 交叉编译 proot（aarch64 + bionic），产出 libproot.so
#
# 为什么要在 CI 上编：
#   1. proot 的 RUNPATH 必须指向本 App 的私有目录；Termux 的现成二进制是写死 com.termux 的。
#   2. 本地没有 Android NDK，也没有能跑 aarch64 链接器的主机。
#
# 依赖链（proot 不是单文件能编出来的）：
#   talloc            → proot 用它做内存池（必需）
#   libandroid-shmem  → proot 的 shm_open 替代（bionic 没有 SysV shm）
#
# 产物：
#   dist/libproot.so             ← 放进 app/src/main/jniLibs/arm64-v8a/
#   dist/libproot-loader.so      ← 同上（若 proot 用内嵌 loader，则这里是空的，脚本会说明）
#   dist/*.info                  ← file / readelf 摘要，供人工核对
#
# 用法：
#   bash tools/proot/build-proot-android.sh --out dist
#   bash tools/proot/build-proot-android.sh --out dist --ndk ~/android-ndk-r27 --api 24 --jobs 4
set -u

OUT="dist"
NDK="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"
API="${API:-24}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 2)}"
PROOT_REPO="${PROOT_REPO:-https://github.com/termux/proot}"
SHMEM_REPO="${SHMEM_REPO:-https://github.com/termux/libandroid-shmem}"
TALLOC_VER="${TALLOC_VER:-2.4.2}"
WORK="${WORK:-$PWD/.proot-build}"

say() { printf '%s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit "${2:-1}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --ndk) NDK="$2"; shift 2 ;;
    --api) API="$2"; shift 2 ;;
    --jobs) JOBS="$2"; shift 2 ;;
    --work) WORK="$2"; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) printf 'unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

# ── 0) 找 NDK ────────────────────────────────────────────────────────
if [ -z "$NDK" ] || [ ! -d "$NDK" ]; then
  for cand in \
    "${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}"/ndk/* \
    "${ANDROID_HOME:-/nonexistent}"/ndk/* \
    "$HOME"/android-ndk-r* \
    /opt/android-ndk*; do
    [ -d "$cand/toolchains/llvm/prebuilt" ] && NDK="$cand"
  done
fi
[ -d "${NDK:-}/toolchains/llvm/prebuilt" ] || die "找不到 NDK（设 --ndk 或 ANDROID_NDK_HOME）" 12

TOOLCHAIN="$(echo "$NDK"/toolchains/llvm/prebuilt/*)"
CC="$TOOLCHAIN/bin/aarch64-linux-android${API}-clang"
AR="$TOOLCHAIN/bin/llvm-ar"
RANLIB="$TOOLCHAIN/bin/llvm-ranlib"
[ -x "$CC" ] || die "交叉编译器不存在：$CC" 12
say "== NDK    : $NDK"
say "   CC     : $CC"
say "   API    : $API"
say "   jobs   : $JOBS"

PREFIX="$WORK/prefix"
mkdir -p "$PREFIX" "$OUT" "$WORK/src"
BASE_CFLAGS="-O2 -fPIC -D_FILE_OFFSET_BITS=64 -D_GNU_SOURCE -I$PREFIX/include"
BASE_LDFLAGS="-L$PREFIX/lib"

# ── 1) talloc（proot 的硬依赖） ──────────────────────────────────────
say ""
say "== 1/4 talloc $TALLOC_VER"
if [ -f "$PREFIX/lib/libtalloc.a" ]; then
  say "   已有静态库，跳过"
else
  cd "$WORK/src" || die "进不去 $WORK/src"
  if [ ! -d "talloc-$TALLOC_VER" ]; then
    curl -fL --retry 3 -o "talloc-$TALLOC_VER.tar.gz" \
      "https://download.samba.org/pub/talloc/talloc-$TALLOC_VER.tar.gz" \
      || die "下载 talloc 失败" 3
    tar -xzf "talloc-$TALLOC_VER.tar.gz" || die "解包 talloc 失败" 4
  fi
  cd "talloc-$TALLOC_VER" || die "进不去 talloc 目录"
  # talloc 用 waf：--host 触发交叉，--disable-shared 只要静态库
  ./configure --host=aarch64-linux-android \
    --prefix="$PREFIX" \
    --disable-shared --enable-static \
    --disable-python --without-gettext \
    CC="$CC" AR="$AR" RANLIB="$RANLIB" CFLAGS="$BASE_CFLAGS" 2>&1 | tail -20
  make -j"$JOBS" 2>&1 | tail -20 || die "talloc 编译失败" 5
  make install 2>&1 | tail -10 || die "talloc 安装失败" 5
fi

# ── 2) libandroid-shmem（bionic 没有 SysV shm） ──────────────────────
say ""
say "== 2/4 libandroid-shmem"
if [ -f "$PREFIX/lib/libandroid-shmem.a" ]; then
  say "   已有，跳过"
else
  cd "$WORK/src" || die "进不去 $WORK/src"
  if [ ! -d libandroid-shmem ]; then
    git clone --depth 1 "$SHMEM_REPO" 2>&1 | tail -3 || die "clone libandroid-shmem 失败" 3
  fi
  cd libandroid-shmem || die "进不去 libandroid-shmem"
  "$CC" -O2 -fPIC -DBIONIC -c shm.c -o shm.o -I. 2>&1 | tail -10 || die "libandroid-shmem 编译失败" 5
  "$AR" rcs "$PREFIX/lib/libandroid-shmem.a" shm.o || die "打包 libandroid-shmem.a 失败" 5
  cp shm.h "$PREFIX/include/" 2>/dev/null || true
fi

# ── 3) proot ─────────────────────────────────────────────────────────
say ""
say "== 3/4 proot"
cd "$WORK/src" || die "进不去 $WORK/src"
if [ ! -d proot ]; then
  git clone --depth 1 "$PROOT_REPO" 2>&1 | tail -3 || die "clone proot 失败" 3
fi
cd proot || die "进不去 proot"
chmod +x src/makefile* 2>/dev/null || true

# termux-packages 的 proot 编译参数（ARG_MAX 必须放大，Android 的 argv 上限更高）
PROOT_CFLAGS="$BASE_CFLAGS -DARG_MAX=131072 -I$PWD/src -I$PWD"
PROOT_LDFLAGS="$BASE_LDFLAGS -ltalloc -landroid-shmem -llog -static-libgcc"

say "   make -C src ..."
make -C src -j"$JOBS" \
  CC="$CC" AR="$AR" RANLIB="$RANLIB" \
  CFLAGS="$PROOT_CFLAGS" LDFLAGS="$PROOT_LDFLAGS" \
  proot 2>&1 | tail -40 || die "proot 编译失败（看上面 40 行）" 5

[ -f src/proot ] || die "make 结束但没有 src/proot" 6

# ── 4) 收集产物 ──────────────────────────────────────────────────────
say ""
say "== 4/4 收集产物"
cp -f src/proot "$OUT/libproot.so"
say "   ✓ $OUT/libproot.so ($(stat -c%s src/proot) B)"

# loader：不同 proot 版本有的内嵌、有的外置，这里全找一遍
LOADER="$(find . -type f \( -name 'loader' -o -name 'loader-m32' -o -name 'loader.aarch64' \) 2>/dev/null | head -1)"
if [ -n "$LOADER" ]; then
  cp -f "$LOADER" "$OUT/libproot-loader.so"
  say "   ✓ $OUT/libproot-loader.so ($(stat -c%s "$LOADER") B, 来自 $LOADER)"
else
  say "   · 没找到外置 loader（多数新版 proot 把 loader 内嵌进二进制）"
  : > "$OUT/LOADER_EMBEDDED"
fi

# 摘要：RUNPATH 是不是 bionic / 有没有残留 com.termux 路径
{
  echo "== proot =="; file "$OUT/libproot.so" 2>/dev/null || echo "(no file cmd)"
  echo; echo "== 依赖 =="
  "$TOOLCHAIN/bin/llvm-readelf" -d "$OUT/libproot.so" 2>/dev/null | grep -E 'NEEDED|RUNPATH|RPATH' || true
  echo; echo "== 关键字符串 =="
  strings "$OUT/libproot.so" 2>/dev/null | grep -E '^(/data|/system|/apex)' | sort -u | head -20 || true
  echo; echo "== size =="; ls -l "$OUT"
} > "$OUT/proot.info" 2>&1

say ""
say "✓ 完成：$OUT"
say "  下一步（本地）：cp $OUT/libproot.so app/src/main/jniLibs/arm64-v8a/"
[ -f "$OUT/libproot-loader.so" ] && say "            cp $OUT/libproot-loader.so app/src/main/jniLibs/arm64-v8a/" || true