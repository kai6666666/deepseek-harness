# ⑫.4 桌面宠物

> 本文是 [AGENTS.md](../../AGENTS.md) 的分册之一，
索引见 [docs/agents/README.md](README.md)。

### ⑫.4 桌面宠物 —— 把引擎的运行状态透传给悬浮球

**需求原话**：「如果我让 AI 做一个桌面宠物，宠物分不同状态，思考时用什么动作、等待时
用什么动作、待机用什么动作，可以做到吗？」

**做不到的不是渲染，是"状态"与"动作"这两件东西在模型里都不存在。** ⑫.2 的分层外观
只有**一个** `avatar`（外加一套 `frames`），而"宠物"要求的是**每个状态一套动作**；
并且没有任何通道把「AI 此刻在思考」这件事送到原生侧。

⑫.4 补的就是这两块：**多命名动作帧集** + **状态透传**。

#### 一、多命名动作帧集（`BubbleFrames`）

磁盘即注册表，**没有任何"注册动作名"的步骤**（少一步就能写错一步）：

```
files/bubble-frames/            动作 `default`（老布局，不搬）
files/bubble-frames/sets/idle/   动作 `idle`
files/bubble-frames/sets/work/   动作 `work`
```

每个动作目录里是一套完整的帧集（`0.bin`/`1.bin`… + `meta.json`），
与 `default` 的布局逐字相同 —— 所以**老安装的帧集原地就是 `default` 动作**，不用迁移。

动作名是**自由字符串**，`BubbleFrames.normalizeAction()` 白名单校验
（`a-z0-9-_`，≤24 字符），非法名返回 `null`（顺带挡掉 `../` 路径穿越）。
`actionNames()` 扫磁盘得到可用动作列表（`default` 有帧才排最前，其余按名排序）。

⚠️ **动作名非法时是「保持原样」而不是「报错退出」**：一个写错的动作名不该让整个
外观下发失败（其他字段还是好的）。

#### 二、状态 → 动作的映射（`actionMap`）

```jsonc
{
  "action": "",                        // 钦定动作；空串 = 跟随 actionMap 自动切换
  "actionMap": {                       // 运行状态 → 动作名
    "idle":     "idle",
    "thinking": "think",
    "working":  "work",
    "waiting":  "wait",
    "error":    "sad",
    "result":   "read",                // 可选：工具刚跑完、在消化结果
    "success":  "cheer"                // 可选：上一轮顺利收工（瞬时）
  }
}
```

运行状态固定七个：`idle` / `thinking` / `working` / `waiting` / `error` /
`result` / `success`（`BubbleAppearance.RUN_STATES`，与插件侧 `RUN_STATES` 必须一致）。

⚠️ **后两个是追加的，位置式配置不会因此错位。** `workStatusTexts` / `statusImages`
按 `RUN_STATES` 顺序**按下标**取值，所以 5 元素的数组仍然精确表示原来那 5 个状态
（`result` / `success` 两档留空 ⇒ 用默认文案/无图）。**不要为了"凑满 7 个"去补空数组**，
补了反而会把 `error` 的档位错开。

- `result`：工具**已返回**、模型在消化结果。与 `working`（工具执行**中**）的区别是
  "手上有没有活在跑"。单列是因为这两个状态体感明显不同，宠物能表达这个差别。
- `success`：上一轮顺利收工，**瞬时**状态 —— 由 `turn/end` 带 `completed` 触发，
  随即回到 `idle`。宠物在这段时间播"庆祝"类动作。

**该播哪个动作的优先级**（`FloatingBubble.wantedAction()`）：

| 序 | 来源 | 语义 |
|---|---|---|
| ① | `appearance.action` 非空 | AI 明确点名，**压过一切**（且落盘持久） |
| ② | `stateOverrideAction` | 脚本/插件临时钦定，不落盘 |
| ③ | `actionMap[runState]` | 按当前运行状态自动映射 |
| ④ | 都没有 | `default` |

⚠️ **`action` 的「空串」与「`default`」是两回事**：空串 = 跟随 `actionMap` 自动切换；
`"default"` = 就播默认动作、**不要**自动切。两者都合法，别把空串归一化成 `default`。

⚠️ **要的动作不在磁盘上就退回 `default`**，并把 `frameAction` 记成**实际播的那个**。
若不退回：`actionMap` 配了 `thinking` 但用户从没传过 thinking 的帧，球会**整个变空白**
（帧文件找不到），比"动作没换"严重得多。
⚠️ 退回日志**只对非 `default` 动作打** —— 否则每个没传过帧的用户每次启动都会看到一行
"改用默认动作"，把日志淹掉。

#### 三、状态从哪来：两条通道，一粗一细

| 通道 | 来源 | 粒度 | 毛病 |
|---|---|---|---|
| 粗 | 页面 DOM 的 `data-process-activity` → `EngineStatus.activity` | 每 ~1 秒 | 短于一秒的工具调用**整个漏掉** |
| 细 | `dsh-android-pet` 插件订阅引擎 `session/event` | 每事件，插件 120ms 合流 | 无 |

⚠️ **`EngineStatus.activity` 一度是「页面在发、原生没读」**：`parse()` 里根本没解析这个
字段，值到了就被丢掉。要断言这条通道，先确认 `parse()` 真的读了它。

**细通道的链路**：

```
引擎（session/event，@mode emit，监听器抛错只记日志）
   │ dsh-android-pet：EVENT_STATES 表 → 运行状态
   ↓ 原子写 $DSH_HOME/bubble-state.json（tmp + rename）
BubbleCommandBridge（原生，250ms 轮询）→ 读后即删
   ↓ FloatingBubble.applyRunStateToActive()
FloatingBubble：applyRunState() → applyActionLayer() → 换帧集
```

`EVENT_STATES` 只列**有明确归属**的事件（`turn/start`→thinking、`tool/call`→working、
`approval/asked`→waiting…）。**没列的事件一律忽略，不猜** —— 猜错会让宠物在"认真思考"
时突然切回待机，比不切更糟。事件名取自 `@deepseek-ai/dsh-session` 的
`KNOWN_SESSION_EVENT_TYPES`（已在真机逐条核对）。引擎升级后新增事件不会让本表失效，
只是那些新事件不驱动宠物。

⚠️ **`turn/end` 要特判**：它是唯一一个"这一轮结束了"的信号，且要区分成败
（`data.kind` 落在 `failed`/`error`/`aborted`… 或带 `error` 字段 ⇒ `error`，否则 `idle`）。
判据**刻意宽松、只认明确失败**：拿不准时按成功处理 —— 反过来会让宠物动不动就耷拉下来。

#### 四、⚠️ 三个必须走对的地方（都踩过）

**① 状态落了，动作没跟着换。** `syncRunStateFromPlugin()` 起初**只改 `runState`、
不刷动作层**，理由是"动作名会紧接着设"。但插件**可以只报状态不带动作名**（那是它的
常态），于是 `runState` 一路跟着变、`playingAction` 纹丝不动 —— `actionMap` 形同虚设。
两条通道现在都收敛到同一个 `applyRunState()`。

**② 一次状态推送别刷两遍轮播。** `applyRunStateToActive()` 里**先落钦定动作、再落运行
状态**。反过来的话，钦定还没生效时 `applyRunState()` 会先按 `actionMap` 刷一次，
紧接着钦定那步又刷一次。同理 `applyRunState()` 内部**动作没变就直接返回** ——
状态每秒推一次，无条件重刷会把正在播的那一轮打断，表现为"宠物动作一卡一卡"。

**③ `publish()` 的备份目录参数传成了临时目录。** 帧集发布是
「写 `…tmp` → rename 到目标，失败则从备份回滚」。我把第三个参数（备份目录）误传成
`tmpFor(...)`，于是**先把刚写好的临时目录删掉再 rename**，必然失败：
日志 `帧集改名失败，回滚` + `悬浮球动作 X 写入失败，保持原帧集`，
而回执**仍是 `ok:true`**（`actions` 那一路是逐动作容错的）。这是**回归**——
`default` 动作的写入走同一函数，同样受影响。备份目录必须是 `oldFor(...)`。

#### 五、为什么用**另一个文件**做状态信箱

`bubble-cmd.json` 是**按 `id` 配对**的请求/响应，`bubble-state.json` 是**单向、无回执、
读完即删**。不复用同一个文件，两条都是硬理由：

1. **id 空间会撞**：工具与插件各自从 1 开始自增，同一个 id 同时存在时，工具调用会收到
   状态播报的回执，表现为"AI 说改了悬浮球但没生效"；
2. **会互相覆盖**：工具写完命令要等最多 4 秒回执，这期间被状态播报覆盖就必然超时。

而状态播报本来就不需要回执（它是"我在干什么"，不是"请你做什么"）。

⚠️ **`action` 是命令名，动作名一律走 `name` 字段**（这两个名字撞过一次）。
⚠️ **「字段不存在」与「字段是空串」语义不同**（前者 = 别动钦定，后者 = 清掉钦定），
所以原生侧用 `json.has("name")` 判定，**不能用 `optString`**（它区分不了）。
⚠️ **解析失败不删文件**（只在成功处理后删）：否则一次读到写一半的内容，那条状态就永久
丢了。插件侧写盘用 `tmp + rename` 保证原生读不到半截。

#### 六、为什么插件**只报状态**，映射留在原生

插件是**传感器**，原生才是**策略**。把 `actionMap` 也放进插件就会出现**两份映射**
（原生一份给离线/无插件场景、插件一份给在线场景），它们必然漂移，而症状是
"有时按状态换动作、有时不换"。

#### 七、两个插件为什么不合并

| | `dsh-android-bubble` | `dsh-android-pet` |
|---|---|---|
| 何时跑 | **只在模型调用 `bubble` 工具时** | **每一轮**都在跑 |
| `inject` | `['tools']`（要注册工具） | `[]`（只订阅事件 + 写一个文件） |

⚠️ **`inject` 多声明一个服务就多一个"引擎没这个服务 ⇒ 整个插件不激活"的机会**，
而本插件失效的症状是**静默的**（宠物不动了，没有任何报错）。所以 pet 的 `inject` 是空数组。

⚠️ **插件里不要用 `ctx.logger`，用 `console.log`。** 本 App 只把引擎子进程的
stdout/stderr 转发进 logcat（`dsh-core-memory` 的"已激活"就是这么打的），
`ctx.logger` 的去向在移动端**不可见**。用 `ctx.logger` 的后果是**"插件到底有没有激活"
根本查不出来** —— 而本插件的失效症状本来就是静默的。这条踩过一次：
`dsh-android-pet` 早已正常激活，却因为日志通道不对而查不出，白排查了一轮。

#### 八、真机验收（2026-10-12，CDY-TN90 / Android 10，system flavor）

**通道往返（不经模型）** —— 手写 `bubble-state.json`：

| 推的状态 | `runState` | `playingAction` |
|---|---|---|
| （初始） | `idle` | `idle` |
| `working` | `working` | **`work`** |
| `thinking` | `thinking` | `idle`（`actionMap` 里 thinking→idle） |
| `idle` | `idle` | `idle` |
| `error` | `error` | `idle` |
| `waiting` | `waiting` | `default`（没配 waiting 的映射） |

**真实 `session/event` 全链路** —— 在 GUI 里发一条会跑工具的消息（`run sleep 8`），
原生侧每 700ms 读一次 `action:"get"`：

```
基线:            idle/idle
[1..5]  轮询:    thinking/idle      ← turn/start 等事件驱动
[6..14] 轮询:    working/work       ← tool/call 驱动，动作真的换了
```

**采样手法**：状态文件**读完即删**，PC 侧轮询（每 400ms 一次 adb）会漏掉大部分中间状态。
要看完整序列就在**设备侧**起一个高频采样循环（`sleep 0.05`，把每次内容追加到日志文件），
事后再去重保序 —— 实测一次真实 turn 采到 `{"state":"thinking","at":…}`。

**其它判据**：

| 项 | 判据 |
|---|---|
| 插件挂载 | `已安装桌面宠物状态桥插件 dsh-android-pet (<N> 字节)` + `已写入桌面宠物状态桥 overlay: pet-bridge.patch.yml` + 启动命令行里出现 `--patch .../pet-bridge.patch.yml` |
| 插件激活 | logcat 里 `[engine] dsh-android-pet: 状态桥已启动: /data/.../files/home/.dsh/bubble-state.json` |
| 动作落盘 | `find files/bubble-frames -type f` 列出 `sets/idle/0.bin`、`sets/idle/meta.json`、`sets/work/…` |
| 动作就位 | `悬浮球动作 idle 已就位: 1 帧` / `悬浮球动作 work 已就位: 1 帧` / `已写入悬浮球动作集: idle, work` |
| 回执含新字段 | `action:"get"` 的 `appearance` 里同时有 `action` / `actionMap` / `actions` / `runState` / `playingAction` |

⚠️ **回执里的 `appearance` 是「JSON 里的 JSON」**（一个转义过的字符串），
用正则从原始文本里抠 `"runState":"…"` **抠不到**（反斜杠转义）。
要先 `ConvertFrom-Json` 拿到外层对象，再对它 `.appearance` 二次解析。这一处卡过一轮。

⚠️ **`action:"get"` 的 `appearance` 来自磁盘配置，`runState`/`playingAction` 来自活着的
那个悬浮球实例** —— 所以球没显示时后两个字段读不到。读之前先 `KEYCODE_HOME` 让球出来。

**测试残留**：`am force-stop` → 配置重置为默认（含 `action:""` 与空 `actionMap`）→
删 `files/bubble-frames/`、`files/bubble-avatar.bin`、`files/home/.dsh/bubble-state.json`、
`files/sample.sh`、`files/sample.log`。


