#!/data/data/com.dsh.android/files/termux/usr/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# dsh-env.sh —— DSH 内置 Termux 环境的一键体检 / 安装（对齐 Operit 的「环境配置」六项）
#
# 背景：DSH 没有照搬 Operit 那套「环境配置」界面，但**底座是一样的** ——
#   打包进来的 Termux bootstrap（240 MB / 400 个二进制）自带 apt + dpkg，
#   sources.list 指向 USTC Termux 仓，pip.conf 指向国内 PyPI 镜像。
#   所以 Node 之外的 Python / SSH / Java / Rust / Go 都能一条 apt 装好。
#
# 用法（app 身份）：
#   run-as com.dsh.android sh -c 'files/termux/usr/bin/bash tools/dsh-env.sh status'
#   run-as com.dsh.android sh -c 'files/termux/usr/bin/bash tools/dsh-env.sh install python ssh'
#   run-as com.dsh.android sh -c 'files/termux/usr/bin/bash tools/dsh-env.sh install all'
#
# 注意：
#   * **node 不在 apt 安装列表里** —— DSH 用的是自带 node-runtime（26.12.1），
#     装 nodejs 反而会和它抢 $PREFIX/bin/node。
#   * 装 Java / Rust / Go 体积较大（每个 100–300 MB 解压后），先看 status 再决定。
#   * 所有操作在 app 私有目录内，卸载应用会一起消失。
# ─────────────────────────────────────────────────────────────────────────────

set -u

FILES="${DSH_FILES:-/data/user/0/com.dsh.android/files}"
PREFIX="${PREFIX:-$FILES/termux/usr}"
export PREFIX
export HOME="${HOME:-$FILES/termux/home}"
export TMPDIR="$PREFIX/tmp"
export PATH="$PREFIX/bin:$PATH"
export LD_LIBRARY_PATH="$PREFIX/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

say() { printf '%s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

ver() {
    # 取版本号；命令缺席时返回空
    case "$1" in
        node)   have node   && node -v 2>/dev/null ;;
        python) have python3 && python3 -V 2>/dev/null ;;
        pip)    have pip     && pip --version 2>/dev/null | awk '{print $2}' ;;
        ssh)    have ssh    && ssh -V 2>&1 | head -1 ;;
        java)   have java   && java -version 2>&1 | head -1 ;;
        rustc)  have rustc  && rustc --version 2>/dev/null ;;
        cargo)  have cargo  && cargo --version 2>/dev/null ;;
        go)     have go     && go version 2>/dev/null ;;
    esac
}

status_one() {
    local name="$1" bin="$2" v
    v="$(ver "$name")"
    if [ -n "$v" ]; then
        say "$(printf '%-8s ✅ %s' "$name" "$v")"
    else
        say "$(printf '%-8s ❌ 未安装（bin=%s）' "$name" "$bin")"
    fi
}

cmd_status() {
    say "── DSH 环境体检 ──────────────────────────────"
    say "PREFIX = $PREFIX"
    say "磁盘   = $(du -sh "$FILES/termux" 2>/dev/null | awk '{print $1}')"
    say ""
    status_one node   "$PREFIX/bin/node"
    status_one python "$PREFIX/bin/python3"
    status_one pip    "$PREFIX/bin/pip"
    status_one ssh    "$PREFIX/bin/ssh"
    status_one java   "$PREFIX/bin/java"
    status_one rustc  "$PREFIX/bin/rustc"
    status_one cargo  "$PREFIX/bin/cargo"
    status_one go     "$PREFIX/bin/go"
    say ""
    say "apt 源：$(head -1 "$PREFIX/etc/apt/sources.list" 2>/dev/null)"
}

need_rootfs() {
    if [ ! -x "$PREFIX/bin/apt-get" ]; then
        say "✗ 找不到 $PREFIX/bin/apt-get —— bootstrap 没装好，先让 App 正常启动一次"
        exit 1
    fi
}

apt_do() {
    need_rootfs
    say "→ apt-get update"
    apt-get update -y 2>&1 | tail -2
    say "→ apt-get install -y $*"
    apt-get install -y "$@" 2>&1 | tail -6
}

cmd_install() {
    [ "$#" -gt 0 ] || { say "用法: dsh-env.sh install <python|ssh|java|rust|go|all>..."; exit 2; }
    local pkgs=()
    for want in "$@"; do
        case "$want" in
            python) pkgs+=(python) ;;
            ssh)    pkgs+=(openssh) ;;
            java)   pkgs+=(openjdk-17) ;;
            rust)   pkgs+=(rust) ;;
            go)     pkgs+=(golang) ;;
            node)   say "· node 是内建运行时，跳过（装 nodejs 会抢 \$PREFIX/bin/node）" ;;
            all)    pkgs+=(python openssh openjdk-17 rust golang) ;;
            *)      say "✗ 不认识的目标: $want"; exit 2 ;;
        esac
    done
    if [ "${#pkgs[@]}" -eq 0 ]; then
        say "没有要装的东西。"
        return 0
    fi
    apt_do "${pkgs[@]}"
    say ""
    cmd_status
}

case "${1:-status}" in
    status)  cmd_status ;;
    install) shift; cmd_install "$@" ;;
    *)       say "用法: dsh-env.sh [status|install <python|ssh|java|rust|go|all>...]"; exit 2 ;;
esac
