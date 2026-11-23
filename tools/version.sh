#!/bin/sh
# 版本号单一来源体检
# 用法：
#   sh tools/version.sh            # 打印当前版本
#   sh tools/version.sh --check    # 校验多处是否同源（CI 用，不一致即非 0）
#   sh tools/version.sh --print    # 只输出 versionName（给发布脚本取值）
#
# 单一来源：app/build.gradle.kts 里的 versionName / versionCode。
# 被校验的引用点：
#   1. app/build.gradle.kts versionName / versionCode
#   2. CHANGELOG.md 最新一个正式版标题  ## [x.y.z]
#   3. 引擎版本：tools/verify-engine-upgrade.sh 的断言 = 各构建脚本的默认值
set -u

APP_FILE=tools/app-version.txt
CHANGELOG=CHANGELOG.md
FAIL=0

die() { echo "version.sh: $*" >&2; exit 2; }
[ -f "$APP_FILE" ] || die "找不到 $APP_FILE（请在仓库根目录运行）"

# ---- 1. 从 tools/app-version.txt 取 versionName / versionCode ----
APP_VER=$(grep -E '^versionName=' "$APP_FILE" | head -1 | cut -d= -f2 | tr -d ' \r\n')
APP_VC=$(grep -E '^versionCode=' "$APP_FILE" | head -1 | cut -d= -f2 | tr -d ' \r\n')
[ -n "$APP_VER" ] || die "解析不出 versionName"

# 0.4.1-debug → 0.4.1（去掉 -debug / -gecko 之类后缀）
BASE_VER=$(echo "$APP_VER" | sed -e 's/-[A-Za-z0-9._]*$//')

if [ "${1:-}" = "--print" ]; then
    echo "$APP_VER"
    exit 0
fi
if [ "${1:-}" = "--base" ]; then
    echo "$BASE_VER"
    exit 0
fi

# ---- 2. CHANGELOG 最新正式版 ----
CL_VER=""
if [ -f "$CHANGELOG" ]; then
    CL_VER=$(grep -E '^## \[[0-9]' "$CHANGELOG" | head -1 | sed -e 's/^## \[//' -e 's/\].*//')
fi

# ---- 3. 引擎版本：单一来源 tools/engine-version.txt ----
ENG_ASSERT=$(sed -n 's/.*if \[ "\$V" = "\([^"]*\)".*/\1/p' tools/verify-engine-upgrade.sh 2>/dev/null | head -1)
ENG_SRC=$(tr -d ' \r\n' < tools/engine-version.txt 2>/dev/null)
[ -n "$ENG_SRC" ] || die "读不到 tools/engine-version.txt（引擎版本唯一来源）"

ok() { printf '  %-34s %-22s %s\n' "$1" "$2" "OK"; }
bad() { printf '  %-34s %-22s %s\n' "$1" "$2" "MISMATCH"; FAIL=1; }

echo "== 版本号体检 =="
printf '  %-34s %-22s\n' "来源" "值"
printf '  %-34s %-22s\n' "app versionName" "$APP_VER"
printf '  %-34s %-22s\n' "app versionCode" "$APP_VC"
printf '  %-34s %-22s\n' "CHANGELOG 最新正式版" "${CL_VER:-<none>}"
printf '  %-34s %-22s\n' "引擎 engine-version.txt" "${ENG_SRC:-<none>}"
printf '  %-34s %-22s\n' "引擎断言 (verify-engine-upgrade)" "${ENG_ASSERT:-<none>}"
echo ""

if [ -n "$CL_VER" ]; then
    [ "$CL_VER" = "$APP_VER" ] && ok "CHANGELOG = versionName" "$APP_VER" || bad "CHANGELOG = versionName" "$CL_VER vs $APP_VER"
else
    bad "CHANGELOG 里找不到正式版标题" "$CHANGELOG"
fi

# ---- 2b. versionCode：最新小节 vc == versionCode，且严格大于上一小节 ----
SEC1=$(awk '/^## \[[0-9]/{n++} n==1{print} n==2{exit}' "$CHANGELOG" 2>/dev/null)
SEC2=$(awk '/^## \[[0-9]/{n++} n==2{print}' "$CHANGELOG" 2>/dev/null)
CL_VC=$(echo "$SEC1" | grep -oE 'vc=[0-9]+' | head -1 | sed 's/vc=//')
PREV_VC=$(echo "$SEC2" | grep -oE 'vc=[0-9]+' | head -1 | sed 's/vc=//')

if [ -z "$CL_VC" ]; then
    bad "CHANGELOG 最新小节缺 vc=<n>" "none"
elif [ "$CL_VC" = "$APP_VC" ]; then
    ok "CHANGELOG vc = versionCode" "$CL_VC"
else
    bad "CHANGELOG vc = versionCode" "vc=$CL_VC vs versionCode=$APP_VC"
fi

if [ -n "$PREV_VC" ] && [ -n "$CL_VC" ]; then
    if [ "$CL_VC" -gt "$PREV_VC" ]; then
        ok "versionCode 递增" "$CL_VC > $PREV_VC"
    else
        bad "versionCode 必须递增" "$CL_VC <= $PREV_VC"
    fi
fi


if [ -n "$ENG_ASSERT" ] && [ "$ENG_ASSERT" != "$ENG_SRC" ]; then
    bad "引擎断言 = engine-version.txt" "$ENG_ASSERT vs $ENG_SRC"
else
    ok "引擎版本单一来源" "$ENG_SRC"
fi
echo ""
if [ "$FAIL" -eq 0 ]; then
    echo "---- VERSION PASS  app=$APP_VER vc=$APP_VC engine=$ENG_SRC"
    exit 0
fi
echo "---- VERSION FAIL  （改版本号时请同步 CHANGELOG 与各构建脚本默认值）"
exit 1