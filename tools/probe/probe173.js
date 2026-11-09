/* ===== 探针 v4 (probe-173)：先看清侧栏脚部长什么样，再精确点「设置」 ===== */
(function () {
  if (window.__mpProbe173) return;
  window.__mpProbe173 = true;
  var P = 'PROBE173';
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
    return { t: el.tagName, c: String(el.className || '').slice(0, 60), p: c.position, z: c.zIndex, tf: String(c.transform).slice(0, 24), ov: c.overflow, d: c.display, v: c.visibility, r: rc(el) };
  }
  function chain(el, n) { var o = []; while (el && el.nodeType === 1 && o.length < n) { o.push(cd(el)); el = el.parentElement; } return o; }
  function dialogs() {
    return [].slice.call(document.querySelectorAll('[role="dialog"]')).map(function (d) {
      var c = getComputedStyle(d);
      return { c: String(d.className).slice(0, 56), p: c.position, z: c.zIndex, tf: String(c.transform).slice(0, 22), am: d.getAttribute('aria-modal'), r: rc(d) };
    }).slice(0, 5);
  }
  function findSettings() {
    var byAria = document.querySelector('[aria-label="设置"]');
    if (byAria) return byAria;
    var all = [].slice.call(document.querySelectorAll('*'));
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.childElementCount === 0 && String(el.textContent || '').trim() === '设置') {
        var b = el.closest('button, [role="button"], a');
        if (b) return b;
      }
    }
    return null;
  }
  function state(why, extra) {
    var col = document.querySelector('[class*="sidebarCol"]');
    var frame = col ? col.closest('[data-sidebar-drawer],[data-sidebar-collapsed]') : null;
    var o = {
      why: why, vw: window.innerWidth, vh: window.innerHeight,
      drawer: frame ? frame.getAttribute('data-sidebar-drawer') : null,
      collapsed: frame ? frame.getAttribute('data-sidebar-collapsed') : null,
      col: cd(col), dialogs: dialogs()
    };
    if (extra) for (var k in extra) o[k] = extra[k];
    send('state', o);
  }
  function openDrawer(cb) {
    var frame = document.querySelector('[data-sidebar-drawer]');
    if (frame && frame.hasAttribute('data-sidebar-collapsed')) {
      var op = document.querySelector('[data-sidebar-opener]') || document.querySelector('[data-sidebar-toggle]');
      if (op) op.click();
    }
    setTimeout(cb, 800);
  }
  setTimeout(function () {
    openDrawer(function () {
      var foot = document.querySelector('[class*="footArea"]');
      send('foot', { html: foot ? foot.innerHTML.replace(/\\s+/g, ' ').slice(0, 1500) : 'NO_FOOT' });
      var b = findSettings();
      send('found', { ok: !!b, d: b ? cd(b) : null, anc: b ? chain(b.parentElement, 3) : null });
      state('drawer-open');
      if (!b) return;
      b.click();
      setTimeout(function () { state('t+600'); }, 600);
      setTimeout(function () { state('t+1600'); }, 1600);
      setTimeout(function () { state('t+3200'); }, 3200);
    });
  }, 9000);
})();