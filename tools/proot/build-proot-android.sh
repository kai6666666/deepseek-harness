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
  # talloc 用 waf：选项在不同版本里不一样（实测 2.4.2 不认 --disable-shared），
  # 所以先问 --help，只拼它支持的选项。
  ./configure --help > waf-help.txt 2>&1 || true
  # ⚠️ 交叉编译探测：waf 是二选一
  #   --cross-compile        → 完全不运行探测程序（新版 waf 会再要求 --cross-execute/--cross-answers，
  #                            实测 talloc 2.4.2 报 "Cannot cross-compile without either ..."）
  #   --cross-execute=<prog> → 拿这个程序去"运行"编译产物；`/bin/true` 最省事：返回 0、输出空
  OPTS=(--host=aarch64-linux-android --prefix="$PREFIX")
  if grep -q -- '--cross-execute' waf-help.txt; then
    OPTS+=(--cross-execute=/bin/true)
  elif grep -q -- '--cross-compile' waf-help.txt; then
    OPTS+=(--cross-compile)
  fi
  for o in --disable-python --without-gettext --disable-shared --enable-static; do
    grep -q -- "$o" waf-help.txt && OPTS+=("$o")
  done
  rm -rf bin build 2>/dev/null || true     # 上次失败可能留下半配置
  say "   configure ${OPTS[*]}"
  # CC/CFLAGS 必须用**环境变量**传；写成 `./configure ... CFLAGS=xxx` 会被 waf 当普通参数忽略
  if ! env CC="$CC" AR="$AR" RANLIB="$RANLIB" CFLAGS="$BASE_CFLAGS" \
      ./configure "${OPTS[@]}" 2>&1 | tail -12; then
    say "   ! talloc configure 失败 → config.log 尾部："
    tail -40 bin/config.log 2>/dev/null || true
  fi
  make -j"$JOBS" 2>&1 | tail -12 || true
  make install 2>&1 | tail -6 || true
  LIB="$(find . -name 'libtalloc.a' | head -1)"
  if [ -n "$LIB" ]; then
    mkdir -p "$PREFIX/lib" "$PREFIX/include"
    cp -f "$LIB" "$PREFIX/lib/libtalloc.a"
    HDR="$(find . -name 'talloc.h' | head -1)"
    [ -n "$HDR" ] && cp -f "$HDR" "$PREFIX/include/"
    say "   ✓ libtalloc.a $(stat -c%s "$PREFIX/lib/libtalloc.a") B"
  else
    say "   ! 没产出 libtalloc.a —— 继续试 proot（它可能自带 talloc.c）"
  fi
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
  # 源码文件名各版本不同（shm.c / shm_open.c / src/*.c），直接找
  SHM_SRC="$(find . -maxdepth 2 -name '*.c' | head -1)"
  [ -n "$SHM_SRC" ] || { ls -la; die "找不到 libandroid-shmem 的 .c 源文件" 5; }
  say "   src: $SHM_SRC"
  "$CC" -O2 -fPIC -DBIONIC -c "$SHM_SRC" -o shm.o \
    -I. -I"$(dirname "$SHM_SRC")" -Iinclude 2>&1 | tail -10 \
    || die "libandroid-shmem 编译失败" 5
  mkdir -p "$PREFIX/lib" "$PREFIX/include"
  "$AR" rcs "$PREFIX/lib/libandroid-shmem.a" shm.o || die "打包 libandroid-shmem.a 失败" 5
  find . -name '*.h' -exec cp -f {} "$PREFIX/include/" \; 2>/dev/null || true
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

say "   proot src 结构（前 30 项）："
say "   $(ls src 2>/dev/null | head -30 | tr '\n' ' ')"
say "   src/Makefile 里的 talloc 引用："
grep -n 'talloc' src/Makefile 2>/dev/null | head -6 || say "   （无，可能自带 talloc.c）"
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