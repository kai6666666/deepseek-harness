/**
 * **凭据不再随包公开** —— 一次真实漏洞的回归测试。
 *
 * ## 漏洞是什么（2026-10-16 发现并修复）
 *
 * `dsh-jiuling-remote-desktop` 1.0.11 及更早把两个凭据**硬编码在包里**：
 *
 *   - `DEFAULT_TOKEN`        —— 中继鉴权令牌（手机端也内置了同一个值）
 *   - `DEFAULT_TUNNEL_TOKEN` —— 我自己的 Cloudflare 隧道凭据
 *
 * 包是发到 npm 公开的，所以任何人都能 `npm pack` 拿到这两个值。实测后果：
 *
 *   POST https://dsh-remote.jiulingssh.xyz/api/dsh-remote/rpc
 *   x-dsh-remote-token: <包内公开常量>
 *   → HTTP 200，cf-ray a4b1631e9a978bcf-SIN，读到本机 177 个目录条目
 *
 * 面向大众分发时这是**灾难级**的：每台未配对的客户机都拿同一个隧道凭据去连
 * **同一条**隧道，而访问令牌又是公开常量 ⇒ 任何一个客户都能读其他客户整台电脑。
 *
 * ## 这个脚本验什么
 *
 * 1. **源码里不含可用凭据**（两个文件都扫）；
 * 2. 未配对时**不起隧道**（`startTunnel` 根本不被调用）；
 * 3. 未配对时中继令牌是**本机随机生成**的 64 hex，且**不等于**那个旧公开常量；
 * 4. 令牌落盘到 `token.txt`，重启后**沿用**（不会每次启动都换，否则手机端连不上）；
 * 5. **老用户升级**：`token.txt` 里若还是旧公开常量，会被识别并**轮换成随机值**；
 * 6. 手机端：`mobile.json` 里若是旧公开常量，`pairStatus` 报**未配对**（不是「已配对」）。
 *
 * 用法：node no-shared-credentials.mjs
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const LEGACY = 'f6721b0cf82414709df172056193c78a6c374e9a920e51145dd7883923cf16e7';
const ROOT = join(import.meta.dirname, '..');
const DESKTOP = join(ROOT, 'dsh-remote-desktop', 'lib', 'index.js');
const MOBILE = join(ROOT, 'dsh-remote-mobile', 'lib', 'index.js');

let failed = 0;
const check = (ok, label, detail = '') => {
	console.log(`${ok ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`);
	if (!ok) failed += 1;
};

// ---------- 1. 源码里不含可用凭据 ----------
console.log('=== 1. 包里不含凭据 ===');
const desktopSrc = readFileSync(DESKTOP, 'utf8');
const mobileSrc = readFileSync(MOBILE, 'utf8');

check(!desktopSrc.includes(LEGACY) || /LEGACY_PUBLIC_TOKEN/.test(desktopSrc), '桌面端源码里那个旧令牌只出现在识别常量里');
// 精确判据：旧令牌的**每一次**出现，都必须紧跟在 LEGACY_PUBLIC_TOKEN 的赋值行上。
const legacyLines = (src) => src.split('\n').filter((l) => l.includes(LEGACY));
const desktopLegacy = legacyLines(desktopSrc);
check(
	desktopLegacy.length === 1 && /LEGACY_PUBLIC_TOKEN\s*=/.test(desktopLegacy[0]),
	'桌面端只有一处出现旧令牌，且是 LEGACY_PUBLIC_TOKEN 的定义',
	`共 ${desktopLegacy.length} 处`,
);
const mobileLegacy = legacyLines(mobileSrc);
check(
	mobileLegacy.length === 1 && /LEGACY_PUBLIC_TOKEN\s*=/.test(mobileLegacy[0]),
	'手机端同上',
	`共 ${mobileLegacy.length} 处`,
);
check(!desktopSrc.includes('DEFAULT_TUNNEL_TOKEN'), '桌面端已无硬编码的隧道凭据');
check(!desktopSrc.includes('DEFAULT_TOKEN ='), '桌面端已无硬编码的默认令牌');
check(!mobileSrc.includes('DEFAULT_TOKEN ='), '手机端已无硬编码的默认令牌');
// 隧道凭据是 JWT 形状（eyJ…），扫一遍确保没有漏网的
check(!/eyJ[A-Za-z0-9+/=]{60,}/.test(desktopSrc), '桌面端源码里没有任何 JWT 形状的隧道凭据');

// ---------- 2~5. 桌面端行为 ----------
console.log('\n=== 2. 未配对：不起隧道，令牌随机 ===');
const stateDir = mkdtempSync(join(tmpdir(), 'dsh-nocred-'));
process.env.DSH_HOME = join(stateDir, 'home');
process.env.DSH_REMOTE_CLOUDFLARED = join(stateDir, 'nonexistent-cloudflared.exe');

const mod = await import(pathToFileURL(DESKTOP).href);

/** 跑一次 apply()，收集日志与注册的路由。 */
function runApply(config = {}) {
	const logs = [];
	const registered = [];
	const disposers = [];
	const ctx = {
		effect: (fn) => {
			const d = fn();
			disposers.push(typeof d === 'function' ? d : () => {});
			return () => {};
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
	mod.apply(ctx, config);
	for (const d of disposers) {
		try {
			d();
		} catch {
			/* 端口被占等 */
		}
	}
	return { logs, registered };
}

const first = runApply();
check(
	!first.logs.some(([, m]) => /未找到 cloudflared|隧道启动失败/.test(m)),
	'未配对时**没有尝试起隧道**（不是「找不到 cloudflared」）',
	first.logs.filter(([, m]) => /隧道|cloudflared/.test(m)).map(([l, m]) => `[${l}] ${m}`).join(' | ') || '(无隧道日志)',
);
check(
	first.logs.some(([, m]) => /尚未配对，未启动隧道/.test(m)),
	'日志明确说明「尚未配对，未启动隧道」',
);

const tokenPath = join(stateDir, 'home', 'dsh-remote', 'token.txt');
check(existsSync(tokenPath), '令牌已落盘到 token.txt', tokenPath.replace(stateDir, '<tmp>'));
const token1 = readFileSync(tokenPath, 'utf8').trim();
check(/^[0-9a-f]{64}$/.test(token1), '令牌是 64 位十六进制（随机生成）', token1.slice(0, 12) + '…');
check(token1 !== LEGACY, '令牌**不等于**那个已公开的旧常量 ← 这是本次修复的核心');

console.log('\n=== 3. 重启沿用同一令牌（否则手机端配对后连不上）===');
const second = runApply();
const token2 = readFileSync(tokenPath, 'utf8').trim();
check(token2 === token1, '第二次启动沿用 token.txt 里的令牌', `${token1.slice(0, 8)}… == ${token2.slice(0, 8)}…`);
check(
	!second.logs.some(([, m]) => /检测到旧版内置的公开令牌/.test(m)),
	'沿用随机令牌时不会误报「旧令牌」',
);

console.log('\n=== 4. 老用户升级：token.txt 里还是旧公开常量 ===');
// 模拟 1.0.11 升级上来的机器：文件里就是那个公开常量
writeFileSync(tokenPath, LEGACY, { mode: 0o600 });
const third = runApply();
const token3 = readFileSync(tokenPath, 'utf8').trim();
check(
	third.logs.some(([, m]) => /检测到旧版内置的公开令牌（已泄露），正在换成本机随机令牌/.test(m)),
	'识别出旧公开令牌并打警告',
	third.logs.filter(([, m]) => /公开令牌/.test(m)).map(([l, m]) => `[${l}] ${m}`).join(' | '),
);
check(token3 !== LEGACY && /^[0-9a-f]{64}$/.test(token3), '已轮换成新的随机令牌（漏洞真的修掉了）', token3.slice(0, 12) + '…');
check(token3 !== token1, '轮换后的令牌与之前不同（确实重新生成）');

console.log('\n=== 5. 显式给了 tunnelToken 才起隧道 ===');
// ⚠️ `findCloudflared()` 还会看 `%LOCALAPPDATA%\cloudflared\cloudflared.exe`，
// 而那台机器上**真的有**。不重定向的话这一项会**真起一个隧道进程**（用假 token，
// 它会自己退出）—— 测试不该碰用户的进程。两个环境变量都指到空目录，
// 让「找不到 cloudflared」成为唯一可能的结果。
const savedLocalAppData = process.env.LOCALAPPDATA;
process.env.LOCALAPPDATA = join(stateDir, 'no-localappdata');
const explicit = runApply({ tunnelToken: 'x'.repeat(40) });
// ⚠️ 还原必须用 delete，不能赋 `undefined` —— 后者会把环境变量变成**字符串**
// `"undefined"`，并被后面的子进程继承（`findCloudflared` 会去探测
// `undefined\cloudflared\cloudflared.exe`）。虽然无害，但会污染测试环境。
if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA;
else process.env.LOCALAPPDATA = savedLocalAppData;
check(
	explicit.logs.some(([, m]) => /未找到 cloudflared，跳过隧道/.test(m)),
	'显式给了 tunnelToken ⇒ 才进入起隧道分支（走到「找 cloudflared」）',
	explicit.logs.filter(([, m]) => /cloudflared/.test(m)).map(([l, m]) => `[${l}] ${m}`).join(' | ') || '(无相关日志)',
);
check(
	!explicit.logs.some(([, m]) => /尚未配对，未启动隧道/.test(m)),
	'有 tunnelToken 时**不**打「尚未配对」的日志（两个分支互斥）',
);

console.log('\n=== 6. 手机端：旧公开令牌不算「已配对」===');
// ⚠️ 手机端的 `CONFIG_PATH` 是**模块顶层**算的（import 时就定了），所以同一个
// 进程里改 `DSH_HOME` 再 import 拿不到新路径。每个场景各起一个子进程。
const { execFileSync } = await import('node:child_process');
const probeMobile = (home) =>
	JSON.parse(
		execFileSync(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`const m = await import(${JSON.stringify(pathToFileURL(MOBILE).href)});` +
					'console.log(JSON.stringify(m.loadConfig()));',
			],
			{ env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' },
		).trim(),
	);

// 6a. 老用户：mobile.json 里存着那个公开常量
const mStateDir = mkdtempSync(join(tmpdir(), 'dsh-nocred-m-'));
mkdirSync(join(mStateDir, 'dsh-remote'), { recursive: true });
writeFileSync(
	join(mStateDir, 'dsh-remote', 'mobile.json'),
	JSON.stringify({ endpoint: 'https://x.example', token: LEGACY }),
	{ mode: 0o600 },
);
const cfg = probeMobile(mStateDir);
check(cfg.token === '', 'mobile.json 里的旧公开令牌被当成**未配对**（token 为空）', `token=${JSON.stringify(cfg.token)}`);

// 6b. 全新安装：首次运行写的模板里不该有任何令牌
const mStateDir2 = mkdtempSync(join(tmpdir(), 'dsh-nocred-m2-'));
const cfg2 = probeMobile(mStateDir2);
check(cfg2.token === '', '首次运行返回的配置里**没有令牌**', `token=${JSON.stringify(cfg2.token)}`);
const written = JSON.parse(readFileSync(join(mStateDir2, 'dsh-remote', 'mobile.json'), 'utf8'));
check(written.token === '', '落盘的 mobile.json 里 token 为空串（不再是公开常量）', JSON.stringify(written));
check(written.token !== LEGACY, '落盘内容**不等于**那个已公开的常量 ← 修复的核心');

// ---------- 收尾 ----------
for (const d of [stateDir, mStateDir, mStateDir2]) rmSync(d, { recursive: true, force: true });
console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
