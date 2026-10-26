#!/usr/bin/env bash
# build-plugin-assets.sh —— 把仓库里的插件源码打成 APK 资产 zip
#
# 为什么需要它：docs/agents/asset-stamps.md 记着一次真事故（b0fbb4b）——
# 改了 6 个插件的 try/catch，commit 里一个 zip 都没有；事后补打又漏了 root-tool。
# 判据只能是「zip 内文件与源目录逐字节一致」，所以打包必须自动化、可校验。
#
# 打包格式（七个 tool zip 同构，见 asset-stamps.md）：
#   条目为 package.json + lib/index.js（uiagent 多一个 lib/screens.js），
#   相对路径、没有顶层目录 —— EngineManager 直接解到
#   $DSH_HOME/<xxx>-tool/dsh-android-xxx/，多一层目录就找不到入口。
#
# 用法：./tools/build-plugin-assets.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS="${APP_ASSETS:-$ROOT/app/src/main/assets}"
mkdir -p "$ASSETS"

PAIRS=(
  "shell-tool:mobile-ui-plugin/dsh-android-shell"
  "root-tool:mobile-ui-plugin/dsh-android-root"
  "bubble-tool:mobile-ui-plugin/dsh-android-bubble"
  "statusbar-tool:mobile-ui-plugin/dsh-android-statusbar"
  "uiagent-tool:mobile-ui-plugin/dsh-android-uiagent"
  "logs-tool:mobile-ui-plugin/dsh-android-logs"
  "browser-tool:mobile-ui-plugin/dsh-android-browser"
  "browser-pane:mobile-ui-plugin/dsh-android-browser-pane"
  "pet-bridge:mobile-ui-plugin/dsh-android-pet"
  "mobile-ui:mobile-ui-plugin/dsh-android-mobile"
  "market-plugin:market-plugin/dsh-android-market"
  "core-memory:core-memory-plugin/dsh-core-memory"
  "preset-skills:preset-skills-plugin/dsh-preset-skills"
  "preset-razor:preset-razor-plugin/dsh-preset-razor"
  "agnes-multimodal:agnes-multimodal-plugin/dsh-agnes-multimodal"
)

ok=0
skip=0

for pair in "${PAIRS[@]}"; do
  name="${pair%%:*}"
  dir="${pair#*:}"
  src="$ROOT/$dir"
  out="$ASSETS/$name.zip"

  if [ ! -d "$src" ]; then
    echo "::warning::$name 的源目录不存在（$dir），跳过"
    skip=$((skip + 1))
    continue
  fi

  case "$name" in
    preset-skills) MODE=data ;;
    preset-razor)  MODE=pkg ;;
    *)             MODE=lib ;;
  esac

  rm -f "$out"

  python3 - "$src" "$out" "$name" <<'PY'
import os, sys, zipfile

src, out, name = sys.argv[1], sys.argv[2], sys.argv[3]
SKIP = {'node_modules', '.git', '.github', 'test', 'tests', '__tests__'}
n = 0
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for dirpath, dirnames, files in os.walk(src):
        dirnames[:] = [d for d in dirnames if d not in SKIP]
        for f in files:
            p = os.path.join(dirpath, f)
            rel = os.path.relpath(p, src).replace(os.sep, '/')
            if rel.startswith('.') or rel.endswith('.map'):
                continue
            zi = zipfile.ZipInfo(rel)
            zi.external_attr = (0o755 if '/bin/' in '/' + rel else 0o644) << 16
            zi.compress_type = zipfile.ZIP_DEFLATED
            with open(p, 'rb') as fh:
                z.writestr(zi, fh.read())
            n += 1
print(f'   {name}.zip  {n} 条目')
PY

  python3 - "$out" "$name" "$MODE" <<'PY'
import sys, zipfile

path, name, mode = sys.argv[1], sys.argv[2], sys.argv[3]
NEED = {'data': [], 'pkg': ['package.json'], 'lib': ['package.json', 'lib/index.js']}[mode]
with zipfile.ZipFile(path) as z:
    names = z.namelist()
    bad = [n for n in names if n.split('/')[0] in ('package', name)]
    if bad:
        sys.exit(f'❌ {name}.zip 有顶层目录：{bad[:3]}')
    if not names:
        sys.exit(f'❌ {name}.zip 是空的')
    for need in NEED:
        if need not in names:
            sys.exit(f'❌ {name}.zip 缺少 {need}（现有 {names[:5]}）')
PY

  if [ "$MODE" = "lib" ]; then
    python3 - "$src" "$out" "$name" <<'PY'
import hashlib, sys, zipfile

src, path, name = sys.argv[1], sys.argv[2], sys.argv[3]
with zipfile.ZipFile(path) as z:
    packed = z.read('lib/index.js')
with open(src + '/lib/index.js', 'rb') as f:
    source = f.read()
if hashlib.sha256(packed).digest() != hashlib.sha256(source).digest():
    sys.exit(f'❌ {name}.zip 里的 lib/index.js 与源文件不一致')
print(f'   ✅ {name}.zip 入口字节一致')
PY
  fi

  ok=$((ok + 1))
done

echo "== 汇总：$ok 个已打包，$skip 个跳过"
ls -lh "$ASSETS"/*.zip 2>/dev/null | tail -20 || true
