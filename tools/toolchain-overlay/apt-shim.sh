#!/usr/bin/env bash
# apt-shim.sh —— 在 Alpine 侧造一批「同名 shim」，让 `apt ...` 透明落进 overlay
#
# 为什么需要它：
#   Alpine 没有 apt。但 README / 脚本 / 肌肉记忆里的 `apt install xxx` 改不掉。
#   于是把 apt/apt-get/dpkg 做成外层小脚本：你在 Alpine 敲 apt，它 exec 进 Ubuntu overlay。
#   退出码原样透传；PWD 若在 workspace 子树内，会自动映射成 guest 的 /workspace/...
#
# 用法：
#   bash apt-shim.sh --install                # 装到 $DSH_HOME/toolchain/bin
#   bash apt-shim.sh --install-to /usr/local/bin
#   bash apt-shim.sh --list
#   bash apt-shim.sh --remove
set -u

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
HERE="$(cd "$(dirname "$0")" && pwd)"
TC_RUN="$HERE/tc-run.sh"
CMDS="apt apt-get apt-cache dpkg apt-key"
BIN_DIR="$DSH_HOME/toolchain/bin"
MODE="install"

while [ $# -gt 0 ]; do
  case "$1" in
    --install) MODE="install"; shift ;;
    --install-to) BIN_DIR="$2"; MODE="install"; shift 2 ;;
    --cmds) CMDS="$2"; shift 2 ;;
    --list) MODE="list"; shift ;;
    --remove) MODE="remove"; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) printf 'unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

case "$MODE" in
  list)
    printf 'shim 目录: %s\n' "$BIN_DIR"
    [ -d "$BIN_DIR" ] || { printf '  （不存在）\n'; exit 0; }
    found=0
    for f in "$BIN_DIR"/*; do
      [ -f "$f" ] || continue
      case "$(basename "$f")" in
        apt|apt-get|apt-cache|dpkg|apt-key) printf '  %-10s → %s\n' "$(basename "$f")" "$TC_RUN"; found=1 ;;
      esac
    done
    [ "$found" = "1" ] || printf '  （无 shim）\n'
    exit 0
    ;;
  remove)
    for c in $CMDS; do rm -f "$BIN_DIR/$c"; done
    printf '✓ 已移除 shim: %s\n' "$CMDS"
    exit 0
    ;;
esac

# 用 bash 调起，不强求可执行位（edit 后 mode 会丢）
[ -f "$TC_RUN" ] || { printf '✗ 找不到 tc-run.sh: %s\n' "$TC_RUN" >&2; exit 12; }
mkdir -p "$BIN_DIR"

for c in $CMDS; do
  cat > "$BIN_DIR/$c" <<EOF
#!/usr/bin/env bash
# 由 DSHAPP tools/toolchain-overlay/apt-shim.sh 生成（勿手改）
# 作用：把 \`$c\` 转发进 Ubuntu toolchain overlay；文件路径按 workspace 子树自动映射。
set -u
TC_RUN="\${DSH_TC_RUN:-$TC_RUN}"
WS="\${DSH_WORKSPACE:-\$HOME/workspace}"
SELF="\$(basename "\$0")"

# 宿主 PWD → guest CWD（只有 workspace 子树能看见）
guest="/"
case "\$PWD/" in
  "\$WS"/*) guest="/workspace\${PWD#"\$WS"}" ;;
esac

exec bash "\$TC_RUN" --sandbox workspace-write --cwd "\$guest" -- "\$SELF" "\$@"
EOF
  chmod 0755 "$BIN_DIR/$c"
done

printf '✓ 已装 shim 到 %s\n' "$BIN_DIR"
printf '  命令: %s\n' "$CMDS"
printf '  启用（当前 shell）: export PATH="%s:$PATH"\n' "$BIN_DIR"
printf '  验证: apt-get --version\n'