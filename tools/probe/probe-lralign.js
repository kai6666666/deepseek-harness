/* 探针 LRALIGN：量会话视图左上/右上按钮的几何、类名与排版属性 */
(function () {
  function rect(el) {
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return [Math.round(r.left * 10) / 10, Math.round(r.top * 10) / 10,
            Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10];
  }
  function info(el, sel) {
    if (!el) return { sel: sel, found: false };
    var cs = getComputedStyle(el);
    var svg = el.querySelector('svg');
    var sr = svg ? svg.getBoundingClientRect() : null;
    return {
      sel: sel,
      found: true,
      cls: (el.className || '').toString().slice(0, 120),
      rect: rect(el),
      svg: sr ? [Math.round(sr.width * 10) / 10, Math.round(sr.height * 10) / 10] : null,
      pad: cs.padding,
      font: cs.fontSize + '/' + cs.lineHeight,
      radius: cs.borderRadius,
      top: cs.top,
      position: cs.position,
      display: cs.display,
      align: cs.alignItems,
    };
  }
  var lead = document.querySelector('[data-conversation-header-leading]');
  var leftBtn = lead ? lead.querySelector('button') : null;
  var rightBtn = document.querySelector('.wSkVaW_headerCorner button') ||
                 document.querySelector('[class*="headerCorner"] button');
  var seat = document.querySelector('[class*="leadingSeat"]');

  var out = {
    probe: 'LRALIGN',
    hasLead: !!lead,
    left: info(leftBtn, 'lead button'),
    right: info(rightBtn, 'headerCorner button'),
    seatDisplay: seat ? getComputedStyle(seat).display : null,
    dpr: window.devicePixelRatio,
  };
  if (out.left.found && out.right.found) {
    out.dyTop = Math.round((out.left.rect[1] - out.right.rect[1]) * 10) / 10;
    out.dyH = Math.round((out.left.rect[3] - out.right.rect[3]) * 10) / 10;
    out.dyW = Math.round((out.left.rect[2] - out.right.rect[2]) * 10) / 10;
    out.dySvg = out.left.svg && out.right.svg
      ? Math.round((out.left.svg[0] - out.right.svg[0]) * 10) / 10 : null;
  }
  console.log('[LRALIGN] ' + JSON.stringify(out));
})();
