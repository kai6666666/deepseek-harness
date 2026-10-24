/**
 * 验证 `remoteFetch` 的三条通道与错误展开 —— **行为级**，不是源码级。
 *
 * ## 为什么必须单独测这一处
 *
 * 2026-10-16 线上故障：手机配对报 `fetch failed`，而配对服务器日志里**根本没有
 * 这次请求** —— 请求没出网。根因是插件里 `await import('undici')` 解析不到
 * undici（它在**引擎**的 node_modules 里，不在插件的解析链上），于是静默退回
 * 全局 `fetch`，而全局 fetch 在 Android 上会因 Happy Eyeballs 卡死。
 *
 * 症状具有极强的欺骗性：**同一个版本，一台手机能配对、另一台不能**（取决于
 * 当下网络让 Happy Eyeballs 撞不撞车），看起来像玄学。
 *
 * 本测试用**真实的 `callRemote`**（走 `remoteFetch`）打一个本机 HTTP 服务器：
 *   - 本目录（`_test/`）解析不到 undici ⇒ 正好复现那台手机的条件；
 *   - 若走 `node:https` 兜底，请求会成功；
 *   - 若退回全局 fetch（旧代码），在 Node 24 上其实也能通 —— 所以**关键判据是
 *     源码里没有全局 fetch 分支**，加上兜底通道本身能跑通。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = join(HERE, '..', 'dsh-remote-mobile', 'lib', 'index.js');

let pass = 0;
let fail = 0;
const ok = (label, detail = '') => {
	pass += 1;
	console.log(`✅ ${label}${detail === '' ? '' : `  ${detail}`}`);
};
const no = (label, detail = '') => {
	fail += 1;
	console.log(`❌ ${label}${detail === '' ? '' : `  ${detail}`}`);
};

// DSH_HOME 指到临时目录：不能碰真用户的状态文件。
process.env.DSH_HOME = join(process.env.TEMP ?? '/tmp', `dsh-fetch-fallback-${Date.now()}`);

/** 靶子服务器：模拟电脑端中继的 RPC 契约。 */
const server = createServer((req, res) => {
	if (req.url === '/api/dsh-remote/rpc') {
		let body = '';
		req.on('data', (chunk) => {
			body += chunk;
		});
		req.on('end', () => {
			const parsed = JSON.parse(body);
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(
				JSON.stringify({
					ok: true,
					result: {
						method: parsed.method,
						token: req.headers['x-dsh-remote-token'] ?? null,
						id: parsed.id ?? null,
					},
				}),
			);
		});
		return;
	}
	if (req.url === '/api/dsh-remote/broken') {
		// 直接毁掉连接：用于验证错误会被展开，而不是只给一句 `fetch failed`。
		req.socket.destroy();
		return;
	}
	res.writeHead(404);
	res.end('nope');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

const mod = await import(pathToFileURL(MOBILE).href);
const { callRemote } = mod;

console.log('=== ① 源码级：不许再有「退回全局 fetch」的分支 ===');
const source = readFileSync(MOBILE, 'utf8');
const start = source.indexOf('async function remoteFetch');
// 用函数名定位（不依赖注释的换行符，CRLF/LF 都能命中）。
const end = source.indexOf('function nodeHttpsFetch');
if (start < 0 || end < 0 || end < start) {
	no('定位不到 remoteFetch / nodeHttpsFetch，源码结构变了');
} else {
	const body = source.slice(start, end);
	if (/nodeHttpsFetch\(url, init\)/.test(body)) ok('失败后切到 node:https 通道');
	else no('没有切到 nodeHttpsFetch');
	// 关键判据：remoteFetch 内部不许出现**裸** fetch()（那就是旧的降级路径）。
	// 先剥掉注释行（注释里会提到 `fetch()` 这种字样），再排除两条合法通道。
	const codeOnly = body
		.split('\n')
		.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
		.join('\n')
		.replace(/nodeHttpsFetch\(/g, '')
		.replace(/pool\.undici\.fetch\(/g, '')
		.replace(/undici\.fetch\(/g, '');
	if (/(^|[^.\w])fetch\(/.test(codeOnly)) {
		no('remoteFetch 里仍有裸 fetch() 调用', (codeOnly.match(/.*(^|[^.\w])fetch\(.*/) ?? [''])[0].trim().slice(0, 60));
	} else {
		ok('remoteFetch 里没有裸 fetch() 调用');
	}
	// 两条通道互为备份：undici 池失败也要能落到 node:https。
	if (/pool\.undici\.fetch/.test(body) && /attempts\.push/.test(body)) {
		ok('两条通道互为备份（不是「解析失败才兜底」）');
	} else {
		no('两条通道没有互为备份');
	}
}
if (source.includes("from 'node:https'")) ok('静态导入 node:https（解析零风险，不依赖 undici）');
else no('没有静态导入 node:https');
if (/family: 4/.test(source)) ok('兜底通道强制 IPv4（Android 上 IPv6 常不通）');
else no('兜底通道没有强制 IPv4');

console.log('\n=== ② 行为级：真实 callRemote 打本机服务器 ===');
{
	// 本目录解析不到 undici ⇒ 与那台手机同条件，走兜底通道。
	const config = { endpoint: BASE, token: 'a'.repeat(64) };
	try {
		const result = await callRemote(config, 'ping', {});
		if (result?.method === 'ping') ok('callRemote 成功出网（兜底通道可用）', JSON.stringify(result));
		else no('callRemote 返回了意外结果', JSON.stringify(result));
		if (result?.token === 'a'.repeat(64)) ok('自定义头 x-dsh-remote-token 被透传');
		else no('自定义头没有透传', String(result?.token));
		if (typeof result?.id === 'string' && result.id !== '') ok('请求体（含 id）被正确写出');
		else no('请求体没有写出', JSON.stringify(result));
	} catch (error) {
		no('callRemote 抛错', String(error?.message ?? error));
	}
}

console.log('\n=== ③ 未配对时必须拦在本机（不出网）===');
{
	try {
		await callRemote({ endpoint: BASE, token: '' }, 'ping', {});
		no('空令牌竟然发出去了');
	} catch (error) {
		if (String(error.message).includes('还没配对')) ok('空令牌被本机拦下', String(error.message).slice(0, 40));
		else no('空令牌报错文案不对', String(error.message));
	}
}

console.log('\n=== ④ 失败时错误被展开（不再是一句 fetch failed）===');
{
	const config = { endpoint: `http://127.0.0.1:1`, token: 'a'.repeat(64) };
	try {
		await callRemote(config, 'ping', {});
		no('连不通的端口竟然成功了');
	} catch (error) {
		const text = String(error?.message ?? error);
		// 两条通道都失败时要分别报出来，否则还是看不出该改什么。
		if (text.includes('两条通道都失败')) ok('两条通道的失败原因都报了出来', text.replace(/\s+/g, ' ').slice(0, 100));
		else no('没有分别报告两条通道', text.replace(/\s+/g, ' ').slice(0, 100));
		if (text.includes('←')) ok('错误带出了 cause 链');
		else no('错误没有展开 cause');
		if (text.includes('走的是专用 undici 池') && text.includes('走的是 node:https 通道')) {
			ok('两条通道各自标明了身份');
		} else {
			no('没有分别标明两条通道');
		}
	}
}

console.log('\n=== ⑤ 源码里登记了常见 errno 的含义（排查手册）===');
for (const code of ['ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'CERT_']) {
	if (source.includes(code)) ok(`登记了 ${code}`);
	else no(`没有登记 ${code}`);
}
if (/error\?\.cause/.test(source)) ok('会读 error.cause');
else no('没有读 error.cause');
if (/error\?\.errors/.test(source)) ok('会读 AggregateError.errors（多地址同时失败）');
else no('没有读 AggregateError.errors');

console.log('\n=== ⑥ 兜底通道的 abort 语义（SSE 重连依赖）===');
if (/name = 'AbortError'/.test(source)) ok('会抛 AbortError');
else no('没有抛 AbortError');
if (/init\.signal/.test(source)) ok('支持 signal');
else no('不支持 signal');
if (/AbortError' \|\| error\?\.name === 'TimeoutError'/.test(source)) ok('remoteFetch 放行 AbortError（不包装成网络故障）');
else no('remoteFetch 会吞掉 AbortError');

server.close();
console.log(`\n共 ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
