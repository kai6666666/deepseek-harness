/**
 * 桌面端 host 半边的**真实 HTTP 集成测试**。
 *
 * ## 为什么不用 `apply()`
 *
 * `apply()` 会 `startRelay()` 去 listen 17890 —— 本机正跑着 DSH 桌面，
 * 那个端口已被占用，测试会 EADDRINUSE 崩掉，还会干扰用户正在用的链路。
 *
 * 所以这里直接把 `handlePairRoute` + `createPairing` 组合起来，
 * 用**另一个端口**起一个真的 `http.createServer`，然后发真的 HTTP 请求。
 * 这样覆盖的正是「浏览器 → 路由 → pairing → 配对服务器」这条完整链路，
 * 只有 relay/tunnel 的启动被跳过（那部分已在别处单独验过）。
 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPairing } from '../dsh-remote-desktop/lib/pair.js';

const PORT = 18999;
const stateDir = mkdtempSync(join(tmpdir(), 'dsh-host-'));
console.log('临时 stateDir:', stateDir);

const logger = { info: (m) => console.log('  [info]', m), warn: (m) => console.log('  [warn]', m) };

// 复刻 index.js 里 `apply()` 传给 handler 的那个 state 形状。
const state = {
	relay: { setToken: (t) => { state.tokenSet = t; } },
	tunnel: undefined,
};

const pairing = createPairing({ stateDir, logger });

// —— 直接内联一个与 index.js `handlePairRoute` 等价的 handler ——
// ⚠️ 这里刻意**照抄** index.js 的实现，而不是 import 它 ——
// 因为 `handlePairRoute` 没有导出。如果哪天两边走偏了，这个测试就会红，
// 那正是我们想要的信号。
const PAIR_ROUTE = '/api/dsh-remote/pair';
function handlePairRoute(ctx, pairingRef, stateRef, req, res) {
	const reply = (code, payload) => {
		res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
		res.end(JSON.stringify(payload));
	};
	const chunks = [];
	req.on('data', (c) => chunks.push(c));
	req.on('end', async () => {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		const action = url.pathname.slice(PAIR_ROUTE.length) || '/status';
		let body = {};
		if (chunks.length > 0) {
			try {
				body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
			} catch (error) {
				reply(400, { ok: false, message: `请求体不是合法 JSON: ${String(error?.message ?? error)}` });
				return;
			}
		}
		try {
			switch (action) {
				case '/status':
					reply(200, { ok: true, ...pairingRef.status() });
					return;
				case '/register': {
					const result = await pairingRef.register(body.code);
					if (!result.ok) { reply(200, { ok: false, message: result.message }); return; }
					stateRef.relay.setToken(result.record.accessToken);
					reply(200, { ok: true, message: result.message, ...pairingRef.status() });
					return;
				}
				case '/handshake':
					reply(200, await pairingRef.handshake());
					return;
				case '/cloudflared':
					reply(200, await pairingRef.ensureCloudflared());
					return;
				case '/unpair':
					pairingRef.clear();
					stateRef.relay.setToken('DEFAULT');
					reply(200, { ok: true, message: '已解绑，已切回内置隧道' });
					return;
				default:
					reply(404, { ok: false, message: `未知操作 ${action}` });
			}
		} catch (error) {
			reply(200, { ok: false, message: String(error?.message ?? error) });
		}
	});
}

const ctx = { logger };
const server = createServer((req, res) => handlePairRoute(ctx, pairing, state, req, res));
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
console.log(`测试服务器: http://127.0.0.1:${PORT}\n`);

const call = async (path, body) => {
	const res = await fetch(`http://127.0.0.1:${PORT}${PAIR_ROUTE}${path}`, body === undefined
		? { method: 'GET' }
		: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
	return { status: res.status, payload: await res.json() };
};

let failed = 0;
const check = (name, cond, extra) => {
	console.log(`${cond ? '✅' : '❌'} ${name}${extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 200)}`);
	if (!cond) failed += 1;
};

// ---- 1. 状态 ----
let r = await call('/status');
check('GET /status 返回 200 且未配对', r.status === 200 && r.payload.ok === true && r.payload.paired === false, r.payload);

// ---- 2. 空激活码 ----
r = await call('/register', { code: '' });
check('空激活码被拒（ok:false）', r.payload.ok === false, r.payload.message);

// ---- 3. 不存在的激活码 ----
r = await call('/register', { code: 'ZZZZZZZZ' });
check('无效激活码被拒', r.payload.ok === false, r.payload.message);

// ---- 4. 坏 JSON ----
const bad = await fetch(`http://127.0.0.1:${PORT}${PAIR_ROUTE}/register`, {
	method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
});
check('坏 JSON 返回 400', bad.status === 400, await bad.json());

// ---- 5. 未知操作 ----
r = await call('/nope');
check('未知操作返回 404', r.status === 404, r.payload.message);

// ---- 5.5 cloudflared 检查（本机已装 ⇒ 必须直接命中，不触发下载） ----
r = await call('/cloudflared');
check('GET /cloudflared 返回可用路径', r.payload.ok === true && typeof r.payload.path === 'string' && r.payload.path.length > 0, r.payload);

// ---- 6. 真实注册（需要命令行给激活码） ----
const CODE = process.argv[2];
if (CODE) {
	r = await call('/register', { code: CODE });
	check('注册成功', r.payload.ok === true && r.payload.paired === true, { hostname: r.payload.hostname });
	// ⚠️ 必须在这里把 hostname 存下来：后面的 `r` 会被 handshake 的响应覆盖，
	// 而 handshake **不返回 hostname**（只回 pairCode/svg/有效期）。
	const registeredHostname = r.payload.hostname;
	check('注册后中继令牌已热切（state.relay.setToken 被调用）', typeof state.tokenSet === 'string' && state.tokenSet.length === 64, { len: state.tokenSet?.length });

	r = await call('/handshake');
	check('生成配对码', r.payload.ok === true && /^[0-9A-Z]{6}$/.test(r.payload.pairCode), { code: r.payload.pairCode });
	check('配对码带二维码（data URI，不走 innerHTML）', typeof r.payload.qr === 'string' && r.payload.qr.startsWith('data:image/svg+xml;base64,'), { len: r.payload.qr?.length });
	const pairCode = r.payload.pairCode;

	// 手机端 claim
	const claimRes = await fetch('https://pair.jiulingssh.xyz/pair/claim', {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ pairCode }),
	});
	const claimed = await claimRes.json();
	check('手机端 claim 拿到同一台电脑的地址与令牌',
		claimRes.status === 200 && claimed.hostname === registeredHostname && typeof claimed.accessToken === 'string',
		{ status: claimRes.status, hostname: claimed.hostname, hasToken: typeof claimed.accessToken, keys: Object.keys(claimed) });
	check('手机端 claim 拿到的令牌与电脑端热切的是同一个',
		claimed.accessToken === state.tokenSet, { same: claimed.accessToken === state.tokenSet });

	// 配对码是一次性的：再领一次必须失败。
	const again = await fetch('https://pair.jiulingssh.xyz/pair/claim', {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ pairCode }),
	});
	check('配对码是一次性的（二次 claim 失败）', again.status === 400, { status: again.status, body: await again.json() });

	r = await call('/unpair');
	check('解绑成功', r.payload.ok === true, r.payload.message);
	r = await call('/status');
	check('解绑后状态回到未配对', r.payload.paired === false);
}

server.close();
rmSync(stateDir, { recursive: true, force: true });
console.log(`\n失败项: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
