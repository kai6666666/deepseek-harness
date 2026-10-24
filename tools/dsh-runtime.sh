#!/usr/bin/env bash
# dsh-runtime.sh —— 运行时总控（唯一入口，把散落的脚本收成 5 个动词）
#
#   ./dsh-runtime.sh status          档位 + 三层 + 体积，一屏看全
#   ./dsh-runtime.sh doctor          依赖体检，缺什么给什么修复命令
#   ./dsh-runtime.sh up alpine       切运行档（代理 backend-select.mjs）
#   ./dsh-runtime.sh run -- node -v  透传进运行档（代理 proot-launch.sh）
#   ./dsh-runtime.sh verify          全量验收：runtime → 补丁 → 工具链
#   ./dsh-runtime.sh gc [--all]      清缓存；--all 连 overlay/deb 一起删（需 --yes）
#
# 退出码：0 正常；1 体检有 FAIL；2 参数错
set -u

TOOLS="$(cd "$(dirname "$0")" && pwd)"
ALPINE="$TOOLS/alpine-runtime"
TC="$TOOLS/toolchain-overlay"

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DSH_WORKSPACE="${DSH_WORKSPACE:-$HOME/workspace}"
DSH_ALPINE_ROOTFS="${DSH_ALPINE_ROOTFS:-$DSH_HOME/alpine}"
CACHE="$DSH_HOME/toolchain/cache/archives"
OVERLAY="${DSH_TC_ROOT:-$DSH_HOME/toolchain/ubuntu}"
DEBROOT="${DSH_DEB_ROOT:-$DSH_HOME/toolchain/deb}"
ENGINE="$DSH_HOME/engine"

mb() { local v; v="$(du -sm "$1" 2>/dev/null | cut -f1)"; printf '%s' "${v:-0}"; }
# n_of <dir> [find 谓词...]：谓词必须作为独立参数传，别把 "-maxdepth 1" 塞成一个字符串
n_of() { local d="$1"; shift; find "$d" "$@" 2>/dev/null | wc -l | tr -d ' '; }
has() { [ -e "$1" ] && printf '✓' || printf '✗'; }

cmd="${1:-status}"
shift || true

case "$cmd" in
  status)
    printf '=== 运行档\n'
    if [ -f "$DSH_HOME/backend.json" ] && command -v node >/dev/null 2>&1; then
      node -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log("  backend     :",s.backend||"(空)","  updatedAt:",s.updatedAt||"-")}catch(e){console.log("  backend     : 解析失败")}' "$DSH_HOME/backend.json"
    else
      printf '  backend     : (未设置，运行时自动探测)\n'
    fi
    printf '  DSH_HOME    : %s\n' "$DSH_HOME"
    printf '  workspace   : %s\n' "$DSH_WORKSPACE"
    printf '\n=== 三层\n'
    printf '  %s alpine rootfs  %-46s %s MB\n' "$(has "$DSH_ALPINE_ROOTFS/usr/bin/node")" "$DSH_ALPINE_ROOTFS" "$(mb "$DSH_ALPINE_ROOTFS")"
    printf '  %s proot          %-46s\n' "$(has "$DSH_HOME/bin/libproot.so")" "$DSH_HOME/bin/libproot.so"
    printf '  %s proot-loader   %-46s\n' "$(has "$DSH_HOME/bin/proot-loader.so")" "$DSH_HOME/bin/proot-loader.so"
    printf '  %s overlay(apt)   %-46s %s MB\n' "$(has "$OVERLAY/usr/bin/apt-get")" "$OVERLAY" "$(mb "$OVERLAY")"
    printf '  %s deb 层         %-46s pkgs=%s bins=%s %s MB\n' \
      "$(has "$DEBROOT")" "$DEBROOT" "$(n_of "$DEBROOT/pkgs" -maxdepth 1)" "$(n_of "$DEBROOT/bin" -maxdepth 1)" "$(mb "$DEBROOT")"
    printf '  %s engine         %-46s .node=%s %s MB\n' \
      "$(has "$ENGINE/node_modules")" "$ENGINE" "$(n_of "$ENGINE" -name '*.node')" "$(mb "$ENGINE")"
    printf '\n=== 磁盘\n'
    printf '  apt 缓存        %s MB  (%s)\n' "$(mb "$CACHE")" "$CACHE"
    total=$(( $(mb "$DSH_ALPINE_ROOTFS") + $(mb "$OVERLAY") + $(mb "$DEBROOT") + $(mb "$ENGINE") ))
    printf '  运行时合计      %s MB\n' "$total"
    ;;

  doctor)
    fail=0
    chk() { # chk 说明 路径 [f]
      if [ -e "$2" ]; then printf '  ✓ %-22s %s\n' "$1" "$2"
      else printf '  ✗ %-22s %s\n' "$1" "$2"; fail=$((fail+1)); fi
    }
    printf '=== 依赖体检\n'
    chk proot "$DSH_HOME/bin/libproot.so"
    chk proot-loader "$DSH_HOME/bin/proot-loader.so"
    chk alpine-node "$DSH_ALPINE_ROOTFS/usr/bin/node"
    printf '  %s %-22s %s\n' "$(has "$DSH_HOME/patches/manifest.json")" "补丁清单" "$DSH_HOME/patches/manifest.json"
    printf '  %s %-22s %s\n' "$(has "$TOOLS/apply-patches.mjs")" "补丁执行器" "$TOOLS/apply-patches.mjs"
    [ "$fail" -eq 0 ] || printf '\n修复：\n  DSH_ALPINE_ROOTFS 缺失 → bash %s/install-overlay.sh 前先烘焙 rootfs（见 alpine-runtime/README.md）\n' "$TC"
    if [ -x "$OVERLAY/usr/bin/apt-get" ]; then
      printf '\n=== 工具链层\n'
      bash "$TC/verify-toolchain.sh" --overlay 2>/dev/null | sed 's/^/  /' || fail=$((fail+1))
    else
      printf '\n  · overlay 未安装（需要 apt 时再装）: bash %s/install-overlay.sh\n' "$TC"
    fi
    [ "$fail" -eq 0 ] && exit 0 || exit 1
    ;;

  up)
    dest="${1:-alpine}"
    case "$dest" in alpine|termux) ;; *) printf 'up 只接受 alpine|termux\n' >&2; exit 2 ;; esac
    exec node "$ALPINE/backend-select.mjs" switch "$dest"
    ;;

  run)
    [ "${1:-}" = "--" ] && shift
    [ $# -gt 0 ] || { printf 'run 需要 -- 之后跟命令\n' >&2; exit 2; }
    exec bash "$ALPINE/proot-launch.sh" -- "$@"
    ;;

  verify)
    # 注意：不能用 `script | tail`——$? 会变成 tail 的退出码，体检永远"通过"（假绿）
    vtmp="$(mktemp -d "${TMPDIR:-/tmp}/dshv.XXXXXX")"
    trap 'rm -rf "$vtmp"' EXIT
    printf '=== 1/3 运行档\n'
    bash "$ALPINE/verify-rootfs.sh" > "$vtmp/1" 2>&1; r1=$?; tail -20 "$vtmp/1"
    printf '\n=== 2/3 补丁与 DSH 兼容\n'
    bash "$TOOLS/verify-dsh-compat.sh" > "$vtmp/2" 2>&1; r2=$?; tail -18 "$vtmp/2"
    printf '\n=== 3/3 工具链\n'
    bash "$TC/verify-toolchain.sh" > "$vtmp/3" 2>&1; r3=$?; tail -20 "$vtmp/3"
    printf '\n汇总: runtime=%s compat=%s toolchain=%s\n' "$r1" "$r2" "$r3"
    [ "$r1" = 0 ] && [ "$r2" = 0 ] && [ "$r3" = 0 ] && exit 0 || exit 1
    ;;

  gc)
    all=0; yes=0
    for a in "$@"; do
      case "$a" in --all) all=1 ;; --yes|-y) yes=1 ;; esac
    done
    printf '=== 清缓存\n'
    n=$(ls -1 "$CACHE" 2>/dev/null | grep -c '\.deb$' || true)
    printf '  apt 缓存 %s 个 deb，%s MB\n' "${n:-0}" "$(mb "$CACHE")"
    rm -f "$CACHE"/*.deb 2>/dev/null || true
    rm -rf "${TMPDIR:-/tmp}"/tc.* "${TMPDIR:-/tmp}"/deb.* 2>/dev/null || true
    printf '  ✓ 已清\n'
    if [ "$all" = "1" ]; then
      if [ "$yes" != "1" ]; then
        printf '\n--all 会删除：\n  %s\n  %s\n' "$OVERLAY" "$DEBROOT"
        printf '确认请重跑： bash %s gc --all --yes\n' "$0"
        exit 0
      fi
      rm -rf "$OVERLAY" "$DEBROOT"
      printf '  ✓ 已删 overlay 与 deb 层（Alpine 档不受影响）\n'
    fi
    ;;

  *)
    sed -n '2,14p' "$0"; exit 2 ;;
esac