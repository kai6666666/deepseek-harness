/* single-handle drawer-fix-v5 */
(function () {
  if (window.__mpDrawerFixV5) return;
  window.__mpDrawerFixV5 = true;
  var STYLE_ID = 'mp-drawer-fix-v5';
  var CSS = ''
    + 'html[data-mobile] body > [class*="overlay"]:has(> [role="dialog"][aria-modal="true"]){z-index:1000 !important;}'
    + 'html[data-mobile] body > [class*="overlay"]:has([role="dialog"][aria-modal="true"]){pointer-events:auto !important;}'
    + 'html[data-mobile] header[data-window-drag],html[data-mobile] header[class*="header"]{padding-left:52px !important;}'
    + 'html[data-mobile] [class*="leadingSeat"]{display:none !important;}'
    + 'html[data-mobile] .mp-lead-btn:not([data-mp-v5]){display:none !important;}'
    + 'html[data-mobile] .mp-lead-v5{position:fixed !important;left:8px !important;top:calc(var(--dsh-android-system-top,0px) + 8px) !important;z-index:65 !important;width:36px !important;height:36px !important;border:none !important;border-radius:8px !important;background:transparent !important;color:inherit !important;display:inline-flex !important;align-items:center !important;justify-content:center !important;padding:0 !important;cursor:pointer !important;}'
    + 'html[data-mobile] .mp-lead-v5 svg{width:15px !important;height:15px !important;transform:scaleX(-1) !important;}'
    + 'html[data-mobile] .mp-lead-v5.mp-lead-hidden{display:none !important;}'
    + 'html[data-mobile] [data-sidebar-right-open]{z-index:90 !important;}'
    + '[data-shortcut-modal="settings"] nav button[data-am-nav]::before{content:none !important;}';
  function injectCss() {
    var oldSt = document.getElementById('mp-drawer-fix-170');
    if (oldSt && oldSt.parentNode) oldSt.parentNode.removeChild(oldSt);
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style'); st.id = STYLE_ID; st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }
  var btn = null;
  function col() { return document.querySelector('[class*=pI_x6G_frame] > [class*=sidebarCol]') || document.querySelector('[class*="sidebarCol"]'); }
  function rightIconSvg() {
    var bs = document.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) {
      if ((bs[i].getAttribute('aria-label') || '').indexOf('右侧边栏') >= 0) {
        var svg = bs[i].querySelector('svg');
        if (svg) return svg.cloneNode(true);
      }
    }
    return null;
  }
  function hasOpenModal() {
    var ds = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
    for (var i = 0; i < ds.length; i++) {
      if ((ds[i].className && String(ds[i].className).indexOf('hHd-Xa_root') >= 0) || (ds[i].closest && ds[i].closest('[class*=sidebarCol]'))) {
        if (!ds[i].matches('[data-shortcut-modal="settings"], [data-shortcut-modal="shortcut-edit"], [class*="VOzbGW_panel"]')) continue;
      }
      var r = ds[i].getBoundingClientRect();
      if (r.width > 1 && r.height > 1) return true;
    }
    return false;
  }
  function ensureBtn() {
    if (!document.documentElement.hasAttribute('data-mobile')) {
      if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
      return;
    }
    var stale = document.querySelectorAll('.mp-lead-btn:not([data-mp-v5])');
    for (var i = 0; i < stale.length; i++) {
      try { stale[i].parentNode.removeChild(stale[i]); } catch (e) {}
    }
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mp-lead-v5';
      btn.setAttribute('data-mp-v5', '1');
      btn.setAttribute('aria-label', '打开侧边栏');
      btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2.2" stroke="currentColor" stroke-width="1.2"/><path d="M10.25 2.25v11.5" stroke="currentColor" stroke-width="1.2"/></svg>';
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
    if (!btn.dataset.mpCloned) {
      var rsvg = rightIconSvg();
      if (rsvg) {
        rsvg.setAttribute('width', '15'); rsvg.setAttribute('height', '15');
        btn.innerHTML = ''; btn.appendChild(rsvg); btn.dataset.mpCloned = '1';
      }
    }
    var c = col();
    var frame = document.querySelector('[class*=pI_x6G_frame]');
    var hide = (c && c.classList.contains('mp-drawer-open')) || (frame && frame.hasAttribute('data-rightbar-fullscreen')) || !!document.querySelector('[data-sidebar-right-open]') || hasOpenModal();
    btn.classList.toggle('mp-lead-hidden', !!hide);
    var cc = document.querySelector('.pI_x6G_centerCol');
    if (cc && cc.hasAttribute('inert')) cc.removeAttribute('inert');
    if (btn.parentElement !== document.body) document.body.appendChild(btn);
  }
  function boot() {
    injectCss();
    ensureBtn();
    setInterval(ensureBtn, 400);
    new MutationObserver(ensureBtn).observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['inert', 'class', 'data-rightbar-fullscreen', 'data-sidebar-right-open']
    });
  }
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot, { once: true });
})();
