#!/usr/bin/env bash
# verify-rc3-device.sh —— 宿主侧验收（0.2.2-rc.3-debug / PRoot 单运行时）
#
# 为什么需要它：rootfs 的 /usr/bin/node 是 glibc ELF，Android 侧没有
# /lib/ld-linux-aarch64.so.1，`run-as sh -c '<rootfs>/usr/bin/node x.mjs'` 必然
# ENOENT（报错指向加载器，不指向文件）。设备侧只能由 App 在 proot 内执行。
#
# 用法：
#   ./tools/verify-rc3-device.sh              # 完整验收
#   ADB="adb -s 127.0.0.1:5666" ./tools/verify-rc3-device.sh   # guest
#   TIMEOUT=300 ./tools/verify-rc3-device.sh  # 冷启动慢时放宽
#
# 退出码：0 = RESULT=PASS；1 = FAIL；2 = 环境问题（无设备/无 adb/包未装）。
set -uo pipefail

ADB=${ADB:-adb}
PKG=${PKG:-com.dsh.android}
TIMEOUT=${TIMEOUT:-240}
DRIVER_LOCAL="$(cd "$(dirname "$0")" && pwd)/proot-verify-driver.cjs"
R="/data/user/0/$PKG/files"
GUEST_DRIVER="$R/home/.dsh/proot-verify-driver.cjs"
PROBE="$R/proot-probe.txt"

say() { printf '%s\n' "$*"; }
die() { printf '[ERROR] %s\n' "$*" >&2; exit 2; }

command -v "$ADB" >/dev/null 2>&1 || die "找不到 adb"
[ -f "$DRIVER_LOCAL" ] || die "缺 driver：$DRIVER_LOCAL"

SER=$($ADB devices | awk 'NR==2{print $1}')
[ -n "${SER:-}" ] || die "没有已连接设备"

$ADB shell pm path "$PKG" >/dev/null 2>&1 || die "$PKG 未安装"

say "== 1/4 推送 driver 到 guest 可见路径"
$ADB push "$DRIVER_LOCAL" /data/local/tmp/proot-verify-driver.cjs >/dev/null || die "push 失败"
# 走 stdin 重定向，避免 `run-as sh -c '...'` 的双层引号
$ADB shell "run-as $PKG sh -c 'mkdir -p files/home/.dsh && cat > files/home/.dsh/proot-verify-driver.cjs'" \
  < "$DRIVER_LOCAL" || die "写入 $GUEST_DRIVER 失败"

say "== 2/4 清理旧回执 + 触发探针"
$ADB shell "run-as $PKG rm -f files/proot-probe.txt" >/dev/null 2>&1
$ADB shell am start -n "$PKG/.runtime.ProotProbeActivity" \
  --es run_script "$GUEST_DRIVER" >/dev/null 2>&1 || die "am start 失败（Activity 未导出时应仍可被 shell 拉起）"

say "== 3/4 轮询回执（上限 ${TIMEOUT}s）"
OUT=""
i=0
while [ "$i" -lt $((TIMEOUT / 2)) ]; do
  i=$((i + 1))
  sleep 2
  OUT=$($ADB shell "run-as $PKG cat files/proot-probe.txt" 2>/dev/null | tr -d '\r')
  case "$OUT" in
    *RESULT=*) break ;;
  esac
done

say "== 4/4 结果"
say "$OUT"
say "----"
case "$OUT" in
  *RESULT=PASS*) say "DEVICE VERIFY PASS"; exit 0 ;;
  *RESULT=FAIL*) say "DEVICE VERIFY FAIL"; exit 1 ;;
  *) say "DEVICE VERIFY TIMEOUT（${TIMEOUT}s 内无 RESULT，检查 App 是否在前台 / rootfs 是否已解包）"; exit 1 ;;
esac