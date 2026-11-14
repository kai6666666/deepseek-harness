#!/usr/bin/env bash
# create-avd.sh —— 从零准备 x86_64 回归用 AVD（Google APIs / API 34）
#
# 为什么用 Google APIs 镜像：雷电/MuMu 的镜像拒绝 ptrace(TRACEME)，PRoot 起不来；
# 只有 Google APIs 的 x86_64 AVD 能跑通 proot（见 docs/plan/evidence/s5-device-20261113.md）。
#
# 用法：
#   bash tools/avd/create-avd.sh                 # 装缺失的包 + 建 AVD dsh34
#   AVD_NAME=dsh35 API=35 bash tools/avd/create-avd.sh
set -euo pipefail

AVD_NAME="${AVD_NAME:-dsh34}"
API="${API:-34}"
ABI="${ABI:-x86_64}"
IMAGE="system-images;android-${API};google_apis;${ABI}"

# ── SDK 定位 ────────────────────────────────────────────────────────────────
if [ -n "${ANDROID_SDK_ROOT:-}" ]; then SDK="$ANDROID_SDK_ROOT"
elif [ -n "${ANDROID_HOME:-}" ]; then SDK="$ANDROID_HOME"
elif [ -d "${LOCALAPPDATA:-}/Android/Sdk" ]; then SDK="$LOCALAPPDATA/Android/Sdk"
else SDK="$HOME/Android/Sdk"; fi
export ANDROID_SDK_ROOT="$SDK" ANDROID_HOME="$SDK"
echo "SDK: $SDK"

# ⚠️ 不要在函数里再按名字调自己（会自递归：command -v 会命中函数本身）
sdkmanager() {
  local bin
  for bin in "$SDK/cmdline-tools/latest/bin/sdkmanager" \
             "$SDK/cmdline-tools/latest/bin/sdkmanager.bat" \
             "$SDK/tools/bin/sdkmanager"; do
    [ -x "$bin" ] && { "$bin" "$@"; return $?; }
  done
  return 127
}
avdmanager() {
  local bin
  for bin in "$SDK/cmdline-tools/latest/bin/avdmanager" \
             "$SDK/cmdline-tools/latest/bin/avdmanager.bat" \
             "$SDK/tools/bin/avdmanager"; do
    [ -x "$bin" ] && { "$bin" "$@"; return $?; }
  done
  return 127
}

# ── 缺 cmdline-tools 就装一份 ───────────────────────────────────────────────
if ! sdkmanager --version >/dev/null 2>&1; then
  echo "== 安装 cmdline-tools"
  mkdir -p "$SDK/cmdline-tools"
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  if [ "$(uname -s)" = "Linux" ] || [ "$(uname -s)" = "Darwin" ]; then
    URL="https://dl.google.com/android/repository/commandlinetools-$( [ "$(uname -s)" = "Darwin" ] && echo mac || echo linux )-13114758_latest.zip"
  else
    URL="https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip"
  fi
  curl -fsSL -o "$TMP/clt.zip" "$URL"
  # unzip 不一定有（Git Bash 默认没带）：python3 → PowerShell 依次兜底
  if command -v unzip >/dev/null 2>&1; then
    ( cd "$TMP" && unzip -q clt.zip )
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$TMP/clt.zip" "$TMP"
  else
    powershell.exe -NoProfile -Command "Expand-Archive -LiteralPath '$TMP\\clt.zip' -DestinationPath '$TMP' -Force"
  fi
  rm -rf "$SDK/cmdline-tools/latest"
  mv "$TMP/cmdline-tools" "$SDK/cmdline-tools/latest"
fi

# ── 装包（幂等：已装的会跳过）──────────────────────────────────────────────
# 幂等：CI 上 setup-android 已经把包装好了，这里再跑 sdkmanager 只会白等
if [ -x "$SDK/emulator/emulator" ] && [ -d "$SDK/system-images/android-${API}/google_apis/${ABI}" ]; then
  echo "== 包已就绪，跳过 sdkmanager（emulator + ${IMAGE}）"
else
echo "== 安装 platform-tools / emulator / platforms;android-${API} / ${IMAGE}"
yes | sdkmanager --licenses >/dev/null 2>&1 || true
# ⚠️ 两件事：
#   1) sdkmanager 遇到未接受的许可会停下来等输入 → CI 里表现为「步骤永远 running」，所以喂 yes；
#   2) `yes | sdkmanager` 里 sdkmanager 先退出会让 yes 吃 SIGPIPE，配合 `set -o pipefail`
#      会把「安装成功」误判成失败（2026-11-13 实际踩到：yes: standard output: Broken pipe）。
#      所以这一段临时关掉 pipefail，并改用「装完文件在不在」做真判据。
set +o pipefail
yes | timeout 900 sdkmanager --verbose "platform-tools" "emulator" "platforms;android-${API}" "${IMAGE}"
rc=$?
set -o pipefail
if [ "$rc" -ne 0 ] || [ ! -d "$SDK/system-images/android-${API}/google_apis/${ABI}" ]; then
  echo "❌ sdkmanager 安装失败（rc=$rc）"
  exit 1
fi
fi

# ── Windows：装 AEHD 加速驱动（需要管理员）────────────────────────────────
if [ "$(uname -s)" = "MSYS_NT"* ] || [ "$(uname -s)" = "MINGW"* ]; then
  if ! sc query aehd 2>/dev/null | grep -qi RUNNING; then
    echo "== 安装 Android Emulator Hypervisor Driver（需要管理员权限）"
    sdkmanager "extras;google;Android_Emulator_Hypervisor_Driver" || true
    BAT="$SDK/extras/google/Android_Emulator_Hypervisor_Driver/silent_install.bat"
    if [ -f "$BAT" ]; then
      ( cd "$(dirname "$BAT")" && cmd.exe //c silent_install.bat ) || echo "⚠️ AEHD 安装失败：请用管理员 PowerShell 手动跑 silent_install.bat"
    fi
  fi
  echo "加速状态："; "$SDK/emulator/emulator" -accel-check || true
else
  [ -w /dev/kvm ] || echo "⚠️ /dev/kvm 不可写：Linux 上需要把用户加进 kvm 组"
fi

# ── 建 AVD（幂等）──────────────────────────────────────────────────────────
if avdmanager list avd 2>/dev/null | grep -q "Name: ${AVD_NAME}$"; then
  echo "AVD ${AVD_NAME} 已存在，跳过创建"
else
  echo "== 创建 AVD ${AVD_NAME}"
  echo no | avdmanager create avd -n "${AVD_NAME}" -k "${IMAGE}" -d medium_phone --force
fi

echo "✅ 就绪：bash tools/avd/run-probe.sh"
