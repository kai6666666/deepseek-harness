# 后台保活与通知栏实时状态

> 本文是 [AGENTS.md](../../AGENTS.md) 的分册之一，
索引见 [docs/agents/README.md](README.md)。

## 后台保活（任务切到后台不能断）

引擎跑在本进程里，所以「App 切后台任务还能继续」= 让本进程既**不被回收**又**不被冻结**。
两层缺一不可：

| 层 | 手段 | 解决什么 |
|---|---|---|
| 系统回收 | `EngineService` 前台服务 + 常驻通知 | oom_adj 钉在前台档，内存压力下不被杀 |
| CPU 休眠 | `PARTIAL_WAKE_LOCK`（`dsh:engine`） | 锁屏后 CPU 不进 suspend，node 事件循环/定时器/网络回调继续跑 |
| ROM 冻结 | 电池优化白名单 | 华为「应用启动管理」/ OPPO「耗电保护」息屏几分钟就冻进程 |

### 通知栏实时状态（WebView → 原生）

常驻通知不只写「引擎正在运行」，而是**实时显示 AI 当前在干什么**：标题是当前动作
（「正在运行命令 · sleep 10」），正文是最后一条助手输出（运行中含正在流式的思考）。

链路：插件读 DOM → `window.DSHAndroid.onStatus(json)`（`addJavascriptInterface`）
→ `MainActivity.StatusBridge` → `EngineService.updateStatus()` → 用**同一个通知 ID**
`notify()` 更新（不重启服务）。

| 字段 | 来源（官方 DOM 契约，0.2.0-rc.2 实测） |
|---|---|
| `running` | `.uV2eYG_primary` 的 `aria-label` 变成「停止生成」。官方 `primaryStops` 为真时换 `t("input.stop")`（`dsh-client-ui-conversation/lib/client.js:17407`） |
| `text` | 最后一个 `.O_Ebla_title` 的文本。官方 `ProcessGroupHeader` 未关闭时用 `message.stepProcess.<activity>`（「正在运行命令」），关闭后用 `processTitle()`（「执行了命令」），都可能接 `" · "` + `liveToolDetail` 从工具参数提出来的详情 |
| `body` | 最后一个 `[data-chat-flow-kind="assistant-step"] .hWmORq_root` |
| `title` | `document.title` 去掉 `— DeepSeek Harness` 后缀，作通知副标题 |

⚠️ **正文选择器必须限定 `data-chat-flow-kind="assistant-step"`。** `.hWmORq_root`
是 `AssistantMarkdown` 的类，但同名容器**也会包住用户自己发的话**（真机实测用户消息是
`data-chat-flow-kind="user"`，内含 `Sixlwa_*` 气泡）。不限定就会把用户的话当成 AI 的进展。

⚠️ **通知卡片高度靠截断控制，不靠布局。** `BigTextStyle` 的展开态按正文**实际行数**
撑高，而助手输出动辄几百字，不截断会吃掉大半个通知栏（用户实测反馈）。三段各有字符上限
（`TITLE_MAX_CHARS` / `SUBTITLE_MAX_CHARS` / `BODY_MAX_CHARS`），全部按 **code point**
切（别按字节，会把 emoji 截成半个）。改这几个常量就是改卡片高度。

⚠️ **正文用 `truncateTail`（保留尾部），标题用 `truncateHead`。** 助手消息是**流式追加**
的，最新进展在末尾；保留头部会把通知栏钉死在几分钟前那句话上，反而看不出"现在在干什么"。

⚠️ **必须 `setOnlyAlertOnce(true)` + `setSilent(true)`。** 状态每秒都可能更新，
不加这两条每次刷新都会重新提醒一次（响铃/亮屏）。

⚠️ **`alive` 标志不能省。** 服务没起来时 `notify()` 会**凭空造出一条普通通知**
（不是前台服务的那条），用户会看到两条。`updateStatus()` 先查 `alive` 再发。

⚠️ 上报节流 1s 且**内容不变则一个字节都不发**（`mpLastStatusJson` 比对）——
流式输出时 DOM 变化极频繁，不节流会让通知栏闪烁并白耗电。

**验收手法**（数值证据，别靠截图猜）：

```powershell
# 通知当前内容（真机上最快的一招）
adb shell dumpsys notification --noredact | Select-String "android.title|android.text|android.subText"
#   → android.title=String (● 正在分析请求)
#     android.subText=String (会话标题)
#     android.text=String (…最后 100 字符，以省略号开头)

# 桥有没有挂上、页面侧判据对不对
adb shell pidof com.dsh.android     # 拿 pid，再用它建 CDP 转发
adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
# 期望：hasBridge=true，primaryLabel 与通知里的 ●/○ 一致
```

#### 顺带解决：键盘升起时下半屏先闪一块深色

**症状**：点输入框，键盘还没完全升起时，中间有几帧屏幕下半部分是纯黑的占位区域，
随后才被键盘填充。**不是加载慢**，是底色不一致。

**根因**：`adjustResize` 让窗口变矮是**逐帧动画**的，WebView 跟着变矮，但页面重排要等
下一帧 —— 这个空档里新露出的那条区域还没有内容覆盖，显示的是 **WebView 自己的背景色**。
原先三处写死 `#0F1115`（`MainActivity.kt` 的 `setBackgroundColor`、`activity_main.xml`
的 FrameLayout、`themes.xml` 的 `windowBackground`），而官方页面是白底，于是深色块闪出来。

**做法**：插件把 `document.body`（透明则退到 `html`）的计算色转成 `#RRGGBB`
（`mpPageBackground()`）搭车同一个状态 JSON 上报，原生侧 `applyPageBackground()`
在**主线程**把 WebView + 根容器 + 窗口背景一起改成该色。

⚠️ **不能写死白色**：官方主题可切换，写死只是把问题换到深色模式下重新暴露。
⚠️ **三处都要改**：DecorView 与 WebView 是两层独立合成，窗口缩小时各自的 Surface
更新不同步，只改一层仍可能露出一帧旧色。
⚠️ **`bg` 不参与通知去重**（`updateStatus()` 里 `copy(bg = "")` 再比）——
主题切换时通知内容一个字没变，不该白发一次通知。
⚠️ 只在底色**真变了**时才 `runOnUiThread`，否则每次状态刷新都白 post 一个任务。

#### 修复 65：键盘升起时输入框被盖住（原生预判 + 高度自学习）

**症状**：点输入框后键盘从屏幕底部升起，但输入框要等约 200ms 才跳上去，
中间几帧被键盘压住（用户实测反馈）。

**真机实测**（Huawei CDY-TN90 / Android 10，各 2~3 轮一致）：

| 测量项 | 结果 |
|---|---|
| focus → 窗口变矮 | **180~220ms** |
| 期间窗口高度变化 | `764 → 475`，**只有 1 个 resize 事件、无中间帧** |
| `visualViewport` vs `innerHeight` | **同一时刻**变化，没有更早的信号 |
| `navigator.virtualKeyboard.boundingRect` | 恒为 `0`（该内核不提供几何信息） |
| 主线程最长阻塞 | 76~85ms（不足以解释这 200ms） |

**根因**：这 200ms 内页面**拿不到任何"键盘现在多高"的信息**，只能干等窗口变矮。
逐帧 insets 回调要 API 30 的 `WindowInsetsAnimation`，本机（API 29）没有。
**这是平台行为，不是插件或主线程的问题。**

**做法**：**提前告诉原生"键盘要来了"**。页面 `focusin`（点击那一刻）走已有的
`DSHAndroid` 桥通知原生，原生按**上次实测的键盘高度**先把 WebView 变矮
（`bottomMargin`），真 insets 到达后归零、交还给 `adjustResize`。

```
页面 focusin ──onImeWillShow()──► MainActivity.applyImePrejudge()
                                     └─ setWebViewBottomMargin(缓存的键盘高度)
真 insets 到 ──onLayoutChangeListener──► 归零 margin + 保存这次实测高度
700ms 仍无 insets ──► restoreFromPrejudge("超时未见 insets")
```

⚠️ **要"学"的不是延迟，是高度。** 延迟是系统动画的固有节奏，我们"点击瞬间立即执行"
就天然覆盖了它，不用学；真正因机器/输入法而异的是**键盘有多高**（本机实测 867 物理 px）。
⚠️ **高度必须持久化**（`SharedPreferences` 名 `dsh_ime`）。只放内存的话每次冷启动
都会丢掉，症状变成"每次开机第一次点输入框都要闪一下"。
⚠️ **横竖屏分开存**（`ime_height_port` / `ime_height_land`）：横屏键盘更矮，
共用一份会让转屏后预判缩错高度。
⚠️ **判据不能用 `getWindowVisibleDisplayFrame()`**：`adjustResize` 下窗口本身已被缩小，
可见区域恒等于窗口高度，算出来永远是 0。改用「静止高度 − 当前根视图高度」
（`restHeightPx` 取历史最大值；键盘只会让内容区变矮、不会变高），
与插件侧已验证的 `restVh` 是同一套判据。
⚠️ **宽度变化（转屏）必须重置 `restHeightPx`**：否则拿竖屏的"历史最大高度"去减横屏的
当前高度，会得到一个巨大的"隐藏高度"被**误判成键盘可见**。
⚠️ **不要在 `onLayoutChangeListener` 里写「布局变化但键盘不可见就撤销预判」**：
预判自己改 `layoutParams` 会让根视图重新布局并触发该回调，那时键盘必然还不可见，
一撤销就等于预判从未生效。真正的"点了输入框但键盘没弹"由 700ms 超时兜底。

**已知代价**（如实记录，不是缺陷）：
- 冷启动后**第一次**点输入框仍会闪一下（还没有缓存值），闪完就学到了。
- 换输入法（键盘高度变了）会有一次轻微错位跳动，随后自愈。

**验收手法**（数值证据）：

```powershell
# 第一次点输入框（无缓存）→ 只应有"已学习并保存"
# 第二次起 → 应看到"键盘预判：提前缩矮 <N>px" 和"键盘预判结束（真 insets 已到 …）"
adb logcat -d -s DSH:I | Select-String "键盘预判|键盘高度已学习"
# 缓存落盘了没
adb shell run-as com.dsh.android cat shared_prefs/dsh_ime.xml
```

⚠️ **只做前台服务是不够的**：前台服务只保证进程活着，锁屏后 CPU 仍会 suspend，
长任务照样断。两件事必须一起做。

⚠️ **WakeLock 刻意不带超时**（`@SuppressLint("WakelockTimeout")`）。带超时的话到期会
**静默释放**，任务跑到一半 CPU 就被允许休眠了。生命周期由服务自己管：
`onCreate` 拿、`onDestroy` 放，服务在则锁在；进程被杀时内核自动释放，不会漏。
`setReferenceCounted(false)` 保证重复 `acquire()` 不会留下需要等次数的计数。

⚠️ **电池优化白名单是唯一由系统认可的免冻结标记**，且**必须用户手动确认**，
App 只能拉起系统对话框。`MainActivity.ensureBatteryExempt()` 在**尚未豁免**时才弹，
已豁免则静默返回，不反复打扰。国产 ROM 上不做这一步，前两层做得再对也会被冻住。

⚠️ `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` 在 Google Play 上受政策限制，**本项目侧载分发，
不受该限制**。不要因为「上架合规」把它删掉。

排查手法（数值证据，别靠猜）：

```powershell
# 前台服务在不在
adb shell dumpsys activity services com.dsh.android | Select-String EngineService
# WakeLock 持没持有
adb shell dumpsys power | Select-String "dsh:engine"
#   → mLock:... PARTIAL_WAKE_LOCK 'dsh:engine' ACQ=... (uid=... pid=...)
# 进程优先级（0 = 前台档）
adb shell "cat /proc/<pid>/oom_score_adj"
# 电池优化白名单
adb shell dumpsys deviceidle whitelist | Select-String dsh
```

