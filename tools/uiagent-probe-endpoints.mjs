const CDP = process.env.UIPROBE_CDP ?? 'http://127.0.0.1:19222/json/list';
const list = await (await fetch(CDP)).json();
const page = list.find((t) => t.type === 'page' && /^https?:/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
function send(method, params) { const myId = ++id; return new Promise((resolve, reject) => { pending.set(myId, { resolve, reject }); ws.send(JSON.stringify({ id: myId, method, params })); }); }
async function ev(expr) { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)); return r.result.value; }

const d = JSON.parse(await ev(`JSON.stringify(window.__DSH_UI_PROBE__.run({action:'dump'}))`));
console.log(`视口 ${JSON.stringify(d.viewport)}  元素 ${d.elements.length} 个\n`);

// 所有 "新建会话" —— 看是不是有多个 DOM 层
const hits = d.elements.filter((e) => (e.text || '').includes('新建会话'));
console.log(`含「新建会话」的元素 ${hits.length} 个:`);
for (const e of hits) {
  console.log(`  tag=${e.tag} role=${e.role} center=(${e.center.x},${e.center.y}) w=${e.w} h=${e.h}`);
  console.log(`    screenCenter=${JSON.stringify(e.screenCenter)}  covered=${e.covered} offscreen=${e.offscreen}`);
  console.log(`    cls=${String(e.cls).slice(0,60)}`);
}

console.log('\n全部可点元素的 center / screenCenter:');
for (const e of d.elements.filter((x) => !x.covered && !x.offscreen).slice(0, 12)) {
  const t = (e.text || e.testid || e.aria || '').replace(/\s+/g,' ').slice(0,26);
  console.log(`  "${t}"  center(${e.center.x},${e.center.y})  screen=${JSON.stringify(e.screenCenter)}  [${e.tag}]`);
}
ws.close();
