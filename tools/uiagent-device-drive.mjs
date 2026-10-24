/**
 * 经**真机 WebView 页面世界**调用设备上引擎的 API。
 *
 * ## 为什么必须走页面世界
 *
 * `/api/*` 是**纯 cookie 鉴权**，而那个 cookie 是 `HttpOnly` + **按 authority 签名**
 * （`dsh-auth-<sha256(authority)>`，见 `dsh-client-connection` 的 `cookieName()`），
 * 所以从 PC 直连引擎端口一律 401，`document.cookie` 也是空的。
 * 在页面里 `fetch` 则与前端平时调 API **完全同源同头**。
 *
 * ## ⚠️ 路径用**斜杠**，不是点号
 *
 * 实测本页前端发的是 `/api/session/list`、`/api/settings/describe`、
 * `/api/agentPresets/list` —— 而 `endpointFromPath()` 允许斜杠分段
 * （`ENDPOINT_SEGMENT_PATTERN` 逐段校验），所以 `session/list` 是一个合法 endpoint。
 * 写成 `session.list` 会 404。
 *
 * ## 信封格式（照抄 `dsh-client-connection/lib/client.js` 的 `call()`）
 *
 *     POST /api/<endpoint>
 *     body: { type: 'client-request', rpcId, method: <endpoint>, payload }
 *
 * ⚠️ `method` 必须与路径末段**逐字相等**，否则服务端回
 *   `gateway/bad-request: method "x" does not match endpoint "y"`。
 *
 * ⚠️ `payload` 必须是 `{ args: <普通对象> }` —— 直接给 `{}` 会被回
 *   `gateway/internal: Remote payload must contain exactly one plain-object args field`。
 *
 * ## ⚠️ CDP 的 `awaitPromise` 在设备自带的老内核上会永久挂住
 *
 * 所以这里一律「发起 fetch 不等待 → 结果存进 window → 轮询读回来」。
 */
const CDP = process.env.UIPROBE_CDP ?? 'http://127.0.0.1:19222/json/list';

const list = await (await fetch(CDP)).json();
const page = list.find((t) => t.type === 'page' && /^https?:/.test(t.url));
if (!page) { console.error('✗ 没有 page 目标'); process.exit(1); }
console.log(`页面: ${page.url}\n`);

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
async function api(endpoint, args = {}, timeoutMs = 12000) {
  const key = `__R${++id}_${seq++}`;
  const env = { type: 'client-request', rpcId: `${Date.now()}-${Math.random().toString(16).slice(2)}`, method: endpoint, payload: { args } };
  await ev(`(() => {
    window.${key} = null;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), ${timeoutMs - 1500});
    fetch('api/' + ${JSON.stringify(endpoint)}, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: ${JSON.stringify(JSON.stringify(env))},
      signal: ac.signal
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
  return { status: 0, body: `超时（${timeoutMs}ms）` };
}

// ── 用真实存在的路径 ─────────────────────────────────────────────────
const r1 = await api('settings/describe', {});
console.log(`settings/describe → HTTP ${r1.status}  ${r1.body.slice(0, 160)}`);

const r2 = await api('session/list', {});
console.log(`session/list      → HTTP ${r2.status}  ${r2.body.slice(0, 300)}`);

// ── 列出工具，验证 ui 工具真的注册进去了 ─────────────────────────────
for (const ep of ['tool/list', 'tools/list', 'plugin/list', 'dynamicCordisRunner/inventory', 'settings/describe']) {
  const r = await api(ep, {});
  const hit = r.status === 200 && !r.body.includes('gateway/internal');
  console.log(`${ep.padEnd(34)} → HTTP ${r.status}${hit ? `  ${r.body.slice(0, 300)}` : ''}`);
}

ws.close();
