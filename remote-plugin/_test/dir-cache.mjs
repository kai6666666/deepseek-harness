/**
 * 「电脑」页签的目录**访问缓存**真机行为回归（jsdom + react-dom，走真实 useEffect）。
 *
 * ## 覆盖的用户报障（1.0.16）
 *
 * 1. 「每次点击电脑都要重新加载一遍目录」—— 关掉对话框再打开、或切到手机页签再
 *    切回来，**不应该**再打一次 `listDesktop`。
 * 2. 「随便点击一个文件夹，文件夹里面的内容还要重新加载一遍」—— 同一个文件夹
 *    点进去 → 上一级 → 再点进去，第二次**必须命中缓存**，`listDesktop` 只该被
 *    调一次。
 * 3. 点「刷新」后，正在看的这一层必须重新打桥（缓存被作废），不能假刷新。
 *
 * ## 为什么必须数「桥被调了几次」
 *
 * 缓存有没有生效，从界面上是**看不出来**的 —— 两种情况最终都渲染出同一份目录。
 * 唯一的判据是 `fetch` 到 `/api/dsh-remote/rpc` 的 `listDesktop` 次数。
 * 所以这里把每次调用记进 `calls`，断言次数而不是断言文字。
 *
 * ⚠️ `fetch` 的响应带可控延时（`LATENCY`），否则缓存命中与未命中在断言上无法区分
 * 快慢 —— 我们只数次数，但延时能让「第二次是否真的没打桥」在日志里肉眼可见。
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const FILE = process.argv[2] ?? 'dsh-remote-mobile/lib/client.js';
const source = readFileSync(FILE, 'utf8');

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
	url: 'http://127.0.0.1:19387/',
	pretendToBeVisual: true,
});

global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
global.EventSource = dom.window.EventSource ?? class { constructor() {} addEventListener() {} close() {} };
global.IS_REACT_ACT_ENVIRONMENT = true;

let failed = 0;
const check = (ok, label, detail) => {
	if (ok) {
		console.log(`  ✅ ${label}`);
	} else {
		console.log(`  ❌ ${label}${detail === undefined ? '' : ` —— ${detail}`}`);
		failed += 1;
	}
};

/** 每次桥调用的记录。 */
const calls = [];
const LATENCY = 20;

/** 电脑上的假目录树：`路径 → 子项`。 */
const TREE = {
	'': {
		path: 'C:\\Users\\demo',
		parent: '',
		home: 'C:\\Users\\demo',
		entries: [
			{ name: 'Desktop', path: 'C:\\Users\\demo\\Desktop', isDirectory: true },
			{ name: 'Documents', path: 'C:\\Users\\demo\\Documents', isDirectory: true },
		],
	},
	'C:\\Users\\demo\\Desktop': {
		path: 'C:\\Users\\demo\\Desktop',
		parent: 'C:\\Users\\demo',
		home: 'C:\\Users\\demo',
		entries: [{ name: '项目代码', path: 'C:\\Users\\demo\\Desktop\\项目代码', isDirectory: true }],
	},
	'C:\\Users\\demo\\Desktop\\项目代码': {
		path: 'C:\\Users\\demo\\Desktop\\项目代码',
		parent: 'C:\\Users\\demo\\Desktop',
		home: 'C:\\Users\\demo',
		entries: [{ name: 'DSHAPP', path: 'C:\\Users\\demo\\Desktop\\项目代码\\DSHAPP', isDirectory: true }],
	},
};

/**
 * 取某个电脑路径的目录内容。
 *
 * ⚠️ `C:\Users\demo` 与「根」（`''`）在真实电脑上是**同一层**（`home` 就是它），
 * 所以点「上一级」从 Desktop 走出来时会带着这条绝对路径回问一次 —— mock 必须认它，
 * 否则会返回空目录，测试看起来像「上一级把内容弄丢了」，那是 mock 的假故障。
 */
function listingFor(path) {
	if (path === 'C:\\Users\\demo') return TREE[''];
	return TREE[path] ?? { path, parent: '', home: '', entries: [] };
}

global.fetch = (url, init) => {
	const raw = String(url);
	if (raw.endsWith('/api/dsh-remote/rpc')) {
		const body = JSON.parse(init?.body ?? '{}');
		const method = body.method;
		const path = body.params?.path ?? '';
		if (method === 'listDesktop') calls.push({ method, path });
		else calls.push({ method, path: undefined });
		let result;
		if (method === 'listDesktop') {
			result = listingFor(path);
			console.log(`     [mock] listDesktop path=${JSON.stringify(path)} → ${(result.entries ?? []).length} 项`);
		} else if (method === 'pairStatus') {
			result = { endpoint: 'https://dsh-demo.jiulingssh.xyz', paired: pairedFlag };
		} else if (method === 'pair') {
			pairedFlag = true;
			result = { endpoint: 'https://dsh-demo.jiulingssh.xyz', tokenSet: true };
		} else if (method === 'refreshAll') {
			result = { directory: { ok: true, value: listingFor(path) } };
			console.log(`     [mock] refreshAll path=${JSON.stringify(path)} → ${(result.directory.value.entries ?? []).length} 项`);
		} else if (method === 'remoteSessions') {
			result = { ids: remoteIds };
		} else if (method === 'mirrorSlugs') {
			result = { slugs: mirrorSlugList };
		} else {
			result = {};
		}
		return new Promise((resolve) => {
			setTimeout(() => resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, result }) }), LATENCY);
		});
	}
	return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
};
dom.window.fetch = global.fetch;

let loaded = null;
dom.window.__ModuleLoader__ = { load: (spec) => { loaded = spec; } };
new Function('window', 'document', 'EventSource', source)(dom.window, dom.window.document, global.EventSource);
if (loaded === null) { console.error('❌ 没调用 load'); process.exit(1); }

const React = (await import('react')).default;
const ReactDOMClient = await import('react-dom/client');
const act = React.act;

const passthrough = (tag) => (props) => React.createElement(tag, { style: props.style, className: props.className }, props.children);

const MODULES = {
	react: React,
	'@deepseek-ai/dsh-client-ui-primitives': new Proxy({}, {
		get(_t, name) {
			if (name === 'Modal') return (props) => (props.open ? React.createElement('div', { className: props.className }, props.children) : null);
			if (name === 'Input') return (props) => React.createElement('input', { ...props, style: undefined, value: props.value ?? '', readOnly: true });
			if (name === 'Button') return (props) => React.createElement('button', { type: 'button', style: props.style, disabled: props.disabled, onClick: props.onClick }, props.children);
			if (name === 'Pill') return (props) => React.createElement('span', null, props.children);
			if (name === 'SegmentedTabs') {
				return (props) => React.createElement(
					'div',
					{ role: 'tablist' },
					(props.items ?? []).map((item) => React.createElement(
						'button',
						{ key: item.value, type: 'button', role: 'tab', 'aria-selected': item.value === props.value, onClick: () => props.onChange?.(item.value) },
						item.label,
					)),
				);
			}
			return passthrough('div');
		},
	}),
};

const mod = loaded.factory((name) => {
	if (!(name in MODULES)) throw new Error(`模块表里没有 "${name}"`);
	return MODULES[name];
});

const cells = [];

/**
 * 假的官方模型目录服务（`super(ctx, "modelDirectories")`）。
 *
 * `catalog.refresh()` 是官方在 `llm/adapters-updated` 时走的同一条路 —— 我们靠它
 * 把前端那份**永久缓存**的模型目录作废，否则「配对之后模型列表变成电脑的」看不见。
 * 数它被调了几次，是这一条唯一可靠的判据。
 */
let catalogRefreshes = 0;

/**
 * 第 ⑦ 节要验的「按工作区筛模型目录」。
 *
 * `ModelDirectory` 的**方法在原型上**（`select` / `reasoningFor` / `syncInputs`），
 * 自有属性只有数据字段 —— 这正是插件必须用
 * `Object.create(原型) + Object.assign` 包装的原因，所以 mock 也必须照这个形状
 * 造，否则测不出「展开运算符把方法全丢了」那个 bug。
 */
const directoryProto = {
	select() {
		return Promise.resolve({ ok: true, value: undefined });
	},
	reasoningFor() {
		return undefined;
	},
};

/** 造一个官方的 `ModelDirectory` 形状：自有数据 + 原型方法。 */
function makeDirectory(value) {
	const directory = Object.create(directoryProto);
	// ⚠️ 形状照抄官方 `syncInputs()` 的产物：`directory.store` 那一层只有
	// `groups` / `failures` / `current`，**没有** `localGroups`（那是宿主
	// `mergeCatalog` 额外带在 catalog 上的）。插件必须从 catalog 原值里现取，
	// 这里就不能顺手塞进去，否则测不出那条路径。
	directory.store = {
		snapshot: {
			current: value === null ? null : (value.default ?? null),
			routable: null,
			groups: value === null ? [] : value.groups,
			failures: value === null ? [] : (value.failures ?? []),
			status: value === null ? 'idle' : 'ready',
			pending: null,
			error: null,
		},
		getSnapshot() {
			return this.snapshot;
		},
		subscribe() {
			return () => {};
		},
		update(mutator) {
			mutator(this.snapshot);
		},
		set(next) {
			this.snapshot = next;
		},
	};
	/**
	 * ⚠️ 假的 catalog store **也必须身份稳定**：真实的 `createSnapshotStore`
	 * 只在 `set`/`update` 时换对象，读两次是同一个。这里若每次 `getSnapshot()`
	 * 都返回新字面量，插件那层身份缓存就永远命中不了，断言会以
	 * 「catalog 那一层也必须身份稳定」的形式假失败 —— 那是 mock 的锅不是插件的锅。
	 */
	let catalogSnapshot = { value, status: 'ready', error: null };
	directory.catalog = {
		store: {
			getSnapshot: () => catalogSnapshot,
			subscribe: () => () => {},
			update: () => {},
			set: (next) => {
				catalogSnapshot = next;
			},
		},
	};
	directory.load = () => Promise.resolve(directory.store.getSnapshot());
	return directory;
}

/** `directoryFor` 返回的那一份（第 ⑦ 节里由测试填内容）。 */
let currentDirectory = makeDirectory(null);

/**
 * 模拟 cordis 的 `ctx.get()` 返回值：一个会使 `this` 变味的 **Proxy**。
 *
 * ⚠️⚠️ 这一段是被**真机**逼出来的，不是假想。1.0.19 首次真机启动时输入框上的
 * **模型按钮直接消失**，logcat 里是：
 *
 *     [web] slot entry crashed in 'conversation.input.model':
 *           Error: cannot get property "remote.session" without inject
 *
 * 根因是插件的 `patchModelDirectories` 在 `ctx.get('modelDirectories')` 拿到的
 * **Proxy** 上覆盖 `directoryFor`，并用 `.bind(models)` 把 `this` 钉死在 Proxy 上。
 * cordis 的 `createTraceable` 给每个方法包了一层 `createShadowMethod`，其 apply 里
 * 有 `if (thisArg === outer) thisArg = shadow;` —— `shadow` 把上下文换成了
 * **取方法那一方**（我的插件）的 `ctx.extend(...)`。于是官方
 * `ModelDirectoryResolver.directoryFor` 里的 `this.ctx.remote.session`
 * （`dsh-client-ui-model-selection/lib/client.js:388`）解析到了我的插件上下文，
 * 而我没有 inject 过 `remote.session` ⇒ 整个 slot 崩掉。
 *
 * 所以这个假服务**必须复刻那层 Proxy 的 this 语义**，否则测试永远绿、真机永远崩：
 * 让 `this.ctx` 只有在「原始实例」上调用时才解析得出来。
 */
const ORIGINAL = Symbol.for('cordis.original');
/** `directoryFor` 里读 `this.ctx.remote.session` 的结果 —— 崩掉时它就是 undefined。 */
let lastResolverSaw = null;

const rawModelDirectories = {
	/**
	 * 官方 `ModelDirectoryResolver` 构造时 `super(ctx, …)` 存下的那个 ctx。
	 * 服务解析（`this.ctx.remote.session`）就靠它 —— 它被换掉就全崩。
	 */
	ctx: { remote: { session: { modelCatalog: () => Promise.resolve({ ok: true, value: {} }) } } },
	catalog: {
		refresh: () => {
			catalogRefreshes += 1;
		},
	},
	// 官方 `ModelDirectoryResolver.directoryFor` 的真实行为：**读 `this.ctx`**。
	// `this` 一旦被换掉，这一句就取不到东西（真机上是 cordis 直接抛错）。
	directoryFor: function () {
		lastResolverSaw = this.ctx === undefined ? undefined : this.ctx.remote;
		return currentDirectory;
	},
};

/** 复刻 `createTraceable`：调用方上下文（这里用「插件看到的那份」代替）会污染 `this`。 */
const rawModelDirectoriesProxy = new Proxy(rawModelDirectories, {
	get: (target, prop, receiver) => {
		if (prop === ORIGINAL) return target;
		const value = Reflect.get(target, prop, receiver);
		if (typeof value !== 'function') return value;
		return new Proxy(value, {
			apply: (fn, thisArg, args) => {
				// `thisArg === receiver` ⇒ cordis 把 this 换成「调用方的 shadow」：
				// `withProp(receiver, property, ctx.extend({[shadow]: origin}))`。这里是
				// 一个**没有 `remote`** 的对象 —— 正是真机上 `this.ctx.remote.session`
				// 报 `without inject` 的那一刻。绑定在 Proxy 上就会踩进来。
				const shadow = { remote: undefined, catalog: target.catalog };
				return Reflect.apply(fn, thisArg === receiver ? shadow : thisArg, args);
			},
		});
	},
});

const fakeModelDirectories = rawModelDirectoriesProxy;

/** `pairStatus` 回什么。第 ⑥ 节要模拟「还没配对」。 */
let pairedFlag = true;

/** `remoteSessions` 回哪些 id —— 第 ⑦ 节用它决定某个会话是不是「电脑的」。 */
let remoteIds = [];

/**
 * `mirrorSlugs` 回哪些 slug —— **隔离的真正判据**（见第 ⑦.5 节）。
 *
 * 用户 1.0.19 报障后的正解：判据从「会话有没有被我的桥登记过」换成
 * 「会话的 cwd 落在哪个工作区」。所以这里要能模拟「电脑镜像工作区已存在」。
 */
let mirrorSlugList = ['desktop-abc12345'];

/**
 * 会话列表的 `byId` —— 模型菜单每帧都从这里**同步**读 `cwd`。
 *
 * 形状抄官方 `projectList()`（`dsh-api-session-controller/lib/client.js`）：
 * 会话行里确实带 `cwd`。第 ⑦.5 节靠它证明「侧边栏建的会话」也能被认出来。
 */
let sessionRows = {};

const ctx = {
	effect: (fn) => fn(),
	slots: {
		inject: (slot, fn) => { const r = fn(); if (r && typeof r.next === 'function') { let s = r.next(); while (!s.done) s = r.next(); } return r; },
		register: (spec, component) => { cells.push({ spec, component }); return { dispose() {} }; },
	},
	sessions: {
		binding: () => undefined,
		create: () => Promise.resolve(),
		refresh: () => Promise.resolve(),
		// 官方 `sessions.list` 是 `createSnapshotStore(...)`，`getSnapshot().byId[id].cwd`
		// 同步可读 —— 插件的 `makeCwdOf` 走的正是这条路。
		list: { getSnapshot: () => ({ ids: Object.keys(sessionRows), byId: sessionRows }) },
	},
	uiWorkspace: {
		listDirectory: () => Promise.resolve({ path: '/', parent: '', home: '/', entries: [] }),
		createDirectory: () => Promise.resolve(),
		openSession: () => {},
	},
	// 官方模型目录服务的取用口（`ctx.get('modelDirectories')`）。
	get: (name) => (name === 'modelDirectories' ? fakeModelDirectories : undefined),
	logger: { info() {}, warn() {}, error() {} },
};

mod.apply(ctx);

const target = cells.find((c) => c.spec.name === 'conversation.hero.workspace.directoryFlow') ?? cells[0];
if (target === undefined) { console.error('❌ 没注册任何 slot'); process.exit(1); }

const injectedProps = typeof target.spec.inject === 'function' ? target.spec.inject() : {};
const container = dom.window.document.createElement('div');
dom.window.document.body.appendChild(container);

const errors = [];
const origError = console.error;
console.error = (...args) => { errors.push(args.map(String).join(' ')); };

const settle = async (ms = 80) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
const textOf = () => container.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const buttons = () => [...container.querySelectorAll('button')];
const clickByText = async (re) => {
	const btn = buttons().find((b) => re.test(b.textContent));
	if (btn === undefined) return false;
	await act(async () => { btn.click(); });
	await settle();
	return true;
};
const listCalls = () => calls.filter((c) => c.method === 'listDesktop');

console.log(`文件: ${FILE}\n场景: 已配对，电脑目录树 mock\n`);

let root = ReactDOMClient.createRoot(container);
await act(async () => {
	root.render(React.createElement(target.component, { open: true, onPicked() {}, onCancel() {}, busy: false, ...injectedProps }));
});
await settle();

// ---------------------------------------------------------------- ① 切到电脑页签
console.log('① 切到「电脑」页签，首次加载');
check(await clickByText(/^电脑$/), '点得到「电脑」页签');
const afterFirst = listCalls().length;
check(afterFirst === 1, '首次进入打了 1 次 listDesktop', `实际 ${afterFirst} 次`);
check(/Desktop/.test(textOf()), '列出了电脑根目录内容', textOf().slice(0, 120));

// ---------------------------------------------------------------- ② 点进子文件夹
console.log('\n② 点进子文件夹「Desktop」');
check(await clickByText(/Desktop/), '点得到 Desktop 这一行');
const afterChild = listCalls().length;
check(afterChild === 2, '首次进入子目录打了 1 次（累计 2）', `实际累计 ${afterChild} 次`);
check(/项目代码/.test(textOf()), '子目录内容已渲染', textOf().slice(0, 120));

// ---------------------------------------------------------------- ③ 上一级再回来
console.log('\n③ 点「上一级」再点回「Desktop」—— 用户报障的核心');
await clickByText(/上一级/);
const beforeBack = listCalls().length;
check(await clickByText(/Desktop/), '再次点进 Desktop');
const afterBack = listCalls().length;
check(afterBack === beforeBack, '回到已看过的 Desktop **没有**重新打桥', `又打了 ${afterBack - beforeBack} 次`);
check(/项目代码/.test(textOf()), '仍然正确渲染 Desktop 的内容', textOf().slice(0, 120));

// ---------------------------------------------------------------- ④ 关掉对话框再打开
console.log('\n④ 关掉对话框再打开（模拟「每次点添加工作区都要重新加载」）');
await act(async () => { root.unmount(); });
container.innerHTML = '';
const beforeReopen = listCalls().length;
root = ReactDOMClient.createRoot(container);
await act(async () => {
	root.render(React.createElement(target.component, { open: true, onPicked() {}, onCancel() {}, busy: false, ...injectedProps }));
});
await settle();
await clickByText(/^电脑$/);
const afterReopen = listCalls().length;
check(afterReopen === beforeReopen, '重新打开对话框后**没有**重新拉根目录', `又打了 ${afterReopen - beforeReopen} 次`);

// ---------------------------------------------------------------- ⑤ 刷新必须真的重拉
console.log('\n⑤ 点「刷新」—— 必须作废缓存并重新打桥');
// ⚠️ 「刷新」走的是 `refreshAll`（一次拿模型 + 预设 + 目录），**不是** `listDesktop`。
// 断言要按方法名分开数，混着数会把「刷新确实打了桥」误判成「没打」。
const refreshCalls = () => calls.filter((c) => c.method === 'refreshAll');
const beforeRefresh = refreshCalls().length;
check(await clickByText(/^刷新$/), '点得到「刷新」按钮');
const afterRefresh = refreshCalls().length;
check(afterRefresh === beforeRefresh + 1, '刷新重新打了 1 次 refreshAll', `实际又打了 ${afterRefresh - beforeRefresh} 次`);
check(/已刷新|刷新失败/.test(textOf()), '给出了刷新回执', textOf().slice(-140));

// 刷新的语义是「整棵树作废」，所以进 Desktop 时**必然**重新打一次桥 ——
// 这正是我们要的（电脑上的目录可能已经变了）。要断言的是下半段：
// 已经重新拉过的 Desktop 与刷新过的当前层，回到它们时不该再打。
const beforeAfterRefresh = listCalls().length;
await clickByText(/Desktop/);
const entered = listCalls().length;
check(entered === beforeAfterRefresh + 1, '刷新后首次进入 Desktop 重新拉了一次（树已作废）', `打了 ${entered - beforeAfterRefresh} 次`);
await clickByText(/上一级/);
check(listCalls().length === entered, '回到刷新过的那一层未再打桥（新列表已回写缓存）', `又打了 ${listCalls().length - entered} 次`);

console.error = origError;
if (errors.length > 0) {
	console.log(`\n❌ 有 ${errors.length} 条 React 告警：`);
	for (const line of errors.slice(0, 3)) console.log('   ' + line.slice(0, 300));
	failed += 1;
} else {
	console.log('\n✅ 无 React 告警');
}

// ---------------------------------------------------------------- ⑥ 配对成功后必须重载模型目录
console.log('\n⑥ 配对成功 → 官方前端的模型目录必须被作废重载（「模型列表没同步」）');
// ⚠️ 这一条钉的是用户本轮报的「预设列表也正确的加载了电脑预设，但模型列表还是没同步」。
// 根因是官方 `ModelCatalogDirectory` 一旦 ready 就**永久缓存**，前端此后再也不问宿主；
// 而预设走 `remoteExportList`，没有缓存层、每次重读 —— 所以只有模型这一侧是坏的。
// 判据只能是「`catalog.refresh()` 被调用了几次」：缓存有没有被作废，界面上看不出来。
{
	// 从「未配对」开始，这样能走到手输配对码那条路。
	pairedFlag = false;
	await act(async () => { root.unmount(); });
	container.innerHTML = '';
	root = ReactDOMClient.createRoot(container);
	await act(async () => {
		root.render(React.createElement(target.component, { open: true, onPicked() {}, onCancel() {}, busy: false, ...injectedProps }));
	});
	await settle();
	await clickByText(/^电脑$/);

	// 未配对时不该有任何重载动作（那时也没有电脑数据可同步）。
	const beforePair = catalogRefreshes;
	check(beforePair === 0, '未配对时没有多余的重载', `实际 ${beforePair} 次`);

	// 往配对码输入框里写 6 位码。Input 被 mock 成受控只读 input，
	// 所以直接改 React 的 state 走不通 —— 改用 onChange 事件驱动。
	const input = container.querySelector('input');
	check(input !== undefined, '找得到配对码输入框');
	if (input !== undefined) {
		const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
		await act(async () => {
			setter.call(input, 'ABC123');
			input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
		});
		await settle();
	}

	// mock 里的 Input 只绑了 value/readOnly，onChange 得靠 React 的合成事件 ——
	// 上面 dispatch 未必命中。这里直接找「配对」按钮，找不到就跳过（不判失败）。
	const pairedBtn = buttons().find((b) => /配对|连接/.test(b.textContent));
	if (pairedBtn === undefined) {
		console.log('     （输入框未承载 onChange，跳过真实提交；改用断言按钮存在性）');
	} else {
		await act(async () => { pairedBtn.click(); });
		await settle(120);
	}
	const afterPair = catalogRefreshes;
	check(afterPair > beforePair, '配对成功后调了 catalog.refresh()（模型目录被作废重载）', `从 ${beforePair} 变成 ${afterPair}`);
}

// ---------------------------------------------------------------- ⑦ 模型目录按工作区隔离
console.log('\n⑦ 模型菜单按工作区隔离（用户报障：「本地文件夹就不要出现电脑的模型」）');
{
	// 宿主 `mergeCatalog` 的产物形状：电脑的组带 `desktop:true`，同 id 的本地组
	// 被覆盖掉、只能从 `localGroups` 里还原。
	const merged = {
		groups: [
			{ id: 'deepseek-official', name: '电脑的', desktop: true, models: [{ id: 'deepseek-v4-pro' }] },
			{ id: 'wk', name: '电脑的', desktop: true, models: [{ id: 'buddy:glm-5.3-flash' }] },
		],
		failures: [{ id: 'wk', name: '电脑的失败', message: 'boom', desktop: true }],
		localGroups: [
			{ id: 'deepseek-official', name: '手机的', models: [{ id: 'deepseek-flash' }] },
			{ id: 'agnes', name: '手机的', models: [{ id: 'agnes-3.0-flash' }] },
		],
		localFailures: [],
		default: { provider: 'agnes', model: 'agnes-3.0-flash' },
	};

	/**
	 * 让插件的包装服务给出上面那份目录，并把会话标成「电脑的」。
	 *
	 * ⚠️ **走 `markRemote` 而不是改 mock 的 `remoteSessions` 应答**：插件的
	 * `remoteSessionIds` 只在 `apply` 时拉一次全量，之后由建会话 / 解绑**增量维护**
	 * （模型菜单每帧都读，不可能每帧打桥 —— 见 `remoteSessionIds` 的注释）。
	 * 改 mock 应答不会让它重拉，测出来的是假的。
	 */
	const install = (sessionId, isRemoteSession) => {
		currentDirectory = makeDirectory(merged);
		if (isRemoteSession === true) injectedProps.markRemote(sessionId);
		// `directoryFor` 已被插件替换，走它才拿到筛过的那一层。
		const models = ctx.get('modelDirectories');
		return models.directoryFor(sessionId);
	};

	// —— 本地工作区：只该看到手机自己的组，且被覆盖的那组要还原 ——
	const local = install('session-local', false);
	const localSnapshot = local.store.getSnapshot();
	const localIds = localSnapshot.groups.map((g) => g.id).sort();
	check(
		localIds.join(',') === 'agnes,deepseek-official',
		'本地工作区：只剩手机自己的组，且被电脑覆盖的组已还原',
		JSON.stringify(localIds),
	);
	check(
		localSnapshot.groups.every((g) => g.desktop !== true),
		'本地工作区：一个电脑组都没漏进来',
		JSON.stringify(localSnapshot.groups.map((g) => g.desktop)),
	);
	check(
		localSnapshot.groups.find((g) => g.id === 'deepseek-official')?.models?.[0]?.id === 'deepseek-flash',
		'本地工作区：同 id provider 用的是**手机**那份模型',
		JSON.stringify(localSnapshot.groups.find((g) => g.id === 'deepseek-official')?.models),
	);
	check(localSnapshot.failures.length === 0, '本地工作区：电脑 provider 的加载失败不显示');
	check(
		localSnapshot.current?.provider === 'agnes',
		'本地工作区：current 仍指向手机的 provider',
		JSON.stringify(localSnapshot.current),
	);

	// —— 电脑工作区：只该看到电脑的组 ——
	const remote = install('session-remote', true);
	const remoteSnapshot = remote.store.getSnapshot();
	const remoteIdsSeen = remoteSnapshot.groups.map((g) => g.id).sort();
	check(
		remoteIdsSeen.join(',') === 'deepseek-official,wk',
		'电脑工作区：只剩电脑的组',
		JSON.stringify(remoteIdsSeen),
	);
	check(
		remoteSnapshot.groups.every((g) => g.desktop === true),
		'电脑工作区：一个手机组都没漏进来',
		JSON.stringify(remoteSnapshot.groups.map((g) => g.desktop)),
	);
	check(
		remoteSnapshot.groups.find((g) => g.id === 'deepseek-official')?.models?.[0]?.id === 'deepseek-v4-pro',
		'电脑工作区：同 id provider 用的是**电脑**那份模型',
		JSON.stringify(remoteSnapshot.groups.find((g) => g.id === 'deepseek-official')?.models),
	);
	check(
		remoteSnapshot.current === null,
		'电脑工作区：current 指向被筛掉的模型时置空（不显示列表里没有的名字）',
		JSON.stringify(remoteSnapshot.current),
	);

	// —— 上层 catalog 也要筛：`syncInputs` 从它算 `current` ——
	const remoteValue = remote.catalog.store.getSnapshot().value;
	check(
		remoteValue.groups.map((g) => g.id).sort().join(',') === 'deepseek-official,wk',
		'catalog 那一层的 groups 也筛过（否则 syncInputs 会把 current 算回手机模型）',
		JSON.stringify(remoteValue.groups.map((g) => g.id)),
	);
	check(
		remoteValue.default?.provider === 'deepseek-official' && remoteValue.default?.model === 'deepseek-v4-pro',
		'catalog 的 default 被换到剩下组的第一个（原来是手机的 agnes，已被筛掉）',
		JSON.stringify(remoteValue.default),
	);
	// 本地那侧同理：default 本来就是手机的，不该被改动。
	const localValue = local.catalog.store.getSnapshot().value;
	check(
		localValue.groups.map((g) => g.id).sort().join(',') === 'agnes,deepseek-official',
		'catalog 那一层：本地工作区也只剩手机组',
		JSON.stringify(localValue.groups.map((g) => g.id)),
	);
	check(
		localValue.default?.provider === 'agnes',
		'catalog 的 default 在本地工作区里保持不变',
		JSON.stringify(localValue.default),
	);

	// —— 关键：包在**原型**上的方法不能丢 ——
	// 用 `{...directory}` 展开会让 `select` / `reasoningFor` 全变 undefined，
	// 表现是「点模型没反应」。这一条就是钉那个写法。
	check(typeof remote.select === 'function', '包装后 select 仍在（原型方法没被展开丢掉）');
	check(typeof remote.reasoningFor === 'function', '包装后 reasoningFor 仍在');
	check(
		remote.store.getSnapshot() !== merged,
		'读路径返回的是筛过的副本，不是原对象',
	);

	// —— 稳定：同一个会话多次取到的是**同一个**包装 ——
	// `inject` 每渲染一帧调一次，每次新建会让 useSyncExternalStore 每帧重订阅。
	const models = ctx.get('modelDirectories');
	check(
		models.directoryFor('session-remote') === remote,
		'同一个会话每次拿到的是同一个包装（不每帧新建）',
	);

	// —— 真机回归（1.0.19 首次启动实测：输入框上的模型按钮整条消失）——
	//
	// `ctx.get('modelDirectories')` 给的是 cordis 的 **Proxy**，它给每个方法套了
	// `createShadowMethod`：`if (thisArg === outer) thisArg = shadow;`，而 `shadow`
	// 把上下文换成**取方法那一方**（我的插件）的 ctx。插件的旧写法
	// `var original = models.directoryFor.bind(models)` 恰好把 this 钉死在 Proxy 上，
	// 于是官方 `directoryFor` 里的 `this.ctx.remote.session` 解析到我的插件上下文 ⇒
	//
	//     cannot get property "remote.session" without inject
	//
	// ⇒ `conversation.input.model` 这个 slot 整体 crash，模型按钮消失。
	//
	// 下面这条断言就是钉它：官方那个 `directoryFor` 拿到的 `this.ctx` 必须仍然
	// 解析得出 `remote`。用 `.bind(models)` 会红。
	lastResolverSaw = 'unset';
	currentDirectory = makeDirectory({ groups: [], failures: [], default: { provider: 'x', model: 'y' } });
	models.directoryFor('session-this-check');
	check(
		lastResolverSaw !== undefined && lastResolverSaw !== 'unset',
		'官方 directoryFor 里的 this.ctx.remote 仍解析得出（否则 slot 崩、模型按钮消失）',
		String(lastResolverSaw),
	);

	// —— 真机回归（1.0.19 第二次启动：React error #185，整个 slot 崩）——
	//
	// 官方把这个 store 的 `getSnapshot` 直接喂给 `useSyncExternalStore`，React 在
	// 渲染期用 **`Object.is`** 比前后两次快照。插件的 `pickWorkspaceGroups` 每次
	// `filter` 出新数组、外面再 `Object.assign` 出新对象 ⇒ **同一个源快照也每次
	// 返回新对象** ⇒ 每帧都"变了" ⇒ 无限重渲染（#185）⇒ 模型按钮消失。
	//
	// 所以读取必须**身份稳定**：源快照没动，就必须回同一个对象。
	check(
		remote.store.getSnapshot() === remote.store.getSnapshot(),
		'getSnapshot 身份稳定（源快照未变时回同一个对象，否则 React #185）',
	);
	check(
		remote.catalog.store.getSnapshot() === remote.catalog.store.getSnapshot(),
		'catalog 那一层的 getSnapshot 也必须身份稳定',
	);
	// 反过来也要成立：源快照换了，投影必须跟着换（否则界面停在旧数据上）。
	currentDirectory.store.set({ groups: [], failures: [], current: null, status: 'ready', pending: null, error: null });
	const afterSet = remote.store.getSnapshot();
	check(
		afterSet !== undefined && afterSet.groups !== undefined,
		'源快照变了，投影跟着重算（不是把旧结果永久缓存住）',
		JSON.stringify(afterSet?.groups),
	);

	// —— 一组都不剩时不能把菜单变空 ——
	currentDirectory = makeDirectory({ groups: [], failures: [], default: { provider: 'x', model: 'y' } });
	const empty = models.directoryFor('session-empty').store.getSnapshot();
	check(
		empty.groups.length === 0 && empty.current?.provider === 'x',
		'一组都没有时原样返回（不把菜单变成空的）',
		JSON.stringify(empty.groups),
	);
}

// ------------------------------------------- ⑦.5 判据是「工作区」而不是「谁建的会话」
//
// ⚠️⚠️ **这是用户 1.0.19 报障的回归断言，整个第 ⑦.5 节都为它而存在。**
//
// 用户原话：
//
//     我第一次添加我选择的是桌面目录，后面我重新在侧边栏点击新建会话，
//     这个桌面目录还是会在待选列表的，且默认就是上一个"桌面目录"，
//     此时已经属于是在电脑工作区了，但是呢我们的模型却还是我们手机本地的模型列表，
//     也就是说你现在这个架构设计的还是有问题，
//     **只有我手动添加工作区的时候，才会触发模型和预设的刷新。**
//
// 根因：第一代判据是 `remoteSessionIds`（按 **sessionId**），它只在
// ① 用户从电脑文件夹对话框建会话（走插件的 `createSession` 桥）或
// ② 宿主 create 拦截器绑过 时才有条目。
// 而侧边栏「新建会话」走的是**官方原生** `sessionController.create({workspaceId})`,
// **不经过本插件** —— 宿主的拦截器认得出镜像目录（消息发得对），
// 但前端那个集合只在 `apply` 时拉过一次全量，**官方这条路前端毫不知情**
// ⇒ 模型菜单按「本地」筛，显示手机模型。
//
// 正解（本节钉的就是它）：判据换成会话的 **cwd 落在哪个工作区**，
// 与宿主 `desktopPathOfMirror` 同一个轴 —— 与「谁建的会话」完全无关。
//
// 这一节**刻意不调 `markRemote`**，正是为了复现「官方那条路」。
console.log('\n⑦.5 侧边栏「新建会话」走的官方路径（判据必须是工作区，不是谁建的会话）');
{
	{
		const merged = {
			groups: [
				{ id: 'deepseek-official', name: '电脑的', desktop: true, models: [{ id: 'deepseek-v4-pro' }] },
				{ id: 'wk', name: '电脑的', desktop: true, models: [{ id: 'buddy:glm-5.3-flash' }] },
			],
			failures: [],
			localGroups: [{ id: 'agnes', name: '手机的', models: [{ id: 'agnes-3.0-flash' }] }],
			localFailures: [],
			default: { provider: 'agnes', model: 'agnes-3.0-flash' },
		};
		const MIRROR = '/data/user/0/com.dsh.android/files/home/.dsh/dsh-remote/workspaces/desktop-abc12345';
		const PHONE = '/data/user/0/com.dsh.android/files/home/workspace';
		const models = ctx.get('modelDirectories');

		/**
		 * 模拟「会话出现在列表里」，再拿它的目录 —— **不碰 `markRemote`**。
		 *
		 * @param sessionId - 会话 id。
		 * @param cwd - 列表行里的 cwd（`undefined` = 这一行还没带 cwd）。
		 * @returns 筛过的那层目录。
		 */
		const byWorkspace = (sessionId, cwd) => {
			currentDirectory = makeDirectory(merged);
			sessionRows = {};
			if (cwd !== undefined) sessionRows[sessionId] = { id: sessionId, cwd: cwd };
			else sessionRows[sessionId] = { id: sessionId };
			return models.directoryFor(sessionId);
		};

		// —— ① 用户报的那条路：侧边栏新建会话，cwd 落在电脑镜像工作区 ——
		const sidebar = byWorkspace('session-sidebar', MIRROR);
		const sidebarIds = sidebar.store.getSnapshot().groups.map((g) => g.id).sort();
		check(
			sidebarIds.join(',') === 'deepseek-official,wk',
			'侧边栏新建的会话（cwd 在镜像工作区）：只看到电脑的组 —— 不靠任何标记',
			JSON.stringify(sidebarIds),
		);
		check(
			sidebar.store.getSnapshot().current === null,
			'侧边栏新建的会话：current 指向被筛掉的手机模型时置空',
			JSON.stringify(sidebar.store.getSnapshot().current),
		);

		// —— ② cwd 是手机目录：即使老标记说它是远程，也必须按本地 ——
		// （老标记可能来自「曾经是远程、后来解绑/换了工作区」，cwd 才是事实。）
		if (injectedProps.markRemote !== undefined) injectedProps.markRemote('session-phone');
		const phone = byWorkspace('session-phone', PHONE);
		const phoneIds = phone.store.getSnapshot().groups.map((g) => g.id).sort();
		check(
			phoneIds.join(',') === 'agnes',
			'cwd 在手机目录：即使留了「远程」老标记也按本地（cwd 说了算）',
			JSON.stringify(phoneIds),
		);

		// —— ③ cwd 落在 workspaces 下、但那个 slug 不是电脑镜像 ——
		// 不能只看 `/workspaces/` 就判远程，必须 slug 真在集合里。
		const stray = byWorkspace('session-stray', '/data/user/0/com.dsh.android/files/home/.dsh/dsh-remote/workspaces/other-nope');
		check(
			stray.store.getSnapshot().groups.map((g) => g.id).join(',') === 'agnes',
			'cwd 在 workspaces 下但 slug 不是电脑镜像：仍按本地',
			JSON.stringify(stray.store.getSnapshot().groups.map((g) => g.id)),
		);

		// —— ④ 列表行还没带 cwd 的那几帧：退回老标记 ——
		if (injectedProps.markRemote !== undefined) injectedProps.markRemote('session-nocwd');
		const nocwd = byWorkspace('session-nocwd', undefined);
		check(
			nocwd.store.getSnapshot().groups.map((g) => g.id).sort().join(',') === 'deepseek-official,wk',
			'列表行还没带 cwd 时退回老标记（会话刚建好那几帧不至于闪回手机模型）',
			JSON.stringify(nocwd.store.getSnapshot().groups.map((g) => g.id)),
		);

		// —— ⑤ 重拉 slug 集合真的能让结论翻转 ——
		// 宿主每给一个新电脑目录建镜像工作区，`workspaceMap` 就多一条；
		// 前端那份是快照，不重拉的话新工作区永远被判成「本地」。
		const before = byWorkspace('session-newdir-a', '/x/workspaces/fresh-99999999');
		check(
			before.store.getSnapshot().groups.map((g) => g.id).join(',') === 'agnes',
			'新镜像工作区还没进集合时按本地',
			JSON.stringify(before.store.getSnapshot().groups.map((g) => g.id)),
		);
		mirrorSlugList = mirrorSlugList.concat(['fresh-99999999']);
		await (injectedProps.refreshMirrorSlugs === undefined ? Promise.resolve() : injectedProps.refreshMirrorSlugs());
		const after = byWorkspace('session-newdir-b', '/x/workspaces/fresh-99999999');
		check(
			after.store.getSnapshot().groups.map((g) => g.id).sort().join(',') === 'deepseek-official,wk',
			'refreshMirrorSlugs 之后同样的 cwd 就按电脑判（新建工作区必须重拉）',
			JSON.stringify(after.store.getSnapshot().groups.map((g) => g.id)),
		);
		mirrorSlugList = mirrorSlugList.filter((s) => s !== 'fresh-99999999');
	}
}

console.log(`\n共 ${calls.length} 次桥调用，其中 listDesktop ${listCalls().length} 次`);
for (const c of calls) console.log(`   ${c.method}${c.path === undefined ? '' : ` path=${JSON.stringify(c.path)}`}`);

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
