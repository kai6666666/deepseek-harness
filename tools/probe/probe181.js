/* ===== 探针 PROBE181：进「会话视图」后量汉堡 vs 右按钮 ===== */
(function () {
  if (window.__p181) return;
  window.__p181 = true;
  var P = 'PROBE181';
  function send(t, o) {
    var s; try { s = JSON.stringify(o); } catch (e) { s = '{}'; }
    if (s.length > 3600) s = s.slice(0, 3600) + '...';
    try { if (window.DSHAndroid && window.DSHAndroid.pageDiag) { window.DSHAndroid.pageDiag(P + '|' + t + '|' + s); return; } } catch (e) {}
    try { console.log(P + '|' + t + '|' + s); } catch (e) {}
  }
  function rc(el) { if (!el) return null; var r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; }
  function d(el) {
    if (!el) return null;
    var c = getComputedStyle(el);
    return { t: el.tagName, c: String(el.className || '').slice(0, 54), p: c.position, l: c.left, tp: c.top, dsp: c.display, w: c.width, h: c.height, r: rc(el) };
  }
  function geo(why) {
    var burger = document.querySelector('.mp-nav-btn');
    var right = document.querySelector('[aria-label="打开右侧边栏"]');
    send('geo', {
      why: why,
      burger: d(burger),
      inHeader: burger ? burger.classList.contains('mp-in-header') : null,
      burgerParent: burger ? String(burger.parentElement.className || burger.parentElement.tagName).slice(0, 40) : null,
      titleRow: !!document.querySelector('.wSkVaW_titleRow'),
      titleRowRect: rc(document.querySelector('.wSkVaW_titleRow')),
      header: d(document.querySelector('.wSkVaW_header')),
      right: d(right),
      rightParent: right ? String(right.parentElement.className || right.parentElement.tagName).slice(0, 40) : null,
      rightGrand: right && right.parentElement ? String(right.parentElement.parentElement.className || '').slice(0, 40) : null
    });
  }
  setTimeout(function () {
    var f = document.querySelector('[data-sidebar-drawer]');
    if (f && f.hasAttribute('data-sidebar-collapsed')) {
      var op = document.querySelector('[data-sidebar-opener]') || document.querySelector('[data-sidebar-toggle]');
      if (op) op.click();
    }
    setTimeout(function () {
      var rows = [].slice.call(document.querySelectorAll('[class*="sessionRow"]'));
      if (!rows.length) { send('nosession', {}); geo('no-session'); return; }
      rows[0].click();
      setTimeout(function () { geo('session-view'); }, 1200);
    }, 900);
  }, 9000);
})();