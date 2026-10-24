/**
 * 真浏览器环境渲染：用 jsdom + react-dom/client 把配对页**完整跑一遍**。
 *
 * ⚠️ 为什么不用 `renderToStaticMarkup`：它不跑 `useEffect`，页面会永远停在
 * 「正在读取配对状态…」—— 等于只验了 20% 的渲染路径。配对页的绝大部分
 * （二维码、6 位码、状态行）都在 `useEffect` 之后才出现。
 *
 * 这里 mock 掉 `fetch`，让它返回真实的接口响应形状，于是能看到**配对成功后的
 * 完整页面**，并据此确认 style 类型、二维码 SVG 注入都正常。
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const FILE = process.argv[2];
const SCENARIO = process.argv[3] ?? 'unpaired';
const source = readFileSync(FILE, 'utf8');

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
	url: 'http://127.0.0.1:19387/',
	pretendToBeVisual: true,
});

global.window = dom.window;
global.document = dom.window.document;
// ⚠️ Node 20+ 的 `globalThis.navigator` 只有 getter，直接赋值会抛
// `Cannot set property navigator`。用 defineProperty 覆盖。
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
global.EventSource = dom.window.EventSource ?? class { constructor() {} addEventListener() {} close() {} };
global.IS_REACT_ACT_ENVIRONMENT = true;

/** 按场景返回的接口响应。 */
const RESPONSES = {
	unpaired: {
		'/status': { ok: true, paired: false, activationCode: '', hostname: '', pairedAt: 0, cloudflared: '', download: { active: false, received: 0, total: 0, error: '' }, home: 'C:\\Users\\demo', platform: 'win32-x64' },
	},
	paired: {
		'/status': { ok: true, paired: true, activationCode: 'CA01AEF6', hostname: 'dsh-qlqojp0n.jiulingssh.xyz', pairedAt: 1792086681175, cloudflared: 'C:\\Users\\demo\\AppData\\Local\\cloudflared\\cloudflared.exe', download: { active: false, received: 0, total: 0, error: '' }, home: 'C:\\Users\\demo', platform: 'win32-x64' },
		'/handshake': { ok: true, pairCode: 'Q82S3F', expiresIn: 600, expiresAt: 0, svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29"><path d="M0 0h1v1h-1z"/></svg>', message: 'ok' },
	},
};

/** 手机端桥的响应（`/api/dsh-remote/rpc` 的 `{ok, result}` 包封）。 */
const BRIDGE = {
	unpaired: {
		pairStatus: { endpoint: 'https://dsh-remote.jiulingssh.xyz', paired: false },
		listDesktop: { path: 'C:\\', parent: '', home: 'C:\\Users\\demo', entries: [{ name: 'Users', path: 'C:\\Users', isDirectory: true }] },
	},
	paired: {
		pairStatus: { endpoint: 'https://dsh-qlqojp0n.jiulingssh.xyz', paired: true },
		listDesktop: { path: 'C:\\', parent: '', home: 'C:\\Users\\demo', entries: [{ name: 'Users', path: 'C:\\Users', isDirectory: true }] },
		pair: { endpoint: 'https://dsh-new.jiulingssh.xyz', tokenSet: true },
		// 解绑回执：清空凭据后退回未配对（endpoint 回到占位地址、paired=false）。
		unpair: { endpoint: 'https://dsh-remote.jiulingssh.xyz', paired: false },
	},
};

global.fetch = (url, init) => {
	const raw = String(url);
	// 手机端走宿主桥：`POST /api/dsh-remote/rpc`，body 里带 method。
	if (raw.endsWith('/api/dsh-remote/rpc')) {
		const method = JSON.parse(init?.body ?? '{}').method;
		const result = BRIDGE[SCENARIO]?.[method] ?? {};
		return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, result }) });
	}
	const path = raw.replace('/api/dsh-remote/pair', '');
	const body = RESPONSES[SCENARIO]?.[path] ?? { ok: false, message: `测试未覆盖 ${path}` };
	return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
};

// jsdom 没有的 API
dom.window.fetch = global.fetch;

let loaded = null;
dom.window.__ModuleLoader__ = { load: (spec) => { loaded = spec; } };

new Function('window', 'document', 'EventSource', source)(dom.window, dom.window.document, global.EventSource);
if (loaded === null) { console.error('❌ 没调用 load'); process.exit(1); }

const React = (await import('react')).default;
const ReactDOMClient = await import('react-dom/client');
// ⚠️ 用 `React.act`（`react-dom/test-utils` 里那个已弃用，会刷一条无关告警
// 把真正的告警淹掉）。
const act = React.act;

const passthrough = (tag) => (props) => React.createElement(tag, { style: props.style, className: props.className }, props.children);

const MODULES = {
	react: React,
	'@deepseek-ai/dsh-client-ui-primitives': new Proxy({}, {
		get(_t, name) {
			if (name === 'Modal') return (props) => React.createElement('div', { className: props.className, 'data-open': props.open }, props.children);
			if (name === 'Input') return (props) => React.createElement('input', { ...props, style: undefined, value: props.value ?? '', readOnly: true });
			if (name === 'Button') return (props) => React.createElement('button', { type: 'button', style: props.style, disabled: props.disabled, onClick: props.onClick }, props.children);
			if (name === 'Pill') return (props) => React.createElement('span', { className: props.active ? 'active' : '' }, props.children);
			// ⚠️ `SegmentedTabs` **必须真的渲染出可点的页签**：手机端的配对条
			// 只在「电脑」页签下才出现，把它当透明 div 的话，测试会「全绿」
			// 却完全没覆盖到配对这条路径。
			if (name === 'SegmentedTabs') {
				return (props) => React.createElement(
					'div',
					{ role: 'tablist' },
					(props.items ?? []).map((item) => React.createElement(
						'button',
						{
							key: item.value,
							type: 'button',
							role: 'tab',
							'aria-selected': item.value === props.value,
							onClick: () => props.onChange?.(item.value),
						},
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
const ctx = {
	effect: (fn) => fn(),
	slots: {
		inject: (slot, fn) => { const r = fn(); if (r && typeof r.next === 'function') { let s = r.next(); while (!s.done) s = r.next(); } return r; },
		register: (spec, component) => { cells.push({ spec, component }); return { dispose() {} }; },
	},
	sessions: { binding: () => undefined, create: () => Promise.resolve(), refresh: () => Promise.resolve() },
	// 手机端从 `ctx.uiWorkspace` 取浏览能力，并把它们以 `inject` 的形式
	// 传给组件（见 client.js 的 `injected()`）。
	uiWorkspace: {
		listDirectory: () => Promise.resolve({ path: '/', parent: '', home: '/', entries: [{ name: 'sdcard', path: '/sdcard', isDirectory: true }] }),
		createDirectory: () => Promise.resolve(),
		openSession: () => {},
	},
	logger: { info() {}, warn() {}, error() {} },
};

mod.apply(ctx);
console.log(`场景=${SCENARIO}，注册到 ${cells.length} 个 slot`);

let failed = 0;
for (const { spec, component } of cells) {
	const label = spec.name + (spec.id ? '/' + spec.id : '');
	const container = dom.window.document.createElement('div');
	dom.window.document.body.appendChild(container);

	// ⚠️ 手机端把浏览能力以 `inject: () => ({...})` 的形式挂在注册项上，
	// 由 slot 系统调一次、把结果**合并进组件的 props**。测试里必须照做，
	// 否则组件拿到 `undefined` 直接抛错 —— 那是测试的假故障，不是真 bug。
	const injectedProps = typeof spec.inject === 'function' ? spec.inject() : {};

	const errors = [];
	const origError = console.error;
	console.error = (...args) => { errors.push(args.map(String).join(' ')); };

	try {
		const root = ReactDOMClient.createRoot(container);
		const baseProps = spec.name === 'settings.section'
			? {}
			: { open: true, onPicked() {}, onCancel() {}, busy: false };
		await act(async () => { root.render(React.createElement(component, { ...baseProps, ...injectedProps })); });
		await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
		console.error = origError;

		const html = container.innerHTML;
		console.log(`\n--- ${label} (${html.length} 字符) ---`);
		// 把标签去掉，只看人眼会读到的文字。
		const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
		console.log('文字:', text.slice(0, 500));

		if (html.includes('[object Object]')) { console.log('❌ HTML 里出现 [object Object]（style 类型错）'); failed += 1; }
		if (errors.length > 0) { console.log('❌ React 告警/报错:', errors.slice(0, 3).join(' | ').slice(0, 400)); failed += 1; }
		else console.log('✅ 无 React 告警');

		// ---- 点一遍所有按钮，抓交互期才暴露的错误 ----
		const buttons = [...container.querySelectorAll('button')];
		for (const btn of buttons) {
			const label2 = (btn.textContent || '').trim();
			if (label2 === '') continue;
			const before = errors.length;
			try {
				await act(async () => { btn.click(); });
				await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
				const after = container.innerHTML;
				const txt = after.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
				const newErrors = errors.slice(before);
				console.log(`   [点击「${label2}」] ${after.length} 字符，告警 ${newErrors.length} 条`);
				// 页签/配对这类关键点击，把点完之后的文字打出来 ——
				// 否则「没有报错」并不能说明「界面真的变了」。
				if (label2 === '电脑' || label2 === '配对' || label2 === '手机') {
					console.log(`      → 文字: ${txt.slice(0, 300)}`);
				}
				if (label2 === '电脑') {
					// 两种场景的期望正好相反：未配对要看到配对入口且新建禁用，
					// 已配对要看到电脑目录且新建可点。断言必须按场景分叉。
					if (SCENARIO === 'unpaired') {
						if (!/配对码/.test(txt)) { console.log('   ❌ 未配对时切到「电脑」没看到配对码输入框'); failed += 1; }
						const createBtn = [...container.querySelectorAll('button')].find((b) => /在此新建对话/.test(b.textContent));
						if (createBtn !== undefined && createBtn.disabled !== true) {
							console.log('   ❌ 未配对时「在此新建对话」应当禁用');
							failed += 1;
						} else if (createBtn !== undefined) {
							console.log('   ✅ 未配对时「在此新建对话」已禁用');
						}
					} else {
						if (/配对码/.test(txt)) { console.log('   ❌ 已配对时不该再显示配对码输入框'); failed += 1; }
						if (!/已配对/.test(txt)) { console.log('   ❌ 已配对时没显示已配对状态'); failed += 1; }
						if (!/Users/.test(txt)) { console.log('   ❌ 已配对时没列出电脑目录'); failed += 1; }
						else console.log('   ✅ 已配对时列出了电脑目录');
						const createBtn = [...container.querySelectorAll('button')].find((b) => /在此新建对话/.test(b.textContent));
						if (createBtn !== undefined && createBtn.disabled === true) {
							console.log('   ❌ 已配对时「在此新建对话」不该禁用');
							failed += 1;
						} else if (createBtn !== undefined) {
							console.log('   ✅ 已配对时「在此新建对话」可点');
						}
						// ⚠️ **回退路径的回归断言**：已配对时必须能看到「重新配对」，
						// 否则电脑一解绑，手机就永久卡在 502 且界面上无路可走。
						if (!/重新配对/.test(txt)) {
							console.log('   ❌ 已配对时没有「重新配对」入口（电脑解绑后手机将无法回退）');
							failed += 1;
						} else {
							console.log('   ✅ 已配对时提供了「重新配对」入口');
						}
					}
				}
				if (after.includes('[object Object]')) { console.log('   ❌ 点击后出现 [object Object]'); failed += 1; }
				if (newErrors.length > 0) { console.log('   ❌', newErrors[0].slice(0, 300)); failed += 1; }
				if (label2 === '生成配对码' && !/Q82S3F/.test(txt)) {
					console.log('   ❌ 点「生成配对码」后没看到 6 位码。当前文字:', txt.slice(0, 200));
					failed += 1;
				}
				if (label2 === '生成配对码' && !/<svg/i.test(after)) {
					console.log('   ❌ 点「生成配对码」后没有二维码 SVG');
					failed += 1;
				}
			} catch (error) {
				console.log(`   ❌ 点击「${label2}」抛错: ${String(error?.message ?? error)}`);
				failed += 1;
			}
		}

		// ---- 解绑闭环：已配对 → 重新配对 → 确定解绑 → 回到输入框 ----
		//
		// ⚠️ 这一段必须在**点完所有按钮之后**单独走一遍：上面那个循环点的是
		// 初始 DOM 里的按钮，「确定解绑」在点「重新配对」之前根本不存在。
		if (SCENARIO === 'paired' && spec.name !== 'settings.section') {
			const textOf = () => container.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
			const clickByText = async (re) => {
				const btn = [...container.querySelectorAll('button')].find((b) => re.test(b.textContent));
				if (btn === undefined) return false;
				await act(async () => { btn.click(); });
				await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
				return true;
			};

			// 回到「电脑」页签（上面循环点过别的页签，状态可能不在电脑上）。
			await clickByText(/^电脑$/);
			if (!/重新配对/.test(textOf())) {
				console.log('❌ 解绑闭环：找不到「重新配对」按钮');
				failed += 1;
			} else {
				await clickByText(/重新配对/);
				const confirming = textOf();
				if (!/确定解绑/.test(confirming)) {
					console.log('❌ 解绑闭环：点了「重新配对」没出现二次确认');
					failed += 1;
				} else {
					console.log('✅ 解绑闭环：出现了二次确认');
					await clickByText(/确定解绑/);
					const after = textOf();
					// 解绑后必须回到「填配对码」的输入框 —— 这正是原来的死锁点。
					//
					// ⚠️ 断言要打在**输入框元素**上，不能只看「配对码」三个字：
					// 未配对时的提示文字（「…生成 6 位配对码，填在这里」）里也有
					// 这三个字，只匹配文字的话，即使输入框没渲染也会假绿。
					const hasInput = [...container.querySelectorAll('input')].some((el) => /配对码/.test(el.getAttribute('aria-label') ?? ''));
					if (!hasInput) {
						console.log('❌ 解绑闭环：解绑后没有出现配对码输入框。文字:', after.slice(0, 300));
						failed += 1;
					} else {
						console.log('✅ 解绑闭环：解绑后回到配对码输入框');
					}
					if (/已配对：/.test(after)) {
						console.log('❌ 解绑闭环：解绑后仍显示「已配对：」');
						failed += 1;
					}
					if (after.includes('[object Object]')) {
						console.log('❌ 解绑闭环：出现 [object Object]');
						failed += 1;
					}
				}
			}
		}
	} catch (error) {
		console.error = origError;
		console.log(`❌ ${label} 渲染抛错: ${String(error?.message ?? error)}`);
		failed += 1;
	}
}

process.exit(failed === 0 ? 0 : 1);
