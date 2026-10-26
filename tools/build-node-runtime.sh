#!/usr/bin/env bash
# build-node-runtime.sh —— 从 Termux 官方仓库重打包 assets/node-runtime.bin
#
# 产物布局必须与 TermuxBootstrap.installNodeRuntimeLocked() 对齐：
#   bin/node                        → $PREFIX/bin/node（zip 里是普通文件，权限在运行期设）
#   lib/libicuuc.so.78.3 …          → $PREFIX/lib/*
#   LINKS.txt                       → 每行「链接路径(含 lib/ 前缀) 相对目标(裸名)」
#
# 为什么不用 apt 装：构建机上没有 Termux，也不需要 rootfs；这里直接取 .deb 解包。
# 为什么只挑 4 个库：libc++_shared / libcrypto / libssl / libz 由 bootstrap 提供，
#   用同一时刻的 deb 覆盖会把包管理器的 ABI 换掉（见 installNodeRuntime 的 KDoc）。
#
# 用法：
#   ./tools/build-node-runtime.sh                 # 输出 dist/node-runtime.bin
#   MIRROR=https://packages.termux.dev/apt/termux-main ./tools/build-node-runtime.sh
set -euo pipefail

MIRROR="${MIRROR:-https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-main}"
OUT="${OUT:-dist/node-runtime.bin}"
WORK="${WORK:-/tmp/dsh-node-runtime}"
PKGS="${PKGS:-nodejs libicu c-ares libffi libsqlite zlib openssl libc++}"

mkdir -p "$WORK" "$(dirname "$OUT")"
cd "$WORK"

echo "== 1/5 索引：$MIRROR"
[ -s Packages.bz2 ] || curl -4 -sS -L -m 300 -o Packages.bz2 "$MIRROR/dists/stable/main/binary-aarch64/Packages.bz2"
[ -s Packages ] || bunzip2 -kc Packages.bz2 > Packages
echo "    $(grep -c '^Package:' Packages) 个包"

echo "== 2/5 选包：$PKGS"
mapfile -t URLS < <(python3 - Packages "$PKGS" <<'PY'
import sys, re
pkgs = set(sys.argv[2].split())
text = open(sys.argv[1], encoding='utf-8', errors='replace').read()
found = {}
for stanza in text.split('\n\n'):
    name = re.search(r'^Package:\s*(\S+)', stanza, re.M)
    fn = re.search(r'^Filename:\s*(\S+)', stanza, re.M)
    ver = re.search(r'^Version:\s*(\S+)', stanza, re.M)
    if name and fn and name.group(1) in pkgs:
        found[name.group(1)] = (fn.group(1), ver.group(1) if ver else '?')
for p in sorted(pkgs):
    if p not in found:
        print(f'MISSING {p}', file=sys.stderr)
        continue
    print(found[p][0])
PY
)
if [ "${#URLS[@]}" -eq 0 ]; then echo "❌ 一个包都没匹配到"; exit 1; fi

echo "== 3/5 下载 + 解包"
rm -rf root && mkdir -p root
for rel in "${URLS[@]}"; do
  f="$(basename "$rel")"
  [ -s "$f" ] || { echo "   ← $f"; curl -4 -sS -L -m 600 -o "$f" "$MIRROR/$rel"; }
  echo "   - $f $(du -h "$f" | cut -f1)"
  ar p "$f" data.tar.xz | tar -xJ -C root
done

PREFIX_REL="data/data/com.termux/files/usr"
if [ ! -f "root/$PREFIX_REL/bin/node" ]; then
  echo "❌ 解包后没有 bin/node"; ls -R root | head -20; exit 1
fi

echo "== 4/5 组装 zip（bin/node + 4 组库 + LINKS.txt）"
python3 - "$OUT" "root/$PREFIX_REL" "$PKGS" <<'PY'
import os, sys, zipfile, re, tarfile, subprocess, glob

out, root, pkgs = sys.argv[1], sys.argv[2], sys.argv[3].split()
want_lib = re.compile(r'^lib(icu|icudata|icui18n|icuuc|icuio|c-ares|ffi|sqlite3|crypto|ssl|z\.so|c\+\+_shared|android-|log|dl).*\.so')
entries = {}

node = os.path.join(root, 'bin', 'node')
entries['bin/node'] = node

libdir = os.path.join(root, 'lib')
links = []
for name in sorted(os.listdir(libdir)):
    p = os.path.join(libdir, name)
    if not os.path.isfile(p) and not os.path.islink(p):
        continue
    if not want_lib.match(name):
        continue
    if os.path.islink(p):
        target = os.readlink(p)
        # LINKS.txt：第一列含 lib/ 前缀，第二列是相对目标（裸名）
        links.append(f'lib/{name} {os.path.basename(target)}')
    else:
        entries[f'lib/{name}'] = p

with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for arc, src in entries.items():
        zi = zipfile.ZipInfo(arc)
        zi.external_attr = (0o755 if arc.startswith('bin/') else 0o644) << 16
        zi.compress_type = zipfile.ZIP_DEFLATED
        with open(src, 'rb') as f:
            z.writestr(zi, f.read())
    z.writestr('LINKS.txt', '\n'.join(links) + ('\n' if links else ''),
               compress_type=zipfile.ZIP_DEFLATED)

print(f'   文件 {len(entries)} 个，软链 {len(links)} 条')
PY

echo "== 5/5 体检"
python3 - "$OUT" <<'PY'
import zipfile, sys
p = sys.argv[1]
with zipfile.ZipFile(p) as z:
    names = z.namelist()
    assert 'bin/node' in names, '缺少 bin/node'
    libs = [n for n in names if n.startswith('lib/')]
    print(f'   条目 {len(names)}：bin/node + {len(libs)} 个库 + LINKS.txt')
    print('   库样例：' + ', '.join(libs[:4]))
PY
ls -lh "$OUT"
echo "✅ 完成：$OUT"