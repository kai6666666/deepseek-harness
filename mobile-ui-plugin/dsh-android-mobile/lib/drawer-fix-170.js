/* ===== mobile-ui 补丁（CI 打包前追加到 lib/client.js）=====
 *
 * 内容分四段：
 *   A. 设置弹窗层级：portal 到 body 的模态(z=1000)被抽屉列(z=1100)压住 → 抬到 1200
 *   B. 打开设置即收抽屉：portal 模态挂载时点一次官方 toggle（等价 selectPanel 的效果）
 *   C. 清理遗留 .mp-drawer-mask（原生抽屉模式下不该存在）
 *   D. 左侧栏按钮对齐右侧栏按钮：同一布局体系（28×28、同一垂直中线、16px 图标、同色）
 *
 * 真机实测依据（PROBE174/175/182/183）：
 *   设置 overlay  : body > .VOzbGW_overlay absolute z=1000 > .VOzbGW_panel fixed z=1 (394×806)
 *   抽屉列        : DIV.pI_x6G_sidebarCol fixed z=1100 rect=[0,0,320,806]
 *   左按钮(IW6AQa_iconButton) : box=[12,11,28,28] svg=[18,17,16,16]  ← 挂在 leadingSeat(绝对 top:11)
 *   右按钮(_sm_1ulci_28)      : box=[354,22.3,28,28] svg=[15px]      ← 标题行内垂直居中
 *   → 左中心 25 / 右中心 36.3：坐标系不同（座位 vs 流内居中），所以左"高"。
 *
 * 注意：不要隐藏 .hHd-Xa_root（侧栏与设置面板共用根类，会整屏白）。
 */
(function () {
  if (window.__mpDrawerFix170) return;
  window.__mpDrawerFix170 = true;

  var STYLE_ID = 'mp-drawer-fix-170';
  var CSS = ''
    + 'html[data-mobile] body > [class*="overlay"]:has(> [role="dialog"][aria-modal="true"]){'
    + 'z-index:1200 !important;'
    + '}\n'
    + 'html[data-mobile] body > [class*="overlay"]:has([role="dialog"][aria-modal="true"]){'
    + 'pointer-events:auto !important;'
    + '}\n';

  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function sidebarCol() { return document.querySelector('[class*="sidebarCol"]'); }
  function frameDrawer() { return document.querySelector('[data-sidebar-drawer]'); }
  function drawerOpen() {
    var f = frameDrawer();
    return !!f && !f.hasAttribute('data-sidebar-collapsed');
  }
  function closeDrawer() {
    var f = frameDrawer();
    if (!f || f.hasAttribute('data-sidebar-collapsed')) return false;
    var t = document.querySelector('[data-sidebar-toggle]')
      || document.querySelector('[data-sidebar-opener]');
    if (!t) return false;
    t.click();
    return true;
  }
  function isPortalModal(node) {
    if (!node || node.nodeType !== 1) return false;
    if (!node.querySelector) return false;
    if (node.closest && node.closest('[class*="sidebarCol"]')) return false;
    var col = sidebarCol();
    if (col && node.contains(col)) return false;
    var d = node.querySelector('[role="dialog"][aria-modal="true"]');
    if (!d) return false;
    var r = d.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }
  function sweepMask() {
    if (!frameDrawer()) return;
    var masks = document.querySelectorAll('body > .mp-drawer-mask');
    for (var i = 0; i < masks.length; i++) {
      try { masks[i].parentNode.removeChild(masks[i]); } catch (e) { /* 静默 */ }
    }
  }
  function handleAdded(node) {
    if (!isPortalModal(node)) return;
    sweepMask();
    if (drawerOpen()) closeDrawer();
  }

  /* ── D. 左侧栏按钮对齐右侧栏按钮 ──── */
  function rightSidebarButton() {
    var bs = document.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) {
      var a = bs[i].getAttribute('aria-label') || '';
      if (a.indexOf('右侧边栏') >= 0) return bs[i];
    }
    return null;
  }
  function leadingSeat() { return document.querySelector('[class*="leadingSeat"]'); }

  function alignLead() {
    if (!document.documentElement.hasAttribute('data-mobile')) return;
    var seat = leadingSeat();
    var right = rightSidebarButton();
    if (!seat || !right) return;
    var lead = seat.querySelector('button');
    if (!lead) return;
    var rr = right.getBoundingClientRect();
    var sr = seat.getBoundingClientRect();
    if (rr.width < 1 || sr.width < 1) return;

    [lead, right].forEach(function (b) {
      var svg = b.querySelector('svg');
      if (!svg) return;
      if (svg.getAttribute('width') !== '16') svg.setAttribute('width', '16');
      if (svg.getAttribute('height') !== '16') svg.setAttribute('height', '16');
    });

    var curTop = parseFloat(getComputedStyle(seat).top);
    if (isNaN(curTop)) curTop = sr.top;
    var delta = rr.top - sr.top;
    if (Math.abs(delta) >= 0.5) {
      seat.style.top = Math.round((curTop + delta) * 100) / 100 + 'px';
    }

    try {
      var c = getComputedStyle(right).color;
      if (c && lead.style.color !== c) lead.style.color = c;
    } catch (e) { /* 静默 */ }
  }

  var leadRaf = 0;
  function scheduleAlign() {
    if (leadRaf) return;
    leadRaf = requestAnimationFrame(function () {
      leadRaf = 0;
      try { alignLead(); } catch (e) { /* 静默 */ }
    });
  }

  function boot() {
    injectCss();
    sweepMask();
    scheduleAlign();
    var obs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) handleAdded(added[j]);
      }
      scheduleAlign();
    });
    obs.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', scheduleAlign);
    window.addEventListener('orientationchange', scheduleAlign);
    window.addEventListener('scroll', scheduleAlign, true);
    setInterval(function () {
      sweepMask();
      scheduleAlign();
      if (!drawerOpen()) return;
      var kids = document.body.children;
      for (var i = 0; i < kids.length; i++) {
        if (isPortalModal(kids[i])) { closeDrawer(); return; }
      }
    }, 1200);
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });
})();
