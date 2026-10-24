/**
 * 图谱「判据唯一性」审计 —— `expect` 必须**只在一屏成立**。
 *
 * ## 为什么需要这个脚本
 *
 * 图谱里每屏有个 `expect`（判据），回答「我到底进没进这一屏」。它有两个用途：
 *   ① 生成图谱时校验那一屏真的进去了（`verified`）；
 *   ② **内建成插件的「一键到屏」**（`tools/build-uiagent-screens.mjs`）——
 *      真机上的模型靠它知道现在在哪一屏。
 *
 * 判据一旦在**多屏**成立，两个用途**同时失效**，而且**症状都是静默的**：
 *   - 图谱那一屏会「假通过」（从没进去也记成 ✅）；
 *   - `goto` 会「假到达」（停在别的屏也报成功），模型于是对着错误的界面点按钮。
 *
 * 本轮实测抓到 **4 处**，全都是同一个成因 —— **看着独有、其实撞车**：
 *
 * | 屏 | 原判据 | 为什么撞车 |
 * |---|---|---|
 * | `hero` | `打开导航` | 它是 mobile-ui 的常驻悬浮按钮，**17 屏全有** |
 * | `model-picker` | `推理等级` | 子串命中了每屏都在的长文案「选择模型，当前 …，推理等级 High」 |
 * | `settings-priv` | `重新检测` | `settings › 悬浮气泡` 那屏也有一个「重新检测」 |
 * | `preset-picker` | `极简模式` | 子串命中了 `settings › Agent 预设` 的「设为新任务默认: 极简模式」 |
 *
 * ⚠️ **光靠肉眼审不出来**（我这轮就先看漏了两处）：必须机械地对**全部元素**跑
 *    一遍探针的匹配语义。
 *
 * ## 第五处（`access-mode`）—— 判据取的是「当前状态」
 *
 * 上面 4 处都是「看着独有、其实撞车」，第 5 处的成因不同，更隐蔽：
 *
 * | 屏 | 原判据 | 为什么撞车 |
 * |---|---|---|
 * | `access-mode` | `完全权限` | 它正是用户**当前的权限值**，于是 composer 那个常驻按钮的 aria 成了「访问模式，当前：完全权限」，`byText` 的子串兜底把它算进去 ⇒ **16 屏全中** |
 *
 * 修法不是换一个枚举项（换 `仅可查看` 只是把「当前值恰好是它」的概率降到更低，
 * 没有消除依赖），而是加 **`exact: true`**：菜单项的 `text` 恰好等于枚举项，
 * 而 composer 那个按钮的 `text` 永远是「访问模式，当前：<任意值>」长串，
 * 精确相等**永远**不成立。判据从此与「用户当前选的是哪一档」彻底解耦。
 *
 * ## `sel` 判据：本脚本**审不了**，如实跳过
 *
 * `terminal` 屏的判据是 `{sel:'.xterm-screen'}`。这里**不判它合格与否**，原因是
 * 本脚本只能看 JSON 里的元素表，而：
 *
 * 1. `dump` 只收 `INTERACTIVE` 候选集（button/a/input/[role]…），`.xterm-screen`
 *    是**普通 `<div>`**，压根不在里面；
 * 2. 就算在，JSON 里记的 `sel` 是**完整 cssPath**（`html>body>div:…`），
 *    与 `.xterm-screen` 这种简短选择器永不相等。
 *
 * 原实现直接比 `e.sel === want`，于是恒报「命中 0」并把整轮审计**永远染红**——
 * 红久了就没人看了，比少审一条更糟。所以这里改成**跳过并说明**，唯一性交给真机
 * 实测（`tools/_diag17.mjs`：`right-sidebar` / `workfiles` 两屏 `.xterm-screen`
 * 计数都是 **0**，只有 `terminal` 屏非 0 ⇒ 判据唯一）。
 *
 * ## 与探针口径的一致性 —— 这是本脚本的要害
 *
 * 判据最终是交给探针的 `wait` / `tap` 去执行的，所以这里必须**逐条复刻**它的语义，
 * 差一点结论就反：
 *
 * 1. **候选集合是全部可交互元素**，不过滤 `covered` / `offscreen`。
 *    遮挡与屏幕外影响的是「能不能点」，**不影响「在不在」**。
 * 2. **`exact` 走两轮**：先扫全部找**精确相等**，找不到才退回**子串包含**，
 *    且子串取**第一个**命中的（不是最长的、也不是最靠前的可见项）。
 * 3. **`clickable:true`** 才附加「没被遮挡、中心点在视口内」。
 * 4. `aria` 与 `text` 是两套入口，`locate()` 里还回落 `title`（这里只审 `text`/`aria`）。
 *
 * ## 用法
 *
 * ```powershell
 * node tools/ui-map-expect-audit.mjs
 * ```
 *
 * 退出码非零 = 有判据不合格。**改完判据要重跑图谱**（`ui-map-real-frontend.mjs`），
 * 让 JSON 里的 `expect` 跟着更新，否则内建表还是旧的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAP = path.join(ROOT, 'tools', 'ui-map-real-frontend.json');
const GEN = path.join(ROOT, 'tools', 'ui-map-real-frontend.mjs');

const map = JSON.parse(fs.readFileSync(MAP, 'utf8'));
const gen = fs.readFileSync(GEN, 'utf8');

/**
 * 从**生成器**而不是 JSON 里读判据。
 *
 * ⚠️ 这一步是有意的：改判据的地方是生成器，JSON 要重跑才会跟上。
 *    从生成器读，就能在**重跑之前**先告诉你判据行不行 —— 否则重跑一次要几分钟。
 */
function expectsFromGenerator() {
  const out = {};
  // 匹配 `id: 'xxx', ... expect: { text: 'yyy', exact: true, clickable: true },`
  // ⚠️ `prefix` 也算——它是「文案里嵌着会变的值」那类元素的唯一抓手，见 [byPrefixLike]。
  const re = /id: '([a-z-]+)',[\s\S]*?expect: \{ (text|aria|sel|prefix): '([^']+)'((?:, (?:exact|clickable): true)*) \}/g;
  for (const mm of gen.matchAll(re)) {
    const flags = mm[4] ?? '';
    out[mm[1]] = {
      kind: mm[2],
      want: mm[3],
      exact: flags.includes('exact'),
      clickable: flags.includes('clickable'),
    };
  }
  return out;
}

/** 复刻探针 `byPrefix`：只看**开头**，且**不 trim**（尾空格有语义，见探针注释）。 */
function byPrefixLike(screen, want) {
  const w = String(want).toLowerCase();
  for (const e of screen.elements) {
    if ((e.text || '').toLowerCase().indexOf(w) === 0) return e;
  }
  return null;
}

/** 复刻探针 `byText`：先精确、再子串。返回命中的元素或 null。 */
function byTextLike(screen, want, exact) {
  const w = want.trim().toLowerCase();
  for (const e of screen.elements) {
    if ((e.text || '').trim().toLowerCase() === w) return e;
  }
  if (exact) return null;
  for (const e of screen.elements) {
    if ((e.text || '').trim().toLowerCase().includes(w)) return e;
  }
  return null;
}

/** 某个判据在全部 17 屏里，哪些屏成立。 */
function hitsOf(spec) {
  const outs = [];
  for (const s of map.screens) {
    let el = null;
    if (spec.kind === 'text') el = byTextLike(s, spec.want, spec.exact);
    else if (spec.kind === 'prefix') el = byPrefixLike(s, spec.want);
    else if (spec.kind === 'aria') el = s.elements.find((e) => e.text === spec.want) ?? null;
    else if (spec.kind === 'sel') {
      // ⚠️⚠️ **`sel` 判据离线审不了，只能标成「跳过」，不能标成「不合格」。**
      //
      //    原实现比的是 `e.sel === spec.want`，而 `e.sel` 是 dump 报出来的
      //    **完整 cssPath**（`html>body>div:nth-of-type(3)>…`），与
      //    `.xterm-screen` 这种简短选择器**永不相等** ⇒ 恒报「命中 0」。
      //
      //    更根本的是：`dump` 只收 `INTERACTIVE` 候选集（button/a/input/[role]…），
      //    而 `terminal` 屏的 `.xterm-screen` 是一个**普通 `<div>`**，压根不在
      //    候选集里 —— 就算把比较改成「子串」，离线也照样看不见它。
      //
      //    所以这里**如实标成跳过**，并把唯一性的判定权交回真机：
      //    见 `tools/_diag17.mjs`（实测 `right-sidebar` / `workfiles` 两屏
      //    `.xterm-screen` 计数都是 0，只有 `terminal` 屏非 0 ⇒ 判据唯一）。
      //    把它算成「不合格」会让整个审计**永远红着**，红久了就没人看了 ——
      //    那比少审一条更糟。
      outs.push({ skipped: true, screen: s.id });
      continue;
    }
    if (!el) continue;
    if (spec.clickable === true && (el.covered || el.offscreen)) continue;
    outs.push(s.id);
  }
  return outs;
}

const expects = expectsFromGenerator();
const problems = [];

console.log(`图谱判据唯一性审计 —— ${map.screens.length} 屏 / ${map.screens.length} 个判据\n`);

for (const s of map.screens) {
  const spec = expects[s.id];
  if (!spec) {
    problems.push(`${s.id}: 生成器里没有解析到 expect`);
    console.log(`  ⚠️ ${s.id.padEnd(18)} （没解析到 expect）`);
    continue;
  }
  const hits = hitsOf(spec);
  const skipped = hits.length > 0 && hits[0]?.skipped === true;
  const names = skipped ? [] : hits;
  const ok = skipped || (names.length === 1 && names[0] === s.id);
  if (!ok) problems.push(`${s.id}: 判据「${spec.want}」在 ${names.length} 屏成立（${names.join(', ') || '一屏都不成立'}）`);

  const flag = `[${spec.kind}${spec.exact ? '+exact' : ''}${spec.clickable ? '+clickable' : ''}]`;
  console.log(`  ${ok ? '✅' : '⚠️'} ${s.id.padEnd(18)} ${flag.padEnd(18)} `
    + `${JSON.stringify(spec.want).slice(0, 40).padEnd(42)} `
    + (skipped ? '跳过（sel 判据离线审不了，见 hitsOf 注释）' : `命中 ${names.length}: ${names.join(' ') || '无'}`));
}

console.log('');
if (problems.length > 0) {
  console.error(`✗ ${problems.length} 处判据不合格 —— 这些屏的「已进入」是假的，goto 会假到达：`);
  for (const p of problems) console.error(`   ${p}`);
  console.error('\n修法：换一个**只在这一屏成立**的判据（见文件头那 4 个反例），');
  console.error('然后重跑 `node tools/ui-map-real-frontend.mjs "<url>"` 让 JSON 跟上。');
  process.exit(1);
}
console.log(`✓ ${map.screens.length} 屏判据全部唯一（每屏只在自己那一屏成立）`);
