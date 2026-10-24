---
name: dsh-mobile-theme
description: 制作或修改 DSH 移动端界面主题（换肤 / 配色 / 改 token / 深色适配）时使用。内含 DSH 前端的取色机制、完整的 --dsw-* token 清单、主题插件的最小结构、打包与挂载到手机 App 的完整步骤，以及本项目的两条硬约束。不必再自行摸索 DSH 前端结构。
---

# 制作 DSH 移动端主题

## 0. 先读这一条：不要重画界面

DSH 的 Web GUI 是**官方前端 bundle**，本 App 只是用 WebView 把它装起来。
皮肤层**不是**改前端源码，而是**覆盖 CSS 变量**。

前端里每个官方组件的颜色都写成 `color: var(--dsw-xxx)` / `background: var(--dsw-xxx)`。
所以你只要往 `<head>` 注入一段 `<style>`，把那些变量重新赋值，
**全界面同时变色**，且一个官方文件都不用动。

这就是主题的全部机制。**没有第二个机制**，不要去找"主题配置文件"。

## 1. 主题插件的形态

一个 DSH 客户端插件 = 一个普通 npm 包 + 三个文件：

```
dsh-<主题名>/
  package.json      ← 声明这是一个客户端插件（dsh.client 字段）
  lib/index.js      ← Node 半：主题里通常空着，只导出声明的 name/inject
  lib/client.js     ← 浏览器半：真正注入 CSS 的地方
```

### package.json

```json
{
  "name": "dsh-<主题名>",
  "version": "1.0.0",
  "type": "module",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js" },
  "dsh": { "client": { "inject": [], "platform": "web", "immediately": true } }
}
```

⚠️ `dsh.client` 这一段是**必须的**：前端靠它才知道这个包有浏览器半、以及怎么加载。
`exports` 里 `./client` 也是必须的 —— 少了它前端解析不到 `lib/client.js`。

### lib/index.js（Node 半）

主题不碰 Node 侧，所以极小：

```js
export const name = 'dsh-<主题名>';
export const inject = [];
```

⚠️ **不要偷懒省略这个文件**：包里 `exports["."]` 指着它，缺了包就解析不过。

### lib/client.js（浏览器半）—— 主题的全部逻辑在这里

```js
// dsh-<主题名> —— 客户端半
//
// 向 <head> 注入一个 <style>，把官方主题 token（--dsw-*）覆盖为自定义配色。
// 所有界面组件都通过这些 token 取色，所以改 token 即全局生效。
window.__ModuleLoader__.load({
  id: 'dsh-<主题名>',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    // 浅色：见 §2 的 token 清单
    var LIGHT = [
      ['--dsw-alias-bg-base', '#e9f6ee'],
      // …其余 token
    ];
    // 深色：同一批 token 名的深色取值。**一个都不能少**，
    // 漏掉的 token 在深色模式下会保持官方默认值，表现为"深色下某块还是原来的颜色"。
    var DARK = [
      ['--dsw-alias-bg-base', '#10231a'],
      // …与 LIGHT 相同的 token 名
    ];

    function decl(list) {
      return list.map(function (p) { return p[0] + ':' + p[1] + ';'; }).join('');
    }

    // 选择器用 body[data-dsh-theme] 打标记：特异性与官方 theme CSS 相同（body），
    // 后插入者胜；暗色由官方既有的 body[data-ds-dark-theme] 标记切换。
    var CSS =
      'body[data-dsh-theme]{' + decl(LIGHT) + '}\n' +
      'body[data-dsh-theme][data-ds-dark-theme]{' + decl(DARK) + '}\n' +
      // 让页面底色也跟着变，避免顶/底露白
      'body[data-dsh-theme]{background-color:var(--dsw-alias-bg-base)}\n' +
      'body[data-dsh-theme][data-ds-dark-theme]{background-color:var(--dsw-alias-bg-base)}';

    exports.inject = [];
    exports.apply = function apply(ctx) {
      var style = null;
      ctx.effect(function () {
        if (typeof document === 'undefined') return;
        style = document.createElement('style');
        style.dataset.plugin = 'dsh-<主题名>';
        style.textContent = CSS;
        document.head.appendChild(style);
        return function () { if (style) { style.remove(); style = null; } };
      }, 'theme: install stylesheet');
      // 标记要等 <body> 存在；theme 可能比 body 先跑
      ctx.effect(function () {
        var t = setInterval(function () {
          if (document.body) {
            document.body.setAttribute('data-dsh-theme', '');
            clearInterval(t);
          }
        }, 50);
        return function () { clearInterval(t); };
      }, 'theme: tag body');
    };
    return module.exports;
  }
});
```

三个要点，缺一不可：

1. `window.__ModuleLoader__.load({id, factory})` —— 这是**唯一**的插件入口形态。
2. `ctx.effect(fn, label)` —— 副作用必须包在里面，返回清理函数（卸载时移除 `<style>`）。
3. `data-dsh-theme` 标记 + `body[...]` 选择器 —— 保证只覆盖你自己这一份，且特异性够用。

## 2. `--dsw-*` token 清单（这是你要改的全部）

按语义分组。**每一组都要给出明暗两套值**。这份清单来自本项目实测可用的绿色主题，
覆盖了移动端界面上所有可见的取色点。

| 分组 | token |
|---|---|
| 背景 | `--dsw-alias-bg-base`、`-bg-layer-1`、`-bg-layer-2`、`-bg-layer-3`、`-bg-module-platform`、`-bg-multi-select`、`-bg-overlay`、`-bg-skeleton`、`-bg-document-preview` |
| 边框 | `--dsw-alias-border-l1`、`-l2`、`-l3`、`-l4`、`-l2-darkmode-thin`、`--dsw-alias-menu-group-header-fill`、`--dsw-menu-surface-fill` |
| 交互态 | `--dsw-alias-interactive-bg-hover`、`-bg-active`、`-bg-hover-solid` |
| 侧栏 | `--dsw-specific-sidebar-fill`、`-nav-item-active`、`-nav-item-active-accent`、`-nav-item-hover`、`--dsw-specific-tip`、`--dsw-specific-selector` |
| 代码块 | `--dsw-alias-markdown-code-block`、`-code-block-banner`、`-code-segment-selected`、`-code-segment-unselected`、`--dsw-alias-markdown-inline-code`、`-placeholder`、`-tag`、`-citation` |
| 气泡/输入 | `--dsw-specific-bubble`、`--dsw-specific-bubble-highlight`、`--dsw-specific-input-major`、`--dsw-specific-login-input` |
| 滚动条 | `--dsw-alias-scrollbar-bg-l1`、`-l2`、`--dsw-alias-scrollbar-hover-l1`、`-l2` |
| 文字 | `--dsw-alias-label-primary`、`-secondary`、`-tertiary`、`-caption`、`-dimmed`、`-document-preview` |
| 品牌/按钮 | `--dsw-alias-brand-primary`、`--dsw-alias-brand-text`、`--dsw-alias-button-elevated-fill`、`-floating-fill`、`-floating-hover`、`-ghost-active-fill`、`-ghost-active-hover`、`-ghost-active-border` |
| 提示/toast | `--dsw-alias-tooltip-bg`、`--dsw-alias-toast-bg`、`--dsw-alias-menu-icon`、`--dsw-alias-state-idle-primary` |

⚠️ `--dsw-alias-label-primary` 是**正文文字色**。改背景却没改它，
症状就是"字看不见了"。背景越深，它必须越浅。

⚠️ `--dsw-alias-bg-skeleton` 这类**带 alpha 的**值要保留透明度（如 `#1a3c2810`），
写成不透明色会让骨架屏糊成一块。

## 3. 配色怎么定（避免"看着能看、用着刺眼"）

- **先定一个主色相，再用同一色相做明度阶梯**。背景三层、
  侧栏、气泡各自相差 3–6% 明度即可，不要各用各的色相。
- **文字与背景的对比度**是唯一硬指标：正文 ≥ 7:1，次要文字 ≥ 4.5:1。
- 深色模式**不是把浅色反转**：深色下背景用「主色相 + 极低明度」（如 `#10231a`），
  文字用「主色相 + 极高明度」（如 `#e4f4ea`），中间层留出明显台阶。
- 边框色用**带 alpha 的主色**（如 `#3f7d531f`），不要用实色灰 —— 实色灰在
  彩色背景上会显脏。

## 4. 打包与挂载到手机 App

### 4.1 落点：**不要放进 profile 的 node_modules**

插件包必须放在 `$DSH_HOME/<工具名>/<包名>/`，例如：

```
$DSH_HOME/green-theme/dsh-green-theme/{package.json,lib/index.js,lib/client.js}
```

原因：profile 的 `node_modules` 归 pnpm 管，本包不在 profile 的 `dependencies` 里，
用户每装一次别的插件，pnpm 就会把它挪进 `node_modules/.ignored/` —— 主题随即失效。
`$DSH_HOME` 下是 pnpm 的管辖之外。

手机上 `$DSH_HOME` = `/data/user/0/<包名>/files/home/.dsh`。

### 4.2 挂载：往 profile 的用户层加一行 `- insert:`

文件：`$DSH_HOME/profiles/web/cordis.patch.yml`

```yaml
- insert:
    - id: dsh-green-theme
      name: "file:///data/user/0/com.dsh.android/files/home/.dsh/green-theme/dsh-green-theme/lib/index.js"
```

⚠️ `name` 用 **`file://` + 绝对路径**，指向包的 `lib/index.js`，不是包目录。
⚠️ `id` 自己起，不要和已有行重名。
⚠️ 这是**用户层**文件（设置页里改的东西也写这里）。写入时**整块重述**这一行，
   不要深合并 —— patch 的语义是整块替换 config。

### 4.3 生效

改完**重启 App**（引擎在启动时读这份配置）。主题是纯前端注入，
不需要重装 APK、不需要重建 Node 环境。

## 5. 验收（必须做完这三步）

1. **插件确实被加载**：`adb logcat -d -s DSH:I` 里能看到引擎打印的插件挂载行；
   引擎启动日志里若出现 `did not activate` 且带你这个包名，说明包解析失败
   （多半是 `exports`/`type: module` 写错）。
2. **样式确实注入了**：在页面世界里查
   `document.querySelector('style[data-plugin="dsh-<主题名>"]') !== null`。
3. **界面确实变了**：用 `ui_screen` / 截图**看**一眼 —— 颜色是视觉判断，
   数值断言替代不了。**深浅两种模式都要看**（切换设置页的主题开关）。

⚠️ 「插件加载了」≠「界面变了」。第 2、3 步才是主题的验收。

## 6. 本项目特有的两条硬约束（改任何东西前必读）

1. **`applicationId` 必须恰好 15 字符**：`com.dsh.android` / `com.dsh.webview`。
   上面示例里的绝对路径含包名，**两个 flavor 的路径不同**。
2. **`targetSdk` 必须 ≤ 28**，不能升。

## 7. 常见错误（都踩过）

| 症状 | 根因 |
|---|---|
| 界面完全没变 | `dsh.client` 字段没写，或 `exports` 里没有 `./client` |
| 只有部分控件变色 | 漏了一组 token；对照 §2 清单逐组核对 |
| 深色模式下花屏/刺眼 | DARK 数组里漏了 token，那些 token 保持官方浅色值 |
| 字看不见 | 改了 `--dsw-alias-bg-*` 但没改 `--dsw-alias-label-*` |
| 主题用一阵子后自己失效 | 包放进了 `node_modules`，被 pnpm 驱逐 |
| 重启后仍不生效 | 改的是引擎目录里的文件，而配置在 `$DSH_HOME/profiles/web/` |
