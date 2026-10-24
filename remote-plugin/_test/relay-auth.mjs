/**
 * **中继必须拒绝那个已泄露的旧令牌** —— 安全回归测试。
 *
 * ## 为什么单独验这一条
 *
 * `no-shared-credentials.mjs` 验的是「包里不再有凭据、未配对时令牌随机」。
 * 但还有一层必须独立确认：**新代码起的中继，拿旧公开令牌打过来必须 401**。
 *
 * 因为那个常量已经发布到 npm、无法收回，它是**已泄露**的。任何还留着它的
 * 老机器（`token.txt` 没升级）或任何读过旧版包的人，都可能拿它来打新版本。
 * 令牌既然已经轮换成随机的，旧值就必须被拒 —— 这是修复生效的直接证据。
 *
 * ## 怎么做到「在空闲端口起真 relay」
 *
 * `RELAY_PORT` 是模块级常量（17890），而那台机器上**真的有另一个 DSH 占着它**，
 * 所以不能直接 `apply()` —— 会走降级分支，中继根本没监听，测不了鉴权。
 *
 * 这里用「源码文本替换 + 落到临时文件」的办法：把端口换成空闲端口、把
 * `./pair.js` 的相对导入换成绝对 `file://` URL，然后 import 那份**真源码**。
 * 换的是端口号，**鉴权逻辑一字未改**，所以断言仍然打在真代码上。
 *
 * 用法：node relay-auth.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';

const LEGACY = 'f6721b0cf82414709df172056193c78a6c374e9a920e51145dd7883923cf16e7';
const SRC = join(import.meta.dirname, '..', 'dsh-remote-desktop', 'lib', 'index.js');
const PAIR_SRC = join(import.meta.dirname, '..', 'dsh-remote-desktop', 'lib', 'pair.js');

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

const PORT = await freePort();
const stateHome = mkdtempSync(join(tmpdir(), 'dsh-relayauth-'));
const workDir = mkdtempSync(join(tmpdir(), 'dsh-relayauth-src-'));

// 造一个「已配对」的机器：accessToken 是随机的（模拟服务器下发的）
//
// ⚠️ `pair.json` 必须落在 `STATE_DIR` = `$DSH_HOME/dsh-remote/` 下（这是
// `createPairing` 的约定），不是随便一个临时目录 —— 放错了 `pairing.read()`
// 读不到，中继就会用随机生成的令牌，于是「正确令牌」那条断言 401，
// 连带「旧令牌 401」也变成**假绿**（它拒绝一切，不是因为认出了旧令牌）。
const FRESH = randomBytes(32).toString('hex');
const stateDir = join(stateHome, 'dsh-remote');
mkdirSync(stateDir, { recursive: true });
writeFileSync(
	join(stateDir, 'pair.json'),
	JSON.stringify({
		activationCode: 'TESTTEST',
		subdomain: 'dsh-testtest',
		hostname: 'dsh-testtest.example',
		tunnelToken: 'y'.repeat(240),
		accessToken: FRESH,
		pairedAt: Date.now(),
		reused: false,
	}),
	{ mode: 0o600 },
);

// 源码替换：只换端口与相对导入，鉴权逻辑原样
let src = readFileSync(SRC, 'utf8');
const before = src;
src = src.replace(/const RELAY_PORT = \d+;/, `const RELAY_PORT = ${PORT};`);
src = src.replace(/from '\.\/pair\.js'/, `from ${JSON.stringify(pathToFileURL(PAIR_SRC).href)}`);
check(src !== before && src.includes(`RELAY_PORT = ${PORT}`), '源码替换成功（端口换到空闲端口）', `PORT=${PORT}`);
check(!src.includes("from './pair.js'"), '相对导入已换成绝对 file:// URL');

const tmpModule = join(workDir, 'index-tmp.js');
writeFileSync(tmpModule, src);

process.env.DSH_HOME = stateHome;
process.env.DSH_REMOTE_CLOUDFLARED = join(workDir, 'nonexistent.exe');

const mod = await import(pathToFileURL(tmpModule).href);

const logs = [];
/** `apply()` 里 `ctx.effect(fn)` 的 `fn()` 返回 dispose —— **必须收好并在末尾调用**，
 *  否则进程退出时中继的 server 还开着，libuv 会以
 *  `!(handle->flags & UV_HANDLE_CLOSING)` 断言崩掉（退出码 -1073740791），
 *  真实失败信号就被这个崩溃盖住了。 */
const disposers = [];
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
	logger: {
		info: (m) => logs.push(['info', String(m)]),
		warn: (m) => logs.push(['warn', String(m)]),
		error: (m) => logs.push(['error', String(m)]),
	},
	webServer: { register: () => ({ dispose() {} }) },
	sessions: { get: () => undefined },
};
mod.apply(ctx, { autoTunnel: false });

// 等中继真的监听上
let up = false;
for (let i = 0; i < 40; i++) {
	await new Promise((r) => setTimeout(r, 100));
	try {
		await fetch(`http://127.0.0.1:${PORT}/api/dsh-remote/rpc`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
			signal: AbortSignal.timeout(1000),
		});
		up = true;
		break;
	} catch {
		/* 还没起来 */
	}
}
check(up, `中继已在 127.0.0.1:${PORT} 监听`);
check(!logs.some(([, m]) => /中继无法监听/.test(m)), '没有端口冲突（用的是空闲端口）');

/** 用给定令牌打一条 RPC。 */
async function call(token) {
	const headers = { 'content-type': 'application/json' };
	if (token !== undefined) headers['x-dsh-remote-token'] = token;
	const res = await fetch(`http://127.0.0.1:${PORT}/api/dsh-remote/rpc`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ id: 't', method: 'ping', params: {} }),
		signal: AbortSignal.timeout(10000),
	});
	let payload;
	try {
		payload = await res.json();
	} catch {
		payload = undefined;
	}
	return { status: res.status, payload };
}

console.log('\n=== 鉴权断言 ===');
const withFresh = await call(FRESH);
check(withFresh.status === 200, '服务器下发的**新令牌** → 200（能正常用）', `HTTP ${withFresh.status}`);

const withLegacy = await call(LEGACY);
check(withLegacy.status === 401, '已泄露的**旧公开令牌** → 401（被拒绝）← 这是修复生效的直接证据', `HTTP ${withLegacy.status}`);
check(withLegacy.payload?.error === 'unauthorized', '返回 unauthorized', JSON.stringify(withLegacy.payload));

const noToken = await call(undefined);
check(noToken.status === 401, '不带令牌 → 401', `HTTP ${noToken.status}`);

const wrong = await call('a'.repeat(64));
check(wrong.status === 401, '随便一个错令牌 → 401', `HTTP ${wrong.status}`);

// ---------------------------------------------------------------- 端到端围栏
//
// ⚠️ **这一节走的是真链路**：真 HTTP server → 真 `tokenMatches` → 真 `handleRpc`
// → 真 `resolveWorkspacePath`。`file-tree.mjs` 测的是 `handleRpc` 那一层，
// 这里补上「经过中继鉴权之后」的那一段，证明围栏在**线上路径**上真的生效。
//
// 为什么必须单独测：围栏若只加在 `handleRpc` 里、而中继另有一条路径直通
// 文件系统，单测就看不出来。走一次真 HTTP 才能证明**没有旁路**。
console.log('\n=== 端到端：越界路径必须被中继拒绝 ===');

/** 打一条真 RPC（走 HTTP）。 */
async function rpc(method, params) {
	const res = await fetch(`http://127.0.0.1:${PORT}/api/dsh-remote/rpc`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-dsh-remote-token': FRESH },
		body: JSON.stringify({ id: 't', method, params }),
		signal: AbortSignal.timeout(15000),
	});
	let payload;
	try {
		payload = await res.json();
	} catch {
		payload = undefined;
	}
	return { status: res.status, payload };
}

// 造一个真工作区，让「区内读」与「越界读」有明确对照。
const workRoot = mkdtempSync(join(tmpdir(), 'dsh-relayauth-ws-'));
writeFileSync(join(workRoot, 'inside.txt'), 'INSIDE-OK\n');
const outsideFile = join(workRoot, '..', `outside-${Date.now()}.txt`);
writeFileSync(outsideFile, 'OUTSIDE-LEAK\n');

const WS_SESSION = 'session-relay-fence';
ctx.sessions = { get: (id) => (id === WS_SESSION ? { header: { cwd: workRoot } } : undefined) };
// ⚠️⚠️ **`sessionController` 必须给**：`handleRpc` 第一行就是
//   `if (controller === undefined) throw new Error('sessionController 不可用')`
// 不给的话**每条 RPC 都在进门第一步就炸**，于是下面那些「越界被拒」的断言
// 会**全部假绿** —— 它们拒的是「没有 controller」，不是「路径越界」。
// 这个坑实测踩过一次，别删这个字段。
//
// `create` 也要有：`createSession` 会走到它。给了之后，若围栏**没**拦住，
// 这里会真的把会话建出来 —— 断言才有意义（否则又是「因为别的错误而失败」）。
ctx.sessionController = {
	create: async ({ sessionId, cwd }) => ({ sessionId, cwd, agentPreset: null }),
};
ctx.get = (name) =>
	name === 'workspaceFiles'
		? {
				// ⚠️ **故意不实现 confine()** —— 与真官方一致（真官方不拦，
				// 见 file-tree.mjs ⑥ 的长注释）。这样测的才是本插件那道围栏。
				async read(scope, path) {
					return { absolutePath: join(scope.workspaceRoot, path), text: readFileSync(join(scope.workspaceRoot, path), 'utf8') };
				},
				async stat(scope, path) {
					const st = statSync(join(scope.workspaceRoot, path));
					return { absolutePath: join(scope.workspaceRoot, path), bytes: st.size };
				},
				async list(scope, path) {
					const abs = path === scope.workspaceRoot ? path : join(scope.workspaceRoot, path);
					return { path: relative(scope.workspaceRoot, abs) || '', entries: readdirSync(abs).map((n) => ({ name: n, type: 'file' })), truncated: false };
				},
				async readBytes(scope, path) {
					const data = readFileSync(join(scope.workspaceRoot, path));
					return { absolutePath: join(scope.workspaceRoot, path), data };
				},
			}
		: undefined;

const inside = await rpc('fileRead', { sessionId: WS_SESSION, path: 'inside.txt' });
check(inside.payload?.result?.text?.includes('INSIDE-OK') === true, '区内文件正常读到（围栏不误伤）', JSON.stringify(inside.payload).slice(0, 120));

const escapes = [
	['fileStat', { path: 'C:\\Windows\\win.ini' }, '绝对路径（Windows）'],
	['fileRead', { path: '/etc/passwd' }, '绝对路径（posix）'],
	['fileStat', { path: '..' }, '上一级'],
	['fileRead', { path: '..\\..\\..\\Windows\\win.ini' }, '反斜杠穿越'],
	['fileList', { path: '../../..' }, '正斜杠穿越'],
	['fileReadBytes', { path: `..\\${outsideFile.split(/[\\/]/).pop()}` }, '读到工作区外的真实文件'],
];
for (const [method, extra, label] of escapes) {
	const res = await rpc(method, { sessionId: WS_SESSION, ...extra });
	const text = JSON.stringify(res.payload ?? '');
	// ⚠️ **必须验「为什么被拒」**，不能只看 `ok:false` —— 否则任何一条别的
	// 早期错误（缺 controller、会话查不到、参数拼错）都会让断言假绿。
	// 实测就踩过：断言全绿，而实际拒绝原因全是 `sessionController 不可用`。
	const isFence = text.includes('相对路径') || text.includes('越出');
	const isUnrelated = text.includes('sessionController 不可用') || text.includes('工作目录');
	check(
		isFence && !isUnrelated,
		`${method} 因【越界】被拒：${label}`,
		isUnrelated ? `⚠️ 假绿！实际拒绝原因与围栏无关：${text.slice(0, 140)}` : text.slice(0, 140),
	);
}

// 决定性一条：工作区外那个文件**确实存在**，证明上一条不是因为文件缺失。
check(statSync(outsideFile).size === 13, '工作区外的诱饵文件真实存在（证明拒绝不是「文件不存在」）');

// ---------------------------------------------------------------- 工作区不能是 DSH_HOME
//
// ⚠️ **这是绕过围栏的那条链**（公网实测）：
//   ① createSession { cwd: 'C:\Users\你的用户名' }            → ok
//   ② fileStat      { path: '.dsh\dsh-remote\pair.json' }  → ok，504 字节
// 第 ② 步是**相对路径**，围栏判「在不在工作区内」——它**确实在**，所以拦不住。
// 围栏以工作区为界，而工作区能自由指定，两者叠加围栏就等于没有。
console.log('\n=== 工作区不能落在 $DSH_HOME（否则围栏可被绕过）===');

/** 打一条 createSession。 */
async function createWith(cwd) {
	const res = await fetch(`http://127.0.0.1:${PORT}/api/dsh-remote/rpc`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-dsh-remote-token': FRESH },
		body: JSON.stringify({ id: 't', method: 'createSession', params: { sessionId: `s-${Math.random().toString(36).slice(2)}`, cwd } }),
		signal: AbortSignal.timeout(15000),
	});
	let payload;
	try {
		payload = await res.json();
	} catch {
		payload = undefined;
	}
	return { status: res.status, payload };
}

// `stateHome` 就是这一轮的 $DSH_HOME（见文件开头 `process.env.DSH_HOME = stateHome`）。
const deniedHome = await createWith(stateHome);
check(
	deniedHome.payload?.ok === false && String(deniedHome.payload?.error ?? '').includes('配置目录'),
	'拒绝把 $DSH_HOME 当工作区',
	JSON.stringify(deniedHome.payload).slice(0, 160),
);
const deniedSub = await createWith(join(stateHome, 'dsh-remote'));
check(
	deniedSub.payload?.ok === false && String(deniedSub.payload?.error ?? '').includes('配置目录'),
	'拒绝把 $DSH_HOME/dsh-remote 当工作区',
	JSON.stringify(deniedSub.payload).slice(0, 160),
);
// ⚠️ 反向断言：普通目录必须照常能建 —— 这条是「选电脑上的文件夹」这个**功能**，
// 不能为了安全把它砍掉。上面两条若把整条路径都拒了，这条会红。
const allowed = await createWith(workRoot);
check(
	allowed.payload?.ok !== false,
	'普通目录照常能当工作区（功能没被砍掉）',
	JSON.stringify(allowed.payload).slice(0, 160),
);

// 令牌仍然要能正常干活 —— 围栏不能把整个中继搞死。
const stillAlive = await call(FRESH);
check(stillAlive.status === 200, '加了围栏之后，正常令牌仍能调用 RPC', `HTTP ${stillAlive.status}`);

rmSync(workRoot, { recursive: true, force: true });
try {
	rmSync(outsideFile, { force: true });
} catch {
	/* 已删 */
}

// 令牌来源也要确认：用的是 pair.json 的 accessToken，不是别的。
//
// ⚠️ 判据是**指纹**而不是明文：外部审计 M2 之后启动日志不再打印令牌本身，
// 只打 `访问令牌: <已隐藏，指纹 xxxxxxxx>`。所以这里自己算一遍同样的指纹 ——
// 这样既验了「令牌来自 pair.json」，又顺带验了「明文确实没被打进日志」。
const freshFp = createHash('sha256').update(FRESH, 'utf8').digest('hex').slice(0, 8);
check(
	logs.some(([, m]) => m.includes(`访问令牌: <已隐藏，指纹 ${freshFp}>`)),
	'中继用的令牌来自 pair.json 的 accessToken（按指纹核对）',
);
check(!logs.some(([, m]) => m.includes(FRESH)), '启动日志里没有明文令牌（审计 M2）');
check(!logs.some(([, m]) => /检测到旧版内置的公开令牌/.test(m)), '没有误报「旧令牌」（文件里本来就是新值）');

// 收尾：先关中继（否则进程退出时 libuv 断言崩），再删临时目录
for (const d of disposers) {
	try {
		d();
	} catch {
		/* 已关闭 */
	}
}
await new Promise((r) => setTimeout(r, 200));
rmSync(stateHome, { recursive: true, force: true });
rmSync(workDir, { recursive: true, force: true });
console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
