/**
 * **解绑闭环回归测试** —— 电脑解绑后，手机必须能重新配对。
 *
 * ## 为什么单独立一条
 *
 * 原缺陷（用户实测报告）：
 *
 * > 电脑解绑之后，手机它就永远都只能 502 了，不能重新匹配
 *
 * 根因是**两端的回退不对称**：
 * - 电脑端有「解绑」按钮（`/unpair`），会换令牌、停隧道；
 * - 手机端在「已配对」状态下**不渲染配对码输入框**（`client.js` 里
 *   `pairState.paired === true` 的两处都返回 `null`），而 `pairStatus` 只看
 *   本地 `mobile.json` 里有没有令牌 —— 那个文件里还留着旧令牌，于是永远报
 *   「已配对」，输入框永远不出现。用户卡在 502，界面上无路可走。
 *
 * 本测试打在**真源码**上，验四件事：
 * ① `unpair` 桥方法真的把 `mobile.json` 清空（`token` 变空串）；
 * ② 清空后 `pairStatus` 报 `paired: false` —— 前端据此才会渲染输入框；
 * ③ 旧电脑的 SSE 跟随连接真的被断掉（`follows` 清空，不再拿旧令牌打旧域名）；
 * ④ **重启后仍然是未配对**（读盘，不是只改了内存里的 `config`）——
 *    这一条最容易漏：只改内存的话界面当场好了，一重启旧令牌又回来。
 *
 * ## 做法
 *
 * `apply()` 起来后直接向它注册的 webServer 路由发真 HTTP 请求，走的
 * 是前端桥完全相同的路径。`DSH_HOME` 指到临时目录，绝不碰真机状态。
 *
 * 用法：node unpair-recover.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const SRC = join(import.meta.dirname, '..', 'dsh-remote-mobile', 'lib', 'index.js');

let failed = 0;
const check = (ok, label, detail = '') => {
	console.log(`${ok ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`);
	if (!ok) failed += 1;
};

/** 找一个空闲端口（`webServer.register` 的 mock 会真监听它）。 */
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

const PORT = await freePort();
const home = mkdtempSync(join(tmpdir(), 'dsh-unpair-'));
const stateDir = join(home, 'dsh-remote');
mkdirSync(stateDir, { recursive: true });

// 造一台「已配对」的手机：旧令牌 + 两个远程会话。
const OLD_TOKEN = randomBytes(32).toString('hex');
const OLD_ENDPOINT = 'https://dsh-deadbeef.jiulingssh.xyz';
writeFileSync(
	join(stateDir, 'mobile.json'),
	JSON.stringify({ endpoint: OLD_ENDPOINT, token: OLD_TOKEN }, null, 2),
	{ mode: 0o600 },
);
writeFileSync(
	join(stateDir, 'sessions.json'),
	JSON.stringify({ sessions: ['session-old-1', 'session-old-2'] }, null, 2),
	{ mode: 0o600 },
);

// ⚠️ `CONFIG_PATH` / `SESSIONS_PATH` 都是**模块顶层**算出来的，所以 `DSH_HOME`
// 必须在第一次 import 之前设好，否则读到的还是真机的 `~/.dsh`。
process.env.DSH_HOME = home;

const mod = await import(pathToFileURL(SRC).href);

/** 记录手机往电脑发起的每一条出网请求（用来确认解绑后不再打旧域名）。 */
const outbound = [];
/** 假电脑：任何请求都返回一个永久挂起的 SSE，用来模拟「连接一直开着」。 */
const fakeDesktop = createServer((req, res) => {
	outbound.push({ url: req.url, token: req.headers['x-dsh-remote-token'] ?? null });
	if (String(req.url).startsWith('/api/dsh-remote/stream')) {
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		res.write(': connected\n\n');
		return; // 故意不结束 —— 长连接
	}
	res.writeHead(200, { 'content-type': 'application/json' });
	res.end(JSON.stringify({ ok: true, result: {} }));
});
await new Promise((r) => fakeDesktop.listen(0, '127.0.0.1', r));
const DESK_PORT = fakeDesktop.address().port;

// 把 mobile.json 的 endpoint 改到假电脑上（保留同一个旧令牌）。
writeFileSync(
	join(stateDir, 'mobile.json'),
	JSON.stringify({ endpoint: `http://127.0.0.1:${DESK_PORT}`, token: OLD_TOKEN }, null, 2),
	{ mode: 0o600 },
);

// ---- 组装 ctx：只 mock 官方服务，插件逻辑一行不改 ----
const logs = [];
const routes = new Map();
const disposers = [];
let restored = 0;

const ctx = {
	effect: (fn) => {
		try {
			const d = fn();
			if (typeof d === 'function') disposers.push(d);
		} catch (e) {
			logs.push(['error', String(e?.message ?? e)]);
		}
		return () => {};
	},
	on: () => {},
	// ⚠️ 桥路由的前置准入用引擎的 `connection.requestRejection`（见
	// `bridgeRejection`），取不到就是 **503 fail-closed** —— 所以桩必须给一个。
	// 这个桩「全部放行」，代表引擎判据已就绪；测试要验的是插件的恢复逻辑。
	get: (name) =>
		name === 'connection' ? { requestRejection: () => undefined } : undefined,
	inject: () => {},
	logger: {
		info: (m) => logs.push(['info', String(m)]),
		warn: (m) => logs.push(['warn', String(m)]),
		error: (m) => logs.push(['error', String(m)]),
	},
	sessions: { get: () => undefined },
	sessionController: {
		prompt: async () => ({ accepted: true }),
		cancel: async () => ({ accepted: true }),
	},
	// 真起 HTTP，走前端桥完全相同的路径。
	webServer: {
		register: (route) => {
			routes.set(route.path, route);
			const server = createServer((req, res) => route.handler(req, res));
			server.on('error', () => {});
			server.listen(PORT, '127.0.0.1');
			return { dispose: () => server.close() };
		},
	},
	workspaceRegistry: undefined,
};

mod.apply(ctx);

// 等路由就绪
for (let i = 0; i < 40; i++) {
	await new Promise((r) => setTimeout(r, 50));
	if (routes.size >= 2) break;
}
check(routes.has('/api/dsh-remote/rpc'), '桥路由已注册');

/** 走前端桥的同一条路径。 */
async function bridge(method, params = {}) {
	const res = await fetch(`http://127.0.0.1:${PORT}/api/dsh-remote/rpc`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ method, params }),
		signal: AbortSignal.timeout(10000),
	});
	const payload = await res.json();
	if (payload.ok !== true) throw new Error(payload.error ?? 'bridge 失败');
	return payload.result;
}

console.log('\n=== ① 解绑前：已配对，且旧连接真的开着 ===');
const before = await bridge('pairStatus');
check(before.paired === true, '解绑前 pairStatus 报已配对', JSON.stringify(before));
check(before.endpoint === `http://127.0.0.1:${DESK_PORT}`, 'endpoint 指向旧电脑');

// 等 `apply()` 里那段「启动恢复」把两个远程会话的 SSE 拉起来
await new Promise((r) => setTimeout(r, 1200));
const streamCalls = outbound.filter((x) => String(x.url).startsWith('/api/dsh-remote/stream'));
check(streamCalls.length >= 1, `旧电脑上已有 ${streamCalls.length} 条跟随连接（长连接挂着）`);
check(
	streamCalls.every((x) => x.token === OLD_TOKEN || String(x.url).includes(OLD_TOKEN)),
	'跟随连接用的是旧令牌',
);

console.log('\n=== ② 解绑：清凭据 + 断连接 ===');
const unpair = await bridge('unpair');
check(unpair.paired === false, 'unpair 回执报未配对', JSON.stringify(unpair));
check(unpair.endpoint === mod.DEFAULT_ENDPOINT, 'endpoint 回到占位地址（不再是旧电脑）', unpair.endpoint);

// 磁盘上的凭据必须真的被清掉 —— 只看内存的话重启就白改了
const onDisk = JSON.parse(readFileSync(join(stateDir, 'mobile.json'), 'utf8'));
check(onDisk.token === '', 'mobile.json 里的令牌已清空', `token=${JSON.stringify(onDisk.token)}`);
check(onDisk.endpoint !== `http://127.0.0.1:${DESK_PORT}`, 'mobile.json 里的 endpoint 已不是旧电脑');

const sessionsOnDisk = JSON.parse(readFileSync(join(stateDir, 'sessions.json'), 'utf8'));
check(
	Array.isArray(sessionsOnDisk.sessions) && sessionsOnDisk.sessions.length === 0,
	'远程会话清单已清空（这些会话退回普通本地会话）',
	`${sessionsOnDisk.sessions.length} 条`,
);

// 解绑后不该再有新的出网请求打旧电脑
const outboundAtUnpair = outbound.length;
await new Promise((r) => setTimeout(r, 1500));
const after = outbound.slice(outboundAtUnpair);
check(
	after.filter((x) => String(x.url).startsWith('/api/dsh-remote/stream')).length === 0,
	'解绑后不再发起新的跟随连接（旧连接已被 abort）',
	`新增 ${after.length} 条请求`,
);

console.log('\n=== ③ 解绑后：前端能拿到「未配对」，输入框才会出现 ===');
const afterStatus = await bridge('pairStatus');
check(afterStatus.paired === false, 'pairStatus 报未配对 ← 前端据此渲染配对码输入框', JSON.stringify(afterStatus));

console.log('\n=== ④ 重新配对：能接受新凭据（回到可用状态）===');
// 模拟「用户拿到电脑上新的 6 位码」：这里直接验状态机能从空令牌切回有令牌。
// 真配对要走公网 `claimPairing`，已由 pair-e2e.mjs / host-route.mjs 覆盖，
// 这里只验**解绑没有把状态机锁死**。
const saved = mod.loadConfig();
check(saved.token === '', '解绑后 loadConfig 读到空令牌（可再次配对）');

console.log('\n=== ⑤ 重启后仍然是未配对 ===');
// 新进程重新 import，读同一个 DSH_HOME —— 这是「只改内存」类 bug 的照妖镜。
const probe = `
	process.env.DSH_HOME = ${JSON.stringify(home)};
	const mod = await import(${JSON.stringify(pathToFileURL(SRC).href)});
	const cfg = mod.loadConfig();
	process.stdout.write(JSON.stringify({ token: cfg.token, endpoint: cfg.endpoint }));
`;
const { execFileSync } = await import('node:child_process');
const raw = execFileSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' });
const restarted = JSON.parse(raw);
check(restarted.token === '', '重启后仍是未配对（凭据真的落盘清了）', `token=${JSON.stringify(restarted.token)}`);
check(restarted.endpoint === mod.DEFAULT_ENDPOINT, '重启后 endpoint 是占位地址', restarted.endpoint);

// ---- 收尾 ----
for (const d of disposers) {
	try {
		d();
	} catch {
		/* 已关闭 */
	}
}
await new Promise((r) => setTimeout(r, 200));
fakeDesktop.close();
rmSync(home, { recursive: true, force: true });
console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
