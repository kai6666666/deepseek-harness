/* ===== 探针 v5 (probe-174)：账号菜单 → 「设置」→ 量抽屉与设置弹窗 ===== */
(function () {
  if (window.__mpProbe174) return;
  window.__mpProbe174 = true;
  var P = 'PROBE174';
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
    return { t: el.tagName, c: String(el.className || '').slice(0, 56), p: c.position, z: c.zIndex, tf: String(c.transform).slice(0, 22), ov: c.overflow, d: c.display, v: c.visibility, r: rc(el) };
  }
  function chain(el, n) { var o = []; while (el && el.nodeType === 1 && o.length < n) { o.push(cd(el)); el = el.parentElement; } return o; }
  function dialogs() {
    return [].slice.call(document.querySelectorAll('[role="dialog"]')).map(function (d) {
      var c = getComputedStyle(d);
      return { c: String(d.className).slice(0, 52), p: c.position, z: c.zIndex, tf: String(c.transform).slice(0, 20), am: d.getAttribute('aria-modal'), r: rc(d) };
    }).slice(0, 5);
  }
  function state(why, extra) {
    var col = document.querySelector('[class*="sidebarCol"]');
    var frame = col ? col.closest('[data-sidebar-drawer],[data-sidebar-collapsed]') : null;
    var o = {
      why: why, drawer: frame ? frame.getAttribute('data-sidebar-drawer') : null,
      collapsed: frame ? frame.getAttribute('data-sidebar-collapsed') : null,
      col: cd(col), dialogs: dialogs(), menus: document.querySelectorAll('[role="menu"]').length
    };
    if (extra) for (var k in extra) o[k] = extra[k];
    send('state', o);
  }
  function pickMenuItem() {
    var items = [].slice.call(document.querySelectorAll('[role="menuitem"], [role="menu"] button, [role="menu"] a'));
    for (var i = 0; i < items.length; i++) {
      var t = String(items[i].textContent || '').trim();
      if (t === '设置' || t === 'Settings') return { el: items[i], t: t };
    }
    return null;
  }
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
        var menu = document.querySelector('[role="menu"]');
        send('menu', {
          ok: !!menu,
          items: [].slice.call(document.querySelectorAll('[role="menuitem"], [role="menu"] button, [role="menu"] a')).map(function (b) {
            return { t: String(b.textContent || '').trim().slice(0, 12), a: b.getAttribute('aria-label'), c: String(b.className).slice(0, 36), r: rc(b) };
          }).slice(0, 12),
          menuD: menu ? cd(menu) : null
        });
        var hit = pickMenuItem();
        if (!hit) { send('nosettingsitem', {}); return; }
        hit.el.click();
        setTimeout(function () { state('t+600'); }, 600);
        setTimeout(function () { state('t+1800'); }, 1800);
        setTimeout(function () {
          var d = null;
          var ds = [].slice.call(document.querySelectorAll('[role="dialog"]')).filter(function (x) {
            var r = x.getBoundingClientRect();
            return r.width > 1 && !x.className.toString().indexOf('hHd-Xa') === 0;
          });
          for (var i = 0; i < ds.length; i++) { if (String(ds[i].className).indexOf('hHd-Xa_root') < 0) { d = ds[i]; break; } }
          state('t+3400', { settingsAncestors: d ? chain(d.parentElement, 7) : null, settingsSelf: d ? cd(d) : null });
        }, 3400);
      }, 700);
    }, 900);
  }, 9000);
})();