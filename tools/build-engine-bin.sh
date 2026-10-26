#!/usr/bin/env bash
# build-engine-bin.sh —— 把指定版本的 @deepseek-ai/dsh 打成 APK 资产 engine.bin
#
# 三步：装 → 裁剪 → 压缩。rc.3 实测：859 MB → 698 MB → 159 MB；
# 再删 3 个重包（PRUNE_LIST）→ 488 MB → 96 MB。
#
# 用法：VER=0.2.1-rc.3 ./tools/build-engine-bin.sh
#       SKIP_INSTALL=1 VER=... WORK=/opt/dsh-rc3 ./tools/build-engine-bin.sh

set -euo pipefail
VER="${VER:?用法: VER=0.2.1-rc.3 $0}"
OUT="${OUT:-dist/engine.bin}"
WORK="${WORK:-/tmp/dsh-engine-$VER}"
REGISTRY="${REGISTRY:-https://registry.npmmirror.com}"

if [ "${SKIP_INSTALL:-0}" = "1" ] && [ -d "$WORK/node_modules/@deepseek-ai/dsh" ]; then
  echo "== 1/4 复用 $WORK"
  cd "$WORK"
else
  echo "== 1/4 安装 @deepseek-ai/dsh@$VER → $WORK"
  rm -rf "$WORK" && mkdir -p "$WORK" && cd "$WORK"
  npm init -y >/dev/null
  npm i "@deepseek-ai/dsh@$VER" --no-audit --no-fund --ignore-scripts --registry="$REGISTRY"
fi

echo "== 2/4 裁剪"
find node_modules -type d -name prebuilds -print0 2>/dev/null | while IFS= read -r -d '' d; do
  find "$d" -mindepth 1 -maxdepth 1 -type d ! -name 'linux-arm64' ! -name 'android-arm64' -exec rm -rf {} + 2>/dev/null || true
done
find node_modules -type f \( -name '*.map' -o -name '*.tsbuildinfo' \) -delete 2>/dev/null || true
find node_modules -type d \( -name test -o -name tests -o -name __tests__ -o -name docs \) -prune -exec rm -rf {} + 2>/dev/null || true

# 移动端用不到的重包（默认只删最安全的三项；路径必须是真实包名）
PRUNE_LIST="${PRUNE_LIST:-@deepseek-ai/libreoffice-kit-wasm @deepseek-ai/dsh-experimental-inspector sherpa-onnx-linux-arm64}"
for name in $PRUNE_LIST; do
  [ -e "node_modules/$name" ] && { rm -rf "node_modules/$name"; echo "  - 删除 $name"; }
done

echo "== 3/4 统计"
du -sh node_modules

echo "== 4/4 打包 $OUT"
rm -f "$OUT"
if command -v zip >/dev/null 2>&1; then
  zip -qr -9 "$OUT" node_modules package.json
else
  echo "（无 zip，改用 python3 zipfile）"
  python3 - "$OUT" <<'PYZIP'
import os, sys, zipfile, time
out = sys.argv[1]; t0 = time.time()
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for base in ('node_modules', 'package.json'):
        if os.path.isfile(base):
            z.write(base, base); continue
        for root, _dirs, files in os.walk(base):
            for f in files:
                p = os.path.join(root, f)
                if not os.path.islink(p) and os.path.isfile(p):
                    z.write(p, p)
print('zip %.1fs' % (time.time() - t0))
PYZIP
fi
ls -lh "$OUT"
echo
echo "下一步：1) cp $OUT <repo>/app/src/main/assets/engine.bin；2) 改 MainActivity.assetStamp = \"$VER-1\"；3) 上机 verify-c + headless"
