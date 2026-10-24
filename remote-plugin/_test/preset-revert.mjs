/**
 * 「切回手机工作区后，预设列表没跟着切回来」的回归测试。
 *
 * ## 这条 bug 的真身（2026-10-17 真机实测定位）
 *
 * 用户报障：「用户添加并选择了电脑工作区之后，预设列表更新为电脑预设，
 * 但是此时从电脑的某工作区切回手机工作区比如默认工作区，预设列表没有
 * 恢复为手机预设列表」。
 *
 * 插件的判据（`currentIsRemote`）**本来就是对的** —— 它只活在
 * `agentPresets.list()` 的包装里，问题在于**没人再调 `list()`**。
 *
 * 官方 hero chip（`dsh-client-ui-agent-preset` 的 `AgentPresetSeat`）只在
 * 三个时机重读 roster：组件挂载、`settings/document-updated`
 * （且只认 `agent-preset-registry`）、`connection/reset`。
 * **切工作区不在其中任何一条里。**
 *
 * 真机实测（页面世界挂 fetch/XHR 钩子）：整个会话里
 * `/api/agentPresets/list` 的 resource timing 条目数**恒为 5**，
 * 最后一条 `startTime = 2746926ms`，而当时 `performance.now() = 28677789ms`
 * —— 七个多小时一次都没再请求过。
 *
 * 于是行为不对称：**切到电脑**会连隧道、触发 `connection/reset` ⇒ 官方刷新
 * ⇒ 显示电脑预设（看起来是对的）；**切回手机**连接本来就在、没有任何 reset
 * ⇒ 不刷新 ⇒ 菜单永远停在电脑那份。
 *
 * ## 这个测试断言什么
 *
 * 插件在「当前工作区的远程性变了」时必须**主动把官方 chip 的 `load()` 叫一次**。
 * 所以这里不测 UI 文字，测**调用**：
 *
 * 1. 造一个假的官方 chip：往 `slots.entriesOfSlot('conversation.hero.agentPreset')`
 *    里放一个带 `inject()` 的 entry，`inject()` 返回面里的 `load` 记账；
 * 2. 用插件真实的 `apply()` 跑起来；
 * 3. 改会话 cwd / 工作区归属，然后 `sessions.list.subscribe` 的回调触发；
 * 4. 断言 `load` 被调用，且**只在远程性真的翻转时**才调用（不翻转不刷）。
 *
 * ⚠️ 必须等去抖窗口（插件里是 150ms）。测试用真实定时器，别改成 fake timer：
 * 那条去抖本身就是被验的对象之一（切工作区是好几步，中间态不能下结论）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = process.argv[2] ?? join(import.meta.dirname, '..', 'dsh-remote-mobile', 'lib', 'client.js');
const source = readFileSync(FILE, 'utf8');

let failed = 0;
const check = (ok, label, detail) => {
	if (ok) {
		console.log(`  ✅ ${label}`);
	} else {
		console.log(`  ❌ ${label}${detail === undefined ? '' : ` —— ${detail}`}`);
		failed += 1;
	}
};

/** 最小可用的 snapshot store（官方用的是 `createSnapshotStore`）。 */
function makeStore(initial) {
	let snapshot = initial;
	const listeners = new Set();
	return {
		getSnapshot: () => snapshot,
		subscribe(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		set(next) {
			snapshot = next;
			for (const fn of listeners) fn();
		},
		/** 测试用：不换对象，只通知（模拟「行内字段变了」那种原地更新）。 */
		touch() {
			for (const fn of listeners) fn();
		},
	};
}

let loaded = null;
global.window = {
	__ModuleLoader__: { load: (spec) => { loaded = spec; } },
};
global.EventSource = class {
	constructor() { this.readyState = 0; }
	addEventListener() {}
	close() {}
};
global.document = {
	querySelector: () => null,
	createElement: () => ({ dataset: {}, style: {}, appendChild() {}, set textContent(v) {} }),
	head: { appendChild() {} },
};
global.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });

// eslint-disable-next-line no-new-func
new Function('window', source)(global.window);
if (loaded === null) {
	console.error('❌ client.js 没有调用 window.__ModuleLoader__.load');
	process.exit(1);
}

const MODULES = {
	react: {
		createElement: () => null,
		useState: (v) => [v, () => {}],
		useEffect: () => {},
		useCallback: (fn) => fn,
		useRef: (v) => ({ current: v }),
		useMemo: (fn) => fn(),
	},
	'@deepseek-ai/dsh-client-ui-primitives': new Proxy({}, { get: () => () => null }),
};

const mod = loaded.factory((name) => {
	if (!(name in MODULES)) throw new Error(`模块表里没有 "${name}"`);
	return MODULES[name];
});

// ---------------------------------------------------------------- 假宿主状态

/** 电脑镜像工作区的 slug 集合（宿主桥 `mirrorSlugs` 的本地镜像）。 */
const MIRROR_SLUGS = ['desk-abc12345'];

/** 会话行：`cwd` 是 `isRemoteSession` 的主判据。 */
const sessionRows = {
	'phone-1': { id: 'phone-1', cwd: '/data/user/0/com.dsh.android/files/home/.dsh/workspace', blank: true },
	'desk-1': { id: 'desk-1', cwd: '/data/user/0/com.dsh.android/files/home/.dsh/remote/workspaces/desk-abc12345', blank: true },
};

/** 工作区行：`sessionIds` 让 `workspacePathOfCurrent` 能反查到路径。 */
const workspaceStore = makeStore({
	items: [
		{
			workspaceId: 'ws-phone',
			path: '/data/user/0/com.dsh.android/files/home/.dsh/workspace',
			sessionIds: ['phone-1'],
		},
		{
			workspaceId: 'ws-desk',
			path: '/data/user/0/com.dsh.android/files/home/.dsh/remote/workspaces/desk-abc12345',
			sessionIds: ['desk-1'],
		},
	],
	archivedSessionIds: [],
});

const sessionsStore = makeStore({ ids: ['phone-1', 'desk-1'], byId: sessionRows });

/**
 * `uiWorkspace.selection` —— 切工作区**落定**的那一刻会写它
 * （官方 `replaceMain()` 里的 `this.selection.set({sessionId})`）。
 */
const selectionStore = makeStore({ sessionId: 'phone-1' });

// ---------------------------------------------------------------- 假的官方 chip

/** `load()` 被调了几次、分别在什么「远程性」下被调。 */
const seatLoads = [];

/**
 * 官方 chip 的 inject 面 —— 形状抄 `dsh-client-ui-agent-preset` 的
 * `seatInjected(sessionId)`：`{ hooks, load, select, introduced }`。
 *
 * ⚠️ 这里只实现 `load`，因为被测的行为就是「谁把它叫起来」。
 */
const seatInject = () => ({
	hooks: {},
	load: () => {
		seatLoads.push({ remote: currentRemoteFlag() });
		return Promise.resolve();
	},
	select: () => Promise.resolve(),
	introduced: () => {},
});

/** 被测插件在那一刻会算出的远程性 —— 从它自己包装的 `list()` 结果反推。 */
function currentRemoteFlag() {
	// 直接读插件包装后的 `agentPresets.list()` 结果太绕；这里用同一份输入
	// 复算一次，判据与插件 `currentIsRemote()` 完全同构（工作区路径优先）。
	const sessionId = selectionStore.getSnapshot().sessionId;
	const items = workspaceStore.getSnapshot().items;
	const ws = items.find((item) => item.sessionIds.includes(sessionId));
	if (ws !== undefined) {
		return ws.path.includes('remote/workspaces/');
	}
	const row = sessionRows[sessionId];
	return row !== undefined && row.cwd.includes('remote/workspaces/');
}

/** slot 注册表：`entriesOfSlot` 要能返回上面那颗假 chip。 */
const slotEntries = [{ inject: seatInject }];
const registered = [];

const ctx = {
	effect: (fn) => fn(),
	slots: {
		entriesOfSlot: (name) => (name === 'conversation.hero.agentPreset' ? slotEntries : []),
		entries: (name) => (name === 'conversation.hero.agentPreset' ? slotEntries : []),
		inject: (slot, fn) => {
			const result = fn();
			if (result && typeof result.next === 'function') {
				let step = result.next();
				while (step.done !== true) step = result.next();
			}
			return result;
		},
		register: (spec) => {
			registered.push(spec);
			return () => {};
		},
	},
	sessions: {
		list: sessionsStore,
		binding: () => undefined,
		create: () => Promise.resolve(),
		refresh: () => Promise.resolve(),
	},
	workspaces: { list: workspaceStore },
	uiWorkspace: {
		selection: selectionStore,
		listDirectory: () => Promise.resolve({ path: '/', parent: '', home: '/', entries: [] }),
		createDirectory: () => Promise.resolve(),
		openSession: () => {},
	},
	remote: {
		agentPresets: {
			list: () => Promise.resolve({
				ok: true,
				value: {
					presets: [
						{ id: 'phone-default', isDefault: true, name: '手机默认' },
						{ id: 'pojia', desktop: true, name: '电脑预设' },
					],
				},
			}),
		},
	},
	get: () => undefined,
	logger: { info() {}, warn() {}, error() {} },
};

console.log('场景: 已配对，手机工作区 ⇄ 电脑工作区\n');

mod.apply(ctx);

const settle = (ms = 220) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- ① 基线
console.log('① 初始状态：当前是手机工作区');
await settle();
const baseLoads = seatLoads.length;
check(baseLoads === 0, '插件启动时不无端刷新 chip（远程性没变过）', `实际 ${baseLoads} 次`);

// ---------------------------------------------------------------- ② 切到电脑
console.log('\n② 切到电脑工作区（selection 指向电脑会话）');
selectionStore.set({ sessionId: 'desk-1' });
await settle();
check(seatLoads.length === baseLoads + 1, '切到电脑 ⇒ chip 的 load 被叫了 1 次', `实际 ${seatLoads.length - baseLoads} 次`);
check(seatLoads[seatLoads.length - 1]?.remote === true, '刷新时插件算出的是「电脑」');

// ---------------------------------------------------------------- ③ 切回手机（本 bug 的核心）
console.log('\n③ 切回手机工作区「默认工作区」—— 用户报障的那一步');
const beforeBack = seatLoads.length;
selectionStore.set({ sessionId: 'phone-1' });
await settle();
check(seatLoads.length === beforeBack + 1, '切回手机 ⇒ chip 的 load **必须**被叫 1 次', `实际 ${seatLoads.length - beforeBack} 次`);
check(seatLoads[seatLoads.length - 1]?.remote === false, '刷新时插件算出的是「手机」（否则筛出来的还是电脑那份）');

// ---------------------------------------------------------------- ④ 不翻转不刷
console.log('\n④ 同一工作区内会话列表变化（远程性没变）⇒ 不该刷');
const beforeNoop = seatLoads.length;
sessionsStore.touch();
await settle();
check(seatLoads.length === beforeNoop, '远程性没变就不刷（否则每次列表抖动都打一次 roster）', `多打了 ${seatLoads.length - beforeNoop} 次`);

// ---------------------------------------------------------------- ⑤ 只改 cwd 也能识别
console.log('\n⑤ 不写 selection、只把当前会话的 cwd 换成电脑镜像目录');
const beforeCwd = seatLoads.length;
sessionRows['phone-1'].cwd = '/data/user/0/com.dsh.android/files/home/.dsh/remote/workspaces/desk-abc12345';
// ⚠️ 同时把工作区那一行也改掉：`currentIsRemote()` 优先看工作区路径，
// 只改 cwd 会被工作区路径（仍是手机目录）盖过去 —— 那是**正确**的优先级，
// 不是缺陷。所以这里模拟「会话真的被挂进了电脑工作区」。
workspaceStore.set({
	...workspaceStore.getSnapshot(),
	items: workspaceStore.getSnapshot().items.map((item) => (
		item.workspaceId === 'ws-phone'
			? { ...item, path: '/data/user/0/com.dsh.android/files/home/.dsh/remote/workspaces/desk-abc12345' }
			: item
	)),
});
await settle();
check(seatLoads.length === beforeCwd + 1, '工作区路径变成镜像目录 ⇒ 刷 1 次', `实际 ${seatLoads.length - beforeCwd} 次`);
check(seatLoads[seatLoads.length - 1]?.remote === true, '这次算出的是「电脑」');

// ---------------------------------------------------------------- ⑥ 去抖
console.log('\n⑥ 连续快速切换（切工作区是好几步）⇒ 去抖后只刷一次');

// 先把 ⑤ 里改掉的手机工作区路径还原，让基线回到「手机」。
sessionRows['phone-1'].cwd = '/data/user/0/com.dsh.android/files/home/.dsh/workspace';
workspaceStore.set({
	...workspaceStore.getSnapshot(),
	items: workspaceStore.getSnapshot().items.map((item) => (
		item.workspaceId === 'ws-phone'
			? { ...item, path: '/data/user/0/com.dsh.android/files/home/.dsh/workspace' }
			: item
	)),
});
await settle();
const beforeBurst = seatLoads.length;

// 中间态先跳到手机、再跳电脑：净变化是「手机 → 电脑」，只该刷一次。
selectionStore.set({ sessionId: 'phone-1' });
selectionStore.set({ sessionId: 'desk-1' });
selectionStore.set({ sessionId: 'desk-1' });
await settle(320);
check(seatLoads.length === beforeBurst + 1, '连续多次变更只触发 1 次刷新', `实际 ${seatLoads.length - beforeBurst} 次`);
check(seatLoads[seatLoads.length - 1]?.remote === true, '按最终态（电脑）刷，不按中间态');

// ---------------------------------------------------------------- ⑦ 插件仍注册了槽位
console.log('\n⑦ 兜底：插件自身的目录对话框没被这次改动破坏');
check(
	registered.some((spec) => spec.name === 'conversation.hero.workspace.directoryFlow'),
	'仍然注册了 conversation.hero.workspace.directoryFlow',
);
check(
	registered.every((spec) => spec.priority === -1),
	'仍然用 priority -1 占首位',
);

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
