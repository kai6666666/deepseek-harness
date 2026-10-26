#!/usr/bin/env bash
# build-bootstrap.sh —— 取 Termux 官方 bootstrap，作为 assets/bootstrap-aarch64.zip
#
# ## 为什么这一步必须有
#
# TermuxBootstrap.installLocked() 干的第一件事就是：
#   context.assets.open("bootstrap-aarch64.zip")
# 这个 zip 就是**整个 Termux 前缀**：bash / apt / dpkg / coreutils / termux-exec，
# 以及 libc++_shared / libz / libssl / libcrypto 这几份运行库。
#
# CI 的 28 项资产清单里从来没有它，于是真机上出现两条看着无关的日志：
#   #9  Termux 引导失败 java.io.FileNotFoundException: bootstrap-aarch64.zip
#   #27 node --version 校验失败 … library "libz.so.1" not found
# 其实是同一个洞：前缀没铺，库自然全缺；而 node-runtime 按设计不重复打包这几份库，
# 于是链接器连 libz 都找不到。构建日志里「28/28 齐备」的包，在设备上是残的。
#
# ## 校验（缺一项就失败，不许出包）
#   1. zip 能打开，条目 > 1000（完整 bootstrap 有 1800+ 项）
#   2. 有 SYMLINKS.txt（zip 不存 symlink，靠它重建 libz.so.1 这类链接）
#   3. tools/bootstrap-required.txt 里每个 soname 都能提供
#
# ## 用法
#   ./tools/build-bootstrap.sh
#   BOOTSTRAP_TAG='bootstrap-2026.10.04-r1+apt.android-7' ./tools/build-bootstrap.sh
#   BOOTSTRAP_URL=https://自建镜像/bootstrap-aarch64.zip ./tools/build-bootstrap.sh
set -euo pipefail

# 钉死版本：bootstrap 决定的是「哪些库在场」，跟着 latest 漂移等于每次出包都换底座。
# 升级姿势：改这里 → 跑一次 CI → 真机看 node --version 与四个 ensure 是否就位。
TAG="${BOOTSTRAP_TAG:-bootstrap-2026.10.25-r1+apt.android-7}"
# 标签里的 + 必须转义：GitHub 的发布下载路径按 %2B 解析，直接写 + 会 404。
ENC=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$TAG")
URL="${BOOTSTRAP_URL:-https://github.com/termux/termux-packages/releases/download/$ENC/bootstrap-aarch64.zip}"
OUT="${OUT:-dist/bootstrap-aarch64.zip}"
WORK="${WORK:-/tmp/dsh-bootstrap}"
REQ="$(cd "$(dirname "$0")" && pwd)/bootstrap-required.txt"

mkdir -p "$WORK" "$(dirname "$OUT")"

echo "== 1/2 下载：$URL"
if [ ! -s "$WORK/bootstrap-aarch64.zip" ]; then
  for i in 1 2 3; do
    if curl -4 -fSL --retry 2 -m 900 -o "$WORK/bootstrap-aarch64.zip" "$URL"; then break; fi
    echo "   第 $i 次失败，重试…"
    sleep 3
  done
fi
[ -s "$WORK/bootstrap-aarch64.zip" ] || { echo "❌ 下载失败：$URL"; exit 1; }
ls -lh "$WORK/bootstrap-aarch64.zip"

echo "== 2/2 体检"
python3 - "$WORK/bootstrap-aarch64.zip" "$REQ" <<'PY'
import os, sys, zipfile

p, req = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(p) as z:
    names = z.namelist()
    if len(names) < 1000:
        sys.exit(f'❌ 条目只有 {len(names)}，不像完整 bootstrap（预期 1800+）')
    if 'SYMLINKS.txt' not in names:
        sys.exit('❌ 没有 SYMLINKS.txt：libz.so.1 这类软链不会被重建，node 照样起不来')
    sym = z.read('SYMLINKS.txt').decode('utf-8', 'replace')

# 实体文件 + SYMLINKS.txt 里会建出来的链接名，合起来就是「这个 bootstrap 能提供什么」
provided = {n[4:] for n in names if n.startswith('lib/')}
for line in sym.splitlines():
    if '←' not in line:
        continue
    right = line.split('←', 1)[1].strip().replace('./', '').strip('/')
    provided.add(os.path.basename(right))

want = [l.strip() for l in open(req, encoding='utf-8')
        if l.strip() and not l.startswith('#')]
missing = [w for w in want if w not in provided]
if missing:
    sys.exit('❌ bootstrap 缺必需 soname：' + ', '.join(missing))

print(f'   条目 {len(names)}，SYMLINKS {len(sym.splitlines())} 行')
print('   必需 soname 全部就位：' + ', '.join(want))
PY

cp "$WORK/bootstrap-aarch64.zip" "$OUT"
sha256sum "$OUT"
echo "✅ 完成：$OUT"