/* ===== 探针 PROBE185：验证左右按钮对齐（对比 rect / svg / color） ===== */
(function () {
  if (window.__p185) return;
  window.__p185 = true;
  var P = 'PROBE185';
  function send(t, o) {
    var s; try { s = JSON.stringify(o); } catch (e) { s = '{}'; }
    try { if (window.DSHAndroid && window.DSHAndroid.pageDiag) { window.DSHAndroid.pageDiag(P + '|' + t + '|' + s); return; } } catch (e) {}
    try { console.log(P + '|' + t + '|' + s); } catch (e) {}
  }
  function rc(el) { if (!el) return null; var r = el.getBoundingClientRect(); return [Math.round(r.left * 10) / 10, Math.round(r.top * 10) / 10, Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]; }
  function svgBox(el) { var s = el && el.querySelector('svg'); return s ? rc(s) : null; }
  setTimeout(function () {
    var seat = document.querySelector('[class*="leadingSeat"]');
    var left = seat ? seat.querySelector('button') : null;
    var right = null;
    var bs = document.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) { if ((bs[i].getAttribute('aria-label') || '').indexOf('右侧边栏') >= 0) { right = bs[i]; break; } }
    send('cmp', {
      seat: rc(seat), seatInlineTop: seat ? seat.style.top : null,
      left: rc(left), leftSvg: svgBox(left), leftColor: left ? getComputedStyle(left).color : null,
      right: rc(right), rightSvg: svgBox(right), rightColor: right ? getComputedStyle(right).color : null,
      dy: (left && right) ? Math.round((rc(left)[1] - rc(right)[1]) * 10) / 10 : null,
      fix: !!window.__mpDrawerFix170, alignFn: typeof window.alignLead
    });
  }, 9500);
})();