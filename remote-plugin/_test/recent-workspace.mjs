/**
 * 回归测试：**在备选区直接选上次那个电脑目录，必须仍然是远程会话**。
 *
 * ## 这个测试钉的是哪个 bug
 *
 * 用户原话：「我此时如果再新建一个对话，然后在备选区里面选择 dshapp 目录，
 * 这时候发信息 他其实就是在本地的，因为我问他 你的工作目录是什么？
 * 他回答的就是我安卓的目录，然后模型的话 他也没有加载到电脑的模型」。
 *
 * 根因：第一次是从「电脑文件夹」对话框选的目录，走本插件的 `createSession` 桥，
 * sessionId 进了 `remoteSessions`，prompt 因此转发电脑。第二次是在**新建对话首页的
 * 备选区**里点那个工作区 —— 官方前端直接 `sessionController.create({workspaceId})`，
 * **不经过本插件**，于是 sessionId 不在 `remoteSessions` 里，prompt 拦截不命中，
 * 消息交给手机本地 agent（真跑手机模型、cwd 是手机路径）。
 *
 * 修法是在 `sessionController.create` 上挂钩子：认出「cwd 落在镜像目录下」的会话，
 * 反查电脑路径，让电脑建同名会话，再补进 `remoteSessions`。
 *
 * 本测试用**假的 ctx / 假的 controller / 假的本机 relay**，把这条链路整条跑通。
 *
 * 用法：`node recent-workspace.mjs`
 */

import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MOBILE = new URL('../dsh-remote-mobile/lib/index.js', import.meta.url);

let passed = 0;
let failed = 0;
const ok = (what, extra = '') => {
	passed += 1;
	console.log(`✅ ${what}${extra === '' ? '' : `  ${extra}`}`);
};
const no = (what, extra = '') => {
	failed += 1;
	console.log(`❌ ${what}${extra === '' ? '' : `  ${extra}`}`);
};
const assert = (cond, what, extra = '') => (cond ? ok(what, extra) : no(what, extra));

/** 每个用例一个干净的 DSH_HOME，避免互相污染。 */
function freshHome() {
	const home = mkdtempSync(join(tmpdir(), 'dsh-recent-'));
	process.env.DSH_HOME = home;
	return home;
}

/** 读远程会话清单；文件不存在时当空（未配对/未绑过就不会有这个文件）。 */
function readListed(home) {
	try {
		return readFileSync(join(home, 'dsh-remote', 'sessions.json'), 'utf8');
	} catch {
		return '';
	}
}

// ── 假的本机 relay：手机引擎"打到电脑"的那一端 ──────────────────────────────
//
// 真的 relay 是电脑上的 `dsh-remote-desktop`，这里只需要认得 `createSession`。
/** 收到的 RPC 调用，供断言。 */
let relayCalls = [];
/**
 * 让 `modelCatalog` 回错误。
 *
 * 用来复现「前端页面加载时，配对后的后台预拉还没回来」这个竞态：把预拉那一次
 * 打成失败，插件内部的缓存就停在 `null`，此时拦截器拿到 `modelCatalog` 调用
 * **必须自己当场去拉一次**（这正是 1.0.17 报的「模型列表还是没同步」）。
 */
let failCatalog = false;
function startFakeRelay() {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			const chunks = [];
			req.on('data', (c) => chunks.push(c));
			req.on('end', () => {
				let body = {};
				try {
					body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
				} catch {
					/* 忽略 */
				}
				relayCalls.push(body);
				res.writeHead(200, { 'content-type': 'application/json' });
				// `fileReadBytes` 要回一段真 base64，手机端那段的还原才测得出来
				// （它必须还原成 `Uint8Array`，官方预览面板不认字符串）。
				// `fileList` 要回官方那个 `{path, entries, truncated}` 形状 ——
				// 前端只挑 `entries` 与 `truncated`，形状不对侧边栏就是一片空。
				//
				// `listDirectory` 回一个「根」目录（第 ⑧ 节数它被调了几次，
				// 用来验证预拉缓存；名字要与那节的断言对上）。
				// `modelCatalog` 回一个**只有电脑才有**的组 —— 合并后它必须排最前，
				// 那正是「模型列表刷新为电脑的」这条需求的判据。
				const result = body?.method === 'fileReadBytes'
					? { absolutePath: 'C:\\x\\logo.png', version: 'v1', offset: 0, eof: true, data: Buffer.from([1, 2, 3, 255]).toString('base64') }
					: body?.method === 'fileList'
						? { path: body?.params?.path ?? '', entries: [{ name: '电脑上的东西', type: 'file', size: 7 }], truncated: false }
						: body?.method === 'listDirectory'
							? {
									path: body?.params?.path ?? 'C:\\Users\\demo',
									parent: '',
									home: 'C:\\Users\\demo',
									entries: [{ name: '电脑上的东西', path: 'C:\\Users\\demo\\电脑上的东西', isDirectory: true }],
								}
							: body?.method === 'modelCatalog'
								? failCatalog
									? undefined
									: {
											groups: [{ id: 'desktop-group', models: [{ id: 'buddy:deepseek-v4.1-flash' }] }],
											failures: [],
											default: { provider: 'desktop-group', model: 'buddy:deepseek-v4.1-flash' },
										}
								: body?.method === 'presetList'
									? { presets: [{ id: 'desktop-preset' }] }
									: { sessionId: body?.params?.sessionId };
				if (body?.method === 'modelCatalog' && failCatalog) {
					res.end(JSON.stringify({ ok: false, error: '模拟：预拉还没回来' }));
					return;
				}
				res.end(JSON.stringify({ ok: true, result }));
			});
		});
		server.listen(0, '127.0.0.1', () => resolve(server));
	});
}

/**
 * 造一个够用的假 ctx。
 *
 * @param opts - `{ workspacePath, desktopPath }`：镜像工作区的真实路径。
 * @returns `{ ctx, controller, created }`。
 */
function makeCtx(opts) {
	/** 记录被 create 的会话。 */
	const created = [];
	/** 假的 workspaceRegistry。 */
	const registry = {
		create: async (dir, title) => ({
			id: `ws-${title}`,
			path: dir,
			title,
			attachSession: async () => undefined,
		}),
		get: (id) => (id === 'ws-mirror' ? { id, path: opts.workspacePath, title: 'DSHAPP' } : undefined),
	};
	/** 假的 sessionController：只实现本插件要挂的那几个方法。 */
	const controller = {
		create: async (request) => {
			const sessionId = request.sessionId ?? `session-${created.length + 1}`;
			created.push({ request, sessionId });
			return { sessionId };
		},
		prompt: async () => ({ accepted: true }),
		cancel: async () => ({ accepted: true }),
	};
	const ctx = {
		logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		webServer: { register: () => () => undefined },
		sessions: { get: (id) => (typeof id === 'string' && id !== '' ? { id } : undefined) },
		sessionController: controller,
		workspaceRegistry: registry,
		effect: (fn) => {
			const dispose = fn();
			return typeof dispose === 'function' ? dispose : undefined;
		},
		inject: () => undefined,
		get: (name) => {
			if (name === 'workspaceRegistry') return registry;
			// ⚠️ 桥路由的前置准入要用引擎的 `connection.requestRejection`
			//（见 `bridgeRejection`），取不到就是 **503 fail-closed**。这里给一个
			// 「全部放行」的桩，代表「引擎判据已就绪且认这个请求」——测试要验的是
			// 插件自己的逻辑，不是引擎的鉴权。
			if (name === 'connection') return { requestRejection: () => undefined };
			return undefined;
		},
		on: () => undefined,
	};
	return { ctx, controller, created };
}

// ── 用例 ────────────────────────────────────────────────────────────────────

console.log('=== ① 镜像目录 → 电脑路径 的反查（纯函数级）===');
{
	freshHome();
	const mod = await import(`${MOBILE.href}?t=${Date.now()}`);
	const { apply, callRemote } = mod;
	assert(typeof apply === 'function', '插件导出 apply');
	assert(typeof callRemote === 'function', '插件导出 callRemote（测试钩子）');

	// 源码级：必须有 create 拦截，且必须查镜像表。
	const src = readFileSync(MOBILE, 'utf8');
	assert(/controller\.create = async/.test(src), '存在 sessionController.create 拦截');
	assert(/desktopPathOfMirror\(workspaceMap/.test(src), '用 workspaceMap 反查电脑路径');
	assert(/workspaces\.json/.test(src), '镜像登记表落盘到 workspaces.json');
	// 反查必须容忍 realpath 差异（/data/user/0 vs /data/data），且两种分隔符都认。
	assert(src.includes('dir.search(') && src.includes('workspaces'), '反查用正则定位 /workspaces/（容忍 realpath 与分隔符差异）');
}

console.log('\n=== ② 备选区选镜像工作区 → 自动绑成远程会话 ===');
{
	const home = freshHome();
	const server = await startFakeRelay();
	const port = server.address().port;
	relayCalls = [];

	// 造出镜像登记表 + 已配对的凭据。
	mkdirSync(join(home, 'dsh-remote', 'workspaces', 'c-users-你的用户名-dshapp-deadbeef'), { recursive: true });
	writeFileSync(
		join(home, 'dsh-remote', 'workspaces.json'),
		JSON.stringify({ workspaces: { 'c-users-你的用户名-dshapp-deadbeef': 'C:\\Users\\你的用户名\\Desktop\\DSHAPP' } }),
	);
	writeFileSync(
		join(home, 'dsh-remote', 'mobile.json'),
		JSON.stringify({ endpoint: `http://127.0.0.1:${port}`, token: 'a'.repeat(64) }),
	);

	const mod = await import(`${MOBILE.href}?t=${Date.now()}`);
	const { apply, callRemote, loadConfig } = mod;
	const mirrorPath = join(home, 'dsh-remote', 'workspaces', 'c-users-你的用户名-dshapp-deadbeef');
	const { ctx, controller } = makeCtx({ workspacePath: mirrorPath });
	apply(ctx);

	// 模拟前端在备选区点那个工作区：官方会走 workspaceId 分支。
	const result = await controller.create({ workspaceId: 'ws-mirror' });
	assert(typeof result?.sessionId === 'string', 'create 正常返回 sessionId', result?.sessionId);

	// 给 create 拦截里那次 callRemote 一点时间（它内部 await 了，但保险起见）。
	await new Promise((r) => setTimeout(r, 300));

	const creates = relayCalls.filter((c) => c.method === 'createSession');
	assert(creates.length === 1, '电脑端被要求建了同名会话', `收到 ${creates.length} 次`);
	if (creates.length === 1) {
		assert(creates[0].params.sessionId === result.sessionId, '两端 sessionId 一致');
		assert(
			creates[0].params.cwd === 'C:\\Users\\你的用户名\\Desktop\\DSHAPP',
			'传给电脑的是**电脑路径**（不是手机镜像路径）',
			creates[0].params.cwd,
		);
	}

	// 关键断言：这个会话必须被登记为远程，否则 prompt 会跑手机本地模型。
	const listed = readListed(home);
	assert(listed.includes(result.sessionId), '会话已写进 remoteSessions（prompt 会转发电脑）');

	// 行为级：prompt 必须打到电脑，而不是本地 controller。
	relayCalls = [];
	const prompts = await (async () => {
		// 直接调被包装过的 prompt：命中远程分支就会 callRemote。
		return await controller.prompt({ sessionId: result.sessionId, content: [{ type: 'text', text: '你的工作目录是什么' }] });
	})();
	await new Promise((r) => setTimeout(r, 300));
	assert(
		relayCalls.some((c) => c.method === 'prompt'),
		'prompt 被转发到电脑（不是手机本地模型）',
		`relay 收到 ${relayCalls.filter((c) => c.method === 'prompt').length} 次 prompt`,
	);
	assert(prompts?.accepted === true, 'prompt 回执 accepted');

	server.close();
}

console.log('\n=== ③ 未配对时不许绑（否则一发消息就报错）===');
{
	const home = freshHome();
	const server = await startFakeRelay();
	relayCalls = [];
	mkdirSync(join(home, 'dsh-remote', 'workspaces', 'c-users-你的用户名-dshapp-deadbeef'), { recursive: true });
	writeFileSync(
		join(home, 'dsh-remote', 'workspaces.json'),
		JSON.stringify({ workspaces: { 'c-users-你的用户名-dshapp-deadbeef': 'C:\\DSHAPP' } }),
	);
	// 没有 mobile.json ⇒ 令牌为空 ⇒ 未配对。
	const mod = await import(`${MOBILE.href}?t=${Date.now()}`);
	const mirrorPath = join(home, 'dsh-remote', 'workspaces', 'c-users-你的用户名-dshapp-deadbeef');
	const { ctx, controller } = makeCtx({ workspacePath: mirrorPath });
	mod.apply(ctx);
	const result = await controller.create({ workspaceId: 'ws-mirror' });
	await new Promise((r) => setTimeout(r, 200));
	assert(relayCalls.length === 0, '未配对时**没有**打电脑', `打了 ${relayCalls.length} 次`);
	const listed = readListed(home);
	assert(!listed.includes(result.sessionId), '未配对时**没有**绑成远程会话（退回本地）');
	server.close();
}

console.log('\n=== ④ 普通手机本地会话不受影响 ===');
{
	const home = freshHome();
	const server = await startFakeRelay();
	const port = server.address().port;
	relayCalls = [];
	mkdirSync(join(home, 'dsh-remote'), { recursive: true });
	writeFileSync(
		join(home, 'dsh-remote', 'mobile.json'),
		JSON.stringify({ endpoint: `http://127.0.0.1:${port}`, token: 'a'.repeat(64) }),
	);
	const mod = await import(`${MOBILE.href}?t=${Date.now()}`);
	// cwd 是普通的手机目录，不是镜像目录。
	const { ctx, controller } = makeCtx({ workspacePath: '/data/user/0/com.dsh.android/files/home/workspace' });
	mod.apply(ctx);
	await controller.create({ workspaceId: 'ws-local' });
	await new Promise((r) => setTimeout(r, 250));
	// ⚠️ **只断言「会话绑定类」的调用**（`createSession` / `prompt`），不能断言
	// `relayCalls.length === 0`：配对成功后本插件会**静默预拉**电脑的模型目录与
	// 预设名单（`prefetchDesktop`），那是与具体会话无关的全局拉取，每次配对都会
	// 打一条 `modelCatalog` + 一条 `presetList`。按条数断言会把「预拉」误判成
	// 「这个本地会话被绑到电脑上了」。
	const bound = relayCalls.filter((c) => c.method === 'createSession' || c.method === 'prompt');
	assert(bound.length === 0, '本地会话**没有**绑到电脑', `打了 ${JSON.stringify(bound.map((c) => c.method))}`);
	server.close();
}

console.log('\n=== ⑤ 电脑建会话失败 → 退回本地，不留坏会话 ===');
{
	const home = freshHome();
	// 指向一个没人监听的端口 ⇒ callRemote 必失败。
	mkdirSync(join(home, 'dsh-remote'), { recursive: true });
	writeFileSync(
		join(home, 'dsh-remote', 'mobile.json'),
		JSON.stringify({ endpoint: 'http://127.0.0.1:1', token: 'a'.repeat(64) }),
	);
	mkdirSync(join(home, 'dsh-remote', 'workspaces', 'c-x-deadbeef'), { recursive: true });
	writeFileSync(
		join(home, 'dsh-remote', 'workspaces.json'),
		JSON.stringify({ workspaces: { 'c-x-deadbeef': 'C:\\X' } }),
	);
	const mod = await import(`${MOBILE.href}?t=${Date.now()}`);
	const mirrorPath = join(home, 'dsh-remote', 'workspaces', 'c-x-deadbeef');
	const { ctx, controller } = makeCtx({ workspacePath: mirrorPath });
	mod.apply(ctx);
	const result = await controller.create({ workspaceId: 'ws-mirror' });
	await new Promise((r) => setTimeout(r, 1500));
	assert(typeof result?.sessionId === 'string', 'create 本身不抛（会话照建）');
	const listed = readListed(home);
	assert(!listed.includes(result.sessionId), '电脑失败时**没有**绑（不会留下发不出消息的会话）');
}

console.log('\n=== ⑥ 远程会话的文件树被转给电脑（侧边栏 / 预览那条链）===');
{
	const home = freshHome();
	const server = await startFakeRelay();
	const port = server.address().port;
	relayCalls = [];

	const slug = 'c-users-你的用户名-dshapp-deadbeef';
	mkdirSync(join(home, 'dsh-remote', 'workspaces', slug), { recursive: true });
	writeFileSync(
		join(home, 'dsh-remote', 'workspaces.json'),
		JSON.stringify({ workspaces: { [slug]: 'C:\\Users\\你的用户名\\Desktop\\DSHAPP' } }),
	);
	writeFileSync(
		join(home, 'dsh-remote', 'mobile.json'),
		JSON.stringify({ endpoint: `http://127.0.0.1:${port}`, token: 'a'.repeat(64) }),
	);

	const mod = await import(`${MOBILE.href}?t=${Date.now()}`);
	/** 假的官方 `workspaceFiles`：记录有没有被本地调用（远程会话**不该**落到这里）。 */
	const localCalls = [];
	const workspaceFiles = {
		async list(scope, path, signal) {
			localCalls.push(`list:${path}`);
			return { path, entries: [{ name: '本地的东西', type: 'file' }], truncated: false };
		},
		async read(scope, path, range, signal) {
			localCalls.push(`read:${path}`);
			return { absolutePath: path, version: 'local', offset: range?.offset ?? 1, text: '本地的内容', lines: 1, eof: true };
		},
		async stat(scope, path) {
			localCalls.push(`stat:${path}`);
			return { absolutePath: path, version: 'local', bytes: 1 };
		},
		async readBytes(scope, path, options) {
			localCalls.push(`readBytes:${path}`);
			return { absolutePath: path, version: 'local', offset: 0, data: new Uint8Array([9]), eof: true };
		},
	};

	const mirrorPath = join(home, 'dsh-remote', 'workspaces', slug);
	const { ctx, controller } = makeCtx({ workspacePath: mirrorPath });
	ctx.get = (name) => (name === 'workspaceFiles' ? workspaceFiles : name === 'workspaceRegistry' ? ctx.workspaceRegistry : undefined);
	mod.apply(ctx);

	// 先走一次 create，把这个 sessionId 记进 remoteSessions（远程会话的判据）。
	const created = await controller.create({ workspaceId: 'ws-mirror' });
	await new Promise((r) => setTimeout(r, 300));
	const sessionId = created.sessionId;
	relayCalls = [];

	// —— 根目录：官方侧边栏第一次 load 走的就是这个（path = 会话 cwd）——
	const rootList = await workspaceFiles.list({ sessionId, workspaceRoot: mirrorPath }, mirrorPath, new AbortController().signal);
	const listCall = relayCalls.find((c) => c.method === 'fileList');
	assert(listCall !== undefined, '根目录 list 转给了电脑');
	assert(listCall?.params?.sessionId === sessionId, '带上 sessionId');
	assert(listCall?.params?.path === '', '转发的是**工作区相对路径**（根 = 空串），不是手机镜像路径', JSON.stringify(listCall?.params?.path));
	assert(localCalls.filter((c) => c.startsWith('list:')).length === 0, '**没有**落到手机本地的 workspaceFiles', JSON.stringify(localCalls));
	assert(rootList?.entries?.[0]?.name === '电脑上的东西', '把电脑的 entries 原样回给前端', JSON.stringify(rootList?.entries));

	// —— 子目录：剥掉镜像前缀 ——
	relayCalls = [];
	await workspaceFiles.list({ sessionId, workspaceRoot: mirrorPath }, `${mirrorPath}/src`, new AbortController().signal);
	assert(relayCalls[0]?.params?.path === 'src', '子目录换成相对路径 `src`', JSON.stringify(relayCalls[0]?.params?.path));

	// —— read：offset 要透传 ——
	relayCalls = [];
	await workspaceFiles.read({ sessionId, workspaceRoot: mirrorPath }, `${mirrorPath}/README.md`, { offset: 3 }, new AbortController().signal);
	const readCall = relayCalls.find((c) => c.method === 'fileRead');
	assert(readCall !== undefined, 'read 转给了电脑');
	assert(readCall?.params?.offset === 3, 'offset 透传', String(readCall?.params?.offset));

	// —— stat ——
	relayCalls = [];
	await workspaceFiles.stat({ sessionId, workspaceRoot: mirrorPath }, `${mirrorPath}/src/a.js`, new AbortController().signal);
	assert(relayCalls.some((c) => c.method === 'fileStat'), 'stat 转给了电脑');

	// —— readBytes：base64 → Uint8Array ——
	relayCalls = [];
	const bytes = await workspaceFiles.readBytes({ sessionId, workspaceRoot: mirrorPath }, `${mirrorPath}/logo.png`, {}, new AbortController().signal);
	assert(relayCalls.some((c) => c.method === 'fileReadBytes'), 'readBytes 转给了电脑');
	assert(bytes?.data instanceof Uint8Array, 'data 还原成了 Uint8Array（官方预览面板不认字符串）', bytes?.data?.constructor?.name);
	assert(bytes?.data?.length === 4 && bytes.data[3] === 255, '字节值正确（含 255，验证不是有符号坑）', JSON.stringify(Array.from(bytes?.data ?? [])));

	// —— 本地会话不受影响（前缀不匹配 ⇒ 照走本地）——
	relayCalls = [];
	localCalls.length = 0;
	const localResult = await workspaceFiles.list({ sessionId: 'some-local-session', workspaceRoot: '/data/user/0/com.dsh.android/files/home/workspace' }, '/data/user/0/com.dsh.android/files/home/workspace', new AbortController().signal);
	assert(relayCalls.length === 0, '本地会话**没有**打电脑');
	assert(localCalls.some((c) => c.startsWith('list:')), '本地会话照走官方实现');
	assert(localResult?.entries?.[0]?.name === '本地的东西', '本地结果原样返回');

	server.close();
}

console.log('\n=== ⑦ 「在此新建对话」那条桥（用户 1.0.16 报障的报错点）===');
{
	// ⚠️ **这条用例的价值在覆盖面，不在断言数量。**
	//
	// 前面几节走的都是 `sessionController.create` 拦截 —— 那是「备选区里选一个
	// 已存在的镜像工作区」那条路。而用户是在**「添加工作区 → 电脑」对话框**里点
	// 的「在此新建对话」，走的是**浏览器桥** `POST /api/dsh-remote/rpc` 的
	// `createSession` 分支，那条路经过 `handleBridge`，是**另一个函数**。
	//
	// 1.0.16 的真实报障就出在这里：`handleBridge` 是模块级函数，作用域里没有
	// `apply()` 的闭包变量，而 `createSession` 分支直接引用了 `workspaceMap`
	// ⇒ 用户点「在此新建对话」只看到一行 `workspaceMap is not defined`。
	// 所以这里必须**真的打一次桥**，而不是只读源码做文本断言。
	const home = freshHome();
	const server = await startFakeRelay();
	const port = server.address().port;
	relayCalls = [];

	// ⚠️ `freshHome()` 只换 HOME 并清空目录，不负责建 `dsh-remote/` —— 第 ②③④⑤
	// 节都自己 `mkdirSync` 了，这里漏了就会 ENOENT。
	mkdirSync(join(home, 'dsh-remote'), { recursive: true });
	writeFileSync(
		join(home, 'dsh-remote', 'mobile.json'),
		JSON.stringify({ endpoint: `http://127.0.0.1:${port}`, token: 'a'.repeat(64) }),
	);

	const mod = await import(`${MOBILE.href}?t=${Date.now()}`);
	const { handleBridge } = mod;
	assert(typeof handleBridge === 'function', '插件导出 handleBridge（桥的入口）');

	const { ctx } = makeCtx({ workspacePath: '/data/user/0/com.dsh.android/files/home/workspace' });

	/** 收集桥写回的登记表文件名，用来验证 `workspaceMap` 真的被写进去了。 */
	let seenMap = null;
	ctx.get = (name) => {
		if (name === 'workspaceRegistry') {
			return {
				create: (dir, title) => ({ id: 'ws-desktop', path: dir, title, attachSession: async () => {} }),
			};
		}
		if (name === 'sessionPersistence') return undefined;
		return undefined;
	};
	mod.apply(ctx);

	const remoteSessions = new Set();
	const io = {
		remoteSessions,
		follow: () => {},
		follows: new Map(),
		mirrorStates: new Map(),
		workspaceMap: (seenMap = {}),
		persist: () => {},
		desktopCache: undefined,
		prefetch: () => Promise.resolve(),
		body: { method: 'createSession', params: { path: 'C:\\Users\\你的用户名\\Desktop\\DSHAPP' } },
	};

	let result;
	let thrown = null;
	try {
		result = await handleBridge(ctx, mod.loadConfig(), io);
	} catch (error) {
		thrown = error;
	}

	// 这一条就是 1.0.16 的核心回归断言：不许再抛 `workspaceMap is not defined`。
	assert(thrown === null, 'createSession 不抛错（1.0.16 在这里抛 workspaceMap is not defined）', String(thrown?.message ?? thrown));
	if (thrown === null) {
		assert(typeof result?.sessionId === 'string' && result.sessionId !== '', '回执带 sessionId', JSON.stringify(result));
		assert(result?.desktopPath === 'C:\\Users\\你的用户名\\Desktop\\DSHAPP', '回执带电脑路径', String(result?.desktopPath));
		assert(remoteSessions.has(result.sessionId), '新会话被登记为远程（prompt 会转发电脑）');

		// `workspaceMap` 必须真的被写进登记表 —— 这正是它被引用的原因，
		// 只断言「没抛错」会漏掉「传进去了但没写」。
		const slugs = Object.keys(seenMap);
		assert(slugs.length === 1, '把 `<slug> → 电脑路径` 写进了登记表', JSON.stringify(seenMap));
		assert(seenMap[slugs[0]] === 'C:\\Users\\你的用户名\\Desktop\\DSHAPP', '登记表里是电脑路径', JSON.stringify(seenMap));

		const creates = relayCalls.filter((c) => c.method === 'createSession');
		assert(creates.length === 1, '电脑端被要求建同名会话', `收到 ${creates.length} 次`);
		assert(creates[0]?.params?.cwd === 'C:\\Users\\你的用户名\\Desktop\\DSHAPP', '传给电脑的是电脑路径', String(creates[0]?.params?.cwd));
	}

	// —— 未配对时必须给出可操作的中文提示，而不是抛一个 TypeError ——
	relayCalls = [];
	writeFileSync(join(home, 'dsh-remote', 'mobile.json'), JSON.stringify({ endpoint: `http://127.0.0.1:${port}`, token: '' }));
	const mod2 = await import(`${MOBILE.href}?t=${Date.now() + 1}`);
	let unpaired = null;
	try {
		await handleBridge(ctx, mod2.loadConfig(), { ...io, remoteSessions: new Set(), workspaceMap: {} });
	} catch (error) {
		unpaired = String(error?.message ?? error);
	}
	assert(unpaired !== null && /配对/.test(unpaired), '未配对时给的是「请先配对」而不是崩溃', String(unpaired));

	server.close();
}

console.log('\n=== ⑧ 模型目录必须并进电脑的 + 根目录预拉（用户 1.0.17 报障）===');
{
	// ⚠️ 这一节盯的是本轮两个独立的报障，**两条机制完全不同**，别混在一起看：
	//
	// ① 「预设列表也正确的加载了电脑预设，但模型列表还是没同步」——
	//    根因在前端：官方 `ModelCatalogDirectory` 一旦 ready 就永久缓存，此后
	//    点菜单一个请求都不发；而预设走 `remoteExportList`，**没有缓存层**、
	//    每次重读。所以是「宿主缓存里有没有电脑数据」+「前端有没有被通知重载」
	//    两件事，这里只能验前半段（宿主侧），后半段在 dir-cache.mjs 里验。
	//    前半段的关键是：**页面一加载就会调 `modelCatalog`**，它可能早于配对时的
	//    后台预拉 —— 所以拦截器必须「缓存为空就当场拉」，不能只等预拉。
	//
	// ② 「目录树都提前存档手机本地了，为什么还是还加载呢，不能预加载吗」——
	//    根目录那一层现在进 `desktopCache.directory`，`listDesktop` 不带 path 时
	//    直接回缓存、**不打隧道**。断言方式是数 relay 收到几次 `listDirectory`。
	const home = freshHome();
	const server = await startFakeRelay();
	const port = server.address().port;
	mkdirSync(join(home, 'dsh-remote'), { recursive: true });
	writeFileSync(
		join(home, 'dsh-remote', 'mobile.json'),
		JSON.stringify({ endpoint: `http://127.0.0.1:${port}`, token: 'a'.repeat(64) }),
	);

	const mod = await import(`${MOBILE.href}?t=${Date.now() + 7}`);
	const { handleBridge } = mod;
	const { ctx } = makeCtx({ workspacePath: '/data/user/0/com.dsh.android/files/home/workspace' });

	/**
	 * 手机本地的模型目录（假）。
	 *
	 * ⚠️ 必须在 `apply()` **之前**挂到 controller 上：插件的拦截器是在 apply 里
	 * 读 `ctx.sessionController.modelCatalog` 并替换掉的，晚挂就等于没拦。
	 */
	const localGroups = [{ id: 'phone-only', models: [{ id: 'agnes-3.0-flash' }] }];
	ctx.sessionController.modelCatalog = async () => ({
		groups: localGroups,
		failures: [],
		default: { provider: 'phone-only', model: 'agnes-3.0-flash' },
	});

	/**
	 * 让 `modelCatalog` 先失败一次，用来复现「前端比预拉先到」那一刻。
	 *
	 * ⚠️ **这里不能写 `let failCatalog = true`** —— 那会声明一个**块级**变量把
	 * 模块级那个遮蔽掉，而假 relay 闭包读的是模块级的 ⇒ 预拉其实照样成功，
	 * 断言就会以「拦截器没打桥」的形式假失败。直接赋值。
	 */
	failCatalog = true;
	mod.apply(ctx);
	// 等预拉那次（注定失败的）请求飞完，免得它算进后面的计数。
	await new Promise((resolve) => setTimeout(resolve, 60));

	/** 记录「下一层预取」被触发了几次、用的是哪一层。 */
	const prefetchDirsCalls = [];
	const prefetchDirsSpy = (listing) => {
		prefetchDirsCalls.push(listing);
	};

	/** 每次桥调用自己带一份独立的 `desktopCache`，才不会互相串味。 */
	const cache = { catalog: null, presets: null, directory: null, dirs: {}, at: 0 };
	const io = {
		remoteSessions: new Set(),
		follow: () => {},
		follows: new Map(),
		mirrorStates: new Map(),
		workspaceMap: {},
		persist: () => {},
		desktopCache: cache,
		prefetch: () => Promise.resolve(),
		// ⚠️ 与 `workspaceMap` 同理：`handleBridge` 是模块级函数，看不见闭包里的
		// 这两个（见 `io` 构造处的注释）。少了就是 `io.prefetchDirs is not a function`。
		prefetchDirs: prefetchDirsSpy,
		rememberDir: (path, listing) => {
			cache.dirs[path] = listing;
		},
		body: { method: 'listDesktop', params: {} },
	};

	// —— ② 根目录：预拉一次之后，`listDesktop` 不带 path 必须**不打隧道** ——
	//
	// ⚠️ 这里先清空 `cache.directory`：`apply()` 里的启动预拉（`prefetchDesktop`）
	// 是异步的，可能已经在后台把根目录填进来了。我们要验的是 `listDesktop`
	// 自己的「没有缓存就拉、有缓存就回」逻辑，不是预拉有没有跑 —— 那两件事
	// 混在一起，断言会随着异步时序时对时错。
	cache.directory = null;
	relayCalls = [];
	await handleBridge(ctx, mod.loadConfig(), { ...io, body: { method: 'listDesktop', params: {} } });
	const firstList = relayCalls.filter((c) => c.method === 'listDirectory').length;
	assert(firstList === 1, '首次要根目录：打了 1 次隧道', `实际 ${firstList} 次`);
	assert(cache.directory !== null, '根目录被写进预拉缓存', JSON.stringify(cache.directory)?.slice(0, 80));

	relayCalls = [];
	const served = await handleBridge(ctx, mod.loadConfig(), { ...io, body: { method: 'listDesktop', params: {} } });
	const secondList = relayCalls.filter((c) => c.method === 'listDirectory').length;
	assert(secondList === 0, '再次要根目录：**零隧道调用**（预加载生效）', `实际 ${secondList} 次`);
	assert(served?.entries?.[0]?.name === '电脑上的东西', '缓存里的内容原样回给了前端', JSON.stringify(served?.entries));

	// 子目录：**首次**实时拉（缓存里还没有），拉完写进 `dirs`；再次进同一层零隧道。
	//
	// 这一节钉的是用户本轮报障原文：「你现在好像只缓存了顶级目录，打开某个文件夹
	// 还是要加载」—— 1.0.18 之前子层**完全没有**宿主侧缓存，每次点进去都要
	// 过一次 Cloudflare（实测 700～1200ms）。
	relayCalls = [];
	const sub = await handleBridge(ctx, mod.loadConfig(), { ...io, body: { method: 'listDesktop', params: { path: 'C:\\desktop-proj' } } });
	assert(relayCalls.filter((c) => c.method === 'listDirectory').length === 1, '子目录首次仍要实时拉（缓存里还没有）');
	assert(sub !== undefined, '子目录拿到了内容');
	assert(cache.dirs['C:\\desktop-proj'] !== undefined, '子目录拉完写进了 `dirs` 缓存');

	relayCalls = [];
	const subAgain = await handleBridge(ctx, mod.loadConfig(), { ...io, body: { method: 'listDesktop', params: { path: 'C:\\desktop-proj' } } });
	assert(
		relayCalls.filter((c) => c.method === 'listDirectory').length === 0,
		'再次进同一个子目录：**零隧道调用**（子层缓存生效）',
		`实际 ${relayCalls.filter((c) => c.method === 'listDirectory').length} 次`,
	);
	assert(subAgain === sub, '子层缓存里那份原样回给了前端');

	// 每次返回都要顺手预取「下一层」—— 用户看列表、决定点哪个的那一两秒
	// 就是用来干这个的。
	assert(prefetchDirsCalls.length > 0, '每次列目录都触发了「下一层」预取', `实际 ${prefetchDirsCalls.length} 次`);
	assert(
		prefetchDirsCalls.some((listing) => listing?.path === 'C:\\desktop-proj'),
		'预取用的正是刚拿到的这一层',
	);

	// 刷新必须把**子层**也整棵作废（根层作废、子层不作废比两处都不作废更难解释）。
	cache.dirs['C:\\desktop-proj'] = { path: 'C:\\desktop-proj', entries: [{ name: '旧内容' }] };
	relayCalls = [];
	await handleBridge(ctx, mod.loadConfig(), {
		...io,
		body: { method: 'refreshAll', params: { path: 'C:\\desktop-proj' } },
	});
	assert(
		cache.dirs['C:\\desktop-proj'] === undefined,
		'刷新把子层缓存整棵作废（点进去看的是电脑现状）',
		JSON.stringify(Object.keys(cache.dirs)),
	);

	// —— ⑨ 真 `prefetchDirs` 的行为（走**真 HTTP 路由**，不是测试自造的 io） ——
	//
	// ⚠️ **不能只在测试里造一个 spy 就算验过**：真正会跑的是 `apply()` 闭包里那个
	// `prefetchDirs`（带分批、去重、淘汰），而它只出现在 HTTP 路由构造的 `io` 里。
	// 所以这一节从真路由打进去，用**行为**验证：先列一层触发预取，等它飞完，
	// 再要那个子层 —— 零隧道就是真预取生效的铁证（spy 验不到这一层）。
	const routeCtx = makeCtx({ workspacePath: '/data/user/0/com.dsh.android/files/home/workspace' });
	/** 假 `webServer.register`：把路由 handler 留下来，稍后自己调。 */
	const routes = new Map();
	routeCtx.ctx.webServer = {
		register: (spec) => {
			routes.set(spec.path, spec.handler);
			return () => undefined;
		},
	};
	routeCtx.ctx.sessionController.modelCatalog = async () => ({
		groups: localGroups,
		failures: [],
		default: { provider: 'phone-only', model: 'agnes-3.0-flash' },
	});
	mod.apply(routeCtx.ctx);
	/** 直接把一条桥调用喂给真 handler（不真起 HTTP 服务）。 */
	const routeBridge = (method, params) =>
		new Promise((resolve, reject) => {
			const body = Buffer.from(JSON.stringify({ method, params: params ?? {} }));
			const handler = routes.get('/api/dsh-remote/rpc');
			if (handler === undefined) {
				reject(new Error('没注册 RPC 路由'));
				return;
			}
			handler(
				{
					// ⚠️ **真请求一定带 headers**：桥路由现在有前置准入（Host / Origin /
					// sec-fetch-site，见 `bridgeRejection`），桩少了 headers 会被 403 掉，
					// 这一节就会以「解析不到 JSON」的形式假报错 —— 那是桩的问题不是产品的问题。
					headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
					method: 'POST',
					on: (name, fn) => {
						if (name === 'data') fn(body);
						if (name === 'end') setImmediate(fn);
					},
				},
				{ writeHead: () => {}, end: (text) => resolve(JSON.parse(text)) },
			);
		});

	relayCalls = [];
	const rootListing = await routeBridge('listDesktop', {});
	assert(rootListing?.ok === true, '真路由：根目录列得出来', JSON.stringify(rootListing)?.slice(0, 80));
	const rootEntries = rootListing?.result?.entries ?? [];
	assert(rootEntries.length > 0, '真路由：根目录有内容（否则预取无对象）', JSON.stringify(rootEntries).slice(0, 120));
	// 真预取是**不 await 的后台动作**，等它飞完（见宿主 `prefetchDirs` 的注释）。
	await new Promise((resolve) => setTimeout(resolve, 200));

	// 真预取的铁证：现在去要刚才那一层里的子目录，应该**零隧道**。
	const probe = rootEntries.find((entry) => entry.isDirectory === true);
	relayCalls = [];
	const cachedChild = await routeBridge('listDesktop', { path: probe.path });
	assert(
		relayCalls.filter((c) => c.method === 'listDirectory').length === 0,
		'真 prefetchDirs：列完一层后，其子目录已经预取到本地（零隧道）',
		`实际 ${relayCalls.filter((c) => c.method === 'listDirectory').length} 次`,
	);
	assert(cachedChild?.ok === true, '真路由：命中的子目录正常回给前端');

	// —— ① 模型目录：预拉**没成功**时，拦截器必须**当场拉**，不能干等预拉 ——
	//
	// 这条是「模型列表还是没同步」的宿主侧回归：预拉是配对后的后台异步动作，
	// 而前端页面一加载就调 `modelCatalog`，谁先到谁决定用户看到什么。
	// 上面 `failCatalog = true` 让 apply 时那次预拉的 `modelCatalog` 失败，
	// 于是插件内部的 modelCatalog 缓存停在 null —— 正好等价于「前端先到一步」。
	//
	// ⚠️ **不能重新 `apply()` 一次** —— 那会把 prompt/cancel 拦截器在同一个
	// controller 上装第二遍，而第二次安装时 `prompt` 已经是第一遍包过的函数，
	// 测试会以 `Cannot read properties of undefined (reading 'bind')` 崩掉。
	// 拦截器在 `apply()` 里只装一次，等下断言即可。
	assert(cache.directory !== null, 'apply 时那次预拉确实跑过（目录预拉不受模型失败影响）');
	failCatalog = false;
	relayCalls = [];

	const merged = await ctx.sessionController.modelCatalog();
	const askedCatalog = relayCalls.filter((c) => c.method === 'modelCatalog').length;
	assert(askedCatalog === 1, '缓存为空时拦截器**当场问了电脑**', `实际 ${askedCatalog} 次`);
	const ids = (merged?.groups ?? []).map((g) => g.id);
	assert(ids[0] === 'desktop-group', '电脑的模型组排在**最前**（用户要的就是刷新为电脑的）', JSON.stringify(ids));
	assert(ids.includes('phone-only'), '手机本地的组仍在（本地会话不会因此没法用）', JSON.stringify(ids));

	// 有缓存之后不能再重复问 —— 每次打开模型菜单都打一次隧道是不能接受的。
	relayCalls = [];
	await ctx.sessionController.modelCatalog();
	assert(relayCalls.filter((c) => c.method === 'modelCatalog').length === 0, '有缓存后不再重复问电脑');

	// —— ⑩ 宿主这一侧的**契约**：前端靠这两个字段做工作区隔离 ——
	//
	// ⚠️ 这一节的必要性是被**反向验证**逼出来的：把宿主的 `desktop: true` 标记拆掉
	// （`groups.map(g => ({...g, desktop:true}))` 还原成裸 spread）后，全部测试**照样
	// 通过** —— 也就是说前端拿什么去区分「电脑的组 / 手机的组」根本没有断言钉住。
	// 而前端 `pickWorkspaceGroups` 认的就是 `desktop === true`：标记一丢，用户选了
	// 本地工作区仍会看到电脑的模型（正是本轮要修的报障），测试却全绿。
	//
	// 所以契约必须**在宿主这一侧**独立钉死，不能只靠前端侧的假数据自证。
	const contract = await ctx.sessionController.modelCatalog();
	const desktopGroup = (contract?.groups ?? []).find((g) => g.id === 'desktop-group');
	assert(desktopGroup !== undefined, '宿主回了电脑的组', JSON.stringify((contract?.groups ?? []).map((g) => g.id)));
	assert(desktopGroup?.desktop === true, '电脑的组必须带 `desktop: true`（前端的唯一判据）', JSON.stringify(desktopGroup));
	assert(
		(contract?.groups ?? []).filter((g) => g.id === 'phone-only').every((g) => g.desktop !== true),
		'手机本地的组**不能**被打上 `desktop`（否则本地工作区会被误判成远程）',
	);
	// 同 id provider 会走电脑那份 ⇒ 手机那份被**丢掉**，前端只能靠 `localGroups` 还原。
	// 所以这两个字段是接口，不是可有可无的附赠。
	assert(
		Array.isArray(contract?.localGroups) && contract.localGroups.length > 0,
		'宿主必须带上 `localGroups`（同 id provider 被电脑覆盖后，前端靠它还原手机那份）',
		JSON.stringify(contract?.localGroups),
	);
	assert(Array.isArray(contract?.localFailures), '宿主必须带上 `localFailures`（同上，失败项也要能还原）', JSON.stringify(contract?.localFailures));
	assert(
		contract.localGroups.every((g) => g.desktop !== true),
		'`localGroups` 里必须全是手机本地的组（那不是「电脑的组」的第二个副本）',
		JSON.stringify(contract.localGroups),
	);

	server.close();
}

console.log(`\n共 ${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
