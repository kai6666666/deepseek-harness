#!/usr/bin/env node
/**
 * 把 `docs/ui-themes/pages/` 的快照转成**自包含单文件**的纯界面版。
 *
 *     node tools/ui-standalone.mjs
 *
 * 产物：`docs/ui-screens/<序号>-<id>.html`，共 19 个。
 *
 * ## 与 `ui-themes` 那份的区别
 *
 * | | `docs/ui-themes/` | `docs/ui-screens/`（本脚本） |
 * |---|---|---|
 * | 用途 | **设计主题**（改 CSS 变量、实时预览、导出） | **只看界面** |
 * | 样式 | 外链 `assets/*.css`（19 屏共用） | **内联进每个 html** |
 * | 依赖 | 要带着 `assets/` 目录；`lab.html` 靠 `?theme=` 预览 | **零依赖，单个文件就是全部** |
 * | JS | 有主题注入器 | **一个 script 都没有** |
 * | 工具 | `lab.html` + `lab-data.js` | 无 |
 *
 * ## 为什么不重新抓一遍
 *
 * 两份产物的**界面 DOM 是同一份**（都来自真机）。重新抓只会多打扰一次手机，
 * 而且两次抓取之间设备状态可能漂移（实测有 4 屏首次没点通）。
 * 所以这里只做**转换**：把 `ui-themes` 里已经抓好的 DOM 取出来，把样式内联进去。
 *
 * ## 转换要做的四件事
 *
 * 1. **取出内层 `<html>`** —— `ui-themes` 的产物是「我加的外层头 + 真机原文」，
 *    外层头里只有 `<title>` 和 4 个 `<link>`，纯界面版不需要。
 * 2. **内联全部样式** —— `app.css` → `extra-<id>.css`（仅 terminal 有）→
 *    `theme-base.css` → `theme.css`，顺序与原 `<link>` 顺序一致（后者覆盖前者）。
 * 3. **删掉 `<base href="./">`** —— 那是为外链样式准备的，内联后没有外部引用，
 *    留着反而会让页面里任何相对链接指向奇怪的地方。
 * 4. **删掉所有 `<script>`** —— 主题注入器是 `ui-themes` 的工具功能，
 *    纯界面版不要。删干净后文件里没有任何可执行代码。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(ROOT, 'docs', 'ui-themes');
const OUT = join(ROOT, 'docs', 'ui-screens');

const MANIFEST = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'));
const ASSETS = join(SRC, 'assets');

/** 读一份样式；不存在就返回空串（`extra-*` 只有 terminal 有）。 */
function css(name) {
  const p = join(ASSETS, name);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

/**
 * 从 `ui-themes` 的产物里取出**真机原文**那段 `<html>`。
 *
 * 结构是：`<!doctype html><html><head>…外层头…</head>` **紧接着** 真机原文
 * （自己带 `<html>`），末尾是注入器 script + 内层的 `</body></html>`，
 * 再跟一个我补的 `</html>`。
 *
 * 判据用「外层 `</head>` 之后的第一个 `<html`」—— 比数第几次出现更稳：
 * 真机原文的 `<html` 一定紧跟在外层 head 之后。
 */
function extractDeviceHtml(page) {
  const afterHead = page.indexOf('</head>');
  if (afterHead < 0) throw new Error('找不到外层 </head>');
  const start = page.indexOf('<html', afterHead);
  if (start < 0) throw new Error('外层 head 之后找不到真机原文的 <html>');
  // 真机原文的收尾 `</body></html>` —— 取最后一个 `</body>`，把注入器 script 甩在外面
  const bodyEnd = page.lastIndexOf('</body>');
  if (bodyEnd < 0) throw new Error('找不到 </body>');
  return page.slice(start, bodyEnd) + '</body>';
}

/** 删掉所有 `<script>…</script>`（本页只有主题注入器那一个）。 */
function stripScripts(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
}

/** 删掉 `<base …>`：内联后没有外部引用，留着会让相对链接行为变得奇怪。 */
function stripBase(html) {
  return html.replace(/<base\b[^>]*>/gi, '');
}

/** 在 `</head>` 之前插入内联样式。 */
function inlineStyles(html, cssText) {
  const i = html.indexOf('</head>');
  if (i < 0) throw new Error('真机原文里找不到 </head>');
  const style = `<style>\n${cssText}\n</style>\n`;
  return html.slice(0, i) + style + html.slice(i);
}

/**
 * 屏幕顺序：按 manifest 的顺序（那是图谱的采集顺序，从基态 Hero 逐层展开）。
 * 序号前缀让文件管理器里按界面顺序排列，而不是按字典序。
 */
const screens = MANIFEST.screens.filter((s) => s.ok);

mkdirSync(OUT, { recursive: true });

// 只清掉本脚本上次的产物，避免旧序号残留（例如上一版 20 屏、这一版 19 屏时
// 会留下一个指向已不存在界面的孤儿文件）。判据是 `NN-` 前缀，不碰别的文件。
for (const f of readdirSync(OUT)) {
  if (/^\d+-.*\.html$/.test(f)) unlinkSync(join(OUT, f));
}

const baseCss = css('app.css');
const themeBase = css('theme-base.css');
const themeUser = css('theme.css');

const rows = [];
for (const [i, s] of screens.entries()) {
  const page = readFileSync(join(SRC, 'pages', `${s.id}.html`), 'utf8');
  let html = extractDeviceHtml(page);
  html = stripScripts(html);
  html = stripBase(html);

  // 顺序必须与原来那 4 个 <link> 一致：后者覆盖前者
  const extra = s.extraCss ? css(s.extraCss) : '';
  const cssText = [baseCss, extra, themeBase, themeUser].filter(Boolean).join('\n\n');
  html = inlineStyles(html, cssText);

  const no = String(i + 1).padStart(2, '0');
  const file = `${no}-${s.id}.html`;
  writeFileSync(join(OUT, file), html);

  const bad = [];
  if (/<script\b/i.test(html)) bad.push('残留 script');
  if (/<link\b/i.test(html)) bad.push('残留 link');
  if (/<base\b/i.test(html)) bad.push('残留 base');
  if (!/<html\b/i.test(html)) bad.push('缺 <html>');

  rows.push({
    no, file, id: s.id, title: s.title,
    bytes: Buffer.byteLength(html, 'utf8'),
    scripts: (html.match(/<script\b/gi) ?? []).length,
    links: (html.match(/<link\b/gi) ?? []).length,
    bad,
  });
}

console.log(`\n产物目录: ${OUT}\n`);
for (const r of rows) {
  const flag = r.bad.length ? `  ⚠️ ${r.bad.join(' / ')}` : '';
  console.log(`  ${r.no}  ${r.title.padEnd(22)} ${r.file.padEnd(28)} ` +
    `${(r.bytes / 1024).toFixed(0).padStart(5)} KB` +
    `  script=${r.scripts} link=${r.links}${flag}`);
}

const total = rows.reduce((a, r) => a + r.bytes, 0);
const badN = rows.filter((r) => r.bad.length).length;
console.log(`\n共 ${rows.length} 屏，合计 ${(total / 1024 / 1024).toFixed(1)} MB` +
  `（平均 ${(total / rows.length / 1024).toFixed(0)} KB/屏）`);
console.log(badN === 0
  ? '✓ 自检通过：每屏零 script / 零 link / 零 base'
  : `✗ ${badN} 屏自检不通过`);
process.exit(badN === 0 ? 0 : 1);
