/* ===== 探针 PROBE188：面板页（插件）上的左上按钮 / 标题留白 ===== */
(function () {
  if (window.__p188) return;
  window.__p188 = true;
  var P = 'PROBE188';
  function send(t, o) {
    var s; try { s = JSON.stringify(o); } catch (e) { s = '{}'; }
    if (s.length > 3800) s = s.slice(0, 3800) + '...';
    try { if (window.DSHAndroid && window.DSHAndroid.pageDiag) { window.DSHAndroid.pageDiag(P + '|' + t + '|' + s); return; } } catch (e) {}
    try { console.log(P + '|' + t + '|' + s); } catch (e) {}
  }
  function rc(el) { if (!el) return null; var r = el.getBoundingClientRect(); return [Math.round(r.left * 10) / 10, Math.round(r.top * 10) / 10, Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]; }
  function desc(el) {
    if (!el) return null;
    return { t: el.tagName, c: String(el.className || '').slice(0, 60), aria: el.getAttribute && el.getAttribute('aria-label'), r: rc(el) };
  }
  function at(x, y) {
    var el = document.elementFromPoint(x, y);
    var b = el && el.closest ? el.closest('button,a,[role="button"]') : null;
    return { hit: desc(el), btn: desc(b) };
  }
  function snap(why) {
    var center = document.querySelector('[class*="centerCol"]');
    var cs = center ? getComputedStyle(center) : null;
    var fl = document.documentElement;
    var nav = document.querySelector('.mp-nav-btn');
    var lead = document.querySelector('.mp-lead-btn');
    var hold = document.querySelector('[data-conversation-header-leading]');
    var seat = document.querySelector('[class*="leadingSeat"]');
    var head = document.querySelector('[class*="pageHead"]');
    send('snap', {
      why: why,
      mpNavBtn: nav ? { d: getComputedStyle(nav).display, c: String(nav.className), r: rc(nav) } : null,
      mpLeadBtn: lead ? { r: rc(lead), c: String(lead.className).slice(0, 50) } : null,
      headerLeading: !!hold, seatDisplay: seat ? getComputedStyle(seat).display : null,
      centerPadTop: cs ? cs.paddingTop : null,
      floatNavH: fl.style.getPropertyValue('--mp-float-nav-h') || getComputedStyle(fl).getPropertyValue('--mp-float-nav-h'),
      pageHead: desc(head),
      at26_25: at(26, 25),
      at20_80: at(20, 80),
      hash: location.hash,
      titleText: (head ? head.textContent : '').trim().slice(0, 24)
    });
  }
  setTimeout(function () {
    var f = document.querySelector('[data-sidebar-drawer]');
    if (f && f.hasAttribute('data-sidebar-collapsed')) {
      var op = document.querySelector('[data-sidebar-opener]') || document.querySelector('[data-sidebar-toggle]');
      if (op) op.click();
    }
    setTimeout(function () {
      var rows = [].slice.call(document.querySelectorAll('nav button'));
      var hit = null;
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i].textContent || '').trim() === '插件') { hit = rows[i]; break; }
      }
      if (!hit) { send('norow', {}); return; }
      hit.click();
      setTimeout(function () {
        snap('panel-plugins');
        var b = at(26, 25).btn;
        var target = b ? document.querySelector('button[aria-label="' + (b.aria || '') + '"]') : null;
        send('clicking', { aria: b ? b.aria : null });
        if (target) target.click();
        setTimeout(function () { snap('after-click-top-left'); }, 900);
      }, 1800);
    }, 1000);
  }, 9500);
})();