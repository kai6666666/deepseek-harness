/* ===== 验证探针 (probe-176)：走「账号菜单→设置」，验层级与抽屉收起 ===== */
(function () {
  if (window.__mpProbe176) return;
  window.__mpProbe176 = true;
  var P = 'PROBE176';
  function send(tag, obj) {
    var s;
    try { s = JSON.stringify(obj); } catch (e) { s = '{"e":1}'; }
    var line = P + '|' + tag + '|' + s;
    try { if (window.DSHAndroid && window.DSHAndroid.pageDiag) { window.DSHAndroid.pageDiag(line); return; } } catch (e) {}
    try { console.log(line); } catch (e) {}
  }
  function rc(el) { if (!el) return null; var r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; }
  function report(why) {
    var f = document.querySelector('[data-sidebar-drawer]');
    var ov = document.querySelector('body > [class*="overlay"]');
    var panel = document.querySelector('[class*="VOzbGW_panel"]') || document.querySelector('body > [class*="overlay"] [role="dialog"][aria-modal="true"]');
    send('r', {
      why: why,
      drawer: f ? f.getAttribute('data-sidebar-drawer') : null,
      collapsed: f ? f.getAttribute('data-sidebar-collapsed') : null,
      colRect: rc(document.querySelector('[class*="sidebarCol"]')),
      overlayZ: ov ? getComputedStyle(ov).zIndex : null,
      overlayRect: rc(ov),
      panelRect: rc(panel),
      fixInstalled: !!document.getElementById('mp-drawer-fix-170'),
      masks: document.querySelectorAll('body > .mp-drawer-mask').length,
      bodyKids: [].slice.call(document.body.children).map(function (e) { return String(e.className || e.tagName).slice(0, 26); })
    });
  }
  function openDrawerIfClosed() {
    var f = document.querySelector('[data-sidebar-drawer]');
    if (f && f.hasAttribute('data-sidebar-collapsed')) {
      var op = document.querySelector('[data-sidebar-opener]') || document.querySelector('[data-sidebar-toggle]');
      if (op) op.click();
    }
  }
  setTimeout(function () {
    openDrawerIfClosed();
    setTimeout(function () {
      report('drawer-open');
      var acc = document.querySelector('[aria-label="账号菜单"]');
      if (!acc) { send('noacc', {}); return; }
      acc.click();
      setTimeout(function () {
        var items = [].slice.call(document.querySelectorAll('[role="menuitem"], [role="menu"] button'));
        var hit = null;
        for (var i = 0; i < items.length; i++) if (String(items[i].textContent || '').trim() === '设置') { hit = items[i]; break; }
        if (!hit) { send('noitem', {}); return; }
        hit.click();
        setTimeout(function () { report('t+500'); }, 500);
        setTimeout(function () { report('t+1500'); }, 1500);
        setTimeout(function () { report('t+3000'); }, 3000);
      }, 700);
    }, 900);
  }, 9000);
})();