/* ===== 探针 PROBE180：左汉堡 vs 右按钮几何/父级；设置导航双图标 DOM ===== */
(function () {
  if (window.__p180) return;
  window.__p180 = true;
  var P = 'PROBE180';
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
    return { t: el.tagName, c: String(el.className || '').slice(0, 60), p: c.position, l: c.left, tp: c.top, z: c.zIndex, w: c.width, h: c.height, r: rc(el) };
  }
  function geo() {
    var burger = document.querySelector('.mp-nav-btn');
    var right = document.querySelector('[aria-label="打开右侧边栏"]');
    var opener = document.querySelector('[aria-label="打开侧边栏"]');
    var lead = document.querySelector('[data-conversation-header-leading]');
    send('geo', {
      vw: window.innerWidth, vh: window.innerHeight,
      sysTop: getComputedStyle(document.documentElement).getPropertyValue('--dsh-android-system-top').trim(),
      burger: d(burger),
      burgerInHeader: burger ? burger.classList.contains('mp-in-header') : null,
      burgerParent: burger ? String(burger.parentElement.className || burger.parentElement.tagName).slice(0, 50) : null,
      titleRow: !!document.querySelector('.wSkVaW_titleRow'),
      titleRowAny: !!document.querySelector('[class*="titleRow"]'),
      sessionHeader: !!document.querySelector('[class*="sessionHeader"]'),
      headerEl: d(document.querySelector('.wSkVaW_header') || document.querySelector('header')),
      leadingSeat: d(lead),
      opener: d(opener), openerParent: opener ? String(opener.parentElement.className || '').slice(0, 40) : null,
      right: d(right), rightParent: right ? String(right.parentElement.className || '').slice(0, 40) : null
    });
  }
  setTimeout(function () {
    geo();
    // 开抽屉 → 账号菜单 → 设置
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
            var kids = [].slice.call(b.children).map(function (k) { return k.tagName + '.' + String(k.className || '').slice(0, 26); });
            out.push({
              tagBlock: b.getAttribute('data-am-nav'),
              directSvg: b.querySelectorAll(':scope > svg').length,
              innerSvg: b.querySelectorAll('svg').length,
              navIconSpan: !!b.querySelector('[class*="navIcon"]'),
              kids: kids
            });
          });
          send('navcell', { n: out.length, rows: out });
        }, 1600);
      }, 700);
    }, 900);
  }, 9000);
})();