/* ===== 探针 PROBE183：左/右按钮内 svg 实际尺寸 + 进会话视图复测 ===== */
(function () {
  if (window.__p183) return;
  window.__p183 = true;
  var P = 'PROBE183';
  function send(t, o) {
    var s; try { s = JSON.stringify(o); } catch (e) { s = '{}'; }
    if (s.length > 3800) s = s.slice(0, 3800) + '...';
    try { if (window.DSHAndroid && window.DSHAndroid.pageDiag) { window.DSHAndroid.pageDiag(P + '|' + t + '|' + s); return; } } catch (e) {}
    try { console.log(P + '|' + t + '|' + s); } catch (e) {}
  }
  function rc(el) { if (!el) return null; var r = el.getBoundingClientRect(); return [Math.round(r.left * 10) / 10, Math.round(r.top * 10) / 10, Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]; }
  function pick() {
    var all = [].slice.call(document.querySelectorAll('button'));
    var left = all.find(function (b) {
      if (!b.querySelector('svg[data-icon="dsw-icon-panel-left-outline-regular"]')) return false;
      var r = b.getBoundingClientRect();
      return r.width > 0 && r.left < 160 && r.top < 140;
    });
    var right = null;
    all.some(function (b) {
      if (/右侧边栏/.test(b.getAttribute('aria-label') || '')) { right = b; return true; }
      return false;
    });
    return { left: left, right: right };
  }
  function snap(why) {
    var p = pick();
    var burger = document.querySelector('.mp-nav-btn');
    send('s', {
      why: why,
      leftBox: rc(p.left), leftSvg: p.left ? rc(p.left.querySelector('svg')) : null,
      leftAria: p.left ? p.left.getAttribute('aria-label') : null,
      rightBox: rc(p.right), rightSvg: p.right ? rc(p.right.querySelector('svg')) : null,
      burgerBox: rc(burger), burgerDisp: burger ? getComputedStyle(burger).display : null,
      burgerParent: burger ? String(burger.parentElement.className || burger.parentElement.tagName).slice(0, 26) : null,
      titleRow: !!document.querySelector('.wSkVaW_titleRow'),
      leadingSeat: rc(document.querySelector('[class*="leadingSeat"]'))
    });
  }
  setTimeout(function () {
    snap('hero');
    // 开抽屉点一个会话
    var f = document.querySelector('[data-sidebar-drawer]');
    if (f && f.hasAttribute('data-sidebar-collapsed')) {
      var op = document.querySelector('[data-sidebar-opener]') || document.querySelector('[data-sidebar-toggle]');
      if (op) op.click();
    }
    setTimeout(function () {
      var rows = [].slice.call(document.querySelectorAll('[class*="sessionRow"]'));
      if (!rows.length) { send('nosession', {}); return; }
      rows[0].click();
      setTimeout(function () { snap('after-session'); }, 2600);
    }, 900);
  }, 9000);
})();