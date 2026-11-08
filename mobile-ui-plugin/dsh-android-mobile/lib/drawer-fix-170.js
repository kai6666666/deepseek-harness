/* ===== mobile-ui 补丁（CI 打包前追加到 lib/client.js）=====
 *
 * A. 设置弹窗层级：portal 到 body 的模态(z=1000)被抽屉列(z=1100)压住 → 抬到 1200
 * B. 打开设置即收抽屉：portal 模态挂载时点一次官方 toggle
 * C. 清理遗留 .mp-drawer-mask
 * D. 左侧栏按钮：完全采用右侧栏按钮的布局体系
 *      - 官方浮动座位 pI_x6G_leadingSeat 退场（display:none）
 *      - 在 wSkVaW_headerLeading（header grid 第 1 列）里建按钮，类名复用右侧按钮
 *      - 图标 15×15（与右侧实测一致），CSS !important 抗 React 重写
 *      - 点击走官方 [data-sidebar-toggle]
 * E. 多模态配置的双图标：按 dsh-market 的做法，不画自定义标记
 *      - agnes 用 ::before 画自己的图案、又想藏掉齿轮，但 rc.1 把齿轮包进 span.navIcon，
 *        它的 `> svg:first-child` 藏不掉 → 双图标。这里直接 content:none，只留 shell 的 fallback。
 *
 * 真机实测依据（PROBE174/175/182/183/186）：
 *   设置 overlay  : body > .VOzbGW_overlay absolute z=1000 > .VOzbGW_panel fixed z=1 (394×806)
 *   抽屉列        : DIV.pI_x6G_sidebarCol fixed z=1100
 *   左按钮(旧)    : .pI_x6G_leadingSeat 绝对 top:11 → box=[12,11,28,28] svg16
 *   右按钮        : .wSkVaW_headerCorner 内 _sm 按钮 → box=[354,22.3,28,28] svg15
 *   header        : grid `auto minmax(0,1fr)`，padding 4px 12px 4px 60px（60 是本插件留的）
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
    + '}\n'
    + 'html[data-mobile] .wSkVaW_header,html[data-mobile] header[class*="header"]{'
    + 'padding-left:20px !important;'
    + '}\n'
    + 'html[data-mobile] [data-conversation-header-leading] button svg,'
    + 'html[data-mobile] button[aria-label*="右侧边栏"] svg{'
    + 'width:15px !important;height:15px !important;'
    + '}\n'
    + '[data-shortcut-modal="settings"] nav button[data-am-nav]::before{'
    + 'content:none !important;'
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
  function drawerToggle() {
    return document.querySelector('[data-sidebar-toggle]')
      || document.querySelector('[data-sidebar-opener]');
  }
  function closeDrawer() {
    var f = frameDrawer();
    if (!f || f.hasAttribute('data-sidebar-collapsed')) return false;
    var t = drawerToggle();
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

  function headerLeading() { return document.querySelector('[data-conversation-header-leading]'); }
  function leadingSeat() { return document.querySelector('[class*="leadingSeat"]'); }
  function rightButton() {
    var bs = document.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) {
      if ((bs[i].getAttribute('aria-label') || '').indexOf('右侧边栏') >= 0) return bs[i];
    }
    return null;
  }
  var mpLeadBtn = null;

  function onLeadClick(e) {
    try { e.preventDefault(); e.stopPropagation(); } catch (err) { /* 静默 */ }
    var t = drawerToggle();
    if (t) t.click();
  }

  function ensureLeadButton() {
    if (!document.documentElement.hasAttribute('data-mobile')) return;
    var hold = headerLeading();
    var right = rightButton();
    if (!hold || !right) return;

    var seat = leadingSeat();
    var icon = seat ? seat.querySelector('button svg') : null;
    if (seat && seat.style.display !== 'none') seat.style.display = 'none';

    if (!mpLeadBtn) {
      mpLeadBtn = document.createElement('button');
      mpLeadBtn.type = 'button';
      mpLeadBtn.setAttribute('aria-label', '打开侧边栏');
      mpLeadBtn.addEventListener('click', onLeadClick, false);
    }
    var cls = right.className + ' mp-lead-btn';
    if (mpLeadBtn.className !== cls) mpLeadBtn.className = cls;

    var wantIcon = icon || (mpLeadBtn.querySelector('svg'));
    if (wantIcon && (!mpLeadBtn.firstChild || mpLeadBtn.getAttribute('data-mp-icon') !== 'left')) {
      var clone = wantIcon.cloneNode(true);
      clone.setAttribute('width', '15');
      clone.setAttribute('height', '15');
      try { clone.style.width = '15px'; clone.style.height = '15px'; } catch (e) { /* 静默 */ }
      mpLeadBtn.innerHTML = '';
      mpLeadBtn.appendChild(clone);
      mpLeadBtn.setAttribute('data-mp-icon', 'left');
    }

    if (mpLeadBtn.parentElement !== hold) hold.insertBefore(mpLeadBtn, hold.firstChild);
  }

  var leadRaf = 0;
  function scheduleLead() {
    if (leadRaf) return;
    leadRaf = requestAnimationFrame(function () {
      leadRaf = 0;
      try { ensureLeadButton(); } catch (e) { /* 静默 */ }
    });
  }

  function boot() {
    injectCss();
    sweepMask();
    scheduleLead();
    var obs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) handleAdded(added[j]);
      }
      scheduleLead();
    });
    obs.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', scheduleLead);
    window.addEventListener('orientationchange', scheduleLead);
    setInterval(function () {
      sweepMask();
      scheduleLead();
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
