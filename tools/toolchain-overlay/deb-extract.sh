#!/usr/bin/env bash
# deb-extract.sh —— 从 .deb 里挖出二进制，交给 Alpine + gcompat 直接跑（不装 Ubuntu）
#
# 什么时候用：
#   工具是「单文件 CLI」，官方只发 .deb（gh / fzf / 各种 vendor 工具）。
#   比 overlay 省 300 MB，比现编快；失败特征也很清晰（ldd 报 missing → apk add gcompat）。
#
# 用法：
#   bash deb-extract.sh --pkg hello --dist noble --component main
#   bash deb-extract.sh --pkg gh --dist noble --component main --bin gh
#   bash deb-extract.sh --url https://.../gh_2.40.1_linux_arm64.deb --bin gh
#   bash deb-extract.sh --file ./foo.deb --bin foo --with-lib
#   bash deb-extract.sh --list
#
# 退出码：0 成功；2 参数错；3 下载/解析失败；4 解包失败；5 找不到二进制
set -u

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DEB_ROOT="${DSH_DEB_ROOT:-$DSH_HOME/toolchain/deb}"
MIRROR="${DSH_DEB_MIRROR:-http://ports.ubuntu.com/ubuntu-ports}"
DIST="noble"
COMPONENT="main"
ARCH="arm64"
PKG=""
BIN=""
URL=""
FILE=""
WITH_LIB=0
MODE="extract"

while [ $# -gt 0 ]; do
  case "$1" in
    --pkg) PKG="$2"; shift 2 ;;
    --bin) BIN="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --file) FILE="$2"; shift 2 ;;
    --dist) DIST="$2"; shift 2 ;;
    --component) COMPONENT="$2"; shift 2 ;;
    --arch) ARCH="$2"; shift 2 ;;
    --mirror) MIRROR="$2"; shift 2 ;;
    --with-lib) WITH_LIB=1; shift ;;
    --list) MODE="list"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) printf 'unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

if [ "$MODE" = "list" ]; then
  printf 'deb 层根: %s\n' "$DEB_ROOT"
  [ -d "$DEB_ROOT/pkgs" ] || { printf '  （空）\n'; exit 0; }
  for d in "$DEB_ROOT"/pkgs/*; do
    [ -d "$d" ] || continue
    printf '  %-24s %s\n' "$(basename "$d")" "$(du -sm "$d" | cut -f1) MB"
  done
  printf '\nwrapper:\n'
  ls -1 "$DEB_ROOT"/bin 2>/dev/null | sed 's/^/  /' || printf '  （无）\n'
  exit 0
fi

command -v python3 >/dev/null 2>&1 || { printf '✗ 缺 python3\n' >&2; exit 12; }
command -v tar >/dev/null 2>&1 || { printf '✗ 缺 tar\n' >&2; exit 12; }
mkdir -p "$DEB_ROOT/pkgs" "$DEB_ROOT/bin"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/deb.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# ── 1) 定位 .deb ─────────────────────────────────────────────────────
if [ -z "$FILE" ] && [ -z "$URL" ]; then
  [ -n "$PKG" ] || { printf '✗ 需要 --pkg / --url / --file 之一\n' >&2; exit 2; }
  printf '== 1/4 查 APT 索引: %s (%s/%s, %s)\n' "$PKG" "$DIST" "$COMPONENT" "$ARCH"
  FILENAME=""
  # 去重：--component main 时不要把 main 再查两遍
  for comp in $(printf '%s\n' "$COMPONENT" main universe multiverse | awk '!seen[$0]++'); do
    FN="$(curl -fsSL --max-time 60 "$MIRROR/dists/$DIST/$comp/binary-$ARCH/Packages.gz" 2>/dev/null \
      | gzip -dc 2>/dev/null \
      | PKG="$PKG" python3 -c '
import os,sys
want=os.environ["PKG"]; cur=None
for line in sys.stdin:
    line=line.rstrip("\n")
    if line.startswith("Package: "):
        cur=line[9:].strip()
    elif line.startswith("Filename: ") and cur==want:
        print(line[10:].strip()); break
')"
    if [ -n "$FN" ]; then FILENAME="$FN"; break; fi
  done
  [ -n "$FILENAME" ] || { printf '✗ 索引里没有 %s（试 --component universe）\n' "$PKG" >&2; exit 3; }
  URL="$MIRROR/$FILENAME"
  printf '   → %s\n' "$URL"
fi

if [ -z "$FILE" ]; then
  printf '== 2/4 下载\n'
  FILE="$WORK/pkg.deb"
  curl -fL --retry 3 --connect-timeout 20 -o "$FILE" "$URL" || { printf '✗ 下载失败\n' >&2; exit 3; }
  printf '   %s\n' "$(du -h "$FILE" | cut -f1)"
else
  printf '== 2/4 用本地文件 %s\n' "$FILE"
fi

# ── 2) ar 拆包（纯 python，不依赖 binutils） ──────────────────────────
printf '== 3/4 解 ar / tar\n'
MEMBER="$(FILE="$FILE" OUT="$WORK" python3 -c '
import os,sys
data=open(os.environ["FILE"],"rb").read()
if data[:8] != b"!<arch>\n": sys.exit("不是 ar 归档")
i=8; got=None
while i+60 <= len(data):
    h=data[i:i+60]; i+=60
    name=h[0:16].decode("utf-8","replace").strip().rstrip("/")
    try: size=int(h[48:58].decode().strip())
    except ValueError: break
    body=data[i:i+size]
    i += size + (1 if size % 2 else 0)
    if name.startswith("data.tar"):
        p=os.path.join(os.environ["OUT"], name)
        open(p,"wb").write(body); got=name
print(got or "")
')"
[ -n "$MEMBER" ] || { printf '✗ deb 里没有 data.tar.*\n' >&2; exit 4; }
printf '   %s\n' "$MEMBER"

DEST="$DEB_ROOT/pkgs/${PKG:-$(basename "${FILE%.deb}")}"
rm -rf "$DEST"; mkdir -p "$DEST"
case "$MEMBER" in
  *.xz)  tar -xJf "$WORK/$MEMBER" -C "$DEST" --no-same-owner 2>/dev/null ;;
  *.gz)  tar -xzf "$WORK/$MEMBER" -C "$DEST" --no-same-owner 2>/dev/null ;;
  *.bz2) tar -xjf "$WORK/$MEMBER" -C "$DEST" --no-same-owner 2>/dev/null ;;
  *.zst)
    # Ubuntu 21.10+ 的 .deb 默认用 zstd 压缩，这条分支是常态而不是例外
    if command -v zstd >/dev/null 2>&1; then
      zstd -dc "$WORK/$MEMBER" | tar -xf - -C "$DEST" --no-same-owner 2>/dev/null
    elif command -v unzstd >/dev/null 2>&1; then
      unzstd -c "$WORK/$MEMBER" | tar -xf - -C "$DEST" --no-same-owner 2>/dev/null
    elif python3 -c 'import zstandard' 2>/dev/null; then
      python3 -c '
import sys, zstandard
src, dst = sys.argv[1], sys.argv[2]
r = zstandard.ZstdDecompressor().stream_reader(open(src, "rb"))
open(dst, "wb").write(r.read())
' "$WORK/$MEMBER" "$WORK/data.tar" \
        && tar -xf "$WORK/data.tar" -C "$DEST" --no-same-owner 2>/dev/null
    else
      printf '✗ data.tar.zst 需要 zstd，宿主没有：\n' >&2
      printf '   Alpine : apk add --no-cache zstd\n' >&2
      printf '   overlay: bash tc-run.sh -- apt-get install -y zstd\n' >&2
      printf '   或      : pip3 install --user zstandard（脚本会自动用 python 兜底）\n' >&2
      exit 4
    fi
    ;;
  *) printf '✗ 不认识的压缩: %s\n' "$MEMBER" >&2; exit 4 ;;
esac
[ -d "$DEST/usr" ] || [ -d "$DEST/bin" ] || { printf '✗ 解包后没有 usr/ 或 bin/\n' >&2; exit 4; }

# 体积控制：不保留 man/doc/locale
rm -rf "$DEST/usr/share/man" "$DEST/usr/share/doc" "$DEST/usr/share/locale" "$DEST/usr/share/info" 2>/dev/null || true
[ "$WITH_LIB" = "1" ] || rm -rf "$DEST/usr/lib" "$DEST/usr/libexec" 2>/dev/null || true

# ── 3) 找二进制 + 生成 wrapper ───────────────────────────────────────
printf '== 4/4 生成 wrapper\n'
if [ -z "$BIN" ]; then
  CAND="$(cd "$DEST" && ls -1 usr/bin usr/sbin bin sbin 2>/dev/null | grep -v ':$' | grep -v '^$' | head -1)"
  [ -n "$CAND" ] || { printf '✗ 包里没有可执行文件（用 --bin 指定）\n' >&2; exit 5; }
  BIN="$CAND"
fi
REAL=""
for p in "usr/bin/$BIN" "usr/sbin/$BIN" "bin/$BIN" "sbin/$BIN"; do
  [ -f "$DEST/$p" ] && { REAL="/opt/deb/pkgs/$(basename "$DEST")/$p"; break; }
done
[ -n "$REAL" ] || { printf '✗ 包里找不到 %s（可 ls %s/usr/bin）\n' "$BIN" "$DEST" >&2; exit 5; }

DSH_HOME="$DSH_HOME" DEB_ROOT="$DEB_ROOT" BIN="$BIN" REAL="$REAL" PKGNAME="$(basename "$DEST")" \
python3 -c '
import os
home=os.environ["DSH_HOME"]; deb=os.environ["DEB_ROOT"]
bin_=os.environ["BIN"]; real=os.environ["REAL"]; pkg=os.environ["PKGNAME"]
w=f"""#!/usr/bin/env bash
# 由 DSHAPP tools/toolchain-overlay/deb-extract.sh 生成：{pkg} / {bin_}
set -u
DSH_HOME="${{DSH_HOME:-{home}}}"
PROOT="${{DSH_PROOT:-$DSH_HOME/bin/libproot.so}}"
LOADER="${{DSH_PROOT_LOADER:-$DSH_HOME/bin/proot-loader.so}}"
ALPINE="${{DSH_ALPINE_ROOTFS:-$DSH_HOME/alpine}}"
[ -x "$PROOT" ] || {{ echo "✗ 缺 proot: $PROOT" >&2; exit 12; }}
[ -d "$ALPINE" ] || {{ echo "✗ 缺 Alpine rootfs: $ALPINE" >&2; exit 12; }}
export PROOT_NO_SECCOMP=1 PROOT_TMP_DIR="${{TMPDIR:-/tmp}}" PROOT_LOADER="$LOADER"
unset LD_PRELOAD
exec "$PROOT" -r "$ALPINE" -0 -w / \\
  -b /dev:/dev -b /proc:/proc \\
  -b {deb}:/opt/deb \\
  --kill-on-exit \\
  /usr/bin/env -i HOME=/root LANG=C.UTF-8 PATH=/usr/bin:/bin \\
    LD_LIBRARY_PATH=/opt/deb/pkgs/{pkg}/usr/lib:/opt/deb/pkgs/{pkg}/usr/lib/aarch64-linux-gnu:{deb}/lib \\
    {real} "$@"
"""
open(os.path.join(deb,"bin",bin_),"w").write(w)
os.chmod(os.path.join(deb,"bin",bin_),0o755)
print(os.path.join(deb,"bin",bin_))
'
WRAP="$DEB_ROOT/bin/$BIN"
printf '   ✓ %s → %s\n' "$WRAP" "$REAL"
printf '   %s MB\n' "$(du -sm "$DEST" | cut -f1)"

printf '\n下一步：\n'
printf '  1) Alpine 里补兼容层: bash ../alpine-runtime/proot-launch.sh -- apk add --no-cache gcompat libstdc++\n'
printf '  2) 直接跑: %s --version\n' "$WRAP"
printf '  3) 若报 "not found" 但文件在: 说明缺 glibc 符号 → 改用 overlay（install-overlay.sh）\n'