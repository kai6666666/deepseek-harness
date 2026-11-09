/* ===== 探针 PROBE186：验证左右按钮对齐（顶边/尺寸/颜色）+ 抽屉-设置联动 ===== */
(function () {
  if (window.__p186) return;
  window.__p186 = true;
  var P = 'PROBE186';
  function send(t, o) {
    var s; try { s = JSON.stringify(o); } catch (e) { s = '{}'; }
    if (s.length > 3800) s = s.slice(0, 3800) + '...';
    try { if (window.DSHAndroid && window.DSHAndroid.pageDiag) { window.DSHAndroid.pageDiag(P + '|' + t + '|' + s); return; } } catch (e) {}
    try { console.log(P + '|' + t + '|' + s); } catch (e) {}
  }
  function rc(el) { if (!el) return null; var r = el.getBoundingClientRect(); return [Math.round(r.left * 10) / 10, Math.round(r.top * 10) / 10, Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]; }
  function svgBox(el) { var s = el && el.querySelector('svg'); return s ? rc(s) : null; }
  function rightBtn() {
    var bs = document.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) if ((bs[i].getAttribute('aria-label') || '').indexOf('右侧边栏') >= 0) return bs[i];
    return null;
  }
  function snap(why) {
    var seat = document.querySelector('[class*="leadingSeat"]');
    var left = seat ? seat.querySelector('button') : null;
    var right = rightBtn();
    send('cmp', {
      why: why,
      seat: rc(seat), seatTopInline: seat ? seat.style.top : null,
      left: rc(left), leftSvg: svgBox(left), leftColor: left ? getComputedStyle(left).color : null,
      right: rc(right), rightSvg: svgBox(right), rightColor: right ? getComputedStyle(right).color : null,
      dy: (left && right) ? Math.round((rc(left)[1] - rc(right)[1]) * 10) / 10 : null,
      fixMark: !!window.__mpDrawerFix170
    });
  }
  setTimeout(function () {
    snap('aligned');
    // 抽屉 → 账号菜单 → 设置：验 D 段没破坏 A/B 段
    var f = document.querySelector('[data-sidebar-drawer]');
    if (f && f.hasAttribute('data-sidebar-collapsed')) {
      var op = document.querySelector('[data-sidebar-opener]') || document.querySelector('[data-sidebar-toggle]');
      if (op) op.click();
    }
    setTimeout(function () {
      var acc = document.querySelector('[aria-label="账号菜单"]');
      if (acc) acc.click();
      setTimeout(function () {
        var items = [].slice.call(document.querySelectorAll('[role="menuitem"]'));
        for (var i = 0; i < items.length; i++) {
          if (String(items[i].textContent || '').trim() === '设置') { items[i].click(); break; }
        }
        setTimeout(function () {
          var f2 = document.querySelector('[data-sidebar-drawer]');
          var ov = document.querySelector('body > [class*="overlay"]');
          var panel = document.querySelector('[class*="VOzbGW_panel"]');
          send('settings', {
            collapsed: f2 ? f2.getAttribute('data-sidebar-collapsed') : null,
            overlayZ: ov ? getComputedStyle(ov).zIndex : null,
            panel: rc(panel),
            masks: document.querySelectorAll('body > .mp-drawer-mask').length
          });
        }, 1500);
      }, 700);
    }, 900);
  }, 9500);
})();