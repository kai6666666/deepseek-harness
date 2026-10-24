/**
 * 用最小可用的 `__ModuleLoader__` 模拟宿主，加载桌面端 client 半边，
 * 检查它是否真的把自己注册进了 `settings.section`。
 *
 * 这能抓到三类真问题：
 * 1. 模块格式不对（不是 `__ModuleLoader__.load({id, factory})`）；
 * 2. `require` 了宿主模块表里没有的东西；
 * 3. 注册时用了不存在的 slot / 参数形状不对。
 */
import { readFileSync } from 'node:fs';
import { createElement } from 'react';

const FILE = process.argv[2];
if (!FILE) {
	console.error('用法: node load-client.mjs <client.js 路径>');
	process.exit(1);
}

const source = readFileSync(FILE, 'utf8');

/** 记录注册了什么。 */
const registered = [];
let loaded = null;

global.window = {
	__ModuleLoader__: {
		load(spec) {
			loaded = spec;
		},
	},
};

// 浏览器 API：Node 里没有，给个空壳让 apply() 能跑完。
global.EventSource = class {
	constructor() {
		this.readyState = 0;
	}
	addEventListener() {}
	close() {}
};
global.document = {
	querySelector: () => null,
	createElement: () => ({ dataset: {}, style: {}, appendChild() {}, set textContent(v) {} }),
	head: { appendChild() {} },
};

// 模拟宿主的模块表：只放真正存在的那几个。
const MODULES = {
	react: {
		createElement,
		useState: (v) => [v, () => {}],
		useEffect: () => {},
		useCallback: (fn) => fn,
		useRef: (v) => ({ current: v }),
	},
	'@deepseek-ai/dsh-client-ui-primitives': new Proxy(
		{},
		{
			get(_t, name) {
				// 官方每个原子组件都是可用的；返回一个占位组件即可。
				return (props) => createElement('div', null, props?.children ?? null);
			},
		},
	),
};

// 执行 client.js（它会调 window.__ModuleLoader__.load）。
// eslint-disable-next-line no-new-func
new Function('window', source)(global.window);

if (loaded === null) {
	console.error('❌ client.js 没有调用 window.__ModuleLoader__.load');
	process.exit(1);
}
console.log('✅ 模块格式正确');
console.log('   id =', loaded.id);
console.log('   factory 是函数:', typeof loaded.factory === 'function');

const mod = loaded.factory((name) => {
	if (!(name in MODULES)) throw new Error(`宿主模块表里没有 "${name}"`);
	return MODULES[name];
});

console.log('   exports 键:', Object.keys(mod));
console.log('   inject =', JSON.stringify(mod.inject));

if (typeof mod.apply !== 'function') {
	console.error('❌ 没有导出 apply');
	process.exit(1);
}

// 跑一次 apply，看它注册了什么。
const ctx = {
	effect: (fn) => fn(),
	slots: {
		inject(slot, fn) {
			console.log('   slots.inject ->', slot);
			const result = fn();
			// ⚠️ `inject` 的回调常常是 **generator**（官方就是靠 yield 拿 disposer）。
			// 不迭代它的话注册根本不会发生，测试会假报「没注册任何 slot」。
			if (result !== null && typeof result === 'object' && typeof result.next === 'function') {
				let step = result.next();
				while (step.done !== true) step = result.next();
			}
			return result;
		},
		register(spec, component) {
			registered.push(spec);
			return { dispose() {} };
		},
	},
	sessions: { binding: () => undefined },
	uiWorkspace: {},
	logger: { info() {}, warn() {} },
};

mod.apply(ctx);

if (registered.length === 0) {
	console.error('❌ apply() 没有注册任何 slot');
	process.exit(1);
}
for (const spec of registered) {
	console.log('✅ 注册:', JSON.stringify(spec), '组件类型:', typeof spec === 'object' ? 'ok' : '?');
}
