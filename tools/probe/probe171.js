/* ===== DSH 抽屉/设置 现场取证探针 v2 (probe-171) =====
 * v1 教训：`[role="dialog"]` 会先命中侧栏根节点（它自己就是 role=dialog），
 *          `[class*="settingsArea"] button` 首命中是「账号菜单」，都不是设置。
 * v2 改为：先枚举 footArea 里所有按钮（带 aria/文本/类名/矩形），再按文本精确点「设置」，
 *          并把所有 role=dialog 连同祖先链一起量出来。
 */
(function () {
  if (window.__mpProbe171) return;
  window.__mpProbe171 = true;
  var P = 'PROBE171';
  function send(tag, obj) {
    var s;
    try { s = JSON.stringify(obj); } catch (e) { s = '{"err":"json"}'; }
    if (s.length > 3800) s = s.slice(0, 3800) + '...';
    var line = P + '|' + tag + '|' + s;
    try { if (window.DSHAndroid && window.DSHAndroid.pageDiag) { window.DSHAndroid.pageDiag(line); return; } } catch (e) {}
    try { console.log(line); } catch (e) {}
  }
  function rc(el) { if (!el) return null; var r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; }
  function cd(el) {
    var c = getComputedStyle(el);
    return {
      t: el.tagName, c: String(el.className || '').slice(0, 80),
      p: c.position, z: c.zIndex, tf: String(c.transform).slice(0, 30),
      ov: c.overflow, ct: c.containerType || '', d: c.display, v: c.visibility, r: rc(el)
    };
  }
  function chain(el, n) { var o = []; while (el && el.nodeType === 1 && o.length < n) { o.push(cd(el)); el = el.parentElement; } return o; }
  function buttons() {
    return [].slice.call(document.querySelectorAll('[class*="footArea"] button, [class*="settingsArea"] button, [class*="panelList"] button')).map(function (b) {
      return { aria: b.getAttribute('aria-label'), txt: String(b.textContent || '').trim().slice(0, 14), c: String(b.className).slice(0, 56), r: rc(b) };
    }).slice(0, 16);
  }
  function dialogs() {
    return [].slice.call(document.querySelectorAll('[role="dialog"]')).map(function (d) {
      var c = getComputedStyle(d);
      return { c: String(d.className).slice(0, 64), p: c.position, z: c.zIndex, tf: String(c.transform).slice(0, 26), am: d.getAttribute('aria-modal'), r: rc(d) };
    }).slice(0, 6);
  }
  var lastSettings = null;
  function state(why) {
    var col = document.querySelector('[class*="sidebarCol"]');
    var frame = col ? col.closest('[data-sidebar-drawer],[data-sidebar-collapsed]') : null;
    send('state', {
      why: why, vw: window.innerWidth, vh: window.innerHeight,
      drawer: frame ? frame.getAttribute('data-sidebar-drawer') : null,
      collapsed: frame ? frame.getAttribute('data-sidebar-collapsed') : null,
      col: cd(col),
      dialogs: dialogs(),
      settingsAncestors: lastSettings ? chain(lastSettings.parentElement, 7) : null
    });
  }
  send('boot', { vw: window.innerWidth, vh: window.innerHeight, mobile: document.documentElement.hasAttribute('data-mobile'), buttons: buttons() });

  function findSettings() {
    var all = [].slice.call(document.querySelectorAll('button'));
    for (var i = 0; i < all.length; i++) {
      var b = all[i];
      var a = (b.getAttribute('aria-label') || '').trim();
      var t = String(b.textContent || '').trim();
      if (a === '设置' || a === '设置…' || t === '设置') return b;
    }
    return null;
  }
  function openDrawer(cb) {
    var frame = document.querySelector('[data-sidebar-drawer]');
    if (frame && frame.hasAttribute('data-sidebar-collapsed')) {
      var op = document.querySelector('[data-sidebar-opener]') || document.querySelector('[data-sidebar-toggle]');
      if (op) op.click();
    }
    setTimeout(cb, 600);
  }
  setTimeout(function () {
    openDrawer(function () {
      state('drawer-open');
      var b = findSettings();
      if (!b) { send('nosettings', { n: document.querySelectorAll('button').length }); return; }
      lastSettings = b;
      send('settingsBtn', { c: String(b.className).slice(0, 70), aria: b.getAttribute('aria-label'), r: rc(b) });
      b.click();
      setTimeout(function () { state('t+500'); }, 500);
      setTimeout(function () { state('t+1500'); }, 1500);
      setTimeout(function () { state('t+3000'); }, 3000);
    });
  }, 9000);
})();