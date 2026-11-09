/* ===== 探针 PROBE190：面板页座位回归 + 点左上不跳会话 + 会话视图对齐 ===== */
(function () {
  if (window.__p190) return;
  window.__p190 = true;
  var P = 'PROBE190';
  function send(t, o) {
    var s; try { s = JSON.stringify(o); } catch (e) { s = '{}'; }
    if (s.length > 3800) s = s.slice(0, 3800) + '...';
    try { if (window.DSHAndroid && window.DSHAndroid.pageDiag) { window.DSHAndroid.pageDiag(P + '|' + t + '|' + s); return; } } catch (e) {}
    try { console.log(P + '|' + t + '|' + s); } catch (e) {}
  }
  function rc(el) { if (!el) return null; var r = el.getBoundingClientRect(); return [Math.round(r.left * 10) / 10, Math.round(r.top * 10) / 10, Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]; }
  function svgOf(el) { var s = el && el.querySelector('svg'); return s ? rc(s) : null; }
  function seat() { return document.querySelector('[class*="leadingSeat"]'); }
  function rightBtn() {
    var bs = document.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) if ((bs[i].getAttribute('aria-label') || '').indexOf('右侧边栏') >= 0) return bs[i];
    return null;
  }
  function drawerState() {
    var f = document.querySelector('[data-sidebar-drawer]');
    return f ? f.getAttribute('data-sidebar-collapsed') : null;
  }
  setTimeout(function () {
    var f = document.querySelector('[data-sidebar-drawer]');
    if (f && f.hasAttribute('data-sidebar-collapsed')) {
      var op = document.querySelector('[data-sidebar-opener]') || document.querySelector('[data-sidebar-toggle]');
      if (op) op.click();
    }
    setTimeout(function () {
      var rows = [].slice.call(document.querySelectorAll('nav button'));
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i].textContent || '').trim() === '插件') { rows[i].click(); break; }
      }
      setTimeout(function () {
        var s = seat(), nav = document.querySelector('.mp-nav-btn');
        var center = document.querySelector('[class*="centerCol"]');
        var head = document.querySelector('[class*="pageHead"]');
        send('panel', {
          seatD: s ? getComputedStyle(s).display : null, seatR: rc(s),
          navD: nav ? getComputedStyle(nav).display : null,
          padTop: center ? getComputedStyle(center).paddingTop : null,
          headR: rc(head), headTxt: (head ? head.textContent : '').trim().slice(0, 8),
          collapsed: drawerState()
        });
        var op = s ? s.querySelector('button') : null;
        if (op) op.click();
        setTimeout(function () {
          var h2 = document.querySelector('[class*="pageHead"]');
          send('after-open', {
            collapsed: drawerState(),
            stillPanel: !!h2,
            headTxt: (h2 ? h2.textContent : '').trim().slice(0, 8)
          });
          var t = document.querySelector('[data-sidebar-toggle]') || document.querySelector('[data-sidebar-opener]');
          if (t) t.click();
          setTimeout(function () {
            var rs = [].slice.call(document.querySelectorAll('[class*="sessionRow"]'));
            if (rs.length) rs[0].click();
            setTimeout(function () {
              var lead = document.querySelector('.mp-lead-btn'), right = rightBtn(), s2 = seat();
              send('session', {
                lead: rc(lead), leadSvg: svgOf(lead),
                right: rc(right), rightSvg: svgOf(right),
                dy: (lead && right) ? Math.round((rc(lead)[1] - rc(right)[1]) * 10) / 10 : null,
                seatD: s2 ? getComputedStyle(s2).display : null,
                headerLeading: !!document.querySelector('[data-conversation-header-leading]')
              });
            }, 2000);
          }, 900);
        }, 1100);
      }, 1600);
    }, 1000);
  }, 9500);
})();