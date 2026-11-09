/* ===== 探针 v3 (probe-172)：把侧栏脚部与全部按钮的真实结构摊开 ===== */
(function () {
  if (window.__mpProbe172) return;
  window.__mpProbe172 = true;
  var P = 'PROBE172';
  function send(tag, obj) {
    var s;
    try { s = JSON.stringify(obj); } catch (e) { s = '{"e":1}'; }
    if (s.length > 3900) s = s.slice(0, 3900) + '...';
    var line = P + '|' + tag + '|' + s;
    try { if (window.DSHAndroid && window.DSHAndroid.pageDiag) { window.DSHAndroid.pageDiag(line); return; } } catch (e) {}
    try { console.log(line); } catch (e) {}
  }
  function rc(el) { var r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; }
  function bInfo(b) {
    return {
      a: (b.getAttribute('aria-label') || '').slice(0, 18),
      x: String(b.textContent || '').trim().slice(0, 12),
      c: String(b.className).slice(0, 44),
      r: rc(b),
      foot: !!b.closest('[class*="footArea"]')
    };
  }
  function tree(el, depth, out) {
    if (!el || el.nodeType !== 1 || out.length > 44 || depth > 3) return;
    out.push({ d: depth, t: el.tagName, c: String(el.className || '').slice(0, 46), a: (el.getAttribute && el.getAttribute('aria-label') || '').slice(0, 14) });
    if (depth === 3) return;
    [].slice.call(el.children).forEach(function (k) { tree(k, depth + 1, out); });
  }
  function dumpAll(tag) {
    var all = [].slice.call(document.querySelectorAll('button'));
    send(tag, {
      n: all.length,
      btns: all.map(bInfo),
      foot: (function () {
        var f = document.querySelector('[class*="footArea"]');
        var o = []; if (f) tree(f, 0, o); return o;
      })(),
      mobile: document.documentElement.hasAttribute('data-mobile')
    });
  }
  setTimeout(function () { dumpAll('all'); }, 9000);
})();