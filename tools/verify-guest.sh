#!/bin/sh
# VMOS guest 终验（Linux 侧）：adb connect → push → su 跑 --tools --root --guest
# 用法：VMOS_ADB=127.0.0.1:5666 sh tools/verify-guest.sh
S=${VMOS_ADB:-127.0.0.1:5666}
REPO=${REPO:-/storage/emulated/0/MT2/apks/deepseek harness/DSHAPP-main}

adb connect "$S" >/dev/null 2>&1
sleep 2
adb -s "$S" push "$REPO/tools/verify-engine-upgrade.sh" /data/local/tmp/verify-engine-upgrade.sh >/dev/null 2>&1
adb -s "$S" push "$REPO/tools/mockrun.sh" /data/local/tmp/mockrun.sh >/dev/null 2>&1
adb -s "$S" push "$REPO/tools/mockall.patch.yml" /data/local/tmp/mockall.patch.yml >/dev/null 2>&1

RES=$(adb -s "$S" shell 'su -c "sh /data/local/tmp/verify-engine-upgrade.sh --tools --root --guest"' 2>&1)
echo "$RES" | tail -14

SUM=$(echo "$RES" | grep -E '[0-9]+ PASS / [0-9]+ FAIL' | tail -1)
[ -z "$SUM" ] && SUM='(no summary line)'
case "$SUM" in
    *' 0 FAIL'*) echo "---- GUEST PASS  $SUM" ;;
    *)           echo "---- GUEST FAIL  $SUM"; exit 1 ;;
esac