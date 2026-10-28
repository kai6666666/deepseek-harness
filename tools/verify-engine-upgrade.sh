#!/system/bin/sh
# 一条命令验收引擎升级（0.2.2 基线）
# 用法（设备上）：
#   run-as com.dsh.android sh /data/local/tmp/verify-engine-upgrade.sh [--ui] [--tools]
#   默认：引擎版本 + 开发环境六组 + 会话索引完整性
#   --ui   ：再加装机 UI 六条断言（需前台 + 已解锁）
#   --tools：再加 mock 工具矩阵（bubble/ui/logs/statusbar + browser/root）
R=/data/user/0/com.dsh.android/files
N=$R/termux/usr/bin/node
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "[PASS] $1"; }
ng(){ FAIL=$((FAIL+1)); echo "[FAIL] $1"; }

V=$(cat $R/engine/node_modules/@deepseek-ai/dsh/package.json 2>/dev/null | $N -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version)}catch{console.log("")}})')
[ "$V" = "0.2.2-alpha.2" ] && ok "引擎版本 $V" || ng "引擎版本 ${V:-unknown}"

LINE=$($N $R/dsh-env.mjs status --json 2>/dev/null | $N -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
 try{const d=JSON.parse(s);const bad=d.groups.filter(g=>g.installedCount!==g.totalCount&&g.id!=="rust");
  console.log(d.groups.length===6&&bad.length===0?"PASS "+d.groups.map(g=>g.id+" "+g.installedCount+"/"+g.totalCount).join(" "):"FAIL "+d.groups.map(g=>g.id+" "+g.installedCount+"/"+g.totalCount).join(" "))
 }catch(e){console.log("FAIL parse")}
})')
case "$LINE" in PASS*) ok "开发环境 ${LINE#PASS }";; *) ng "开发环境 ${LINE#FAIL }";; esac

CNT=$(grep -o 'session-[a-z0-9-]*' $R/home/.dsh/storages/workspace.json 2>/dev/null | wc -l)
[ "$CNT" -le 3 ] && ok "会话索引干净（$CNT 条）" || ng "会话索引残留（$CNT 条）"

PM=$($N /data/local/tmp/check-engine-patch-marks.mjs $R/engine 2>&1); PRC=$?
if [ $PRC -eq 0 ]; then ok "引擎补丁标记 $(echo "$PM" | tail -1)"; else ng "引擎补丁标记"; echo "$PM" | grep '❌' ; fi

case "$*" in *--ui*)
  OUT=$($N /data/local/tmp/urc3.mjs 2>&1); RC=$?
  echo "$OUT" | tail -7
  if [ $RC -eq 0 ] && echo "$OUT" | grep -q "0 FAIL"; then ok "UI 断言（见上方结果行）"; else ng "UI 断言"; fi
;; esac

case "$*" in *--tools*)
  for t in bubble ui logs statusbar; do
    O=$(sh /data/local/tmp/mockrun.sh $t "$(case $t in bubble) echo '{\"action\":\"get\"}';; ui) echo '{\"action\":\"ping\"}';; logs) echo '{\"action\":\"summary\"}';; *) echo '{\"action\":\"get\"}';; esac)" mock4.patch.yml 2>&1)
    echo "$O" | grep -q '"status":"completed"' && ok "工具 $t" || ng "工具 $t"
  done
  for t in browser root; do
    A='{"action":"tabs"}'; [ $t = root ] && A='{"command":"id","description":"verify"}'
    O=$(sh /data/local/tmp/mockrun.sh $t "$A" mock5.patch.yml 2>&1)
    echo "$O" | grep -q '"status":"completed"' && ok "工具 $t" || ng "工具 $t"
  done
;; esac

echo "----"
echo "$PASS PASS / $FAIL FAIL"
[ $FAIL -eq 0 ]
