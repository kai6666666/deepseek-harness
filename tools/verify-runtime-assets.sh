#!/usr/bin/env bash
# verify-runtime-assets.sh —— APK 内置 rootfs 的构建期闸门（由 Gradle preBuild 调用）
#
# 为什么要有：
#   assets 里缺 rootfs、或 sha256 与 manifest 对不上，打出来的 APK 首启必崩。
#   构建期失败 3 秒，比用户装完才崩好一万倍。
#
# 用法：
#   bash tools/verify-runtime-assets.sh           # 严格（preBuild 用的就是这个）
#   bash tools/verify-runtime-assets.sh --soft    # 只警告，退出码恒 0（本地想强制打包时）
#
# 退出码：0 通过；1 失败（缺文件 / 摘要不符 / Node 主版本不对 / 体积异常）
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
ASSETS="${DSH_ASSETS_DIR:-$REPO/app/src/main/assets/runtime}"
TAR="$ASSETS/alpine-rootfs.bin"
MAN="$ASSETS/alpine-rootfs.manifest.json"
EXPECT_NODE_MAJOR="${EXPECT_NODE_MAJOR:-24}"
SOFT=0
[ "${1:-}" = "--soft" ] && SOFT=1

fail() {
  printf '✗ runtime assets: %s\n' "$*" >&2
  printf '   修复：bash tools/fetch-rootfs-into-assets.sh --from <CI 产物目录|zip>\n' >&2
  printf '   跳过（不推荐）：DSH_SKIP_ASSET_CHECK=1 ./gradlew ...\n' >&2
  [ "$SOFT" = "1" ] && { printf '   （--soft：仅警告）\n' >&2; exit 0; }
  exit 1
}

[ -s "$TAR" ] || fail "缺 $TAR"
[ -s "$MAN" ] || fail "缺 $MAN（manifest 决定解包后写什么状态）"

# manifest 里的三件事：bytes / sha256 / nodejs
eval "$(python3 - "$MAN" <<'PY'
import json, sys, shlex
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print("echo 'manifest 不是合法 JSON' >&2; exit 1")
    raise SystemExit
print("M_BYTES=%s" % shlex.quote(str(d.get("bytes", ""))))
print("M_SHA=%s" % shlex.quote(str(d.get("sha256", ""))))
print("M_NODE=%s" % shlex.quote(str(d.get("nodejs", ""))))
print("M_ALPINE=%s" % shlex.quote(str(d.get("alpine", ""))))
print("M_SCHEMA=%s" % shlex.quote(str(d.get("schema", ""))))
PY
)" || fail "manifest 解析失败"

A_BYTES="$(stat -c%s "$TAR")"
A_SHA="$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$TAR")" \
  || fail "无法计算 sha256（缺 python3？）"

[ "$M_BYTES" = "$A_BYTES" ] || fail "字节数不符：manifest=$M_BYTES 实际=$A_BYTES"
[ "$M_SHA" = "$A_SHA" ] || fail "sha256 不符：manifest=${M_SHA:0:16}… 实际=${A_SHA:0:16}…"

MAJOR="${M_NODE%%.*}"
[ "$MAJOR" = "$EXPECT_NODE_MAJOR" ] || fail "Node 主版本 $M_NODE ≠ 期望 $EXPECT_NODE_MAJOR.x"

if [ "$A_BYTES" -lt 20000000 ]; then fail "tarball 只有 $A_BYTES B，几乎肯定没装包"; fi
if [ "$A_BYTES" -gt 130000000 ]; then fail "tarball $A_BYTES B，超过 130 MB 预算"; fi

printf '✓ runtime assets：node %s / alpine %s / %s MB / sha256 %s…\n' \
  "$M_NODE" "${M_ALPINE:-?}" "$((A_BYTES / 1024 / 1024))" "${A_SHA:0:12}"
exit 0