# A + B 详细计划：多线路下载（A）/ 启动计时（B）

> 本文是**唯一权威计划**。曾另有一份平行草稿（`multiline-and-startup.md`），
> 经逐条交叉比对后**已合并进本文并删除** —— 它独有的内容只有两项：
> **A3.1 并行块下载** 与 **C4-#17**（其余部分本文更完备）。
> 合并判据见 §C4-#17 与 A3.1 的注释。

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

### A0. 基线（2026-11-24 真机实测，**改动前**）

在设备 `0.2.2-rc.5-debug.37`（不含多线路/并行）上，用 `auto-dryrun` 钩子制造一次**全量**运行时下载：

```text
准备：manifest.json 的 runtimeVersion 改成 r1-A0-OLD-BASELINE
      runtime/parts → parts.a0bak（没有本地基线 ⇒ 必然全量）
      touch runtime/auto-dryrun
结果：
  23:26:48.544  auto-dryrun: check 开始
  23:26:52.517  check 发现运行时：全量 143.5 MB（needBytes=150,497,904）
  23:27:28.548  apply = "正在下载运行时… 2.6 MB / 143.5 MB"   ← 30 秒只下了 2.6 MB
```

| 指标 | 实测值 |
|---|---|
| 吞吐 | **≈ 87 KB/s**（2.6 MB / 30 s） |
| 全量 143.5 MB 预计耗时 | **≈ 27 分钟** |
| 下载方式 | 串行 · 单线路（`github.com` 直连） |
| 请求数 | `150497904 / 65536 ≈ 2296` 次（全量时 `fetch` 是全部块） |

⇒ **这就是 A 要改善的基线**。这也解释了为什么"只加多线路不加并发"没用：
2296 次串行请求，每次哪怕只花 100 ms 握手，光握手就要 3.8 分钟，而实测 87 KB/s
说明**绝大多数时间耗在等请求上**，不是带宽。

**同时留下的验证样本**：中途 `force-stop` 让 apply 被杀，产生
`runtime/parts/.staging-r1-arm64-v8a-…-19783`（18 MB）。它会在装上含 V2 修复的版本后
被 `sweepStale` 自动清掉 —— 这是 V2 的**真机验收**手段（单测之外的实物证据）。

⚠️ 注意：复现基线时要小心 `parts/` 的恢复 —— 演练脚本会把它改名成 `parts.a0bak`，
测完必须 `mv` 回 `parts`，否则 App 会以为没有基线（虽然能用，但下次更新会走全量）。

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

### A3.1 并行块下载（**A 的必做项，不是可选优化**）

多线路只解决"下得动"，不解决"下得快"。现状是**串行**：

```kotlin
// RuntimeDelta.kt:213
for (c in fp.fetch) {                 // 79 MB 全量 = 79448384 / 65536 ≈ 1212 个块
    val buf = downloadRange(fp.url, off, len)   // 每块一次 HTTP：建连 + TLS + 302
}
```

每次建连 100~300 ms ⇒ **光握手就是 3 分钟**，线路再快也白搭。Operit 的
`FullUpdateInstaller` / `PatchUpdateInstaller` 都是 `DOWNLOAD_THREAD_COUNT = 6`。

**做法**：

| 项 | 取值 | 理由 |
|---|---|---|
| 并发度 | **6**（硬上限） | 与 Operit 一致；移动网络下再高会被限速 |
| 启用条件 | **仅当 `fp.fetch.size >= 32`** | 增量常态只下几块，开 6 线程纯属浪费（见 A-R8） |
| 写入方式 | **`FileChannel.write(ByteBuffer, position)`** | ⚠️ **`RandomAccessFile.seek()+write()` 是两步，非原子** —— 6 个线程交错会把块写到错误偏移，且是**静默损坏**（块 sha256 在写之前校验，写完不再验） |
| 进度 | `var done` → **`AtomicLong`** | 否则丢更新、百分比倒退（`RootfsInstaller` 已经踩过一次，用 `AtomicLong` 解决的） |
| 失败 | 计入 `errors` 后**统一抛** | 不做逐块重试（与 C-#7 的重试语义一致：只在"整个下载阶段"降级一次） |

```kotlin
// 关键三行
val ch = FileChannel.open(dst.toPath(), StandardOpenOption.WRITE, StandardOpenOption.CREATE)
ch.write(ByteBuffer.wrap(buf), off)   // positional write，内核层面原子
ch.close()
```

**整文件终校（`RuntimeDelta.kt:232`）在并行下更不可省** —— 它是最后一道防线，**保留不动**。

## A4. 验收标准

| # | 验收项 | 方法 |
|---|---|---|
| 1 | 过滤条件正确 | 单测：`api.github.com/...` → 空；`github.com/x/y/releases/download/v1/a.apk` → **`MIRRORS.size` 个**（原写"34 个"与 A5/C4.1「只保留 12–16 个」自相矛盾，见 V8） |
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
| **17** | **串行 1212 次请求才是真瓶颈**（本条来自平行计划的交叉校验） | 多线路做完，用户体感几乎不变；且**并行化若用 `RandomAccessFile.seek+write` 会静默写错块偏移** | 见新增 **A3.1**：并发 6、`FileChannel.write(buf, position)` 定位写、`done` 改 `AtomicLong`、仅 `fetch.size >= 32` 时启用 |

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

---

## V. 第三轮查漏补缺（数据生命周期与既有机制的冲突，11 条）

> 前两轮（C / C4）查的是**设计与实现**。这一轮换角度：**A/B 落地后会碰到哪些已经存在的东西**，
> 以及**前两轮里哪些假设其实是错的**。

### V1（严重，代码 bug）· `pruneParts` 会把 `.staging-*` 当成一个"版本"，可能删掉**正在用的基线**

`RuntimeFiles.pruneParts` 的过滤条件：

```kotlin
.filter { it.isDirectory && !Files.isSymbolicLink(it.toPath()) }   // ← 没有过滤 "." 开头
```

而同一文件的 `RuntimeDelta.localBase` 是**过滤了**的：

```kotlin
val dirs = parts.listFiles { f -> f.isDirectory && !f.name.startsWith(".") } ?: return null
```

**两个函数对同一目录的判据不一致**。后果：

1. `runApply` 的临时目录是 `runtime/parts/.staging-<ver>-<pid>`（`RuntimeDelta.kt:195`）；
2. 若 apply 被系统杀掉，`.staging-*` 残留（见 V2）；
3. 下次 `RootfsInstaller.pruneOldBaselines()` → `pruneParts(keep = 1)` **按 mtime 排序**时，
   残留的 `.staging-*`（半成品，mtime 可能比真基线新）会被当成"最新版本"**保留**，
   而**真正的当前基线 `parts/<ver>/` 被删除**；
4. ⇒ 下一次更新退化成**全量**，且磁盘上留下一个半成品目录。

**修法**（两行，本轮就做）：

```kotlin
.filter { it.isDirectory && !it.name.startsWith(".") && !Files.isSymbolicLink(it.toPath()) }
```

并在 `RuntimeS6Test` 加一条：`parts/` 下放 `.staging-x` 与 `v-old`、`v-new`，`pruneParts(keep=1)`
必须**只删 `v-old`**、`.staging-x` 原样保留（它是别人正在写的，不该由这里清理）。

### V2 · `sweepStale` 扫不到 `parts/.staging-*`

`sweepStale(runtimeDir)` 只认 `rootfs.staging-*` 与 `rootfs.old-*`（一级目录），
而 `RuntimeDelta` 的 staging 在 **`runtime/parts/`** 下面。⇒ 进程被杀后那份半成品
（最大 144 MB）**永久残留，没人清**。

**修法**：`sweepStale` 增加第二段——扫 `runtime/parts/.staging-*`（只删 `.` 开头且
`lastModified` 早于当前进程启动时刻的，避免删到**另一个**正在跑的 apply）。

### V3 · （**我推翻了自己的怀疑**）跨主机重定向**不会**丢 `Range`

第三轮我怀疑："镜像 302 到别的 host 时，`HttpURLConnection` 会丢自定义头"。
**实测推翻**：GitHub Release 下载本来就是
`github.com` **302 → `objects.githubusercontent.com`**（跨 host），而 `debug.33/34` 的
增量演练（篡改 part2 第 1000 字节、48 秒内恢复成清单值）正是走这条链路且 Range 正常。
⇒ **不是漏洞**。记在这里是为了以后别再怀疑一遍。

⚠️ 但**仍要**按 C4-#12/#13 处理"镜像明确不支持 Range"的情况 —— 那是另一回事。

### V4 · `EventLog.record` **不是"纯内存"**，C-#11 的前提不成立

C-#11 写"只写 `EventLog`（内存 + 异步落盘），不 fsync"。但 `EventLog.record` 实际是**双写**：

```kotlin
LogStore.app('I', "Event", "$name$detail (t+${elapsed}ms)")   // ← 也写 app.log
val w = writer ?: return                                       // 再写 events.jsonl
```

⇒ B-1 动手前必须先确认 `LogStore.app` 是缓冲写还是每次 flush。

**✅ 已确认（2026-11-24，Phase 0 执行时读码）**：`LogStore.writeApp` 是**每行 `flush()`**，
`LogStore.kt:479` 的注释写得很清楚：

```text
⚠️ `flush()` **每行都调**：这就是「崩溃时日志完整」的代价与保障。
不 flush 的话最后几行留在用户态缓冲里，进程一死就没了 —— 而那几行通常正是最关键的。
```

⇒ **`EventLog.record` 是同步落盘**（`LogStore.app` + `events.jsonl` 缓冲两段）。

**结论：B-1 不需要新增"轻量入口"**。估算 8 个点 × 1~5 ms ≈ **8~40 ms**，
远低于 B6-#4 的"< 1 s 影响"验收线；`boot.phase.gui` 在 WebView 回调（主线程）只有 1 次
flush，不构成 ANR 风险。**照原计划打 8 个点即可**。

**处置**：B-1 的第一步不是写打点，而是**读 `LogStore.app` 的实现**并在文档记下结论；
若确认是同步，则打点改走"只写 `events.jsonl`"的轻量入口（新增 `EventLog.mark()`），不双写。

### V5 · 计划只写"新增文档"，漏了"**要更新的既有文档**"

| 文件 | 要改什么 |
|---|---|
| `docs/agents/runtime-delta.md` | P2 章节补「多线路选路 + 并行块下载」，并记 V1/V2 的修复 |
| `docs/plan/progress.md` | P2 表加 A/B 两行；D8 已引用本文 |
| `AGENTS.md` | 若新增 `GithubMirrors.kt` / `BootTimeline.kt`，需在文件清单里登记（该文件是接手入口） |

### V6 · **没有基线对比**，无法证明"更快"

A4 验收 #5 只要求"选出的线路是候选里最快的"，没有"**改动前后**全量下载耗时对比"。
⇒ 加 **A-0 步骤**：动手前先跑一次全量下载（`rm -rf parts` + `auto-dryrun`），
把耗时写进本文，作为对照基线。

### V7 · 全线路失败时，用户仍会看到**debug.34 修过的那类误报**

`latestRuntimeRelease()` 失败时，`lastReleaseError` 之外的兜底文案是
"没找到带 runtime-chunks.json 的 Release"。D2 修的是"限流 403 被误报成没找到"，
但**网络整体不通**仍会落进同一句话 ⇒ 用户方向完全错（以为是发布缺资产）。

**修法**：`lastReleaseError` 必须区分三类并带进 `message`：
`网络层失败（超时/连接拒绝，试了 N 条线路）` / `拿到 atom 但 5 个 tag 都没有清单` / `清单解析失败`。

### V8 · A4-#1 的"34 个"与 A5「只保留 12–16」矛盾

已在上方 A4 表格改正为 `MIRRORS.size`。（这条是自查出来的文档内部矛盾。）

### V9 · 探测函数**不可注入**，单测躲不开真网络

A3 的签名是 `suspend fun probeHeads(urls, expectBytes, timeoutMs)` —— 全是网络调用。
单测跑 CI 时没有稳定外网 ⇒ 必须可注入：

```kotlin
fun probeHeads(urls: Map<String, String>, expectBytes: Long, timeoutMs: Int,
               probe: (String, Int) -> Probe = ::defaultProbe): List<Probe>
```

否则 A4 验收 #1~#3 只能"真机手工验"，进不了 `apk.yml` 的单测门禁。

### V10 · A 的验收 #6 依赖 `parts/` 基线，而 V1 可能已经把它删了

A4-#6 要验"增量仍然只下变化块"，前提是 `parts/<ver>/` 基线**存在且完整**。
但 V1 的 bug 会让基线被误删 ⇒ **A 验收前必须先修 V1**，否则会误判成"A 把增量搞坏了"。

### V11 · 并行下载会让 `message` 刷屏（1212 次更新）

`RuntimeDelta.message` 是 `@Volatile`，被 JS 桥每 500 ms 轮询。串行时最多 1212 次写/分钟；
并行后 6 线程同时写，日志里 `engine`/`app.log` 可能被进度行淹没，且**看不到真正的错误**。

**修法**：`message` 写入加节流 —— 仅当「距上次更新 ≥ 200 ms」**或**「进度百分比变化 ≥ 1%」才写。

### V 汇总：本轮（A/B 之前）就该做的 4 件小事

| 项 | 改动量 | 为什么必须先做 |
|---|---|---|
| V1 `pruneParts` 过滤 `.` 开头 | 1 行 + 1 条单测 | 否则 A 的增量验收会被误判 |
| V2 `sweepStale` 扫 `parts/.staging-*` | ~10 行 | 否则残留 144 MB 永远清不掉 |
| V4 确认 `LogStore.app` 是否缓冲 | 只读代码 + 记文档 | 否则 B 的"< 1s 开销"验收前提不成立 |
| V7 报错区分三类失败 | ~15 行 | 否则用户又被误导一次 |

---

---

## Phase 0（A/B 之前，第三轮审查产物）

这四件事**不属于 A/B 的功能范围**，但会直接影响 A/B 的验收能不能做成：

**✅ 四项均已完成（2026-11-24，commit `d00fb0c1c3`，CI run `45414435263` 全绿）。**

| 步 | 内容 | 实际改动 | 验证结果 |
|---|---|---|---|
| **V1** | `pruneParts` 过滤 `.` 开头 | `RuntimeFiles.kt` 1 行 + 注释 | 单测 `prunePartsIgnoresDotStagingDirs` 通过（`.staging-*` 既不参与排序也不被删） |
| **V2** | `sweepStale` 扫 `parts/.staging-*` | `RuntimeFiles.kt` ~25 行；3 个调用点传 `currentPid` | 单测 2 条通过（别人的 staging 被删 / 本进程与未超龄的保留 / 真基线不动） |
| **V4** | 确认 `LogStore.app` 是否缓冲 | 只读 + 本文档 | **每行 flush**（见上方 V4 段结论），B-1 照原计划打点 |
| **V7** | 检查更新失败分三类 | `RuntimeDelta.kt` ~35 行（`ReleaseFailKind` + `failRelease` + 2 个 accessor） | 编译通过；真机断网验证留到 A/B 联调时做 |

**单测：27 → 30 条。**

**为什么排在最前**：V1 的 bug 会让 A4-#6（"增量仍只下变化块"）**必然误判**；
V4 的结论决定 B-1 用什么入口打点；V7 是 debug.34（D2）那类"误导用户"的残留形态。

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