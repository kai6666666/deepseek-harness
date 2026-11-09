/* ===== 回归探针 (probe-177)：设置→关闭→再开抽屉，验完整开合环 ===== */
(function () {
  if (window.__mpProbe177) return;
  window.__mpProbe177 = true;
  var P = 'PROBE177';
  function send(tag, obj) {
    var s; try { s = JSON.stringify(obj); } catch (e) { s = '{"e":1}'; }
    try { if (window.DSHAndroid && window.DSHAndroid.pageDiag) { window.DSHAndroid.pageDiag(P + '|' + tag + '|' + s); return; } } catch (e) {}
    try { console.log(P + '|' + tag + '|' + s); } catch (e) {}
  }
  function rc(el) { if (!el) return null; var r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; }
  function rep(why) {
    var f = document.querySelector('[data-sidebar-drawer]');
    var ov = document.querySelector('body > [class*="overlay"]');
    var panel = document.querySelector('[class*="VOzbGW_panel"]');
    send('r', {
      why: why,
      collapsed: f ? f.getAttribute('data-sidebar-collapsed') : null,
      col: rc(document.querySelector('[class*="sidebarCol"]')),
      ovZ: ov ? getComputedStyle(ov).zIndex : null,
      ovRect: rc(ov), panel: rc(panel),
      masks: document.querySelectorAll('body > .mp-drawer-mask').length
    });
  }
  function click(el) { if (el) { el.click(); return true; } return false; }
  setTimeout(function () {
    var opener = document.querySelector('[data-sidebar-opener]') || document.querySelector('[data-sidebar-toggle]');
    click(opener);
    setTimeout(function () {
      rep('drawer-open');
      click(document.querySelector('[aria-label="账号菜单"]'));
      setTimeout(function () {
        var items = [].slice.call(document.querySelectorAll('[role="menuitem"], [role="menu"] button'));
        var hit = null;
        for (var i = 0; i < items.length; i++) if (String(items[i].textContent || '').trim() === '设置') { hit = items[i]; break; }
        click(hit);
        setTimeout(function () {
          rep('settings-open');
          var close = document.querySelector('[class*="VOzbGW_close"]') || document.querySelector('[class*="VOzbGW_panel"] button[aria-label*="关闭"]');
          if (!close) {
            var bs = [].slice.call(document.querySelectorAll('[class*="VOzbGW_panel"] button'));
            for (var k = 0; k < bs.length; k++) if ((bs[k].getAttribute('aria-label') || '').indexOf('关闭') >= 0) { close = bs[k]; break; }
          }
          click(close);
          setTimeout(function () {
            rep('settings-closed');
            click(document.querySelector('[data-sidebar-opener]') || document.querySelector('[data-sidebar-toggle]'));
            setTimeout(function () { rep('reopen'); }, 900);
          }, 900);
        }, 1400);
      }, 700);
    }, 900);
  }, 9000);
})();