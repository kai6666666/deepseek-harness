# ⑫.2 悬浮窗接进插件生态

> 本文是 [AGENTS.md](../../AGENTS.md) 的分册之一，
索引见 [docs/agents/README.md](README.md)。

### ⑫.2 悬浮窗接进 DSH 插件生态 —— 页面里的插件就能改悬浮球

目标：**让 AI 改悬浮窗像改自己的 web 界面一样简单** —— 写个插件、
`window.DSHAndroid.bubbleApply(...)` 一行，悬浮球就变样，原生侧零改动。

```
插件(client.js) ──window.DSHAndroid.bubbleApply(json)──> 页面桥
                                                        ├─ system: @JavascriptInterface（同步）
                                                        └─ gecko : native messaging（异步）
                                                              ↓ PageBridge
                                                    MainActivity.StatusBridge
                                                              ↓
                                                    FloatingBubble.applyAppearance()
                                                              ↓
                                                    BubbleAppearance.merge + 落盘 + 重绘
```

#### 三个页面侧方法（两个 flavor 都暴露，方法名完全一致）

| 方法 | 语义 |
|---|---|
| `bubbleApply(json): Boolean` | 合并下发外观字段。返回 `true` = **已接受**，不代表视图已重绘 |
| `bubbleAppearance(): String` | 读回当前外观 JSON（同步），供插件做「读-改-写」 |
| `onTranscript(json)` | 上报会话转录（原生侧自己切主线程，页面不用管） |

页面侧另有 `bubbleState()` / `rootState()` 等既有方法，见 `PageBridge` 接口
（现共 **16 个**；`GeckoWebHost` 里那句「13 个方法」的注释是旧文案）。

#### 外观字段一览（`BubbleAppearance`）

⚠️ **是分层模型，不是枚举模型。** 早期版本只有一个 `shape` 枚举 + 一张图片，
于是 AI 无法满足任意诉求（"背景透明但图片不透明"、"把球做成星形"都表达不出来）。
现在分三层，**三层的透明度相乘**：

```
形状层   shape / shapePath / bg / bg2 / border / bgOpacity
内容层   avatar / frames / avatarOpacity / avatarScale
动效层   spin / pulse
```

| 字段 | 取值 | 说明 |
|---|---|---|
| `state` | `auto` / `expanded` / `collapsed` / `hidden` | `auto` = 老行为（只在后台显示）；其余三态**前台也保持** |
| `shape` | `circle` / `square` / `rounded` / **`path`** | 球的形状；`path` 用下面的 `shapePath` |
| `shapePath` | SVG path 的 `d` | **任意形状**（星形/心形/六边形/…）。坐标是 `shapeViewBox` 单位，不是 dp，所以同一串能适配任意 `size`。上限 `MAX_SHAPE_PATH_CHARS = 4000` |
| `shapeViewBox` | `minX minY width height` | 默认 `0 0 100 100` |
| `size` | dp | 球边长（默认 44） |
| `cornerRadius` | dp | `rounded` 的圆角 |
| `opacity` | 0.05–1 | **整体**不透明度（三层之上再乘一次） |
| `bgOpacity` | 0–1 | **只压形状层**。`0` = 背景全透明、只剩图片 |
| `avatarOpacity` | 0–1 | **只压内容层** |
| `avatarScale` | 0.2–2.0 | 内容层缩放；>1 溢出球、由形状裁剪（这就是"放大裁切"） |
| `bg` / `bg2` | `#RRGGBB` / `#AARRGGBB` | 底色 / 渐变第二色（留空 = 纯色） |
| `border` / `borderWidth` | 色 / dp | 描边 |
| `avatar` | `default` / `none` / data-URI | 头像（`none` = **完全不要图片**） |
| `frames` | data-URI 数组 | **轮播帧**（每项一帧）；`[]` = 清空轮播 |
| `frameDurations` | int 数组 | 每帧时长（ms），与 `frames` 同序；缺省用 `frameIntervalMs` |
| `frameIntervalMs` | ms（20–60000） | 统一帧时长，默认 400 |
| `frameLoop` | int | `-1` = 无限（默认）；`N>0` = 播 N 轮后停在最后一帧 |
| `spriteRows` / `spriteCols` | 0–32 | **精灵图网格**：`frames` 只给一张大图，按 `rows×cols` 行优先切片 |
| `spin` | -720–720 | 每秒旋转角度（负 = 逆时针），0 = 不转。作用在**内容层**，形状层不动 |
| `pulse` | bool | 呼吸缩放动画 |
| `panelWidth` / `panelHeight` | dp | 展开面板尺寸（`panelHeight` = **总高**，0 = 自适应内容） |
| `panelBg` / `panelText` / `panelAccent` | 色 | 面板配色 |
| `statusAutoHideMs` | ms | 状态横条自动隐藏（≤0 = 永不隐藏） |
| `edgeSnap` | bool | 是否启用「拖出屏幕自动贴边」 |

**常见诉求 → 字段组合**（插件描述里也给了模型同一张表）：

| 用户说 | 下发 |
|---|---|
| 背景透明、图片留着 | `{bgOpacity: 0}` |
| 去掉图片 | `{avatar: "none"}` |
| 做成星形/心形 | `{shape: "path", shapePath: "M50 3 L61 38 … Z"}` |
| 让它转起来 | `{spin: 90}` |
| 轮播几张图 | `{frameFiles: [...], frameIntervalMs: 200}` |
| 用精灵图做动画 | `{frameFiles: ["sheet.png"], spriteRows: 4, spriteCols: 4}` |

`merge()` 是**逐字段**合并：只写想改的字段，其余保持原值。落盘在
`SharedPreferences("dsh_bubble")` 的 `appearance` 键；头像字节落
`filesDir/bubble-avatar.bin`（`readAvatar`/`writeAvatar`，上限
`MAX_AVATAR_BASE64 = 700_000`）；轮播帧字节落 `filesDir/bubble-frames/`（见下）。

#### ⚠️⚠️ 加字段时 `save()` 与 `merge()` 必须同步（踩过的静默丢数据 bug）

`load()` 的实现是「读 SharedPreferences 的 JSON → 走 `merge()`」，所以：

- `merge()` 认的键，`save()` **必须写出来**，否则该字段只在本次运行有效、
  重启即回默认 —— 用户看到的是「AI 改的时候看得见，重开 App 就没了」。
- 反过来，`save()` 写了但 `merge()` 不认，重启后一样丢。

两个函数各有一处 `put(...)` / `xxxOf(o, ...)` 列表，**加字段要一起改**。
`frameCount` 尤其容易漏：漏了它重启后帧数读回 0，磁盘上那堆帧文件再没人引用，
表现为「重启后动画没了」。

#### ⚠️ 球的形状可以不是圆的 —— `BubbleShapeDrawable`

`shape:"path"` 时用 `androidx.core.graphics.PathParser` 解析成 `Path`，
`onBoundsChange` 里做等比缩放 + 居中（viewBox 空间 → 视图空间）。

- `getOutline()` 走 `Outline.setPath`（API 30+）；API 29 及以下只有
  `setConvexPath`，**非凸 path（星形、心形）会失败**，此时退回矩形 —— 那是
  **优雅降级**：阴影变方，形状本身照常正确。
  ⚠️ `setConvexPath` 返回 **void** 不是 boolean，判断"成没成"只能看
  `outline.isEmpty`。
- `setAlpha` **不能**把 alpha 乘进渐变分支：Skia 里 shader 的 alpha 与 paint 的
  alpha 本来就相乘，再乘一次会双重衰减（`#80` 的渐变会淡到看不见）。
- `getOpacity()` 恒返回 `TRANSLUCENT`：它是"最坏情况"声明，声明成不透明时
  背景透明会画出黑块。

`clipToShape()` 只在 `shape:"path"` 时给球设 `clipToOutline`，让图片跟着形状裁。
⚠️ 非凸 path 在 API 29 及以下无法作为 outline，此时**不裁剪**（宁可"图没被裁"
也不要"整个球不显示"）。

#### ⚠️ 轮播帧：两种存储模式，写入是全有或全无

`BubbleFrames`（`filesDir/bubble-frames/`，`META = meta.json`）：

| 模式 | 磁盘上 | 帧数 |
|---|---|---|
| 普通轮播（`sprite == null`） | `0.bin` … `N-1.bin`，每帧一张完整图 | = 文件数 |
| **精灵图**（`spriteRows/Cols > 0`） | **只有 `0.bin`** —— 那是整张大图 | = `rows × cols` |

⚠️ **精灵图模式下 `loadFrame(index)` 必须无条件读第 0 个文件再切片**，
不能去读 `index.bin`（它不存在）—— 漏了这条，球在精灵图模式下永远是空白。

⚠️ 只改 `spriteRows`/`spriteCols` 而不重传 `frames` 时，走
`BubbleFrames.rewriteSprite()` 只改 meta 不动字节；**普通轮播模式下没有"整图"
可重切**，返回 null，`merge()` 会退回整图模式并打日志（静默用错网格会让球显示
成网格里的碎块，比不显示更难查）。

⚠️ `write()` 先**全部解码**再落盘，然后写 `$DIR.tmp` → 原子改名（旧目录先挪成
`.old` 做备份）。任何一步失败都不动已有帧集 —— 半写好的帧集渲染出来是碎图。

⚠️ `MAX_FRAMES = 64`、`MIN_DURATION_MS = 20`、`MAX_DURATION_MS = 60_000`。
插件侧另设 `MAX_FRAMES_BASE64 = 6 MB` 总量闸：帧以 data URI 进 JSON，原生侧要
`readText()` 整个文件再 `JSONObject(...)`，64 帧 × 700 KB ≈ 45 MB 足以让 App 被
LMK 杀掉，而症状是「球突然消失、什么都没发生」。

#### ⚠️ 动效必须用两个独立的 `ObjectAnimator`

`spin` 与 `pulse` **不能**用 `view.animate()`（`ViewPropertyAnimator`）：它对同一个
View 是**单例**，后一次 `.start()` 会取消前一次 —— 两个动画同时打开时只有一个生效，
而且看不出是谁把谁取消了。且不能用 `withEndAction` 递归实现无限循环：递归入口有
"已在跑就不重启"的守卫，会把它自己挡住，转完一圈就停。

正确写法：`ObjectAnimator` + `repeatCount = INFINITE` + `repeatMode = RESTART`
（旋转）/ `REVERSE`（呼吸）。旋转终值必须是**正好一整圈**（±360），否则每轮之间
会跳一下。呼吸的 `SCALE_X` / `SCALE_Y` 各一个动画、时长与相位完全一致，否则会拉成椭圆。

#### ⚠️ 改尺寸后夹取不能读 `root.width`

`applyAppearance()` 改完 `layoutParams` 时布局**还没重测**，`root.width` 仍是
**旧**尺寸（可能是贴边态的 6dp，也可能是上一版的小球）。拿它算夹取范围，AI 一把球
改大，球就跑到屏幕右/下边缘外，用户看到的是「球消失了」。
收起态直接用 `dp(appearance.size)` 算；展开态尺寸由面板决定，`root.post{}` 里再夹一次。

#### AI 主动推送状态消息（`action:"notify"`）

与 `set` 是**两条独立通道**：`notify` 只影响这一次显示，**不改持久配置**
（否则下次启动气泡上会挂着上次推送的旧话）。推送期间引擎状态让位
（`refreshStatusBubble` 里 `pushedStatus` 优先），推送自带停留时长，`sticky` = 常驻。

⚠️ 横条自动消失时**必须一并清掉推送标记**：不清的话下一次引擎状态刷新（每几秒一次）
会把同一条推送重新显示出来，用户看到的是"这条消息消失又冒出来、消失又冒出来"。

⚠️ 气泡没显示时 `notify` 返回 `false` 而不是先把它显示出来：`state:"hidden"` 是插件
明确要求"别出现"，为一条推送打破它是越权。

#### ⚠️⚠️ 自定义头像必须能用**落盘标记**读回来（踩过的静默丢数据 bug）

`avatar` 字段在**两条路径上不是同一个值**，这是本处最容易漏的地方：

| 时点 | 值 |
|---|---|
| 插件下发 | `data:image/png;base64,…`（几百 KB） |
| `save()` 落盘 | **`bubble-avatar.bin`**（只留文件名标记，base64 单独落盘） |

`avatarOf()` 的合法值白名单原本只写了 `default` / `none` / `data:image/…`，
于是**回读时把 `bubble-avatar.bin` 判成非法值退回 `default`**。两个后果：

1. **自定义头像重启即丢** —— 图片文件还在 `filesDir`，但配置里再没人引用它；
2. `bubbleAppearance()` 的回读值与 `bubbleApply()` 的下发值**不一致**，
   插件做「读-改-写」时会把头像悄悄洗掉（读回 `default`，写回 `default`）。

修法：白名单补上 `AVATAR_FILE`，并**核对文件真的存在**（用户清数据后不能留悬空引用）。
`merge()` / `avatarOf()` 因此各多一个可空 `context` 参数（纯解析场景传 null = 当作文件在）。

同一处的第二个坑：**下发 data URI 那一帧不显示自定义头像**。视图判定走
`usesCustomAvatar`（即 `avatar == AVATAR_FILE`），而 `applyAppearance` 拿到的是 data URI。
所以 `writeAvatar()` 成功后必须**把内存里的 data URI 换成文件标记**，否则表现为
「AI 换了头像但没反应，重启才看见」。落盘失败（不是有效位图）时退回改动前的头像值，
不能留一个指向不存在文件的引用。

真机验收（system 包）：下发 1×1 PNG 的 data URI → 立刻回读 `avatar:"custom"`
（修复前是 `default`）→ `am force-stop` 重启后仍是 `custom` → 读-改-写只动 `size`
时 `avatar` 保持 `custom` → 显式传 `default` 能切回内置、再传标记能切回自定义。

#### ⚠️ 新增桥方法要**三处一起改**，漏一处是静默失败

`system` 与 `gecko` 的内核实现分别在 flavor 源集里，**没有共享基类**，所以每个新方法都要：

1. `app/src/main/java/com/dsh/android/web/PageBridge.kt` —— 接口声明；
2. `app/src/system/java/.../SystemWebHost.kt` —— `@JavascriptInterface fun xxx(...)`；
3. `app/src/gecko/java/.../GeckoWebHost.kt` —— `dispatchInvoke()` 里加分支
   **并调 `pushSnapshot()`**（页面侧是**同步读快照**，不推送的话插件读回的是旧值）；
4. `app/src/gecko/assets/dsh-bridge/content.js` —— 在页面世界暴露同名函数，
   **并 bump `manifest.json` 的 `version`**（否则 GeckoView 继续用旧扩展）。

⚠️ gecko 侧的 `BRIDGE_INSTALLER_SOURCE` 是**模板字符串**：里面出现反引号会提前
终止模板，症状是整段 content script 不执行（见 ⑦.7 的三个注释陷阱）。

#### 转录通道：为什么另开一条路，不加进通知栏那条

状态通道（`mpReportStatus`）的正文上限 400 字，只够放"当前在做什么"。完整转录
（用户消息 + 每条助手回复 + 每次工具调用）**大两个数量级**，混进同一条通道会把
通知栏那条挤爆。

所以另开 `onTranscript`：页面侧 `mpCollectTranscript()` 采集 → `mpReportTranscript()`
**指纹去重**（内容没变一条都不发）→ `mpScheduleTranscript()` 1500ms 节流 →
另有 5000ms 兜底轮询。上限 `MP_TRANSCRIPT_MAX_ITEMS = 80` /
`MP_TRANSCRIPT_MAX_CHARS = 2000`（超出保留**最后** 80 条 —— 面板要看的是当前进展）。

采集范围限定 `.wSkVaW_viewArea`（取不到退回 `document`），按 selector 逐节点取文本。

⚠️ **工具行的判据是 `[data-chat-flow-kind="tool-call"]`，不是 `[data-tool]`。**
这一点踩过：`data-tool` 是 `dsh-client-ui-tool` 的标记，而本页面渲染工具行的是另一套，
真机全文档 `[data-tool]` 命中数**恒为 0** —— 只认它的后果是「工具调用一条都采不到」，
而其它条目都正常，所以很容易误判成"没有工具调用"而不是"选择器错了"。
真实形状（CDP 读活会话）：

```html
<div data-chat-flow-kind="tool-call" data-turn-process-member="true"
     data-turn-process-hidden="true" hidden="until-found">
  <div class="ztWv_q_callRow">
    <div class="CY-8Ka_card">
      <div class="CY-8Ka_root" data-sample="bash" data-state="ok" data-expandable="true">
        …「运行命令」+ 摘要「Echo TOOL_OK to test output」…
```

⚠️ **`data-sample`（工具名）与 `data-state` 长在内层 `[data-sample]` 节点上**，
不在 `[data-chat-flow-kind]` 那个外层 div 上 —— 直接读外层会全空。
`data-state` 取值 `ok` / `running`（后者映射成面板上的"运行中"）。

⚠️ **工具行处在折叠态（`hidden="until-found"`）也要采**：`textContent` 对 hidden
元素仍可读，而用户要的正是「展开面板能看到调了哪些工具」，折叠时恰恰最需要补这条。

完整选择器（`MP_TRANSCRIPT_SELECTOR`）：

```
[data-chat-flow-kind="user"],
[data-chat-flow-kind="steering"],
[data-chat-flow-kind="assistant-step"],
[data-chat-flow-kind="tool-call"],
[data-chat-flow-kind="turn-error"],
[data-tool]
```

⚠️ **`steering` 是用户在回合进行中追加的指令**，按用户消息显示（官方 chat.js 定义了这个
kind，但默认视图里不出现，所以要显式列进选择器才采得到）。

⚠️ **`turn-process` 与 `turn-tail` 刻意不采**：前者是「已完成，用时 9秒」那个折叠按钮
（纯耗时摘要，不是对话内容），后者是「用量 13.3K tok / 01:15」的页脚。两者都不属于
"微博里能看到的回复内容"，采进来只会让面板多两行噪音。

原生侧 `ChatTranscript.parse()` **永不抛异常**（畸形 JSON 只是解析成
空列表），畸形输入不能让悬浮球崩掉。

⚠️ **取文本必须先剔除元数据子树**（`mpTranscriptVisibleText()`）：官方把时间戳与
复制按钮放在同一条消息尾部，直接取 `textContent` 会得到
`只回复两个字：通了01:14` —— 时间戳粘在用户原话后面，看起来像用户自己打的字。
判据用 **`[data-clock]` 属性 + `button`/`svg` 标签**，不用哈希类名
（`xzv4MW_actions` 这种会随官方发版变，属性不会）。取不到就退回原文
（多带点噪音，不丢内容）。

⚠️ 助手回复**收窄到 `.hWmORq_root`**：官方 `AssistantMarkdown` 对 tool-call 块是
直接 `break` 跳过的（不渲染进 body），所以这里取到的是纯正文，不会把工具标题混进
助手回复里。这个前提一旦变了（官方改成渲染进 body），助手条目就会掺进工具标题。

#### 验收（真机，system flavor / CDPY-TN90 / Android 10）

四条必改行为逐条实测通过：

| 行为 | 判据 |
|---|---|
| 状态条 2 秒自隐 | 推状态后 0.7s 截图有横条，3.7s 截图已消失 |
| 拖出屏幕贴边 | `adb shell input swipe` 拖出右边界 → 日志 `气泡已贴边折叠: side=1 x=1062 y=963`，窗口 `Requested w=18` |
| 点贴边条弹回 | 日志 `气泡已从贴边态弹出: side=1 x=888 y=963`，随后 `expand()` 到面板态 |
| 面板拖动 | 拖顶栏 → `mAttrs` 由 `(120,963)` 变 `(120,628)` |
| 面板缩放 | 拖底手柄 → `Requested w=960 h=1062` → `623 x 1436`，落盘 `panel_w=623` / `transcript_h=867`；收起再展开仍是 `722 x 1384`（持久化生效） |
| 插件改外观 | `bubbleApply({"shape":"rounded","size":64})` → 返回 `true`，日志 `插件下发悬浮球外观: ...` + `气泡已显示: (888, 963) shape=rounded size=64` |
| 完整转录 | 面板里同时有用户消息、助手回复（含思考）、**工具调用行**，颜色/对齐正确 |
| 工具调用行 | 真机发一条「用 bash 工具执行 echo TOOL_OK」→ 面板出现「工具调用 / 运行命令 Echo TOOL_OK to test output」。⚠️ 判据是 `[data-chat-flow-kind="tool-call"]`，`[data-tool]` 在本页面恒为 0（见上） |
| 时间戳剔除 | 面板用户条目为 `只回复两个字：通了`（无 `01:14`） |

gecko flavor 同样实测通过：`bubbleApply` 走 native messaging 生效（面板被插件改过的大小
与配色在 gecko 包上原样重现），转录经桥到达原生 —— **这条只能走 native messaging，
没有第二条路，所以它的通过本身就证明了 gecko 桥的三个新分支都是通的**。

⚠️ **`input tap` 的 y 坐标要按 `mFrame` 算，不是 `mAttrs` 的 y**：实测 `mAttrs` 给
`y=963`，而 `mFrame` 是 `[888,1071]` —— 差 108px（状态栏）。按 `mAttrs` 点会**点在球
上方 108px 处**，表现为「点了没反应」，很容易误判成触摸逻辑坏了。取坐标一律用：

```powershell
adb shell dumpsys window windows | Select-String 'APPLICATION_OVERLAY|mFrame='
```

⚠️ gecko 包**没开 WebView 远程调试**（`dsh-bridge` 走的是 native messaging，
`/proc/net/unix` 里只有 `gecko-crash-helper-pipe`），所以 gecko 侧不能靠 CDP 探针验证，
只能靠**预置 `shared_prefs/dsh_bubble.xml` + 重启**观察行为。

