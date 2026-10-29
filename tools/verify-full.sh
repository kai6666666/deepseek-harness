#!/system/bin/sh
# 全链路冷启动验收（设备侧 / 宿主）
# 用法：sh verify-full.sh          全跑：mock 矩阵 + 三条真模型线
#       sh verify-full.sh --quick  只跑 mock 矩阵 + llmtools（快检）
# 前提：App 在前台、已解锁；不要用 run-as 包本脚本（内部自己 run-as）。
TS=$(date +%Y%m%d-%H%M%S)
OUT=${OUT:-/data/local/tmp/full-$TS.txt}
mkdir -p "$(dirname "$OUT")" 2>/dev/null
: > "$OUT" 2>/dev/null || OUT=/data/local/tmp/full-$TS.txt
TOTAL=0
BAD=0

say() { echo "$*" | tee -a "$OUT"; }

one() {
    NAME=$1
    shift
    say "== $NAME =="
    sh /data/local/tmp/verify-all.sh "$@" > /tmp/_one.log 2>&1
    RC=$?
    case "$NAME" in
        llmsplit) SUM=$(grep -oE 'llmsplit pass=[0-9]+ fail=[0-9]+' /tmp/_one.log | tail -1) ;;
        *)        SUM=$(grep -E '[0-9]+ PASS / [0-9]+ FAIL' /tmp/_one.log | tail -1) ;;
    esac
    [ -z "$SUM" ] && SUM='(no summary line)'
    RES=FAIL
    case "$SUM" in
        *' 0 FAIL'*|*'fail=0'*) RES=PASS ;;
    esac
    [ "$RC" -ne 0 ] && RES=FAIL
    printf '%-14s %-46s %s\n' "$NAME" "$SUM" "$RES" | tee -a "$OUT"
    TOTAL=$((TOTAL + 1))
    [ "$RES" = PASS ] || BAD=$((BAD + 1))
}

say "== full cold-start acceptance  TS=$TS  model=$(getprop ro.product.model)  sdk=$(getprop ro.build.version.sdk) =="
say ""

one mock-matrix --tools
one llmtools    --llmtools
if [ "$1" != "--quick" ]; then
    one llmsplit    --llmsplit
    one llm         --llm
fi

say ""
say "----"
say "---- FULL $((TOTAL - BAD)) PASS / $BAD FAIL  (sections=$TOTAL)"
say "report: $OUT"
[ "$BAD" -eq 0 ]
