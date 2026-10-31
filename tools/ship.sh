#!/usr/bin/env bash
# 一条命令走完：出包 → 生成装机/取证脚本 → 装机 → 取证 → 登记表推送
#   bash tools/ship.sh 1.1.0-146             # 完整链路（CI 约 10 分钟）
#   bash tools/ship.sh 1.1.0-146 --wait      # 无 adb 时：主人只需在设备侧跑一条 sh，脚本自动等证据并登记
#   bash tools/ship.sh 1.1.0-146 --skip-build  # 只重生装机脚本，不重新出包（调试用）
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VER="${1:-}"
if [ -z "$VER" ] || [ "${VER#--}" != "$VER" ]; then
  VER="$(python3 tools/release.py --bump-only)" || { echo "[ship] 自动取版本失败（检查 /tmp/gh_token 与网络）"; exit 1; }
  echo "[ship] 未给版本号，自动取远端 +1 → $VER"
else
  shift || true
fi

WAIT=0; SKIP=0; ONLY_VERIFY=0; PAUSE=0; NODRIFT=0; FIXDRIFT=0; STRICT=0; TIMEOUT=900
MP_WAIT_CHG=0; export MP_WAIT_CHG
for a in "$@"; do
  case "$a" in
    --wait) WAIT=1 ;;
    --skip-build) SKIP=1 ;;
    --verify-only) SKIP=1; ONLY_VERIFY=1 ;;
    --pause-on-fail) PAUSE=1 ;;
    --no-drift) NODRIFT=1 ;;
    --fix-drift) FIXDRIFT=1 ;;
    --strict) STRICT=1 ;;
    --timeout=*) TIMEOUT="${a#*=}" ;;
    *) echo "[ship] 忽略未知参数 $a" ;;
  esac
done

DL=/storage/emulated/0/Download
APK="$DL/dsh-ci-$VER.apk"
JSON="$DL/verify-$VER.json"
if [ "$ONLY_VERIFY" -eq 1 ]; then SCRIPT="$DL/verify-$VER.sh"; else SCRIPT="$DL/install-$VER.sh"; fi
START=$(date +%s)

# ① 出包（或只重生脚本）
if [ "$SKIP" -eq 0 ]; then
  echo "[ship] 1/5 出包 + 下载 + 校验"
  bash tools/push.sh "$VER" || { echo "[ship] 出包失败"; exit 1; }
else
  echo "[ship] 1/5 跳过出包，重生取证资产与$( [ "$ONLY_VERIFY" -eq 1 ] && echo 仅取证脚本 || echo 装机脚本 )"
  [ "$ONLY_VERIFY" -eq 1 ] || [ -s "$APK" ] || echo "[ship] 提示：$APK 不存在，装机脚本会失败"
  python3 - "$VER" "$ONLY_VERIFY" <<'PY' || exit 1
import sys
sys.path.insert(0, "tools")
import release as r
v, only = sys.argv[1], sys.argv[2] == "1"
r.write_evidence()
r.write_install_script(v, install=not only)
PY
fi

# ①.5 拍基线快照（发布动作前）
echo "[ship] 1.5/5 拍九项基线快照"
python3 tools/drift_check.py --baseline "$VER" || echo "[ship] 基线快照失败（继续）"

# ② 装机 + 取证
DEV="$(adb devices 2>/dev/null | awk 'NR>1 && $2=="device"{print $1; exit}')"
if [ -n "$DEV" ]; then
  echo "[ship] 2/5 检测到 adb 设备 $DEV，直接装机"
  adb install -r "$APK" || { echo "[ship] adb install 失败"; exit 1; }
  adb shell sh "/sdcard/Download/$(basename "$SCRIPT")" || echo "[ship] 设备侧取证脚本返回非 0（继续尝试取证据）"
  adb pull "/sdcard/Download/verify-$VER.json" "$JSON" >/dev/null 2>&1 || true
elif [ "$WAIT" -eq 1 ]; then
  echo "[ship] 2/5 本机没有 adb 设备。请在这台设备上执行："
  echo "         sh $SCRIPT"
  echo "[ship]     等 verify-$VER.json 出现（最多 ${TIMEOUT}s）…"
  WLOG="/tmp/ship-watch-$VER.log"
  WATCH_PID=""
  python3 tools/drift_check.py --watch 15 > "$WLOG" 2>&1 &
  WATCH_PID=$!
  echo "[ship]     等待期巡检已起（15s 一次，pid=$WATCH_PID，日志 $WLOG）"
  deadline=$((START + TIMEOUT)); ok=0
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ -s "$JSON" ] && [ "$(stat -c %Y "$JSON")" -ge "$START" ]; then ok=1; break; fi
    sleep 3
  done
  if [ -n "$WATCH_PID" ]; then
    kill "$WATCH_PID" 2>/dev/null
    wait "$WATCH_PID" 2>/dev/null
  fi
  NCHG=0
  [ -s "$WLOG" ] && NCHG=$(grep -c '状态变化' "$WLOG" 2>/dev/null || true)
  [ -z "${NCHG:-}" ] && NCHG=0
  if [ "${NCHG:-0}" -gt 0 ]; then
    echo "[ship] 等待期检测到 ${NCHG} 次环境状态变化："
    grep -A4 '状态变化' "$WLOG" | while IFS= read -r l; do echo "        $l"; done
  else
    echo "[ship] 等待期环境稳定（无状态变化）"
  fi
  MP_WAIT_CHG=$NCHG; export MP_WAIT_CHG
  if [ "${NCHG:-0}" -gt 0 ] && [ -s "$WLOG" ]; then
    echo "[ship] 归档等待期巡检日志到 docs/agents/failures/"
    python3 tools/archive_fail.py --log "$VER" --file "$WLOG" --count "$NCHG" \
      || echo "[ship] 巡检日志归档失败（检查 token/网络）"
  fi
  [ "$ok" -eq 1 ] || { echo "[ship] 超时：没等到新的 $JSON"; exit 2; }
else
  echo "[ship] 2/5 本机没有 adb 设备。在设备上执行："
  echo "         sh $SCRIPT"
  echo "       跑完再执行：python3 tools/record.py $VER"
  echo "[ship] 想全自动就加 --wait：bash tools/ship.sh $VER --skip-build --wait"
  exit 0
fi

# ③ 结论判定（不通过就不登记）
echo "[ship] 3/5 判定取证结果"
python3 - "$VER" <<'PY'
import json, sys
v = sys.argv[1]
d = json.load(open(f"/storage/emulated/0/Download/verify-{v}.json"))
bad = []
if not d.get("clicked"): bad.append("未点到「创建你的插件」")
if not d.get("match"): bad.append("输入框文案不一致")
if d.get("msgs") != 0: bad.append(f"消息数={d.get('msgs')}")
if len(d.get("items") or []) != 7: bad.append(f"菜单行数={len(d.get('items') or [])}")
print("[ship] 3/5 结果", "全部通过" if not bad else "不通过：" + "；".join(bad),
      f"｜retries={sum((d.get('retries') or {}).values())} attempt={d.get('attempt', 0)} ms={d.get('ms')}")
sys.exit(0 if not bad else 3)
PY
RC=$?
if [ "$RC" -ne 0 ]; then
  if [ -n "$DEV" ]; then
    adb shell screencap -p "/sdcard/Download/dsh-$VER-fail.png" >/dev/null 2>&1 || true
    adb pull "/sdcard/Download/dsh-$VER-fail.png" "$DL/dsh-$VER-fail.png" >/dev/null 2>&1 || true
  fi
  if [ "$PAUSE" -eq 1 ]; then
    KEEP="$DL/verify-$VER-fail-$(date +%Y%m%d-%H%M%S).json"
    cp "$JSON" "$KEEP" 2>/dev/null && echo "[ship] 现场已保留：$KEEP"
  fi
  echo "[ship] 不合格，未登记（证据：$JSON / dsh-$VER-fail.png）"
  echo "[ship] 归档现场到 docs/agents/failures/"
  python3 tools/archive_fail.py "$VER" || echo "[ship] 归档失败（检查 token/网络）"
  exit "$RC"
fi

# ④ 登记表
echo "[ship] 4/5 全部通过，推送登记表"
python3 tools/record.py "$VER" || { echo "[ship] 登记失败"; exit 1; }

# ⑤ 一致性体检
if [ "$NODRIFT" -eq 1 ]; then
  echo "[ship] 5/5 跳过一致性体检（--no-drift）"
  exit 0
fi
echo "[ship] 5/5 一致性体检（远端版本 / 验收表 / 设备戳 / client / APK）"
DRIFT_ARGS="--save $VER --diff"
[ "$FIXDRIFT" -eq 1 ] && DRIFT_ARGS="--fix $DRIFT_ARGS"
python3 tools/drift_check.py $DRIFT_ARGS
DRC=$?
DIFF="$DL/verify-$VER.diff.json"
CHANGES=0
[ -s "$DIFF" ] && CHANGES=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('changes',0))" "$DIFF" 2>/dev/null || true)
[ -z "${CHANGES:-}" ] && CHANGES=0
if [ "$CHANGES" -gt 0 ]; then
  echo "[ship] 发布期间实际值变化 ${CHANGES} 项，归档变更清单"
  python3 tools/archive_fail.py --change "$VER" || echo "[ship] 变更清单归档失败（检查 token/网络）"
fi
if [ "$DRC" -ne 0 ]; then
  echo "[ship] 5/5 ⚠ 存在漂移，本次发布标记为可疑：$VER"
  echo "[ship] 归档漂移报告到 docs/agents/failures/"
  python3 tools/archive_fail.py --drift "$VER" || echo "[ship] 漂移归档失败（检查 token/网络）"
  echo "[ship] 重新登记（漂移列会标 🚩）"
  python3 tools/record.py "$VER" || echo "[ship] 重登记失败"
  exit 4
fi
if [ "$STRICT" -eq 1 ]; then
  DJ="$DL/verify-$VER.drift.json"
  PERTURB=0
  if [ -s "$DJ" ]; then
    PERTURB=$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(int(d.get('wait',0))+int(d.get('changes',0))+len(d.get('fixed') or []))" "$DJ" 2>/dev/null || true)
  fi
  [ -z "${PERTURB:-}" ] && PERTURB=0
  if [ "$PERTURB" -gt 0 ]; then
    python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print('[ship] strict: wait=%d changes=%d fixed=%d' % (int(d.get('wait',0)),int(d.get('changes',0)),len(d.get('fixed') or [])))" "$DJ" 2>/dev/null || true
    echo "[ship] strict: 发布过程存在扰动，标记 ⚠（exit 5）：$VER"
    echo "[ship] 归档扰动汇总到 docs/agents/failures/"
    python3 tools/archive_fail.py --perturb "$VER" || echo "[ship] 扰动归档失败（检查 token/网络）"
    python3 tools/record.py "$VER" || echo "[ship] strict 重登记失败"
    exit 5
  fi
fi
echo "[ship] 5/5 九项一致，发布完成：$VER"
exit 0
