/**
 * 隧道**热切**验证：配对后不重启 DSH，旧隧道进程真的被换掉了吗？
 *
 * ## 为什么需要这个脚本
 *
 * `lib/index.js` 的 `restartTunnel()` 注释写着：
 *
 *   > 换隧道**必须换进程**：`cloudflared` 的凭据是启动参数，运行中改不了。
 *   > 旧的还挂着上一次（或内置）的凭据，不杀的话两条隧道同时连着 Cloudflare，
 *   > 域名解析到哪一条是随机的 —— 表现是「一会儿通一会儿 502」。
 *
 * 但这条路径此前**从未真实执行过**：`pair-e2e.mjs` 只验了**中继**的令牌热切
 *（`setToken`），没碰隧道进程；其它脚本都用临时 stateDir 直接调 `createPairing`，
 * 绕开了 `apply()`。而「配完不用重启 DSH」正是面向大众分发的关键承诺。
 *
 * ## 怎么验（要点：两条**有效** token）
 *
 * 一开始用**假 token** 试过，结论是假的 —— 假 token 会让 cloudflared 立刻
 * 自行退出（`隧道退出，code=4294967295`），于是「旧进程」压根不存在，
 * 「旧的被杀掉」这条断言就成了无意义的真。所以必须：
 *
 *   1. 用**有效 token A** 起隧道（`apply({tunnelToken})`），等它连上边缘；
 *   2. 断言 A 的进程确实活着（否则后面全是假绿）；
 *   3. 打真实 `/register` 路由（用另一个未使用的激活码 → 服务器发新隧道 B）；
 *   4. 断言 A 的 PID 消失、B 的 PID 出现、且新增总数仍为 1（不是并存）。
 *
 * ⚠️ 只碰自己起的子进程，**不动用户机器上已在跑的那个 cloudflared**。
 * ⚠️ 走真实网络（`/pair/register`），需要 `HTTPS_PROXY`。
 *
 * 用法：node tunnel-swap.mjs <起隧道用的隧道token> <用于 /register 的激活码>
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

const STARTUP_TOKEN = process.argv[2];
const CODE = process.argv[3];
if (!STARTUP_TOKEN || !CODE) {
	console.error('用法: node tunnel-swap.mjs <起隧道用的隧道token> <用于 /register 的激活码>');
	process.exit(2);
}

const CF = process.env.DSH_REMOTE_CLOUDFLARED ?? join(process.env.LOCALAPPDATA ?? '', 'cloudflared', 'cloudflared.exe');
if (!existsSync(CF)) {
	console.error(`找不到 cloudflared: ${CF}`);
	process.exit(2);
}

/** 列出 cloudflared 当前的所有 PID。 */
function pidsOf(imageName) {
	try {
		const out = execSync(
			`powershell -NoProfile -Command "Get-Process ${imageName} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"`,
			{ encoding: 'utf8' },
		);
		return out.split(/\s+/).filter((s) => /^\d+$/.test(s)).map(Number);
	} catch {
		return [];
	}
}

const killPid = (pid) => {
	try {
		execSync(`powershell -NoProfile -Command "Stop-Process -Id ${pid} -Force"`);
	} catch {
		/* 已退出 */
	}
};

let failed = 0;
const check = (ok, label, detail = '') => {
	console.log(`${ok ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`);
	if (!ok) failed += 1;
};

const stateDir = mkdtempSync(join(tmpdir(), 'dsh-swap-'));
process.env.DSH_REMOTE_CLOUDFLARED = CF;
process.env.DSH_HOME = join(stateDir, 'home');

const before = new Set(pidsOf('cloudflared'));
console.log(`基线：本机现有 cloudflared PID = ${[...before].join(', ') || '(无)'}（这些不会被碰）`);
console.log(`stateDir = ${stateDir}\n`);

const mod = await import(
	pathToFileURL(join(import.meta.dirname, '..', 'dsh-remote-desktop', 'lib', 'index.js')).href
);

const registered = [];
const logs = [];
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

mod.apply(ctx, { tunnelToken: STARTUP_TOKEN });

const pairRoute = registered.find((r) => r.path === mod.PAIR_ROUTE);
check(pairRoute !== undefined, 'apply() 注册了配对路由', pairRoute?.path ?? '(无)');

const busyWarn = logs.find(([level, m]) => level === 'warn' && /中继无法监听/.test(m));
if (busyWarn !== undefined) {
	console.log('（提示）中继端口被占用（本机有另一个 DSH 在跑），本进程只跑隧道 —— 不影响本测试');
}

// ---- 1. 等隧道 A 连上（有效 token，进程应长期存活） ----
console.log('\n等隧道 A 起来（最多 20 秒）…');
let oldPid;
for (let i = 0; i < 20; i++) {
	await new Promise((r) => setTimeout(r, 1000));
	const live = pidsOf('cloudflared').filter((p) => !before.has(p));
	if (live.length > 0) {
		oldPid = live[0];
		break;
	}
}
check(oldPid !== undefined, '隧道 A 进程已起且存活', oldPid ? `PID ${oldPid}` : '(没起来)');
if (oldPid === undefined) {
	console.log('隧道没起来，后续断言无意义，提前结束');
	rmSync(stateDir, { recursive: true, force: true });
	process.exit(1);
}
// 再等一会儿，确认它没有像假 token 那样自行退出
await new Promise((r) => setTimeout(r, 3000));
check(
	pidsOf('cloudflared').includes(oldPid),
	'隧道 A 持续存活（不是刚起就退出）',
	`PID ${oldPid}`,
);

// ---- 2. 打真实 /register 路由，触发热切 ----
function drivePairRoute(body) {
	return new Promise((resolve) => {
		const chunks = [JSON.stringify(body)];
		const req = {
			method: 'POST',
			url: `${mod.PAIR_ROUTE}/register`,
			headers: {},
			on(event, cb) {
				if (event === 'data') for (const c of chunks) cb(Buffer.from(c));
				if (event === 'end') cb();
				return req;
			},
		};
		let status = 0;
		const res = {
			writeHead(code) {
				status = code;
				return res;
			},
			end(payload) {
				resolve({ status, text: String(payload ?? '') });
			},
		};
		pairRoute.handler(req, res);
	});
}

console.log('\n打真实 /register 路由（向 pair.jiulingssh.xyz 注册，会发新隧道）…');
const t0 = Date.now();
const reply = await drivePairRoute({ code: CODE });
console.log(`   HTTP ${reply.status}，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
let payload;
try {
	payload = JSON.parse(reply.text);
} catch {
	console.log('   响应不是 JSON:', reply.text.slice(0, 200));
}
if (payload) console.log(`   ok=${payload.ok} hostname=${payload.hostname ?? '(无)'}  ${payload.message ?? ''}`);
check(payload?.ok === true, '/register 返回成功');

// ---- 3. 关键断言：旧的被杀、新的起来、没有并存 ----
console.log('\n等新隧道起来（最多 20 秒）…');
let newPid;
for (let i = 0; i < 20; i++) {
	await new Promise((r) => setTimeout(r, 1000));
	const live = pidsOf('cloudflared').filter((p) => !before.has(p) && p !== oldPid);
	if (live.length > 0) {
		newPid = live[0];
		break;
	}
}

const liveAll = pidsOf('cloudflared');
check(!liveAll.includes(oldPid), '旧隧道 A 的进程已被杀掉', `旧 PID ${oldPid} ${liveAll.includes(oldPid) ? '仍活着 ← 会双隧道抢域名' : '已退出'}`);
check(newPid !== undefined, '新隧道 B 的进程已起来', newPid ? `PID ${newPid}` : '(没起来)');
const mine = liveAll.filter((p) => !before.has(p));
check(mine.length === 1, '自己起的隧道进程总数为 1（旧的真死了，不是并存）', `当前 ${mine.length} 个：${mine.join(',')}`);

console.log('\n相关日志:');
for (const [level, m] of logs.filter(([, m]) => /隧道退出|隧道切换到|隧道启动失败/.test(m))) {
	console.log(`   [${level}] ${m}`);
}

// ---- 收尾 ----
for (const pid of pidsOf('cloudflared')) if (!before.has(pid)) killPid(pid);
rmSync(stateDir, { recursive: true, force: true });
console.log('\n已清理：本次起的隧道进程已杀，临时目录已删');
console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
