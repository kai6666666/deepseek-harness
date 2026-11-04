# 1.1.0-161 · 左侧栏完全收起

## 根因

dsh-web-all 的移动端响应式层在折叠态保留 52px 图标条：

```css
[data-dsh-frame] [data-pane="sidebar"]:is([data-pane="sidebar"]) {
  position: absolute !important;
  left: 0;
}

[data-dsh-frame][data-sidebar-collapsed] [data-pane="sidebar"] {
  width: 52px !important;
}
```

它的 specificity 高于 mobile-ui-plugin 原有的 `.pI_x6G_sidebarCol` 抽屉规则，因此设置页左侧仍露出图标条。

## 补丁

`mobile-ui-plugin/dsh-android-mobile/lib/client.js` 的第三方适配 CSS：

```css
html[data-mobile] [data-dsh-frame] [data-pane="sidebar"]:not(.mp-drawer-open) {
  display: none !important;
}

html[data-mobile] [data-dsh-frame] [data-pane="sidebar"].mp-drawer-open {
  display: block !important;
  position: fixed !important;
  left: 0 !important;
  top: 0 !important;
  bottom: 0 !important;
  width: min(320px, 85vw) !important;
  z-index: 1100 !important;
  pointer-events: auto !important;
}
```

设置 dialog 是 body 级 portal，`sidebar.contains(dialog) = false`，隐藏侧栏不会隐藏设置内容。

## 真机结果

```text
关闭态 sidebar      display:none, 0 × 0
打开态 sidebar      display:block, position:fixed, 320 × 806
设置 dialog         394 × 806, x=0
document.scrollWidth = innerWidth = 394
```

设置页不再有 52px 金色图标条，正文从 x=0 开始；抽屉打开时仍为 320px 浮层。

## 证据

```text
/sdcard/Download/161-settings-no-rail.png
/sdcard/Download/161-drawer.png
/sdcard/Download/verify-1.1.0-161-sidebar.json
```

镜像归档：

```text
release-archive/0.4.2/evidence/1.1.0-161/
```