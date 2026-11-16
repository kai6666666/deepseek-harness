import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const start = source.indexOf('/* BEGIN mobile-layout-v183');
const end = source.indexOf('/* END mobile-layout-v183 */', start);
assert.ok(start >= 0 && end > start, 'live layout adapter exists');
const block = source.slice(start, end);
const css = block.match(/style\.textContent = `([\s\S]*?)`;/)[1];

class Style {
  values = new Map();
  writes = 0;
  getPropertyValue(name) { return this.values.get(name)?.value ?? ''; }
  getPropertyPriority(name) { return this.values.get(name)?.priority ?? ''; }
  setProperty(name, value, priority = '') {
    this.writes++;
    if (name === 'grid-area' && value === 'title') value = 'title / title / title / title';
    this.values.set(name, { value, priority });
  }
  removeProperty(name) { this.writes++; this.values.delete(name); }
}
const element = (parentElement = null, display = 'block') => ({
  tagName: 'DIV', nodeType: 1, parentElement, display, position: 'static', style: new Style(), dataset: {}, children: [],
});
function harness() {
  const context = vm.createContext({
    document: { querySelectorAll: () => [] },
    getComputedStyle: el => ({ display: el.display, position: el.style.getPropertyValue('position') || el.position }),
    mpIsMobile: () => false,
  });
  vm.runInContext(block + '\nglobalThis.layout = { set: mpMarketSet, restore: mpMarketRestore, shell: mpMarketShell, sync: mpSyncSettings, patches: mpMarketInline };', context);
  return context.layout;
}

test('header contract uses stable attributes and three independent grid rows', () => {
  assert.match(css, /\[data-plugin-header-part="title"\][\s\S]*?grid-row:1/);
  assert.match(css, /\[data-plugin-header-part="toolbar"\][\s\S]*?grid-row:1/);
  assert.match(css, /\[data-plugin-header-part="intro"\][\s\S]*?grid-row:2/);
  assert.match(css, /\[data-plugin-header-part="tabs"\][\s\S]*?grid-row:3/);
  assert.match(css, /position:static!important/);
  assert.doesNotMatch(css, /VOzbGW|nUhMVa|data-shortcut-modal|role="dialog"/);
  assert.ok(!source.includes('const mpSettingsSync = new WeakMap()'), 'dead settings state machine removed');
});

test('inline declarations are important, canonicalization-safe and idempotent', () => {
  const h = harness(), el = element();
  const declarations = { width: '100%', 'grid-area': 'title' };
  h.set(el, declarations, new Map());
  const writes = el.style.writes;
  for (let i = 0; i < 20; i++) h.set(el, declarations, new Map());
  assert.equal(el.style.writes, writes);
  assert.equal(el.style.getPropertyPriority('width'), 'important');
});

test('leaving a market restores previous values and priorities, removing added properties', () => {
  const h = harness(), el = element();
  el.style.setProperty('padding', '16px', 'important');
  el.style.setProperty('display', 'block');
  h.set(el, { padding: '0px', display: 'flex', width: '100%' }, new Map());
  h.restore(new Map());
  assert.equal(el.style.getPropertyValue('padding'), '16px');
  assert.equal(el.style.getPropertyPriority('padding'), 'important');
  assert.equal(el.style.getPropertyValue('display'), 'block');
  assert.equal(el.style.getPropertyPriority('display'), '');
  assert.equal(el.style.getPropertyValue('width'), '');
  assert.equal(h.patches.size, 0);
});

test('partial reconciliation releases only properties no longer requested', () => {
  const h = harness(), el = element();
  el.style.setProperty('padding', '16px');
  h.set(el, { padding: '0px', display: 'flex' }, new Map());
  const active = new Map();
  h.set(el, { display: 'flex' }, active);
  h.restore(active);
  assert.equal(el.style.getPropertyValue('padding'), '16px');
  assert.equal(el.style.getPropertyValue('display'), 'flex');
  assert.equal(h.patches.get(el).size, 1);
});

test('restoration keeps unrelated changes and declarations taken over by another owner', () => {
  const h = harness(), el = element();
  h.set(el, { display: 'flex' }, new Map());
  el.style.setProperty('display', 'grid', 'important');
  el.style.setProperty('color', 'red');
  h.restore(new Map());
  assert.equal(el.style.getPropertyValue('display'), 'grid');
  assert.equal(el.style.getPropertyValue('color'), 'red');
});

test('a React inline update becomes the new restoration baseline', () => {
  const h = harness(), el = element();
  el.style.setProperty('padding', '16px');
  h.set(el, { padding: '0px' }, new Map());
  el.style.setProperty('padding', '8px');
  h.set(el, { padding: '0px' }, new Map());
  h.restore(new Map());
  assert.equal(el.style.getPropertyValue('padding'), '8px');
  assert.equal(el.style.getPropertyPriority('padding'), '');
});

test('market chain stops below host, skips transparent slots and leaves market header alone', () => {
  const h = harness(), host = element(), wrapper = element(host), slot = element(wrapper, 'contents');
  const root = element(slot), header = element(root);
  root.firstElementChild = header;
  host.style.setProperty('padding-top', '48px');
  const active = new Map();
  h.shell(root, host, active);
  assert.equal(host.style.getPropertyValue('padding-top'), '48px');
  assert.equal(host.style.writes, 1);
  assert.equal(slot.style.writes, 0);
  assert.equal(header.style.writes, 0);
  assert.equal(root.style.getPropertyValue('width'), '100%');
  assert.equal(wrapper.style.getPropertyValue('min-height'), '0px');
  assert.equal(active.size, 2);
});

test('desktop transition releases mobile inline geometry', () => {
  const h = harness(), el = element();
  el.style.setProperty('display', 'block');
  h.set(el, { display: 'flex' }, new Map());
  h.sync();
  assert.equal(el.style.getPropertyValue('display'), 'block');
  assert.equal(h.patches.size, 0);
});


test('toolbar keeps refresh and add in row one and moves only status to row two', () => {
  assert.match(css, /toolbar[\s\S]*?display:contents!important/);
  assert.match(css, /> :not\(button\):not\(:has\(button\)\)[\s\S]*?grid-row:2!important/);
  assert.match(css, /grid-template-columns:minmax\(0,1fr\) auto auto/);
  assert.match(css, /@media \(max-width: 359px\)/);
});

test('two-child market keeps header natural and gives native scrolling to body', () => {
  const h = harness(), host = element(), root = element(host), head = element(root), body = element(root);
  root.children = [head, body];
  body.style.setProperty('min-height', '100%');
  body.style.setProperty('overflow-y', 'visible');
  head.style.setProperty('margin-left', '-4px');
  h.shell(root, host, new Map());
  assert.equal(head.style.getPropertyValue('height'), 'auto');
  assert.equal(head.style.getPropertyValue('flex'), '0 0 auto');
  assert.equal(head.style.getPropertyValue('margin'), '0px');
  assert.equal(body.style.getPropertyValue('flex'), '1 1 0%');
  assert.equal(body.style.getPropertyValue('min-height'), '0px');
  assert.equal(body.style.getPropertyValue('overflow-y'), 'auto');
  assert.match(body.style.getPropertyValue('touch-action'), /pan-y/);
  h.restore(new Map());
  assert.equal(body.style.getPropertyValue('min-height'), '100%');
  assert.equal(body.style.getPropertyValue('overflow-y'), 'visible');
  assert.equal(head.style.getPropertyValue('margin-left'), '-4px');
});

test('entry-independent density is local and restores original font and animation', () => {
  const h = harness(), host = element(), root = element(host);
  root.style.setProperty('font-size', '15px');
  root.style.setProperty('transition', 'all 0.2s');
  h.shell(root, host, new Map());
  assert.equal(root.style.getPropertyValue('font-size'), '14px');
  assert.equal(root.style.getPropertyValue('transition'), 'none');
  assert.equal(root.style.getPropertyValue('transform'), 'none');
  assert.equal(host.style.writes, 0);
  h.restore(new Map());
  assert.equal(root.style.getPropertyValue('font-size'), '15px');
  assert.equal(root.style.getPropertyValue('transition'), 'all 0.2s');
});

test('conditional back-to-top span still lets the market adapter size head and body', () => {
  const h = harness(), host = element(), root = element(host);
  const head = element(root), body = element(root), top = element(root);
  top.tagName = 'SPAN';
  root.children = [head, body, top];
  h.shell(root, host, new Map());
  assert.equal(head.style.getPropertyValue('height'), 'auto');
  assert.equal(body.style.getPropertyValue('overflow-y'), 'auto');
  assert.equal(top.style.writes, 0, 'the fixed back-to-top span keeps its own placement');
});

test('a non-DIV second child keeps market internals unchanged', () => {
  const h = harness(), host = element(), root = element(host);
  const head = element(root), body = element(root);
  body.tagName = 'SPAN';
  root.children = [head, body];
  h.shell(root, host, new Map());
  assert.equal(head.style.writes, 0);
  assert.equal(body.style.writes, 0);
});

test('sticky category rail rejoins the scroll flow and is restored on leave', () => {
  const h = harness(), host = element(), root = element(host);
  const head = element(root), body = element(root), cats = element(body);
  cats.position = 'sticky';
  body.children = [cats];
  root.children = [head, body];
  h.shell(root, host, new Map());
  assert.equal(cats.style.getPropertyValue('position'), 'static');
  assert.equal(cats.style.getPropertyValue('width'), '100%');
  assert.equal(cats.style.getPropertyValue('z-index'), 'auto');
  assert.equal(cats.style.getPropertyValue('top'), 'auto');
  h.restore(new Map());
  assert.equal(cats.style.getPropertyValue('position'), '');
  assert.equal(cats.style.getPropertyValue('width'), '');
});

test('new market mounts are sized before the debounced general pass', () => {
  const observer = source.slice(source.indexOf('const mo = new MutationObserver'));
  assert.ok(observer.indexOf('mpSyncSettings();') < observer.indexOf('setTimeout('));
});
