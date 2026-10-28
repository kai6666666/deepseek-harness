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
echo "== warming up 75s =="
sleep 75
dumpsys window | grep -m1 mCurrentFocus
echo "== run suite: $ARGS =="
run-as com.dsh.android sh /data/local/tmp/verify-engine-upgrade.sh $ARGS
RC=$?
echo "== prune sessions =="
run-as com.dsh.android sh -c 'files/termux/usr/bin/node /data/local/tmp/prune1.mjs'
echo "---- wrapper rc=$RC"
exit $RC