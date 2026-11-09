/* ===== 探针 PROBE187：左按钮是否入 header / 双图标是否消失 ===== */
(function () {
  if (window.__p187) return;
  window.__p187 = true;
  var P = 'PROBE187';
  function send(t, o) {
    var s; try { s = JSON.stringify(o); } catch (e) { s = '{}'; }
    if (s.length > 3800) s = s.slice(0, 3800) + '...';
    try { if (window.DSHAndroid && window.DSHAndroid.pageDiag) { window.DSHAndroid.pageDiag(P + '|' + t + '|' + s); return; } } catch (e) {}
    try { console.log(P + '|' + t + '|' + s); } catch (e) {}
  }
  function rc(el) { if (!el) return null; var r = el.getBoundingClientRect(); return [Math.round(r.left * 10) / 10, Math.round(r.top * 10) / 10, Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]; }
  function svgOf(el) { var s = el && el.querySelector('svg'); return s ? rc(s) : null; }
  function leadBtn() { return document.querySelector('.mp-lead-btn'); }
  function rightBtn() {
    var bs = document.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) if ((bs[i].getAttribute('aria-label') || '').indexOf('右侧边栏') >= 0) return bs[i];
    return null;
  }
  function seat() { return document.querySelector('[class*="leadingSeat"]'); }
  function headerLead() { return document.querySelector('[data-conversation-header-leading]'); }

  setTimeout(function () {
    var l = leadBtn(), r = rightBtn(), s = seat(), h = headerLead();
    var hdr = document.querySelector('.wSkVaW_header') || document.querySelector('header');
    send('lead', {
      lead: rc(l), leadCls: l ? String(l.className).slice(0, 100) : null, leadSvg: svgOf(l),
      right: rc(r), rightSvg: svgOf(r),
      seatDisplay: s ? getComputedStyle(s).display : null,
      headerLead: rc(h), headerLeadKids: h ? h.children.length : null,
      headerPadLeft: hdr ? getComputedStyle(hdr).paddingLeft : null,
      dy: (l && r) ? Math.round((rc(l)[1] - rc(r)[1]) * 10) / 10 : null
    });

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
          var cells = [].slice.call(document.querySelectorAll('nav button'));
          var out = [];
          cells.forEach(function (b) {
            if (String(b.textContent || '').indexOf('多模态') < 0) return;
            var before = '';
            try { before = getComputedStyle(b, '::before').content; } catch (e) { /* 静默 */ }
            out.push({
              txt: String(b.textContent || '').trim().slice(0, 8),
              am: b.getAttribute('data-am-nav'),
              before: before,
              svg: b.querySelectorAll('svg').length,
              kids: [].slice.call(b.children).map(function (k) { return k.tagName; })
            });
          });
          var f2 = document.querySelector('[data-sidebar-drawer]');
          var ov = document.querySelector('body > [class*="overlay"]');
          send('cell', {
            n: out.length, rows: out,
            collapsed: f2 ? f2.getAttribute('data-sidebar-collapsed') : null,
            overlayZ: ov ? getComputedStyle(ov).zIndex : null
          });
        }, 1600);
      }, 700);
    }, 900);
  }, 9500);
})();