#!/usr/bin/env bash
# build-adb-wireless.sh —— 只生成 app/src/main/assets/adb-wireless-arm64.zip
#
# 0.5.0 单运行时不再分发 bionic 资产，但 uid 2000 的第二条来源（无线调试）
# 仍然需要 Termux 的 android-tools。这个脚本从 Termux 镜像取 deb，抽出
# bin/adb 与 KEEP 前缀的依赖库，打成 EngineManager.ensureAdbWireless() 认的布局：
#   bin/adb
#   lib/<soname>
#
# 用法：bash tools/build-adb-wireless.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS="${APP_ASSETS:-$ROOT/app/src/main/assets}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 镜像候选：清华源曾单次 136s 连接超时直接把 apk.yml 打挂（2026-11-16 43906637715），
# 所以按顺序探活，第一个能下到真 bz2 的就锁定；MIRROR=... 可强制指定。
MIRRORS_DEFAULT="https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-main https://mirrors.ustc.edu.cn/termux/apt/termux-main https://packages.termux.dev/apt/termux-main https://mirrors.bfsu.edu.cn/termux/apt/termux-main https://mirrors.nju.edu.cn/termux/apt/termux-main"
MIRROR="${MIRROR:-}"

pick_mirror() {
  [ -n "$MIRROR" ] && return 0
  local m
  for m in $MIRRORS_DEFAULT; do
    echo "  · 探测镜像 $m" >&2
    if curl -4 -fsS -L -m 90 --connect-timeout 12 -o "$WORK/Packages.bz2" \
         "$m/dists/stable/main/binary-aarch64/Packages.bz2" \
       && bzip2 -t "$WORK/Packages.bz2" 2>/dev/null; then
      MIRROR="$m"; echo "  ✅ 使用镜像 $MIRROR" >&2; return 0
    fi
    rm -f "$WORK/Packages.bz2"
  done
  echo "❌ 所有 Termux 镜像均不可用（可用 MIRROR=... 指定）" >&2
  return 1
}
mkdir -p "$ASSETS"

ensure_index() {
  [ -s "$WORK/Packages" ] && return
  pick_mirror
  [ -s "$WORK/Packages.bz2" ] || curl -4 -sS -L -m 300 --connect-timeout 15     -o "$WORK/Packages.bz2" "$MIRROR/dists/stable/main/binary-aarch64/Packages.bz2"
  bzip2 -dc "$WORK/Packages.bz2" > "$WORK/Packages"
}

deb_url() {
  ensure_index
  python3 - "$WORK/Packages" "$1" <<'PY'
import re, sys
pkg, text = sys.argv[2], open(sys.argv[1], encoding='utf-8', errors='replace').read()
for st in text.split('\n\n'):
    n = re.search(r'^Package:\s*(\S+)', st, re.M)
    f = re.search(r'^Filename:\s*(\S+)', st, re.M)
    if n and f and n.group(1) == pkg:
        print(f.group(1)); break
else:
    sys.exit(f'{pkg} not found')
PY
}

fetch_deb() {
  local pkg="$1" rel f
  rel="$(deb_url "$pkg")"
  [ -n "$rel" ] || { echo "❌ $pkg 在 Packages 里没有 Filename" >&2; exit 1; }
  f="$WORK/$(basename "$rel")"
  if [ ! -s "$f" ] || ! head -c 8 "$f" | grep -q '^!<arch>'; then
    echo "   ← $(basename "$rel")" >&2
    for i in 1 2 3; do
      curl -4 -fsS -L -m 300 --connect-timeout 15 -o "$f" "$MIRROR/$rel" || true
      head -c 8 "$f" 2>/dev/null | grep -q '^!<arch>' && break
      echo "   ↻ 重试 $i（下载内容不是 ar）" >&2
      rm -f "$f"
    done
  fi
  head -c 8 "$f" | grep -q '^!<arch>' || { echo "❌ $pkg 下载失败（不是 deb）" >&2; exit 1; }
  echo "$f"
}

echo "== adb-wireless-arm64（Termux android-tools + 9 个依赖）"
A="$WORK/adb"
mkdir -p "$A"
for pkg in android-tools libc++ abseil-cpp brotli fmt liblz4 libprotobuf pcre2 zlib zstd; do
  f="$(fetch_deb "$pkg")"
  ar p "$f" data.tar.xz | tar -xJ -C "$A"
done

PREFIX_REL="data/data/com.termux/files/usr"
[ -s "$A/$PREFIX_REL/bin/adb" ] || { echo "❌ deb 里没有 bin/adb"; exit 1; }

python3 - "$A/$PREFIX_REL" "$ASSETS/adb-wireless-arm64.zip" <<'PY'
import os, sys, zipfile
root, out = sys.argv[1], sys.argv[2]
KEEP = ('libabsl_', 'libbrotli', 'libfmt', 'libc++_shared', 'liblz4',
        'libprotobuf', 'libpcre2', 'libz.so', 'libzstd', 'libandroid-',
        'libcrypto', 'libssl')
n = 0
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    zi = zipfile.ZipInfo('bin/adb')
    zi.external_attr = 0o755 << 16
    zi.compress_type = zipfile.ZIP_DEFLATED
    with open(os.path.join(root, 'bin/adb'), 'rb') as fh:
        z.writestr(zi, fh.read())
    n += 1
    libdir = os.path.join(root, 'lib')
    for name in sorted(os.listdir(libdir)):
        p = os.path.join(libdir, name)
        if os.path.islink(p) or not os.path.isfile(p):
            continue
        if not name.startswith(KEEP):
            continue
        zi = zipfile.ZipInfo(f'lib/{name}')
        zi.external_attr = 0o644 << 16
        zi.compress_type = zipfile.ZIP_DEFLATED
        with open(p, 'rb') as fh:
            z.writestr(zi, fh.read())
        n += 1
print(f'   条目 {n} 个')
PY

python3 - "$ASSETS/adb-wireless-arm64.zip" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    names = z.namelist()
assert 'bin/adb' in names, names[:5]
print(f'   ✅ bin/adb + {len([n for n in names if n.startswith("lib/")])} 个库')
PY
ls -lh "$ASSETS/adb-wireless-arm64.zip"