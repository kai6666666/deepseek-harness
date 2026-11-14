/* single-handle drawer-fix-170 */
(function () {
  if (window.__mpDrawerFix170) return;
  window.__mpDrawerFix170 = true;
  var STYLE_ID = 'mp-drawer-fix-170';
  var CSS = ''
    + 'html[data-mobile] body > [class*="overlay"]:has(> [role="dialog"][aria-modal="true"]){z-index:1200 !important;}'
    + 'html[data-mobile] body > [class*="overlay"]:has([role="dialog"][aria-modal="true"]){pointer-events:auto !important;}'
    + 'html[data-mobile] header[data-window-drag],html[data-mobile] header[class*="header"]{padding-left:52px !important;}'
    + 'html[data-mobile] [class*="leadingSeat"]{display:none !important;}'
    + 'html[data-mobile] .mp-lead-btn{position:fixed !important;left:8px !important;top:calc(var(--dsh-android-system-top,0px) + 8px) !important;z-index:2147483000 !important;width:36px !important;height:36px !important;border:none !important;border-radius:8px !important;background:transparent !important;color:inherit !important;display:inline-flex !important;align-items:center !important;justify-content:center !important;padding:0 !important;cursor:pointer !important;}'
    + '[data-shortcut-modal="settings"] nav button[data-am-nav]::before{content:none !important;}';
  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style'); st.id = STYLE_ID; st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }
  var btn = null;
  function col() { return document.querySelector('[data-dsh-frame] > [data-pane=sidebar]') || document.querySelector('[class*="sidebarCol"]'); }
  function ensureBtn() {
    if (!document.documentElement.hasAttribute('data-mobile')) {
      if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
      return;
    }
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mp-lead-btn';
      btn.setAttribute('aria-label', '打开侧边栏');
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M6 2.5v11" stroke="currentColor" stroke-width="1.4"/></svg>';
      btn.addEventListener('click', function (e) {
        try { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); } catch (err) {}
        var c = col();
        if (!c) return;
        var next = !c.classList.contains('mp-drawer-open');
        if (window.__mpSetDrawerVisual) { window.__mpSetDrawerVisual(next); return; }
        var t = document.querySelector('[data-sidebar-toggle],[data-sidebar-opener]');
        if (t) t.click();
      }, true);
    }
    if (btn.parentElement !== document.body) document.body.appendChild(btn);
  }
  function boot() { injectCss(); ensureBtn(); setInterval(ensureBtn, 400); new MutationObserver(ensureBtn).observe(document.body, { childList: true, subtree: true }); }
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot, { once: true });
})();
