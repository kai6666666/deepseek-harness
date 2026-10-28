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


## 六、补充：点菜单项后自动收起侧栏（2026-10-27）

上一轮只做到「打开菜单不收抽屉」。用户指出：菜单里的「浏览更多插件」「创建你的插件」点完，
抽屉仍留在原地 —— 与点「插件」行的行为不一致。

### 判定：按菜单来源，不按文案

```text
菜单挂载时记录来源：anchor 是否属于 sidebarCol → 'sidebar' | 'other'
点 [role="menuitem"]：
  sidebar → 置 mpMenuConsumed，延后 120ms closeDrawerAfterClick()
  other   → 不碰抽屉（会话视图 / 右栏的菜单）
```

`mpMenuConsumed` 同时给 `mpHoldDrawerForMenu()` 加闸：点击后不再“钉住”抽屉，否则会与收起动画打架。

为什么延后 120ms：先让官方把目标页/弹窗渲染出来，再滑走抽屉，避免“页面没切、抽屉先走”的闪断感。

### 真机证据

```text
点「浏览更多插件」：  menu@506 → tap → drawer 全部 @-1013（收起）
点「创建你的插件」：  menu@506 → tap → drawer 全部 @-1013（收起）
                     屏幕停在「创建一个带左侧栏入口的 DSH 插件」页
只打开「更多」不点：  drawer 保持 @454（上一轮修复未回退）
```

### 回归判据

```text
E. 左栏「更多」→ 点任一项：drawerRow.x 由 454 变为负值（收起），目标页/弹窗出现
F. 只开菜单不点：drawerRow.x 仍 454
G. 点菜单外的遮罩：抽屉收起，菜单不复活
```

## 七、回归实测（rc3 三处「更多」+ 遮罩，2026-10-27）

环境：`1.1.0-111` 热替换到 `files/termux/home/.dsh/mobile-ui/...`，viewport CSS `394×806 @dpr3.25`。
坐标一律取 `rect.x`（CSS px），抽屉关闭态 = `-330`，展开态 = `14`（`left:0` + 16 padding）。

### F. 只开菜单不点：抽屉不动（不回归）

```text
开抽屉后:            14,14,14
点「更多」+150ms:    14,14,14   menu= 浏览更多插件@16,240 创建你的插件@16,274
           +400ms:    14,14,14   （同上）
           +900ms:    14,14,14   （同上）
```

留意「更多」按钮本身 `panelRow` 且**没有** `aria-haspopup` 属性（dump 里 `hp=-`），
所以「跳过 haspopup 行」这条规则在 rc3 实际不生效 —— 真正兜住抽屉的是
`mpSyncDrawer()` 的「见到可见菜单就 hold」分支，这一点已由上面三帧证实。

### G. 点遮罩：抽屉收起，菜单不复活（真手指）

```text
menu 打开态（drawer=14）→ adb `input tap 350 400`（抽屉右侧的遮罩）
2s 后: drawer= -330,-330,-330   menuitem= 0
```

即：遮罩点击走 `mpCloseDrawer`，菜单被官方 `onClose` 一起关掉，且没有 observer 复活。

### E. 点菜单项：抽屉收起（两种入口）

```text
「浏览更多插件」→ tap → drawer 全部 @-1013（screen px）/ -330（CSS px）
「创建你的插件」→ tap → drawer 全部 @-1013 / -330，页面停在插件创建页
```

### D. 会话视图「更多操作」

```text
header: 更多操作[314,22] → tap
menu:   下载 Session 日志[197,58] 反馈[197,88] 刷新[197,118]   （全部 x+w ≤ 338 < 394）
抽屉行: -330,-330,-330   （未被误开）
```

右栏打开后再点同一按钮（位置变 342,22）：

```text
menu: 下载 Session 日志[225,58] 反馈[225,88] 刷新[225,118]  → 全在视口内
抽屉行: -330,-330,-330
```

### 右栏 guide 的「更多」：空态不可达

`GuideBody.tsx:105` 的 `GuideMoreMenu` 只在 guide 有卡片时渲染。当前会话右栏是「开始」空态，
dump 里没有任何 `更多` 锚点（`x>150` 只有会话视图的「更多操作」），因此**运行期无入口可点**。

代码级保证已经足够：`mpNoteMenuSource()` 用

```js
mpMenuSource = (col && anchor && col.contains(anchor)) ? 'sidebar' : 'other';
```

右栏/会话视图的 anchor 天然不在 `sidebarCol` 内 → 一律判 `other` → 永远不碰抽屉。
等右侧栏出现 guide 卡片时，可直接复用本节 D 的脚本（把候选条件换成 `x>150 && /更多/`）补一条实测。

### 本轮踩到的两个脚本坑（记下来免得重犯）

1. **别点 x 为负的「打开侧边栏」**：关着的时候官方 toggle 也在 dump 里（`x=-330`），
   `tap` 直接 dispatch 会“成功”但不打开抽屉。只点 `打开导航`（`mp-nav-btn`，x=6）。
2. **应用中途被 force-stop 时所有坐标会失真**：本轮出现过一次 app 退出（`pidof` 为空），
   期间 drawer 恒为 `-326`、菜单却在 `16,240`。重新 `am start` 后同一脚本立刻恢复正常。
   跑回归前先 `pidof com.dsh.android` 确认进程在。

## 八、装机复核：走 `ensureMobileUi()` 解包路径再跑一遍（2026-10-27）

第七节是热替换（手工 `cp` 到 `files/termux/home/.dsh/mobile-ui/`）测的。这一节把同一套用例
跑在**APK 自带 `assets/mobile-ui.zip` 解出来的那份**上，用来确认版本戳与解包链路没有吃掉修复。

### 安装与解包

```text
APK:            app-system-debug.apk 189,775,982 B（CI 40632127741 / 773dd6b6 / success）
安装前 stamp:   1.0.0-108            ← 老包留下的，说明之前确实是“旧代码 + 热替换”
处理:           把 dsh-android-mobile 整目录改名为 .old21744（等价于首次安装）
启动后 stamp:   1.1.0-111            ← assets 解包成功
client.js:      442,719 B，onMenuItemClick×3、mpMenuConsumed×5
```

⚠️ 注意体积差：仓库里 `mobile-ui-plugin/.../client.js` 是 528 KB（带注释与缩进），
zip 里那份 443 KB 是构建产物。**判断版本要看行为与 grep，不要拿字节数对比。**
旧目录 `.old21744` 事后用 `find -type f -delete` + `rmdir` 清掉，避免插件清单扫到两份同名包。

### 四条用例复跑结果

```text
F 只开菜单：  +150/+400/+900ms  drawer 恒 14,14,14；menu 16,240 / 16,274
E 点菜单项：  「浏览更多插件」→ tap → drawer 全 -1013（screen px）
G 点遮罩：    input tap 350 400 → drawer -330；menuitem 0
D 会话视图：  更多操作[314,22] → menu 197,58 / 197,88 / 197,118（全在 394 宽内）
              抽屉行 -330,-330,-330（未被误开）
```

结论：**四条与热替换结果完全一致**，说明 1.1.0-111 的 zip 里就是带修复的构建，
`ensureMobileUi()` 的「版本戳 → 删目录 → 重解包 → 写戳」链路也正常。

### 顺带记录：怎么在手机上点到“某个会话”

`dump` 只收可交互元素，会话行的标题是普通文本节点，**不在 dump 里**；只有右侧的 16×16
「会话“xxx”的操作 / 归档会话 / 置顶会话」三个图标有 `aria-label`。
所以“点开某个历史会话”目前只能靠：新建会话 → 发一条消息 → 头部才会出现「更多操作」。
这也是第七节 D 项必须先把会话跑起来才能测的原因。
