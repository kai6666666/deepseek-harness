#!/data/data/com.dsh.android/files/usr/bin/bash
# verify-dsh-compat.sh —— 换 DSH 引擎版本前先跑这个
# 用法： bash tools/verify-dsh-compat.sh [仓库根]
# 退出码：0 全绿；非 0 = 失败条数
set -u

R="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
A="$R/app/src/main/java/com/dsh/android"
E="${DSH_ENGINE_ROOT:-$R/engine}"
fail=0

say() { printf '%s\n' "$*"; }
chk() {
  if eval "$2" >/dev/null 2>&1; then
    say "  OK   $1"
  else
    say "  FAIL $1"
    fail=$((fail + 1))
  fi
}

say "== [1] 资产版本戳（四个必须同源）"
chk "MainActivity.assetStamp"        "grep -q 'assetStamp' '$A/MainActivity.kt'"
chk "TermuxBootstrap.NODE_VERSION"   "grep -q 'NODE_VERSION' '$A/termux/TermuxBootstrap.kt'"
chk "EngineManager.PNPM_VERSION"     "grep -q 'PNPM_VERSION' '$A/EngineManager.kt'"
chk "EngineManager.MOBILE_UI_VERSION" "grep -q 'MOBILE_UI_VERSION' '$A/EngineManager.kt'"

say "== [2] 引擎侧可补丁锚点"
chk "flock 平台白名单可定位" \
    "grep -rq \"platform !== 'linux'\" '$E/node_modules/@deepseek-ai/node-addon-system/lib' 2>/dev/null || [ -n \"\${DSH_ALLOW_MISSING_FLOCK:-}\" ]"
chk "sandbox runnerCommand 支持"     "grep -q 'runnerCommand' '$A/EngineManager.kt'"
chk "runnerFailureSignatures 非空"   "grep -q 'boo-sandbox-run: ' '$A/EngineManager.kt'"
chk "DENIAL 文案未变"               "grep -q 'permission denied' '$R/app/src/main/jni/boosandbox.c'"

say "== [3] profile 与组合包"
chk "PROFILE_WEB 常量"              "grep -q 'PROFILE_WEB' '$A/EngineManager.kt'"
chk "web app bundle patch 存在"      "test -f '$E/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml'"
chk "rescue profile 通道保留"        "grep -q 'profile \\\"rescue\\\"' '$A/EngineManager.kt'"

say "== [4] 原生资产与 ABI"
chk "boo-sandbox-run 资产"           "test -f '$R/app/src/main/assets/boo-sandbox-run.bin'"
chk "boosandbox 拦截器资产"          "test -f '$R/app/src/main/assets/boosandbox.bin'"
chk "linkcompat 资产"                "test -f '$R/app/src/main/assets/linkcompat.bin'"
chk "上游 native 仍无 android 产物"  "! ls '$R/../deepseek-harness-master/native/system/packages' 2>/dev/null | grep -q android"

say "== [5] 补丁队列"
chk "patches/manifest.json 存在"     "test -f '$R/patches/manifest.json'"
chk "apply-patches 可 dry-run"       "DSH_ENGINE_ROOT='$E' node '$R/tools/apply-patches.mjs' --dry-run"

say ""
say "FAIL=$fail"
exit "$fail"