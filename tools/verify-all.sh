#!/system/bin/sh
# verify-all.sh —— 外层包装：冷启动 App → 预热 → 跑 run-as 验收套件
#
# 为什么需要它：WebView 探针在 App 长时间运行后会返回陈旧 dump（elements 不变），
# 导致真模型用例点不到输入框/发送键。冷启动 + 75s 预热是唯一稳定姿势。
#
# 用法（外层 shell，不要 run-as）：
#   sh /data/local/tmp/verify-all.sh --tools --llmtools --llm --clean
#   sh /data/local/tmp/verify-all.sh --tools --json --latest
ARGS="$*"
echo "== force-stop + cold start =="
am force-stop com.dsh.android
sleep 2
am start -n com.dsh.android/.MainActivity >/dev/null 2>&1
echo "== warming up (probe health check) =="
OK=0
sleep 120
for k in 1 2 3 4; do
  if run-as com.dsh.android sh -c 'files/termux/usr/bin/node /data/local/tmp/probe-count.mjs'; then
    OK=1
    break
  fi
  echo "-- probe weak, keep waiting (try $k) --"
  am start -n com.dsh.android/.MainActivity >/dev/null 2>&1
  sleep 45
done
if [ $OK -ne 1 ]; then
  echo "-- last try: force-stop + 90s --"
  am force-stop com.dsh.android
  sleep 2
  am start -n com.dsh.android/.MainActivity >/dev/null 2>&1
  sleep 90
  if run-as com.dsh.android sh -c 'files/termux/usr/bin/node /data/local/tmp/probe-count.mjs'; then
    OK=1
  fi
fi
if [ $OK -ne 1 ]; then
  echo "PROBE_UNHEALTHY: 探针未恢复，手动打开 App 后再跑"
  exit 3
fi
# 确保 App 在最前：通知栏/其它窗口会抢焦点，导致探针 dump 不到 textbox
for i in 1 2 3; do
  F=$(dumpsys window | grep -m1 mCurrentFocus)
  case "$F" in
    *com.dsh.android*) break ;;
    *) input keyevent 4; sleep 1; am start -n com.dsh.android/.MainActivity >/dev/null 2>&1; sleep 2 ;;
  esac
done
dumpsys window | grep -m1 mCurrentFocus
case "$ARGS" in
  *--split*)
    echo "== split mode: 每个工具单独冷启 =="
    FAILED=0
    for t in bubble ui logs statusbar browser; do
      echo "-- case $t --"
      am force-stop com.dsh.android
      sleep 2
      am start -n com.dsh.android/.MainActivity >/dev/null 2>&1
      sleep 75
      run-as com.dsh.android sh -c "files/termux/usr/bin/node /data/local/tmp/verify-llm-tools.mjs --only $t --clean --shot"
      [ $? -ne 0 ] && FAILED=$((FAILED+1))
    done
    echo "---- split failed=$FAILED"
    run-as com.dsh.android sh -c 'files/termux/usr/bin/node /data/local/tmp/prune-sessions.mjs'
    [ $FAILED -eq 0 ] || exit 1
    exit 0 ;;
esac
case "$ARGS" in
  *--llmsplit*)
    echo "== llmsplit: 5 tools, cold start per case =="
    FP=0; FI=0
    for t in bubble ui logs statusbar browser; do
      am force-stop com.dsh.android
      sleep 2
      am start -n com.dsh.android/.MainActivity >/dev/null 2>&1
      sleep 75
      run-as com.dsh.android sh /data/local/tmp/verify-engine-upgrade.sh --llmtools --only $t --clean
      if [ $? -eq 0 ]; then FP=$((FP+1)); else FI=$((FI+1)); fi
    done
    echo "---- llmsplit pass=$FP fail=$FI"
    run-as com.dsh.android sh -c 'files/termux/usr/bin/node /data/local/tmp/prune-sessions.mjs'
    [ $FI -eq 0 ] || exit 1
    exit 0 ;;
esac
echo "== run suite: $ARGS =="
run-as com.dsh.android sh /data/local/tmp/verify-engine-upgrade.sh $ARGS
RC=$?
echo "== prune sessions =="
run-as com.dsh.android sh -c 'files/termux/usr/bin/node /data/local/tmp/prune-sessions.mjs'
echo "---- wrapper rc=$RC"
exit $RC