#!/usr/bin/env bash
# tc-run.sh —— Ubuntu toolchain overlay 执行器
#
# 定位：这是「可抛弃的工具链层」，**不是第二个运行档**。
#   - 里面永不启动 DSH 引擎（engine 只有一份，在 Alpine 档）
#   - 只在需要 apt/deb 依赖树时挂载
#   - 产物要么是 musl 兼容的（进 Alpine），要么被 ABI 守卫拦住（只能在 overlay 里用）
#
# 用法：
#   ./tc-run.sh --dry-run -- apt-get update
#   ./tc-run.sh -- apt-get install -y --no-install-recommends default-jdk
#   ./tc-run.sh --raw -- /bin/bash -lc 'echo $PATH; javac -version'
#   ./tc-run.sh --cwd /workspace/proj -- gradle build
#
# 环境：
#   DSH_TC_ROOT       默认 $DSH_HOME/toolchain/ubuntu
#   DSH_HOME          默认 $HOME/.dsh
#   DSH_WORKSPACE     默认 $HOME/workspace
#   DSH_PROOT         默认 $DSH_HOME/bin/libproot.so
#   DSH_PROOT_LOADER  默认 $DSH_HOME/bin/proot-loader.so
#   DSH_TC_BIND_SYS   1 时额外绑 /sys
#
# 退出码：0 正常；2 参数错；12 overlay/proot 缺；其余透传内层命令
set -u

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DSH_WORKSPACE="${DSH_WORKSPACE:-$HOME/workspace}"
TC_ROOT="${DSH_TC_ROOT:-$DSH_HOME/toolchain/ubuntu}"
DSH_PROOT="${DSH_PROOT:-$DSH_HOME/bin/libproot.so}"
DSH_PROOT_LOADER="${DSH_PROOT_LOADER:-$DSH_HOME/bin/proot-loader.so}"

SANDBOX="workspace-write"
CWD=""
DRY=0
RAW=0
CMD=()

while [ $# -gt 0 ]; do
  case "$1" in
    --rootfs|--tc-root) TC_ROOT="$2"; shift 2 ;;
    --proot) DSH_PROOT="$2"; shift 2 ;;
    --loader) DSH_PROOT_LOADER="$2"; shift 2 ;;
    --cwd) CWD="$2"; shift 2 ;;
    --sandbox) SANDBOX="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --raw) RAW=1; shift ;;
    --) shift; CMD=("$@"); break ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) printf 'tc-run: unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

[ ${#CMD[@]} -eq 0 ] && { printf 'tc-run: 缺少命令（用 -- 分隔）\n' >&2; exit 2; }
case "$SANDBOX" in readonly|workspace-write) ;; *) printf 'tc-run: sandbox 只能是 readonly|workspace-write\n' >&2; exit 2 ;; esac

# ── 依赖检查（缺就 exit 12，不静默回退到宿主） ──────────────────────────
missing=""
[ -d "$TC_ROOT" ] || missing="$missing overlay:$TC_ROOT"
[ -x "$TC_ROOT/usr/bin/apt-get" ] || missing="$missing apt-get"
[ -x "$DSH_PROOT" ] || missing="$missing proot:$DSH_PROOT"
[ -f "$DSH_PROOT_LOADER" ] || missing="$missing proot-loader"
if [ -n "$missing" ]; then
  printf '✗ overlay 不可用:%s\n' "$missing" >&2
  printf '  修复：bash tools/toolchain-overlay/install-overlay.sh\n' >&2
  exit 12
fi

GUEST_CWD="${CWD:-/workspace}"
case "$GUEST_CWD" in /*) ;; *) GUEST_CWD="/workspace" ;; esac

# ── 绑定表：工具链层比运行档多绑一个「产物交换区」 ──────────────────────
BINDS=(
  "-b" "/dev:/dev"
  "-b" "/proc:/proc"
  "-b" "$DSH_HOME:/dsh-home"
)
# deb 层（deb-extract.sh 的产物）：只有目录存在才绑，proot 对不存在的绑定源会直接失败
[ -d "$DSH_HOME/toolchain/deb" ] && BINDS+=("-b" "$DSH_HOME/toolchain/deb:/opt/deb")
[ "${DSH_TC_BIND_SYS:-0}" = "1" ] && BINDS+=("-b" "/sys:/sys")
if [ "$SANDBOX" = "workspace-write" ]; then
  # proot 对不存在的绑定源会直接失败，这里兜一层
  [ -d "$DSH_WORKSPACE" ] || mkdir -p "$DSH_WORKSPACE" 2>/dev/null || true
  BINDS+=("-b" "$DSH_WORKSPACE:/workspace")
fi

# proot 自身的环境（必须在本进程 export）
PROOT_ENVV=(
  "PROOT_NO_SECCOMP=1"
  "PROOT_TMP_DIR=${TMPDIR:-/tmp}"
  "PROOT_LOADER=$DSH_PROOT_LOADER"
)

# guest 内环境：干净起步，且把 apt 的非交互锁死（proot 里没有 tty 时否则会挂）
GUEST_ENVV=(
  "HOME=/root"
  "LANG=C.UTF-8"
  "LC_ALL=C.UTF-8"
  "TERM=${TERM:-xterm-256color}"
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  "DEBIAN_FRONTEND=noninteractive"
  "APT_LISTCHANGES_FRONTEND=none"
  "NEEDRESTART_MODE=a"
  "DSH_TOOLCHAIN_OVERLAY=1"
)

EXTRA=("--link2symlink")
[ -n "${PROOT_KERNEL_RELEASE:-}" ] && EXTRA+=("-k" "$PROOT_KERNEL_RELEASE")
if [ -n "${PROOT_EXTRA_ARGS:-}" ]; then
  # shellcheck disable=SC2206
  EXTRA+=(${PROOT_EXTRA_ARGS})
fi

ARGV=(
  "$DSH_PROOT"
  "-r" "$TC_ROOT"
  "-0"
  "-w" "$GUEST_CWD"
  "${EXTRA[@]}"
  "${BINDS[@]}"
  "--kill-on-exit"
)
if [ "$RAW" = "1" ]; then
  ARGV+=("--" "${CMD[@]}")
else
  ARGV+=("/usr/bin/env" "-i" "${GUEST_ENVV[@]}" "--" "${CMD[@]}")
fi

printf '# overlay=%s sandbox=%s cwd=%s\n' "$TC_ROOT" "$SANDBOX" "$GUEST_CWD"
if [ "$DRY" = "1" ]; then
  printf 'proot-env '; printf '%s ' "${PROOT_ENVV[@]}"; printf '\n'
  [ "$RAW" = "1" ] || { printf 'guest-env '; printf '%s ' "${GUEST_ENVV[@]}"; printf '\n'; }
  printf '%s ' "${ARGV[@]}"; printf '\n'
  exit 0
fi

export "${PROOT_ENVV[@]}"
unset LD_PRELOAD
exec "${ARGV[@]}"
