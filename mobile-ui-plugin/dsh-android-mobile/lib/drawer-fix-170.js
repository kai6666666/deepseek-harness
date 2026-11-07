/* ===== mobile-ui 1.1.0-170：设置弹窗层级 + 打开设置即收抽屉 =====
 *
 * 真机实测（PROBE174/175，Xiaomi 25104RADAC / Android 16 / WebView 156 / rc.1）：
 *   ① 设置入口是「账号菜单」里的菜单项（menuitem 文本=设置），点击只调
 *      settings.actions.open()，从不经过官方的 selectPanel()
 *      （packages/client/ui-layout/src/client/stores.ts:96 才是 narrowExpanded=false
 *        —— 抽屉收起的源码级唯一开关）→ 所以只有设置不收抽屉。
 *   ② 设置弹窗被 portal 到 body：
 *        body > .VOzbGW_overlay(position:absolute, z-index:1000)
 *              > .VOzbGW_panel(position:fixed, z-index:1, 394x806 全屏)
 *      而 mobile-ui 把抽屉列抬到 z-index:1100 !important
 *      → 1000 < 1100 → 全屏设置面板被 320px 抽屉盖住 = 用户看到的「遮挡」。
 *   ③ body 里还躺着插件早年自建的 .mp-drawer-mask（原生抽屉模式下早就不该存在）。
 *
 * 修法（三刀，全部不碰 React）：
 *   A. 把「装模态的 body 直属 overlay」抬到 1200（> 抽屉 1100），恢复模态在上；
 *   B. 侦测到这类 portal 模态挂载 → 点一次官方 toggle 收抽屉（等价 selectPanel 的效果）；
 *   C. 原生抽屉模式下清掉遗留的 .mp-drawer-mask。
 *
 * 注意：不要隐藏 .hHd-Xa_root（它同时是侧栏与设置面板的根，会整屏白）。
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
  /* 这个节点是不是「portal 到 body 的模态容器」——不是侧栏内部的 role=dialog */
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
  /* 原生抽屉模式下，插件自建的遮罩是历史遗留：留着会盖住 portal 模态的点击 */
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

  function boot() {
    injectCss();
    sweepMask();
    var obs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) handleAdded(added[j]);
      }
    });
    obs.observe(document.body, { childList: true });
    /* 兜底：万一 observer 漏掉（模态在 body 观察开始前就已挂载） */
    setInterval(function () {
      sweepMask();
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
