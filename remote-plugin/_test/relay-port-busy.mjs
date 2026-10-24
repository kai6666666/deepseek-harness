/**
 * 中继端口被占用时**不能崩掉整个引擎**。
 *
 * ## 背景（这是一个实测复现过的真缺陷）
 *
 * `startRelay()` 原来只有一句 `server.listen(RELAY_PORT, '127.0.0.1')`，
 * **没有 `'error'` 处理器**。`listen()` 失败是异步发 `'error'` 事件的，
 * `apply()` 里那个 try/catch 兜不住，于是 Node 直接抛未捕获异常：
 *
 *   Error: listen EADDRINUSE: address already in use 127.0.0.1:17890
 *   Emitted 'error' event on Server instance at: ...
 *
 * 后果不只是「远程功能不可用」，而是**整个 DSH 进程退出**。客户机上有
 * 残留引擎进程是常见现象（本项目 AGENTS.md 记着「3080 已被占用（多半是
 * 上一次残留的引擎进程）」），客户完全看不出是本插件干的。
 *
 * ## 怎么验
 *
 * 思路：**先占住插件要用的那个端口**，再走真实 `apply()`，断言进程存活、
 * 有可读的日志、且配对路由照常注册（降级而非整体失效）。
 *
 * ⚠️ 本机可能真有 DSH 在跑并占着 17890（开发机常态）。所以占位分两种情况：
 *   - 端口已被别人占 → 直接用这个真实占用，**不再重复 listen**（否则崩的是
 *     测试脚本自己，且会动到用户的进程）；
 *   - 端口空闲 → 自己占一个临时端口，并把插件指向它。
 *     插件的 `RELAY_PORT` 是模块级常量改不了，所以这种情形下只能跳过
 *     「真实端口冲突」这一步，退化为验证 `error` 处理器确实挂上了。
 *
 * 用法：node relay-port-busy.mjs
 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let failed = 0;
const check = (ok, label, detail = '') => {
	console.log(`${ok ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`);
	if (!ok) failed += 1;
};

const indexUrl = pathToFileURL(
	join(import.meta.dirname, '..', 'dsh-remote-desktop', 'lib', 'index.js'),
).href;

// ---- 0. 先确认修复真的在源码里（否则后面全是假绿） ----
const source = readFileSync(new URL(indexUrl), 'utf8');
check(/server\.on\('error'/.test(source), '源码里确实挂了 server 的 error 处理器');
check(
	/server\.on\('error'[\s\S]{0,400}?server\.listen\(/.test(source),
	'error 处理器挂在 listen 之前（挂晚了会漏掉这次的 EADDRINUSE）',
);

const stateDir = mkdtempSync(join(tmpdir(), 'dsh-busy-'));
process.env.DSH_HOME = join(stateDir, 'home');

const mod = await import(indexUrl);

// ---- 1. 看插件要用的端口现在是不是被占着 ----
/** 试着独占一个端口；成功即空闲（并立刻释放），失败即被占用。 */
async function isPortBusy(port) {
	const probe = createServer();
	try {
		await new Promise((resolve, reject) => {
			probe.once('error', reject);
			probe.listen(port, '127.0.0.1', resolve);
		});
		return false;
	} catch {
		return true;
	} finally {
		try {
			probe.close();
		} catch {
			/* 没起来 */
		}
	}
}

const busy = await isPortBusy(mod.RELAY_PORT);
console.log(
	`插件端口 ${mod.RELAY_PORT} 当前${busy ? '已被占用（本机确有另一个 DSH 在跑）' : '空闲'} —— ` +
		`${busy ? '直接利用这个真实冲突做验证' : '改为自行占位后再验证'}\n`,
);

let blocker;
if (!busy) {
	// 端口空闲：自己占住它，制造冲突。占位失败就是测试环境有问题，直接报出来。
	blocker = createServer((_req, res) => res.end('occupied'));
	await new Promise((resolve, reject) => {
		blocker.once('error', reject);
		blocker.listen(mod.RELAY_PORT, '127.0.0.1', resolve);
	});
	console.log(`已自行占住 127.0.0.1:${mod.RELAY_PORT}\n`);
}

// ---- 2. 走真实 apply() ----
const logs = [];
const registered = [];
const ctx = {
	effect: (fn) => {
		const dispose = fn();
		return typeof dispose === 'function' ? dispose : () => {};
	},
	on: () => {},
	logger: {
		info: (m) => logs.push(['info', String(m)]),
		warn: (m) => logs.push(['warn', String(m)]),
		error: (m) => logs.push(['error', String(m)]),
	},
	webServer: {
		register: (route) => {
			registered.push(route);
			return { dispose() {} };
		},
	},
	sessions: { get: () => undefined },
};

let applyError;
try {
	mod.apply(ctx, { autoTunnel: false });
} catch (error) {
	applyError = error;
}

// ⚠️ 给异步的 'error' 事件留时间。**这一步就是断言本身**：
// 若没有 error 处理器，进程会在到达下一行之前就被未捕获异常杀掉。
await new Promise((r) => setTimeout(r, 1500));

check(true, '进程存活（没有因 EADDRINUSE 崩溃）');
check(applyError === undefined, 'apply() 没有同步抛错', applyError ? String(applyError.message) : '');

const warnLine = logs.find(([level, m]) => level === 'warn' && /中继无法监听/.test(m));
check(warnLine !== undefined, '打出了说明原因的 warn 日志');
if (warnLine) console.log(`   → ${warnLine[1]}`);
check(
	warnLine !== undefined && warnLine[1].includes(String(mod.RELAY_PORT)),
	'日志里带上了具体端口号',
);
check(warnLine !== undefined && /另一个 DSH/.test(warnLine[1]), '日志里提示了「多半是另一个 DSH 实例」');
check(
	registered.some((r) => r.path === mod.PAIR_ROUTE),
	'配对路由仍然注册了（降级而非整体失效）',
	`共注册 ${registered.length} 条路由`,
);
console.log(`\n本次日志共 ${logs.length} 条，其中 warn ${logs.filter(([l]) => l === 'warn').length} 条`);

// ---- 3. 顺带记一个实测事实：Node 24 的 close() 未监听时**不抛也不 reject** ----
//（一度以为它会抛 ERR_SERVER_NOT_RUNNING 并据此加了 try/catch，实测是错的：
//  close() 静默返回一个无 then 的对象。所以那里不需要 try/catch，已撤掉。）
{
	const { createServer: mk } = await import('node:http');
	let threw = false;
	try {
		mk().close();
	} catch {
		threw = true;
	}
	console.log(`（记录）未监听的 close() 是否抛错：${threw}（实测 false ⇒ 不需要 try/catch）`);
}

if (blocker !== undefined) blocker.close();
rmSync(stateDir, { recursive: true, force: true });
console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
