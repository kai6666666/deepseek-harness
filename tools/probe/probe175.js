/* ===== 探针 v6 (probe-175)：只量设置面板的祖先链与层级 ===== */
(function () {
  if (window.__mpProbe175) return;
  window.__mpProbe175 = true;
  var P = 'PROBE175';
  function send(tag, obj) {
    var s;
    try { s = JSON.stringify(obj); } catch (e) { s = '{"e":1}'; }
    if (s.length > 3800) s = s.slice(0, 3800) + '...';
    var line = P + '|' + tag + '|' + s;
    try { if (window.DSHAndroid && window.DSHAndroid.pageDiag) { window.DSHAndroid.pageDiag(line); return; } } catch (e) {}
    try { console.log(line); } catch (e) {}
  }
  function rc(el) { var r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; }
  function cd(el) {
    if (!el) return null;
    var c = getComputedStyle(el);
    return { t: el.tagName, c: String(el.className || '').slice(0, 50), p: c.position, z: c.zIndex, tf: String(c.transform).slice(0, 18), ov: c.overflow, r: rc(el) };
  }
  function chain(el, n) { var o = []; while (el && el.nodeType === 1 && o.length < n) { o.push(cd(el)); el = el.parentElement; } return o; }
  setTimeout(function () {
    var frame = document.querySelector('[data-sidebar-drawer]');
    if (frame && frame.hasAttribute('data-sidebar-collapsed')) {
      var op = document.querySelector('[data-sidebar-opener]') || document.querySelector('[data-sidebar-toggle]');
      if (op) op.click();
    }
    setTimeout(function () {
      var acc = document.querySelector('[aria-label="账号菜单"]');
      if (!acc) { send('noacc', {}); return; }
      acc.click();
      setTimeout(function () {
        var items = [].slice.call(document.querySelectorAll('[role="menuitem"], [role="menu"] button'));
        var hit = null;
        for (var i = 0; i < items.length; i++) if (String(items[i].textContent || '').trim() === '设置') { hit = items[i]; break; }
        if (!hit) { send('noitem', { n: items.length }); return; }
        hit.click();
        setTimeout(function () {
          var panel = document.querySelector('[class*="VOzbGW_panel"]') || document.querySelector('[role="dialog"][aria-modal="true"]:not([class*="hHd-Xa_root"])');
          if (!panel) { send('nopanel', {}); return; }
          var ov = panel.parentElement;
          send('panel', {
            self: cd(panel),
            overlay: cd(ov),
            chain: chain(ov, 8),
            bodyChildren: [].slice.call(document.body.children).map(function (e) { return String(e.className || e.tagName).slice(0, 40); }).slice(0, 10)
          });
        }, 1600);
      }, 700);
    }, 900);
  }, 9000);
})();