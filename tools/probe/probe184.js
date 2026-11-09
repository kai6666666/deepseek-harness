/* ===== 探针 PROBE184：报会话行坐标 + 轮询等“会话视图”再量按钮 ===== */
(function () {
  if (window.__p184) return;
  window.__p184 = true;
  var P = 'PROBE184';
  function send(t, o) {
    var s; try { s = JSON.stringify(o); } catch (e) { s = '{}'; }
    if (s.length > 3800) s = s.slice(0, 3800) + '...';
    try { if (window.DSHAndroid && window.DSHAndroid.pageDiag) { window.DSHAndroid.pageDiag(P + '|' + t + '|' + s); return; } } catch (e) {}
    try { console.log(P + '|' + t + '|' + s); } catch (e) {}
  }
  function rc(el) { if (!el) return null; var r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; }
  function pick() {
    var all = [].slice.call(document.querySelectorAll('button'));
    var left = all.find(function (b) {
      if (!b.querySelector('svg[data-icon="dsw-icon-panel-left-outline-regular"]')) return false;
      var r = b.getBoundingClientRect();
      return r.width > 0 && r.left < 160 && r.top < 140;
    });
    var right = null;
    all.some(function (b) { if (/右侧边栏/.test(b.getAttribute('aria-label') || '')) { right = b; return true; } return false; });
    return { left: left, right: right };
  }
  function snap(why) {
    var p = pick();
    var burger = document.querySelector('.mp-nav-btn');
    var hdr = document.querySelector('.wSkVaW_header');
    send('s', {
      why: why, titleRow: !!document.querySelector('.wSkVaW_titleRow'),
      header: rc(hdr), headerPad: hdr ? getComputedStyle(hdr).padding : null,
      leftBox: rc(p.left), leftSvg: p.left ? rc(p.left.querySelector('svg')) : null,
      leftParent: p.left ? String(p.left.parentElement.className || '').slice(0, 30) : null,
      rightBox: rc(p.right), rightSvg: p.right ? rc(p.right.querySelector('svg')) : null,
      rightParent: p.right ? String(p.right.parentElement.className || '').slice(0, 30) : null,
      burgerBox: rc(burger), burgerDisp: burger ? getComputedStyle(burger).display : null
    });
  }
  setTimeout(function () {
    // 先把抽屉里会话行的坐标报出来（供外部 input tap）
    var f = document.querySelector('[data-sidebar-drawer]');
    if (f && f.hasAttribute('data-sidebar-collapsed')) {
      var op = document.querySelector('[data-sidebar-opener]') || document.querySelector('[data-sidebar-toggle]');
      if (op) op.click();
    }
    setTimeout(function () {
      var rows = [].slice.call(document.querySelectorAll('[class*="sessionRow"]')).slice(0, 4);
      send('rows', { n: rows.length, r: rows.map(rc), t: rows.map(function (x) { return String(x.textContent || '').trim().slice(0, 12); }) });
      snap('hero');
      var t0 = Date.now();
      var iv = setInterval(function () {
        if (!document.querySelector('.wSkVaW_titleRow')) { clearInterval(iv); setTimeout(function () { snap('session'); }, 700); return; }
        if (Date.now() - t0 > 120000) { clearInterval(iv); snap('timeout'); }
      }, 500);
    }, 900);
  }, 9000);
})();