---
name: dsh-desktop-pet
description: 制作 DSH 移动端悬浮球外观 / 桌面宠物 / 精灵图动画 / 透明视频宠物时使用。内含悬浮球的落盘布局（bubble-frames 目录契约）、精灵图切片的精确规则、bubble 工具的全部字段与上限、透明 WebM 视频、动作池与随机链、状态图与台词、自主走动、七个运行状态到动作的映射，以及 AI 做宠物时最常犯的错。直接照此调用即可，不必再翻项目源码。
---

# 悬浮球外观与桌面宠物

## 0. 一句话结论

**AI 通过 `bubble` 工具改悬浮球。内容层可以是静帧（精灵图/轮播），也可以是透明 WebM 视频。**

```
bubble(action:"set", frameFiles:["/abs/sheet.png"], spriteRows:2, spriteCols:3, frameIntervalMs:120)
bubble(action:"set", video:"/abs/idle.webm")          // 真动画，dsh-pet 那种宠物用这个
```

精灵图只传一张图 + 一组网格数字，**不要**自己切成 N 张再传 N 个文件 —— 那是"轮播模式"，
能用但浪费：精灵图模式磁盘上只存 1 个文件，且改网格时不用重传图片。

⚠️ **不要以为悬浮球只能做精灵图。** `video` 字段支持带 alpha 通道的 VP9 WebM，
这是还原 `dsh-pet` 桌面宠物的正确方式（待机呼吸、扔出去、落地压扁都是真动画，
不是几张静帧）。

## 1. 精灵图契约（照这个做，不会错）

### 1.1 网格怎么切

- 图片被当作 `rows × cols` 的**等分网格**，每格是一帧。
- 单格宽 = `图片宽 / cols`，单格高 = `图片高 / rows`（**整数除法，余数丢弃**）。
  所以**图片尺寸最好是 cols / rows 的整数倍**，否则右边缘或下边缘会被裁掉几个像素。
- 帧顺序是**行优先**：先从左到右走完第一行，再第二行。
  即 2×3 的网格里，第 0 帧是左上角，第 2 帧是第一行最右，第 3 帧是第二行最左。

### 1.2 网格数字的硬限制

| 项 | 限制 |
|---|---|
| `spriteRows` / `spriteCols` | 每个 0–32，且**两个都要 > 0** 才进精灵图模式 |
| 总帧数 `rows × cols` | ≤ **64** |
| 单张精灵图 base64 | ≤ 6 MB（约 4.5 MB 原图） |

⚠️ 只写 `spriteRows` 不写 `spriteCols`（或写 0）= **不进精灵图模式**，
   那张大图会被当成"只有一帧"，用户看到的就是一整张网格图缩在球里。
   两个数字必须成对出现且都 > 0。

### 1.3 图片从哪来

- 参数是**绝对路径**，由插件所在进程读盘：`/sdcard/...` 下的图可以直接用。
- 允许扩展名：`.png` `.jpg` `.jpeg` `.webp` `.gif`。
- 用户发来的附件先在工作区里找到它的落盘路径，再把路径给 `frameFiles`。

### 1.4 只改网格、不重传图

想让同一个精灵图换一种切法（比如 2×3 改成 3×2），**只传网格数字**：

```
bubble(action:"set", spriteRows:3, spriteCols:2)
```

原生侧会发现"没有新帧"，于是复用已有的整图字节、只重写 meta。
**别重新传一遍图**，那是白白多传几 MB、而且容易触发体积上限。

## 2. 落盘布局（排查问题时按这个看）

`filesDir` 下：

```
bubble-frames/                    ← 默认动作（老数据，零迁移）
  ├── 0.bin                       ← 普通模式：一帧一个文件
  ├── 1.bin
  ├── …
  └── meta.json
bubble-frames/                    ← 精灵图模式：整张图只占一个文件
  ├── 0.bin                       ← 就是那张网格大图
  └── meta.json
bubble-frames/sets/<动作名>/       ← 命名动作（桌面宠物用这个）
  ├── 0.bin
  └── meta.json
```

`meta.json` 的形状：

```json
{"count":6,"durations":[120,120,120,120,120,120],"sprite":{"rows":2,"cols":3},"loop":-1}
```

⚠️ **默认动作就是 `bubble-frames/` 本身**，不是 `sets/default/`。
⚠️ **命名动作必须落在 `sets/` 下**：根目录的 `0.bin` 已被默认动作占用，
   平铺会撞名，表现为"配了新动作，默认动作的帧被顶掉"。

写入是**整目录替换**（先写临时目录再改名），所以任何一步失败都不会留下半个帧集。

## 3. 桌面宠物：一个状态一套动作

### 3.1 七个运行状态（写死，多一个少一个都静默不生效）

`idle`（没在跑）· `thinking`（模型生成中）· `working`（工具/命令执行中）·
`waiting`（等你确认/输入）· `error`（上一轮失败）· `result`（工具刚返回，在消化结果）·
`success`（上一轮顺利收工，瞬时）

⚠️ **后两个是追加的，按位置配置不会错位。** `workStatusTexts` / `statusImages`
是**按下标**取值的，所以 5 元素的数组仍然精确表示前 5 个状态。
**不要为了"凑满 7 个"去补空数组** —— 补了反而会把 `error` 的档位错开。

### 3.2 两步配出宠物

```
bubble(action:"set",
  actions:{
    "idle":  {frameFiles:["/abs/idle.png"],  spriteRows:2, spriteCols:4, frameIntervalMs:300},
    "think": {frameFiles:["/abs/think.png"], spriteRows:2, spriteCols:4, frameIntervalMs:150},
    "work":  {frameFiles:["/abs/work.png"],  spriteRows:2, spriteCols:4, frameIntervalMs:100},
    "sad":   {frameFiles:["/abs/sad.png"],   spriteRows:2, spriteCols:4, frameIntervalMs:400}
  },
  actionMap:{"thinking":"think","working":"work","error":"sad"})
```

配完之后宠物**自己**随状态切换，不再需要每次驱动。
`actions` 里每个动作的规格与 §1 的字段完全一致，外加 `frameLoop`、`video`。

- 动作名：只允许 `a–z 0–9 - _`，≤ 24 字符，**不能中文**（会变成目录名）。
- 未映射的状态回落到默认动作 —— 所以通常不用给 `idle` 建映射。
- 传空 `frames: []` 删除那个动作；`action:"get"` 返回磁盘上**真实存在**的动作清单
  （外加 `videoActions`，列出哪些动作有视频）。

### 3.3 透明视频：真动画

```
bubble(action:"set", actions:{
  "idle":  {video:"/abs/idle.webm"},
  "think": {video:"/abs/think.webm"}
}, actionMap:{"thinking":"think"})
```

- 每个视频约 200 KB–1.3 MB，上限 ~6 MB。**优先传路径，不要内联 base64**
  （base64 会再膨胀 33%）。
- 视频**优先于** `frameFiles`，所以两者可以同时给：视频是主，帧集当兜底。
- 传 `video:""` 删除该动作的视频。
- VP9 + alpha 是 `dsh-pet` 用的格式，这里播放正常。

### 3.4 主动驱动（不落盘）

跑长任务时想让宠物即时有反应：

```
bubble(action:"state", runState:"working")
bubble(action:"state", runState:"idle")
```

`action:"state"` **不保存任何设置**，只影响"现在演什么"。
`pinAction` 则会落盘（钦定一个动作，忽略 actionMap）；`pinAction:""` 回到自动。
**能用 `state` 就别用 `pinAction`** —— 后者会给用户留下一个改不回来的状态。

## 4. 让宠物"活起来"：动作池 / 台词 / 头顶图 / 自主走动

§3 配出来的宠物只会"你让它换它才换"。下面这些字段让它像活的。

### 4.1 `pools` —— 动作分组，由 App 驱动

```
bubble(action:"set",
  pools:{
    "idle":["breathe","look-around","scratch"],
    "click":["happy"],
    "drag":["dangling"],
    "move":["shuffle"],
    "turn":["spin-turn"],
    "work-thinking":["think-a","think-b"]
  },
  poolWeights:{"idle":10,"turn":2})
```

**六个特殊池名**：

| 池名 | 作用 |
|---|---|
| `idle` | **随机待机链**：没事干时随机抽一个播。一次性动作播完自动接下一个；循环动作每 8 秒重抽一次。这是"不再呆滞"的关键 |
| `click` | **点一下的反应**。⚠️ 配了它会**改变交互**：单击变成"摸宠物"，**面板移到长按**。用户主要靠点击开面板时**不要配它** |
| `drag` | 被拎起来时的姿势。不配就只是移动 |
| `move` | 自己走路时的姿势（需 `moveEnabled`） |
| `turn` | 转身姿势。⚠️ **动作本身不翻转**，翻转发生在它播完时，且要 `flipOnTurn` 开着（默认开） |
| `work-<状态>` / `state-<状态>` | **状态专属池**：每次进这个状态重新抽一个，是 `actionMap` 的升级版。两者都配时**池赢** |

其它任何池名（`celebrate` / `sleep` …）随便起，用 `actionMap` 或按名字播即可，声明不花钱。

### 4.2 `poolWeights` —— 权重

`{"idle":10}`。**`idle` 权重驱动随机链**：`0` = 关掉（宠物就停在 `actionMap` 说的那个动作上，
这是"我想要个安静的球"），不给默认 10。`turn` 是第二个有效权重，
**不给它权重它就永远不会被抽到**。其它池名接受但忽略，所以可以整表下发。

### 4.3 `workStatusTexts` —— 宠物的台词

按 `[idle, thinking, working, waiting, error, result, success]` 顺序，每档给多句随机抽：

```
bubble(action:"set", workStatusTexts:[
  ["在发呆"],["正在想…"],["正在干活…"],["等你确认"],["出错了"]
])
```

这是给宠物**配台词**的正确方式 —— 纯静态文本，**不需要任何 LLM 调用**。
只配关心的档即可（位置式，留空就是默认）。

### 4.4 `statusImages` —— 头顶小图（meme 面板）

结构与 `workStatusTexts` 完全相同，每次状态变化随机抽一张：

```
bubble(action:"set", statusImages:[
  ["/abs/idle.png"],["/abs/think.png"],["/abs/work.png"]
], statusImageSizeDp:96)
```

绝对路径或 `data:image/...;base64,...` 都行；字节会被拷进 App 自己的存储，
**原文件挪走也不影响**。某一档只有图没有台词是可以的（球上方就只显示图，这是常见观感）。
`statusImageSizeDp` 范围 32–240，默认 96。

### 4.5 `moveEnabled` —— 自主走动

```
bubble(action:"set", moveEnabled:true, moveIntervalSec:20, moveMinDp:24, moveMaxDp:80)
```

每 `moveIntervalSec` 秒自己走一小段。**默认关**：对宠物是可爱，对按钮是烦人，
**只在用户明确要宠物时才开**。

### 4.6 `moveParams` —— 每个动作不同步幅

```
bubble(action:"set", moveParams:{"shuffle":{"minDp":10,"maxDp":20},"dash":{"minDp":120,"maxDp":200}})
```

`{minDp:0,maxDp:0}` = 原地播放走路动画但不移动。

### 4.7 `flipOnTurn` —— 转身是否镜像

默认 `true`。素材通常只画了一个朝向，转身靠水平镜像实现。
**素材本身画了双向、或图里有文字**时关掉它。

## 5. 贴边态（球被拖出屏幕后那一条）

球拖出屏幕边缘会**折叠成贴在边上的"探头"**。它现在是**可自由编辑的一等公民**，
不是原来那条写死 6dp 的纯色薄缝：

| 字段 | 说明 |
|---|---|
| `edgeImage` | `"default"`（内置探头形象，默认）/ `"none"`（纯色薄片，老行为）/ `data:image/...` |
| `edgeFile` | 图片**绝对路径**，由插件读盘后下发。优先于 `edgeImage`，推荐用它 |
| `edgeWidth` | 可见宽度 dp，6–120，**默认 28** |
| `edgeHeight` | 可见高度 dp，`0` = 跟随球高（默认），上限 400 |
| `edgeOpacity` | 0–1，默认 1 |
| `edgeAnchor` | 0–1 固定竖直位置（0 = 顶，1 = 底）。`-1`（默认）= 沿用拖出去时的 y |

```
bubble(action:"set", edgeFile:"/abs/peek.png", edgeWidth:32, edgeAnchor:0.5)
```

⚠️ **默认宽度从 6dp 提到 28dp 是因为用户反馈"太小了，点不到"** ——
6dp × 44dp 在 3x 屏上只有 18×132 像素。**不要把它改小回 6**。

⚠️ 图片用 `fitCenter` 绘制，竖长的探头形象不会被压扁；两侧留白是透明的，
**但仍属于可点击区域**（点到留白也能唤出球）。

## 6. 画布尺寸（宠物形象不是正方形时）

- `size`：球的长边，24–160 dp。
- `boxWidth` / `boxHeight`：画布（背景框/窗口）尺寸，16–400 dp，`0`（默认）= **自动**
  —— 按当前素材长宽比算，长边 = `size`，短边按比例。所以正方形头像得经典的圆球，
  宽精灵图得宽框。只给一个另一个照样跟着素材走。
- 素材周围的空白是透明的（`bgOpacity:0` 可完全去掉背景板）。
- `showDot` 默认 **false**：那个绿点压在宠物形象上，与桌宠观感冲突。

## 7. 上限（超了会明确报错，不会静默）

| 项 | 上限 | 超了会怎样 |
|---|---|---|
| 单个动作帧数 | 64 | 截断（工具会说明） |
| 单个动作 base64 总量 | 6 MB | 明确报错，要求压图或减帧 |
| **一次调用的全部动作** base64 总量 | 12 MB | 明确报错 |
| 动作数量 | 24 | 明确报错 |
| 动作名长度 | 24 字符 | 明确报错 |
| 单个视频 | ~6 MB | 明确报错 |

⚠️ 6 MB / 12 MB 这两条**是防内存爆的，不是防磁盘的**：帧以 base64 进 JSON，
   原生侧要一次性 `readText()` 整个文件。超了会让 App 被系统杀掉，
   **症状是"悬浮球突然消失、什么都没发生"**，极难归因。
   所以：一次只配 2–3 个动作，图片先压到 256×256 上下。**视频走路径就不会撑爆。**

## 8. AI 做宠物最常犯的六个错

1. **把精灵图切好再逐帧传** —— 浪费传输量，且很容易撞 6 MB 上限。
   用 `spriteRows`/`spriteCols` 传一张图。
2. **只给一个网格数字** —— 不进精灵图模式，球里显示整张网格图。
3. **以为只能做精灵图** —— 有 `video` 字段（透明 WebM），做 `dsh-pet` 那种真动画该用它。
4. **配完不检查可见性**：默认 `state:"auto"` 时，**悬浮球只在 App 退到后台才可见**。
   用户正盯着 App 看，却说"我什么都没看到" —— 这是**预期行为不是失败**。
   要当场展示效果，先 `bubble(action:"set", state:"collapsed")` 把它钉在前台可见。
5. **用中文动作名** —— 被白名单拦掉。用 pinyin/英文。
6. **随手配 `click` 池** —— 会让单击变"摸宠物"、面板移到长按，
   把用户习惯的"点一下开面板"弄坏。除非用户明确要互动，否则别配。

## 9. 验收

1. `bubble(action:"get")` 读回当前外观、**磁盘上真实存在的 actions 列表**与 `videoActions`。
2. `adb logcat -d -s DSH:I` 里有
   `悬浮球动作帧集已更新: <动作名> = N 帧（精灵图 R×C）`。
3. **人眼看**：`state:"collapsed"` 钉到前台，看它有没有在动、切得对不对。
   动画是否流畅、切帧是否错位是视觉判断，日志替代不了。

## 10. 边界（知道就好，别越界）

- 悬浮球是**独立进程里的一个窗口**，工具通过文件信箱与它通信（写 `$DSH_HOME/bubble-cmd.json`，
  原生 250 ms 轮询）。所以单次调用有 4 秒等待上限；超时会明确返回"可能已生效也可能没有，
  请用 `action:"get"` 复查"，**这时不要当成功**。
- 非法字段值会**回落成当前值**而不是报错，未知字段被忽略 —— 所以打错字不会让球消失，
  但也不会生效。改完务必 `get` 复查。
- `action:"notify"` 推一条横条消息，**不改任何持久设置**；球处于 `hidden` 时返回 `false`
  （插件明确要求"别出现"，为一条推送打破它是越权）。
