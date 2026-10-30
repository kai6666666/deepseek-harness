/*
 * 下拉按钮「双击」去重（运行时热补丁，不依赖重装 APK）。
 *
 * 现象：设置 → 通用设置 / 内置插件 的下拉用真手指点不开；DevTools 里 `el.click()` 能开。
 * 根因：一次真实 tap 在 button[aria-haspopup] 上派发了两次 click
 *       （pointer 合成的 click + WebView 鼠标兼容 click），Radix 的切换语义被抵消。
 * 详见 docs/agents/verification.md ⑯.5。
 *
 * 放置位置：files/engine/node_modules/@deepseek-ai/dsh-web-frontend/dist/dsh-clickfix.js
 * 并在同目录 index.html 里、webview-polyfill.js 之前插一个 script 标签。
 * 引擎升级会重新解包 dist，届时这份文件会消失 —— APK 侧的 assets/webview-polyfill.js
 * 已经带同名逻辑，所以升级后照样生效。
 */
(function () {
  if (window.__dshClickDedupe) return;
  window.__dshClickDedupe = true;
  var WINDOW_MS = 450;
  window.addEventListener('click', function (e) {
    var t = e.target;
    var b = t && t.closest ? t.closest('button[aria-haspopup]') : null;
    if (!b) return;
    var now = Date.now();
    var last = b.__dshLastClick || 0;
    if (now - last < WINDOW_MS) {
      e.stopImmediatePropagation();
      e.preventDefault();
      return;
    }
    b.__dshLastClick = now;
  }, true);
})();