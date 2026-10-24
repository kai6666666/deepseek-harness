/**
 * **电脑端 `/pair/*` 准入（fail-closed）回归测试** —— 外部审计 4.1 / P0-12。
 *
 * ## 为什么要单独立一条
 *
 * 引擎的 `webserver` 在路由命中**之前不做任何鉴权**，而 `match()` 是
 * 「精确表先命中、再最长前缀」：本插件的 `/api/dsh-remote/pair`(20) 比引擎的
 * `/api`(4) 长 ⇒ 请求落进本插件 handler，**引擎那层 cookie 门根本不会被调用**。
 *
 * 第一版只有 `pairRequestAllowed` 一条，它只做**浏览器向的 CSRF 防护**
 * （Host 是 loopback + `sec-fetch-site` + Origin 同源）。挡不住**同机其它进程 /
 * 同机另一个用户**：它们打 `127.0.0.1` 时 Host 也是 loopback，而非浏览器客户端
 * 根本不带 `sec-fetch-site`。攻击链是「偷配对码 → 换 accessToken → 驱动真 agent」。
 *
 * 中途那一版补了引擎判据，但**取不到 `connection` 时 fail-open**（退回弱判据），
 * 理由是「否则还没建会话的用户打不开配对界面」。⚠️ 那个理由是错的：
 * `connection` **服务**是否存在 ≠ 用户有没有登录 —— 前者是 cordis 的服务注册，
 * 引擎启动后必然就绪。现在改成与手机端同款 **fail-closed（503）**，
 * 并留一个显式逃生口 `DSH_REMOTE_ALLOW_WEAK_GATE=1`。
 *
 * 本测试打在**真源码**上（`apply()` 起真插件、发真 HTTP 请求），断言：
 * ① `connection` 缺失 ⇒ **503**（不是 200、也不是 403 —— 要能区分
 *    「服务暂时没就绪」与「判据拒绝了」）；且**没有任何令牌/主机名泄漏**；
 * ② `requestRejection` 抛错 ⇒ **503**；
 * ③ 返回状态码 ⇒ 原样透传；返回 `undefined` ⇒ 放行；
 * ④ 弱判据自身仍然生效（非 loopback Host ⇒ 403）；
 * ⑤ 逃生口打开时才退回弱判据，且**每次都告警**；
 * ⑥ 源码级：`pairGateAllowed`（旧的 fail-open 名字）必须彻底不存在。
 *
 * 用法：node desktop-pair-gate.mjs
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';

const SRC = join(import.meta.dirname, '..', 'dsh-remote-desktop', 'lib', 'index.js');
const ROUTE = '/api/dsh-remote/pair';

let failed = 0;
const check = (ok, label, detail = '') => {
	console.log(`${ok ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`);
	if (!ok) failed += 1;
};

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

/** 每次起一个全新 state 目录，绝不碰真机状态。 */
function freshHome() {
	return mkdtempSync(join(tmpdir(), 'dsh-desktop-gate-'));
}

/**
 * 起一个插件实例，返回 `{port, logs}`。
 *
 * @param connection - `undefined` = 服务未就绪；`{requestRejection}` = 引擎判据。
 * @param env - 额外环境变量（逃生口测试用）。
 */
async function startWith(connection, env = {}) {
	const port = await freePort();
	const logs = [];
	// ⚠️ 环境变量在 import **之前**设：`pairWeakGateFallback` 每次调用读
	// `process.env`，但 `apply()` 里的其它路径可能在 import 时就读过了。
	for (const [k, v] of Object.entries(env)) process.env[k] = v;
	if (!('DSH_REMOTE_ALLOW_WEAK_GATE' in env)) delete process.env.DSH_REMOTE_ALLOW_WEAK_GATE;

	const stateDir = freshHome();
	const mod = await import(`${pathToFileURL(SRC).href}?t=${Date.now()}${Math.random()}`);

	const routes = [];
	const ctx = {
		logger: {
			info: (m) => logs.push(String(m)),
			warn: (m) => logs.push(String(m)),
			error: (m) => logs.push(String(m)),
		},
		effect: (fn) => {
			const dispose = fn();
			return typeof dispose === 'function' ? dispose : undefined;
		},
		inject: () => undefined,
		on: () => undefined,
		get: (name) => (name === 'connection' ? connection : undefined),
		sessions: { get: () => undefined },
		sessionController: { create: async () => ({ ok: true }), prompt: async () => ({ ok: true }) },
		webServer: {
			register: (route) => {
				routes.push(route);
				return { dispose: () => {} };
			},
		},
	};
	// `STATE_DIR` 是模块级常量，由 `DSH_HOME` 推导 —— 在这里设已经晚了，
	// 所以上面 import 之前就要有。这里再确认一次路径落在临时目录里。
	process.env.DSH_HOME = stateDir;
	mod.apply(ctx, { autoTunnel: false });

	if (routes.length === 0) throw new Error('插件没有注册任何路由');
	const route = routes.find((r) => r.path === ROUTE) ?? routes[0];
	const server = createServer((req, res) => route.handler(req, res));
	server.on('error', () => {});
	server.listen(port, '127.0.0.1');
	// ⚠️ 必须 unref：残留监听会让 node 退出时报
	// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`。
	server.unref();
	for (let i = 0; i < 60; i++) {
		try {
			await fetch(`http://127.0.0.1:${port}${ROUTE}/status`);
			break;
		} catch {
			await new Promise((r) => setTimeout(r, 50));
		}
	}
	return { port, logs };
}

/**
 * 打一次配对路由。
 *
 * ⚠️ **必须用 `node:http` 而不是 `fetch`**：undici（node 的 fetch）**忽略**
 * 调用方传进来的 `host` 头，一律用真实地址填。于是「Host: evil.example」
 * 这个用例会**假装通过**（实际发出去的是 127.0.0.1）—— 那是测试在骗自己。
 * 弱判据的第一条就是判 Host，测不到它等于没测。
 */
async function hit(port, { method = 'GET', path = `${ROUTE}/status`, host } = {}) {
	const { request } = await import('node:http');
	return new Promise((resolve, reject) => {
		const headers = {};
		if (host) headers.host = host;
		const req = request(
			{ host: '127.0.0.1', port, path, method, headers },
			(res) => {
				let text = '';
				res.setEncoding('utf8');
				res.on('data', (c) => (text += c));
				res.on('end', () => resolve({ status: res.statusCode, text }));
			},
		);
		req.on('error', reject);
		req.end();
	});
}

// ── ① connection 缺失 ⇒ 503 ────────────────────────────────────────────────
console.log('=== ① connection 服务未就绪 ⇒ 必须 503（fail-closed）===');
let missingPort = 0;
{
	const { port, logs } = await startWith(undefined);
	missingPort = port;
	const r = await hit(port);
	check(r.status === 503, '取不到 connection 时返回 503', `实际 ${r.status}`);
	check(r.text === '', '拒绝时不返回任何 body（不给探测者反馈）', JSON.stringify(r.text));
	check(
		logs.some((m) => m.includes('fail-closed')),
		'打了一条 fail-closed 告警（运维可见）',
	);
	// ⚠️ 这一条才是审计真正在意的：同机另一个进程不能从这里拿到 hostname。
	const status200 = await hit(port);
	check(!status200.text.includes('hostname'), '没有泄漏 hostname', status200.text.slice(0, 80));
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
	check(!r.text.includes('hostname'), '没有泄漏 hostname');
}

// ── ③ 引擎判据：透传与放行 ─────────────────────────────────────────────────
console.log('=== ③ 引擎判 401/403 ⇒ 原样透传；判据通过 ⇒ 放行 ===');
for (const expected of [401, 403]) {
	const { port } = await startWith({ requestRejection: () => expected });
	const r = await hit(port);
	check(r.status === expected, `透传引擎的 ${expected}`, `实际 ${r.status}`);
	check(r.text === '', `拒绝时不返回 body`, JSON.stringify(r.text).slice(0, 60));
}
{
	const { port } = await startWith({ requestRejection: () => undefined });
	const r = await hit(port);
	check(r.status === 200, '判据通过时返回 200', `实际 ${r.status}`);
	check(
		r.text.includes('ok'),
		'确实是 handler 在应答（拿到了配对状态）',
		r.text.slice(0, 90),
	);
}

// ── ④ 弱判据仍在（非 loopback Host ⇒ 403）─────────────────────────────────
console.log('=== ④ 弱判据仍生效：非 loopback Host ⇒ 403 ===');
{
	const { port } = await startWith({ requestRejection: () => undefined });
	const r = await hit(port, { host: 'evil.example' });
	check(r.status === 403, 'Host: evil.example 被弱判据挡住', `实际 ${r.status}`);
	check(!r.text.includes('hostname'), '没有泄漏 hostname');
}

// ── ⑤ 逃生口：默认关，打开才降级 ───────────────────────────────────────────
console.log('=== ⑤ DSH_REMOTE_ALLOW_WEAK_GATE 逃生口 ===');
{
	const { port } = await startWith(undefined, { DSH_REMOTE_ALLOW_WEAK_GATE: '1' });
	const r = await hit(port);
	check(r.status === 200, '逃生口打开时退回弱判据（放行）', `实际 ${r.status}`);
	const { port: p2, logs } = await startWith(undefined, { DSH_REMOTE_ALLOW_WEAK_GATE: '1' });
	// ⚠️ 逃生口的状态要**每次都告警**（不折成「只报一次」）：
	// 只报一次的话，运维翻日志时会以为早修好了。
	await hit(p2);
	await hit(p2);
	check(
		logs.filter((m) => m.includes('DSH_REMOTE_ALLOW_WEAK_GATE')).length >= 2,
		'逃生口每次调用都告警（不是只报一次）',
		String(logs.filter((m) => m.includes('DSH_REMOTE_ALLOW_WEAK_GATE')).length),
	);
}
{
	// 逃生口**默认必须关**：显式设成别的值也不算打开。
	const { port } = await startWith(undefined, { DSH_REMOTE_ALLOW_WEAK_GATE: 'true' });
	const r = await hit(port);
	check(r.status === 503, '只有 === "1" 才算打开（默认 fail-closed）', `实际 ${r.status}`);
}
// 清理：别把逃生口带进后续断言。
delete process.env.DSH_REMOTE_ALLOW_WEAK_GATE;

// ── ⑥ 源码级：旧的 fail-open 门必须不存在 ──────────────────────────────────
console.log('=== ⑥ 源码级：旧的 fail-open 门（pairGateAllowed）必须彻底不存在 ===');
{
	const source = readFileSync(SRC, 'utf8');
	check(
		!source.includes('function pairGateAllowed('),
		'旧的 pairGateAllowed（返回布尔、缺服务即放行）已删除',
	);
	check(
		source.includes('function pairGateRejection('),
		'存在新的 pairGateRejection（返回状态码）',
	);
	// 关键：缺 connection 的分支里**不能再有 `return true`**。
	const body = source.slice(
		source.indexOf('function pairGateRejection('),
		source.indexOf('let pairGateDegradedWarned'),
	);
	check(
		!/return true;/.test(body),
		'缺服务/抛错分支里没有任何 `return true`（fail-open 的特征）',
	);
	check(body.includes('return 503;'), '缺服务/抛错分支返回 503');
	check(
		body.includes("DSH_REMOTE_ALLOW_WEAK_GATE === '1'"),
		'逃生口用严格相等判 `"1"`（不是真值判断）',
	);
	// 门必须在解析 body 之前。
	const routeBody = source.slice(source.indexOf('function handlePairRoute('));
	const gateAt = routeBody.indexOf('pairGateRejection(ctx, req)');
	const parseAt = routeBody.indexOf('JSON.parse');
	check(
		gateAt >= 0 && parseAt >= 0 && gateAt < parseAt,
		'门在解析请求体之前',
		`gate@${gateAt} parse@${parseAt}`,
	);
	check(missingPort > 0, '（占位）① 的分支确实跑过');
}

console.log('');
console.log(failed === 0 ? '全部通过 ✅' : `失败 ${failed} 项 ❌`);
// ⚠️ 不要 `process.exit()`：监听已 unref，进程会自然退出。
process.exitCode = failed === 0 ? 0 : 1;
