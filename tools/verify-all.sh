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
for k in 1 2 3; do
  sleep 60
  if run-as com.dsh.android sh -c 'files/termux/usr/bin/node /data/local/tmp/probe-count.mjs'; then
    OK=1
    break
  fi
  echo "-- probe weak, restart app (try $k) --"
  am force-stop com.dsh.android
  sleep 2
  am start -n com.dsh.android/.MainActivity >/dev/null 2>&1
done
if [ $OK -ne 1 ]; then
  echo "PROBE_UNHEALTHY: WebView 探针三轮回暖仍未恢复，先手动打开 App 再跑"
  exit 3
fi
dumpsys window | grep -m1 mCurrentFocus
echo "== run suite: $ARGS =="
run-as com.dsh.android sh /data/local/tmp/verify-engine-upgrade.sh $ARGS
RC=$?
echo "== prune sessions =="
run-as com.dsh.android sh -c 'files/termux/usr/bin/node /data/local/tmp/prune-sessions.mjs'
echo "---- wrapper rc=$RC"
exit $RC