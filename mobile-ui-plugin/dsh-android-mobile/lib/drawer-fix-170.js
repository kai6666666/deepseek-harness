/* ===== DSH Android 1.1.0-170：抽屉选择器迁移（打包前由 CI 追加到 lib/client.js）=====
 *
 * 真机实测（2026-11-07，Xiaomi 25104RADAC / Android 16 / WebView 156）：
 *   侧栏抽屉祖先链：BUTTON.hHd-Xa_panelRow > NAV.hHd-Xa_panelList > DIV.hHd-Xa_root
 *   → rc.1 的抽屉根是 `.hHd-Xa_root`，并自带 `role="dialog" aria-modal="true"`；
 *     而**设置弹窗共用同一个根类**，所以不能直接按类名隐藏。
 *   → 旧版 mobile-ui 里那套 `[data-pane="sidebar"]` 规则在 rc.1 命中数为 0（DOM 改名），
 *     这就是「点侧栏的设置后抽屉不收起、直接把设置界面压住」的根因。
 *
 * 两者结构差异：侧栏 root 内含 NAV[class*="panelList"]；设置面板不含。
 * WebView 156（Chrome 156）支持 :has()，于是：
 *   ① 收起态 + 含 panelList → 整块不显示（真抽屉）；
 *   ② 展开态 + 含 panelList → 正常 flex；
 *   ③ 不含 panelList 的全屏面板（设置等）→ 抬到顶格 z-index + 不透明底，永不被压。
 * 另加一条点击兜底：点抽屉内任何一项就把 html[data-sidebar-collapsed] 置 true。
 */
(function () {
  if (window.__mpDrawerFix170) return;
  window.__mpDrawerFix170 = true;

  try {
    if (!document.getElementById('mp-drawer-fix170')) {
      var st = document.createElement('style');
      st.id = 'mp-drawer-fix170';
      st.textContent = [
        'html[data-sidebar-collapsed="true"] .hHd-Xa_root:has([class*="panelList"]){display:none !important;pointer-events:none !important;}',
        'html[data-sidebar-collapsed="false"] .hHd-Xa_root:has([class*="panelList"]){display:flex !important;}',
        '.hHd-Xa_root:not(:has([class*="panelList"])){z-index:2147483000 !important;background:#111418 !important;box-shadow:0 0 0 100vmax #111418 !important;}'
      ].join('');
      (document.head || document.documentElement).appendChild(st);
    }
  } catch (e) {}

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    if (!t.closest('.hHd-Xa_root')) return;
    try {
      document.documentElement.setAttribute('data-sidebar-collapsed', 'true');
    } catch (e) {}
  }, true);
})();
