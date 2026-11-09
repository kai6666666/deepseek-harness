/* ===== DSH 抽屉/设置 现场取证探针 probe-170（临时，取证后即删） =====
 * 目的：把「点设置后抽屉不收」的真实几何/层叠/包含块一次性量出来。
 * 输出通道：window.DSHAndroid.pageDiag() → logcat（tag=DSH，前缀 PROBE170）
 * 采样点：boot → click(点击现场) → drawer-open → t+400 → t+1200 → t+2600
 */
(function () {
  if (window.__mpProbe170) return;
  window.__mpProbe170 = true;
  var P = 'PROBE170';
  function send(tag, obj) {
    var s;
    try { s = JSON.stringify(obj); } catch (e) { s = '{"err":"json"}'; }
    if (s.length > 3600) s = s.slice(0, 3600) + '...';
    var line = P + '|' + tag + '|' + s;
    try { if (window.DSHAndroid && window.DSHAndroid.pageDiag) { window.DSHAndroid.pageDiag(line); return; } } catch (e) {}
    try { console.log(line); } catch (e) {}
  }
  function R(el) { if (!el) return null; var r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; }
  function cls(el) { return el ? String(el.className || '').slice(0, 96) : ''; }
  function desc(el) {
    if (!el) return null;
    var c = getComputedStyle(el);
    return {
      t: el.tagName, c: cls(el), p: c.position, z: c.zIndex,
      tf: String(c.transform).slice(0, 36), ov: c.overflow,
      ct: c.containerType || '', d: c.display, v: c.visibility, r: R(el)
    };
  }
  function chain(el, n) { var out = []; while (el && el.nodeType === 1 && out.length < n) { out.push(desc(el)); el = el.parentElement; } return out; }
  function visibleDialogs() {
    return [].slice.call(document.querySelectorAll('[role="dialog"]')).filter(function (d) {
      var r = d.getBoundingClientRect(); return r.width > 1 && r.height > 1;
    });
  }
  function snapshot(why) {
    var col = document.querySelector('[class*="sidebarCol"]');
    var frame = col ? col.closest('[data-sidebar-drawer],[data-sidebar-collapsed]') : document.querySelector('[data-sidebar-collapsed]');
    var dlgs = visibleDialogs();
    var d = dlgs[0] || null;
    var trig = document.querySelector('[class*="settingsArea"] button') || document.querySelector('[class*="footArea"] button');
    send('snap', {
      why: why,
      vw: window.innerWidth, vh: window.innerHeight, dpr: window.devicePixelRatio,
      htmlMobile: document.documentElement.hasAttribute('data-mobile'),
      mpDrawerOpen: document.documentElement.hasAttribute('data-mp-drawer-open'),
      frameAttr: frame ? {
        c: cls(frame), drawer: frame.getAttribute('data-sidebar-drawer'),
        collapsed: frame.getAttribute('data-sidebar-collapsed'),
        instant: frame.getAttribute('data-sidebar-instant')
      } : null,
      col: desc(col),
      colHashPIX6G: !!document.querySelector('.pI_x6G_sidebarCol'),
      colXform: col ? String(getComputedStyle(col).transform) : null,
      colMask: !!document.querySelector('.mp-drawer-mask'),
      root: desc(document.querySelector('[class*="hHd-Xa_root"]') || document.querySelector('[class*="_root"]')),
      dialogCount: dlgs.length,
      dialog: d ? desc(d) : null,
      dialogAncestors: d ? chain(d.parentElement, 6) : null,
      trigger: trig ? {
        c: cls(trig), aria: trig.getAttribute('aria-label'),
        panelRow: !!trig.closest('[class*="panelRow"]'),
        inPanelList: !!trig.closest('[class*="panelList"]'),
        inFootArea: !!trig.closest('[class*="footArea"]')
      } : null
    });
  }
  window.__probe170Snap = snapshot;

  send('boot', {
    vw: window.innerWidth, vh: window.innerHeight,
    mobile: document.documentElement.hasAttribute('data-mobile'), ready: document.readyState
  });

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!(t instanceof Element)) return;
    var b = t.closest('button') || t;
    send('click', {
      tag: b.tagName, c: cls(b),
      aria: b.getAttribute ? b.getAttribute('aria-label') : null,
      txt: String(b.textContent || '').trim().slice(0, 24),
      panelRow: !!b.closest('[class*="panelRow"]'),
      inPanelList: !!b.closest('[class*="panelList"]'),
      inFootArea: !!b.closest('[class*="footArea"]'),
      inSettingsArea: !!b.closest('[class*="settingsArea"]')
    });
  }, true);

  function ensureOpen(cb) {
    var opener = document.querySelector('[data-sidebar-opener]');
    var frame = document.querySelector('[data-sidebar-drawer]');
    if (frame && frame.hasAttribute('data-sidebar-collapsed') && opener) opener.click();
    setTimeout(function () {
      var f2 = document.querySelector('[data-sidebar-drawer]');
      if (f2 && f2.hasAttribute('data-sidebar-collapsed')) {
        var tg = document.querySelector('[data-sidebar-toggle]');
        if (tg) tg.click();
      }
      setTimeout(cb, 500);
    }, 500);
  }

  setTimeout(function () {
    ensureOpen(function () {
      snapshot('drawer-open');
      var btn = document.querySelector('[class*="settingsArea"] button');
      if (!btn) { send('nosettings', { foot: !!document.querySelector('[class*="footArea"]') }); return; }
      btn.click();
      setTimeout(function () { snapshot('t+400'); }, 400);
      setTimeout(function () { snapshot('t+1200'); }, 1200);
      setTimeout(function () { snapshot('t+2800'); }, 2800);
    });
  }, 9000);
})();
