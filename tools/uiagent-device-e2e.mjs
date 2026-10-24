/**
 * 真机端到端：**让设备上的 agent 自己调一次 `ui` 工具**，并交叉核对它拿到的坐标。
 *
 * ## 这条链路要验的是什么
 *
 *     模型(Node) ──写 ui-cmd.json──▶ 原生 UiProbeBridge ──evaluateJavascript──▶ 页面探针
 *                       ▲                                                      │
 *                       └──────────── ui-result.json ◀──────────────────────────┘
 *
 * PC 侧的 `uiagent-bridge-verify.mjs`（120 断言）用 **fake native**，只能证明
 * 「插件把命令写成什么样、把回执读成什么样」，**证明不了**：
 *   ① 原生轮询线程真的在消费信箱；② `action` 真的透传到探针；
 *   ③ 坐标换算（`attachScreenCoords`）真的发生；④ 回执真的被写回且 id 配对。
 * 这四件事只有让真机跑一遍才算数。
 *
 * ## 怎么把命令送进去
 *
 * 不直接写文件（app 私有目录 shell 读不到、release 包也没有 `run-as`），
 * 而是经**真机 WebView 页面世界**调引擎的 `session/prompt`，让设备上的 agent
 * 按自然语言去调 `ui` 工具 —— 完全走用户真实的那条路。
 *
 * ## 证据怎么取
 *
 * `session/projections` 的 `turnOutline[].response` 是 agent 的原话，
 * `sessionStats.toolMs` 是工具执行耗时。两者一起看就能区分：
 *   · 工具**没注册** → 模型会说自己没有这个工具，`toolMs` ≈ 0；
 *   · 工具注册了但**原生没消费信箱** → 模型会报「等待页面探针超时」；
 *   · 全链路通 → 模型贴出带**屏幕物理坐标**的元素列表，`toolMs` 明显 > 0。
 *
 * ## 信封与 args 形状（实测，别猜）
 *
 *   POST /api/<endpoint>，body `{type:'client-request', rpcId, method, payload:{args}}`
 *   ⚠️ 路径用**斜杠**：`session/list`、`session/prompt`（写成点号 404）
 *   ⚠️ `session/prompt` 的 args = `{ request: {...} }`，request 里要
 *      `{ requestId, sessionId, mode, content, clientTimeZone }`
 *   ⚠️ `session/projections` 的 args = `{ request: { sessionId } }`
 *   ⚠️ `session/page` 的 `request` 另有边界校验（要 `throughSeq` 等），本轮用不到
 *
 * ⚠️ CDP 的 `awaitPromise` 在设备老内核上会永久挂住 ⇒ 一律「发起不等待 + 轮询读回」。
 */
const CDP = process.env.UIPROBE_CDP ?? 'http://127.0.0.1:19222/json/list';

const list = await (await fetch(CDP)).json();
const page = list.find((t) => t.type === 'page' && /^https?:/.test(t.url));
if (!page) { console.error('✗ 没有 page 目标'); process.exit(1); }
console.log(`页面: ${page.url}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  const p = pending.get(m.id);
  if (p) { pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
});
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

function send(method, params) {
  const myId = ++id;
  return new Promise((resolve, reject) => { pending.set(myId, { resolve, reject }); ws.send(JSON.stringify({ id: myId, method, params })); });
}
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
async function api(endpoint, args = {}, timeoutMs = 20000) {
  const key = `__R${++id}_${seq++}`;
  const env = { type: 'client-request', rpcId: `${Date.now()}-${Math.random().toString(16).slice(2)}`, method: endpoint, payload: { args } };
  await ev(`(() => {
    window.${key} = null;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), ${timeoutMs - 1500});
    fetch('api/' + ${JSON.stringify(endpoint)}, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: ${JSON.stringify(JSON.stringify(env))}, signal: ac.signal
    }).then(async (r) => { window.${key} = { status: r.status, body: await r.text() }; })
      .catch((e) => { window.${key} = { status: 0, body: String(e) }; });
    return 1;
  })()`);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(250);
    const v = await ev(`window.${key} ? JSON.stringify(window.${key}) : null`);
    if (v) return JSON.parse(v);
  }
  return { status: 0, body: '超时' };
}
const rpc = (r) => JSON.parse(r.body).result;
/**
 * `session/projections` 的真实层级是 `result.value.values`（多一层 `values`）。
 * 里面的字段：title / sessionStats / turnOutline / inbox / lastAgentError…
 */
const proj = (r) => rpc(r)?.value?.values;

/** 直接读页面世界的探针（与原生走的是同一个函数，但这里不过原生）。 */
async function probe(cmd) {
  const src = await ev(`window.__DSH_UI_PROBE__ ? 'ready' : 'absent'`);
  if (src !== 'ready') {
    // 探针是「每次调用自带装填」的，需要先跑一次才会挂上去。
    await ev(`(function(){ return 1; })()`);
  }
  const r = await ev(`JSON.stringify(window.__DSH_UI_PROBE__.run(${JSON.stringify(cmd)}))`);
  return JSON.parse(r);
}

let pass = 0;
const fails = [];
const ok = (c, label, extra) => {
  if (c) { pass++; console.log(`  ✓ ${label}`); }
  else { fails.push(label); console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`); }
};

// ── ① 拿一个会话 ─────────────────────────────────────────────────────
console.log('\n① 找一个会话');
const sl = await api('session/list', { _request: {} });
const items = rpc(sl)?.value?.items ?? [];
ok(items.length > 0, `有 ${items.length} 个会话可用`);
if (!items.length) { ws.close(); process.exit(1); }
const sessionId = items[0].sessionId;
console.log(`     用 ${sessionId}`);

// ── ② 记下发指令前的状态 ─────────────────────────────────────────────
const before = proj(await api('session/projections', { request: { sessionId } }));
const turnsBefore = before?.sessionStats?.turns ?? 0;
console.log(`     当前轮数: ${turnsBefore}`);

// ── ③ 让 agent 调 ui 工具 ────────────────────────────────────────────
console.log('\n② 发指令，让设备上的 agent 自己调 ui 工具');
const prompt = [
  '请调用 ui 工具，参数 {"action":"dump"}。',
  '然后把结果里前 3 个元素的 text 和 center 原样贴出来。',
  '只做这一件事，不要读文件、不要用别的工具。',
].join('\n');
const pr = await api('session/prompt', {
  request: {
    requestId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: prompt }],
    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  },
}, 30000);
console.log(`     session/prompt → HTTP ${pr.status}  ${JSON.stringify(rpc(pr)).slice(0, 160)}`);
ok(rpc(pr)?.ok === true, 'prompt 被接受');

// ── ④ 等 agent 干完，取它的原话 ──────────────────────────────────────
console.log('\n③ 等 agent 执行');
const deadline = Date.now() + 180000;
let after = null;
let turn = null;
while (Date.now() < deadline) {
  await sleep(5000);
  const pj = proj(await api('session/projections', { request: { sessionId } }, 15000));
  const turns = pj?.sessionStats?.turns ?? 0;
  if (turns > turnsBefore) {
    after = pj;
    turn = (pj.turnOutline ?? []).at(-1);
    if (turn?.response) break;
  }
  process.stdout.write('.');
}
console.log('');
ok(!!after, `轮数已从 ${turnsBefore} 推进`);
if (!after) { ws.close(); process.exit(1); }

console.log(`     标题: ${after.title}`);
console.log(`     stats: steps=${after.sessionStats?.steps} toolMs=${after.sessionStats?.toolMs} llmMs=${after.sessionStats?.llmMs}`);
console.log(`     回复: ${String(turn?.response ?? '').replace(/\s+/g, ' ').slice(0, 400)}`);

// ── ⑤ 关键断言 ───────────────────────────────────────────────────────
console.log('\n④ 判定');
const resp = String(turn?.response ?? '');
ok(after.sessionStats?.toolMs > 0,
  `工具真的执行了（toolMs=${after.sessionStats?.toolMs}ms）`,
  'toolMs 为 0 说明模型没调工具（很可能工具没注册进去）');
ok(!/没有.*工具|未找到.*工具|not found|no such tool|不认识/i.test(resp),
  '模型没说「没有这个工具」（说明 ui 已注册进工具列表）', resp.slice(0, 120));
ok(!/超时|timeout/i.test(resp),
  '模型没报「等待页面探针超时」（说明原生真的把命令送到了探针）', resp.slice(0, 120));

// 回复里应当出现**屏幕物理坐标** —— 那是原生 `attachScreenCoords` 独有的字段，
// 探针自己只给 CSS 坐标。看到「屏幕」或比 CSS 大得多的数值，就证明换算发生了。
const hasScreen = /屏幕|screen|\(\s*\d{3,}\s*,\s*\d{3,}\s*\)/.test(resp);
ok(hasScreen, '回复里带屏幕物理坐标（原生 attachScreenCoords 生效）', resp.slice(0, 200));

// ── ⑥ 交叉核对坐标 ───────────────────────────────────────────────────
// ⚠️ 换算公式是 `屏幕 = webView屏幕原点 + CSS × scale`（见 UiProbeBridge 头部注释），
//    所以**不能**直接拿 CSS×dpr 跟屏幕坐标比 —— 会差一个 `screenY`（WebView 在屏幕上
//    的偏移，实测 108 物理px）。正确做法是**解出偏移再要求所有元素一致**：
//    这比「某一个元素对得上」强得多，能抓出缩放比例错、或只有部分元素算错这类问题。
console.log('\n⑤ 交叉核对：模型报的屏幕坐标是否满足「CSS × scale + 同一偏移」');
const d = await probe({ action: 'dump' });
ok(d.ok === true, '直接经探针拿到 dump');
const scale = d.viewport?.dpr ?? 3;
console.log(`     dpr=${scale}，视口 ${d.viewport?.w}×${d.viewport?.h}`);

const pairs = [];
const seenText = new Set();
for (const e of (d.elements ?? [])) {
  const t = String(e.text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) continue;
  // ⚠️ 同名元素会出现多次（实测「新建会话」在 hero 屏有 3 个不同位置的按钮），
  //    而回复里只有坐标没有 ref，无法分辨模型指的是哪一个。
  //    所以**同名只取第一次出现** —— 否则会把模型报的第 1 个坐标错配到第 3 个元素，
  //    报出一个假的「换算不一致」。
  if (seenText.has(t)) continue;
  const at = resp.indexOf(t);
  if (at < 0) continue;
  const m = resp.slice(at).match(/\(\s*(\d+)\s*,\s*(\d+)\s*\)/);
  if (!m) continue;
  seenText.add(t);
  pairs.push({ t, css: e.center, got: { x: +m[1], y: +m[2] } });
}
ok(pairs.length > 0, `从回复里抠出 ${pairs.length} 个「文字 + 坐标」对`);

if (pairs.length > 0) {
  // 用第一对解出偏移，再看其余对是否落在同一偏移上（容差 2px 抗取整）。
  const off = { x: pairs[0].got.x - pairs[0].css.x * scale, y: pairs[0].got.y - pairs[0].css.y * scale };
  console.log(`     解出的屏幕偏移: (${off.x}, ${off.y}) 物理px`);
  let consistent = 0;
  for (const p of pairs) {
    const dx = Math.abs(p.got.x - (p.css.x * scale + off.x));
    const dy = Math.abs(p.got.y - (p.css.y * scale + off.y));
    const good = dx <= 2 && dy <= 2;
    if (good) consistent++;
    console.log(`     "${p.t.slice(0, 18)}" 报(${p.got.x},${p.got.y}) 算(${(p.css.x * scale + off.x).toFixed(0)},${(p.css.y * scale + off.y).toFixed(0)}) ${good ? '✓' : '✗'}`);
  }
  ok(consistent === pairs.length,
    `全部 ${consistent}/${pairs.length} 个元素落在同一偏移上（换算比例正确）`);
  // 偏移的 x 分量应当 ≈0（WebView 横向铺满），y 分量是状态栏/标题栏高度。
  ok(Math.abs(off.x) < 8, `横向偏移 ≈0（实测 ${off.x}，WebView 横向铺满屏幕）`);
}

console.log(`\n${'═'.repeat(58)}`);
if (fails.length === 0) console.log(`真机端到端全部通过：${pass} 项断言`);
else {
  console.log(`失败 ${fails.length} / 共 ${pass + fails.length}：`);
  fails.forEach((f) => console.log(`  ✗ ${f}`));
}
ws.close();
process.exit(fails.length === 0 ? 0 : 1);
