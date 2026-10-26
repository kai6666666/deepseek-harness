#!/usr/bin/env bash
# build-node-runtime.sh —— 从 Termux 官方仓库重打包 assets/node-runtime.bin
#
# 产物布局必须与 TermuxBootstrap.installNodeRuntimeLocked() 对齐：
#   bin/node                        → $PREFIX/bin/node（zip 里是普通文件，权限在运行期设）
#   lib/libicuuc.so.78.3 …          → $PREFIX/lib/*
#   LINKS.txt                       → 每行「链接路径(含 lib/ 前缀) 相对目标(裸名)」
#
# 为什么不用 apt 装：构建机上没有 Termux，也不需要 rootfs；这里直接取 .deb 解包。
#
# ## 选库规则：NEEDED 闭包，不是文件名正则
#
# 第一版用 `want_lib = ^lib(icu|c-ares|ffi|sqlite3).*\.so` 白名单挑库，连错两次：
#   ① `.*\.so` 要求文件名**以 .so 结尾**，于是 `libz.so.1` / `libssl.so.3` /
#      `libcrypto.so.3` 全部被漏掉（它们以版本号结尾）；
#   ② 包名 `c-ares` 对应的库名是 `libcares.so`，正则里的 `c-ares` 永远匹配不上。
# 结果 23 个库躺在 $PREFIX/lib 里，node 一跑就是
#   CANNOT LINK EXECUTABLE … library "libz.so.1" not found
# 而构建日志「文件 N 个」看着完全正常 —— 静默漏资产。
#
# 现在改成：从 bin/node 出发递归读 `readelf -d` 的 NEEDED，逐个在解包目录里解析，
# 解析不到就**让构建失败**。谁提供的写进两张表（系统 bionic / bootstrap），
# 表外缺一个都是硬错误。
#
# ## 为什么不把 libz/libssl/libcrypto/libc++ 也塞进这个 zip
#
# 它们由 bootstrap 提供（见 TermuxBootstrap 的 KDoc）：装包顺序是 bootstrap 先、
# node-runtime 后「叠加」，再铺一份同名库等于把 apt/dpkg 依赖的 ABI 换掉。
#
# 用法：
#   ./tools/build-node-runtime.sh                 # 输出 dist/node-runtime.bin
#   MIRROR=https://packages.termux.dev/apt/termux-main ./tools/build-node-runtime.sh
set -euo pipefail

MIRROR="${MIRROR:-https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-main}"
OUT="${OUT:-dist/node-runtime.bin}"
WORK="${WORK:-/tmp/dsh-node-runtime}"
PKGS="${PKGS:-nodejs libicu c-ares libffi libsqlite}"

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
echo "== 4/5 组装 zip（bin/node + NEEDED 闭包 + LINKS.txt）"
python3 - "$OUT" "root/$PREFIX_REL" "$(cd "$(dirname "$0")" && pwd)/bootstrap-required.txt" <<'PY'
import os, re, subprocess, sys, zipfile

out, root = sys.argv[1], sys.argv[2]
libdir = os.path.join(root, 'lib')
node = os.path.join(root, 'bin', 'node')

# Android 自己提供的（bionic + 公开 NDK 库），不进包。
SYSTEM = {
    'libc.so', 'libm.so', 'libdl.so', 'liblog.so', 'libandroid.so',
    'libstdc++.so', 'libjnigraphics.so', 'libEGL.so', 'libGLESv2.so',
}
# bootstrap 提供的，按设计不覆盖（覆盖会把 apt/dpkg 的 ABI 换掉）。
# 清单在 tools/bootstrap-required.txt，与 build-bootstrap.sh / check-apk-assets.py 共用。
DEFAULT_BOOTSTRAP = {'libz.so.1', 'libssl.so.3', 'libcrypto.so.3', 'libc++_shared.so'}
BOOTSTRAP = set(DEFAULT_BOOTSTRAP)
manifest = sys.argv[3] if len(sys.argv) > 3 else ''
if manifest and os.path.isfile(manifest):
    BOOTSTRAP = {l.strip() for l in open(manifest, encoding='utf-8')
                 if l.strip() and not l.startswith('#')}



def needed(path):
    r = subprocess.run(['readelf', '-d', path], capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f'❌ readelf 失败：{path}\n{r.stderr.strip()[:400]}')
    return re.findall(r'\(NEEDED\)\s+Shared library: \[([^\]]+)\]', r.stdout)


avail = {}
for n in sorted(os.listdir(libdir)):
    p = os.path.join(libdir, n)
    if os.path.islink(p) or os.path.isfile(p):
        avail[n] = p

seen = set()
reals = {}      # 实体文件 basename → 绝对路径
missing = []    # (引用者, soname)
queue = [(node, 'bin/node')]

while queue:
    path, arc = queue.pop()
    for soname in needed(path):
        if soname in seen:
            continue
        seen.add(soname)
        if soname in SYSTEM or soname in BOOTSTRAP:
            continue
        p = avail.get(soname)
        if p is None:
            missing.append((arc, soname))
            continue
        cur, hops = p, 0
        while os.path.islink(cur):
            hops += 1
            if hops > 8:
                sys.exit(f'❌ 软链成环：{soname}')
            cur = os.path.join(os.path.dirname(cur), os.readlink(cur))
        base = os.path.basename(cur)
        if not os.path.isfile(cur):
            missing.append((arc, soname))
            continue
        if base not in reals:
            reals[base] = cur
            queue.append((cur, f'lib/{base}'))

if missing:
    for arc, s in missing:
        print(f'❌ {arc} 需要 {s}，解包出的 lib 里没有', file=sys.stderr)
    sys.exit('❌ 依赖闭包不完整：先把缺的包加进 PKGS（这是硬失败，不许出半残包）')

# 实体文件挑完，再把指向它们的软链补齐（zip 不存 symlink，运行期按 LINKS.txt 重建）
links = []
for n, p in sorted(avail.items()):
    if os.path.islink(p):
        tgt = os.path.basename(os.readlink(p))
        if tgt in reals:
            links.append(f'lib/{n} {tgt}')

with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    zi = zipfile.ZipInfo('bin/node')
    zi.external_attr = 0o755 << 16
    zi.compress_type = zipfile.ZIP_DEFLATED
    with open(node, 'rb') as f:
        z.writestr(zi, f.read())
    for base, src in sorted(reals.items()):
        zi = zipfile.ZipInfo(f'lib/{base}')
        zi.external_attr = 0o644 << 16
        zi.compress_type = zipfile.ZIP_DEFLATED
        with open(src, 'rb') as f:
            z.writestr(zi, f.read())
    z.writestr('LINKS.txt', ''.join(l + '\n' for l in links),
               compress_type=zipfile.ZIP_DEFLATED)

print(f'   实体库 {len(reals)} 个，软链 {len(links)} 条')
print('   由 bootstrap 提供（不进包）：' + ', '.join(sorted(BOOTSTRAP)))
print('   由 Android 提供（不进包）：' + ', '.join(sorted(SYSTEM)))
print('   库清单：' + ', '.join(sorted(reals)))
PY

echo "== 5/5 体检"
python3 - "$OUT" <<'PY'
import zipfile, sys
p = sys.argv[1]
with zipfile.ZipFile(p) as z:
    names = z.namelist()
    assert 'bin/node' in names, '缺少 bin/node'
    libs = [n for n in names if n.startswith('lib/')]
    assert len(libs) >= 5, f'库太少（{len(libs)}），几乎肯定漏了依赖'
    assert 'lib/libcares.so' in names, '缺少 lib/libcares.so（node 的 DT_NEEDED 里有它）'
    assert any(n.startswith('lib/libicu') for n in libs), '缺少 libicu*'
    txt = z.read('LINKS.txt').decode()
    print(f'   条目 {len(names)}：bin/node + {len(libs)} 个库 + LINKS.txt({len(txt.splitlines())} 条软链)')
    print('   库：' + ', '.join(sorted(x[4:] for x in libs)))
PY
ls -lh "$OUT"
echo "✅ 完成：$OUT"