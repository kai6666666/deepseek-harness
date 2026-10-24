#!/usr/bin/env bash
# proot-launch.sh —— Alpine 档启动链（单入口，双档可切）
#
# 用法：
#   ./proot-launch.sh --dry-run -- --version
#   ./proot-launch.sh --sandbox workspace-write -- node --version
#   ./proot-launch.sh --backend termux -- node --version        # 直通，不套 proot
#   ./proot-launch.sh --backend alpine --cwd /workspace -- \
#       /usr/bin/node /dsh-home/engine/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --no-open
#
# 环境（都有默认值，先看 backend-select.mjs 的 resolve 输出）：
#   DSH_HOME          默认 $HOME/.dsh
#   DSH_WORKSPACE     默认 $HOME/workspace
#   DSH_ALPINE_ROOTFS 默认 $DSH_HOME/alpine
#   DSH_PROOT         默认 $DSH_HOME/bin/libproot.so（或 PATH 里的 proot）
#   DSH_PROOT_LOADER  默认 $DSH_HOME/bin/proot-loader.so
#
# 退出码：0 正常；2 参数错；3 依赖缺失且 --strict；12 档位不可用
set -u

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DSH_WORKSPACE="${DSH_WORKSPACE:-$HOME/workspace}"
DSH_ALPINE_ROOTFS="${DSH_ALPINE_ROOTFS:-$DSH_HOME/alpine}"
DSH_PROOT="${DSH_PROOT:-$DSH_HOME/bin/libproot.so}"
DSH_PROOT_LOADER="${DSH_PROOT_LOADER:-$DSH_HOME/bin/proot-loader.so}"

BACKEND=""
SANDBOX="workspace-write"
CWD=""
STRICT=0
DRY=0
CMD=()

while [ $# -gt 0 ]; do
  case "$1" in
    --backend) BACKEND="$2"; shift 2 ;;
    --sandbox) SANDBOX="$2"; shift 2 ;;
    --cwd) CWD="$2"; shift 2 ;;
    --rootfs) DSH_ALPINE_ROOTFS="$2"; shift 2 ;;
    --proot) DSH_PROOT="$2"; shift 2 ;;
    --strict) STRICT=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --) shift; CMD=("$@"); break ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) printf 'unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

[ ${#CMD[@]} -eq 0 ] && { printf '缺少要执行的命令（用 -- 分隔）\n' >&2; exit 2; }
case "$SANDBOX" in readonly|workspace-write) ;; *) printf 'sandbox 只能是 readonly|workspace-write\n' >&2; exit 2 ;; esac

say() { printf '%s\n' "$*"; }

# ── 档位解析：显式传入 > backend.json > 自动探测 ──────────────────────
resolve_backend() {
  if [ -n "$BACKEND" ]; then printf '%s' "$BACKEND"; return; fi
  if [ -f "$DSH_HOME/backend.json" ] && command -v node >/dev/null 2>&1; then
    node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).backend||"")}catch{}' \
      "$DSH_HOME/backend.json" 2>/dev/null | grep -E '^(alpine|termux)$' && return
  fi
  if [ -x "$DSH_ALPINE_ROOTFS/usr/bin/node" ] && [ -x "$DSH_PROOT" ]; then
    printf 'alpine'
  else
    printf 'termux'
  fi
}

[ -z "$BACKEND" ] && BACKEND="$(resolve_backend)"
case "$BACKEND" in alpine|termux) ;; *) printf '未知档位: %s\n' "$BACKEND" >&2; exit 12 ;; esac

# ── termux 档：直通，不加任何拦截 ─────────────────────────────────────
if [ "$BACKEND" = "termux" ]; then
  say "# backend=termux（直通，bionic 原生）"
  if [ "$DRY" = "1" ]; then
    printf 'exec %s\n' "$(printf '%q ' "${CMD[@]}")"
    exit 0
  fi
  cd "${CWD:-$PWD}" 2>/dev/null || true
  exec "${CMD[@]}"
fi

# ── alpine 档：proot 单次 exec，内层程序由 proot 用户态加载 ────────────
missing=""
[ -x "$DSH_ALPINE_ROOTFS/usr/bin/node" ] || missing="$missing rootfs:node"
[ -x "$DSH_PROOT" ] || missing="$missing proot"
[ -f "$DSH_PROOT_LOADER" ] || missing="$missing proot-loader"

if [ -n "$missing" ]; then
  if [ "$STRICT" = "1" ]; then
    printf '✗ alpine 档缺依赖:%s\n' "$missing" >&2
    exit 12
  fi
  say "# ⚠ alpine 档缺依赖:$missing → 回退 termux（--strict 可禁止）"
  printf 'exec %s\n' "$(printf '%q ' "${CMD[@]}")"
  [ "$DRY" = "1" ] && exit 0
  cd "${CWD:-$PWD}" 2>/dev/null || true
  exec "${CMD[@]}"
fi

GUEST_CWD="${CWD:-/workspace}"
case "$GUEST_CWD" in /*) ;; *) GUEST_CWD="/workspace" ;; esac

# ── 绑定表：proot -r 之后宿主根默认不可见，这里就是"白名单" ───────────
# 注意：proot 的 -b 没有 :ro 选项。readonly 档的正确语义是「不绑定 workspace」，
#       而不是「绑定成只读」——guest 里看不到它，本身就是最硬的只读。
# /sys 在部分设备不可读，绑定失败会让 proot 直接退出，所以默认不绑（需要时 PROOT_BIND_SYS=1）。
BINDS=(
  "-b" "/dev:/dev"
  "-b" "/proc:/proc"
  "-b" "$DSH_HOME:/dsh-home"
)
# deb 层（tools/toolchain-overlay/deb-extract.sh 产物）：存在才绑，两档共用同一出口
[ -d "$DSH_HOME/toolchain/deb" ] && BINDS+=("-b" "$DSH_HOME/toolchain/deb:/opt/deb")
[ "${PROOT_BIND_SYS:-0}" = "1" ] && BINDS+=("-b" "/sys:/sys")
if [ "$SANDBOX" = "workspace-write" ]; then
  BINDS+=("-b" "$DSH_WORKSPACE:/workspace")
fi

# proot 自己的环境变量：必须在 proot 进程环境里，不能塞进 guest 的 env -i
PROOT_ENVV=(
  "PROOT_NO_SECCOMP=1"
  "PROOT_TMP_DIR=${TMPDIR:-/tmp}"
  "PROOT_LOADER=$DSH_PROOT_LOADER"
)
# guest 内的环境（干净起步，避免把宿主 bionic 路径带进去）
GUEST_ENVV=(
  "HOME=/root"
  "LANG=C.UTF-8"
  "TERM=${TERM:-xterm-256color}"
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  "DSH_GUEST=1"
)

# ── 额外 proot 参数 ──────────────────────────────────────────────────
# 默认加 --link2symlink：npm/pnpm 在 proot 里装包常依赖硬链接，proot 需要一个
# 用户态转译层；不需要时设 PROOT_NO_LINK2SYMLINK=1。
EXTRA=()
[ "${PROOT_NO_LINK2SYMLINK:-0}" != "1" ] && EXTRA+=("--link2symlink")
# 包管理器/运行时可能用 uname 判断系统，覆盖成常见内核版本，避免落到奇怪分支
[ -n "${PROOT_KERNEL_RELEASE:-}" ] && EXTRA+=("-k" "$PROOT_KERNEL_RELEASE")
# 追加自定义参数（空格分词）
if [ -n "${PROOT_EXTRA_ARGS:-}" ]; then
  # shellcheck disable=SC2206
  EXTRA+=(${PROOT_EXTRA_ARGS})
fi

ARGV=(
  "$DSH_PROOT"
  "-r" "$DSH_ALPINE_ROOTFS"
  "-0"
  "-w" "$GUEST_CWD"
  "${EXTRA[@]}"
  "${BINDS[@]}"
  "--kill-on-exit"
  "/usr/bin/env" "-i" "${GUEST_ENVV[@]}"
  "--"
  "${CMD[@]}"
)

say "# backend=alpine sandbox=$SANDBOX rootfs=$DSH_ALPINE_ROOTFS cwd=$GUEST_CWD"
if [ "$DRY" = "1" ]; then
  printf 'proot-env '; printf '%s ' "${PROOT_ENVV[@]}"; printf '\n'
  printf 'guest-env '; printf '%s ' "${GUEST_ENVV[@]}"; printf '\n'
  printf '%s ' "${ARGV[@]}"; printf '\n'
  exit 0
fi

# proot 自己的环境变量必须 export 到本进程，否则它会用默认 loader / 开 seccomp
export "${PROOT_ENVV[@]}"
# 宿主可能已经设了 LD_PRELOAD（liblinkcompat / boosandbox），带进 proot 会污染 guest
unset LD_PRELOAD
exec "${ARGV[@]}"
