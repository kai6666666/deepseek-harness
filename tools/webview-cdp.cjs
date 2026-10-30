#!/usr/bin/env node
/**
 * 设备内直连 WebView DevTools 抽象 socket（不需要 adb forward）。
 *
 *   run-as com.dsh.android files/termux/usr/bin/node files/webview-cdp.cjs --pid <pid>
 *   run-as com.dsh.android files/termux/usr/bin/node files/webview-cdp.cjs --pid <pid> --eval "document.title"
 *   ... --eval-file files/probe.js
 *
 * 为什么是 .cjs：node 26 把 .mjs 当 ESM，require 不可用。
 */
const net = require('net');
const fs = require('fs');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : def;
}

const pid = arg('pid', '');
if (!pid) { console.error('missing --pid'); process.exit(2); }
let expr = arg('eval', '');
const file = arg('eval-file', '');
if (file) expr = fs.readFileSync(file, 'utf8');
const sockPath = '\0webview_devtools_remote_' + pid;

function httpGet(pathname, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ path: sockPath });
    let raw = '';
    const done = () => { clearTimeout(t); s.destroy(); resolve(raw); };
    const t = setTimeout(() => { s.destroy(); reject(new Error('http timeout')); }, timeoutMs);
    s.on('connect', () => {
      s.write('GET ' + pathname + ' HTTP/1.1\r\nHost: localhost\r\nAccept: */*\r\n\r\n');
    });
    s.on('data', (d) => {
      raw += d.toString('utf8');
      const i = raw.indexOf('\r\n\r\n');
      if (i < 0) return;
      const head = raw.slice(0, i);
      const m = /content-length:\s*(\d+)/i.exec(head);
      if (!m) { done(); return; }
      const need = parseInt(m[1], 10);
      if (raw.length - (i + 4) >= need) done();
    });
    s.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

function bodyOf(raw) {
  const i = raw.indexOf('\r\n\r\n');
  return i >= 0 ? raw.slice(i + 4) : raw;
}

function wsConnect(pathname) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ path: sockPath });
    let pending = Buffer.alloc(0);
    let ok = false;
    const t = setTimeout(() => { s.destroy(); reject(new Error('ws timeout')); }, 8000);
    s.on('connect', () => {
      s.write('GET ' + pathname + ' HTTP/1.1\r\n' +
        'Host: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + Buffer.from(String(Math.random())).toString('base64') + '\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n');
    });
    s.on('data', (d) => {
      if (ok) return;
      pending = Buffer.concat([pending, d]);
      const i = pending.indexOf('\r\n\r\n');
      if (i < 0) return;
      const first = pending.slice(0, i).toString('utf8').split('\r\n')[0];
      if (!/ 101 /.test(first + ' ')) { clearTimeout(t); reject(new Error('handshake: ' + first)); return; }
      ok = true;
      clearTimeout(t);
      resolve({ socket: s, rest: pending.slice(i + 4) });
    });
    s.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.from([0x81, 0x80 | len]); }
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function decodeFrames(buf) {
  const out = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off], b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    let len = b1 & 0x7f, p = off + 2;
    if (len === 126) { if (buf.length < p + 2) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (buf.length < p + 8) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    if (buf.length < p + len) break;
    const payload = buf.slice(p, p + len);
    off = p + len;
    if (opcode === 1) out.push(payload.toString('utf8'));
  }
  return { messages: out, rest: buf.slice(off) };
}

(async () => {
  const listRaw = await httpGet('/json/list');
  let pages;
  try { pages = JSON.parse(bodyOf(listRaw)); }
  catch (e) { console.error('bad /json/list:', bodyOf(listRaw).slice(0, 200)); process.exit(3); }
  if (!pages.length) { console.error('no pages'); process.exit(4); }
  const page = pages.find(p => p.type === 'page') || pages[0];
  const wsPath = page.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, '');

  if (!expr) {
    console.log(JSON.stringify({ pages: pages.map(p => ({ title: p.title, url: p.url, ws: wsPath })) }, null, 2));
    return;
  }

  const { socket, rest } = await wsConnect(wsPath);
  let buf = rest && rest.length ? rest : Buffer.alloc(0);
  const waiters = new Map();
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    const { messages, rest: r } = decodeFrames(buf);
    buf = r;
    for (const m of messages) {
      let obj; try { obj = JSON.parse(m); } catch (e) { continue; }
      if (obj.id && waiters.has(obj.id)) { waiters.get(obj.id)(obj); waiters.delete(obj.id); }
    }
  });
  let id = 0;
  const call = (method, params) => new Promise((resolve) => {
    const myId = ++id;
    waiters.set(myId, resolve);
    socket.write(encodeFrame(JSON.stringify({ id: myId, method, params })));
    setTimeout(() => { if (waiters.has(myId)) { waiters.delete(myId); resolve({ error: 'timeout' }); } }, 15000);
  });

  const res = await call('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true, userGesture: true,
  });
  const v = res.result && res.result.result ? res.result.result.value : res;
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  socket.destroy();
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(5); });