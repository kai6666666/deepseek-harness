#!/system/bin/sh
export MOCK_PORT=${MOCK_PORT:-28999}
# 设备侧：换 mock 工具 → 起 headless → 打印 tool_call/tool_result
# 用法：sh mockrun.sh <tool> '<json args>' [patch.yml]
R=/data/user/0/com.dsh.android/files
N=$R/termux/usr/bin/node
TOOL="$1"; ARGS="$2"; PATCH="${3:-mock4.patch.yml}"
LOG=$R/home/mockrun.log
[ -f $R/home/mock.pid ] && kill $(cat $R/home/mock.pid) 2>/dev/null
sleep 1
: > $LOG
BOUND=0
for i in 1 2; do
  MOCK_TOOL=$TOOL MOCK_ARGS=$ARGS MOCK_LOG=$LOG nohup $N /data/local/tmp/mocktool.mjs >>$LOG 2>&1 &
  P=$!; echo $P > $R/home/mock.pid
  for j in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    sleep 1
    grep -q "listening" $LOG && { BOUND=1; break; }
    kill -0 $P 2>/dev/null || break
  done
  [ $BOUND -eq 1 ] && break
  kill $P 2>/dev/null; sleep 1
done
if [ $BOUND -ne 1 ]; then echo "MOCK_BIND_FAILED"; tail -3 $LOG; exit 3; fi
cd $R/engine
HOME=$R/home DSH_HOME=$R/home/.dsh PREFIX=$R/termux/usr PATH=$R/termux/usr/bin:$PATH \
 LD_PRELOAD=$R/liblinkcompat.so MOCK_KEY=dummy DSH_ROOT_RUNNER=$R/dsh-android-root.mjs \
 $N node_modules/@deepseek-ai/dsh/lib/bin.js --profile headless --patch $R/home/$PATCH --json mock 2>&1 \
 | grep -E 'tool_call|tool_result' | head -3
