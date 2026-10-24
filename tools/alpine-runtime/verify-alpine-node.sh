#!/usr/bin/env bash
# verify-alpine-node.sh —— 断言 Alpine rootfs 里的 nodejs 主版本符合 DSH 要求
#
# 为什么需要它：Alpine 的 `nodejs` 包版本随分支走（3.20=20，3.21=22，3.23=24）。
# 装错分支时 apk 不会报错，但 DSH 启动会直接失败（engines: ^22.19 || >=24）。
# 所以在打包前读 apk 数据库做断言，而不是等设备上炸。
#
# 用法：
#   ./verify-alpine-node.sh <rootfs-dir> [min-major]
#   ./verify-alpine-node.sh out/rootfs 22
#
# 退出码：0 通过；1 不满足；2 参数/结构错
set -u

ROOT="${1:-}"
MIN="${2:-22}"

if [ -z "$ROOT" ]; then
  printf 'usage: %s <rootfs-dir> [min-major]\n' "$0" >&2
  exit 2
fi
if [ ! -d "$ROOT" ]; then
  printf '✗ rootfs 不存在: %s\n' "$ROOT" >&2
  exit 2
fi

DB="$ROOT/lib/apk/db/installed"
if [ ! -f "$DB" ]; then
  printf '✗ 找不到 apk 数据库: %s\n' "$DB" >&2
  exit 2
fi

VER="$(
  awk '
    BEGIN { RS = ""; FS = "\n" }
    {
      p = ""; v = "";
      for (i = 1; i <= NF; i++) {
        if (substr($i, 1, 2) == "P:") p = substr($i, 3);
        if (substr($i, 1, 2) == "V:") v = substr($i, 3);
      }
      if (p == "nodejs") { print v; exit }
    }
  ' "$DB"
)"

if [ -z "$VER" ]; then
  printf '✗ apk 数据库里没有 nodejs（安装阶段失败？）\n' >&2
  exit 1
fi

MAJOR="${VER%%.*}"
case "$MAJOR" in
  ''|*[!0-9]*)
    printf '✗ 无法解析 nodejs 版本: %s\n' "$VER" >&2
    exit 1
    ;;
esac

if [ "$MAJOR" -lt "$MIN" ]; then
  printf '✗ nodejs %s 主版本 %s < 要求 %s（DSH 需要 ^22.19 || >=24）\n' "$VER" "$MAJOR" "$MIN" >&2
  printf '  修法：把 packages 里的 nodejs 换成 nodejs~24，或换更新的 Alpine 分支\n' >&2
  exit 1
fi

NODE_BIN="$ROOT/usr/bin/node"
if [ ! -f "$NODE_BIN" ]; then
  printf '✗ 缺少 %s（包装了但可执行文件不在？）\n' "$NODE_BIN" >&2
  exit 1
fi
if [ ! -x "$NODE_BIN" ]; then
  printf '! %s 没有执行位，设备侧解包后需要 chmod 755\n' "$NODE_BIN" >&2
fi

printf '✓ Alpine nodejs %s（主版本 %s ≥ %s），%s 就位\n' "$VER" "$MAJOR" "$MIN" "$NODE_BIN"
exit 0