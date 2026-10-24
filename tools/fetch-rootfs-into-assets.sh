#!/usr/bin/env bash
# fetch-rootfs-into-assets.sh —— 把 CI 产出的 rootfs 拉进 assets（G-04：随 APK 分发）
#
# 为什么是 assets 不是下载：
#   首次启动就要能跑引擎，且离线可用。代价是 APK +约 40 MB（tar.gz 已压缩，不再二次压缩）。
#
# 用法：
#   bash tools/fetch-rootfs-into-assets.sh --from ~/Downloads/dist
#   bash tools/fetch-rootfs-into-assets.sh --from ~/Downloads/alpine-rootfs-aarch64.zip
#   bash tools/fetch-rootfs-into-assets.sh --from dist --verify     # 只校验
#   bash tools/fetch-rootfs-into-assets.sh --from dist --dest /tmp/x --force
#
# 退出码：0 成功；2 参数错；3 输入缺文件；4 sha256 不符；5 复制失败
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
SRC=""
DEST="$REPO/app/src/main/assets/runtime"
VERIFY_ONLY=0
FORCE=0
EXPECT_NODE_MAJOR="${EXPECT_NODE_MAJOR:-24}"

say() { printf '%s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit "${2:-1}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --from) SRC="$2"; shift 2 ;;
    --dest) DEST="$2"; shift 2 ;;
    --verify) VERIFY_ONLY=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) printf 'unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

[ -n "$SRC" ] || die "需要 --from <目录|zip>" 2
[ -e "$SRC" ] || die "找不到 $SRC" 3

WORK=""
cleanup() { [ -n "$WORK" ] && rm -rf "$WORK"; }
trap cleanup EXIT

# ── 1) 定位三件套（目录直接用；zip 先解） ─────────────────────────────
IN="$SRC"
if [ -f "$SRC" ]; then
  case "$SRC" in
    *.zip) ;;
    *) die "--from 只能是目录或 .zip（拿到的是：$(basename "$SRC")）" 2 ;;
  esac
  command -v unzip >/dev/null 2>&1 || die "缺 unzip" 3
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/rf.XXXXXX")"
  unzip -q "$SRC" -d "$WORK" || die "解压失败" 3
  # artifact zip 可能带一层目录
  IN="$(find "$WORK" -name 'alpine-rootfs.tar.gz' -printf '%h\n' 2>/dev/null | head -1)"
  [ -n "$IN" ] || IN="$WORK"
fi

TAR="$IN/alpine-rootfs.tar.gz"
SHAF="$IN/alpine-rootfs.tar.gz.sha256"
MAN="$IN/rootfs.manifest.json"
[ -s "$TAR" ] || die "缺 $TAR（先跑 CI 的 alpine-rootfs）" 3
[ -s "$SHAF" ] || die "缺 $SHAF" 3

say "== 1/4 输入"
say "   tarball : $TAR ($(du -h "$TAR" | cut -f1))"

# ── 2) 校验摘要 ───────────────────────────────────────────────────────
EXPECT="$(cut -d' ' -f1 "$SHAF")"
ACTUAL="$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$TAR")" \
  || die "算 sha256 失败" 3
say "== 2/4 摘要"
say "   expect: $EXPECT"
say "   actual: $ACTUAL"
[ "$EXPECT" = "$ACTUAL" ] || die "sha256 不符，拒绝落地" 4
say "   ✓ 匹配"
BYTES="$(stat -c%s "$TAR")"

# ── 3) 读/补 manifest ────────────────────────────────────────────────
NODEJS=""
PKGS_JSON="[]"
ALPINE=""
BUILT=""
if [ -s "$MAN" ]; then
  eval "$(python3 - "$MAN" <<'PY'
import json, sys, shlex
d = json.load(open(sys.argv[1]))
print("NODEJS=%s" % shlex.quote(str(d.get("nodejs", ""))))
print("ALPINE=%s" % shlex.quote(str(d.get("alpine", ""))))
print("BUILT=%s" % shlex.quote(str(d.get("builtAt", ""))))
print("PKGS_JSON=%s" % shlex.quote(json.dumps(d.get("packages", []), ensure_ascii=False)))
PY
)"
fi
[ -n "$NODEJS" ] || NODEJS="unknown"
MAJOR="${NODEJS%%.*}"
say "== 3/4 清单"
say "   nodejs: $NODEJS (major=$MAJOR, 期望 $EXPECT_NODE_MAJOR)"
if [ "$MAJOR" != "$EXPECT_NODE_MAJOR" ]; then
  die "Node 主版本不对：拿到 $NODEJS，期望 $EXPECT_NODE_MAJOR.x（CI 里传 node_major）" 4
fi

if [ "$VERIFY_ONLY" = "1" ]; then
  say ""
  say "✓ --verify 通过（未写盘）"
  exit 0
fi

# ── 4) 落地 assets/runtime/ ──────────────────────────────────────────
say "== 4/4 落地"
mkdir -p "$DEST" || die "建目录失败: $DEST" 5
if [ -e "$DEST/alpine-rootfs.tar.gz" ] && [ "$FORCE" != "1" ]; then
  OLD="$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$DEST/alpine-rootfs.tar.gz" 2>/dev/null || echo none)"
  if [ "$OLD" = "$ACTUAL" ]; then
    say "   已是最新（sha256 相同），跳过复制"
  else
    say "   ! 目标已存在且不同（旧 ${OLD:0:12}…），加 --force 覆盖"
    exit 5
  fi
else
  cp -f "$TAR" "$DEST/alpine-rootfs.tar.gz" || die "复制失败（磁盘空间？）" 5
  say "   ✓ $DEST/alpine-rootfs.tar.gz"
fi
printf '%s  %s\n' "$ACTUAL" "alpine-rootfs.tar.gz" > "$DEST/alpine-rootfs.tar.gz.sha256"

# assets 侧 manifest：schema 3，App 直接读它
NODEJS="$NODEJS" ALPINE="$ALPINE" BUILT="$BUILT" PKGS_JSON="$PKGS_JSON" \
BYTES="$BYTES" SHA="$ACTUAL" DEST="$DEST" python3 - <<'PY' || die "写 manifest 失败" 5
import json, os, datetime
d = {
    "schema": 3,
    "assetsPath": "runtime/alpine-rootfs.tar.gz",
    "bytes": int(os.environ["BYTES"]),
    "sha256": os.environ["SHA"],
    "nodejs": os.environ["NODEJS"],
    "alpine": os.environ["ALPINE"],
    "packages": json.loads(os.environ["PKGS_JSON"] or "[]"),
    "builtAt": os.environ["BUILT"],
    "fetchedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "note": "APK 内置运行时。首启解包到 filesDir/runtime/alpine，校验 sha256 后写 .ready 标记。",
}
p = os.path.join(os.environ["DEST"], "alpine-rootfs.manifest.json")
open(p, "w").write(json.dumps(d, ensure_ascii=False, indent=2) + "\n")
print("   ✓ " + p)
PY

say ""
say "✓ 就绪：$DEST"
say "   APK 体积影响：+$((BYTES / 1024 / 1024)) MB（tar.gz 原样入 assets）"
say "   下一步：bash tools/verify-runtime-assets.sh   （preBuild 会自动跑它）"