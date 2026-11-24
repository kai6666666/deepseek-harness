# A + B 实施计划：多线路下载 & 启动耗时测量

> 状态：**计划待审**（2026-11-24）　决策依据：`docs/plan/progress.md` D7 / D8
> 参照实现：`Operit-main`（`util/GithubReleaseUtil.kt` / `data/updates/*` / `core/application/OperitApplication.kt`）

---

## 0. 核准过的现状（不是估算）

### 0.1 DSH 侧

| 事实 | 数据 | 出处 |
|---|---|---|
| 增量粒度 | `chunkSize = 65536`（64 KiB），逐块 `sha256` 比对 | `RuntimeDelta.kt:20` |
| 网络点 | 4 处：`releases.atom`、`<TAG>/runtime-chunks.json`、`<TAG>/manifest.json`、**逐块 `downloadRange`** | `RuntimeDelta.kt:188/237/217` |
| 下载是否并行 | **串行**。79 MB 全量 = `79448384 / 65536 ≈ 1212` 次 HTTP 请求 | `RuntimeDelta.kt:213` 的 `for (c in fp.fetch)` |
| 线路 | 单线路直连 `https://github.com/...` | `RuntimeDelta.kt:415/430` 的 `URL(url)` |
| 冷启动 | `engine.ready ms=50459`；`Web 界面加载完成 t+54.83s` | 设备 `app.log`（debug.37，20:29） |
| 其中"黑盒" | `ProotHost` 起（t+3.57s）→ `runtime.purge`（t+51.40s）= **47.8 秒无任何 app.log** | 同上 |
| 引擎侧耗时 | `pet 桥(#67)` → `dsh web: http://…token` = **13~19 秒**（三次采样：16.5s / 19.1s / 13.3s） | 设备 `engine.log` |

### 0.2 Operit 侧（参照）

| 能力 | 实现 | 关键参数 |
|---|---|---|
| 多线路 | `GithubReleaseUtil.GITHUB_MIRRORS` | **34 个镜像**，`linkedMap` 保序；只对含 `github.com` + `/releases/download/` 的 URL 生效 |
| 选线方式 | `probeMirrorUrls` → `async` + `awaitAll` | **并发**；`timeoutMs=2500`；`Range: bytes=0-262143`（**256 KB 采样**）；记录 `latencyMs` / `bytesPerSec` |
| 全量下载 | `FullUpdateInstaller` | `DOWNLOAD_THREAD_COUNT = 6`，`RandomAccessFile` 定位写 |
| 增量下载 | `PatchUpdateInstaller` | `PATCH_DOWNLOAD_THREAD_COUNT = 6`；`MAX_CHAIN_STEPS = 64`（补丁链） |
| 启动计时 | `OperitApplication` | 每个阶段一行 `【启动计时】xx完成 - Nms`；非必需工作丢 `CoroutineScope(SupervisorJob() + Dispatchers.IO)`；`initialize(preloadNow = false)` + 异步 `preloadFromDisk()` |

---

## A. 多线路下载

### A1 目标

让 `RuntimeDelta` 的运行时下载**不再依赖单一 `github.com`**：自动从镜像表里挑最快的线路，失败自动回退直连，**正确性由既有 sha256 链路保证、不靠线路可信**。

### A2 新增文件：`app/src/main/java/com/dsh/android/runtime/MirrorSelector.kt`

纯 Kotlin、无 Android 依赖（可在 `RuntimeS6Test` 里跑），四件事：

| 成员 | 签名 | 职责 |
|---|---|---|
| `MIRRORS` | `LinkedHashMap<String, String>` | 镜像表。**只收 2026 年仍可能活的**，初始 12~16 个（见 A5） |
| `rewrite` | `fun rewrite(base: String, url: String): String?` | 仅当 `url` 含 `github.com` 且含 `/releases/download/` 时返回 `base + url`，否则 `null`（**原子 feed 不镜像**） |
| `supportsRange` | `fun probe(url, timeoutMs): Info` | `Info(ok, latencyMs, bytesPerSec, rangeOk, error)`。用 `Range: bytes=0-262143` 拉 256 KB，**同时校验响应码必须 206** |
| `select` | `fun select(url, cacheFile: File?, budgetMs = 2500): Choice` | **同步阻塞**（见下方"为什么不能是 suspend"）。先测直连；直连探测成功且 `bytesPerSec ≥ 512 KiB/s` → **直接返回直连，不碰镜像**；否则并发测全部镜像，取 `rangeOk && ok` 里最快的一个；全失败 → 直连（带记录） |

**为什么 `select` 不能是 `suspend`**：唯一调用方 `RuntimeDelta.runApply` 是 `private fun`（同步），整条 apply 链跑在调用方给的普通线程上，那里没有 `CoroutineScope`。硬加 `runBlocking` 会把协程调度器塞进一个已经被阻塞的线程，得不偿失。

⇒ 实现用**纯 Java 并发**，与 `HttpMultiPartDownloader` 同风格：

```kotlin
// 并发探测：固定 8 线程 + CountDownLatch，每个探测自带 connectTimeout/readTimeout
val pool = Executors.newFixedThreadPool(8)
val latch = CountDownLatch(candidates.size)
val results = Collections.synchronizedList(ArrayList<Info>())
// ... pool.execute { ... }; latch.await(budgetMs + 500, MILLISECONDS)
```

**缓存**：`Choice(base, name, bytesPerSec, savedAtMs)` 写 `cacheFile`（传 `null` 则不缓存，便于单测）；TTL 10 分钟。命中则**只探 1 个**确认可用，不再全表测。`File` 是纯 Java 类型，不影响可测性。

### A3 接入 `RuntimeDelta`

| 位置 | 改法 |
|---|---|
| `runApply` 开头 | 选一次线路：`val choice = MirrorSelector.select(plan 里第一个 /releases/download/ URL)`，结果传给后续所有下载 |
| `downloadRange(url, off, len)` | 新增 `base: String?` 参数；`base != null` 时用 `MirrorSelector.rewrite(base, url) ?: url` |
| `httpGet(url)` | 清单 `chunksUrl` / `manifestUrl` **也走镜像**（它们在 `/releases/download/` 下，直连不通时这是唯一的活路）；`releases.atom` **不镜像**，但失败后**追加一次镜像尝试**（前缀式代理对普通 URL 通常也生效，失败无害） |
| 报错文案 | `lastReleaseError` 里带上是哪条线路失败、试过几条 |

### A4 边界与风险（**这是 A 的核心，必须逐条落到代码**）

| # | 风险 | 处理 | 为什么不能省 |
|---|---|---|---|
| **A-R1** | **镜像不支持 Range → O(n²) 流量**。`downloadRange` 现在 `code==200` 时"自己跳过前缀"（`RuntimeDelta.kt:444`），`off` 可达几十 MB；1212 块 × 每块重下前缀 = 灾难 | **探测阶段就校验 206**；`rangeOk=false` 的镜像**一律不入选**；运行时若某块返回 200 直接 `throw`（换线路重试）而不是默默跳过 | 直连 GitHub 支持 Range，所以这个地雷现在没暴露；**接镜像后必然踩** |
| **A-R2** | 单做多线路收益有限：1212 次串行请求，每次建连+TLS+302 就是 100~300 ms ⇒ **光握手就 3 分钟** | **A 必含并行块下载**（见 A6-A2）。否则线路再快也白搭 | 实测 79 MB 全量在设备上要几分钟，瓶颈在请求数不在带宽 |
| **A-R3** | 镜像篡改内容 | **不需要额外信任机制**：每块 `sha256`（`RuntimeDelta.kt:220`）+ 整文件终校（`:232`）+ 分片清单 `sha256`（`RootfsInstaller:186`）三层已足够 | 这也是为什么敢用第三方代理 |
| **A-R4** | 镜像表腐烂（Operit 那 34 个里死掉不少） | 探测天然过滤（失败即淘汰）+ 本地缓存"上次最快"+ 全灭回退直连 | 硬编码列表必然过期 |
| **A-R5** | 测速拖慢正常用户 | **直连优先**：直连达标直接跳过镜像全测（A2 的 `select` 逻辑） | 海外/科学上网用户不该为这个功能付 2.5 秒 |
| **A-R6** | 隐私 | 代理能看到请求 URL（含 repo 名与文件名），**不含任何 token**（分片下载不带鉴权头，`RuntimeDelta.kt:429` 注释已说明） | 可在文档里明说，不隐瞒 |
| **A-R7** | 镜像对 `releases.atom` 的兼容性未知 | 不纳入常规路径，只作为 atom 失败后的**最后尝试**；失败不计入致命 | 前缀代理通常能转，但不能假设 |
| **A-R8** | 并行化可能压垮低端设备（6 线程 × `RandomAccessFile` 句柄，与 PRoot 的 986 MB 磁盘 IO 抢带宽） | 并行度**硬上限 6**，且**只对「全量路径」启用**；增量路径（`fetch` 块数 < 32）保持串行 —— 小改动开 6 线程纯属浪费 | 增量是常态路径，全量只在首装/换基线时发生 |
| **A-R9** | 「直连达标就跳过镜像」的阈值是拍的，定高了会让慢速可用直连被误判 | 阈值 `512 KiB/s`（不是 1 MiB/s）；且**仅当直连探测本身成功**（拿到 200/206）才适用 —— 探测失败直接进镜像流程，不做速度判断 | 目的是"别让正常用户变慢"，不是"一定要用镜像" |

### A5 初始镜像表（**待实测筛选，不照抄 Operit 的 34 个**）

先放 16 个候选，用 `probe` 在真机上跑一轮，**只保留 `rangeOk=true` 且能真的拉到 206 的**，其余删掉并在文档记录淘汰原因。

```text
ghfast.top  ghproxy.net  gh-proxy.com  hub.gitmirror.com
github.moeyy.xyz  gh.h233.eu.org  ghproxy.cfd  gh-proxy.net
gh.jasonzeng.dev  gh.monlor.com  fastgit.cc  github.tbedu.top
ghfile.geekertao.top  gh.chjina.com  gh.llkk.cc  ghproxy.monkeyray.net
```

### A6 实施步骤（A-1 → A-3，顺序不可换）

| 步骤 | 内容 | 验收 |
|---|---|---|
| **A-1** | 写 `MirrorSelector.kt` + 单测（`rewrite` 过滤规则、`select` 直连优先、`rangeOk=false` 被排除、缓存命中） | `RuntimeS6Test` 全绿（新增 4~5 条） |
| **A-2** | `runApply` 的 `for (c in fp.fetch)` 改**并行**：固定 6 线程（与 Operit 同参数），用 `RandomAccessFile` 各自 `seek+write`（**不同块区间写入不冲突**），失败计入 `errors` 后统一抛 | 79 MB 全量下载耗时从分钟级降到 <60 s（真机） |
| **A-3** | 接入线路选择 + 缓存 + 回退；`httpGet` 的清单/manifest 走镜像 | 关掉 IPv6/挂代理模拟"直连不通"，仍能完成 apply |

### A7 验证方法（真机，可复现）

```bash
# 1) 单元层
./gradlew :app:testSystemDebugUnitTest

# 2) 线路探测（真机，直接跑 app 内探针或看日志）
#    期望日志：mirror.select chosen=<name> speed=<x>KB/s rangeOk=true ms=<n>

# 3) 端到端：制造一次全量下载
#    ⚠️ 只删 manifest.json 不够 —— apply 是「用户点检查更新」才触发，不是开机触发。
#    用演练钩子（files/runtime/auto-dryrun）可靠，历史演练已验证过这个入口：
run-as com.dsh.android sh -c 'rm -rf files/runtime/parts; touch files/runtime/auto-dryrun'
am force-stop com.dsh.android; am start -n com.dsh.android/.MainActivity
#   期望：日志出现 mirror.select；钩子自删（ls 显示不存在）；
#        files/runtime/parts/<ver>/ 下每个分片 sha256 == Release 资产的 digest

# 4) 回退路径
#    把 .mirror-cache 里的 base 改成一个不可用域名 → 仍应成功（回退直连）
```

---

## B. 启动耗时测量（**只测量，不改行为**）

### B1 已有数据与缺口

**已有**（不用改一行代码就能拿）：

```text
app.log   t+0.08s app.onCreate → t+0.97s runtime ready → t+3.57s ProotHost → t+51.40s engine.ready
engine.log  pet 桥(#67) → dsh web token(#73) = 13.3~19.1 秒（三次采样）
```

**缺口**：

1. `ProotHost` 起 → 引擎第一行输出之间，**App 侧无打点**（那 30 秒是黑盒）。
2. `engine.log` 的时间戳是 **App 收到行时**写的；node 的 stdout 是 **pipe**（`ProcessBuilder` + pump 线程），若中间层有块缓冲，时间戳会失真，**低报或高报都可能**。
3. 不知道 47.8 秒里 `awaitToken` / `healthProbe` 各占多少。

### B2 打点设计（4 个 `EventLog`，全部在 `EngineManager.startProot`）

| 事件名 | 位置 | 字段 |
|---|---|---|
| `engine.spawn` | **锚点**：`host.start(prootEnv, overlays, targetProfile) { … }` 这一行**返回之后**（当前在 `6920` 附近，改动后以锚点为准） | `ms`（从 `startMs` 起）、`pid` |
| `engine.token` | **锚点**：`val token = host.awaitToken(READY_TIMEOUT_MS)` 之后 | `waitedMs`、`ok`（token 是否为 null） |
| `engine.health.first` | **锚点**：health 重试 `while` 循环内、`healthAttempts == 1` 的那次 `probe` 之后 | `ms`（单次探测耗时）、`http` |
| `engine.health.ok` | **锚点**：`health == manifest.unauthStatus` 跳出循环处 | `attempts`、`windowMs` |

> 用锚点不用行号：A 阶段会动 `RuntimeDelta`，虽然本轮不动 `EngineManager`，但行号迟早会漂。

**为什么不改行为**：这 4 处只调 `EventLog.record`（已有机制，写 `events.jsonl`），不 sleep、不改顺序、不新增线程。失败路径不受影响。

### B3 必须处理的两个测量陷阱

| # | 陷阱 | 处理 |
|---|---|---|
| **B-R1** | **stdout 缓冲让 `engine.log` 时间戳失真**。`/bin/sh -c "exec /usr/local/bin/dsh web"` 的输出进 pipe，node 对 pipe 的写入不保证逐行落地；`stdbuf` **在 rootfs 里存在**（`/usr/bin/stdbuf`，67 KB） | **第一步不改**：先在同一轮里对比 `engine.spawn`（App 记）与 `engine.log` 第一行（App 记），若两者差值 > 2 s 就说明**有缓冲**；确认后才加 `stdbuf -oL`（这一步会改启动命令，需单独确认） |
| **B-R2** | 偶发慢帧（首帧兜底 1.5 s）会污染样本 | **采 3 次冷启动**取中位数，每次前 `pm force-stop` + 清空 `app.log` 到独立文件，避免历史行干扰 |

### B4 实施步骤

| 步骤 | 内容 | 验收 |
|---|---|---|
| **B-1** | 加 4 个 `EventLog` 打点（纯新增） | `assembleSystemDebug` 绿；`events.jsonl` 出现 4 条新事件 |
| **B-2** | 写 `tools/startup-timeline.py`：读 `app.log` + `events.jsonl` + `engine.log`，按时间戳对齐出**一张阶段表**（含"未归因"的空档） | 对一次冷启动能输出 8~10 行表格，合计与 `engine.ready ms` 吻合（误差 < 1 s） |
| **B-3** | 3 次冷启动采样，产出结论：`awaitToken` vs `healthProbe` vs **引擎内部真实耗时**各占多少 | 明确写出"下一刀该切哪里"，**不在这轮改行为** |

### B5 验证方法

```bash
# 单次采样（每次之间 force-stop，避免复用热进程）
run-as com.dsh.android sh -c 'rm -f files/logs/app.log files/logs/events.jsonl'
am force-stop com.dsh.android; am start -n com.dsh.android/.MainActivity
sleep 70
run-as com.dsh.android sh -c 'cp files/logs/app.log files/logs/events.jsonl files/logs/engine.log /sdcard/startup-cap/'
python3 tools/startup-timeline.py /sdcard/startup-cap/
```

---

## C. 查漏补缺（我把计划自己审了一遍，共 9 条）

> 这里记的是"计划本身的问题"，不是待办。每条都附处理结论。

| # | 漏洞 | 结论 |
|---|---|---|
| **C1** | **A 只做多线路没用**：瓶颈是 1212 次串行请求（A-R2） | **已并入 A**：A-2 并行下载成为必做步骤，不再是"可选项" |
| **C2** | **Range 地雷**：接镜像后 `code==200` 的"跳过前缀"会炸流量（A-R1） | **已并入 A-R1**：探测校验 206，运行时遇 200 直接换线 |
| **C3** | **清单也可能拿不到**：`runtime-chunks.json` 和 `manifest.json` 同样在 `/releases/download/` 下，若只镜像分片，GitHub 直连不通时连"要下什么"都不知道 | **已并入 A3**：清单/manifest 一起走镜像 |
| **C4** | 测速 2.5 s 会让正常用户变慢 | **已并入 A-R5**：直连达标则跳过全表 |
| **C5** | 镜像表照抄 Operit 会带回一堆死线路 | **已并入 A5**：先 16 候选，真机实测后裁掉 |
| **C6** | **B 的 `engine.log` 时间戳可能失真**（pipe 缓冲） | **已并入 B-R1**：先用"spawn vs 第一行"的差值判断，确认后才动 `stdbuf` |
| **C7** | 单次样本会被慢帧污染 | **已并入 B-R2**：3 次取中位数 |
| **C8** | **A 会改变下载并发度 → 可能压垮小内存设备**（1212 块 × 6 线程，每块 64 KB，峰值内存可控，但 `RandomAccessFile` 6 个句柄 + PRoot 已占 986 MB 磁盘 IO） | **新增 A-R8**：并行度**上限 6**，且**仅全量路径启用**；增量路径（块少）保持串行，避免小改动也开 6 线程 |
| **C9** | 计划里 `MirrorSelector.select` 要"直连达标就跳过"，但**达标阈值 1 MiB/s 是拍的** | **新增 A-R9**：阈值改为 `≥ 512 KiB/s`（更宽松，避免误判慢速但可用的直连）；且**仅当直连探测本身成功**才适用（探测失败直接进镜像流程） |

### C10 另外三条"不在本轮范围但必须记下"的

| 项 | 为什么不在本轮 |
|---|---|
| **应用内自更新 APK**（Operit 的 `FullUpdateInstaller`） | 主人明确只做 A+B；且装错包风险最高 |
| **APK 差分包 `apkraw-1`** | 166 MB 里 150 MB 是 runtime，已有块级增量；APK diff 只能省 16 MB 的差量 |
| **`stdbuf -oL` 改启动命令** | 属"改行为"，B 只测量。等 B-3 有结论后单独确认 |

---

---

## D. 排期与交付物

| 阶段 | 交付 | 提交信息前缀 |
|---|---|---|
| A-1 | `MirrorSelector.kt` + 单测 | `feat(delta): 镜像选择器` |
| A-2 | 并行块下载 | `perf(delta): 块下载并行化（6 线程）` |
| A-3 | 接入 + 缓存 + 回退 | `feat(delta): 多线路接入与回退` |
| A-4 | 真机实测镜像表裁剪 + 文档 | `docs(runtime-delta): 镜像实测结论` |
| B-1 | 4 个打点 | `feat(engine): 启动分段计时` |
| B-2 | `tools/startup-timeline.py` | `feat(tools): 启动时间轴对齐` |
| B-3 | 3 次采样结论 + 文档 | `docs(plan): 启动瓶颈结论` |
| 收口 | `debug.38 / vc123` | `chore(release): ...` |

**每步都独立可回滚**：A-1/A-2 不动线路，A-3 才有行为变化，且失败自动回退直连。

---

## E. 第二遍复审：技术可行性（5 条，其中 2 条阻断级）

> C 章节是"计划内容"的漏洞；这里是"能不能照着写出来"的漏洞。**E1 与 E2 是阻断级** —— 不改设计的话，A 根本写不出来，或者写出来会静默损坏数据。

### E1（阻断级）· 清单本身拿不到时，"测速选最快"无从谈起

**矛盾**：A2 的 `select` 需要"一个 `/releases/download/` 的 URL"来测速，但**清单 `runtime-chunks.json` 本身也是 `/releases/download/` 下的文件**。如果直连 `github.com` 完全不通，`latestRuntimeRelease()` 连"有哪些文件、块哈希是什么"都拿不到 —— 此时还没有任何 URL 可以拿去测速。

**解法**：**两种策略，别混用**

| 用途 | 策略 | 方法 |
|---|---|---|
| **小文件**（atom / `runtime-chunks.json` / `manifest.json`，KB~百 KB 级） | **顺序试线路**：直连 → 镜像表逐个试；每个短超时（`connectTimeout=4000`），**拿到就返回**，不测速 | 新增 `MirrorSelector.fetchText(url, cacheFile): Pair<String?, String>`（返回值 + 用的线路名） |
| **大文件**（分片、逐块 Range） | **测速选最快**：先直连、达标即用；否则并发探测选最优 | A2 的 `select` |

⇒ **A-3 的实际顺序**：`fetchText`（顺序试）拿到清单 → `planDelta` → `select`（测速）拿最优线路 → 并行块下载。

### E2（阻断级）· `RandomAccessFile` 不是线程安全的

**问题**：A-2 要 6 线程并行写同一个分片文件。`RandomAccessFile.seek()` + `write()` 是**两步**，两个线程交错就会把块写到错误偏移 —— 数据损坏，而且是**静默损坏**（每块 `sha256` 在写入前校验，写完就不再验，只靠最后整文件校验兜底；但整文件校验失败后要整个重下）。

**解法**：用 **`FileChannel.write(ByteBuffer, long position)`**（positional write，内核层面原子），或**每线程独立开一个 `RandomAccessFile`**（各写各的区间，`seek` 互不影响）。

推荐 `FileChannel`：

```kotlin
FileChannel.open(dst.toPath(), StandardOpenOption.WRITE, StandardOpenOption.CREATE).use { ch ->
    ch.write(ByteBuffer.wrap(buf), off)   // 指定 position，线程安全
}
```

**附带后果**：整文件终校（`RuntimeDelta.kt:232`）在并行下更不可省 —— 它现在是最后一道防线，**保留不动**。

### E3 · 进度上报会线程竞争

`runApply` 里 `var done = 0L` 被 `done += len` 累加（`:224`），并行后必须换成 `AtomicLong`，否则丢更新、进度倒退（历史上踩过"百分比来回跳"，`RootfsInstaller` 已用 `AtomicLong` 解决过一次）。

同时 `message` 是 `@Volatile` 字符串字段，多线程写是"最后一个赢"—— 可接受（只用于显示），不需要加锁。

### E4 · B 的打点不能放在 `synchronized(lifecycleLock)` 里

`host.start(...)` 当前在 `synchronized(lifecycleLock)` 块内（`:6912-6921`）。`EventLog.record` 有 IO，**持锁做 IO 会拖慢并发的 `currentStart()` 检查**。⇒ `engine.spawn` 必须打在**块外**（`val proc = try { synchronized { … } }` 结束后）。

同理 `engine.token` / `health.*` 本来就在锁外，注意不要再包进 `synchronized`。

### E5 · `MirrorSelector` 的可测性设计

探测要联网，单测跑不了真网络。⇒ `select` 与 `fetchText` 都接受**可注入的探测函数**：

```kotlin
object MirrorSelector {
    fun select(
        url: String,
        cacheFile: File? = null,
        budgetMs: Int = 2500,
        probe: (String, Int) -> Info = ::defaultProbe,   // 单测注入假实现
    ): Choice
}
```

单测覆盖（不碰网络）：

1. `rewrite`：非 `github.com` → `null`；`/releases/download/` → 拼接；`releases.atom` → `null`
2. `select`：假 probe 让直连 2 MiB/s → 返回直连且**未探镜像**（用计数器断言）
3. `select`：假 probe 让直连 100 KiB/s、镜像 A 800 KiB/s、镜像 B 1.5 MiB/s → 选 B
4. `select`：某镜像 `rangeOk=false` 但速度最快 → **被排除**
5. `select`：全失败 → 返回直连且 `degraded=true`
6. 缓存命中：第二次调用只探 1 个（计数器断言）

→ `RuntimeS6Test` 从 27 条增到 **33 条**左右。
