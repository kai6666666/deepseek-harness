/**
 * mp-probe.cjs —— 在设备 WebView 里执行一段 JS，返回字符串结果。
 * 用法： node files/mp-probe.cjs <pid> <expr-file>
 */
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const pid = process.argv[2];
const expr = fs.readFileSync(process.argv[3], 'utf8');
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
    setTimeout(() => fin(rej, new Error('ws timeout')), timeout || 15000);
  });
}

(async () => {
  try {
    const listRaw = await httpGet('/json/list');
    const body = listRaw.slice(listRaw.indexOf('\r\n\r\n') + 4);
    const list = JSON.parse(body);
    const pick = list.filter((x) => (x.url || '').includes('3080')).pop() || list[0];
    const target = pick.webSocketDebuggerUrl.replace('ws://localhost', '');
    const raw = await call(target, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, 20000);
    const obj = JSON.parse(raw);
    if (obj.exceptionDetails) {
      console.log('JS-ERROR ' + JSON.stringify(obj.exceptionDetails.text || obj.exceptionDetails));
      process.exit(1);
    }
    console.log(obj.result && obj.result.value);
  } catch (e) {
    console.log('PROBE-ERROR ' + (e && e.message));
    process.exit(1);
  }
})();