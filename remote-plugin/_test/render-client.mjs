/**
 * 真渲染测试：把两个 client 半边的组件树跑一遍 `renderToStaticMarkup`，
 * 抓 React 抛出的运行时错误（比如那个经典的 `style` 给字符串 → error #62）。
 *
 * ⚠️ 为什么必须真渲染：React 的 `style` prop 校验发生在**渲染时**，
 * 静态检查看不出来。手机端曾经因为这个问题整块组件被 slot 系统 `abdicate`，
 * 表现是「页签根本不出现」，而控制台只有一条难懂的 #62。
 */
import { readFileSync } from 'node:fs';
import { createElement, useState, useEffect, useCallback, useRef, useMemo, useId } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const FILE = process.argv[2];
const source = readFileSync(FILE, 'utf8');

let loaded = null;
global.window = { __ModuleLoader__: { load: (spec) => { loaded = spec; } } };
global.EventSource = class { constructor() { this.readyState = 0; } addEventListener() {} close() {} };
global.document = {
	querySelector: () => null,
	createElement: () => ({ dataset: {}, style: {}, appendChild() {}, set textContent(v) {} }),
	head: { appendChild() {} },
};
global.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, result: {} }) });

/** 一个老老实实把 props 透到 DOM 的占位组件（等价于官方原子的行为）。 */
const passthrough = (tag) => (props) => createElement(tag, { style: props.style, className: props.className }, props.children);

const MODULES = {
	react: { createElement, useState, useEffect, useCallback, useRef, useMemo, useId },
	'@deepseek-ai/dsh-client-ui-primitives': new Proxy({}, {
		get(_t, name) {
			if (name === 'Modal') {
				// 官方 Modal 的 `className` 是字符串、children 直接渲染。
				return (props) => createElement('div', { className: props.className, 'data-open': props.open }, props.children);
			}
			if (name === 'Input') return (props) => createElement('input', { ...props, style: undefined, value: props.value ?? '' });
			// Button / Pill / 图标：都当 div/span 透传。
			return passthrough('div');
		},
	}),
};

new Function('window', source)(global.window);
if (loaded === null) { console.error('❌ 没调用 load'); process.exit(1); }

const mod = loaded.factory((name) => {
	if (!(name in MODULES)) throw new Error(`模块表里没有 "${name}"`);
	return MODULES[name];
});

/** 收集注册进来的组件。 */
const cells = [];
const ctx = {
	effect: (fn) => fn(),
	slots: {
		inject: (slot, fn) => {
			const r = fn();
			if (r && typeof r.next === 'function') { let s = r.next(); while (!s.done) s = r.next(); }
			return r;
		},
		register: (spec, component) => { cells.push({ spec, component }); return { dispose() {} }; },
	},
	sessions: { binding: () => undefined, create: () => Promise.resolve(), refresh: () => Promise.resolve() },
	uiWorkspace: {},
	logger: { info() {}, warn() {}, error() {} },
};

mod.apply(ctx);
console.log('注册到', cells.length, '个 slot');

let failed = 0;
for (const { spec, component } of cells) {
	const label = spec.name + (spec.id ? '/' + spec.id : '');
	// 两种 props 都试：对话流契约（open:true）与设置页（无 props）。
	const propSets = spec.name === 'settings.section' ? [{}] : [{ open: true, onPicked() {}, onCancel() {} }];
	for (const props of propSets) {
		try {
			const html = renderToStaticMarkup(createElement(component, props));
			console.log(`✅ ${label} 渲染成功（${html.length} 字符）`);
			if (html.includes('[object Object]')) {
				console.log(`❌ ${label} 的 HTML 里出现了 [object Object] —— style 传错类型了`);
				failed += 1;
			}
		} catch (error) {
			console.log(`❌ ${label} 渲染抛错: ${String(error?.message ?? error)}`);
			failed += 1;
		}
	}
}

process.exit(failed === 0 ? 0 : 1);
