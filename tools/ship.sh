#!/usr/bin/env bash
# 一条命令走完：出包 → 生成装机/取证脚本 → 装机 → 取证 → 登记表推送
#   bash tools/ship.sh 1.1.0-146             # 完整链路（CI 约 10 分钟）
#   bash tools/ship.sh 1.1.0-146 --wait      # 无 adb 时：主人只需在设备侧跑一条 sh，脚本自动等证据并登记
#   bash tools/ship.sh 1.1.0-146 --skip-build  # 只重生装机脚本，不重新出包（调试用）
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VER="${1:-}"
[ -n "$VER" ] || { echo "用法：bash tools/ship.sh <版本，如 1.1.0-146> [--skip-build] [--wait] [--timeout=900]"; exit 1; }
shift || true

WAIT=0; SKIP=0; TIMEOUT=900
for a in "$@"; do
  case "$a" in
    --wait) WAIT=1 ;;
    --skip-build) SKIP=1 ;;
    --timeout=*) TIMEOUT="${a#*=}" ;;
    *) echo "[ship] 忽略未知参数 $a" ;;
  esac
done

DL=/storage/emulated/0/Download
APK="$DL/dsh-ci-$VER.apk"
JSON="$DL/verify-$VER.json"
START=$(date +%s)

# ① 出包（或只重生脚本）
if [ "$SKIP" -eq 0 ]; then
  echo "[ship] 1/4 出包 + 下载 + 校验"
  bash tools/push.sh "$VER" || { echo "[ship] 出包失败"; exit 1; }
else
  echo "[ship] 1/4 跳过出包，重生取证资产与装机脚本"
  [ -s "$APK" ] || echo "[ship] 提示：$APK 不存在，装机脚本会失败"
  python3 - "$VER" <<'PY' || exit 1
import sys
sys.path.insert(0, "tools")
import release as r
v = sys.argv[1]
r.write_evidence()
r.write_install_script(v)
PY
fi

# ② 装机 + 取证
DEV="$(adb devices 2>/dev/null | awk 'NR>1 && $2=="device"{print $1; exit}')"
if [ -n "$DEV" ]; then
  echo "[ship] 2/4 检测到 adb 设备 $DEV，直接装机"
  adb install -r "$APK" || { echo "[ship] adb install 失败"; exit 1; }
  adb shell sh "/sdcard/Download/install-$VER.sh" || echo "[ship] 设备侧取证脚本返回非 0（继续尝试取证据）"
  adb pull "/sdcard/Download/verify-$VER.json" "$JSON" >/dev/null 2>&1 || true
elif [ "$WAIT" -eq 1 ]; then
  echo "[ship] 2/4 本机没有 adb 设备。请在这台设备上执行："
  echo "         sh /sdcard/Download/install-$VER.sh"
  echo "[ship]     等 verify-$VER.json 出现（最多 ${TIMEOUT}s）…"
  deadline=$((START + TIMEOUT)); ok=0
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ -s "$JSON" ] && [ "$(stat -c %Y "$JSON")" -ge "$START" ]; then ok=1; break; fi
    sleep 3
  done
  [ "$ok" -eq 1 ] || { echo "[ship] 超时：没等到新的 $JSON"; exit 2; }
else
  echo "[ship] 2/4 本机没有 adb 设备。在设备上执行："
  echo "         sh /sdcard/Download/install-$VER.sh"
  echo "       跑完再执行：python3 tools/record.py $VER"
  echo "[ship] 想全自动就加 --wait：bash tools/ship.sh $VER --skip-build --wait"
  exit 0
fi

# ③ 登记表
echo "[ship] 3/4 解析证据并推送登记表"
python3 tools/record.py "$VER" || { echo "[ship] 登记失败"; exit 1; }

# ④ 结论
python3 - "$VER" <<'PY'
import json, sys
v = sys.argv[1]
d = json.load(open(f"/storage/emulated/0/Download/verify-{v}.json"))
bad = []
if not d.get("clicked"): bad.append("未点到「创建你的插件」")
if not d.get("match"): bad.append("输入框文案不一致")
if d.get("msgs") != 0: bad.append(f"消息数={d.get('msgs')}")
if len(d.get("items") or []) != 7: bad.append(f"菜单行数={len(d.get('items') or [])}")
print("[ship] 4/4", "全部通过" if not bad else "不通过：" + "；".join(bad))
sys.exit(0 if not bad else 3)
PY
