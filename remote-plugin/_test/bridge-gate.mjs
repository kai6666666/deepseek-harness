/**
 * **桥路由准入（fail-closed）回归测试** —— 外部审计 5.1。
 *
 * ## 为什么单独立一条
 *
 * 引擎的 `webserver` 在路由命中**之前不做任何鉴权**，而 `match()` 是
 * 「精确表先命中」：本插件的 `kind:'exact'` 路由 `/api/dsh-remote/rpc`
 * 会比引擎自己的 `/api` 前缀路由**先**被选中，于是引擎那层门根本不会被调用。
 * 所以本插件必须自己加门（`bridgeRejection`）。
 *
 * 第一版的门在**取不到 `connection` 服务时回退到弱判据**（Host + Origin +
 * sec-fetch-site）—— 那是 **fail-open**：弱判据里**没有 cookie 这一条**，
 * 而非浏览器客户端（同机任意其它 App）天然不带 `sec-fetch-site`，于是全过。
 *
 * 更糟的是它**有一个必然出现的窗口**：cordis 的 `ctx.get(name, strict)` 对
 * 尚未 ACTIVE 的提供者返回 `undefined`，而 client-connection 的 `apply` 里
 * `await BrowserAuth.create(...)` 排在 `provide('connection')` **之前** ⇒
 * 引擎启动 / 插件重载 / `cordis.patch.yml` HMR 期间，本插件同步注册的路由
 * **已经在收请求**，而 `connection` 还没就绪。
 *
 * 本测试打在**真源码**上，验四件事：
 * ① `connection` 缺失 ⇒ **503**（不是 200，也不是 403 —— 要能区分
 *    「服务暂时没就绪」与「判据拒绝了」）；
 * ② `requestRejection` 抛错 ⇒ **503**（判据没跑成 = 没有判据，不能默认放行）；
 * ③ `requestRejection` 返回状态码 ⇒ 原样透传（引擎说 401 就是 401）；
 * ④ `requestRejection` 返回 `undefined` ⇒ 放行，请求真的被处理；
 * ⑤ 源码级：弱判据那段代码**必须彻底不存在**（防止将来有人「优化」回去）。
 *
 * ## 做法
 *
 * `apply()` 起来后直接向它注册的 webServer 路由发真 HTTP 请求。`DSH_HOME`
 * 指到临时目录，绝不碰真机状态。每换一种 `connection` 形态就重新 import
 * 一次模块（`?t=` 破缓存），因为 `bridgeRejection` 读的是每次调用时的 `ctx`。
 *
 * 用法：node bridge-gate.mjs
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';

const SRC = join(import.meta.dirname, '..', 'dsh-remote-mobile', 'lib', 'index.js');

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

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-bridge-'));

/**
 * 用给定的 `connection` 形态起一个插件实例，返回 `{port, logs}`。
 *
 * @param connection - `undefined` 表示服务未就绪；也可以是 `{requestRejection}`。
 */
async function startWith(connection) {
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
		inject: () => undefined,
		on: () => undefined,
		get: (name) => (name === 'connection' ? connection : undefined),
		sessions: { get: () => undefined },
		sessionController: {
			prompt: async () => ({ accepted: true }),
			cancel: async () => ({ accepted: true }),
		},
		webServer: {
			register: (route) => {
				const server = createServer((req, res) => route.handler(req, res));
				server.on('error', () => {});
				server.listen(port, '127.0.0.1');
				// ⚠️ `unref()` 是必须的：测试跑完进程要能干净退出。不 unref 的话
				// 未关闭的监听会让 node 在退出时打
				// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`
				// 并以非 0 码崩掉 —— 那会让 CI 把「全绿」判成失败。
				server.unref();
				return { dispose: () => server.close() };
			},
		},
		workspaceRegistry: undefined,
	};
	mod.apply(ctx);
	// 等端口起来。
	for (let i = 0; i < 60; i++) {
		try {
			await fetch(`http://127.0.0.1:${port}/api/dsh-remote/rpc`, { method: 'POST' });
			break;
		} catch {
			await new Promise((r) => setTimeout(r, 50));
		}
	}
	return { port, logs };
}

/** 打一次桥 RPC，返回状态码与解析后的 body（解析失败给 null）。 */
async function hit(port, method = '__probe__') {
	const res = await fetch(`http://127.0.0.1:${port}/api/dsh-remote/rpc`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ id: 'a', method, params: {} }),
	});
	const text = await res.text();
	let body = null;
	try {
		body = JSON.parse(text);
	} catch {
		body = null;
	}
	return { status: res.status, text, body };
}

// ── ① connection 缺失 ⇒ 503 ────────────────────────────────────────────────
console.log('=== ① connection 服务未就绪 ⇒ 必须 503（fail-closed）===');
{
	const { port, logs } = await startWith(undefined);
	const r = await hit(port);
	check(r.status === 503, '取不到 connection 时返回 503', `实际 ${r.status}`);
	check(
		!r.text.includes('unknown method'),
		'请求没有被真正处理（body 里没有 handler 的输出）',
		r.text.slice(0, 80),
	);
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
	check(
		!r.text.includes('unknown method'),
		'请求没有被真正处理',
		r.text.slice(0, 80),
	);
}

// ── ③ requestRejection 返回状态码 ⇒ 原样透传 ───────────────────────────────
console.log('=== ③ 引擎判 401 ⇒ 原样 401（不能吞掉、也不能改成 200）===');
{
	const { port } = await startWith({ requestRejection: () => 401 });
	const r = await hit(port);
	check(r.status === 401, '透传引擎的 401', `实际 ${r.status}`);
	check(r.text === '', '拒绝时不返回任何 body（不给探测者反馈）', JSON.stringify(r.text));
}
{
	const { port } = await startWith({ requestRejection: () => 403 });
	const r = await hit(port);
	check(r.status === 403, '透传引擎的 403', `实际 ${r.status}`);
}

// ── ④ 放行 ⇒ 请求真的被处理 ────────────────────────────────────────────────
console.log('=== ④ 引擎放行 ⇒ 请求真的进 handler ===');
{
	const { port } = await startWith({ requestRejection: () => undefined });
	const r = await hit(port, '__probe__');
	check(r.status === 200, '放行时返回 200', `实际 ${r.status}`);
	check(
		typeof r.body?.error === 'string' && r.body.error.includes('unknown method'),
		'确实是 handler 在应答（未知方法错误）',
		r.text.slice(0, 100),
	);
}

// ── ⑤ 源码级：弱判据必须彻底不存在 ─────────────────────────────────────────
console.log('=== ⑤ 源码级：不查 cookie 的弱判据必须不存在 ===');
{
	const source = readFileSync(SRC, 'utf8');
	check(
		!source.includes('bridgeFallbackWarned'),
		'旧的 bridgeFallbackWarned 标记已删除',
	);
	check(
		!source.includes('退回弱判据'),
		'源码里不再有「退回弱判据」这条路径',
	);
	// 弱判据的特征代码：自己判 sec-fetch-site / Origin 同源。
	check(
		!source.includes("'sec-fetch-site'"),
		'源码里不再自己判 sec-fetch-site（判据只从引擎来）',
	);
	check(
		!/hostname === '127\.0\.0\.1'/.test(source),
		'源码里不再自己判 Host 是 loopback（那是弱判据的核心）',
	);
	check(
		source.includes('return 503;'),
		'存在 fail-closed 的 503 返回',
	);
}

console.log('');
console.log(failed === 0 ? '全部通过 ✅' : `失败 ${failed} 项 ❌`);
// ⚠️ 不要 `process.exit()`：监听已 unref，进程会自然退出。强行 exit 会和
// 正在关闭的 socket 抢，Windows 上就报那个 UV_HANDLE_CLOSING 断言。
process.exitCode = failed === 0 ? 0 : 1;
