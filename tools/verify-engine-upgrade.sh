#!/system/bin/sh
# 一条命令验收引擎升级（0.2.2 基线）
# 用法（设备上）：
#   run-as com.dsh.android sh /data/local/tmp/verify-engine-upgrade.sh [--ui] [--tools] [--json] [--baseline <json>]
#   默认      ：引擎版本 + 开发环境六组 + 会话索引 + 补丁标记
#   --ui      ：再加装机 UI 断言（需前台 + 已解锁）
#   --tools   ：再加 mock 工具矩阵（bubble/ui/logs/statusbar + browser；root 需 --root 启用）
#   --json    ：只输出 JSON（同时写 files/home/verify-<ts>.json）
#   --baseline：与指定 verify-<ts>.json 比对；有回归时退出码 2
#   --latest  ：自动拿最新一份 verify-<ts>.json 当基线（等价于 --baseline 最新文件）
#   --llm     ：用已登录账号在 App UI 跑一轮真实对话并校验 shell 输出 uid=（需 DSH 前台且已解锁）
#   --llmtools：真模型逐个驱动 6 个工具插件（bubble/ui/logs/statusbar/browser），校验 tool/result
#   --root    ：配合 --tools/--llmtools 启用 root 用例（默认冻结，只登记 SKIP）
#   --clean   ：配合 --llm/--llmtools，跑完删掉本次测试会话，只留 home/llm-evidence-<ts>.txt
#   --tools 需要的 mockrun.sh / pick.js / mocktool.mjs 已内嵌：缺失时自动写入 /data/local/tmp，
#   要强制刷新可用 VERIFY_HELPERS_REFRESH=1。
R=/data/user/0/com.dsh.android/files
N=$R/termux/usr/bin/node
PASS=0; FAIL=0; SKIP=0
# ── 设备侧 helpers：自举 ────────────────────────────────────────────────
# mockrun.sh / pick.js / mocktool.mjs 原先必须手工推到 /data/local/tmp：
# 换机、清空该目录、或重装后都会让 `--tools` 直接失败（NO_FREE_PORT / 模块找不到）。
# 现在三份都内嵌在本脚本里，缺失就落地；已有则不覆盖，除非 VERIFY_HELPERS_REFRESH=1。
HLP="$R/home/.verify-helpers"
ensure_helpers() {
  mkdir -p "$HLP" 2>/dev/null
  # ⚠️ mksh 的 heredoc 是先写到临时文件再搬运：默认 TMPDIR=/data/local，
  #   run-as 身份写不进去 ⇒ 三份 helper 全部变成 0 字节（已踩）。
  mkdir -p "$HLP/tmp" 2>/dev/null
  TMPDIR="$HLP/tmp"; export TMPDIR
  if [ ! -s "$HLP/pick.js" ] || [ "${VERIFY_HELPERS_REFRESH:-0}" = "1" ]; then
    cat > "$HLP/pick.js" <<'__DSH_PICK__'
const net=require("net");
const p0=Number(process.env.P0||0);
const tryOne=(p)=>new Promise((r)=>{const s=net.createServer();
  s.once("error",()=>r(false));
  s.listen(p,"127.0.0.1",()=>s.close(()=>r(true)));});
(async()=>{for(let p=p0;p<p0+20;p++){if(await tryOne(p)){console.log(p);process.exit(0)}}
  process.exit(1)})();
__DSH_PICK__
    chmod 700 "$HLP/pick.js" 2>/dev/null
    echo "helpers: 已写入 $HLP/pick.js"
  fi
  if [ ! -s "$HLP/mocktool.mjs" ] || [ "${VERIFY_HELPERS_REFRESH:-0}" = "1" ]; then
    cat > "$HLP/mocktool.mjs" <<'__DSH_MOCKTOOL__'
#!/usr/bin/env node
/**
 * mock-openai-toolcall.mjs —— 离线验证「插件工具能不能注册/执行」的最小 OpenAI 兼容服务。
 *
 * 为什么需要：真机 headless 要跑一轮 tool-call 得有可用模型凭据；凭据失效时
 * 整条链路就停在 MISSING_CREDENTIAL，看不到 tools.register 是否兼容。
 * 这个 mock 让引擎以为模型回了 tool_calls，从而把工具真正执行一遍：
 *   第 1 次请求（无 tools 字段，标题/预热）→ 回纯文本 ok
 *   第 2 次请求（带 tools、无 tool 结果）→ 回 tool_calls，调用 MOCK_TOOL
 *   第 3 次请求（带 tool 结果）        → 把工具输出回显成最终文本
 *
 * 用法（与 headless 同机）：
 *   node tools/mock-openai-toolcall.mjs &
 *   MOCK_TOOL=shell MOCK_ARGS='{"command":"id"}' \
 *     node .../bin.js --profile headless --patch mock.patch.yml --json "用 shell 执行 id"
 *
 * patch 里 provider 的 baseURL 填 http://127.0.0.1:3099/v1，apiKeyEnv 任意（MOCK_KEY=dummy）。
 */
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.MOCK_PORT || 3098);
const TOOL = process.env.MOCK_TOOL || 'shell';
const ARGS = process.env.MOCK_ARGS || JSON.stringify({ command: 'id' });
const LOG = process.env.MOCK_LOG || '';
const log = (m) => { if (LOG) { try { fs.appendFileSync(LOG, m + '\n'); } catch {} } };

const srv = http.createServer((req, res) => {
  if (!req.url.includes('/chat/completions')) { res.writeHead(404); res.end('no'); return; }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(body); } catch {}
    const msgs = j.messages || [];
    const toolResults = msgs.filter((m) => m.role === 'tool');
    const tools = j.tools || [];
    log(`REQ msgs=${msgs.length} tools=${tools.length} results=${toolResults.length} names=${tools.map((t) => t.function && t.function.name).join(',')}`);

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
    const base = (delta, finish) => ({
      id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: 'mock-1',
      choices: [{ index: 0, delta, finish_reason: finish || null }],
    });
    const done = () => { res.write('data: [DONE]\n\n'); res.end(); };

    if (tools.length === 0) {
      send(base({ role: 'assistant', content: '' }));
      send(base({ content: 'ok' }));
      send(base({}, 'stop'));
      log('SENT plain ok (request has no tools)');
      return done();
    }
    if (toolResults.length === 0) {
      send(base({ role: 'assistant', content: '' }));
      send(base({ tool_calls: [{ index: 0, id: 'call_mock_1', type: 'function', function: { name: TOOL, arguments: ARGS } }] }));
      send(base({}, 'tool_calls'));
      log(`SENT tool_call ${TOOL} ${ARGS}`);
      return done();
    }
    const last = toolResults[toolResults.length - 1];
    const text = 'TOOL_RESULT_BEGIN\n' + String(last.content || '').slice(0, 1200) + '\nTOOL_RESULT_END';
    send(base({ role: 'assistant', content: '' }));
    send(base({ content: text }));
    send(base({}, 'stop'));
    log('SENT final len=' + text.length);
    done();
  });
});
srv.listen(PORT, '127.0.0.1', () => log('listening ' + PORT));
__DSH_MOCKTOOL__
    chmod 600 "$HLP/mocktool.mjs" 2>/dev/null
    echo "helpers: 已写入 $HLP/mocktool.mjs"
  fi
  if [ ! -s "$HLP/mockrun.sh" ] || [ "${VERIFY_HELPERS_REFRESH:-0}" = "1" ]; then
    cat > "$HLP/mockrun.sh" <<'__DSH_MOCKRUN__'
#!/system/bin/sh
# 设备侧：换 mock 工具 → 起 headless → 打印 tool_call/tool_result
# 用法：sh mockrun.sh <tool> '<json args>' [mockPatch.yml]
R=/data/user/0/com.dsh.android/files
N=$R/termux/usr/bin/node
TOOL="$1"; ARGS="$2"; PATCH="${3:-mock4.patch.yml}"
LOG=$R/home/mockrun.log
[ -f $R/home/mock.pid ] && kill $(cat $R/home/mock.pid) 2>/dev/null
sleep 1
: > $LOG
[ -f $R/home/mock.port ] && MOCK_PORT=$(cat $R/home/mock.port)
export MOCK_PORT=${MOCK_PORT:-3098}
PICK=$(P0=$MOCK_PORT $N /data/local/tmp/pick.js)
if [ -z "$PICK" ]; then echo NO_FREE_PORT; tail -3 $LOG; exit 3; fi
echo "$PICK" > $R/home/mock.port
sed -i "s/127\\.0\\.0\\.1:[0-9]*\\/v1/127.0.0.1:$PICK\\/v1/" $R/home/$PATCH
MOCK_PORT=$PICK
export MOCK_PORT
echo "mock port -> $PICK" >>$LOG
BOUND=0
for i in 1 2; do
  MOCK_TOOL=$TOOL MOCK_ARGS=$ARGS MOCK_LOG=$LOG nohup $N $R/home/.verify-helpers/mocktool.mjs >>$LOG 2>&1 &
  P=$!; echo $P > $R/home/mock.pid
  for j in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    sleep 1
    /system/bin/grep -q "listening" $LOG && { BOUND=1; break; }
    kill -0 $P 2>/dev/null || break
  done
  [ $BOUND -eq 1 ] && break
  kill $P 2>/dev/null; sleep 1
done
if [ $BOUND -ne 1 ]; then echo "MOCK_BIND_FAILED"; tail -3 $LOG; exit 3; fi
cd $R/engine || exit 9
PARS="--patch $R/home/$PATCH"
for f in bubble-tool statusbar-tool logs-tool browser-tool uiagent-tool shell-tool; do
  [ -f "$R/home/.dsh/$f.patch.yml" ] && PARS="$PARS --patch $R/home/.dsh/$f.patch.yml"
done
HOME=$R/home DSH_HOME=$R/home/.dsh PREFIX=$R/termux/usr PATH=$R/termux/usr/bin:$PATH \
 LD_PRELOAD=$R/liblinkcompat.so MOCK_KEY=dummy DSH_ROOT_RUNNER=$R/dsh-android-root.mjs \
 $N node_modules/@deepseek-ai/dsh/lib/bin.js --profile headless $PARS --json mock 2>&1 \
 | /system/bin/grep -E 'tool_call|tool_result' | head -3
__DSH_MOCKRUN__
    chmod 700 "$HLP/mockrun.sh" 2>/dev/null
    echo "helpers: 已写入 $HLP/mockrun.sh"
  fi
}

QUIET=0; case "$*" in *--json*) QUIET=1;; esac
CLEANFLAG=0; case "$*" in *--clean*) CLEANFLAG=1;; esac
GUEST=0; for a in "$@"; do [ "$a" = "--guest" ] && GUEST=1; done
BASE=""; prev=""
for a in "$@"; do [ "$prev" = "--baseline" ] && BASE="$a"; prev="$a"; done
case "$*" in *--latest*) [ -z "$BASE" ] && BASE=$(ls -t $R/home/verify-*.json 2>/dev/null | head -1) ;; esac
[ -n "$BASE" ] && [ ! -f "$BASE" ] && BASE=""
RES=$R/home/.verify-results.$$
: > $RES
say(){ [ $QUIET -eq 0 ] && echo "$1"; }
ok(){ PASS=$((PASS+1)); echo "PASS|$1" >> $RES; say "[PASS] $1"; true; }
ng(){ FAIL=$((FAIL+1)); echo "FAIL|$1" >> $RES; say "[FAIL] $1"; true; }
sk(){ SKIP=$((SKIP+1)); echo "SKIP|$1" >> $RES; say "[SKIP] $1"; true; }

V=$(cat $R/engine/node_modules/@deepseek-ai/dsh/package.json 2>/dev/null | $N -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version)}catch{console.log("")}})')
if [ "$V" = "0.2.2-rc.1" ]; then ok "引擎版本 $V"; else ng "引擎版本 ${V:-unknown}"; fi

if [ "$GUEST" = "1" ]; then sk "开发环境（guest 跳过）"
else
LINE=$($N $R/dsh-env.mjs status --json 2>/dev/null | $N -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
 try{const d=JSON.parse(s);const bad=d.groups.filter(g=>g.required!==false&&g.installedCount!==g.totalCount&&g.id!=="rust");
  console.log(bad.length===0?"PASS "+d.groups.map(g=>g.id+" "+g.installedCount+"/"+g.totalCount).join(" "):"FAIL "+d.groups.map(g=>g.id+" "+g.installedCount+"/"+g.totalCount).join(" "));
 }catch(e){console.log("FAIL parse")}
})')
case "$LINE" in
  PASS*) ok "开发环境 ${LINE#PASS }" ;;
  *) ng "开发环境 ${LINE#FAIL }" ;;
esac
fi

CNT=$(grep -o 'session-[a-z0-9-]*' $R/home/.dsh/storages/workspace.json 2>/dev/null | wc -l)
MAX=${VERIFY_SESSION_MAX:-4}
if [ "$CNT" -le "$MAX" ]; then ok "会话索引干净（$CNT/$MAX 条）"; else ng "会话索引残留（$CNT 条，上限 $MAX）"; fi

if [ "$GUEST" = "1" ]; then sk "引擎补丁标记（guest 跳过）"
else
PM=$($N /data/local/tmp/check-engine-patch-marks.mjs $R/engine 2>&1); PRC=$?
if [ $PRC -eq 0 ]; then ok "引擎补丁标记 $(echo "$PM" | tail -1)"; else ng "引擎补丁标记"; say "$(echo "$PM" | grep '❌')"; fi
fi

case "$*" in *--ui*)
  OUT=$($N /data/local/tmp/urc3.mjs 2>&1); RC=$?
  say "$(echo "$OUT" | tail -7)"
  if [ $RC -eq 0 ] && echo "$OUT" | grep -q "0 FAIL"; then ok "UI 断言"; else ng "UI 断言"; fi
;; esac

case "$*" in *--llmtools*)
  ONLY=""
  prev=""
  for a in "$@"; do [ "$prev" = "--only" ] && ONLY="--only $a"; prev="$a"; done
  RA="$ONLY"
  case "$*" in *--root*) RA="--root" ;; esac
  # 兜底超时：真模型 + guest 慢设备时，单轮不设上限会把外层 adb 会话整段挂死
  # （实测 guest 上卡满 30 分钟后 adb 直接 offline）。LLM_TIMEOUT 可调。
  TMO=${LLM_TIMEOUT:-900}
  TO=""
  command -v timeout >/dev/null 2>&1 && TO="timeout $TMO"
  LO=$(CLEAN=$CLEANFLAG SHOT=1 $TO $N /data/local/tmp/verify-llm-tools.mjs $RA 2>&1)
  RC=$?
  LN=$(echo "$LO" | grep '^SUMMARY' | tail -1)
  LN=${LN#SUMMARY }
  if [ $RC -eq 0 ]; then ok "真实模型工具 $LN"; else ng "真实模型工具 ${LN:-no-summary}"; say "$(echo "$LO" | tail -7)"; fi
;; esac
LLMON=0
for a in "$@"; do [ "$a" = "--llm" ] && LLMON=1; done
case $LLMON in
  1)
  LO=$(CLEAN=$CLEANFLAG SHOT=1 $N /data/local/tmp/verify-llm-ui.mjs 2>&1 | tail -1)
  case "$LO" in
    HIT*) ok "真实模型对话 ${LO#HIT }" ;;
    *)
      LO=$(CLEAN=$CLEANFLAG SHOT=1 $N /data/local/tmp/verify-llm-ui.mjs 2>&1 | tail -1)
      case "$LO" in
        HIT*) ok "真实模型对话 ${LO#HIT } (retry)" ;;
        *) ng "真实模型对话 $LO" ;;
      esac ;;
  esac
;; esac
case "$*" in *--tools*)
  ensure_helpers
  for t in bubble ui logs statusbar; do
    case $t in
      ui) A='{"action":"ping"}' ;;
      logs) A='{"action":"summary"}' ;;
      *) A='{"action":"get"}' ;;
    esac
    O=$(sh $HLP/mockrun.sh $t "$A" mock4.patch.yml 2>&1)
    if echo "$O" | grep -q '"status":"completed"'; then ok "工具 $t"; else ng "工具 $t"; say "$(echo "$O" | head -c 200)"; fi
  done
  O=$(sh $HLP/mockrun.sh browser '{"action":"tabs"}' mock5.patch.yml 2>&1)
  if echo "$O" | grep -q '"status":"completed"'; then ok "工具 browser"; else ng "工具 browser"; say "$(echo "$O" | head -c 200)"; fi
  case "$*" in
    *--root*)
      O=$(sh $HLP/mockrun.sh root '{"command":"id","description":"verify"}' mock5.patch.yml 2>&1)
      if echo "$O" | grep -q '"status":"completed"'; then ok "工具 root"; else ng "工具 root"; say "$(echo "$O" | head -c 200)"; fi ;;
    *) sk "工具 root（冻结·待 root 环境）" ;;
  esac
;; esac


TS=$(date +%Y%m%d-%H%M%S)
OUT=$R/home/verify-$TS.json
QUIET=$QUIET BASE="$BASE" $N -e '
const fs=require("fs");
const res=process.argv[1],out=process.argv[2];
const txt=fs.readFileSync(res,"utf8");
const checks=[...txt.matchAll(/^(PASS|FAIL|SKIP)\|(.*)$/gm)].map(m=>({name:m[2],status:m[1],pass:m[1]==="PASS",detail:m[2]}));
const j={ts:new Date().toISOString(),pass:checks.filter(c=>c.pass).length,fail:checks.filter(c=>c.status==="FAIL").length,skip:checks.filter(c=>c.status==="SKIP").length,checks};
const base=process.env.BASE||"";
let cleaned=[];
try{const c=JSON.parse(fs.readFileSync("/data/user/0/com.dsh.android/files/home/llm-last-clean.json","utf8"));cleaned=c.ids||[]}catch{}
if(cleaned.length) j.cleaned=cleaned;
if(base){
  try{
    const b=JSON.parse(fs.readFileSync(base,"utf8"));
    const bm=new Map((b.checks||[]).map(c=>[c.name,c.pass]));
    const cm=new Map(checks.map(c=>[c.name,c.pass]));
    const regressions=[],fixes=[];
    for(const [n,p] of bm){
      if(p){ if(!cm.has(n)) regressions.push(n+" [missing]"); else if(cm.get(n)!==true) regressions.push(n); }
      if(!p && cm.get(n)===true) fixes.push(n);
    }
    j.baseline={file:base,regressions,fixes};
    if(process.env.QUIET!=="1"){
      console.log("baseline "+base+"  regressions="+regressions.length+" fixes="+fixes.length);
      for(const n of regressions) console.log("  REGRESSED "+n);
      for(const n of fixes) console.log("  FIXED     "+n);
    }
    if(regressions.length) process.exitCode=2;
  }catch(e){ j.baseline={file:base,error:String(e && e.message || e)}; }
}
fs.writeFileSync(out,JSON.stringify(j,null,2));
if(process.env.QUIET==="1")console.log(JSON.stringify(j,null,2));else{ if(cleaned.length) console.log("cleaned "+cleaned.join(",")); console.log("json "+out); }
' "$RES" "$OUT"
GRC=$?

# 保留策略：verify-*.json / llm-evidence-*.txt / llm-fail-*.png 各留最近 10 份
ls -t $R/home/verify-*.json 2>/dev/null | tail -n +11 | while read f; do rm -f "$f"; done
ls -t $R/home/llm-evidence-*.txt 2>/dev/null | tail -n +21 | while read f; do rm -f "$f"; done
find $R/home -maxdepth 1 -name 'llm*fail-*.png' -mtime +7 -exec rm -f {} + 2>/dev/null

if [ $QUIET -eq 0 ]; then echo "----"; echo "$PASS PASS / $FAIL FAIL / $SKIP SKIP"; fi
rm -f $RES
if [ $FAIL -ne 0 ]; then exit 1; fi
if [ $GRC -eq 2 ]; then exit 2; fi
exit 0