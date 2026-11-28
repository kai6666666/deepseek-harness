/*
 * dsh-android 前端“手术级”样式修复（只注入，不改上游包）。
 *
 * 为什么要有这个文件：
 *   轨迹面板 `dsh-client-ui-trajectory` 的每一步是一个 **固定 38px 高的单行**（
 *   `TrajectoryCell.module.css`: `.root{height:38px}` / `.text{white-space:nowrap;
 *   overflow:hidden;text-overflow:ellipsis}`），右侧指标区还写死了 `width:320px`
 *   （4×71 + 3×12）。在手机上：
 *     · 文本区被压到几乎没有 → 全被省略号吃掉；
 *     · 高 38px 装不下换行内容 → 溢出后与下一条重叠（就是“右侧内容堆叠”）；
 *   改 rootfs 里的 dist 会在 runtime 升级时被覆盖，所以先走**注入 CSS**（方案 a）。
 *
 * 注入时机：
 *   `MainActivity` 在每次 `onPageFinished` 后评估一次；插件（统计/轨迹）是晚挂载的，
 *   所以本脚本自己装了 MutationObserver，`<style>` 被后来的 re-render 掉了会重新插回。
 *
 * 回退：删掉这个文件（或把版本号改回去）重启 App 即回到上游原样式。
 */
(function () {
  'use strict';
  var VERSION = 1;
  var STYLE_ID = 'dsh-ui-fixes';
  var css = [
    '/* ① 轨迹行：不再强高 38px，允许换行与增高 */',
    '@media (max-width: 560px) {',
    '  [data-kind] {',
    '    height: auto !important;',
    '    min-height: 38px !important;',
    '    align-items: flex-start !important;',
    '    flex-wrap: wrap !important;',
    '    row-gap: 4px !important;',
    '  }',
    '  /* ② 右侧指标区（4×71+3×12=320px）在窄屏上改为另起一行、左对齐 */',
    '  [data-kind] [class*="trailing" i] {',
    '    width: auto !important;',
    '    flex: 1 1 100% !important;',
    '    justify-content: flex-start !important;',
    '    column-gap: 10px !important;',
    '  }',
    '  /* ③ 正文：允许换行与任意位置断词，不再 ellipsis */',
    '  [data-kind] [class*="text" i] {',
    '    white-space: pre-wrap !important;',
    '    overflow: visible !important;',
    '    text-overflow: clip !important;',
    '    overflow-wrap: anywhere !important;',
    '    word-break: break-word !important;',
    '    line-height: 1.45 !important;',
    '  }',
    '}',
    '/* ④ 统计 tab 的表格同样允许换行（窄屏不横向溢出） */',
    '@media (max-width: 560px) {',
    '  [class*="stats" i] table { table-layout: auto !important; }',
    '  [class*="stats" i] td, [class*="stats" i] th {',
    '    white-space: normal !important;',
    '    overflow-wrap: anywhere !important;',
    '  }',
    '}'
  ].join('\n');
  function apply() {
    if (document.getElementById(STYLE_ID)) return;
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.setAttribute('data-version', String(VERSION));
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
  }
  apply();
  // 插件晚挂载 / re-render 会把 head 重建，守住它。
  try {
    var obs = new MutationObserver(function () { apply(); });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* 老 WebView 无 MutationObserver：只靠一次性注入 */ }
  window.__DSH_UI_FIXES__ = VERSION;
})();
