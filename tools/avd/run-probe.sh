#!/usr/bin/env bash
# run-probe.sh —— 一条命令：起 AVD → 装 x86_64 包 → 跑 ProotProbe → 断言 RESULT=PASS
#
# 用法：
#   bash tools/avd/run-probe.sh [apk路径]
#   AVD_NAME=dsh34 PORT=5556 KEEP=1 bash tools/avd/run-probe.sh     # 保留模拟器不关
#
# 退出码：0 = 四行断言全过；非 0 = 失败，且 out/ 下留下 logcat 与截图。
set -euo pipefail

AVD_NAME="${AVD_NAME:-dsh34}"
PORT="${PORT:-5556}"
SERIAL="emulator-${PORT}"
APK="${1:-app/build/outputs/apk/system/debug/app-system-debug.apk}"
OUT="${OUT:-out/avd-$(date +%Y%m%d-%H%M%S)}"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-420}"
PROBE_TIMEOUT="${PROBE_TIMEOUT:-420}"

if [ -n "${ANDROID_SDK_ROOT:-}" ]; then SDK="$ANDROID_SDK_ROOT"
elif [ -n "${ANDROID_HOME:-}" ]; then SDK="$ANDROID_HOME"
elif [ -d "${LOCALAPPDATA:-}/Android/Sdk" ]; then SDK="$LOCALAPPDATA/Android/Sdk"
else SDK="$HOME/Android/Sdk"; fi
ADB="${ADB:-$SDK/platform-tools/adb}"
EMU="${EMU:-$SDK/emulator/emulator}"
export ANDROID_SDK_ROOT="$SDK" ANDROID_HOME="$SDK"

die() { echo "❌ $*" >&2; dump; exit 1; }

dump() {
  mkdir -p "$OUT"
  echo "== 失败现场 → $OUT"
  "$ADB" -s "$SERIAL" logcat -d 2>/dev/null | tail -200 > "$OUT/logcat.txt" || true
  "$ADB" -s "$SERIAL" exec-out screencap -p > "$OUT/screen.png" 2>/dev/null || true
  "$ADB" -s "$SERIAL" shell run-as com.dsh.android cat files/proot-probe.txt > "$OUT/proot-probe.txt" 2>/dev/null || true
  ls -l "$OUT" || true
}

[ -f "$APK" ] || die "找不到 APK：$APK（先出包：gradlew :app:assembleSystemDebug -PtargetAbi=x86_64）"
[ -x "$EMU" ] || [ -f "$EMU.exe" ] || die "找不到 emulator：$EMU（先跑 tools/avd/create-avd.sh）"

mkdir -p "$OUT"
echo "== 启动 AVD $AVD_NAME（:$PORT）"
"$EMU" -avd "$AVD_NAME" -port "$PORT" -no-window -no-audio -no-snapshot -no-boot-anim \
  -gpu swiftshader_indirect > "$OUT/emulator.log" 2>&1 &
EMU_PID=$!
trap 'kill $EMU_PID 2>/dev/null || true' EXIT

echo "== 等待开机（最多 ${BOOT_TIMEOUT}s）"
"$ADB" start-server >/dev/null 2>&1 || true
DEADLINE=$(( $(date +%s) + BOOT_TIMEOUT ))
until [ "$("$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
  [ "$(date +%s)" -lt "$DEADLINE" ] || die "开机超时（${BOOT_TIMEOUT}s）"
  kill -0 $EMU_PID 2>/dev/null || die "emulator 进程已退出，见 $OUT/emulator.log"
  sleep 3
done
"$ADB" -s "$SERIAL" shell settings put global window_animation_scale 0 || true
"$ADB" -s "$SERIAL" shell settings put global transition_animation_scale 0 || true
"$ADB" -s "$SERIAL" shell settings put global animator_duration_scale 0 || true
echo "✅ 开机完成：$( "$ADB" -s "$SERIAL" shell getprop ro.product.cpu.abi | tr -d '\r' )"

echo "== 安装 $APK"
"$ADB" -s "$SERIAL" install -r -t "$APK" > "$OUT/install.txt" 2>&1 || die "安装失败（$OUT/install.txt）"
grep -q Success "$OUT/install.txt" || die "install 未返回 Success"

echo "== 打开探针开关并启动 ProotProbeActivity"
"$ADB" -s "$SERIAL" shell run-as com.dsh.android mkdir -p files
"$ADB" -s "$SERIAL" shell run-as com.dsh.android touch files/proot-probe.enable
"$ADB" -s "$SERIAL" shell run-as com.dsh.android rm -f files/proot-probe.txt || true
# NEW_TASK|CLEAR_TASK：否则旧 MainActivity task 会被恢复，引擎把探针顶掉（0x10008000）
"$ADB" -s "$SERIAL" shell am start -W -f 0x10008000 -n com.dsh.android/.runtime.ProotProbeActivity > "$OUT/amstart.txt" 2>&1 || die "am start 失败"

echo "== 等待探针结果（最多 ${PROBE_TIMEOUT}s）"
DEADLINE=$(( $(date +%s) + PROBE_TIMEOUT ))
RESULT=""
until $( "$ADB" -s "$SERIAL" shell run-as com.dsh.android test -f files/proot-probe.txt && echo true || echo false ) | grep -q true; do
  [ "$(date +%s)" -lt "$DEADLINE" ] || die "探针超时（${PROBE_TIMEOUT}s），可能 TOKEN_TIMEOUT"
  sleep 3
done
RESULT="$("$ADB" -s "$SERIAL" shell run-as com.dsh.android cat files/proot-probe.txt | tr -d '\r')"
printf '%s\n' "$RESULT" | tee "$OUT/proot-probe.txt"
echo "----"

fail=0
for want in "health=PASS" "stopped=true" "leftover_node=0" "RESULT=PASS"; do
  if printf '%s\n' "$RESULT" | grep -qx "$want"; then echo "  ✅ $want"; else echo "  ❌ $want"; fail=1; fi
done

if [ "$fail" -ne 0 ]; then dump; exit 1; fi

echo "✅ RESULT=PASS（${OUT}）"
[ "${KEEP:-0}" = "1" ] || { "$ADB" -s "$SERIAL" emu kill >/dev/null 2>&1 || true; }
