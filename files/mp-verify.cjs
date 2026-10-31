/**
 * mp-verify.cjs —— 一次连 CDP 跑完三段取证，结构化落盘。
 * 用法： node files/mp-verify.cjs <pid> <out.json> [version]
 * 输出： {"ok":true,"items":[...],"clicked":true,"mode":"创造模式","text":"...","match":true,"msgs":0,
 *         "stages":{"ev1":"ok","ev2":"ok","ev3":"ok"},"ms":12345}
 */
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');

const pid = process.argv[2];
const outPath = process.argv[3] || ('files/verify-' + pid + '.json');
const version = process.argv[4] || '';
const sockPath = '\0webview_devtools_remote_' + pid;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(p) {
  return new Promise((res, rej) => {
    const s = net.connect({ path: sockPath });
    let raw = '';
    s.on('connect', () => s.write('GET ' + p + ' HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
    s.on('data', (d) => { raw += d.toString(); });
    s.on('close', () => res(raw));
    s.on('error', rej);
    setTimeout(() => { s.destroy(); res(raw); }, 4000);
  });
}

function call(path, method, params, timeout) {
  return new Promise((res, rej) => {
    const s = net.connect({ path: sockPath });
    const key = crypto.randomBytes(16).toString('base64');
    let buf = Buffer.alloc(0), hs = false, done = false;
    const fin = (fn, v) => { if (!done) { done = true; try { s.destroy(); } catch (e) {} fn(v); } };
    s.on('connect', () => s.write('GET ' + path + ' HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!hs) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        hs = true; buf = buf.slice(i + 4);
        const pl = Buffer.from(JSON.stringify({ id: 1, method, params }));
        const mask = crypto.randomBytes(4);
        let head;
        if (pl.length < 126) head = Buffer.from([0x81, 0x80 | pl.length]);
        else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(pl.length, 2); }
        const m = Buffer.from(pl);
        for (let k = 0; k < m.length; k++) m[k] ^= mask[k % 4];
        s.write(Buffer.concat([head, mask, m]));
      }
      while (buf.length >= 2) {
        const l0 = buf[1] & 0x7f;
        let off = 2, len = l0;
        if (l0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (l0 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const data = buf.slice(off, off + len).toString();
        buf = buf.slice(off + len);
        try {
          const msg = JSON.parse(data);
          if (msg.id === 1) return fin(res, JSON.stringify(msg.result || msg));
        } catch (e) {}
      }
    });
    s.on('error', (e) => fin(rej, e));
    setTimeout(() => fin(rej, new Error('ws timeout')), timeout || 12000);
  });
}

// ① 打开抽屉 → 点一个会话：点击会同步触发页面重建，所以把动作丢进 setTimeout，立刻回话
const EV1 = `(()=>{setTimeout(()=>{try{const scan=(s,f)=>[...document.querySelectorAll(s)].find(f);const vis=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0};const nav=scan('button',e=>e.getAttribute('aria-label')==='打开导航');nav&&nav.click();setTimeout(()=>{try{const skip=/^(新建会话|插件|自动化任务|搜索会话|设置|视图选项|添加工作区|收起侧边栏|账号菜单|打开导航)$/;const rows=[...document.querySelectorAll('[class*="session" i], a, [role=button]')].filter(e=>{const t=(e.textContent||'').trim();const r=e.getBoundingClientRect();return vis(e)&&r.height>14&&r.height<64&&t.length>1&&t.length<60&&!skip.test(t)&&t.indexOf('工作区')<0&&t.indexOf('新会话')<0});const row=rows.sort((a,b)=>a.getBoundingClientRect().height-b.getBoundingClientRect().height)[0];if(row)row.dispatchEvent(new MouseEvent('click',{bubbles:true}));}catch(e){}},700);}catch(e){}},0);return 'scheduled';})()`;

// ② 开 ⋯ 读七行（不点），返 JSON
const EV2A = `(async()=>{const sleep=ms=>new Promise(r=>setTimeout(r,ms));const scan=(s,f)=>[...document.querySelectorAll(s)].find(f);const more=scan('.wSkVaW_header button',e=>e.getAttribute('aria-label')==='更多操作');more&&more.click();await sleep(1500);const items=[...document.querySelectorAll('[role=menuitem]')].map(e=>e.textContent.trim());return JSON.stringify({items:items});})()`;

// ②b 点「创建你的插件」：同样丢进 setTimeout，立刻回话
const EV2B = `(()=>{setTimeout(()=>{try{const scan=(s,f)=>[...document.querySelectorAll(s)].find(f);const it=scan('[data-mp-plugin-item] [role=menuitem], [data-mp-plugin-item] button',e=>(e.textContent||'').trim()==='创建你的插件');it&&it.click();}catch(e){}},0);return 'scheduled';})()`;

// ③ 读三项：模式 / 文案 / 消息条数
const EV3 = `(()=>{const trig=[...document.querySelectorAll('button,[role=button]')].find(e=>/^(标准模式|PTC 模式|极简模式|创造模式)/.test((e.textContent||'').trim()));const ed=document.querySelector('[contenteditable=true][role=textbox],[contenteditable=true]');const t=(ed&&ed.textContent)||'';return JSON.stringify({mode:trig?(trig.textContent||'').trim():null,text:t.slice(0,40),match:t.trim()==='创建一个带会话视图入口的 DSH 插件。',msgs:document.querySelectorAll('[class*=_message_]').length});})()`;

async function evalExpr(path, expr, timeout) {
  const raw = await call(path, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, timeout);
  const obj = JSON.parse(raw);
  if (obj.exceptionDetails) throw new Error('js: ' + JSON.stringify(obj.exceptionDetails.text || obj.exceptionDetails));
  const v = obj.result && obj.result.value;
  if (typeof v !== 'string') throw new Error('no value: ' + raw.slice(0, 120));
  return v;
}

async function retry(label, fn, times, gap) {
  let err;
  for (let i = 1; i <= times; i++) {
    try { return { v: await fn(), tries: i }; } catch (e) { err = e; await sleep(gap || 1500); }
  }
  throw new Error(label + ': ' + (err && err.message));
}

// MP_RETRY=n 追加 n 次重试（默认 0），便于偶发超时时一键加压
const EXTRA = Math.max(0, parseInt(process.env.MP_RETRY || '0', 10) || 0);
// MP_ATTEMPT=0 表示设备脚本第 1 轮，1 表示重试轮
const ATTEMPT = Math.max(0, parseInt(process.env.MP_ATTEMPT || '0', 10) || 0);

(async () => {
  const t0 = Date.now();
  const res = { ok: false, version, stages: {}, retries: {}, retry_cfg: EXTRA, attempt: ATTEMPT, items: [], clicked: false, mode: null, text: '', match: false, msgs: -1 };
  try {
    let target = '';
    const listRaw = (await retry('json/list', () => httpGet('/json/list'), 6 + EXTRA, 800)).v;
    const body = listRaw.slice(listRaw.indexOf('\r\n\r\n') + 4);
    const list = JSON.parse(body);
    const pick = list.filter((x) => (x.url || '').includes('3080')).pop() || list[0];
    if (!pick || !pick.webSocketDebuggerUrl) throw new Error('no target');
    target = pick.webSocketDebuggerUrl.replace('ws://localhost', '');
    res.target = target;

    // ev1：只负责把点击排进队列，不等结果（点了会重建页面）
    const e1 = await retry('ev1', async () => { await evalExpr(target, EV1, 12000); return 'ok'; }, 3 + EXTRA, 2000)
      .catch((e) => ({ v: 'fail: ' + e.message, tries: 3 + EXTRA }));
    res.stages.ev1 = e1.v;
    res.retries.ev1 = e1.tries - 1;
    await sleep(3500);

    // ev2a：开 ⋯ 读七行；菜单最多等 1.5s，读到 ≤2 行就重开一次
    const e2 = await retry('ev2a', async () => {
      const o = JSON.parse(await evalExpr(target, EV2A, 12000));
      if (!o.items || o.items.length < 5) throw new Error('items=' + (o.items || []).length);
      return o;
    }, 4 + EXTRA, 1800).catch((e) => ({ v: { items: [], error: e.message }, tries: 4 + EXTRA }));
    res.items = e2.v.items || [];
    res.stages.ev2a = e2.v.error ? 'fail: ' + e2.v.error : 'ok';
    res.retries.ev2a = e2.tries - 1;

    // ev2b：在菜单仍开着时点「创建你的插件」；点击动作丢进 setTimeout，回话先行
    const e3 = await retry('ev2b', async () => {
      const probe = await evalExpr(target, "(()=>{const e=[...document.querySelectorAll('[data-mp-plugin-item] [role=menuitem], [data-mp-plugin-item] button')].find(x=>(x.textContent||'').trim()==='创建你的插件');return e?'yes':'no';})()", 8000);
      if (probe !== 'yes') throw new Error('item not found');
      await evalExpr(target, EV2B, 8000);
      return true;
    }, 4 + EXTRA, 1800).catch(() => ({ v: false, tries: 4 + EXTRA }));
    res.clicked = e3.v;
    res.stages.ev2b = e3.v ? 'ok' : 'fail';
    res.retries.ev2b = e3.tries - 1;

    await sleep(10000);

    const e4 = await retry('ev3', async () => JSON.parse(await evalExpr(target, EV3, 10000)), 3 + EXTRA, 2000);
    res.mode = e4.v.mode;
    res.text = e4.v.text;
    res.match = !!e4.v.match;
    res.msgs = e4.v.msgs;
    res.stages.ev3 = 'ok';
    res.retries.ev3 = e4.tries - 1;
    res.ok = res.clicked && res.match && res.msgs === 0;
  } catch (e) {
    res.error = e.message;
    res.stages.conn = 'fail: ' + e.message;
  }
  res.ms = Date.now() - t0;
  res.stage_sum = Object.entries(res.stages).map(([k, v]) => `${k}:${String(v).split(' ')[0]}(r${res.retries[k] || 0})`).join(',');
  res.sum = `stages=${res.stage_sum} retries=${Object.values(res.retries).reduce((a, b) => a + b, 0)} retry_cfg=${EXTRA} attempt=${ATTEMPT} ms=${res.ms}`;
  try { fs.writeFileSync(outPath, JSON.stringify(res, null, 2)); } catch (e) { res.writeError = e.message; }
  try { fs.writeFileSync(outPath + '.sum', res.sum); } catch (e) {}
  console.log(JSON.stringify(res));
  process.exit(res.ok ? 0 : 2);
})();
