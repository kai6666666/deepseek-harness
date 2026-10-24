# ⑫.3 bubble 工具

> 本文是 [AGENTS.md](../../AGENTS.md) 的分册之一，
索引见 [docs/agents/README.md](README.md)。

### ⑫.3 `bubble` 工具 —— 让**模型自己**改悬浮窗（补上可发现性那一段）

⑫.2 那条链对**页面侧插件**是通的，但对**模型**是关着的：

| 谁 | 能不能改悬浮窗 | 为什么 |
|---|---|---|
| 页面侧插件（`client.js`） | ✅ | 浏览器里直接摸到 `window.DSHAndroid` |
| **模型（AI）** | ❌ | 它的工具跑在 **Node 进程**里，那里没有 `window` |

所以「让 AI 改悬浮窗像改自己的 web 界面一样简单」在**可发现性**上是假的 ——
模型既不知道有这个能力，也没有任何途径触达它。⑫.3 补的就是这一段：
注册一个独立工具 `bubble`，并给它一条回原生的通道。

```
模型 ──调用 bubble 工具──> dsh-android-bubble（Node 插件，跑在引擎进程）
                                │ 写 $DSH_HOME/bubble-cmd.json
                                ↓
                    BubbleCommandBridge（原生，250ms 轮询）
                                ↓ FloatingBubble.applyAppearance()
                                │ 写 $DSH_HOME/bubble-result.json
                                ↑
模型 <──工具返回──────────────┘
```

| 件 | 位置 |
|---|---|
| 插件源码 | `mobile-ui-plugin/dsh-android-bubble/` |
| 打包产物 | `assets/bubble-tool.zip`（解到 `$DSH_HOME/bubble-tool/dsh-android-bubble/`） |
| overlay | `$DSH_HOME/bubble-tool.patch.yml`（`ensureBubbleTool()` + `writeBubbleToolPatch()`） |
| 原生通道 | `BubbleCommandBridge.kt`（`EngineManager.start()` 里 `BubbleCommandBridge.start(dshHome)`） |

#### 为什么是文件信箱，不是 socket / Binder

引擎 node 是 App 进程的**子进程**，同域、共享 app 私有目录，文件是最短的那条路。
本项目已有同构先例（`adb-wireless-port`：Kotlin 写、Node 读），这里只是把方向反过来。
不选 AF_UNIX 抽象命名空间：Android 的 app 域对命名管道的策略随版本变，
而文件在两个方向上都已经验过。

⚠️ **请求带自增 `id`，回执按 id 配对。** 没有它，「两个工具调用并发、后一个的回执
被前一个读走」会让模型拿到张冠李戴的结果。缺 `id` 的请求原生侧**直接丢弃并删文件**
（否则会卡住一个永远等不到答案的工具调用）。

⚠️ **原生侧先写回执、再删请求文件。** 反过来的话插件会超时 —— 它区分不了
「还没处理」与「回执丢了」。

⚠️ **回执文件由插件在发命令前主动删掉**（不是写空对象）：写空对象会让「解析失败」
与「还没处理」两种状态混在一起，只能靠 id 分辨，多一处出错的机会。

⚠️ **超时不返回成功。** 原生侧可能只是慢（引擎刚启动、主线程正忙），但返回 `ok`
会让模型以为改成功了。超时文案明确要求它用 `action:"get"` 复查。

⚠️ **`avatarFile` 在插件侧读**，不把路径交给原生：原生按自己的沙箱跑、拿不到工作区
路径，而插件与 `read` 工具同进程同权限。读取失败**明确报错**，不静默退回内置头像
（那样用户会看到球变成默认头像却没有任何提示）。

⚠️ **`DSH_HOME` 缺失/不存在时不注册工具。** 注册一个必然失败的工具比不注册更糟 ——
模型会反复重试。

#### 验收（真机，system flavor）

| 步骤 | 判据 |
|---|---|
| 插件挂载 | `已安装悬浮球控制工具插件 dsh-android-bubble (27981 字节)` + `已写入悬浮球控制工具 overlay: bubble-tool.patch.yml` + 启动命令行里出现 `--patch .../bubble-tool.patch.yml` |
| 信箱启动 | `悬浮球命令信箱已启动: /data/.../files/home/.dsh/bubble-cmd.json` |
| 通道往返（不经模型） | 手写 `{"id":1,"action":"get"}` 落进 `bubble-cmd.json` → 回执含完整外观 JSON，且请求文件被删 |
| 写入生效 | 手写 `{"id":2,"action":"set","fields":{"size":120,"shape":"square"}}` → 回执 `ok:true`，日志 `插件下发悬浮球外观: state=collapsed shape=square size=120`，`dumpsys` 的 `Requested w=360 h=360`（120dp × density 3.0） |
| **模型端到端** | 在官方 composer 里发「用 bubble 工具把悬浮球改成圆形、金黄色底 #FFC107、大小 90」→ 落盘 `shape=circle` / `size=90` / `bg=#FFC107`，日志同款一行，窗口 `Requested w=270 h=270` |

⚠️ 手写命令文件的坑：**PowerShell 里用 `adb shell "run-as ... sh -c 'printf ...'"` 转义
嵌套引号会被 PS 解析器吃掉**。稳妥做法是先在 PC 落一个 `.json`，`adb push` 到 `/sdcard`，
再 `run-as cp` 进私有目录。
⚠️ **写 JSON 必须用 UTF-8**（`[System.IO.File]::WriteAllText($p, $s, (New-Object System.Text.UTF8Encoding($false)))`）。
用 `-Encoding ascii` 会把中文替换成 `?`，而症状是**推送的横条显示成一串问号**，
看起来像"中文渲染坏了"，实际是测试脚本自己把字写坏了。

#### 分层外观的真机验收（2026-10-12，CDY-TN90 / Android 10）

| 能力 | 下发 | 判据 |
|---|---|---|
| 任意 SVG 形状 | `{shape:"path", shapePath:"M50 3 L61 38 …Z", size:120, bg:"#FFFFC107", avatar:"none"}` | 截图里球变成**黄色五角星** |
| 背景透明、图片留着 | `{bgOpacity:0, avatarOpacity:1}` | 截图里只剩头像、无背景板 |
| 轮播（4 张独立图） | `{frames:[4 个 data URI], frameIntervalMs:250}` | 日志 `悬浮球帧集已更新: 4 帧`；连续截图在球心采到 **4 种不同颜色** |
| 精灵图 2×2 | `{frames:[一张大图], spriteRows:2, spriteCols:2}` | 日志 `悬浮球帧集已更新: 4 帧（精灵图 2×2）`；同样采到 4 种颜色 |
| 旋转 + 呼吸同时 | `{spin:120, pulse:true}` | 蓝发重心与蓝像素数**均**周期变化（证明两个动画并行，没互相取消） |
| AI 主动推状态 | `{"action":"notify","text":"AI 主动推送测试 · 收到请举手","durationMs":9000}` | 截图里球上方横条显示该文案（中文正常） |
| 重启持久化 | 下发含全部新字段的配置 → `am force-stop` → 重启 → `action:"get"` | `shapePath` / `bgOpacity` / `avatarOpacity` / `avatarScale` / `frameCount` / `frameIntervalMs` / `frameLoop` / `spin` / `pulse` **全部完整读回** |
| 改大不跑出屏幕 | 球在 `x=1062`（贴右缘）时下发 `{size:140}` | `dumpsys` 里 `mAttrs=(660,578)` + `Requested w=420 h=420`，即被夹到 `1080-420=660` |

⚠️ **测试残留必须清回默认**（`state:"auto"` / `shape:"circle"` / `size:44` / 空 `shapePath`
/ `spin:0` / 空帧集），并删掉 `files/bubble-frames/` 与 `files/bubble-avatar.bin`。
⚠️ **必须先 `am force-stop` 再改 `shared_prefs/dsh_bubble.xml`** —— 不然内存里的旧配置
会在下次落盘时把文件覆盖回去，用户看到的是"我改了但没生效"。


