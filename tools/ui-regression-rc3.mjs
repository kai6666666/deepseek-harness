#!/data/data/com.dsh.android/files/termux/usr/bin/node
// ─────────────────────────────────────────────────────────────────────────────
// rc3 三处「更多」菜单 + 遮罩的回归脚本（E / F / G / D 四条）
//
// 为什么要有这条脚本：
//   rc3 的「更多」是 portal 到 body 的浮层，anchor 又在抽屉里。历史上出过两个
//   互相打架的 bug：①打开菜单把抽屉收掉 → 菜单被 clamp 到屏幕中央；
//   ②菜单项点完抽屉不收 → 与「插件 / 自动化任务」行行为不一致。
//   这两条都是“看截图看不出来、过两版又回来”的类型，所以固化成断言。
//
// 跑法（必须在 app 身份下，因为要读写 $DSH_HOME 里的探针文件）：
//   adb shell run-as com.dsh.android \
//     files/termux/usr/bin/node /data/local/tmp/ui-regression-rc3.mjs
//
// 退出码：0 = 全 PASS（SKIP 不算失败）；1 = 至少一条 FAIL
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.DSH_HOME || '/data/user/0/com.dsh.android/files/home/.dsh';
const CMD = path.join(HOME, 'ui-cmd.json');
const RES = path.join(HOME, 'ui-result.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TXT = (e) => (((e && e.text) || '') + ((e && e.aria) || '')).replace(/\s+/g, ' ').trim();
const BOX = (e) => (e && e.rect) || {};
const X = (e) => Math.round(BOX(e).x || 0);
const Y = (e) => Math.round(BOX(e).y || 0);
const DESC = (e) => `${TXT(e) || '(无文本)'}[${X(e)},${Y(e)} ${Math.round(BOX(e).w || 0)}x${Math.round(BOX(e).h || 0)}]`;

let seq = 900000;

/** 发一条探针命令并等对应回执（id 必须闭环，否则会读到上一条结果）。 */
async function run(action, extra = {}) {
  const id = ++seq;
  try { fs.unlinkSync(RES); } catch { /* 首次跑没有旧文件 */ }
  fs.writeFileSync(CMD, JSON.stringify({ id, action, limit: 900, ...extra }));
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    try {
      const d = JSON.parse(fs.readFileSync(RES, 'utf8'));
      if (d && d.id === id) return d;
    } catch { /* 还没写完，继续等 */ }
  }
  throw new Error(`探针超时：${action}`);
}

const results = [];
function record(level, name, detail) {
  results.push({ level, name, detail });
  const tag = level === 'PASS' ? 'PASS' : level === 'SKIP' ? 'SKIP' : 'FAIL';
  console.log(`[${tag}] ${name} — ${detail}`);
}

const rows = (d) => (d.elements || []).filter((e) => /panelRow/.test(e.cls || ''));
const items = (d) => (d.elements || []).filter((e) => e.role === 'menuitem');
const drawerXs = (d) => rows(d).map(X);
// 阈值用 5 而不是 0：抽屉滑入动画会停在 x=1 这种“半开”状态，
// 拿 >=0 会把它当成已展开，后面所有帧都对不上。
const drawerOpen = (d) => rows(d).some((e) => X(e) > 5);
const menuCount = (d) => items(d).length;

/** 复位：关菜单（Esc）→ 有遮罩就点掉 → 再 Esc 一次。 */
async function resetAll() {
  await run('key', { key: 'Escape' });
  await sleep(400);
  const f = await run('find', { sel: '.mp-drawer-mask' }).catch(() => ({ ok: false }));
  if (f && f.ok) {
    // 遮罩存在 = 抽屉还开着：点一次遮罩把两侧都收掉
    await run('tap', { ref: f.ref }).catch(() => {});
    await sleep(700);
  }
  await run('key', { key: 'Escape' });
  await sleep(500);
}

/** 打开抽屉：只点**可见**的锚点（关着时官方 toggle 也在 dump 里，x 为负）。 */
async function openDrawer() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const d = await run('dump');
    if (drawerOpen(d)) return d;
    const cands = (d.elements || []).filter(
      (e) => TXT(e) === '打开导航' || TXT(e).startsWith('打开侧边栏')
    );
    const vis = cands.find((e) => X(e) >= 0);
    if (!vis) break;
    await run('tap', { ref: vis.ref });
    await sleep(700);
  }
  // 等动画停：连续两帧 x 一致才算“开好了”，否则 before 会取到 x=1 的中间态。
  let prev = '';
  for (let i = 0; i < 8; i++) {
    const d = await run('dump');
    const xs = drawerXs(d).join(',');
    if (drawerOpen(d) && xs === prev) return d;
    prev = xs;
    await sleep(350);
  }
  return run('dump');
}

async function openMoreMenu() {
  const d = await openDrawer();
  const more = rows(d).find((e) => TXT(e) === '更多');
  if (!more) throw new Error('找不到侧栏「更多」行');
  await run('tap', { ref: more.ref });
  await sleep(900);
  return run('dump');
}

// ── 前置：进程 / 探针活着 ───────────────────────────────────────────────────
(async () => {
  const ping = await run('ping').catch((e) => ({ ok: false, err: String(e.message || e) }));
  if (!ping.ok) {
    record('FAIL', 'PREFLIGHT', `探针不通（app 可能没起）: ${ping.err || ''}`);
    console.log('\n结果：1 条失败，未继续。先 am start -n com.dsh.android/.MainActivity');
    process.exit(1);
  }
  record('PASS', 'PREFLIGHT', '探针 ping 通');

  await resetAll();

  // ── D：会话视图「更多操作」菜单不越界、不碰抽屉 ──────────────────────
  try {
    await resetAll();
    let d = await run('dump');
    const vp = d.viewport || { w: 394, h: 806 };
    const head = (d.elements || []).find(
      (e) => X(e) >= 0 && Y(e) < 130 && /更多操作|更多/.test(TXT(e)) && !/panelRow/.test(e.cls || '')
    );
    if (!head) {
      record('SKIP', 'D 会话视图「更多」不越界', '当前不在会话视图（头部没有「更多操作」）；先建会话发一条消息再跑');
    } else {
      await run('tap', { ref: head.ref });
      await sleep(1000);
      d = await run('dump');
      const its = items(d);
      const inside = its.every((e) => {
        const b = BOX(e);
        return b.x >= 0 && b.y >= 0 && b.x + b.w <= vp.w + 1 && b.y + b.h <= vp.h + 1;
      });
      const drawerUntouched = !drawerOpen(d);
      const ok = its.length > 0 && inside && drawerUntouched;
      record(
        ok ? 'PASS' : 'FAIL',
        'D 会话视图「更多」不越界',
        its.length
          ? `${its.map(DESC).join(' ')}；视口内=${inside ? 'YES' : 'NO'}；抽屉=${drawerUntouched ? '未动' : '被打开'}`
          : `点「${DESC(head)}」后没有 menuitem`
      );
    }
  } catch (e) {
    record('FAIL', 'D 会话视图「更多」不越界', e.message);
  }

  // ── F：只开菜单不点 → 抽屉必须钉住 ─────────────────────────────────────
  try {
    const d0 = await openDrawer();
    if (!drawerOpen(d0)) throw new Error(`抽屉没打开（drawerX=${drawerXs(d0).join(',')}）`);
    const before = drawerXs(d0).join(',');
    const more = rows(d0).find((e) => TXT(e) === '更多');
    await run('tap', { ref: more.ref });

    const frames = [];
    for (const ms of [150, 400, 900]) {
      await sleep(ms);
      const d = await run('dump');
      frames.push({ ms, xs: drawerXs(d).join(','), n: menuCount(d) });
    }
    const stable = frames.every((f) => f.xs === before && f.n > 0);
    record(
      stable ? 'PASS' : 'FAIL',
      'F 开菜单不收起抽屉',
      stable
        ? `drawer 恒 ${before}；三帧 menu 项 ${frames.map((f) => f.n).join('/')}`
        : `开抽屉=${before}；${frames.map((f) => `+${f.ms}ms drawer=${f.xs} menu=${f.n}`).join(' | ')}`
    );
  } catch (e) {
    record('FAIL', 'F 开菜单不收起抽屉', e.message);
  }

  // ── E：点菜单项 → 抽屉必须收 ───────────────────────────────────────────
  try {
    let d = await run('dump');
    if (!menuCount(d)) d = await openMoreMenu();
    const first = items(d)[0];
    if (!first) throw new Error('菜单里没有 menuitem');
    const label = TXT(first);
    // ⚠️ 不要拿旧 dump 的 ref 直接点：菜单是 React 渲染的，帧间可能已重建，
    //   ref 会落到已卸载的节点上（点了没反应、抽屉不动）。按文案重新定位更稳。
    let closed = false;
    for (let attempt = 0; attempt < 2 && !closed; attempt++) {
      const t = await run('tap', { text: label }).catch(() => ({ ok: false }));
      if (t.ok === false) await run('tap', { ref: items(await run('dump'))[0].ref }).catch(() => {});
      await sleep(1100);
      d = await run('dump');
      closed = !drawerOpen(d);
      if (!closed) { await sleep(400); d = await run('dump'); closed = !drawerOpen(d); }
    }
    record(
      closed ? 'PASS' : 'FAIL',
      'E 点菜单项收起抽屉',
      closed ? `「${label}」→ drawer=${drawerXs(d).join(',')}` : `「${label}」点完 drawer 仍在 ${drawerXs(d).join(',')}`
    );
  } catch (e) {
    record('FAIL', 'E 点菜单项收起抽屉', e.message);
  }

  // ── G：点遮罩 → 抽屉收、菜单不复活 ────────────────────────────────────
  try {
    await resetAll();
    let d = await openMoreMenu();
    if (!menuCount(d)) throw new Error('菜单没打开');
    // 按坐标点遮罩右侧空白（抽屉宽 280，视口 394 → x=vp.w-30 一定在遮罩上）。
    // 不能用 ref：遮罩铺满全屏，它的中心点正好被抽屉盖住。
    const vp0 = d.viewport || { w: 394, h: 806 };
    const tapAt = { x: Math.round(vp0.w - 30), y: Math.round(vp0.h / 2) };
    const hit = await run('tap', tapAt);
    if (hit.ok === false) throw new Error(`坐标点击失败: ${hit.err || ''}`);
    await sleep(1200);
    d = await run('dump');
    const ok = !drawerOpen(d) && menuCount(d) === 0;
    record(
      ok ? 'PASS' : 'FAIL',
      'G 点遮罩收起抽屉且菜单不复活',
      ok ? `drawer=${drawerXs(d).join(',')}；menuitem=0` : `drawer=${drawerXs(d).join(',')}；menuitem=${menuCount(d)}`
    );
  } catch (e) {
    record('FAIL', 'G 点遮罩收起抽屉且菜单不复活', e.message);
  }

  await resetAll();

  // ── 汇总 ───────────────────────────────────────────────────────────────
  const bad = results.filter((r) => r.level === 'FAIL').length;
  const skip = results.filter((r) => r.level === 'SKIP').length;
  console.log(
    `\n结果：${results.length - bad - skip} PASS / ${bad} FAIL / ${skip} SKIP` +
      (bad ? ' → 退出码 1' : ' → 退出码 0')
  );
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error(`[FAIL] 脚本异常：${e.message}`);
  process.exit(1);
});