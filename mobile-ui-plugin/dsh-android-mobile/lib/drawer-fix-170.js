/* ===== mobile-ui 补丁（CI 打包前追加到 lib/client.js）=====
 *
 * A. 设置弹窗层级：portal 到 body 的模态(z=1000)被抽屉列(z=1100)压住 → 抬到 1200
 * B. 打开设置即收抽屉：portal 模态挂载时点一次官方 toggle
 * C. 清理遗留 .mp-drawer-mask
 * D. 左侧栏按钮：会话视图里改用 header 的布局体系（与右侧按钮同一串类名、15px 图标）
 *      ⚠️ 只能在「存在 [data-conversation-header-leading]（即会话视图）」时把官方浮动座位
 *         pI_x6G_leadingSeat 退场；面板页（插件/插件市场/自动化任务/任务看板/智能体）
 *         没有这个容器，必须把座位放回来 —— 否则插件会倒退回它自己的 40px 浮动汉堡：
 *           · pointerdown 就开抽屉 → 紧随的 click 落在抽屉「新建会话」上 → 跳回新会话（真机复现）
 *           · 浮动态写 --mp-float-nav-h=54px → 标题被推下 54px（真机复现：pageHead.y 102 → 48）
 * E. 多模态配置的双图标：照 dsh-market 的做法，不画自定义标记（只留 shell 齿轮）
 *
 * 真机实测依据（PROBE174/175/182/183/186/187/188/189）。
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

  function removeLeadButton() {
    if (mpLeadBtn && mpLeadBtn.parentNode) {
      try { mpLeadBtn.parentNode.removeChild(mpLeadBtn); } catch (e) { /* 静默 */ }
    }
  }

  function mountLeadButton(hold, right, seat) {
    var icon = seat ? seat.querySelector('button svg') : null;
    if (!mpLeadBtn) {
      mpLeadBtn = document.createElement('button');
      mpLeadBtn.type = 'button';
      mpLeadBtn.setAttribute('aria-label', '打开侧边栏');
      mpLeadBtn.addEventListener('click', onLeadClick, false);
    }
    var cls = right.className + ' mp-lead-btn';
    if (mpLeadBtn.className !== cls) mpLeadBtn.className = cls;

    var wantIcon = icon || mpLeadBtn.querySelector('svg');
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

  function syncLeadScope() {
    if (!document.documentElement.hasAttribute('data-mobile')) return;
    var seat = leadingSeat();
    if (!seat) return;
    var hold = headerLeading();
    if (!hold) {
      if (seat.style.display === 'none') seat.style.display = '';
      removeLeadButton();
      return;
    }
    var right = rightButton();
    if (!right) return;
    if (seat.style.display !== 'none') seat.style.display = 'none';
    mountLeadButton(hold, right, seat);
  }

  var leadRaf = 0;
  function scheduleLead() {
    if (leadRaf) return;
    leadRaf = requestAnimationFrame(function () {
      leadRaf = 0;
      try { syncLeadScope(); } catch (e) { /* 静默 */ }
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
