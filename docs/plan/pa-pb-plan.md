# A + B 详细计划：多线路下载（A）/ 启动计时（B）

> 立项：2026-11-24　目标版本：`0.2.2-rc.5-debug.38`（vc123）
> 参考实现：工作区 `Operit-main`（`util/GithubReleaseUtil.kt`、`core/application/OperitApplication.kt`）
> 决策依据：`docs/plan/progress.md` D7 / D8

---

## 0. 为什么要做这两件（一句话）

| | 现状 | 后果 |
|---|---|---|
| **A 多线路** | `RuntimeDelta` 只有一个 URL：`https://github.com/<repo>/releases/download/<TAG>/<name>` | 国内直连 GitHub 的 release 下载经常超时/中断 → **增量更新在真实网络下不成立** |
| **B 启动计时** | `ProotHost` 启动（t+3.57s）到 `engine.ready`（t+51.40s）之间 **47.8 秒零日志** | 想优化却没有数据；任何"我觉得这里慢"都是猜 |

A 是**可用性**问题（下不动 = 功能不存在），B 是**可观测性**前提（不测量不优化）。
两项都只动「下载路径」与「日志打点」，不动运行时结构与身份。

---

# A. 多线路下载

## A1. 目标与非目标

**目标**

1. `github.com/<repo>/releases/download/*` 的下载（清单 + 4 个分片）能自动选最快的可用线路。
2. 全部线路不可用时**退回直连**，行为与现在一致（不引入新的失败模式）。
3. 探测成本可控：**一次选路的总探测流量 ≤ 256 KB**，且结果可缓存。

**非目标**

- 不给 `api.github.com` 走镜像（镜像不转 API；`ReleaseFeed` 保持原样）。
- 不改增量算法、不改清单格式、不改校验逻辑。
- 不做「下载中途换线路重试」（v1 只在**选路阶段**做多线路）。

## A2. Operit 的做法与我要改的地方

Operit `GithubReleaseUtil.kt` 的关键参数：

```kotlin
private val GITHUB_MIRRORS = linkedMapOf(/* 34 个 */)
private const val SPEED_TEST_BYTES = 256 * 1024L          // 每个镜像拉 256 KB
suspend fun probeMirrorUrls(urls, timeoutMs = 2500)        // 34 个并发探测
```

**照抄会出问题**：`34 × 256 KB = 8.5 MB`。为省 100 MB 的下载先去烧 8.5 MB，
在移动网络上是**负优化**，而且用户会看到"检查更新"消耗流量。

我的改法（三段式，流量从 8.5 MB → ≤ 256 KB）：

```text
① HEAD 并发探活（0 字节）
   判据：HTTP 200/206、Content-Length 与清单 bytes 一致、Accept-Ranges: bytes
   → 这一步就把「死掉 / 返回 HTML 错误页 / 不匹配大小 / 不支持 Range」的全筛掉

② 对存活者做 RTT 排序，只取前 3 个做真速测
   每个拉 64 KB（Range: bytes=0-65535），取 bytesPerSec 最高者

③ 选出 1 个主线路 + 保留 1 个备选（下载失败可换一次）
```

**为什么不支持 Range 就必须筛掉**：增量下载是按块（`chunkSize=65536`）发 `Range` 请求的，
不支持 Range 的镜像拿到的是**整个文件**，等于全量下载 —— 比直连更慢，且会打乱
`planDelta` 的"只下变化块"语义。

## A3. 落地文件与改动点

### 新增 `app/src/main/java/com/dsh/android/runtime/GithubMirrors.kt`

纯逻辑 + 网络探测，无 Android 依赖之外的东西（`HttpURLConnection`），可单测其**纯函数部分**。

```kotlin
internal object GithubMirrors {
    /** 只保留对 release 下载有意义的线路；顺序 = 默认优先级 */
    private val MIRRORS: LinkedHashMap<String, String> = linkedMapOf(...)

    data class Probe(
        val name: String,
        val url: String,
        val ok: Boolean,
        val bytes: Long,          // Content-Length
        val ranges: Boolean,      // Accept-Ranges: bytes
        val rttMs: Long,
        val bytesPerSec: Long,
    )

    /** 只对 github.com + /releases/download/ 生效（同 Operit 的过滤条件） */
    fun mirrored(url: String): Map<String, String>

    /** ① HEAD 并发探活，返回存活且大小匹配者 */
    suspend fun probeHeads(urls: Map<String, String>, expectBytes: Long, timeoutMs: Int): List<Probe>

    /** ② 前 N 个做 64 KB 真速测，返回按吞吐降序 */
    suspend fun probeSpeeds(cands: List<Probe>, sampleBytes: Long, timeoutMs: Int): List<Probe>

    /** ③ 一次选路：返回 (primary, fallback?)；全挂则返回 null（调用方退回直连） */
    suspend fun pick(expectedUrl: String, expectBytes: Long): Pair<String, String?>?
}
```

### 改 `RuntimeDelta.kt`

现状（`latestRuntimeRelease()` 已改 Atom）：

```kotlin
private const val REPO = "kai6666666/deepseek-harness"
// 拼：baseUrl + name，baseUrl = "https://github.com/$REPO/releases/download/$TAG/"
```

要改的地方只有**下载入口**，共 3 处：

| 位置 | 现在 | 改成 |
|---|---|---|
| 探清单 `httpGet(chunksUrl)` | 直连 | 先 `pick()`，成功用 primary，失败退直连 |
| `planDelta` 里取分片 | `rel.baseUrl + name` | 同一次选路的 primary |
| `readFully`/Range 请求 | 直连 | primary 失败一次后换 fallback 重试**该块** |

⚠️ **选路只做一次**，在 `runApply` 开头把 `primaryBase` 算好并复用 —— 不要每个块都探测。

### 缓存

`GithubMirrors` 内部用内存缓存（`pick()` 结果 + 时间戳，TTL 30 分钟），
**不落盘**：镜像可用性变化快，落盘反而会用过期结果。

TTL 内再次更新直接复用；跨 App 重启重新测（成本 ≤256 KB，可接受）。

## A4. 验收标准

| # | 验收项 | 方法 |
|---|---|---|
| 1 | 过滤条件正确 | 单测：`api.github.com/...` → 空；`github.com/x/y/releases/download/v1/a.apk` → 34 个 |
| 2 | URL 拼接正确 | 单测：`prefix + originalUrl`（注意 mirror 尾斜杠，不能双斜杠） |
| 3 | 全部镜像死 → 退回直连 | 真机拔网/断代理后跑一次检查更新，必须不报错、走直连 |
| 4 | 探测流量 ≤ 256 KB | 日志里打印 `probe bytes=`，累计求和 |
| 5 | 选出的线路确实更快 | 日志打印 3 个候选的 `bytesPerSec`，primary 必须是最高 |
| 6 | 增量仍然只下变化块 | 复用 `docs/agents/runtime-delta.md` 的演练：篡改 part2，看日志仍是「用增量分片」 |

## A5. 风险与对策（见 §C 查漏补缺）

---

# B. 启动计时

## B1. 目标与非目标

**目标**：把 `t+3.57s → t+51.40s` 这 47.8 秒拆成**可读的分段**，落进 `EventLog` 与 `app.log`，
让下一次优化有数据。

**非目标**

- 不改启动顺序、不删任何步骤、不改超时值 —— **纯观测**。
- 不做"预加载/预热"（那是 A/B 之后的事，先测量再决定）。

## B2. Operit 的做法

`OperitApplication.kt` 每段一行：

```kotlin
AppLogger.d(TAG, "【启动计时】实例初始化完成 - ${System.currentTimeMillis() - startTime}ms")
AppLogger.d(TAG, "【启动计时】TextSegmenter预热完成（异步） - ...ms")
```

有效点在于：**同一基准时间 + 每段都打**，看日志就能排出瀑布图。

## B3. 要打的点（8 个）

| # | 打点名 | 位置 | 记录内容 |
|---|---|---|---|
| 1 | `boot.phase.app` | `MainActivity` 首次 `onCreate` 末 | 到此处累计 ms |
| 2 | `boot.phase.runtime` | `RootfsInstaller.ensure` 返回（命中 stamp 或解包完） | 累计 ms + `unpacked=true/false` |
| 3 | `boot.phase.preflight` | `preflight()` 返回 | 累计 ms + 结论 |
| 4 | `boot.phase.prootSpawn` | `ProotHost` 把 proot 进程拉起来（`ProcessBuilder.start()` 返回） | 累计 ms + pid |
| 5 | `boot.phase.prootMounted` | 首次能在 stdout 里看到 guest 输出 / 或 `proot` 首行 banner | 累计 ms |
| 6 | `boot.phase.nodeExec` | guest 内 `node` 开始执行（见 B4 的跨边界手法） | 累计 ms |
| 7 | `boot.phase.health` | `health` 探测拿到首次响应（200 或 401） | 累计 ms + 状态码 |
| 8 | `boot.phase.gui` | `Web 界面加载完成`（已有这一行，补上累计 ms） | 累计 ms |

打点统一走一个 helper，避免每处手写：

```kotlin
// BootTimeline.kt（新）
object BootTimeline {
    fun mark(name: String, extra: Map<String, String> = emptyMap())
    fun reset()                 // 每次 startEngine 前重置基准
    fun dump(): String          // 一次性输出瀑布图（给日志/复制）
}
```

## B4. 跨边界：guest 内部的耗时怎么拿

`node` 是在 PRoot 的 rootfs 里跑的，宿主侧只有 stdout。

**手法**：`ProotLaunch` 生成的启动命令行里，在 `exec node ...` 前面插一条**只打时间戳**的语句：

```sh
echo "DSH_BOOT_NODE_EXEC $(date +%s%3N)" >&2 ; exec /usr/bin/node ...
```

宿主侧读 stdout/stderr 时匹配 `DSH_BOOT_NODE_EXEC` 前缀 → 得到 guest 侧 wall clock（毫秒）。
⚠️ 前提是 guest 的 `date` 支持 `%3N`（busybox `date` 支持；GNU coreutils 支持）。启动前先验一次。

**这是唯一需要动到启动命令行的改动**，且只在前面加 `echo`，不影响 `exec` 语义。

## B5. 输出形态

`dump()` 输出（示例）：

```text
=== DSH 启动时间线（cold, unpacked=false, 本次 total=54830ms）===
  app            1ms   |█
  runtime      966ms   |████
  preflight   3426ms   |█████████████
  prootSpawn  3600ms   |██████████████
  prootMounted 3700ms  |██████████████
  nodeExec    9000ms   |██████████████████████████████████
  health     51400ms   |████████████████████████████████████████████████████████
  gui        54830ms   |██████████████████████████████████████████████████████████████
```

同时在 `EventLog` 记 `boot.timeline`（一条，fields 里放各段 ms），便于以后统计。

## B6. 验收标准

| # | 验收项 | 方法 |
|---|---|---|
| 1 | 8 个点全部出现，且单调递增 | 冷启动后 `grep boot.phase` |
| 2 | 各段之和 ≈ total | 误差 < 5% |
| 3 | `unpacked` 标记正确 | 首次装（解包）与第二次启动分别验证 |
| 4 | 不影响启动耗时 | 对比加打点前后 `engine.ready ms`，差 < 1s |
| 5 | guest 时间戳可用 | 日志里 `nodeExec` 段的宿主↔guest 时钟差 < 2s |

---

# C. 查漏补缺（计划自查）

写这份计划时，我逐条推演了一遍，发现 **11 个原方案没覆盖的问题**，逐条给对策：

| # | 盲点 | 影响 | 对策 |
|---|---|---|---|
| **1** | Operit 的 `34 × 256KB = 8.5MB` 探测流量 | 移动网络下负优化，用户会看到检查更新烧流量 | **三段式**：HEAD(0B) 筛 → 只对前 3 做 64KB 采样。上限 256 KB |
| **2** | 镜像返回 **HTML 错误页**（200 但不是文件） | 按"成功"算 → 下载到假数据 → sha256 失败 | HEAD 阶段就比对 `Content-Length == 清单 bytes`，不等就不算存活 |
| **3** | 部分镜像**不支持 Range** | 增量退化成全量；或 `206` 变 `200` 导致 tile 拼接错乱 | HEAD 必须看到 `Accept-Ranges: bytes`，否则剔除 |
| **4** | 镜像 URL 尾斜杠**双斜杠** | `https://ghproxy.com//https://github.com/…` 部分代理会 400 | `mirrored()` 里统一 `prefix.trimEnd('/') + "/" + url`，单测覆盖 |
| **5** | 每个块都选路 → **34×N 次探测** | 灾难 | **选路只做一次**，在 `runApply` 开头算 `primaryBase`，全程复用；TTL 30 分钟 |
| **6** | `RuntimeDelta` 里 **Atom 与 download 两条路** | 改错地方会把 Atom 也塞给镜像（镜像不转 API） | 明确：`releases.atom` / `api.github.com` **不走镜像**；只改 `releases/download/*` |
| **7** | 镜像挂掉时的**重试语义** | v1 若每个块失败都换线路，日志会爆炸且难复现 | v1 只在「**整个下载阶段**被主线路判失败一次」时降级到 fallback，不做逐块切换 |
| **8** | `BootTimeline.dump()` 在**子线程**写日志 | `DshLog` 在子线程不落盘（已知坑） | 统一 `runOnUiThread`，或直接用 `EventLog`（它自己处理落盘） |
| **9** | guest `date +%3N` 可能不支持 | `nodeExec` 点拿不到 | 启动前在 `ensureDevEnvScripts` 里跑一次 `date +%s%3N` 探针，失败则降级为「不打这个点」并在日志注明 |
| **10** | 热启动（引擎已在跑）打点 | 会出现"8 个点缺失"的假告警 | `BootTimeline.reset()` 只在真正 `startEngine` 时调；`dump()` 里标 `cold`/`warm` |
| **11** | 打点本身的开销 | 若每点都 flush，可能反而变慢 | 只写 `EventLog`（内存 + 异步落盘），不 `fsync`；验收要求 < 1s 影响 |

## C4. 第二轮查漏补缺（落盘后的再次推演，5 条更致命）

第一轮 11 条是设计层面的，这一轮是**实现时会直接卡住**的：

| # | 盲点 | 为什么会卡住 | 对策 |
|---|---|---|---|
| **12** | **探测清单时不知道 `expectBytes`**（鸡生蛋） | `pick(url, expectBytes)` 需要预期大小来筛"返回 HTML 错误页"的镜像；但**第一次就是去下 `runtime-chunks.json`**，此时还没读过它，不知道多大 | `pick()` 支持 `expectBytes = -1`：不校验大小，改用「HTTP 200 + 响应首字节是 `{` + 能 JSON 解析」三连判据；拿到清单后，**分片下载时再用严格大小校验** |
| **13** | 有些镜像**不支持 HEAD**（回 405/501） | 直接把可用线路误杀 | 探测顺序：先 `HEAD`；405/501 时降级为 `GET` + `Range: bytes=0-0`（只拿 1 字节），据此读 `Content-Range: bytes 0-0/TOTAL` 得到真实大小 |
| **14** | 34 个镜像**全部并发**发请求 | 移动网络下并发连接数被限、也可能被代理方按"滥用"限速，反而更慢 | 并发上限 **8**（信号量/`Semaphore`），分批跑：先跑前 12 个，存活不足 2 个再跑剩下的 |
| **15** | **宿主与 guest 的时钟不能相减** | `nodeExec` 打的是 guest 的 `date`，宿主是本地时区；两者时区/时钟都可能不同 → 直接相减会得出负值或荒谬数字 | **只做相对量**：guest 侧打**两个**点（`nodeExec` 与 `nodeReady`，都在 guest 内用同一时钟），宿主只用「收到这两行日志的宿主时刻」算**传输延迟**；跨边界不做绝对差 |
| **16** | `ProotLaunch` 里加 `echo` 会**污染 stdout** | 现有代码若按行解析 stdout（找 pid、找 banner），多一行可能被误认作有效输出 | 前缀用不可能冲突的 `DSH_BOOT_`；产出前先 `grep` 一遍现有解析逻辑（`ProotHost` 里对 stdout 的处理），确认前缀不参与任何判断 |

### C4.1 顺带确认的三件事（不是盲点，但要写死）

| 项 | 结论 |
|---|---|
| 镜像表要不要照抄 34 个 | **不要**。实现时先本地 `curl` 实测一轮，只保留**当前可用**的；表里保留 12–16 个足够，多了只是增加探测负担 |
| A 的日志要能一眼看出走了哪条 | `EventLog` 统一记 `runtime.download.via`，fields = `{via: "mirror:<name>"|"direct", rtt, bps, bytes}` |
| B 的 `dump()` 什么时候调 | `engine.ready` 之后立刻调一次（此时 8 个点齐了），**并且**在 `Web 界面加载完成` 后再补一次（补 `gui` 点） |

### C4.2 修正后的工作量排序（按"能不能独立验证"排）

```text
① GithubMirrors 的纯函数（mirrored / 拼接 / 判据）  ← 单测可验，不碰网络
② GithubMirrors 的探测（HEAD→Range 降级、并发上限 8） ← 本地 curl 可控验证
③ pick() 的缓存与 fallback                          ← 单测可验
④ 接 RuntimeDelta（清单 → 分片 → Range 重试）        ← 真机验
⑤ BootTimeline + 8 打点                             ← 单测 + 真机日志验
⑥ guest 两个相对点                                  ← 真机验
```

**①③⑤ 可以纯本地验证**（不需要设备），这正是把它们排在前面原因。

---



| 项 | 说明 |
|---|---|
| **镜像可信度** | 镜像能看到你的下载内容。内容正确性靠 `sha256`（清单里的 `sha256` 与 `files[].sha256`）兜底，**被篡改会被校验拦住**；但泄露"你在下哪个文件"这件事无法避免。计划里只选用 HTTPS 的镜像，且只用于 `releases/download/*`（公开资产） |
| **镜像存活率会漂移** | 34 个里长期可用的可能只有 10 个左右。v1 不做"自动淘汰"，只做"这次选不到就用直连"；未来可从 `EventLog` 统计成功率再删表 |
| **B 只能测到宿主侧** | guest 内部（node 加载 338 个包）的细分耗时拿不到，除非在 rootfs 里注入计时脚本。v1 只打一个 `nodeExec` 边界点 |
| **两件事都要发版才生效** | A 改下载路径、B 加打点，都要 `debug.38` 才能真机验；计划里把发版步骤列成 A6/B7 |

## C3. 实施顺序（为什么 A 先）

```text
A1  GithubMirrors.kt（新，纯逻辑） + 单测
A2  接 RuntimeDelta 的 3 个下载点
A3  本地跑：直连/镜像/全挂 三种路径
A4  发 debug.38 → 真机验（这是 B 的载体）
B1  BootTimeline.kt（新）
B2  8 个打点接进启动链
B3  guest 时间戳探针
B4  冷启动两次（一次解包、一次不解包）看瀑布图
```

**A 先行的原因**：B 要真机多次冷启动才能取到有效样本，而每次冷启动都要下载/校验；
A 先落地能让后续每次验机的下载更快更稳，也顺带在真实网络下验证了 A。

---

## D. 每步的"完成"定义

| 步骤 | 完成定义 |
|---|---|
| A1 | `GithubMirrors` 单测：过滤/拼接/HEAD 筛选/选优排序 全绿 |
| A2 | `RuntimeDelta` 下载入口改完，`apk.yml` 的 `单元测试门禁` 绿 |
| A3 | 三种路径各跑一次，日志能看出走了哪条（`mirror=<name>` / `direct`） |
| A4 | `debug.38` 发布 + 装机 + 真机日志出现 `mirror=` 字段 |
| B1 | `BootTimeline` + `dump()` 单测（纯格式化逻辑） |
| B2 | 8 点全出、单调、误差 <5% |
| B3 | `nodeExec` 点有值（或明确标注不支持） |
| B4 | 两次冷启动的瀑布图贴进 `docs/agents/` |