#!/system/bin/sh
# 一条命令验收引擎升级（0.2.2 基线）
# 用法（设备上）：
#   run-as com.dsh.android sh /data/local/tmp/verify-engine-upgrade.sh [--ui] [--tools] [--json]
#   默认  ：引擎版本 + 开发环境六组 + 会话索引 + 补丁标记
#   --ui  ：再加装机 UI 断言（需前台 + 已解锁）
#   --tools：再加 mock 工具矩阵（bubble/ui/logs/statusbar + browser/root）
#   --json：只输出 JSON（同时写 files/home/verify-<ts>.json）
R=/data/user/0/com.dsh.android/files
N=$R/termux/usr/bin/node
PASS=0; FAIL=0
QUIET=0; case "$*" in *--json*) QUIET=1;; esac
RES=$R/home/.verify-results.$$
: > $RES
say(){ [ $QUIET -eq 0 ] && echo "$1"; }
ok(){ PASS=$((PASS+1)); echo "PASS|$1" >> $RES; say "[PASS] $1"; true; }
ng(){ FAIL=$((FAIL+1)); echo "FAIL|$1" >> $RES; say "[FAIL] $1"; true; }

V=$(cat $R/engine/node_modules/@deepseek-ai/dsh/package.json 2>/dev/null | $N -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version)}catch{console.log("")}})')
if [ "$V" = "0.2.2-alpha.2" ]; then ok "引擎版本 $V"; else ng "引擎版本 ${V:-unknown}"; fi

LINE=$($N $R/dsh-env.mjs status --json 2>/dev/null | $N -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
 try{const d=JSON.parse(s);const bad=d.groups.filter(g=>g.installedCount!==g.totalCount&&g.id!=="rust");
  console.log(d.groups.length===6&&bad.length===0?"PASS "+d.groups.map(g=>g.id+" "+g.installedCount+"/"+g.totalCount).join(" "):"FAIL "+d.groups.map(g=>g.id+" "+g.installedCount+"/"+g.totalCount).join(" "));
 }catch(e){console.log("FAIL parse")}
})')
case "$LINE" in
  PASS*) ok "开发环境 ${LINE#PASS }" ;;
  *) ng "开发环境 ${LINE#FAIL }" ;;
esac

CNT=$(grep -o 'session-[a-z0-9-]*' $R/home/.dsh/storages/workspace.json 2>/dev/null | wc -l)
if [ "$CNT" -le 3 ]; then ok "会话索引干净（$CNT 条）"; else ng "会话索引残留（$CNT 条）"; fi

PM=$($N /data/local/tmp/check-engine-patch-marks.mjs $R/engine 2>&1); PRC=$?
if [ $PRC -eq 0 ]; then ok "引擎补丁标记 $(echo "$PM" | tail -1)"; else ng "引擎补丁标记"; say "$(echo "$PM" | grep '❌')"; fi

case "$*" in *--ui*)
  OUT=$($N /data/local/tmp/urc3.mjs 2>&1); RC=$?
  say "$(echo "$OUT" | tail -7)"
  if [ $RC -eq 0 ] && echo "$OUT" | grep -q "0 FAIL"; then ok "UI 断言"; else ng "UI 断言"; fi
;; esac

case "$*" in *--tools*)
  for t in bubble ui logs statusbar; do
    case $t in
      ui) A='{"action":"ping"}' ;;
      logs) A='{"action":"summary"}' ;;
      *) A='{"action":"get"}' ;;
    esac
    O=$(sh /data/local/tmp/mockrun.sh $t "$A" mock4.patch.yml 2>&1)
    if echo "$O" | grep -q '"status":"completed"'; then ok "工具 $t"; else ng "工具 $t"; say "$(echo "$O" | head -c 200)"; fi
  done
  for t in browser root; do
    if [ $t = root ]; then A='{"command":"id","description":"verify"}'; else A='{"action":"tabs"}'; fi
    O=$(sh /data/local/tmp/mockrun.sh $t "$A" mock5.patch.yml 2>&1)
    if echo "$O" | grep -q '"status":"completed"'; then ok "工具 $t"; else ng "工具 $t"; say "$(echo "$O" | head -c 200)"; fi
  done
;; esac

TS=$(date +%Y%m%d-%H%M%S)
OUT=$R/home/verify-$TS.json
QUIET=$QUIET $N -e '
const fs=require("fs");
const res=process.argv[1],out=process.argv[2];
const txt=fs.readFileSync(res,"utf8");
const checks=[...txt.matchAll(/^(PASS|FAIL)\|(.*)$/gm)].map(m=>({name:m[2],pass:m[1]==="PASS",detail:m[2]}));
const j={ts:new Date().toISOString(),pass:checks.filter(c=>c.pass).length,fail:checks.filter(c=>!c.pass).length,checks};
fs.writeFileSync(out,JSON.stringify(j,null,2));
if(process.env.QUIET==="1")console.log(JSON.stringify(j,null,2));else console.log("json "+out);
' "$RES" "$OUT"

if [ $QUIET -eq 0 ]; then echo "----"; echo "$PASS PASS / $FAIL FAIL"; fi
rm -f $RES
[ $FAIL -eq 0 ]