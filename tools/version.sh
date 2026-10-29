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

GRADLE=app/build.gradle.kts
CHANGELOG=CHANGELOG.md
FAIL=0

die() { echo "version.sh: $*" >&2; exit 2; }
[ -f "$GRADLE" ] || die "找不到 $GRADLE（请在仓库根目录运行）"

# ---- 1. 从 build.gradle.kts 取 versionName / versionCode ----
APP_VER=$(grep -E '^[[:space:]]*versionName[[:space:]]*=' "$GRADLE" | head -1 | sed -e 's/.*=[[:space:]]*"//' -e 's/".*//')
APP_VC=$(grep -E '^[[:space:]]*versionCode[[:space:]]*=' "$GRADLE" | head -1 | sed -e 's/[^0-9]//g')
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

# ---- 3. 引擎版本一致性 ----
ENG_ASSERT=$(sed -n 's/.*if \[ "\$V" = "\([^"]*\)".*/\1/p' tools/verify-engine-upgrade.sh 2>/dev/null | head -1)
ENG_BUILD=$(sed -n 's/.*VER="\${VER:?.*\([0-9]\+\.[0-9]\+\.[0-9]\+[^ ]*\).*/\1/p' tools/build-engine-bin.sh 2>/dev/null | head -1)
[ -z "$ENG_BUILD" ] && ENG_BUILD=$(grep -oE '[0-9]+\.[0-9]+\.[0-9]+-alpha\.[0-9]+' tools/build-engine-bin.sh 2>/dev/null | head -1)
ENG_PROV=$(grep -oE '[0-9]+\.[0-9]+\.[0-9]+-alpha\.[0-9]+' tools/provision-glibc-host.sh 2>/dev/null | head -1)
ENG_DIR1=$(grep -oE '[0-9]+\.[0-9]+\.[0-9]+-alpha\.[0-9]+' tools/build-node-addon-system.sh 2>/dev/null | head -1)
ENG_DIR2=$(grep -oE '[0-9]+\.[0-9]+\.[0-9]+-alpha\.[0-9]+' tools/build-node-pty.sh 2>/dev/null | head -1)

ok() { printf '  %-34s %-22s %s\n' "$1" "$2" "OK"; }
bad() { printf '  %-34s %-22s %s\n' "$1" "$2" "MISMATCH"; FAIL=1; }

echo "== 版本号体检 =="
printf '  %-34s %-22s\n' "来源" "值"
printf '  %-34s %-22s\n' "app versionName" "$APP_VER"
printf '  %-34s %-22s\n' "app versionCode" "$APP_VC"
printf '  %-34s %-22s\n' "CHANGELOG 最新正式版" "${CL_VER:-<none>}"
printf '  %-34s %-22s\n' "引擎断言 (verify-engine-upgrade)" "${ENG_ASSERT:-<none>}"
printf '  %-34s %-22s\n' "引擎 build-engine-bin" "${ENG_BUILD:-<none>}"
printf '  %-34s %-22s\n' "引擎 provision-glibc-host" "${ENG_PROV:-<none>}"
echo ""

if [ -n "$CL_VER" ]; then
    [ "$CL_VER" = "$BASE_VER" ] && ok "CHANGELOG = versionName" "$BASE_VER" || bad "CHANGELOG = versionName" "$CL_VER vs $BASE_VER"
else
    bad "CHANGELOG 里找不到正式版标题" "$CHANGELOG"
fi

for pair in "build-engine-bin:$ENG_BUILD" "provision-glibc-host:$ENG_PROV" \
            "build-node-addon-system:$ENG_DIR1" "build-node-pty:$ENG_DIR2"; do
    name=${pair%%:*}
    val=${pair#*:}
    if [ -z "$val" ]; then
        bad "引擎默认值 $name" "<none>"
    elif [ "$val" = "$ENG_ASSERT" ]; then
        ok "引擎默认值 $name" "$val"
    else
        bad "引擎默认值 $name" "$val vs $ENG_ASSERT"
    fi
done

echo ""
if [ "$FAIL" -eq 0 ]; then
    echo "---- VERSION PASS  app=$APP_VER vc=$APP_VC engine=$ENG_ASSERT"
    exit 0
fi
echo "---- VERSION FAIL  （改版本号时请同步 CHANGELOG 与各构建脚本默认值）"
exit 1