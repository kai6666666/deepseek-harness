#!/usr/bin/env bash
# build-extra-native.sh —— 补齐三个「官方没有 android 包」的资产
#
#   1. sharp-wasm32.zip            @img/sharp-wasm32 + @emnapi/runtime（npm）
#   2. ripgrep-android-arm64.zip   Termux ripgrep 的 bin/rg + 合成 package.json
#   3. adb-wireless-arm64.zip      Termux android-tools 的 bin/adb + 全部依赖库
#
# 条目布局与 EngineManager 的 ensureSharp / ensureRipgrep / ensureAdbWireless 一致：
#   sharp : 相对 node_modules（@img/sharp-wasm32/lib/…、@emnapi/runtime/…）
#   rg    : @vscode/ripgrep-android-arm64/bin/rg
#   adb   : bin/adb + lib/*.so（解到 filesDir/adbwire/）
#
# 用法：./tools/build-extra-native.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS="${APP_ASSETS:-$ROOT/app/src/main/assets}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

MIRROR="${MIRROR:-https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-main}"
SHARP_VERSION="${SHARP_VERSION:-0.35.5}"
mkdir -p "$ASSETS"

ensure_index() {
  [ -s "$WORK/Packages" ] && return
  curl -4 -sS -L -m 300 -o "$WORK/Packages.bz2" "$MIRROR/dists/stable/main/binary-aarch64/Packages.bz2"
  bunzip2 -kc "$WORK/Packages.bz2" > "$WORK/Packages"
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

# ⚠️ 进度行必须走 stderr：这个函数用 $(...) 捕获返回值，
#    往 stdout 多写一行就会把路径拼坏（v1 就是这么坏的）。
fetch_deb() {
  local pkg="$1" rel f
  rel="$(deb_url "$pkg")"
  f="$WORK/$(basename "$rel")"
  # -f：HTTP 4xx/5xx 不当成文件内容；下载后再校验 ar 魔数。
  # 踩过：镜像偶尔返回 HTML 错误页，文件被缓存后 tar 报「File format not recognized」，
  # 看起来像“包坏了”，实际是下载的错。
  if [ ! -s "$f" ] || ! head -c 8 "$f" | grep -q '^!<arch>'; then
    echo "   ← $(basename "$rel")" >&2
    for i in 1 2 3; do
      curl -4 -fsS -L -m 600 -o "$f" "$MIRROR/$rel" || true
      head -c 8 "$f" 2>/dev/null | grep -q '^!<arch>' && break
      echo "   ↻ 重试 $i（下载内容不是 ar）" >&2
      rm -f "$f"
    done
  fi
  head -c 8 "$f" | grep -q '^!<arch>' || { echo "❌ $pkg 下载失败（不是 deb）" >&2; exit 1; }
  echo "$f"
}

# ---------- 1. sharp wasm32 ----------
echo "== 1/3 sharp-wasm32（npm @img/sharp-wasm32@$SHARP_VERSION）"
S="$WORK/sharp"
mkdir -p "$S"
( cd "$S" && npm init -y >/dev/null 2>&1 \
  && npm i --ignore-scripts --no-audit --no-fund "@img/sharp-wasm32@$SHARP_VERSION" >/dev/null 2>&1 )
python3 - "$S/node_modules" "$ASSETS/sharp-wasm32.zip" <<'PY'
import os, sys, zipfile

nm, out = sys.argv[1], sys.argv[2]
n = 0
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for r in ('@img/sharp-wasm32', '@emnapi'):
        base = os.path.join(nm, r)
        if not os.path.isdir(base):
            continue
        for dirpath, _, files in os.walk(base):
            for f in files:
                p = os.path.join(dirpath, f)
                rel = os.path.relpath(p, nm).replace(os.sep, '/')
                zi = zipfile.ZipInfo(rel)
                zi.external_attr = 0o644 << 16
                zi.compress_type = zipfile.ZIP_DEFLATED
                with open(p, 'rb') as fh:
                    z.writestr(zi, fh.read())
                n += 1
print(f'   条目 {n} 个')
PY
python3 - "$ASSETS/sharp-wasm32.zip" "$SHARP_VERSION" <<'PY'
import sys, zipfile
need = f'@img/sharp-wasm32/lib/sharp-wasm32-{sys.argv[2]}.node.wasm'
with zipfile.ZipFile(sys.argv[1]) as z:
    names = z.namelist()
assert need in names, f'缺少 {need}；现有 {names[:5]}'
print(f'   ✅ {need}')
PY
ls -lh "$ASSETS/sharp-wasm32.zip"

# ---------- 2. ripgrep ----------
echo "== 2/3 ripgrep-android-arm64（Termux ripgrep）"
D="$WORK/rg"
mkdir -p "$D"
f="$(fetch_deb ripgrep)"
ar p "$f" data.tar.xz | tar -xJ -C "$D"
RG="$D/data/data/com.termux/files/usr/bin/rg"
[ -s "$RG" ] || { echo "❌ deb 里没有 bin/rg"; exit 1; }
python3 - "$RG" "$ASSETS/ripgrep-android-arm64.zip" <<'PY'
import json, sys, zipfile

src, out = sys.argv[1], sys.argv[2]
pkg = {'name': '@vscode/ripgrep-android-arm64', 'version': '14.1.1',
       'description': 'ripgrep for android-arm64 (repacked from Termux)',
       'bin': {'rg': 'bin/rg'}, 'license': 'MIT'}
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    zi = zipfile.ZipInfo('@vscode/ripgrep-android-arm64/bin/rg')
    zi.external_attr = 0o755 << 16
    zi.compress_type = zipfile.ZIP_DEFLATED
    with open(src, 'rb') as fh:
        z.writestr(zi, fh.read())
    z.writestr('@vscode/ripgrep-android-arm64/package.json',
               json.dumps(pkg, ensure_ascii=False, indent=2))
print('   @vscode/ripgrep-android-arm64/bin/rg')
PY
ls -lh "$ASSETS/ripgrep-android-arm64.zip"

# ---------- 3. adb ----------
# android-tools 的 Depends 是 9 个包；漏一个就在真机上 'cannot locate symbol'。
echo "== 3/3 adb-wireless-arm64（Termux android-tools + 9 个依赖）"
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

echo "== 完成"
