#!/usr/bin/env bash
# install-overlay.sh —— 装一个「可抛弃的 Ubuntu 工具链层」（不是运行档）
#
# 做什么：
#   1) 动态探测 ubuntu-base 的 arm64 tarball（不硬编码小版本号）
#   2) 解包到 $DSH_HOME/toolchain/ubuntu
#   3) 注入 proot 专用 apt 配置（沙箱用户 / 缓存外置 / 不装 man+doc / 阻止服务启动）
#   4) 写 deb822 软件源（ubuntu-ports，arm64 必须用 ports）
#   5) apt-get update，可选预装包
#
# 用法：
#   bash install-overlay.sh --dry-run
#   bash install-overlay.sh                                   # 24.04 最小层（约 90 MB 落地）
#   bash install-overlay.sh --packages default-jdk,gradle     # 带 JDK + gradle
#   bash install-overlay.sh --release 22.04 --mirror http://ports.ubuntu.com/ubuntu-ports
#   bash install-overlay.sh --force                            # 删掉重装
#
# 退出码：0 成功；2 参数错；3 下载/探测失败；4 解包失败；5 apt 失败；12 proot 缺
set -u

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
TC_ROOT="${DSH_TC_ROOT:-$DSH_HOME/toolchain/ubuntu}"
DSH_PROOT="${DSH_PROOT:-$DSH_HOME/bin/libproot.so}"
DSH_PROOT_LOADER="${DSH_PROOT_LOADER:-$DSH_HOME/bin/proot-loader.so}"
HERE="$(cd "$(dirname "$0")" && pwd)"

RELEASE="24.04"
MIRROR="https://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports"
ARCH="arm64"
PKGS=""
DO_UPDATE=1
FORCE=0
DRY=0
SUITE=""
PIN=""
SHA=""

while [ $# -gt 0 ]; do
  case "$1" in
    --release) RELEASE="$2"; shift 2 ;;
    --suite) SUITE="$2"; shift 2 ;;
    --mirror) MIRROR="$2"; shift 2 ;;
    --arch) ARCH="$2"; shift 2 ;;
    --root) TC_ROOT="$2"; shift 2 ;;
    --packages) PKGS="$2"; shift 2 ;;
    --pin) PIN="$2"; shift 2 ;;
    --no-update) DO_UPDATE=0; shift ;;
    --force) FORCE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) printf 'unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit "${2:-1}"; }

if [ -z "$SUITE" ]; then
  case "$RELEASE" in
    24.04*) SUITE=noble ;;
    22.04*) SUITE=jammy ;;
    25.10*) SUITE=questing ;;
    25.04*) SUITE=plucky ;;
    *) die "未知 release=$RELEASE，请显式 --suite" 2 ;;
  esac
fi

# ── 0) 前置检查 ──────────────────────────────────────────────────────
[ -x "$DSH_PROOT" ] || die "缺 proot: $DSH_PROOT（先跑 alpine-runtime 的烘焙流程，或设 DSH_PROOT）" 12
[ -f "$DSH_PROOT_LOADER" ] || die "缺 proot-loader: $DSH_PROOT_LOADER" 12
command -v curl >/dev/null 2>&1 || die "缺 curl" 12
command -v tar  >/dev/null 2>&1 || die "缺 tar" 12

# ── 1) 探测 ubuntu-base tarball（不硬编码 24.04.3 这种小版本） ────────
BASE_URL="https://cdimage.ubuntu.com/ubuntu-base/releases/${RELEASE}/release/"
say "== 1/5 探测 ubuntu-base（$RELEASE / $ARCH）"
say "   $BASE_URL"
if [ -n "$PIN" ]; then
  FILE="$PIN"
  say "   锁定版本（--pin）：$FILE"
else
  FILE="$(curl -fsSL --max-time 60 "$BASE_URL" 2>/dev/null \
    | grep -oE 'ubuntu-base-[0-9][^"<> ]*-base-'"$ARCH"'\.tar\.gz' \
    | sort -uV | tail -1)"
  [ -n "$FILE" ] || die "探测失败：$BASE_URL 里没找到 *-base-$ARCH.tar.gz（可 --release 换版本）" 3
  say "   → $FILE    （要复现这次构建，下次加 --pin $FILE）"
fi
TB_URL="${BASE_URL}${FILE}"

# 摘要：cdimage 每个 release 目录都有 SHA256SUMS
EXPECT_SHA="$(curl -fsSL --max-time 60 "${BASE_URL}SHA256SUMS" 2>/dev/null \
  | awk -v f="$FILE" '{ sub(/^\*/,"",$2) } $2==f { print $1; exit }')"
if [ -n "$EXPECT_SHA" ]; then
  say "   sha256: $EXPECT_SHA"
else
  say "   ⚠ SHA256SUMS 未收录该文件，只能下载后自算摘要"
fi

if [ "$DRY" = "1" ]; then
  say ""
  say "== 2/5 解包目标（dry-run）"
  say "   $TC_ROOT"
  say ""
  say "== 3/5 将注入的 apt 配置"
  say "   /etc/apt/apt.conf.d/99-proot        (APT::Sandbox::User root / 缓存外置 / 不装推荐)"
  say "   /etc/dpkg/dpkg.cfg.d/99-proot       (path-exclude man+doc+locale)"
  say "   /usr/sbin/policy-rc.d               (exit 101，阻止服务启动)"
  say "   /etc/apt/sources.list.d/ubuntu.sources (deb822, $MIRROR, $SUITE)"
  say ""
  say "== 4/5 校验与执行"
  say "   sha256: ${EXPECT_SHA:-（SHA256SUMS 未收录，下载后自算）}"
  say "   proot -r $TC_ROOT -0 --link2symlink -- apt-get update"
  [ -n "$PKGS" ] && say "   apt-get install -y --no-install-recommends $PKGS"
  say ""
  say "== 5/5 dry-run 结束（未下载、未写盘）"
  exit 0
fi

if [ -d "$TC_ROOT" ] && [ "$FORCE" != "1" ]; then
  say "   overlay 已存在：$TC_ROOT（用 --force 重装）"
  exit 0
fi
[ "$FORCE" = "1" ] && [ -d "$TC_ROOT" ] && { say "   --force：删除旧 overlay"; rm -rf "$TC_ROOT"; }

# ── 2) 下载 + 解包 ───────────────────────────────────────────────────
say "== 2/5 下载并解包"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/tc.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
curl -fL --retry 3 --connect-timeout 20 -o "$TMP/base.tar.gz" "$TB_URL" || die "下载失败: $TB_URL" 3
ACTSHA="$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$TMP/base.tar.gz")" \
  || die "算 sha256 失败（缺 python3）" 3
say "   $(du -h "$TMP/base.tar.gz" | cut -f1) 已下载  sha256=$ACTSHA"
if [ -n "$EXPECT_SHA" ] && [ "$ACTSHA" != "$EXPECT_SHA" ]; then
  die "sha256 不匹配！期望 $EXPECT_SHA 实际 $ACTSHA —— 包被截断或源被换，拒绝解包" 3
fi
[ -n "$EXPECT_SHA" ] && say "   ✓ sha256 校验通过"
SHA="$ACTSHA"

mkdir -p "$TC_ROOT"
# --no-same-owner：Android 上没有 root，属主无法保留；mode 位保留（可执行位必须留）
tar -xzf "$TMP/base.tar.gz" -C "$TC_ROOT" --no-same-owner --numeric-owner 2>/dev/null \
  || die "解包失败（存储空间不足？）" 4
[ -x "$TC_ROOT/usr/bin/apt-get" ] || die "解包后没有 apt-get，tarball 不对" 4
say "   overlay 落地 $(du -sm "$TC_ROOT" | cut -f1) MB"

# ── 3) 注入 proot 适配（这四份配置是 apt 能在 proot 里跑起来的关键） ──
say "== 3/5 注入 proot 适配"

mkdir -p "$TC_ROOT/etc/apt/apt.conf.d" "$TC_ROOT/etc/dpkg/dpkg.cfg.d" \
         "$TC_ROOT/etc/apt/sources.list.d" "$DSH_HOME/toolchain/cache/archives/partial"

cat > "$TC_ROOT/etc/apt/apt.conf.d/99-proot" <<'EOF'
// proot 里 apt 的必备适配（由 DSHAPP install-overlay.sh 生成）
// 1) 切换 _apt 沙箱用户会 setgroups 失败，直接禁用沙箱
APT::Sandbox::User "root";
// 2) .deb 缓存放 overlay 外，避免把 rootfs 撑大 / 每次重装
Dir::Cache::archives "/dsh-home/toolchain/cache/archives";
// 3) 不拉推荐包（体积第一原则）
APT::Install-Recommends "false";
APT::Install-Suggests "false";
// 4) 保留旧配置，避免 postinst 交互卡死
Dpkg::Options { "--force-confold"; "--force-confdef"; };
// 5) 重试与超时（手机网络）
Acquire::Retries "3";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
EOF

cat > "$TC_ROOT/etc/dpkg/dpkg.cfg.d/99-proot" <<'EOF'
# 体积第一原则：不落地 man / doc / locale（可省 20–30%）
force-confold
path-exclude=/usr/share/man/*
path-exclude=/usr/share/doc/*
path-exclude=/usr/share/locale/*
path-exclude=/usr/share/info/*
EOF

cat > "$TC_ROOT/usr/sbin/policy-rc.d" <<'EOF'
#!/bin/sh
# proot 里没有 init：任何服务启动请求都拒绝（dpkg postinst 的标准做法）
exit 101
EOF
chmod 0755 "$TC_ROOT/usr/sbin/policy-rc.d"

# DNS：三级回退。国内优先 223.5.5.5，海外可用 1.1.1.1
cat > "$TC_ROOT/etc/resolv.conf" <<'EOF'
nameserver 223.5.5.5
nameserver 119.29.29.29
nameserver 1.1.1.1
EOF

# 软件源：arm64 必须走 ubuntu-ports（archive.ubuntu.com 的 arm64 覆盖不全）
KEYRING="$TC_ROOT/usr/share/keyrings/ubuntu-archive-keyring.gpg"
{
  printf 'Types: deb\n'
  printf 'URIs: %s\n' "$MIRROR"
  printf 'Suites: %s %s-updates %s-backports\n' "$SUITE" "$SUITE" "$SUITE"
  printf 'Components: main universe restricted multiverse\n'
  if [ -f "$KEYRING" ]; then
    printf 'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n'
  elif [ "${APT_INSECURE:-0}" = "1" ]; then
    # G-16：只有显式 APT_INSECURE=1 才允许关校验。
    #   以前的写法是「没 keyring 就写 Trusted: yes」——等于静默把签名校验关掉，
    #   日志里只有 keyring=no，没人会注意到装进来的包没验签。
    say "   ⚠ APT_INSECURE=1：无 keyring，本次关闭 apt 签名校验（仅调试用）"
    printf 'Trusted: yes\n'
  else
    say "✗ 缺 keyring: $KEYRING" >&2
    say "  → 先 ensure-rootfs 装 ubuntu-keyring；或显式 APT_INSECURE=1 承担风险" >&2
    exit 33
  fi
} > "$TC_ROOT/etc/apt/sources.list.d/ubuntu.sources"
say "   source: $MIRROR ($SUITE, $ARCH)  keyring=$([ -f "$KEYRING" ] && echo yes || echo no)"

# ── 4) apt-get update（走 tc-run，与运行时完全同一套 proot 参数） ─────
if [ "$DO_UPDATE" = "1" ]; then
  say "== 4/5 apt-get update"
  # G-20：三级源回退。国内网络下单个镜像抽风很常见，硬失败会让用户以为「装不了」。
  SRC_FILE="$TC_ROOT/etc/apt/sources.list.d/ubuntu.sources"
  update_ok=0
  for fb in "$MIRROR" "https://mirrors.aliyun.com/ubuntu-ports" "http://ports.ubuntu.com/ubuntu-ports"; do
    [ -n "$fb" ] || continue
    if [ "$fb" != "$MIRROR" ]; then
      say "   ↻ 回退到 $fb"
      sed -i "s#^URIs: .*#URIs: $fb#" "$SRC_FILE"
    fi
    if DSH_TC_ROOT="$TC_ROOT" DSH_PROOT="$DSH_PROOT" DSH_PROOT_LOADER="$DSH_PROOT_LOADER" \
      bash "$HERE/tc-run.sh" --sandbox readonly -- apt-get update -qq; then
      update_ok=1
      MIRROR="$fb"
      break
    fi
  done
  [ "$update_ok" = "1" ] || die "apt-get update 失败（3 个源都不可用：$MIRROR / aliyun / ports）" 5
  say "   update ok（源=$MIRROR）"
else
  say "== 4/5 跳过 update（--no-update）"
fi

# ── 5) 可选预装 ──────────────────────────────────────────────────────
if [ -n "$PKGS" ]; then
  say "== 5/5 安装: $PKGS"
  # shellcheck disable=SC2086
  PKG_LIST="$(printf '%s' "$PKGS" | tr ',' ' ')"
  DSH_TC_ROOT="$TC_ROOT" DSH_PROOT="$DSH_PROOT" DSH_PROOT_LOADER="$DSH_PROOT_LOADER" \
    bash "$HERE/tc-run.sh" -- apt-get install -y --no-install-recommends $PKG_LIST \
    || die "预装失败: $PKG_LIST" 5
else
  say "== 5/5 不预装（之后用 tc-run.sh -- apt-get install ...）"
fi

# ── 状态文件 ────────────────────────────────────────────────────────
SIZE_MB="$(du -sm "$TC_ROOT" | cut -f1)"
node -e '
const fs=require("fs");
const [root,rel,suite,arch,mirror,size,pkgs]=process.argv.slice(1);
const p=process.env.DSH_HOME+"/toolchain.json";
let s={};try{s=JSON.parse(fs.readFileSync(p,"utf8"))}catch{}
s.overlay={root,release:rel,suite,arch,mirror,sizeMB:Number(size),packages:(pkgs||"").split(",").filter(Boolean),installedAt:new Date().toISOString()};
fs.writeFileSync(p, JSON.stringify(s,null,2));
' "$TC_ROOT" "$RELEASE" "$SUITE" "$ARCH" "$MIRROR" "$SIZE_MB" "$PKGS" 2>/dev/null || true

# 追加 sha256（复现凭据），失败不影响主流程
if [ -n "$SHA" ]; then
  SHA="$SHA" DSH_HOME="$DSH_HOME" node -e '
const fs = require("fs");
const p = process.env.DSH_HOME + "/toolchain.json";
try {
  const s = JSON.parse(fs.readFileSync(p, "utf8"));
  if (s.overlay) s.overlay.sha256 = process.env.SHA;
  fs.writeFileSync(p, JSON.stringify(s, null, 2));
} catch {}
' 2>/dev/null || true
fi

say ""
say "✓ overlay 就绪：$TC_ROOT  (${SIZE_MB} MB)"
say "  用：bash tc-run.sh -- apt-get install -y <pkg>"
say "  验：bash verify-toolchain.sh --overlay"