# 移动端 UI 插件 × DSH 0.2.1-rc.3 适配

> 起因：rc3 新增了三处「更多」菜单（左侧栏面板列表 / 会话视图 / 右侧栏）。左侧栏的
> 「更多」一打开，菜单就落到会话区中间。记录时间：2026-10-27，真机 Xiaomi 25104RADAC。

## 一、结论：不是菜单画错，是**抽屉被我们自己收掉了**

rc3 的「更多」用的是 `Menu`（`packages/client/ui-primitives/src/Menu.tsx`）的 **portal 模式**：
菜单挂到 `body`，位置用 `position: fixed` 从 **anchor 的 rect** 算出来。

而左侧栏那个「更多」按钮，在 rc3 里是：

```tsx
// packages/client/ui-sidebar/src/client/SidebarRoot.tsx:103
<button className={css.panelRow} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(v => !v)}>
```

`css.panelRow` 正是我们插件在「修复 66」里加的那条规则要收抽屉的对象：

```js
// client.js · onPanelRowClick
const t = e.target.closest('.hHd-Xa_panelRow, .hHd-Xa_panelList button');
if (!t) return;
closeDrawerAfterClick();          // ← 点「更多」也走了这里
```

于是顺序变成：点「更多」→ 我们收起抽屉 → 抽屉滑出屏幕 → 菜单挂载，anchor 已在屏幕外 →
fixed 定位把坐标**夹回视口** → 菜单出现在会话区中央。

真机 dump（修复前，同一帧）：

```text
e18 menuitem  506,1032  浏览更多插件      ← 菜单在屏幕中央
e19 menuitem  506,1142  创建你的插件
e3  button   -1013,580  hHd-Xa_panelRow  插件   ← 抽屉在屏幕外
e5  button   -1013,892  hHd-Xa_panelRow  更多
```

## 二、修法（三条，缺一不可）

| # | 改动 | 作用 |
|---|---|---|
| 1 | `onPanelRowClick` 跳过 `aria-haspopup="menu"` 的行 | **根因修复**：开菜单的行不再收抽屉 |
| 2 | `mpSyncDrawer()` 见到 `[role="menu"]`/`[class*="moreMenu"]` 就冻结同步，并 `mpHoldDrawerForMenu()` 把展开类补回 | 兜底：portal 挂载比 observer 晚一帧时也不会被收走 |
| 3 | CSS：`[role="menu"], [role="menuitem"] { z-index: 60 }`（遮罩 39 / 抽屉 40） | 菜单压在遮罩与抽屉之上，点击不会被遮罩吃掉 |

> ⚠️ 不要给菜单期间的遮罩加 `pointer-events: none`：那会让点击**穿透到会话区**。
> 遮罩保持可点（点它就是关抽屉），菜单自身 z=60 在遮罩之上，点菜单不会落到遮罩。

另外把两处硬编码哈希换成「快路径 + 语义后缀兜底」：

```js
mpSidebarCol()    : '.pI_x6G_sidebarCol'   || '[class*="sidebarCol"]'
mpOfficialToggle(): '.hHd-Xa_toggle'       || col.querySelector('[class*="toggle"]')
```

rc3 的哈希**没变**（`pI_x6G_` / `hHd-Xa_` / `VOzbGW_` 实测仍在），但下次 rc4 一改，
CSS Module 的后半段（`_sidebarCol`）仍然稳定，兜底能接住。

## 三、真机验证（修复后，同一脚本）

```text
drawer:           插件@454 自动化任务@454 更多@454
after-menu drawer:插件@454 自动化任务@454 更多@454   ← 不再被收起
menu:             浏览更多插件@506 创建你的插件@506  ← 贴着按钮
```

截图确认：抽屉停在屏幕左侧，「更多」下方弹出两项菜单，会话区不再被菜单压住。

## 四、回归判据

```text
A. 打开左栏「更多」：drawerRow.x 不变（≈454），menu.x > drawerRow.x
B. 关闭菜单：抽屉仍在；点遮罩：抽屉收起、菜单不复活
C. 其余面板行（插件 / 自动化任务 / 新会话 / 会话条）：点击后抽屉照旧收起
D. 会话视图「更多」、右侧栏「更多」：菜单不越出视口、不压住发送键
```

## 五、版本

`MOBILE_UI_VERSION = 1.1.0-110`（本次起用 1.1.x 表示“已适配 rc3 的三处菜单”）。
