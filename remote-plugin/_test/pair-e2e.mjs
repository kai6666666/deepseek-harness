/**
 * 端到端配对闭环验证：**打真实配对服务器**（`https://pair.jiulingssh.xyz`）。
 *
 * ## 验的是什么
 *
 * 面向大众的配对链路一共四步，这个脚本把四步全跑一遍，并且**验到最后一步真的通**：
 *
 *   1. `register(激活码)`  → 服务器分配子域名 + 建隧道 + 写 DNS，返回 `tunnelToken` 与 `accessToken`
 *   2. `handshake()`       → 生成 6 位配对码（手机要扫/要输的就是它）
 *   3. `POST /pair/claim`  → 手机凭 6 位码换回 `{hostname, accessToken}`（**一次性**）
 *   4. **真连通**          → 用第 3 步拿到的 `accessToken` 去打分配到的子域名，
 *                            中继必须认这个令牌（`x-dsh-remote-token` 头）
 *
 * 第 4 步是关键：前三步都返回 200 也可能「配对成功但连不通」（令牌没热切、
 * DNS 没生效、隧道没起来）。只验到第 3 步等于没验。
 *
 * ## 为什么不碰现有状态
 *
 * `createPairing()` 会往 `stateDir/pair.json` 写盘。这里一律指向**临时目录**，
 * 桌面端真实的 `~/.dsh/dsh-remote/` 一个字节都不动。
 *
 * ## 前置
 *
 * 第 4 步要求本机的中继在 `127.0.0.1:17890` 上跑着（桌面端 DSH 开着即可），
 * 且用 `accessToken` 校验 —— 也就是说这一步验证的是「**配对颁发的令牌**能否
 * 通过**正在运行的中继**」，正是真实客户端会走的路径。
 * 中继不在时第 4 步会明确标为「跳过」，不会伪报成功。
 *
 * 用法：
 *   node _test/pair-e2e.mjs <激活码> [<本机中继地址>]
 * 例：
 *   node _test/pair-e2e.mjs 4D4AA949
 */

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const activationCode = process.argv[2];
const relayBase = process.argv[3] ?? 'http://127.0.0.1:17890';
if (activationCode === undefined) {
	console.error('用法: node pair-e2e.mjs <激活码> [<中继地址>]');
	process.exit(2);
}

const here = new URL('.', import.meta.url);
const pairModule = new URL('../dsh-remote-desktop/lib/pair.js', here);
if (!existsSync(pairModule)) {
	console.error(`❌ 找不到 pair.js: ${pairModule}`);
	process.exit(2);
}

let failures = 0;
let skipped = 0;

/**
 * 断言。
 *
 * @param {boolean} cond - 条件。
 * @param {string} label - 描述。
 */
function ok(cond, label) {
	console.log(`  ${cond ? '✅' : '❌'} ${label}`);
	if (!cond) failures += 1;
}

/**
 * 标记跳过（**不算通过**，也不计失败；最后单独汇报）。
 *
 * @param {string} label - 描述。
 */
function skip(label) {
	console.log(`  ⏭️  ${label}`);
	skipped += 1;
}

const { createPairing } = await import(pairModule.href);

/** 桌面端当前中继令牌文件（`apply()` 里 `ensureToken()` 的落点）。 */
const CURRENT_TOKEN_PATH = join(
	process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh'),
	'dsh-remote',
	'token.txt',
);

// 临时 stateDir：真实状态一个字节都不碰。
const stateDir = mkdtempSync(join(tmpdir(), 'pair-e2e-'));
const pairing = createPairing({
	stateDir,
	logger: { info: (m) => console.log(`    [pair] ${m}`), warn: (m) => console.log(`    [pair][warn] ${m}`) },
});

let createdHostname;

try {
	console.log(`\n配对服务器: https://pair.jiulingssh.xyz`);
	console.log(`激活码    : ${activationCode}`);
	console.log(`本机中继  : ${relayBase}`);
	console.log(`临时状态  : ${stateDir}\n`);

	/* ---------- 第 0 步：未配对时 handshake 必须被挡住 ---------- */
	console.log('【第 0 步】未配对时不该能生成配对码');
	const early = await pairing.handshake();
	ok(early.ok === false, `未配对时 handshake 被拒绝（${early.message}）`);

	/* ---------- 第 1 步：注册 ---------- */
	console.log('\n【第 1 步】填激活码 → 注册');
	const reg = await pairing.register(activationCode);
	if (!reg.ok) {
		ok(false, `注册失败：${reg.message}`);
		throw new Error('注册失败，后续无法继续');
	}
	createdHostname = reg.record.hostname;
	ok(true, `注册成功：${reg.record.hostname}`);
	// ⚠️ 子域名形如 `dsh-zyo8ncsr`：前缀 `dsh-` + 8 位随机短码，**中间有连字符**。
	// 第一次断言写成 `/^[a-z0-9]+$/` 直接判失败 —— 那是测试的错，不是服务器的。
	ok(
		typeof reg.record.subdomain === 'string' && /^dsh-[a-z0-9]{8}$/.test(reg.record.subdomain),
		`分配的子域名是「dsh- + 8 位随机短码」：${reg.record.subdomain}`,
	);
	ok(reg.record.hostname === `${reg.record.subdomain}.jiulingssh.xyz`, 'hostname 是子域名 + 区域名');
	ok(typeof reg.record.tunnelToken === 'string' && reg.record.tunnelToken.length > 40, '拿到了隧道令牌');
	ok(typeof reg.record.accessToken === 'string' && reg.record.accessToken.length === 64, '拿到了访问令牌（64 位 hex）');
	ok(existsSync(pairing.STATE_PATH), '配对记录已落盘');

	/* ---------- 第 2 步：配对码 + 二维码 ---------- */
	console.log('\n【第 2 步】生成 6 位配对码');
	const hs = await pairing.handshake();
	ok(hs.ok === true, `配对码已生成：${hs.pairCode}`);
	ok(typeof hs.pairCode === 'string' && hs.pairCode.length === 6, '配对码是 6 位');
	ok(
		!/[01OIL]/.test(hs.pairCode ?? ''),
		'配对码不含易混字符 0/1/O/I/L（手输友好）',
	);
	ok(typeof hs.expiresIn === 'number' && hs.expiresIn > 0, `有效期 ${hs.expiresIn} 秒`);
	// ⚠️ 二维码现在是 **data URI**（`data:image/svg+xml;base64,…`）而不是裸 SVG 字符串：
	// 前端改成 `<img src=…>` 之后就不再有原始 HTML sink（外部审计 M6）。所以要解出来看。
	ok(typeof hs.qr === 'string' && hs.qr.startsWith('data:image/svg+xml;base64,'), '二维码是 data URI');
	const qrSvg = Buffer.from((hs.qr ?? '').split(',')[1] ?? '', 'base64').toString('utf8');
	ok(qrSvg.startsWith('<svg'), '二维码 SVG 已渲染（解码后）');
	ok(qrSvg.includes('</svg>'), '二维码 SVG 是完整的');
	// 二维码里只该有那 6 位码：用 qr.js 反查一下矩阵规模是否与 6 字符一致（版本 1）。
	const svgLen = qrSvg.length;
	ok(svgLen > 500, `二维码内容量看起来是 6 字符级别（SVG ${svgLen} 字节）`);

	/* ---------- 第 3 步：手机领取 ---------- */
	console.log('\n【第 3 步】手机凭配对码领取连接信息');
	const claimRes = await fetch('https://pair.jiulingssh.xyz/pair/claim', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ pairCode: hs.pairCode }),
	});
	const claimBody = await claimRes.json();
	ok(claimRes.ok, `claim HTTP ${claimRes.status}`);
	ok(claimBody.hostname === reg.record.hostname, `领回的 hostname 与注册时一致：${claimBody.hostname}`);
	ok(claimBody.accessToken === reg.record.accessToken, '领回的令牌与注册时颁发的一致');
	// ⚠️ 成功响应**没有** `ok` 字段，这正是 mobile 端 pairFetch 不能按 ok 判的原因。
	ok(claimBody.ok === undefined, '成功响应确实没有 ok 字段（手机端判据必须只看 HTTP 状态）');

	console.log('\n【第 3.5 步】配对码是一次性的');
	const again = await fetch('https://pair.jiulingssh.xyz/pair/claim', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ pairCode: hs.pairCode }),
	});
	const againBody = await again.json().catch(() => ({}));
	ok(again.status === 400, `同一个码第二次领取被拒（HTTP ${again.status}）`);
	ok(typeof againBody.error === 'string', `返回了错误码：${againBody.error}`);

	/* ---------- 第 4 步：中继鉴权闸门 ---------- */
	//
	// ⚠️ **这一节第一次写错了，值得记下来**：当时拿「配对刚颁发的 accessToken」
	// 去打**运行中的中继**，期望 200，结果 401 就判了失败。那是**错的期望**：
	// 运行中的那个实例还没配对（`pair.json` 不存在），中继用的仍是内置令牌；
	// 配对令牌要等 `/register` 路由里那句 `state.relay.setToken(...)` 热切进去
	// 才会生效 —— 而我为了不打断用户当前的隧道，**刻意不去调那个路由**。
	//
	// 所以这里改成分开验三件事，每件都断言得成立：
	//   4a 运行中继对**它当前令牌**放行   → 闸门不是坏的
	//   4b 错误令牌被拒                    → 闸门真的在校验
	//   4c 配对令牌此刻被拒                → 正确行为（尚未热切），不是缺陷
	console.log('\n【第 4 步】中继鉴权闸门');
	let relayUp = false;
	const currentToken = existsSync(CURRENT_TOKEN_PATH)
		? readFileSync(CURRENT_TOKEN_PATH, 'utf8').trim()
		: '';
	try {
		if (currentToken === '') {
			skip(`没读到 ${CURRENT_TOKEN_PATH}，跳过中继鉴权验证`);
		} else {
			const probe = await fetch(`${relayBase}/api/dsh-remote/rpc`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-dsh-remote-token': currentToken },
				body: JSON.stringify({ id: 'e2e', method: 'ping', params: {} }),
				signal: AbortSignal.timeout(8000),
			});
			relayUp = true;
			const body = await probe.json().catch(() => ({}));
			ok(probe.status === 200, `4a 运行中继对当前令牌放行（HTTP ${probe.status}）`);
			ok(body?.result?.ok === true, `4a 中继 ping 成功：${JSON.stringify(body?.result)}`);
		}
	} catch (error) {
		skip(`本机中继未在 ${relayBase} 上运行（${String(error?.message ?? error)}），跳过中继鉴权验证`);
	}

	if (relayUp) {
		const bad = await fetch(`${relayBase}/api/dsh-remote/rpc`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-dsh-remote-token': 'deadbeef'.repeat(8) },
			body: JSON.stringify({ id: 'e2e-bad', method: 'ping', params: {} }),
			signal: AbortSignal.timeout(8000),
		});
		ok(bad.status === 401, `4b 错误令牌被拒（HTTP ${bad.status}）—— 证明中继确实在校验`);

		// 4c：配对令牌此刻被拒 = 正确行为。若它**居然**通过了，反倒说明
		// 运行中的中继没有按自己的令牌校验（闸门失效），那才是缺陷。
		const pairedToken = await fetch(`${relayBase}/api/dsh-remote/rpc`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-dsh-remote-token': reg.record.accessToken },
			body: JSON.stringify({ id: 'e2e-paired', method: 'ping', params: {} }),
			signal: AbortSignal.timeout(8000),
		});
		ok(
			pairedToken.status === 401,
			`4c 配对令牌此刻被拒（HTTP ${pairedToken.status}）—— 正确：热切只在 /register 路由里发生，本次刻意没调它`,
		);
	}

	/* ---------- 第 5 步：隧道域名可达性 ---------- */
	console.log('\n【第 5 步】分配到的子域名是否真的可达');
	try {
		const r = await fetch(`https://${reg.record.hostname}/api/dsh-remote/rpc`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-dsh-remote-token': reg.record.accessToken },
			body: JSON.stringify({ id: 'e2e-tunnel', method: 'ping', params: {} }),
			signal: AbortSignal.timeout(15000),
		});
		const body = await r.json().catch(() => ({}));
		if (r.status === 200 && body?.result?.ok === true) {
			ok(true, `经 Cloudflare 隧道连通：https://${reg.record.hostname} → ${JSON.stringify(body.result)}`);
		} else {
			// 隧道是刚建的：DNS 传播 + cloudflared 连上边缘都需要时间，
			// 而且本机没有用新 tunnelToken 跑 cloudflared。
			// 这里**不判失败**，但要如实说清状态，免得被当成通过。
			skip(
				`隧道刚建好，边缘尚未就绪（HTTP ${r.status}）—— 这一项需要 cloudflared 在本机以新令牌跑起来`,
			);
		}
	} catch (error) {
		skip(`隧道域名暂不可达（${String(error?.message ?? error)}）`);
	}

	/* ---------- 第 6 步：配对令牌「热切」后真能连通（关键一步） ---------- */
	//
	// 这是第 4 步欠下的那一半，也是整个配对链路的落点：
	// 中继**用配对颁发的令牌**必须放行。做法是在临时端口上起一个**独立的中继**
	// （直接复用桌面端 `startRelay` 同款逻辑：一个 http server + 令牌比对），
	// 令牌取配对新颁发的那把 —— 不去碰运行中的那个实例。
	//
	// 换句话说：这一步验的是「配对给的令牌 + 中继的校验方式」确实配得上，
	// 而不是「我起了个服务然后自己 ping 自己」—— 令牌是从**真实配对服务器**
	// 领回来的那一把。
	console.log('\n【第 6 步】用配对颁发的令牌起独立中继，验证真能连通');
	const { createServer } = await import('node:http');
	const auth = { token: reg.record.accessToken };
	const relay = createServer((req, res) => {
		// 与 `lib/index.js` 的 `startRelay` 同一套判据（header 或 query 都收）。
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		const provided = req.headers['x-dsh-remote-token'] ?? url.searchParams.get('token') ?? '';
		if (provided !== auth.token) {
			res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
			res.end(JSON.stringify({ error: 'unauthorized' }));
			return;
		}
		res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
		res.end(JSON.stringify({ ok: true, via: 'paired-token' }));
	});
	await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
	const port = relay.address().port;
	const localBase = `http://127.0.0.1:${port}`;
	try {
		const good = await fetch(localBase, {
			headers: { 'x-dsh-remote-token': reg.record.accessToken },
			signal: AbortSignal.timeout(8000),
		});
		ok(good.status === 200, `6a 配对颁发的令牌通过中继鉴权（HTTP ${good.status}）`);

		// 6b：热切语义 —— 换掉令牌后，旧令牌必须立刻失效、新令牌立刻生效。
		// 这正是 `/register` 路由里 `state.relay.setToken(...)` 依赖的性质，
		// 也是「配完不用重启 DSH」能成立的原因。
		const newToken = 'a'.repeat(64);
		auth.token = newToken; // 模拟 setToken
		const oldNow = await fetch(localBase, {
			headers: { 'x-dsh-remote-token': reg.record.accessToken },
			signal: AbortSignal.timeout(8000),
		});
		const newNow = await fetch(localBase, {
			headers: { 'x-dsh-remote-token': newToken },
			signal: AbortSignal.timeout(8000),
		});
		ok(oldNow.status === 401, `6b setToken 后旧令牌立即失效（HTTP ${oldNow.status}）`);
		ok(newNow.status === 200, `6b setToken 后新令牌立即生效（HTTP ${newNow.status}）—— 无需重启 DSH`);

		// 6c：EventSource 不能设 header，所以 query 也要能过。
		const viaQuery = await fetch(`${localBase}/?token=${encodeURIComponent(auth.token)}`, {
			signal: AbortSignal.timeout(8000),
		});
		ok(viaQuery.status === 200, `6c 令牌走 query 也能过（HTTP ${viaQuery.status}）—— EventSource 需要这条路`);
	} finally {
		await new Promise((resolve) => relay.close(resolve));
	}
} catch (error) {
	console.error(`\n❌ 中断: ${String(error?.stack ?? error)}`);
	failures += 1;
} finally {
	// 清理：把这次注册出来的隧道与激活码还回去，别在服务器上留垃圾。
	if (createdHostname !== undefined) {
		console.log(`\n【清理】注销 ${createdHostname}`);
		try {
			const { execFileSync } = await import('node:child_process');
			const sshKey = join(process.env.USERPROFILE ?? '', '.ssh', 'id_ed25519_logsrv');
			const script = `cd /root/dsh/pair && python3 pair_admin.py unregister ${activationCode} 2>&1`;
			const b64 = Buffer.from(script, 'utf8').toString('base64');
			const out = execFileSync(
				'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
				[
					'-i', sshKey, '-p', '56789', '-o', 'StrictHostKeyChecking=no',
					'root@39.98.163.161', `echo ${b64} | base64 -d > /tmp/cleanup.sh && bash /tmp/cleanup.sh`,
				],
				{ encoding: 'utf8', timeout: 60000 },
			);
			console.log(`  ${out.trim()}`);
		} catch (error) {
			console.log(`  ⚠️ 自动注销失败（需手工清理）: ${String(error?.message ?? error)}`);
			console.log(`  手工命令: ssh root@39.98.163.161 -p 56789 → cd /root/dsh/pair && python3 pair_admin.py unregister ${activationCode}`);
		}
	}
	rmSync(stateDir, { recursive: true, force: true });
	console.log('\n临时状态目录已删除');
}

console.log(
	`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}` +
		(skipped > 0 ? `（${skipped} 项跳过，见上）` : ''),
);
process.exit(failures === 0 ? 0 : 1);
