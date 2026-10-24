/**
 * **市场目录接口准入（fail-closed）回归测试** —— 外部审计 5.1「同类问题第二例」。
 *
 * ## 为什么要单独立一条
 *
 * `/api/dsh-android/market` 是**精确路径**注册的，而引擎 `match()` 是
 * 「精确表先命中、再长前缀胜」：`/api/dsh-android/market`(23) 比 `/api`(4) 长
 * ⇒ **引擎自己的 cookie 门根本不会被走到**。第一版只判了 `req.method !== 'GET'`，
 * 实测带 `Host: evil.example` 的无凭据请求拿到 **200 + 全量目录**，
 * `?refresh=1` 还能让手机去扫 200+ 个 npm packument。
 *
 * 攻击者是**手机上任意其它 App**（Android loopback 跨 App 可达），
 * 前置条件只是「App 在跑」。所以这道门必须由插件自己加。
 *
 * ## 判据要点
 *
 * 与手机桥（`dsh-remote-mobile` 的 `bridgeRejection`）同款取舍：
 * `connection` 取不到 ⇒ **503**，绝不降级到「只判方法」那种 fail-open 判据。
 *
 * ⚠️ 本测试额外断言**门在方法判定之前**：反过来的话，一个 `POST` 会先拿到
 * 405 —— 那本身就是「这个路由存在」的存在性信号，还给攻击者省一次探测。
 *
 * 用法：node market-gate.mjs
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';

const SRC = join(
	import.meta.dirname,
	'..',
	'..',
	'market-plugin',
	'dsh-android-market',
	'lib',
	'index.js',
);
const ROUTE = '/api/dsh-android/market';

let failed = 0;
const check = (ok, label, detail = '') => {
	console.log(`${ok ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`);
	if (!ok) failed += 1;
};

/** 找一个空闲端口。 */
async function freePort() {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});
}

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-market-'));

/**
 * 用给定的 `connection` 形态起一个插件实例。
 *
 * @param connection - `undefined` 表示服务未就绪；也可以是 `{requestRejection}`。
 */
async function startWith(connection, { withWebServer = true } = {}) {
	const port = await freePort();
	const logs = [];
	const mod = await import(`${pathToFileURL(SRC).href}?t=${Date.now()}${Math.random()}`);
	const ctx = {
		logger: {
			info: (m) => logs.push(['info', String(m)]),
			warn: (m) => logs.push(['warn', String(m)]),
			error: (m) => logs.push(['error', String(m)]),
		},
		effect: (fn) => {
			const dispose = fn();
			return typeof dispose === 'function' ? dispose : undefined;
		},
		get: (name) => (name === 'connection' ? connection : undefined),
		webServer: withWebServer
			? {
					register: (route) => {
						const server = createServer((req, res) => route.handler(req, res));
						server.on('error', () => {});
						server.listen(port, '127.0.0.1');
						// ⚠️ 必须 unref：否则进程退出时残留监听会让 node 报
						// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`。
						server.unref();
						return { dispose: () => server.close() };
					},
				}
			: undefined,
	};
	await mod.apply(ctx);
	for (let i = 0; i < 60; i++) {
		try {
			await fetch(`http://127.0.0.1:${port}${ROUTE}`);
			break;
		} catch {
			await new Promise((r) => setTimeout(r, 50));
		}
	}
	return { port, logs };
}

/**
 * 打一次目录接口。
 *
 * ⚠️ **必须用 `node:http` 而不是 `fetch`**：undici（node 的 fetch）**忽略**
 * 调用方传进来的 `host` 头，一律用真实地址填。而审计的判据正是
 * 「`Host: evil.example` 能不能拿到 200」—— 用 fetch 发的话那个头根本没出去，
 * 断言会**假通过**（测的是 127.0.0.1）。那是测试在骗自己。
 */
async function hit(port, { method = 'GET', url = ROUTE, host } = {}) {
	const { request } = await import('node:http');
	return new Promise((resolve, reject) => {
		const headers = {};
		if (host) headers.host = host;
		const req = request({ host: '127.0.0.1', port, path: url, method, headers }, (res) => {
			let text = '';
			res.setEncoding('utf8');
			res.on('data', (c) => (text += c));
			res.on('end', () => resolve({ status: res.statusCode, text }));
		});
		req.on('error', reject);
		req.end();
	});
}

// ── ① connection 缺失 ⇒ 503 ────────────────────────────────────────────────
console.log('=== ① connection 服务未就绪 ⇒ 必须 503（fail-closed）===');
{
	const { port, logs } = await startWith(undefined);
	const r = await hit(port);
	check(r.status === 503, '取不到 connection 时返回 503', `实际 ${r.status}`);
	check(!r.text.includes('featured'), '没有返回目录内容', r.text.slice(0, 80));
	check(
		logs.some(([, m]) => m.includes('fail-closed')),
		'打了一条 fail-closed 告警（运维可见）',
	);
}

// ── ② requestRejection 抛错 ⇒ 503 ─────────────────────────────────────────
console.log('=== ② requestRejection 抛错 ⇒ 必须 503（判据没跑成 = 没有判据）===');
{
	const { port } = await startWith({
		requestRejection: () => {
			throw new Error('browserAuth 还没建好');
		},
	});
	const r = await hit(port);
	check(r.status === 503, '抛错时返回 503', `实际 ${r.status}`);
	check(!r.text.includes('featured'), '没有返回目录内容', r.text.slice(0, 80));
}

// ── ③ 引擎判 401/403 ⇒ 原样透传 ────────────────────────────────────────────
console.log('=== ③ 引擎判 401/403 ⇒ 原样透传（不能改成 200）===');
for (const expected of [401, 403]) {
	const { port } = await startWith({ requestRejection: () => expected });
	const r = await hit(port, { host: 'evil.example' });
	check(r.status === expected, `透传引擎的 ${expected}`, `实际 ${r.status}`);
}
{
	// ⚠️ 审计的实测判据就是这一条：任何带门的版本都不可能对
	// `Host: evil.example` 返回 200。
	const { port } = await startWith({ requestRejection: () => 403 });
	const r = await hit(port, { host: 'evil.example' });
	check(r.status !== 200, 'Host: evil.example 拿不到 200 全量目录', `实际 ${r.status}`);
}

// ── ④ 门在方法判定之前 ─────────────────────────────────────────────────────
console.log('=== ④ 方法判定必须在门之后（否则 405 泄露路由存在性）===');
{
	const { port } = await startWith(undefined);
	const r = await hit(port, { method: 'POST' });
	check(r.status === 503, 'POST + 服务未就绪 ⇒ 503 而不是 405', `实际 ${r.status}`);
}
{
	const { port } = await startWith({ requestRejection: () => 403 });
	const r = await hit(port, { method: 'DELETE' });
	check(r.status === 403, 'DELETE + 判据拒绝 ⇒ 403 而不是 405', `实际 ${r.status}`);
}

// ── ⑤ 放行 ⇒ 请求真的进 handler ────────────────────────────────────────────
console.log('=== ⑤ 引擎放行 ⇒ 请求真的进 handler ===');
{
	const { port } = await startWith({ requestRejection: () => undefined });
	const r = await hit(port);
	check(r.status === 200, '放行时返回 200', `实际 ${r.status}`);
	check(
		r.text.includes('featured') || r.text.includes('community'),
		'返回的是目录 JSON',
		r.text.slice(0, 80),
	);
}
{
	// 放行之后 405 才该出现。
	const { port } = await startWith({ requestRejection: () => undefined });
	const r = await hit(port, { method: 'POST' });
	check(r.status === 405, '放行后非 GET/HEAD ⇒ 405', `实际 ${r.status}`);
}

// ── ⑥ 源码级：不许再有「只判方法」的门 ─────────────────────────────────────
console.log('=== ⑥ 源码级：门必须存在且在最前面 ===');
{
	const source = readFileSync(SRC, 'utf8');
	check(source.includes('function marketRejection('), '存在 marketRejection');
	check(
		source.includes("ctx.get?.('connection')"),
		'判据从引擎的 connection 服务来（不是自己判 Host）',
	);
	check(source.includes('return 503;'), '存在 fail-closed 的 503 返回');
	check(
		!/hostname === '127\.0\.0\.1'/.test(source),
		'源码里没有自己判 Host 是 loopback 的弱判据',
	);
	// 门必须在方法判定之前出现。
	// ⚠️ 从 `export function apply` 之后开始找：docstring 里**故意写着**
	// `req.method !== 'GET'`（那是描述第一版的门），全文 indexOf 会命中注释，
	// 于是断言恒假 —— 那是断言写错了，不是代码错了。
	const body = source.slice(source.indexOf('export function apply'));
	const gateAt = body.indexOf('marketRejection(ctx, req)');
	const methodAt = body.indexOf("req.method !== 'GET'");
	check(
		gateAt >= 0 && methodAt >= 0 && gateAt < methodAt,
		'门在方法判定之前',
		`gate@${gateAt} method@${methodAt}`,
	);
}

console.log('');
console.log(failed === 0 ? '全部通过 ✅' : `失败 ${failed} 项 ❌`);
// ⚠️ 不要 `process.exit()`：监听已 unref，进程会自然退出。
process.exitCode = failed === 0 ? 0 : 1;
