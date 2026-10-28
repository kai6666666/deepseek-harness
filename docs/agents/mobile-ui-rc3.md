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

## 九、回归脚本化：`tools/ui-regression-rc3.mjs`（2026-10-27）

四条用例不再手拼脚本，固化成一个文件，退出码 0/1：

```bash
run-as com.dsh.android sh -c 'files/termux/usr/bin/node /data/local/tmp/urc3.mjs'
```

### 脚本里踩到的三个真坑（都改在脚本/代码里了）

| 现象 | 根因 | 处理 |
|---|---|---|
| F 判 `drawer 恒 1,1,1` 失败 | 抽屉滑入动画中间帧停在 `x=1`，`x>=0` 被当成“已展开” | `openDrawer()` 改成「连续两帧 x 一致且 >5」才算开好 |
| G 点遮罩没反应 | 遮罩铺满全屏，`ref` 点法落到中心点 → 正好被抽屉盖住 | 探针 VERSION 8 支持 `tap {x,y}`（`elementFromPoint` 取 topmost）；脚本点 `viewport.w-30` |
| E 偶发“点了抽屉不动” | 菜单是 React 渲染，旧 dump 的 `ref` 可能已指向卸载节点 | E 改成按文案重新定位 + 失败重试一次 |

另外修了一个**真机才暴露**的抽屉 bug：插件市场这类页面官方 `expanded=true` 但抽屉在屏幕外，
`mpOpenDrawer()` 见到 expanded 直接 `return` → 点汉堡没反应。现在改为「补 `mp-drawer-open` 类 + 同步一次」。

### 实测记录（同一台机，1.1.0-112 装机版）

```text
[PASS] PREFLIGHT — 探针 ping 通
[PASS] D 会话视图「更多」不越界 — 下载 Session 日志[197,112 141x30] 反馈[197,142] 刷新[197,172]
                                 视口内=YES；抽屉=未动
[PASS] F 开菜单不收起抽屉 — drawer 恒 14,14,14；三帧 menu 项 2/2/2
[PASS] E 点菜单项收起抽屉 — 「浏览更多插件」→ drawer=-330,-330,-330
[PASS] G 点遮罩收起抽屉且菜单不复活 — drawer=-330,-330,-330；menuitem=0
结果：4 PASS / 0 FAIL → 退出码 0          ← D 先跑（E 会把界面导航到插件页）
```

单独跑 `D` 时（会话视图在场）同样是 PASS；`D` 在非会话视图下记 SKIP 而不是 FAIL，
因为「更多操作」按钮本身要“有消息的会话”才渲染。

### ⚠️ 跑之前必须确认屏幕是亮的

本轮有一次 `4 PASS` 之后紧接着全 FAIL：`dumpsys power` 显示 `mWakefulness=Dozing`，
`mCurrentFocus=NotificationShade`。**熄屏时 `dump` 照样能返回坐标，但 `tap` 全被 keyguard 吃掉** ——
表现就是「F 抽屉没打开」这类假失败。跑之前先：

```bash
input keyevent 224        # 唤醒
wm dismiss-keyguard       # 无密码锁时直接收起
settings put system screen_off_timeout 1800000
```

这条已经写进 `docs/agents/verification.md` ⑥。

## 十、1.1.0-113 装机全绿（2026-10-27）

第九节那次是在 112 上跑出 `4 PASS + D SKIP`，随后补了「官方 expanded 但抽屉在屏外」的修复、
把用例顺序调成 D→F→E→G、E 改成按文案重定位。113 的出包（CI `40638216626` / `b4ba13b8`）装上后：

```text
stamp = 1.1.0-113        （assets 解包写戳正常）
探针  = VERSION 8        （坐标点击可用）
```

一条命令、零人工干预：

```text
[PASS] PREFLIGHT — 探针 ping 通
[PASS] D 会话视图「更多」不越界 — 下载 Session 日志[197,58] 反馈[197,88] 刷新[197,118]
                                 视口内=YES；抽屉=未动
[PASS] F 开菜单不收起抽屉 — drawer 恒 14,14,14；三帧 menu 项 2/2/2
[PASS] E 点菜单项收起抽屉 — 「浏览更多插件」→ drawer=-330,-330,-330
[PASS] G 点遮罩收起抽屉且菜单不复活 — drawer=-330,-330,-330；menuitem=0

结果：5 PASS / 0 FAIL / 0 SKIP → 退出码 0
```

这是第一次 **五条全 PASS、无 SKIP**：D 能过说明重启后仍停在会话视图（`更多操作`在头部），
也说明「有消息的会话」这个前置在装机后是保留的（会话数据在 `files/` 里，`pm install -r` 不抹）。

### 装机版的额外确认

| 项 | 值 |
|---|---|
| 解包路径 | `files/termux/home/.dsh/mobile-ui/dsh-android-mobile/` |
| 版本戳 | `1.1.0-113` |
| 探针 | `files/home/.dsh/ui-probe.js` 里 `VERSION = 8` |
| 源码比对 | zip 内 `client.js` 是压缩产物（注释被剥），**不能靠 grep 注释判断**；以行为断言为准 |

### 这条线到此的完整判据

```text
E 点菜单项 → 抽屉收
F 只开菜单 → 抽屉不动
G 点遮罩   → 抽屉收、菜单不复活
D 会话视图「更多」→ 菜单在视口内、抽屉不动
PREFLIGHT 探针通
```

四条行为 + 一条前置，全部由 `tools/ui-regression-rc3.mjs` 一条命令覆盖，退出码即结论。

## 十一、右栏「更多」→「创建你的插件」后收右栏（2026-10-27）

### 现象与调用链

右栏 guide 的「更多」与左栏共用同一个注入（`ui-entry-customization/src/client/index.ts`）：

```text
sidebar.right.tab.guide.actions → inject('rightbar')
  ├─ 浏览更多插件 → pluginNavigation.openList()      → 主区换成插件列表页（正常）
  └─ 创建你的插件 → uiWorkspace.startSession(prompt) → 主区起新会话，右栏不收起 → 新会话被挤窄
```

### 最终判据：草稿内容变化 → 收右栏

```text
点 [role="menuitem"]，且 mpMenuSource === 'right'
  → 记下点击前 [role=textbox] 的内容（mpDraftSignature）
  → 每 130ms 轮询（最多 6 次，首次 180ms）
  → 内容变了（startSession 把提示词写入草稿）或出现 dialog → mpCloseRightbar()
  → 浏览插件：路由跳转，草稿不变 → 不碰右栏
```

不用文案（英文界面是 “Create your plugin”），也不用“发送键是否存在”（会话视图里它一直在，会误判）。

### 四个真机才暴露的坑（都修了）

| # | 坑 | 后果 | 修法 |
|---|---|---|---|
| 1 | guide 的「更多」按钮**没有把 `aria-haspopup/expanded` 落到 DOM** | `mpNoteMenuSource()` 找不到 anchor，来源判成 `other`，整段逻辑不执行 | 新增 `onGuideClick`：点 guide 内任何 button 就把来源记成 `right`（菜单项是 portal 到 body 的，点它时认不出来源） |
| 2 | **全屏态右栏从 `rightbarCol` 搬出去**（portal 成整屏） | `rightbarCol.contains(anchor)` 恒 false | `anchor.closest('[data-sidebar-right-guide], …, [data-sidebar-right]')` 兜底 |
| 3 | 全屏时 DOM 里还有一份**隐藏的 header 副本**，`getBoundingClientRect().width > 0` | `退出全屏` 点到了那份不可见按钮 → 点了没反应 | `seen()` 加「必须与视口相交 + 非 disabled」 |
| 4 | 页面上有两个「更多工具」：右栏 guide 卡片 + 输入框旁的「+」 | 点错会打开「AI 浏览器 / 工作区文件」那组菜单 | 脚本逐个试，菜单里出现「创建…」才算选对 |

### 收右栏的动作

```text
有「退出全屏」→ 先点它（实测：退全屏这一步本身就把右栏收掉）
否则有「收起右侧边栏」→ 点它
320ms 后再补点一次「收起右侧边栏」（防全屏退出后按钮重排）
```

### 真机 6 PASS（1.1.0-115 装机版）

```text
[PASS] PREFLIGHT
[PASS] D 会话视图「更多」不越界 — 三项全在 394 宽内；抽屉=未动
[PASS] R 右栏「更多」→创建插件收右栏 — 「创建你的插件」→ 右栏已收起；主区发送键=有
[PASS] F 开菜单不收起抽屉 — drawer 恒 14,14,14；三帧 menu 项 2/2/2
[PASS] E 点菜单项收起抽屉 — 「浏览更多插件」→ drawer=-330,-330,-330
[PASS] G 点遮罩收起抽屉且菜单不复活 — drawer=-330,-330,-330；menuitem=0

结果：6 PASS / 0 FAIL / 0 SKIP → 退出码 0
```

装机确认（`pm install -r` 后由 `ensureMobileUi()` 从 assets 解包）：

```text
stamp = 1.1.0-115
client.js: onGuideClick×3、mpDraftSignature×3   （压缩产物里仍能按符号数确认）
```

R 的判定细节：点「创建…」后 1.7s，`收起右侧边栏/退出全屏` 全部不可见（右栏没了），主区「发送消息」在。

「浏览更多插件」这条没有被我们的代码碰：它走 `openList()` 换页，草稿签名不变，轮询自然结束，右栏去留交给官方。
