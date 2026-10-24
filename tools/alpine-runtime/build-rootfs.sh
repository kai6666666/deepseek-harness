#!/usr/bin/env bash
# build-rootfs.sh —— 在 x86_64 Linux / WSL 上交叉构建 aarch64 Alpine rootfs
#
# 产物（可直接打成 app/src/main/assets/alpine-rootfs.bin）：
#   out/alpine-rootfs.tar.gz
#   out/alpine-rootfs.tar.gz.sha256
#   out/rootfs.manifest.json      ← 包列表 / node 版本 / 大小 / 时间，供 App 侧校验
#
# 三个关键做法（对齐 Operit2 的 build_alpine_rootfs_wsl.sh）：
#   1. Node 用版本约束 `nodejs~24`，不写裸 `nodejs`（分支老时会给 node 20，DSH 直接不满足）
#   2. apk-tools-static 的版本从 APKINDEX 自动解析，不硬编码（换分支不会 404）
#   3. 打包前用 verify-alpine-node.sh 读 apk 数据库断言 node 主版本
#
# 用法：
#   ./build-rootfs.sh --dry-run
#   ./build-rootfs.sh                                   # 默认 v3.23 + nodejs~24
#   ./build-rootfs.sh --alpine 3.23.0 --out ./out
#   ./build-rootfs.sh --pkgs "bash nodejs~24 npm pnpm python3 py3-pip openssh ca-certificates tzdata"
set -u
ORIG_ARGS=("$@")                                    # 自动提权要原样回放参数
HERE="$(cd "$(dirname "$0")" && pwd)"

ALPINE_VER="3.23.0"
MIRROR="https://dl-cdn.alpinelinux.org/alpine"
ARCH="aarch64"
HOST_ARCH="x86_64"
OUT="$HERE/out"
WORK="${TMPDIR:-/tmp}/dsh-alpine-build"
APK_TOOLS_VER=""                                   # 空 = 自动从 APKINDEX 解析
PKGS="bash nodejs~24 npm pnpm python3 py3-pip openssh ca-certificates tzdata"
EXPECT_NODE_MAJOR="24"                             # 必须与 PKGS 里的 nodejs~24 一致（曾误写 22 → 断言必失败）
DRY=0
KEEP=0
NODE_STRICT=1

while [ $# -gt 0 ]; do
  case "$1" in
    --alpine) ALPINE_VER="$2"; shift 2 ;;
    --mirror) MIRROR="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --pkgs) PKGS="$2"; shift 2 ;;
    --apk-tools-ver) APK_TOOLS_VER="$2"; shift 2 ;;
    --expect-node-major) EXPECT_NODE_MAJOR="$2"; shift 2 ;;
    --allow-old-node) NODE_STRICT=0; shift ;;
    --dry-run) DRY=1; shift ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) printf 'unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

# ── 提权：apk-tools 3.x 拒绝以非 root 建 apk 数据库（GitHub runner 是 runner 用户） ──
#   DSH_ROOTFS_NO_SUDO=1 可禁用自动提权（自己用 --usermode / fakeroot 时）。
if [ "$DRY" != "1" ] && [ "$(id -u)" != "0" ] && [ "${DSH_ROOTFS_NO_SUDO:-0}" != "1" ]; then
  if command -v sudo >/dev/null 2>&1; then
    printf ' ! 非 root：自动 sudo 重新执行（apk-tools 3.x 需要 root 建库）\n'
    exec sudo -E bash "$0" "${ORIG_ARGS[@]}"
  fi
  printf '✗ apk-tools 3.x 需要 root（当前 uid=%s）。用 sudo 跑，或 DSH_ROOTFS_NO_SUDO=1 并自行 --usermode\n' "$(id -u)" >&2
  exit 13
fi

BRANCH="v${ALPINE_VER%.*}"                          # 3.23.0 → v3.23
ROOT="$WORK/rootfs"
APKDIR="$WORK/apk-tools"
APK="$APKDIR/sbin/apk.static"
MINI="$WORK/minirootfs.tar.gz"
REPOS_FILE="$ROOT/etc/apk/repositories"

say() { printf '%s\n' "$*"; }
run() {
  if [ "$DRY" = "1" ]; then say "  [dry] $*"; else "$@"; fi
}
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

apk_db_field() {   # $1=db 路径 $2=包名 $3=字段(P/V)
  awk -v want_pkg="$2" -v want_key="$3" '
    BEGIN { RS = ""; FS = "\n" }
    {
      p = ""; v = "";
      for (i = 1; i <= NF; i++) {
        if (substr($i, 1, 2) == "P:") p = substr($i, 3);
        if (substr($i, 1, 2) == "V:") v = substr($i, 3);
      }
      if (p == want_pkg) { print (want_key == "P" ? p : v); exit }
    }' "$1"
}

say "== 参数"
say "  alpine      : $ALPINE_VER（$BRANCH）"
say "  arch        : $ARCH（host $HOST_ARCH）"
say "  packages    : $PKGS"
say "  node ≥      : $EXPECT_NODE_MAJOR（--allow-old-node 可放宽）"
say "  out         : $OUT"
say "  dry-run     : $DRY"
say ""

# ── 1) minirootfs：从 latest-releases.yaml 拿真实文件名与 sha256 ─────────
# 不拼 URL：Alpine 的小版本号经常变（3.23.0 → 3.23.1），拼错就 404。
release_field() {   # $1 = file | sha256
  curl -fsSL "$MIRROR/$BRANCH/releases/$ARCH/latest-releases.yaml" | awk -v want="$1" '
    {
      if ($0 ~ /^ *- */) blk_flavor = "";
      if ($0 ~ /^ *- *flavor: */) { v = $0; sub(/^ *- *flavor: */, "", v); blk_flavor = v }
      if ($0 ~ /^ *flavor: */)    { v = $0; sub(/^ *flavor: */, "", v);    blk_flavor = v }
      if (blk_flavor == "alpine-minirootfs" && $0 ~ ("^ *" want ": ")) {
        out = $0; sub("^ *" want ": *", "", out); gsub(/"/, "", out); print out; exit
      }
    }'
}

say "== 1) 取 minirootfs"
MINI_FILE="alpine-minirootfs-${ALPINE_VER}-${ARCH}.tar.gz"
MINI_SHA=""
if [ "$DRY" = "0" ]; then
  mf="$(release_field file || true)"
  ms="$(release_field sha256 || true)"
  if [ -n "$mf" ]; then
    MINI_FILE="$mf"
    say "  latest-releases.yaml → $MINI_FILE"
  else
    say "  ! 没解析到 latest-releases.yaml，回退按版本号拼文件名"
  fi
  [ -n "$ms" ] && MINI_SHA="$ms"

  if [ ! -f "$MINI" ]; then
    mkdir -p "$WORK"
    curl -fL --retry 3 -o "$MINI" "$MIRROR/$BRANCH/releases/$ARCH/$MINI_FILE" \
      || die "下载失败：$MIRROR/$BRANCH/releases/$ARCH/$MINI_FILE（去该目录看实际文件名）"
  fi
  if [ -n "$MINI_SHA" ]; then
    printf '%s  %s\n' "$MINI_SHA" "$MINI" | sha256sum -c - || die "minirootfs sha256 校验失败"
  else
    say "  ! 没有 sha256（老镜像不提供），跳过校验"
  fi
else
  say "  [dry] 解析 latest-releases.yaml → file / sha256"
  say "  [dry] curl $MIRROR/$BRANCH/releases/$ARCH/<file>"
fi

say "== 2) 解开 rootfs"
if [ "$DRY" = "0" ]; then
  rm -rf "$ROOT"; mkdir -p "$ROOT"
  tar -xzf "$MINI" -C "$ROOT"
  [ -f "$ROOT/etc/alpine-release" ] || die "解包后没有 /etc/alpine-release，minirootfs 不对"
  say "  alpine-release: $(cat "$ROOT/etc/alpine-release")"
else
  say "  [dry] tar -xzf $MINI -C $ROOT"
fi

say "== 3) 取 host 侧 apk.static"
if [ "$DRY" = "0" ]; then
  mkdir -p "$APKDIR"
  if [ -z "$APK_TOOLS_VER" ]; then
    idx="$WORK/APKINDEX-main-$HOST_ARCH.tar.gz"
    curl -fsSL -o "$idx" "$MIRROR/$BRANCH/main/$HOST_ARCH/APKINDEX.tar.gz" \
      || die "取不到 APKINDEX（分支写错了？$BRANCH）"
    # 先落地成文件再 awk：`tar | awk` 里 awk 提前 exit 会给 tar 一个 SIGPIPE，
    # tar 会打出 "Wrote only N of M bytes" 并返回非 0 —— 在 pipefail 下会被误判成失败。
    tar -xzOf "$idx" APKINDEX > "$WORK/APKINDEX-main" 2>/dev/null || true
    APK_TOOLS_VER="$(
      awk '
        BEGIN { RS = ""; FS = "\n" }
        {
          p = ""; v = "";
          for (i = 1; i <= NF; i++) {
            if (substr($i, 1, 2) == "P:") p = substr($i, 3);
            if (substr($i, 1, 2) == "V:") v = substr($i, 3);
          }
          if (p == "apk-tools-static") { print v; exit }
        }' "$WORK/APKINDEX-main"
    )"
  fi
  [ -n "$APK_TOOLS_VER" ] || die "解析不到 apk-tools-static 版本；用 --apk-tools-ver 手动指定"
  say "  apk-tools-static: $APK_TOOLS_VER"
  curl -fL --retry 3 -o "$WORK/apk-tools-static.apk" \
    "$MIRROR/$BRANCH/main/$HOST_ARCH/apk-tools-static-$APK_TOOLS_VER.apk" \
    || die "apk-tools-static-$APK_TOOLS_VER.apk 下载失败（版本与分支不匹配？）"
  rm -rf "$APKDIR"; mkdir -p "$APKDIR"
  tar -xzf "$WORK/apk-tools-static.apk" -C "$APKDIR" sbin/apk.static 2>/dev/null \
    || tar -xzf "$WORK/apk-tools-static.apk" -C "$APKDIR"
  chmod 755 "$APK" 2>/dev/null || true
  [ -x "$APK" ] || die "apk.static 没解出来"
  # 宿主预检：必须能原生执行 apk.static。在 PRoot / chroot 里常见 SIGBUS（exit 135），
  # 表现出来就是一句 "Bus error"，很难猜；这里提前拦下并说清原因。
  # 用正向判断拿真实退出码（`if ! cmd; then rc=$?` 里 $? 是取反后的 0，会丢信息）
  if "$APK" --version >"$WORK/apk-version.txt" 2>&1; then
    say "  apk.static: $(head -1 "$WORK/apk-version.txt")"
  else
    rc=$?
    say "  $(head -1 "$WORK/apk-version.txt" 2>/dev/null)"
    die "本机无法执行 apk.static（exit $rc）。构建必须在能原生执行 x86_64 静态二进制的环境里做：WSL2 / CI / 真 Linux / 容器；PRoot 与 chroot 里会 SIGBUS。"
  fi
else
  say "  [dry] 解析 APKINDEX → apk-tools-static 版本"
  say "  [dry] curl …/apk-tools-static-<ver>.apk && tar -xzf … sbin/apk.static"
fi

say "== 4) 预置 apk 配置（安装要用 --repositories-file，必须先写）"
if [ "$DRY" = "0" ]; then
  mkdir -p "$ROOT/etc/apk" "$ROOT/etc/profile.d" "$ROOT/tmp" "$ROOT/dev" "$ROOT/proc" "$ROOT/sys" \
           "$ROOT/workspace" "$ROOT/dsh-home"
  printf '%s/main\n%s/community\n' "$MIRROR/$BRANCH" "$MIRROR/$BRANCH" > "$REPOS_FILE"
  printf '%s\n' "$ARCH" > "$ROOT/etc/apk/arch"
  printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > "$ROOT/etc/resolv.conf"
  cat > "$ROOT/etc/profile.d/dsh.sh" <<'PROFILE'
export LANG=C.UTF-8
export PS1='\h:\w\$ '
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
PROFILE
  chmod 755 "$ROOT/tmp"
  say "  repositories: $(tr '\n' ' ' < "$REPOS_FILE")"
else
  say "  [dry] 写 /etc/apk/repositories、/etc/apk/arch、/etc/resolv.conf"
fi

say "== 5) 交叉安装软件包"
# --no-scripts：post-install 是 aarch64 二进制，在 x86_64 host 上跑不了
if [ "$DRY" = "0" ]; then
  DEBIAN_FRONTEND=noninteractive "$APK" \
    --arch "$ARCH" --root "$ROOT" --initdb --no-cache --no-scripts \
    --keys-dir "$ROOT/etc/apk/keys" \
    --repositories-file "$REPOS_FILE" \
    add $PKGS \
    || die "apk add 失败（版本不存在 / 包名在该分支没有 / apk-tools 与分支不匹配）"
  say "  ✓ 安装完成：$(printf '%s' "$PKGS" | wc -w) 个包"
else
  say "  [dry] apk.static --arch $ARCH --root $ROOT --initdb --no-cache --no-scripts \\"
  say "        --keys-dir $ROOT/etc/apk/keys --repositories-file $REPOS_FILE add $PKGS"
fi

say "== 6) 断言 node 主版本（DSH 需要 ^22.19 || >=24）"
NODE_VER=""
if [ "$DRY" = "0" ]; then
  if [ -f "$HERE/verify-alpine-node.sh" ]; then
    if [ "$NODE_STRICT" = "1" ]; then
      bash "$HERE/verify-alpine-node.sh" "$ROOT" "$EXPECT_NODE_MAJOR" \
        || die "node 版本断言失败：换 v3.23+ 分支，或把 packages 里的 nodejs 改成 nodejs~24"
    else
      bash "$HERE/verify-alpine-node.sh" "$ROOT" 0 || true
    fi
  else
    say "  ! 缺 verify-alpine-node.sh，跳过断言"
  fi
  NODE_VER="$(apk_db_field "$ROOT/lib/apk/db/installed" nodejs V)"
else
  say "  [dry] bash verify-alpine-node.sh $ROOT $EXPECT_NODE_MAJOR"
fi

say "== 7) 打包 + 校验 + 清单"
if [ "$DRY" = "0" ]; then
  mkdir -p "$OUT"
  # 必须绝对化：下面 `cd "$ROOT"` 之后，相对的 dist 会被解析成 $ROOT/dist（不存在）
  OUT="$(cd "$OUT" && pwd)"
  TARBALL="$OUT/alpine-rootfs.tar.gz"
  ( cd "$ROOT" && tar --numeric-owner --owner=0 --group=0 -czf "$TARBALL" . )
  ( cd "$OUT" && sha256sum "$(basename "$TARBALL")" > "$(basename "$TARBALL").sha256" )
  BYTES=$(wc -c < "$TARBALL" | tr -d ' ')
  SHA=$(cut -d' ' -f1 "$OUT/alpine-rootfs.tar.gz.sha256")
  PKGJSON=$(printf '%s' "$PKGS" | tr ' ' '\n' | sed 's/.*/"&"/' | paste -sd, -)
  cat > "$OUT/rootfs.manifest.json" <<EOF
{
  "schema": 2,
  "alpine": "$ALPINE_VER",
  "branch": "$BRANCH",
  "arch": "$ARCH",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "tarball": "alpine-rootfs.tar.gz",
  "bytes": $BYTES,
  "sha256": "$SHA",
  "nodejs": "$NODE_VER",
  "packages": [$PKGJSON]
}
EOF
  say "  ✓ $TARBALL（$BYTES B, sha256 ${SHA:0:16}…）"
  say "  ✓ nodejs $NODE_VER"
  say "  ✓ $OUT/rootfs.manifest.json"
  say "  下一步：cp $TARBALL <repo>/app/src/main/assets/alpine-rootfs.bin"
  [ "$KEEP" = "0" ] && rm -rf "$WORK"
else
  say "  [dry] tar --numeric-owner --owner=0 --group=0 -czf $OUT/alpine-rootfs.tar.gz -C $ROOT ."
  say "  [dry] sha256sum + rootfs.manifest.json（schema 2，含 nodejs 字段）"
fi

say ""
say "完成。设备侧验收：tools/alpine-runtime/verify-rootfs.sh"