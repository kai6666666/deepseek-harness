/* ===== 探针 PROBE182：官方左按钮 vs 官方右按钮的真实盒子模型 ===== */
(function () {
  if (window.__p182) return;
  window.__p182 = true;
  var P = 'PROBE182';
  function send(t, o) {
    var s; try { s = JSON.stringify(o); } catch (e) { s = '{}'; }
    if (s.length > 3800) s = s.slice(0, 3800) + '...';
    try { if (window.DSHAndroid && window.DSHAndroid.pageDiag) { window.DSHAndroid.pageDiag(P + '|' + t + '|' + s); return; } } catch (e) {}
    try { console.log(P + '|' + t + '|' + s); } catch (e) {}
  }
  function rc(el) { var r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; }
  function box(el) {
    if (!el) return null;
    var c = getComputedStyle(el);
    return {
      c: String(el.className || '').slice(0, 64), aria: el.getAttribute('aria-label'),
      r: rc(el), w: c.width, h: c.height, pad: c.padding, mar: c.margin,
      p: c.position, top: c.top, left: c.left, fs: c.fontSize, br: c.borderRadius, bg: c.backgroundColor
    };
  }
  function chain(el, n) { var o = []; while (el && el.nodeType === 1 && o.length < n) { o.push({ c: String(el.className || el.tagName).slice(0, 40), r: rc(el), pad: getComputedStyle(el).padding }); el = el.parentElement; } return o; }
  setTimeout(function () {
    var all = [].slice.call(document.querySelectorAll('button'));
    var left = all.find(function (b) {
      if (!b.querySelector('svg[data-icon="dsw-icon-panel-left-outline-regular"]')) return false;
      var r = b.getBoundingClientRect();
      return r.width > 0 && r.left < 160 && r.top < 140;
    });
    var right = null;
    all.some(function (b) {
      var a = b.getAttribute('aria-label') || '';
      if (/右侧边栏|收起右侧|打开右侧/.test(a)) { right = b; return true; }
      return false;
    });
    var burger = document.querySelector('.mp-nav-btn');
    send('cmp', {
      left: box(left), leftChain: left ? chain(left.parentElement, 3) : null,
      right: box(right), rightChain: right ? chain(right.parentElement, 3) : null,
      burger: box(burger), burgerInline: burger ? burger.getAttribute('style') : null,
      header: box(document.querySelector('.wSkVaW_header')),
      titleRow: box(document.querySelector('.wSkVaW_titleRow'))
    });
  }, 9000);
})();