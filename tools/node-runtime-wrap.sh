#!/usr/bin/env bash
# node-runtime-wrap.sh -- 给 node-runtime.bin 注入「node 启动包装」
#
# 为什么需要（真机实测，2026-11）：
#   1) App 用 `node bin.js ... --no-open` 起引擎，而 --no-open 同时抑制了 URL 打印；
#      App 的就绪判据是 stdout 里那行 `dsh web: http://127.0.0.1:.../?token=...`
#      -> 永远等不到 -> 28s 后判失败并 kill 掉活着的引擎。
#   2) node 的 RUNPATH 被 patchElfInPlace() 等长重写成 /data/data/com.dsh.android//usr/lib，
#      而 App 从不创建 data 根下的 usr 符号链接 -> CANNOT LINK EXECUTABLE ... libz.so.1 not found。
#
# 两条都能在「node 入口」闭环，不需要改 Kotlin：
#   - 包装脚本吃掉 --no-open，让引擎回到打印 URL 的路径；
#   - 包装脚本启动时补 usr / home 两个符号链接（App 自己的 data 根，进程有权限）。
#
# 用法：bash tools/node-runtime-wrap.sh [app/src/main/assets/node-runtime.bin]
set -euo pipefail

IN="${1:-app/src/main/assets/node-runtime.bin}"
[ -s "$IN" ] || { echo "[ERR] missing $IN"; exit 1; }

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

unzip -q "$IN" -d "$T"
[ -f "$T/bin/node" ] || { echo "[ERR] no bin/node in node-runtime.bin"; exit 1; }
if [ -f "$T/bin/node.real" ]; then
  echo "already wrapped, skip"
  exit 0
fi

mv "$T/bin/node" "$T/bin/node.real"

cat > "$T/bin/node" <<'SH'
#!/system/bin/sh
# DSH Android -- node entry wrapper (injected by tools/node-runtime-wrap.sh)
# __DSH_NODE_WRAP__ v1
BASE=/data/data/com.dsh.android
SELF="$0"
REAL="$SELF.real"
[ -x "$REAL" ] || chmod 755 "$REAL" 2>/dev/null

if [ -d "$BASE/files/termux" ]; then
  [ -e "$BASE/usr" ] || ln -sfn "$BASE/files/termux/usr" "$BASE/usr" 2>/dev/null
  [ -e "$BASE/home" ] || ln -sfn "$BASE/files/termux/home" "$BASE/home" 2>/dev/null
fi

HAS=0
for a in "$@"; do
  [ "$a" = "--no-open" ] && HAS=1
done
if [ "$HAS" = "0" ]; then
  exec "$REAL" "$@"
fi

ARGS=""
for a in "$@"; do
  [ "$a" = "--no-open" ] && continue
  ARGS="$ARGS $a"
done
exec "$REAL" $ARGS
SH

chmod 755 "$T/bin/node" "$T/bin/node.real"

python3 - "$T" "$IN" <<'PY'
import os, sys, zipfile

root, out = sys.argv[1], sys.argv[2]
tmp = out + '.tmp'
with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for dirpath, dirnames, files in os.walk(root):
        for f in files:
            p = os.path.join(dirpath, f)
            rel = os.path.relpath(p, root).replace(os.sep, '/')
            zi = zipfile.ZipInfo(rel)
            zi.external_attr = (0o755 if rel.startswith('bin/') else 0o644) << 16
            zi.compress_type = zipfile.ZIP_DEFLATED
            with open(p, 'rb') as fh:
                z.writestr(zi, fh.read())
os.replace(tmp, out)
print('repacked', out, os.path.getsize(out), 'bytes')
PY

unzip -l "$IN" | grep -q ' bin/node$' || { echo "[ERR] missing bin/node"; exit 1; }
unzip -l "$IN" | grep -q ' bin/node.real$' || { echo "[ERR] missing bin/node.real"; exit 1; }
unzip -p "$IN" bin/node | grep -q '__DSH_NODE_WRAP__' || { echo "[ERR] wrapper not packed"; exit 1; }
echo "[OK] node-runtime wrapped: bin/node (wrapper) + bin/node.real"

# build stamp: keystore-stable
