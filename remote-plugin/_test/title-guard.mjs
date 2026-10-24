/**
 * 验证：远程会话在手机本地**不再生成标题事件**。
 *
 * ## 为什么需要这个测试
 *
 * 官方 `@deepseek-ai/dsh-session-title` 的 `ctx.on("session/event")` 对任何
 * `source.kind === "user"` 的 `user/message` 都会在本地写一条 `session/title`
 * （`onUserMessage()` → `ensureFallback()`）。手机端的本地日志是电脑日志的
 * **逐条镜像**，seq 必须严格对齐；本地多写的这 2 条会把电脑端同 seq 上的
 * 真实事件挤掉，而 `mirrorEvent` 对「折算 seq < 本地 seq」按「重连补发的历史」
 * **静默丢弃**，被挤掉的事件在手机上永久缺失。
 *
 * 真机实测（探针会话 `session-dc52fa34`）：两端各 41 条事件，仅 seq 9 与 16
 * 类型不一致 —— 丢的是电脑端的 workspace 说明与电脑端自己的标题。
 *
 * ## 这个测试怎么做到「可信」
 *
 * 它**不 mock 标题服务**：跑的是**引擎里那份真实 `dsh-session-title`**，
 * 承载它的也是**真实的 cordis `Context`**（插件的守卫依赖 cordis 的服务机制，
 * 用假对象测不出真问题）。流程：
 *   1. 真实 Context + 真实服务就位；
 *   2. 可选地先由插件 `apply()` 打上守卫；
 *   3. 喂一条 `user/message`，看真实服务**是否真的没有** append 标题事件。
 *
 * 断言的是「真实服务的行为被改变了」，而不是「我叫了我的桩」。
 *
 * 用法：node _test/title-guard.mjs <引擎 node_modules 绝对路径>
 */

import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const engineModules = process.argv[2];
if (engineModules === undefined) {
	console.error('用法: node title-guard.mjs <引擎 node_modules 绝对路径>');
	process.exit(2);
}

/**
 * 被测会话的 id。**必须与 `sessions.json` 里登记的一致** —— 守卫是按
 * 「这个会话在不在远程清单里」放行的，清单外的会话走原逻辑（本地写标题）。
 */
const SESSION_ID = 'session-test-1';

// ⚠️ 必须先于**首次** `import` 插件的模块：`SESSIONS_PATH` 是模块顶层算出来的
// 常量，import 之后就定死了。插件读的是 `$DSH_HOME/dsh-remote/sessions.json`，
// 所以这里把 `DSH_HOME` 指到一个临时目录，并把被测会话登记成**远程会话** ——
// 否则守卫会按设计放行，实验组必然失败（一开始就踩了这个：测试夹具漏了登记，
// 结果对照组与实验组都写标题）。
const HOME_DIR = mkdtempSync(join(tmpdir(), 'title-guard-'));
process.env.DSH_HOME = HOME_DIR;
mkdirSync(join(HOME_DIR, 'dsh-remote'), { recursive: true });
writeFileSync(
	join(HOME_DIR, 'dsh-remote', 'sessions.json'),
	JSON.stringify({ sessions: [SESSION_ID] }, null, 2),
);

let failures = 0;

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

/* ---------- 1. 真实 cordis ---------- */

const cordisPath = join(engineModules, '@deepseek-ai', 'cordis', 'lib', 'index.js');
const titlePath = join(engineModules, '@deepseek-ai', 'dsh-session-title', 'lib', 'index.js');
for (const [label, p] of [['cordis', cordisPath], ['dsh-session-title', titlePath]]) {
	if (!existsSync(p)) {
		console.error(`❌ 找不到 ${label}: ${p}`);
		process.exit(2);
	}
}
const { Context } = await import(pathToFileURL(cordisPath).href);
const titleMod = await import(pathToFileURL(titlePath).href);
const SessionTitleService = titleMod.default ?? titleMod.SessionTitleService;
if (typeof Context !== 'function' || typeof SessionTitleService !== 'function') {
	console.error('❌ cordis 或标题服务没有导出可用类');
	process.exit(2);
}
console.log(`\n真实 cordis Context    : ${cordisPath}`);
console.log(`真实标题服务           : ${titlePath}\n`);

/* ---------- 2. 假会话：只实现标题服务真正会碰的面 ---------- */

/**
 * 造一个够用的假会话。
 *
 * 标题服务会用 `session.header`、`session.snapshotEvents()`、`session.seq`，
 * 以及（经 `ctx.sessions`）判存活。
 *
 * @param {string} id - 会话 id。
 * @returns {object} 假会话。
 */
function makeSession(id) {
	const events = [];
	return {
		id,
		header: {},
		seq: 0,
		append(type, data, opts) {
			const event = { type, data, seq: this.seq, ...opts };
			this.seq += 1;
			events.push(event);
			return event;
		},
		snapshotEvents: () => events.slice(),
		requestHeader: () => undefined,
		_events: events,
	};
}

/**
 * 跑一次实验。
 *
 * @param {boolean} withGuard - 是否先由插件打上守卫。
 * @param {string} [sessionId] - 会话 id；默认用登记为远程的那个。
 * @returns {Promise<string[]>} 该会话上出现的 `session/title*` 事件类型列表。
 */
async function runOnce(withGuard, sessionId = SESSION_ID) {
	const root = new Context();
	const sessions = new Map();

	// ⚠️ 会话投影必须**真的能跑**：`titleInputOf(session)` 读的是
	// `sessionProjections.stateOf(session, 'titleInput')`，而那个 state 是靠
	// projection 的 `apply(state, event)` 一条条喂出来的。一开始把
	// `stateOf` stub 成恒定 `{first:null}`，于是 `ensureFallback()` 拿到
	// `first === null` 直接 return —— 对照组从不写标题，实验组的 ✅ 变成
	// **空转**（断言「没有标题事件」对一个从不触发的服务恒真）。
	const defs = new Map();
	const projStates = new Map();
	const stateOf = (session, key) => {
		const def = defs.get(key);
		if (def === undefined) return undefined;
		const per = projStates.get(key);
		if (!per.has(session)) per.set(session, def.init());
		return per.get(session);
	};
	/** 模拟引擎的会话投影流水线：把一条事件喂进所有投影。 */
	const feedProjections = (session, event) => {
		for (const [key, def] of defs) {
			const per = projStates.get(key);
			if (!per.has(session)) per.set(session, def.init());
			per.set(session, def.apply(per.get(session), event));
		}
	};

	root.provide('sessions', { get: (id) => sessions.get(id) });
	root.provide('sessionProjections', {
		register: (def) => {
			defs.set(def.key, def);
			projStates.set(def.key, new Map());
		},
		stateOf,
	});

	// ⚠️ **必须把服务建在一个「激活的 plugin fiber」里**，不能直接
	// `new SessionTitleService(root, ...)`：
	//   - `ctx.on(...)` 的订阅要挂在 fiber 上，根 ctx 上挂不到事件总线；
	//   - `serviceActive()` 判据是 `ownerFiber.state === 2`（active），
	//     非激活时 `onUserMessage()` **第一行就 return**。
	let service;
	await root.plugin({
		name: 'test-title-service',
		apply(inner) {
			service = new SessionTitleService(inner, {
				fallbackMaxWords: 6,
				fallbackMaxBytes: 60,
				maxTitleBytes: 200,
			});
		},
	});

	if (withGuard) {
		const pluginPath = new URL('../dsh-remote-mobile/lib/index.js', import.meta.url);
		const plugin = await import(pluginPath.href);
		if (typeof plugin.apply !== 'function') throw new Error('插件没有导出 apply');

		// 只喂插件运行这支守卫所需的最小面：其余依赖给空壳，
		// 避免把测试重心带到别的功能上。
		const noop = () => {};
		plugin.apply({
			logger: { info: noop, warn: (m) => console.log(`    [插件 warn] ${m}`), error: noop },
			effect: (fn) => fn(),
			inject: (_deps, cb) => cb({ sessionTitle: service }),
			get: (name) => (name === 'sessionTitle' ? service : undefined),
			on: noop,
			slots: { inject: noop, register: noop },
			uiWorkspace: {},
			workspaceRegistry: {},
			sessionController: { prompt: noop, cancel: noop },
			webServer: { register: noop },
			sessions: { get: (id) => sessions.get(id) },
		});
	}

	const session = makeSession(sessionId);
	sessions.set(session.id, session);

	// 走真实事件总线派发，这样「服务到底有没有被触发」由 cordis 决定。
	const event = {
		type: 'user/message',
		seq: 0,
		data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好，请回复四个字' }] },
	};
	session.append('user/message', event.data); // 先落日志（投影与 append 同序）
	feedProjections(session, event); // 再喂投影
	root.emit('session/event', session, event); // 最后广播，触发服务订阅
	// `onUserMessage` 里的 `ensureFallback` 是 `defer()` 出去的（微任务），等一拍。
	await new Promise((r) => setTimeout(r, 100));

	return session._events.filter((e) => e.type.startsWith('session/title')).map((e) => e.type);
}

console.log('【对照组】不打守卫（应当是：真实服务**会**写标题）');
const withoutGuard = await runOnce(false);
console.log(`  本地标题事件: ${withoutGuard.length === 0 ? '（无）' : withoutGuard.join(', ')}`);
ok(
	withoutGuard.includes('session/title'),
	'不打守卫时真实服务确实会本地写 session/title（证明实验有效、断言非空转）',
);

console.log('\n【实验组】打上插件的守卫（应当是：**不再**写标题）');
const withGuard = await runOnce(true);
console.log(`  本地标题事件: ${withGuard.length === 0 ? '（无）' : withGuard.join(', ')}`);
ok(withGuard.length === 0, '打上守卫后本地不再产生任何 session/title* 事件');

// ⚠️ 反向断言（必须有）：守卫只能拦**远程**会话。若它把本地会话也拦了，
// 用户的手机本地对话就再也拿不到标题 —— 那是把一个缺陷换成了另一个，
// 而且更显眼。这一路同时验证守卫用的是 `original.call(this, ...)`：
// 若 `this` 丢了，官方 `onUserMessage` 读 `this.registration` 会抛错，
// 这里会以「没写出标题」的形式暴露出来。
console.log('\n【反向组】本地会话（不在远程清单里）打上守卫后**仍应**写标题');
const localSession = await runOnce(true, 'session-local-1');
console.log(`  本地标题事件: ${localSession.length === 0 ? '（无）' : localSession.join(', ')}`);
ok(localSession.includes('session/title'), '守卫没有误伤本地会话，本地会话照旧生成标题');

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
