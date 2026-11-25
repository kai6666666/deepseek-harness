# 更新日志

## [Unreleased] — 收尾（无代码变更）

- 包名最终决定：**`com.dsh.android`**（0.4.1 起），不再变更；
- 工程进入**维护态**：只修 bug，不改身份与架构；
- 文档对齐：`AGENTS.md` / `docs/agents/constraints.md` / `docs/plan/…`；
- 设备侧清理：删除演练备份 `dsh-backup-drill.zip` 与 13 个历史 APK（约 2.4 GB）。

**不发新版**：本批只有文档与文件清理。
## [0.2.2-rc.5-debug.42] — 2026-11-25
vc=127

### 修复：`runtime-chunks.json` 下载不走镜像（`debug.41` 演练撞出来的）

`debug.41` 修好了「apply 静默不启动」，真机上立刻暴露出下一层：

```text
18:12:08  小文件走镜像 GhProxyCom：releases.atom        ← atom 成功（1.2s）
18:12:52  检查失败：Release 里没有运行时清单：最近 5 个 tag 全部「下载失败」
```

**根因**：`latestRuntimeRelease()` 探 tag 时用的是

```kotlin
val txt = httpGet(base + CHUNKS_NAME)     // ← 直连！不走镜像
```

真机同一分钟同一 URL 的对照：

```text
gh-proxy  http=200  t=2.72s   size=292451   ← 正确，正是文件大小
direct    http=000  t=31.46s  size=0        ← 完全不通
```

⇒ 5 个 tag 全卡在直连上失败，而错误文案说的是「Release 里没有运行时清单」——
**又一次把网络问题误导成发布缺资产**（同一类问题的第二次）。

**修法**：探 tag 与 `runCheck` 两处都改走 `httpGetWithMirrors`。

### 附：A-2「Range 分块 + 并行」在 167 MB 真实下载上验证有效

```text
单流 curl -C -：30 分钟只到 43 MB（≈24 KB/s）
6 线程 Range 分块（16 MB/块 × 10）：186.4s，875 KB/s，zip testzip=None ✓
```

⇒ 再次印证 A-0 的结论：**瓶颈是请求数，不是带宽**。

## [0.2.2-rc.5-debug.41] — 2026-11-25
vc=126

### 修复：`apply` 静默不启动（状态机 + dryrun 时序）

真机现象（`debug.40`）：入口已经通了，check 也探明了「全量 143.5 MB」，但 apply 没跑：

```text
02:22:38  小文件走镜像 GhProxyCom：releases.atom        ← 入口 OK
02:22:56  apply 结果 = {"state":"ready", ...全量 143.5 MB}  ← 但 parts/ 无 staging
          events.jsonl 里也没有 runtime.download.via
```

**根因**：`auto-dryrun` 钩子是「`checkAsync()` → `sleep(10s)` → `applyAsync()`」。
而 `runCheck` 现在要走镜像 + 探测多个 tag，耗时 20+ 秒 ⇒ 调 `applyAsync` 时
`state` 还是 `"checking"`，而它开头是：

```kotlin
if (state != "ready") return false      // ← 静默返回，什么都没留
```

⇒ 30 秒后打印的还是 `state=ready`，看起来就像 apply 从没被触发。

**三处修法**：

1. **失败必须可见**：`applyAsync` 被拒时写 `message = "还不能应用：当前状态=$cur"` + `Log.w`。
2. **dryrun 改成轮询等终态**（不再靠固定 sleep 猜）：
   - check 等 `ready` / `error`，上限 90 秒
   - apply 等 `applied` / `error`，上限 30 分钟（全量 143 MB 可能要十几分钟）
3. **`runCheck` 的结果给 `runApply` 复用**（5 分钟 TTL）：原来 apply 会自己再跑一遍
   `latestRuntimeRelease()` + `planDelta()` —— 等于用户「看到 143 MB 提示并点应用」之后
   **还要再等一遍 atom + 多 tag 探测**（走镜像也要 6~10 秒）。现在直接复用。

### 无行为变更（对最终用户）

更新逻辑本身没变：仍是「检查 → 用户点应用 → 增量/全量下载 → 校验 → 落盘」。
本版只修「应用阶段可能根本没启动」与「apply 侧白等一轮探测」。

## [0.2.2-rc.5-debug.40] — 2026-11-25
vc=125

### 补入口：`releases.atom` 现在能走镜像（这原来是个单点故障）

上一版把多线路做在 `/releases/download/` 上，但 **atom 是整条更新链的入口**：
拿不到 tag 就拿不到任何下载 URL，选路根本没机会跑。真机实测（当前网络）：

```text
直连 atom     http=200  t=25.000s  size=0      ← 25 秒到点仍 size=0，等于不通
直连 分片     http=000  t=25.001s              ← 完全不通
镜像 atom     http=200  t=1.22s    size=9316    ← gh-proxy.com
镜像 分片     http=200  t=1.22s    size=1888
```

**修法**：新增 `ATOM_MIRRORS` + `atomUrls()`，只放**实测能转普通 URL** 的镜像
（当前仅 `gh-proxy.com`）。`httpGetWithMirrors` 按 URL 类型分流：

```text
/releases/download/*  → GithubMirrors.mirrored().take(6)   （分片表，5 条）
其它（atom 等）        → GithubMirrors.atomUrls()          （atom 表，1 条）
```

⚠️ 不能拿整表顺序试 atom —— 另外 4 条对 atom 明确回 403/404，试了只是白等 4 个超时。

### 超时收紧：直连不通时不再白等 15 秒

| 位置 | 改前 | 改后 | 为什么 |
|---|---|---|---|
| `httpGet`（atom / 清单 / manifest） | connect 15s / read 20s | **connect 6s** / read 20s | 实测直连 25s 都不通，15s 纯属白等；压短后总耗时「15s 失败」→「6s + 1.2s 成功」 |
| `downloadRange`（分块） | connect 15s / read 30s | **connect 8s** / **read 60s** | 8 秒连不上说明这条线路坏了，快速失败好换线；60s 给慢镜像读够 |

海外/网络好的用户 6 秒内就成功，不受影响。

### 镜像表按真机实测裁剪：16 → 5

| 镜像 | atom | 分片 | Range |
|---|---|---|---|
| **gh-proxy.com** | **200 / 1.22s** | 200 / 1888B | **206** |
| ghproxy.net | 403 | 200 / 1.23s | 206 |
| ghfast.top | 403 | 200 / 1.31s | 206 |
| github.boki.moe | 404 | 200 / 1.37s | 206 |
| gh.monlor.com | 404 | 200 / 1.43s | 206 |
| **ghproxy.cfd** | 000 | **200 / 22474B（HTML）** | **200** ❌ |
| 其余 9 条 | 000 / 403 / 429 / 裸 302 | — | ❌ |

**16 条里 9 条是死的（56%）**。淘汰 `ghproxy.cfd` 尤其重要：它**接受 `Range` 头却返回
200 全文**（还给了 22474 字节 HTML 错误页）—— 若放它进来，分块下载会走"跳过前缀"分支，
2296 个块每块重下前缀 = **O(n²) 流量**。这次实测正好给"判据必须是 206"提供了一个活样本。

### 测试 36 → 38

- `atomUsesDedicatedMirrorListNotTheDownloadOne`：atom 必须有候选、**分片表不该匹配 atom**
- `atomMirrorListIsSubsetOfTheWorkingMirrors`：atom 表必须是分片表的子集（两张表别不一致）

第二条测试当场抓到一个真 bug：`atomUrls` 只判了 `contains("github.com")`，没排除
`/releases/download/` ⇒ 分片 URL 也会拿到 atom 候选，白白丢掉另外 4 条可用线路。

## [0.2.2-rc.5-debug.39] — 2026-11-24
vc=124

### 运行时更新：多线路 + 并行块下载（A-1 / A-2）

**改前的实测基线**（`debug.37`，全量 143.5 MB）：

```text
23:26:48  check 开始
23:27:28  "正在下载运行时… 2.6 MB / 143.5 MB"    ← 30 秒只下了 2.6 MB
```

| 指标 | 改前 |
|---|---|
| 吞吐 | **≈ 87 KB/s** |
| 预计耗时 | **≈ 27 分钟** |
| 请求数 | **2296 次串行**，单线路直连 `github.com` |

⇒ 瓶颈是**请求数**（每次建连 + 302 + Range），不是带宽。

### A-1 新增 `GithubMirrors`：自动选最快线路

- **只对 `github.com` + `/releases/download/` 生效**。`api.github.com` 与
  `releases.atom` 不走镜像 —— 前缀式代理不转 API，硬塞 100% 失败。
- **两段式探测，总流量 ≤192 KB**（Operit 那套是 `34 × 256 KB = 8.5 MB`，移动网络下是负优化）：
  1. 全部并发发 `Range: bytes=0-0`（每条约 1 字节），验 206 + 从 `Content-Range` 拿真实大小
  2. 只给 RTT 最快的前 3 条做 64 KB 真速测
- **判据必须是 206**：很多代理接受 `Range` 头却返回 **200 全文**，而块下载在 200 时会
  "跳过前缀"（off 可达几十 MB）⇒ 2296 个块变成 **O(n²) 流量灾难**。
  探测阶段就把这种镜像剔除。
- **直连优先**：直连 1 字节探活 + 64 KB 速测，≥512 KiB/s 就**跳过镜像全测**
  —— 海外/科学上网用户零额外延迟。
- **全灭回退直连**（`degraded=true`）：选路失败不是错误，行为与改前完全一致。
- 缓存只在内存（TTL 30 分钟）：镜像可用性变化快，落盘的过期结果比没有更糟。

### A-2 并行块下载（`RuntimeDelta`）

- 块数 **≥32 才并行**（6 线程）：增量常态只下几块，为几十 KB 起线程池反而更慢。
- **写入用 `FileChannel.write(buf, position)`**，不是 `RandomAccessFile`：
  `seek()`+`write()` 是**两步、非原子**，6 线程交错会把块写到错误偏移 ——
  而且是**静默损坏**（块的 sha256 在写入**之前**校验，写完不再验）。
- `done` 改 `AtomicLong`；`message` 节流 200 ms（否则 6 线程把日志刷屏、真正的错误被淹没）。
- 串行路径保留给增量。

### 接入

- `runApply` 里**只选一次线路**（绝不每块都探），结果写
  `EventLog.record("runtime.download.via", {via, bps, degraded})`。
- `downloadRange` 增加 `base` 参数，按选中镜像改写 URL。
- 清单 `runtime-chunks.json` 与 `manifest.json` 走新增的 `httpGetWithMirrors`
  （顺序试前 6 条镜像）：这两个文件本身也在 `/releases/download/` 下，
  直连不通时**连"要下什么"都拿不到**，所以它们不能等"测速选最快"。

### 测试 30 → 36

新增 6 条（全部用注入的假 `probe`，不碰真网络，因此能进 `apk.yml` 单测门禁）：

- `mirroredOnlyRewritesReleaseDownloadUrls`：过滤规则 + 拼接无双斜杠
- `pickPrefersDirectWhenFastEnough`：直连达标时**只探 2 次**、不碰镜像
- `pickChoosesFastestMirrorAndExcludesNonRange`：选最快 + **排除不支持 Range 的**
- `pickFallsBackToDirectWhenEveryMirrorFails`：全灭回退 + `degraded`
- `pickCachesChoiceAndReusesIt`：缓存命中不再探测、换 URL 失效
- `pickWithNoMirrorCandidatesStaysDirect`：非 release URL 不产生候选

## [0.2.2-rc.5-debug.38] — 2026-11-24
vc=123

### 修复：`pruneParts` 会把 `parts/.staging-*` 当成一个"版本"，可能删掉**正在用的增量基线**

`RuntimeFiles.pruneParts` 的过滤条件漏了排除 `.` 开头的目录，而同一文件的
`RuntimeDelta.localBase` 是排除的 —— **两个函数对同一目录两套判据**。后果链：

```text
runApply 的临时目录 = parts/.staging-<ver>-<pid>
  → apply 被系统杀掉后残留
  → 下次 pruneOldBaselines() 按 mtime 排序时，残留半成品（mtime 更新）被当成"最新版本"保留
  → 真正的当前基线 parts/<ver>/ 被删除
  ⇒ 下一次更新退化成全量（143.5 MB ≈ 27 分钟，见下），磁盘上还留个 144 MB 级半成品
```

已修（一行）：判据与 `localBase` 对齐，`!it.name.startsWith(".")`。

### 修复：`sweepStale` 扫不到 `parts/.staging-*`，被杀残留永久占空间

`sweepStale` 只认一级的 `rootfs.staging-*` / `rootfs.old-*`，而 `RuntimeDelta` 的
临时目录在 `runtime/parts/` 下面 ⇒ 进程被杀后那份半成品**永远没人清**。

现在增加第二段扫描，判据用 **pid** 而不是 mtime（目录名末尾就是 pid）：

```kotlin
val pid = f.name.substringAfterLast('-').toLongOrNull()
when {
    pid != null && currentPid > 0L -> pid != currentPid      // 别人的残留才删
    else -> now - f.lastModified() > STALE_PARTS_AGE_MS      // 解析不出 pid 才用 24h 兜底
}
```

三个调用点（`EngineManager` 启动清扫 + `RootfsInstaller` 两处安装前清扫）都传 `currentPid`。

### 修复：检查更新失败不再一律报「没找到带清单的 Release」

`debug.34`（D2）修的是「匿名 API 限流 403 被误报成没找到 Release」。但**网络整体不通**
仍会落进同一句话，让人以为是发布缺资产、去翻 Release 页 —— 方向完全错。

新增 `ReleaseFailKind`：

| kind | 什么时候 | 用户该做什么 |
|---|---|---|
| `NETWORK` | `releases.atom` 读不到（超时/连接被拒/被拦截），或未知异常 | 检查网络（A 上线后会自动试镜像） |
| `NO_MANIFEST` | atom 拿到了，但最近 5 个 tag 都没有 `runtime-chunks.json` | 这才是"发布缺资产" |
| `PARSE` | atom 能取到但解析不出任何 tag | 反馈 |

另加 `lastFailureKind` / `lastFailureMessage` 两个只读 accessor 给 UI。
兜底文案也从"没找到"改成"检查更新失败：原因未知（既没拿到 atom 也没拿到清单）"。

### 已知基线：全量运行时要 27 分钟（下一版 A 的目标）

在 `debug.37` 上真机实测一次全量下载（143.5 MB）：

```text
23:26:48  check 开始
23:27:28  "正在下载运行时… 2.6 MB / 143.5 MB"    ← 30 秒只下了 2.6 MB
```

| 指标 | 实测 |
|---|---|
| 吞吐 | **≈ 87 KB/s** |
| 预计耗时 | **≈ 27 分钟** |
| 请求数 | **2296 次串行**，单线路直连 |

⇒ 瓶颈是**请求数**（每次建连 + 302 + Range），不是带宽。多线路解决"下得动"，
并行块下载解决"下得快"，两者缺一不可。

### 测试

`RuntimeS6Test` 27 → **30**：

- `prunePartsIgnoresDotStagingDirs`：`.staging-*` 既不参与 mtime 排序、也不被 `pruneParts` 删
- `sweepStaleClearsForeignStagingAndKeepsOwnPid`：删别人的 staging / 一级残留 / 超龄 legacy；
  保留本进程的、未超龄且解析不出 pid 的、真基线
- `sweepStaleWithoutPidFallsBackToMtime`：`currentPid = -1` 时只看 mtime

本版 `app/` 只改了 `RuntimeFiles` / `RuntimeDelta` / `RootfsInstaller` / `EngineManager`
的上述四处，**不动运行时结构与启动流程**。

## [0.2.2-rc.5-debug.37] — 2026-11-24
vc=122

### 发布入口收口：删掉会发出"残废包"的旧工作流

仓库里同时存在**两个手动发布工作流**。`publish-release-from-run.yml` 已经彻底过时：

```yaml
SYS=$(find dist/dsh-system-release -name '*.apk' | head -1)
GECKO=$(find dist/dsh-gecko-release  -name '*.apk' | head -1)
test -n "$SYS" && test -n "$GECKO"     # ← gecko 变体早已不构建
```

**两层危害**：

1. **跑不通**：`apk.yml` 只产出 `dsh-system-*`，没有 `dsh-gecko-release`，卡在这行断言。
2. **跑通了更糟**：它只挂两个 APK，**不挂 runtime 分片 / manifest / plugins /
   `runtime-chunks.json`** —— 就算手工补上 gecko 让它成功，发出来的 Release
   也没有增量能力（P2 直接失效），`SHA256SUMS.txt` 只有 2 行，
   release notes 还是硬编码的 `dsh@0.2.2-rc.1` / `mobile-ui 1.1.0-163`。

已删除。删除前逐个扫描其余 7 个工作流，确认无引用、无 `workflow_run` 依赖。
**唯一正确的发布入口是 `publish-apk.yml`**（`publish` + `publish-plugins` + SHA256SUMS 重建）。

### 工具目录：清掉 10 个已完成使命的一次性探针

做了**引用审计**：对仓库内 442 个可读文本文件逐个搜索 `tools/` 下 120 个脚本的路径与文件名，
判定「无任何文件引用」的共 18 个。其中 10 个是已完成使命的一次性取证探针，删除
（git 历史里永久可查）：

| 已删除 | 为什么 |
|---|---|
| `tools/probe/probe171.js` ~ `probe176.js` | 抽屉/设置页取证系列。问题已修（v7 起 CSS 首帧生效），中间版本不再需要 |
| `tools/probe/probe181.js` ~ `probe184.js` | 头部栏对齐系列。结论已固化进 `docs/agents/mobile-ui.md` |

**保留判据**：只要还被别的文件提到（哪怕只是文档）就留着 —— 说明它仍有解释价值。
`probe170.js`（首个取证脚本，注释自带方法论）与 `probe-lralign.js`（几何一致性验收）因此保留。

**没删的「无引用」脚本**：`probe-vmos.mjs`、`ui-drive.mjs`、`ui-standalone.mjs`、
4 个 `uiagent-*` —— 它们是**手动工具**而非一次性探针。

### `tools/legacy/`：把被推翻的方案留档

新增 `tools/legacy/`，第一份归档是 `plugin-readme.py`（原 `tools/plugin-readme.py`）。

它想用「补 `README.md`」修插件详情页的「插件声明的详细介绍文件无效」，方向是错的：

1. 官方 `@deepseek-ai/dsh-plugin-detail` 读的是 **`docs/DETAIL.md`**，不是 `README.md`；
2. 包旁的 `README.i18n.yaml` 是**双语区块哈希旁签**，塞 README 会让哈希对不上，
   **反而制造新的「无效」**；
3. 真正该修的是 `tools/runtime/build-runtime.sh` 的两条删除规则，
   以及用 `tools/plugin-docs.py` 把 `docs/` 补回来。

`tools/legacy/README.md` 里写了完整复盘，避免以后有人再走一遍这条路。

### 文档

- `docs/plan/progress.md`：P0/P2 三项转 ✅、P1 三项转 ⛔（D4）、新增 D5/D6 决策；
- `tools/probe/README.md`：清单同步（只剩保留的 9 个），新增清理记录与
  「写新探针的约定」（一次性问题标注「取证后即删」、结论要落进 docs 不靠探针保存）。

### 无行为变更

本版只动 CI 工作流与 `tools/` 下的脚本/文档，`app/` 下 Kotlin 零改动
（`RuntimeFailure` / `pruneParts` / `changelog.py` 已在 `debug.36` 落地）。
装上去与 `debug.36` 行为一致，仅版本号推进 —— 收口的目的是让「发布入口唯一」这件事
有一个可追溯的版本号。

## [0.2.2-rc.5-debug.36] — 2026-11-24
vc=121

### P0：首启失败兜底（用户能看懂 + 知道下一步）

以前运行时准备失败，用户看到的是 `State.Failed("运行时准备失败：rootfs 分片校验失败：part2 sha256=…\njava.io.IOException…")`
—— 既不知道差多少空间，也不知道该点什么。

新增 `RuntimeFailure`（纯 Kotlin，可单测）：把 `IOException` 归类成
`INSUFFICIENT_SPACE` / `CORRUPT_ASSET` / `INCOMPLETE` / `PERMISSION` / `UNKNOWN`，
每类给出「标题 + 说明 + 下一步动作」。示例（空间不足）：

```text
存储空间不足，运行时装不下
解包大约需要 3244 MB，当前可用 812 MB。还差约 2432 MB。
请先腾出空间再重试：删掉旧的录屏/下载/别的 AI 应用都可以；若只是缓存占空间，
可在系统「设置 → 应用 → DSH → 存储 → 清除缓存」（不会删会话与凭据）。
点『重试』会重新解包；已校验通过的分片会复用，不会重新下载。
```

配套：

- `RootfsInstaller` 新增 `internal class Failure(info)`，在空间不足与分片校验失败处抛出；
  继承 `IOException`，不破坏既有 `catch (t: IOException)` 契约。
- `EngineManager` 在 `failStart` 前用 `RuntimeFailure.classify(t, filesDir.usableSpace)`，
  并把 `kind` / `code` / `retryable` / `freeMb` 写进 `EventLog`（事件名 `engine.failed.kind`），
  以后能按失败种类统计，而不是只知道「失败了」。
- 判据细节：`usableSpace` 读到 0 或 -1（系统读不出来）时**不判**「空间不足」，
  避免一批设备永远装不上（沿用 `insufficientSpace` 的既有语义）。

### P0：增量基线只留一版（`parts/` 自动清理）

`RuntimeDelta` 会把下好的分片留在 `runtime/parts/<runtimeVersion>/` 当下一轮增量基线。
只留当前版本是 144 MB，但每换一次 runtime 就多一份 —— 历史上跑几次演练就能堆到 400 MB 以上，
而 `RootfsInstaller.sweepStale` 只扫 `rootfs.staging-*` / `rootfs.old-*`，**碰不到 parts/**。

新增 `RuntimeFiles.pruneParts(partsDir, keep = 1)`：

- 按 **mtime** 保留最新 `keep` 个目录（不是按名字排序 —— `runtimeVersion` 里的哈希没有时间含义）；
- 符号链接目录一律跳过（可能指到用户数据）；
- 删不掉不抛（清理失败不该拖累启动），幂等。

调用点在「stamp 已写、swap 已完成」之后（此时当前基线刚被写过，mtime 最新，必然被保留）。

### P2：CHANGELOG 从提交历史生成

新增 `tools/changelog.py`：按 Conventional Commits 把提交分到
`新增 / 修复 / 性能 / 重构 / 工程 / 测试 / 文档 / 杂项`，标题、日期、`vc=` 按
`tools/app-version.txt` 填好，直接可粘。

```bash
# 有 .git（CI 里）
python3 tools/changelog.py --since v0.2.2-rc.5-debug.35
# 没有 .git
GITHUB_TOKEN=… python3 tools/changelog.py --from-api --since v0.2.2-rc.5-debug.35
# 直接插入 CHANGELOG.md
python3 tools/changelog.py --since v0.2.2-rc.5-debug.35 --write
```

`--since` 支持 tag：API 模式下先把 tag 解成 ISO 时间（`commits?since=` 只认时间，
而 tag 也不是提交标题 —— 第一版就是这么写错的，会静默退化成「最近 100 条」）。

### 修复

- `SHA256SUMS.txt` 只写了 APK 一行：`publish` job 里 `sha256sum` 只算 APK，
  而 `plugins / manifest / 4 个分片 / runtime-chunks` 是 `publish-plugins` job 之后才上传的。
  现在在 `publish-plugins` 末尾用 Release 自带 `digest` 重建全量清单（零下载）后 `--clobber` 上传。
- 删除仓库根目录陈旧的 `app-version.txt`（内容是 `debug.31 / vc116`）：版本唯一来源是
  `tools/app-version.txt`，两份并存只会让人改错文件、版本号静默不生效。

### 测试

`RuntimeS6Test` 从 20 条增到 **27 条**，新增覆盖：失败分类 4 条
（空间不足含精确 MB、实测值优先于消息、包损坏/不完整/权限可区分、已分类不重复分类）、
`pruneParts` 3 条（按 mtime 只留最新、不跟随符号链接、缺目录与 `keep=0` 的容错）。

### 工程

- 单测已并入 `apk.yml` 的出包路径（`debug.35` 起）：单测挂了就不出包。
  本轮它两次拦下真问题 —— 一次是测试里的 `\n` 被三层转义吃成真换行（Kotlin 语法错误），
  一次是 4 条断言比较 `Info` 却断言 `Kind`（漏 `.kind`）。这两次如果没并进门禁，
  都会直接出包发出去。

## [0.2.2-rc.5-debug.35] — 2026-11-24
vc=120
### 工程：单测提到出包路径上（单测挂了就不出包）
单测原来只跑在 `compile.yml`（PR 快速反馈），而真正出包的 `apk.yml` 不跑 ——
`RuntimeS6Test` 因此红了两天没人发现。本版把单测插到 `assembleSystemDebug` 的
「编译门禁（engine）」之后：

```yaml
      - name: 单元测试门禁（app 单测，含 S6 回归）
        run: bash ./gradlew :app:testSystemDebugUnitTest --console=plain --stacktrace
      - name: 单测报告（失败时也上传）
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: app-unit-tests
```

实证（run `45328267758`）：step16 / step17 均 `success`，artifact `app-unit-tests`
6,280 B；step29「发布到 Release」仍 `skipped`，不会误发。

### 仓库卫生：删掉会误导人的旧版版本文件
仓库根目录还留着 `app-version.txt`（内容是 `0.2.2-rc.5-debug.31` / `vc 116`），
但版本唯一来源早就迁到 `tools/app-version.txt`，所有工作流（`apk.yml` /
`publish-apk.yml`）也只读 `tools/` 下那份。根目录这份已删除 —— 否则改错文件
会让版本号静默不生效。

### 文档
- `docs/plan/progress.md`：全景进度、决策 D1/D2/D3、10 条问题台账、P0/P1/P2 待办；
- `docs/agents/runtime-delta.md`：P2 设计 + 3 次演练 + Atom 改造 + 真机取证方法；
- `docs/agents/plugin-data-repair.md`：升级/重建 runtime 后两类数据失效的判定与修复；
- `docs/agents/mobile-ui.md`：16dp 三列表、标题 `padding-left` 根因、幂等纪律。

### 无行为变更
本版只动 CI 与仓库文件，`app/` 下 Kotlin 代码零改动（`purgeLegacy` 与 Atom
增量已在 `debug.34` 落地）。装上去与 `debug.34` 行为一致，仅版本号推进。

## [0.2.2-rc.5-debug.34] — 2026-11-24
vc=119
### 运行时增量（P2）：不再依赖 GitHub API 配额
旧实现用匿名 `GET /repos/…/releases?per_page=10` 找带 `runtime-chunks.json` 的 Release。
匿名配额只有 **60 次/小时/出口 IP**（全网共享），打空时返回 403，却被误报成
「没找到带 runtime-chunks.json 的 Release」——用户侧看到的就是「检查更新失败」。

本版改走 **`releases.atom` + 固定下载前缀**：

```text
1) GET https://github.com/<repo>/releases.atom            ← 无认证、不严格限流
   解析前 5 个 tag（可跳过只挂 APK 的版本）
2) https://github.com/<repo>/releases/download/<TAG>/runtime-chunks.json
3) 资产名直接来自清单 files.keys  https://github.com/<repo>/releases/download/<TAG>/<name>
```

配套：清单在探测时已下载（`chunksText` 复用，少一次请求）；`RuntimeRelease` 新增
`baseUrl` / `chunksText`；`planDelta` 在 `assets` 为空时按 `baseUrl` 拼；
新增 `lastReleaseError` 把真实失败原因带进 `message`。
### 运行时清扫：保住 `termux/home` 用户数据
`RuntimeFiles.purgeLegacy` 原来把整个 `termux` 删掉，会连用户在 `termux/home` 里的
自定义环境一起删。现在只删 bionic 时代的 `termux/usr`，`termux/home` 保留；
返回值仍含 `"termux"`，两次调用幂等。（`RuntimeS6Test` 一直红的就是这条，现已转绿。）
### 移动端 UI 插件 1.1.0-237
- 插件详情页可读（`docs/DETAIL.md` 随 runtime 构建）；
- 插件页三个列表左右 16dp；导航标题左对齐（`padding-left` 52px → 0）；
- 补丁改 `MutationObserver + requestAnimationFrame`，首帧即生效，标题不再「向左瞬移」。

## [0.2.2-rc.5-debug.33] — 2026-11-24
vc=118
### 运行时：插件详细介绍真正带进 runtime
上一版修掉了一条规则，但 `*.md` 那条还在删 `docs/DETAIL.md`，实测 `debug.32` 的 rootfs：
**16 个包有 `docs/` 目录，`detail_md=0`，只剩 `preview.svg`** ⇒ 详情页依旧报无效。
本版把两条规则都修齐：

```bash
# ① 文件规则：豁免 README 与 docs/ 下的所有 md
find "$ROOTFS/opt/dsh/node_modules" -type f \( -name '*.map' -o -name '*.md' -o -name '*.markdown' \) \
  ! -name 'README.md' ! -name 'readme.md' ! -path '*/docs/*' -delete
# ② 目录规则：只删 test/tests/__tests__/example/examples（docs 已不在列表里）
```

⇒ 本版构建出的 runtime **自带 `docs/DETAIL.md` / `DETAIL.zh.md` / `preview.svg`**，
重装 APK 或重建 rootfs 都不会再丢，不必手工补。
### 文档
- 新增 `docs/agents/plugin-data-repair.md`：升级 / 重建 runtime 后两类数据失效的排查与修复——
  ① `docs/*.md` 被删 ⇒ 详情页「详细介绍文件无效」（含设备侧判定与应急补命令、
  哪些包本来就没有 `docs/`）；
  ② profile 里第三方插件变成 PRoot `.l2s` 死链 ⇒ 「未运行 / 包不可用」
  （判定：`ls -la` 全是软链 + `cat package.json` 为空；修法：从 npm 镜像拉 tgz 重装真实文件；
  验证：`engine.log` 能看到 `已注册 …工具`）。
- 文末附通用排查三条：文件在不在 → 是不是死链 → `engine.log` 认没认，
  以及 `app.log` / `web.log` / `engine.log` 三个日志的分工。

## [0.2.2-rc.5-debug.32] — 2026-11-24
vc=117
### 移动端 UI 插件 1.1.0-237
- **插件详情页恢复可读**：「插件声明的详细介绍文件无效」有两层真因——
  ① `tools/runtime/build-runtime.sh` 删了**整个 `docs/` 目录**（`dsh-plugin-detail` 读 `docs/DETAIL.md`）；
  ② 包旁的 `README.i18n.yaml` 是**哈希旁签**，人手塞的 README 对不上哈希同样判无效。
  修法：构建脚本保留 `docs/`；新增 `tools/plugin-docs.py`（jsDelivr 拉真实 `docs/`，
  `--fallback` 用 description 生成最小 `DETAIL.md`，`--keep-map` 合并清单）。
- **插件页三个列表不再贴边**：实测官方 `SECTION` 宽 394 / left 0，改为抬最外层容器
  （`main,section` 宽 ≥ 90%vw 且 left ≤ 2 → `padding: 0 16px`），列表左缘落到 **16dp**。⚠️ `ul` 加 `padding`
  反而更贴边（只推内容，底色仍铺满），必须改父容器。
- **导航标题左对齐**：父链探针查出官方给 `header` 留了 `padding-left: 52px` 给返回按钮，
  按钮本身又是 flex 子项，叠加把 `H1` 推到 104。归零后 `BUTTON@16 / H1@52`，截图标题行左缘 259px → **90px**。
- **消除标题「向左瞬移」**：补丁从「1.2s 定时器」改为 **MutationObserver + requestAnimationFrame**，
  样式在**首次 paint 之前**生效。逐帧采样验收：`first left=32 padL=0px frame=1`。
  另注：CSS 属性选择器（`header[class*="_moreHead"]`）在 CSS Modules 场景下**不命中渲染**，已弃用。
### 文档
- 新增 `docs/agents/mobile-ui.md`：设计 token 白名单（`bg-elevated` / `bg-subtle` 不存在）、
  详情页两处根因、对齐 6 轮实测表、补丁时机与采样判读、探针与量像素固定套路。

## [0.2.2-rc.5-debug.31] — 2026-11-23
vc=116

### 诊断
- 新增**无屏演练钩子**：`files/runtime/auto-dryrun` 存在时，App 启动 12 s 后自动跑一次
  `RuntimeDelta.checkAsync` → `applyAsync`，结果全部写进 `app.log`。
  用途：不点屏就能验证「清单比对 → Range 下载 → sha256 → staging 原子替换」整条链路；
  文件不存在时完全无行为。演练脚本与实测数据见 `docs/agents/runtime-delta.md`。

## [0.2.2-rc.5-debug.30] — 2026-11-23
vc=115

### 接线（P2 收口）
- `RootfsInstaller.resolveManifest()`：**增量下载的新 runtime 优先**（`files/runtime/parts/<ver>/manifest.json` 最新一份），
  没有再回退 APK assets。`EngineManager` 的 4 个调用点全部改用它 —— 否则下载完永远不被采用。
- `RootfsInstaller.installParts`：拷分片时先找 `files/runtime/parts/<manifest.runtimeVersion>/<asset>`，
  长度与 sha256 都对就直接用（日志 `partN 用增量分片`），否则回读 assets。
- 前端「关于 → 检查更新」接入运行时行：`runtimeDeltaCheck` / `runtimeDeltaState` / `runtimeDeltaApply`，
  弹窗按「安装包 / 界面 / 运行时」三行显示，增量时标注 KB；只补运行时则提示「重启 App 生效」。
  旧 APK 没有这些桥 → 直接跳过（热包可装在 debug.28 上）。

### 说明
- 移动端 UI 插件 `1.1.0-218`。

## [0.2.2-rc.5-debug.29] — 2026-11-23
vc=114

### 新增（P2 客户端段）
- `RuntimeDelta.kt`：runtime 文件级增量的客户端实现。
  - 从 Release 的 `runtime-chunks.json` 取块清单，按 64 KiB 块比对本地旧分片，
    只对变化的块发 HTTP Range（`bytes=off-off+len-1`）；
  - 两道校验：单块 sha256 → 整文件 sha256，任一不符即丢弃；
  - `.staging-<ver>/` 内拼装 → 成功后原子 `rename` 到 `files/runtime/parts/<ver>/`；
  - 无本地旧分片时自动回退**全量**，并把分片保留，供下一次走增量；
  - 三条纪律与热更新一致：**不自动检查/不自动下载、只升不降、校验不过一律丢弃**。
- 桥新增三方法（三层同构）：`runtimeDeltaCheck` / `runtimeDeltaState` / `runtimeDeltaApply`。
- `publish-apk.yml`：发布时把 `rootfs-*.tar.xz` 与 `manifest.json` 一并挂上 Release
  （`RuntimeDelta` 的 Range 请求必须指向 Release 资产）。

### 尚未接线（下一段）
- `RootfsInstaller.installParts` 仍从 APK assets 拷分片；需改成「`files/runtime/parts/<manifest.runtimeVersion>/`
  有就用它」，增量才能真正替掉重装 APK。
- 前端「检查更新」弹窗还没显示运行时行。

## [0.2.2-rc.5-debug.28] — 2026-11-23
vc=113

### 性能（设置页四处加载慢）
- **「关于」后置**：`settings.section` 的 `order` 29 → 201，排在「多模态配置」(order 200) 之后。
- **「开发环境」不再空等 13 秒**：`/api/dsh-android/devenv` 加 60 s 状态缓存 + 并发去重 + 写后失效；
  插件挂载 3 s 后静默预热一次；前端加模块级快照（切走再回来先渲染快照，后台再刷新）。
  真机实测：**13.9 s → 6 ms**（`x-dsh-force: 1` 强制重算 5.7 s）。
- **「内置插件」不再每次重扫**：宿主半把 `pluginInventory.list()` 包一层
  （30 s TTL + 并发去重 + 8 s 硬上限）。官方实现每次调用都重读全部 fiber，
  且对 failed 的 fiber 会 `await fiber.await()` —— 一个插件卡住就拖死整张清单。
- **「插件市场」不再干等 15 秒**：overlay 里给 `plugin-market` 加配置
  `fetchTimeoutMs` 15 s → **3 s**、`cacheTtlMs` 10 min → **1 h**。
  原先两个索引（dshopen.org / jsdelivr）抓不动时，每个都要干等满 15 s 才回落离线目录。

### 说明
- 移动端 UI 插件版本 `1.1.0-214`（走热更新通道，无需重装 APK 也能先拿到前端改动）。

## [0.2.2-rc.5-debug.27] — 2026-11-23
vc=112

### 修复
- **vc111 的修复在设备上没生效**：`tools/mobile-ui-version.txt` 仍是 1.1.0-205，
  而 `client.js` 已改 → 版本戳相同 → `ensureMobileUi` 直接跳过解包，跑的还是有 bug 的旧文件。
  现 bump 到 **1.1.0-206**（这就是为什么改 `mobile-ui` 必须同步 bump 版本号）。

## [0.2.2-rc.5-debug.26] — 2026-11-23
vc=111

### 修复
- **设置页崩在 `settings.section`**：`slot entry crashed … TypeError: template.replace is not a function`。
  原因：「关于」分节用了框架的 `props.t`，而它只支持**字符串模板**；本字典里有
  `(v) => ...` 这类函数值，于是调用时对函数做 `replace` 报错。
  现改为像开发环境分节一样**自己实现 t**（`useMemo` + 自带中英文字典）。

## [0.2.2-rc.5-debug.25] — 2026-11-23
vc=110

### 新增
- **设置 → 「关于」分节**（order 29，排在开发环境 / 运行日志之后）：
  版本号（读 BuildConfig，非手写）、检查更新、允许预发布版、项目地址 / Star / 更新日志 / 许可、
  联系方式与开发者。
- **检查更新弹窗**：检查中 → 检查完成 / 发现新版本；显示 APK 与界面的可更新项与体积。
- **更新历史**：卡片列表（★ 最新徽章 + 绿色「最新」+ 日期 + 摘要 + 展开更多 + 查看发布/下载）。
- 新桥 6 个（三层同构）：`aboutInfo` / `openUrl` / `releasesJson` / `pluginUpdateCheck` /
  `pluginUpdateState` / `pluginUpdateApply`；新增 `ReleaseFeed`（异步 + 10 分钟缓存）。

### 变更（关键）
- **取消自动更新**：启动不再检查/下载热包，只在用户点「检查更新」时联网。
  （真机事故：启动自动拉包把缺 `lib/index.js` 的坏包装上 → 插件挂载失败、界面回退桌面布局、就绪超时。）
- **完整性校验**：`package.json` / `lib/client.js` / `lib/index.js` / `lib/drawer-fix-170.js`
  缺一个就不生效；解到 `.staging-<ver>` → 校验 → 原子替换；坏包移入 `plugins/.rejected/`。
- **支持增量包**：`plugins-mobile-ui-<base>-<ver>.delta.zip` + `plugin-manifest.json`
  （`kind/base/files/deletes`）；基线不符或校验不过则丢弃、保留旧版。

### 配套
- `tools/mobile-ui-version.txt` 1.1.0-203 -> **1.1.0-205**；插件 `package.json` 1.0.6 -> **1.0.7**。

## [0.2.2-rc.5-debug.24] — 2026-11-23
vc=109

### 修复
- `PluginUpdater` 的检查结果在子线程里 **不落盘**（logcat 有、`app.log` 没有）：
  改为把结果回传给 `EngineManager.startPluginUpdateCheck()`，用同一个 `DshLog` 记一行摘要。
  现在 `app.log` 能看到：`插件热更新：已是最新（release=1.1.0-203 内置=1.1.0-203）`。

### 实证（vc108 真机 logcat）
- `11-23 03:32:36.758 I PluginUpdater: 已是最新（release=1.1.0-203 内置=1.1.0-203）`
  —— updater 能读到 Release 资产、能比对版本。

## [0.2.2-rc.5-debug.23] — 2026-11-23
vc=108

### 修复
- `PluginUpdater` 原来用 `android.util.Log`：只进 logcat，**app.log 里一行都没有**
  （同一个坑 vc92 踩过）。改用 `DshLog`，否则线上根本看不到它是否工作。

### 运维
- 版本 `0.2.2-rc.5-debug.23` / vc108。

## [0.2.2-rc.5-debug.22] — 2026-11-23
vc=107

### 新增（P1-b 发布端）
- `apk.yml` 新增「打包插件热更新资产」：把 `assets/mobile-ui.zip` 改名成
  `plugins-mobile-ui-<mobile-ui-version>.zip` 并作为 `plugins-mobile-ui` artifact 上传。
- `publish-apk.yml` 新增独立 job `publish-plugins`：从同一个 run 取该 artifact、
  挂到 Release。这样 `PluginUpdater` 才有官方来源可拉。

### 闭环
改 UI → push → 构建 → 发版 → App 启动时自动拉到热包 → 下次启动生效。
**不再需要重装 161 MB APK**。

## [0.2.2-rc.5-debug.21] — 2026-11-23
vc=106

### 新增（P1-b 第二段：自动更新）
- 新增 `PluginUpdater`：每次启动**后台**查一次 GitHub Release，找 `plugins-mobile-ui-<ver>.zip`，
  版本比内置新则下载到 `files/runtime/plugins/`，**下次启动生效**（本次不动运行中的页面）。
  失败一律静默：没网 / 限流 / 资产不存在 / sha256 不符 → 返回 null，不影响启动。
- 急救开关：`files/plugin-update-disabled` 存在则整个跳过。
- 只保留最新 2 个热包，避免长期占用。

### 修复（自查发现的真问题）
- **只升级不降级**：热包版本必须严格大于内置版本才采用。
  否则「内置已是 1.1.0-206、plugins 里还躺着 204」会把前端倒退回旧版。
- **zip-slip 防护**：解包时 entry 名的 canonicalPath 必须落在 target 内，带 `../` 的条目跳过。

### 已知安全点
- `RuntimeFiles.sweepStale()` 只删 `runtime/rootfs.staging-*` / `rootfs.old-*`，
  **不会**动 `runtime/plugins/`（已核代码）。

## [0.2.2-rc.5-debug.20] — 2026-11-23
vc=105

### 新增（P1-b 第一步：插件热更新机制）
- `EngineManager.ensureMobileUi()` 改为**两源**：优先 `files/runtime/plugins/mobile-ui-<ver>.zip`，
  没有或解包失败则**回退内置 `assets/mobile-ui.zip`**。版本戳按实际来源的版本写，
  热包与内置包的版本变化都能触发重解。
- 新增 `hotMobileUiBundle()` / `cmpVersion()` / `unzipInto()`：选版本号最大的热包、
  逐段比较版本、共用解压实现。
- 日志可区分来源：`已安装移动端 UI 插件（热更新包）… src=mobile-ui-1.1.0-204.zip`
  vs `已安装移动端 UI 插件 … 1.1.0-203`。

### 为什么（账）
- 插件资产原本只存在 APK 的 `assets/`，改一行 CSS 就要重装 **161 MB** APK
  （vc96→vc104 九版每版如此）。热包 ~200 KB，推上去重启即生效。

### 下一步
- `PluginUpdater`（自动从 Release 拉热包）+ 发布端产出 `plugins-mobile-ui-<ver>.zip`。

## [0.2.2-rc.5-debug.19] — 2026-11-23
vc=104

### 变更
- **「未授权」改成纯文字**：去掉边框与底色（与卡片同色），文字色 `#ffb454` → **`#ff6b4a`**
  （与左侧橙红圆点同色）。它仍是 `<button>`，点击区域就是那一格 68px，点它照旧跳系统授权页。
- 几何基准未动（`width 68px` / `box-sizing:border-box` / `padding 5px 9px` / `text-align:right`），
  「已授权」与「未授权」右缘仍逐像素重合。

### 运维
- 版本 `0.2.2-rc.5-debug.19` / vc104；`tools/mobile-ui-version.txt` → 1.1.0-203；插件 `package.json` → 1.0.6。

## [0.2.2-rc.5-debug.18] — 2026-11-23
vc=103

### 修复
- **「已授权」与「未授权」右边缘差 9 CSS px**：`bStatusOn` 缺 `padding`，而按钮有 `padding: 5px 9px`。
  现两者几何完全一致（同宽 68px / border-box / 同 padding / 同右对齐），
  真机像素复核：绿字右缘 1178 与橙字右缘 1178 重合。

### 运维
- 版本 `0.2.2-rc.5-debug.18` / vc103；`tools/mobile-ui-version.txt` → 1.1.0-202；插件 `package.json` → 1.0.5。

## [0.2.2-rc.5-debug.17] — 2026-11-23
vc=102

### 修复
- **字号不统一**：标签行 14px / 「已授权」13px / 「未授权」按钮实际 16px 三档并存。
  根因是 `bStatusBtn` 里写了 `font: "inherit"`——它是含 `font-size` 的简写，排在 `fontSize`
  之后把 13px 顶回了继承值。现统一为 **13px**（只留 `fontFamily: "inherit"`）。
- **右边缘不齐**：未授权按钮由 `textAlign:center` 改 `right` + `box-sizing:border-box`，
  「未授权」与「已授权」的右边缘落在同一条竖线（连 0.5px 边框偏差也一并消掉）。

### 变更
- **圆点颜色跟着状态走**：已授权 = 绿点 `#2f9e44`，未授权 = 橙红点 `#ff6b4a`（不再写死品牌蓝），
  点色与右侧文字色/按钮色一一对应。

### 配套
- `tools/mobile-ui-version.txt` 1.1.0-200 -> **1.1.0-201**；插件 `package.json` 1.0.3 -> **1.0.4**。

### 运维
- 版本 `0.2.2-rc.5-debug.17` / vc102。

## [0.2.2-rc.5-debug.16] — 2026-11-23
vc=101

### 变更
- **「基础权限」五行改成表格式对齐**：右侧状态列固定 68px + 右对齐，
  「已授权 / 未授权」不再跟着标签长短跑，五行落在同一条竖线上；行间加 0.5px 分隔线（末行不画）。
- **按钮文案「去开启」→「未授权」**：未授权项右侧就是那个橙色按钮，点它跳对应系统授权页；
  授权回来后同一格变成绿色「已授权」文字（不可点），位置不变。
- 顺带清掉一条过时注释（tabs 里还写着「Shizuku 排第一」，实际已是「基础权限」第一）。

### 配套
- `tools/mobile-ui-version.txt` 1.1.0-199 -> **1.1.0-200**；插件 `package.json` 1.0.2 -> **1.0.3**。

### 运维
- 版本 `0.2.2-rc.5-debug.16` / vc101。

## [0.2.2-rc.5-debug.15] — 2026-11-22
vc=100

### 变更
- **「基础权限」从独立卡片改为标签页**，与 `Shizuku / ADB / root` **同一排、排在最前**
  （它是另三条通道的前置条件：缺存储/通知，AI 开工前就被卡住）。
  标签行由 3 项变 4 项；桥缺失（gecko）时该项整项不出现，安静退回 3 项。
- 面板内不再重复「基础权限」大标题（标签已表明身份），只留一句说明 + 五行状态 + 未授权项的「去开启」。
- 标签圆点：五项全开=绿，否则=橙。

### 配套
- `tools/mobile-ui-version.txt` 1.1.0-198 -> **1.1.0-199**；插件 `package.json` 1.0.1 -> **1.0.2**
  （client.js 有改动，缓存键必须变）。

### 运维
- 版本 `0.2.2-rc.5-debug.15` / vc100。

## [0.2.2-rc.5-debug.14] — 2026-11-22
vc=99

### 修复
- **「基础权限」卡始终不可见 —— 真因钉死**：能力要三层同时齐（`PageBridge` 接口 / `MainActivity` 实现 /
  `SystemWebHost.SystemPageBridge` 的 `@JavascriptInterface` 手工白名单）。vc96 只补了前两层，
  页面侧 `window.DSHAndroid.basicPermState` 是 `undefined`，client.js 的守卫
  `typeof !== "function"` 直接**静默 return**（`pageDiag` 诊断写在守卫之后，所以三版都是一行日志都没有）。
  本次补 `basicPermState()` / `basicPermOpen(kind)` 两条转发，与 `rootState` / `shizukuState` **完全同构**。

### 未动
- `client.js`、`package.json`(1.0.1)、`tools/mobile-ui-version.txt`(1.1.0-198) 一律不变；
- gecko 侧 `dispatchInvoke` 刻意不加：`basicPermState` 是同步返回值、gecko invoke 是异步，
  加了页面会拿到 Promise 并显示成「全部未授权」（误导）。gecko 上这张卡静默不显示，
  与既有「拿不到桥就不渲染」的约定一致。

### 运维
- 版本 `0.2.2-rc.5-debug.14` / vc99；只改 Kotlin，runtime 未变（设备不重解）。

## [0.2.2-rc.5-debug.13] — 2026-11-22
vc=98

### 「基础权限」卡不显示 —— 按包版本命中的旧编译产物（E+A）
- 根因（高置信）：`@deepseek-ai/dsh-client-modules` 把 `client.js` 编进浏览器 bundle 时按
  **包名@版本** 缓存；`mobile-ui` 的 `package.json` 版本一直是 `1.0.0`，所以只改 `client.js`、
  只 bump `MOBILE_UI_VERSION` 都不会让引擎重新编译 → 服务端文件是新的、页面里没有这段代码。
- 修（E）：`mobile-ui-plugin/dsh-android-mobile/package.json` `1.0.0` → `1.0.1`；
  `MOBILE_UI_VERSION` `1.1.0-197` → `1.1.0-198`。
- 证（A）：`lib/index.js`（host half）启动时打印
  `[dsh-adb] host half: client.js=<路径> bytes=<字节> pkgVersion=1.0.1` → 引擎日志可直接核对。

### 运维
- 版本 `0.2.2-rc.5-debug.13` / vc98。

## [0.2.2-rc.5-debug.12] — 2026-11-22
vc=97

### 「基础权限」卡：位置纠正 + 一条落盘诊断
- 位置：从「当前状态」卡上方挪到**下方**、`S.stack` 首位（Shizuku / ADB / root 标签行之上），与截图标注一致。
- 诊断：`readBasicPerm` 里加 `bridge.pageDiag("基础权限 base=<typeof> state=<raw>")`：
  - `base=function state={…}` → 桥正常，问题在前端缓存；
  - `base=undefined` → 桥没注入；
  - 一行都没有 → 页面跑的还是旧 JS。
- mobile-ui `1.1.0-196` → `1.1.0-197`。

### 运维
- 版本 `0.2.2-rc.5-debug.12` / vc97；缓存策略待定（本轮不动缓存）。

## [0.2.2-rc.5-debug.11] — 2026-11-22
vc=96

### 「特权权限」页新增「基础权限」卡（5 项）
- 原生：`PageBridge.basicPermState()` / `basicPermOpen(kind)`；`MainActivity` 实现
  存储、悬浮窗、电池优化豁免、通知、无障碍五项状态与对应系统页跳转（`Environment.isExternalStorageManager`、
  `canDrawOverlays`、`isIgnoringBatteryOptimizations`、`areNotificationsEnabled`、`ENABLED_ACCESSIBILITY_SERVICES`）。
- 页面：`mobile-ui` 在「特权权限」分节**顶部**渲染该卡；未授权行右侧「去开启」直接跳系统页，
  回到页面（`focus` / `visibilitychange`）自动重取状态。
- gecko 内核：`dispatchInvoke` 白名单**刻意未加**这两条 → 该卡在 gecko 上安静不显示（不误导、不报错）。
- mobile-ui 版本 `1.1.0-195` → `1.1.0-196`。

### P4（免 proot 直启）：**冻结**
- 三条路全部真机验过（`docs/plan/perf-incremental.md` §7.6 / §7.7）：
  rootfs loader → error=13；jniLib loader + rootfs glibc → loader 秒退；
  第三条需整套 glibc 进 jniLibs + `patch-dynstr`，成本 ≈ 再造一个 proot 级工程。
- 结论：**收益 26 s 不值得这份长期维护成本**，数据留档，主线转向 P1/P2。

### 运维
- 版本 `0.2.2-rc.5-debug.11` / vc96。

## [0.2.2-rc.5-debug.10] — 2026-11-22
vc=95

### P4-a′ 修复：direct 刚 spawn 就被误判「未就绪」（3 ms）
- 现象（vc94 真机）：`direct.spawn argv0=…/lib/arm64/libld-linux.so`（**exec 权限已过**），
  紧接着 `direct 未就绪（alive=true, 3 ms），回退 proot`。
- 根因：回退判断用的 `awaitToken()` 等的是**实例级** `readyOrEof` latch；同一 host 上一个
  `startCommand`（proot 探测命令）的 drain 线程 EOF 时 countDown 了它 → 新 direct 进程刚起就被判成
  「已就绪但没 token」。
- 修法：direct 分支改为**独立轮询** `tokenUrl` + `process.isAlive`（50 ms 一跳），不再依赖共享 latch。

### 运维
- 版本 `0.2.2-rc.5-debug.10` / vc95。

## [0.2.2-rc.5-debug.9] — 2026-11-22
vc=94

### P4-a′：loader 迁入 jniLibs（绕开 untrusted_app 的 exec 禁令）
- 根因（vc93 真机）：App 进程 execve rootfs 里的 `ld-linux-aarch64.so.1` → `error=13, Permission denied`；
  同机同 uid 的 `run-as` 探针却能跑，**差别只在 SELinux 域**（Android 10+ 不让 `untrusted_app`
  执行 app data 目录里的文件）。
- 做法：`build-runtime.sh` 把 rootfs 里的 loader 另存一份到 `jniLibs/<abi>/libld-linux.so`
  （203,968 B，APK 仅 +0.2 MB）；`DirectLaunch.loaderPath()` 改为**优先**取
  `nativeLibraryDir/libld-linux.so`，rootfs 那份只留给探针。
- 原理：loader 是**解释器** —— 内核只 execve 它，`node` 由它 mmap 加载，因此 node 继续留在
  rootfs（123 MB 不进 APK），也不会触发对 node 的 execve 检查。
- 判据：`launch: direct=on` → `direct=on token ready in N ms` → `engine.ready runtime=direct`（health=401）。

### 运维
- 版本 `0.2.2-rc.5-debug.9` / vc94；`files/direct-enabled` 开关语义不变（默认关）。

## [0.2.2-rc.5-debug.8] — 2026-11-22
vc=93

### P4-a 修复：direct 路径必须可观测
- vc92 的 direct 日志走 `android.util.Log`（只进 logcat，被系统缓冲冲掉）——真机复测时「direct=on 之后一片空白」，原因就是**日志不可见**而不是没跑。现改为 `DshLog` 落盘（8 处）。
- 新增 `direct.spawn pid=… argv0=…`（`ProcPid.of` 取不到 pid 时显示 `?`）。
- direct 分支补 `ensureGuestNetworkConfig()`：不走 proot 的 bind，也同样要可用的 `resolv.conf` / `hosts`。
- 修掉一处 Kotlin 编译隐患：字符串模板里内嵌 `"?"` 是非法的，改成字符串拼接。

### 运维
- 版本 `0.2.2-rc.5-debug.8` / vc93；`files/direct-enabled` 开关语义不变（默认关）。

## [0.2.2-rc.5-debug.7] — 2026-11-22
vc=92

### P4-a：direct（免 proot）直启落地 —— **默认关，需开关**
- 新增 `runtime/DirectLaunch.kt`（149 行，纯 JVM）：`enabled / failed / markFailed / loaderPath / unavailable / plan`。
- `ProotHost`：`launch()` 新增 direct 分支（仅 `profile=web` 且 `command=null`）；`spawnDirect()` 用
  `ld-linux-*.so.* --library-path … node …/bin.js --profile web [--patch …] web --host 127.0.0.1 --port 0 --no-open`。
- `start()` 新增回退：25 s 宽限内拿不到 token 行 → `destroyForcibly` + 写
  `files/direct-failed-<runtimeVersion>` + 重走 proot（同一 runtime 不再试）。
- 三道闸：`files/direct-enabled` 存在才尝试；失败标记按 runtimeVersion 固化；工具命令（`startCommand`）恒走 proot。
- 埋点：`launch: direct=on …` / `direct=off reason=…` / `direct=on token ready in N ms` /
  `direct 未就绪（alive=…），回退 proot`；`engine.ready` 的 `runtime` 字段与事件名按实际取值（`direct`/`proot`）。
- 依据：真机探针 loader 直起 node 到 `dsh web:` **6.5 s**，proot 同口径 **32.6 s**（`docs/plan/perf-incremental.md` §7）。

### 运维
- 版本 `0.2.2-rc.5-debug.7` / vc92。

## [0.2.2-rc.5-debug.6] — 2026-11-22
vc=91

### P3-c：解包进度单调（显示层 bug，vc89 引入）
- 现象：进度条在 **3X% 与 6X% 之间反复横跳**。
- 原因：`installParts` 四线程各自回报「已完成片之和 + **本线程**片内 `pr.done`」，线程交替上报时两个量互相打架。
- 修法：每线程只把自己片内的**增量**累进共享 `AtomicLong`（并补尾部余量）；`EngineManager` 再把百分比夹成**单调不减**。
- 影响面：**仅显示**，不影响解包结果与启动。

### 运行日志界面：上滚不再被拽回底部
- 现象：`LogViewerActivity` 每 2 s 刷新一次，刷新即 `setSelection(最后一条)`，用户翻历史时被反复拉回最新。
- 修法：刷新前记 `wasAtBottom` 与锚点（`firstVisiblePosition` + 首行 `top`）；**原本在底部**才继续跟随，否则 `setSelectionFromTop` 把那一行钉回原位。
- 配套：`LogAdapter.hasStableIds() = true`（`getItemId` 已是 `seq`），插入新行时历史行不串位。

### 运维
- 版本 `0.2.2-rc.5-debug.6` / vc91。

## [0.2.2-rc.5-debug.5] — 2026-11-22
vc=90
### P3-bis：减条目（并行解包没达预期的正解）
- 实测：分片四线程只把解包从 **85.6 s → 77.4 s**（-9.6%）——瓶颈是设备的小文件元数据吞吐，加线程无效。
- 改为删「运行时永不需要」的文件：`.d.ts`/`.d.mts`/`.d.cts` **16,196 个 / 51.3 MB**，包内 `src/**/*.ts` **12,147 个 / 115.3 MB**（两者占 `node_modules` 条目 **37%**）。
- 风险：node 只加载 `lib/*.js`（`.ts` 需 loader，`.d.ts` 只是类型）；sourcemap 已在更早的 prune 阶段删除。

### P-7 补完
- `deleteTree` 再加 `visitFileFailed` 兜底：不可遍历/不可读的目录不再让整次清扫失败。

### 运维
- `profiles/web/package.json` 里残留的 `dsh-open-market` / `dshmarket` bundle 引用已清除（未安装 → 每次启动刷两条 warning）；市场入口仍由 `market.patch.yml` 的 `dsh-android-market` 提供。
## [0.2.2-rc.5-debug.4] — 2026-11-22
vc=89
### P3：分片并行解包
- 构建期按顶层目录切 4 片：`rootfs-arm64-v8a.tar.xz`（./opt，88% 条目）+ `rootfs-part1`（./usr）+ `rootfs-part2`（./var ./etc）+ `rootfs-part3`（其余顶层）；manifest 新增 `rootfsParts[]`。
- 运行期：`RootfsInstaller.installParts()` 四线程并行解到同一 staging（单片失败即整体失败，单片回退仍走原单包路径）；日志 `stage copy(parts=…)` / `stage extract(parts=…)`。
- 依据：单 tar 流是顺序的，无法并行；实测单线程解 7.5 万文件 85.6 s，CPU 只占 11%。

### P-7：旧 rootfs 清不掉
- `RuntimeFiles.deleteTree()` 现在 `preVisitDirectory` 里先 `chmod u+w+x`，并对单个文件的删除失败做兜底重试；`postVisitDirectory` 不再抛错。
- 原因：rootfs 里有 0555 目录（如 `/system`），删除其子项需要目录可写，否则 `AccessDeniedException` 会让整次清扫失败、残留 `rootfs.old-*`。
## [0.2.2-rc.5-debug.3] — 2026-11-22
vc=88
### 修复
- **P0 埋点落盘**：`RootfsInstaller` 用的是 `android.util.Log`（只进 logcat），而 app.log 只收 `DshLog` → vc87 的三段埋点在日志里**看不到**。本版改为 `DshLog.i("DSH", ...)`，日志与诊断包可直接读到 `stage copy / stage sha256 / stage extract`。

### 附带实测（vc87 → vc88 基线）
- APK **185.8 → 162.8 MB**（P-1 删除 apt 二进制缓存生效，`rootfs.tar.xz` 170.4 → 147.5 MB）。
- 首启（含重解）`engine.ready` **161,994 → 147,052 ms**（-15 s，copy 少 23 MB、写盘少 100 MB）。
- 已知遗留：`files/runtime/rootfs.old-*` 清理失败会在日志里报 `启动清扫失败`（体积很小但目录残留），留待 P6 双槽方案一并收。
## [0.2.2-rc.5-debug.2] — 2026-11-22
vc=87
### 优化（首刀：零架构变更）
- **P-1 免费赎身**：`tools/runtime/build-runtime.sh` 的 prune 补删 `var/cache/apt/pkgcache.bin` 与 `srcpkgcache.bin`（各 50 MB 原始 / 11 MB xz，合计 22 MB = rootfs.tar.xz 的 12.4%）→ rootfs 与 APK 各约 **-22 MB**。
- **P0 启动埋点**：`RootfsInstaller.ensureLocked` 新增三段日志 —— `stage copy: <bytes> in <ms>`、`stage sha256: <ms>`、`stage extract: <ms>`；配合已有的 `engine.ready` / `loadEvent` / `notifyUiReady`，启动链初次可分段度量。

### 为什么现在才加（实测依据）
- 设备解包 **106 s**，而同一台机上 `xz -dc` 全量解压仅 **11.7 s**、顺序写 1.2 GB 仅 **12.7 s** → CPU 只占约 11%，瓶颈是 **75,624 个文件的逐文件创建**（`opt/dsh` 58 88% 条目 / 57% 体积）。
- rc.3 → rc.5 两版 tar 仅差 **20,480 B**、**新增 0 文件 / 修改 390 文件 / 内容相同 90.60%**，其中 **100.38 MB** 是 apt 缓存 → 删掉后真实差异仅 **6.67 MB**。
## [0.2.2-rc.5-debug] — 2026-11-22
vc=86
### 引擎升级（`0.2.2-rc.3` → `0.2.2-rc.5`）
- 引擎 `@deepseek-ai/dsh` **0.2.2-rc.5**；node `24.22.1` / pnpm `11.28.5` 与 rc.5 的 `engines` 要求一致；`native/` 侧 **0 变化**。
- 补丁：6 个 patch 对 rc.5 **全部可原样套用**（4 个包 `lib` 逐字节相同，`dsh-llm` 仅 1 行偏移自动吸收）；`pins.json` 新增 `0.2.2-rc.5` 节。
- `apk.yml` 删除写死的 `DSH_VERSION`，引擎版本**只由 `tools/engine-version.txt` 单一来源提供**；`REL_TAG` → `v0.2.2-rc.5-debug`。
- `sign-upgrade-apk.yml` 的 runtimeVersion 断言 → `dsh0.2.2-rc.5-`。

### rc.5 能力增量（引擎层全量继承）
- **web 搜索自动路由**：DeepSeek 模型会话走旧版 Messages 搜索（不计次费，按 token 计费，日志追加 `web/deepseek-search-llm-request`），其他路由走 DeepSeek Search API。
- LLM 错误分类（`dsh-llm/src/error.ts`）与 DeepSeek 翻译层（`llm-deepseek/src/translate.ts`）。
- 插件 API 目录（`tool-cordis` api-catalog）。
- 官方 `docs/upgrade-guide` 仅覆盖到 `v0.2.2-rc.4`；rc.5 无破坏性变更说明。

### 已知
- 引擎版本变化会让 `runtimeVersion`（含 `runtime/patches` 全部文件 sha）变化 ⇒ **升级后必重解一次 rootfs（~110 s）**，`files/home/.dsh` 与会话不受影响。

## [0.2.2-rc.3] — 2026-11-22
vc=85
### 重新发布（发布线重开）
- **内容等于 `0.4.1`**（单宿主 PRoot / targetSdk 35 / 包名 `com.dsh.android` / 引擎 `@deepseek-ai/dsh@0.2.2-rc.3`），仅**改名重发**；
- versionName **0.2.2-rc.3** / versionCode **85**；与 `0.4.1`（vc84）同签名，可覆盖安装；
- 发布线收敛：Release 只保留 `v0.2.2-rc.1` / `v0.4.2` / `v0.4.3` / `v0.2.2-rc.3`，其余 26 个历史 Release 与 tag 已删除；
- `v0.4.1` 已从 Release 下线，本机 `/sdcard/Download/dsh-rc3/upgrade/r041b.apk` 为唯一副本。
### 已知
- 历史 `0.2.2-rc.3`（vc54）已下线，同名 tag 重建指向本次提交（vc85）。

## [0.4.1] — 2026-11-22
vc=84

### 包名回到 `com.dsh.android`（新包名 `io.github.ccch1mneyyy.dsh` 不再使用）

| 项 | 0.3.x | 0.4.1 |
|---|---|---|
| system `applicationId` | `io.github.ccch1mneyyy.dsh` | **`com.dsh.android`** |
| gecko `applicationId` | `io.github.ccch1mneyyy.dsh.webview` | **`com.dsh.android.webview`** |
| `namespace` | `com.dsh.android` | 不变 |

**为什么能这样切**：包名与 targetSdk、与单运行时重构完全解耦 —— 只改 `applicationId`，
代码与运行时一处都不用动。

**代价（必须知道）**
- 覆盖安装要求「同包名 + **同签名**」。历史旧包若不是本仓库证书（`79d0dab6…dc96`）签的，
  装的时候仍会 `UPDATE_INCOMPATIBLE` —— 必须先「导出 → 卸载 → 安装 → 导入」。
- 0.3.x 的数据在 `/data/data/io.github.ccch1mneyyy.dsh/`，要导回：
  **迁移向导已改为检测该包名**，提示三步走。
- `KNOWN_PACKAGES` 仍含 4 个 id，导出→导入两个方向都通。

### 同步
- `tools/` 下开发脚本与 `mockall*.patch.yml` 的包名一并切回；
- `docs/agents/constraints.md` 记录决定与代价。

> 版本号选 `0.4.1` 而不是 `0.4.0`：`CHANGELOG` 里已存在历史上的 `## [0.4.0] — 2026-10-23`，避免重名。

## [0.3.6] — 2026-11-22
vc=83

### 迁移向导文案跟着**存储态**走
`0.3.3` 的向导只说「打开旧版导出」，但没说导出会落到哪 ——
在未授予「所有文件访问」时，备份落在 `Android/data/<包名>/files/Download`，
**卸载旧包会把它一起删**（`.14` 的坑）。

现在向导分两种文案：

| 存储态 | 第 ① 步文案 |
|---|---|
| 已授予所有文件访问 | 打开旧版 →「导出数据」（会存到 `/sdcard/Download`，卸载不删） |
| 未授予 | 先在本版授予「所有文件访问」再导出；否则备份会落在 `Android/data` 下，卸载旧包会一起删 |

### 文档
`docs/agents/constraints.md` 新增「**包名可以回退，但要算清代价**」：
覆盖安装要求「同包名 + 同签名」；回退包名等于让 `0.3.x` 用户的数据再迁移一次
（`KNOWN_PACKAGES` 已支持 4 个 id 双向导入）。

### 判据
```text
未授予（默认）：urandom 触发向导 → 第①步含「先在本版授予「所有文件访问」」
已授予：        第①步为「会存到 /sdcard/Download，卸载不删」
```

## [0.3.5] — 2026-11-22
vc=82

### 修复：导出的备份可能落进「卸载即删」的私有目录
`LogContext.publicExportDirOrNull()` 用 `WRITE_EXTERNAL_STORAGE` 判定能否写公共 Downloads ——
但 targetSdk ≥ 29 且无 legacy 时，该权限在系统侧**恒为未授予**（本机实测 `granted=false`）。
于是导出**永远**退到 `Android/data/<包名>/files/Download`，卸载/清数据即被删 ——
这正是「备份随卸载消失」的真实成因。

**改法**
- API 30+ 用 `Environment.isExternalStorageManager()`（「所有文件访问」）判定；
  低于 30 保留旧的 `WRITE_EXTERNAL_STORAGE` 判定。
- 落点打一行日志：`导出落点：公共 Download…` / `导出落点：私有目录 <path>（卸载会删）`。
- 启动时打 `存储态：isExternalStorageManager=true/false`，并注明 guest 的 `/sdcard`
  是真手机存储还是 app 私有副本。

### 判据
```text
未授予：日志「存储态：… false（guest /sdcard = app 私有副本）」
        导出 → 「导出落点：私有目录 …（卸载会删）」
已授予：日志「… true（guest /sdcard = 真手机存储）」
        导出 → 「导出落点：公共 Download」，文件在 /sdcard/Download
```

## [0.3.4] — 2026-11-22
vc=81

### 修复：设置 → 开发环境 显示「无法获取状态（引擎插件未激活？）」
**根因**（P4 换包名 + P3 去 Termux 的两处遗留叠加）：

1. 宿主 `ProotHost` **从未注入 `DSH_FILES`**；
2. 插件 `mobile-ui` 的兜底常量写死了旧包名 `com.dsh.android`。

于是插件拼出的 `/data/user/0/com.dsh.android/files/dsh-env.mjs` 根本不存在，
`spawn` 失败 → 返回 null → UI 显示「无法获取状态」。

**真机对照**：在 guest 内直接跑 `dsh-env.mjs status --json` 是**成功**的
（`exit=0`，返回完整 JSON，`builtin.node=v24.22.1`、`totalMb=363`）——
说明脚本本身没问题，纯粹是插件定位不到它。

**改法**
- `ProotHost` 注入 `DSH_FILES=<filesDir canonicalPath>`；
- 插件兜底改为 `DSH_FILES → dirname(dirname(DSH_HOME)) → cwd`，
  并删除 `termux/usr/bin/node` 分支（P3 之后那条路已不存在）。

### 工程化（B）
`publish-apk.yml` 增加 **versionCode 严格递增**校验：与上一个正式 release 比较，
不递增直接失败（防止旧版本被重新打 tag 覆盖线上产物）。读不到历史值时跳过，不阻塞首发布。

### 文档（R3）
`docs/agents/verification.md` 顶部加「历史文档（0.3.0 起不适用）」标注 ——
bionic / Termux 双宿主时代的验收步骤已在 P2/P3 删除，只作历史对照。

### 判据
```text
设置 → 开发环境：能看到 6 组（Node/Python/SSH/Java/Rust/Go）与「已用 N MB」
日志不再出现 `devenv status 失败`
```

## [0.3.3] — 2026-11-22
vc=80

### 新增：迁移向导（换包名不再「静默丢数据」）
P4 换包名后，旧包 `com.dsh.android` 与本版是**两个独立应用**：数据不通用，
卸载旧包会带走它的会话/凭据/引擎数据 —— 而此前界面上**没有任何提示**。

启动时检测旧包是否还在，在且本版**还没有会话数据**时弹一次三步向导：

```text
① 打开旧版 →「导出数据」
② 回到本版 →「导入数据」选刚导出的 zip
③ 确认会话都在，再卸载旧版
```

按钮：`打开旧版` / `稍后` / `不再提示`（后者写 `dsh_migration.dismissed`）。
本版已有 `home/.dsh/sessions` 时直接跳过，不打扰已迁移完成的用户。

### 调试入口（验收用）
```bash
adb shell am start -n io.github.ccch1mneyyy.dsh/com.dsh.android.MainActivity \
  -a com.dsh.android.action.MIGRATION_HINT --ez force true
```

### 判据
```text
有旧包 → 启动即弹「检测到旧版 DSH」，日志 migration 相关行
无旧包 → 不弹（绝大多数用户）
本版已有会话 → 不弹（日志「迁移向导跳过：本版已有会话数据」）
```

## [0.3.2] — 2026-11-22
vc=79

### 新增：全面屏有了用户入口（桌面长按快捷方式）
在此之前 `fullscreen` **只能**由模型调 `statusbar` 工具开启，用户想自己切一下没有任何
入口。现在长按桌面图标有两个动作：

```text
全面屏：开   → SystemBarAppearance.fullscreen = true
全面屏：关   → false
```

等价的命令行（验收用，也可自动化）：

```bash
adb shell am start -a com.dsh.android.action.FULLSCREEN \
  -n io.github.ccch1mneyyy.dsh/com.dsh.android.MainActivity --ez enable true
```

实现：`res/xml/shortcuts.xml` 两个 shortcut（`singleTask` 下走 `onNewIntent`）→
`MainActivity.handleFullscreenIntent()` → `SystemBarAppearance.apply(...)`，
与 `statusbar` 工具改的是**同一个字段**（会落盘、重启仍生效）。

### 判据
```text
am start -a com.dsh.android.action.FULLSCREEN … --ez enable true
  → 日志「快捷方式：全面屏=true」+「内容让位：top=0」
--ez enable false
  → 「内容让位：top=<状态栏高度>」
```

## [0.3.1] — 2026-11-22
vc=78

### edge-to-edge 加固
- 顶部让位改为 `systemBars() or displayCutout()` 的**并集**：只取 `systemBars()` 时，
  挖孔/刘海机型上状态栏高度可能小于安全区，页面标题会钻进孔里。
- 键盘：`ime()` 高度变化时打一行日志（`键盘弹出：ime=…px，底部让位=…` / `键盘收起`），
  真机上不接电脑也能从日志判读让位是否正确。

### 文档
- `docs/plan/…`：补「旧包 `com.dsh.android` 消失」的**归因结论** —— 用户手动卸载，
  与本工程清理逻辑无关（`purgeLegacy` 只动 `files/` 内 runtime 目录，从不 `pm uninstall`）。
  同时固化「换包名 = 新安装、旧数据不继承，删旧包前必须先导出」。
- `docs/agents/constraints.md`：insets 取并集的规则 + 键盘日志约定。

### 判据
```text
grep "键盘弹出" app.log   → ime>0 时出现一行，且底部让位 = ime（≥ 导航栏高度）
挖孔机：内容顶边 ≥ 挖孔安全区高度
```

## [0.3.0] — 2026-11-22
vc=77

**首个正式版**：`0.2.2-rc.1` 的 Android 移植完成单运行时架构重构后的定版。
预发布线 `0.3.0-refactor.0` … `0.3.0-refactor.21` 的改动全部收在本版内。

### 架构（P0–P6）

| 阶段 | 结果 |
|---|---|
| P0 | 基线快照（111 文件 / 3.2 MB + SHA256SUMS） |
| P1 | `libproot.so` / `libproot-loader.so` / `libtalloc.so` / `libandroid-shmem.so` 收进 jniLibs；`.dynstr` 等长原位改写（`patch-dynstr.py`），不用 patchelf |
| P2 | 单宿主化：删 `EngineHosts` / `TermuxBionicHost` / `ProotGlbcHost` / `EngineBootGate`（全零调用方） |
| P3 | 运行时去 Termux：13 处 `IS_PROOT` 双分支、`$PREFIX` 候选、三个前缀修补函数全删；`purgeLegacy`（删而不归档）+ `swapIn` 启动清扫 |
| P4 | 包名 `com.dsh.android` → `io.github.ccch1mneyyy.dsh`（只改 `applicationId`，`namespace` 不动） |
| P5 | targetSdk 29 → 30 → 34，逐档真机验；根治「`/data/user/0` 与 `/data/data` 两套前缀」 |
| P6 | bionic 出包链清零（`android-release.yml` / 7 个构建脚本 / `bootstrap-required.txt`）；引擎版本改单一来源 `tools/engine-version.txt` |

### 能力与修复

- **targetSdk 35**：系统强制 edge-to-edge，改用 `setDecorFitsSystemWindows(false)` +
  真实 `WindowInsets` 让位（`webContainer` padding），系统栏区域底色由 window 背景提供。
- **解包进度可见**：`State.Extracting` 接线（copy 0–30% / extract 30–98%）、
  `.xz` 已读字节做分母、通知权限推迟到 `UiStage.UiReady`（不再遮住进度）。
- **冷启 `HTTP=-1`**：健康探测改 20 s 窗口重试，失败文案带「试了 N 次 / 最后错误」。
- **工作区选择器**：`$HOME` 由宿主注入 `filesDir/home`、`home` 整体 bind、
  `/root` 下建兼容入口 —— 对话框可见「手机存储 / 下载 / 应用目录」三行并可进入。
- **数据迁移**：换包名后导出→清数据→导入实测通过；`exportResultText` 新增
  「卸载或清除数据会一起删掉备份」告警。

### 真机判据（全部实测）

```text
冷启          engine.ready × 3 连跑，engine.failed = 0
edge-to-edge  内容让位 top=152 == dumpsys statusBars [0,0][1280,152]
全面屏        top=0，--dsh-android-system-top = 47px（=152/3.2）
解包进度      10%→30%(copy)→40→52→61→74→80→93→100%，112.5 s 到 ready
选择器        ENTER_OK 手机存储=67 / 下载=32 / 应用目录=13
```

## [0.3.0-refactor.21] — 2026-11-22
vc=76

### targetSdk 35：edge-to-edge 改造（系统强制，必须自己让位）
API 35 起：`decorFitsSystemWindows` 恒为 false，`statusBarColor`/`navigationBarColor`
的赋值**被忽略**。原实现依赖「系统自动避开系统栏」，失效后表现为标题被时钟压住。

**改法**
- `MainActivity.enableEdgeToEdgeCompat()`：`setDecorFitsSystemWindows(false)` +
  `setOnApplyWindowInsetsListener(binding.root)`，`systemBars()` / `ime()` 的真实 insets
  落到 `webContainer` 的 padding；**全面屏时让位为 0**。
- 系统栏区域颜色改由 **window 背景** 提供（`applyPageBackground` 的 `setBackgroundDrawable`）。
- `statusBarHeightPx()` 首选运行期 `insetTopPx`（根治 vc19「整行下移」的物理/CSS 像素混用）。
- 键盘走 `ime` inset（edge-to-edge 下 `adjustResize` 不生效）。

### 判据
```text
内容顶边 y == 状态栏高度；全面屏时 == 0
键盘弹出：内容上移，输入框不被遮挡
```

## [0.3.0-refactor.20] — 2026-11-21
vc=75

### 修复（第三层，最终）：引擎进程的 `$HOME` 一直是 `/root`
vc74 截图：对话框路径框写着 **`/root/`**、下面空。查 `/proc/<proot pid>/cmdline`：

```text
HOME=/root
DSH_USER_HOME=/data/data/io.github.ccch1mneyyy.dsh/files/home
```

**根因**：`runtime/manifest.json` 的 `launch.argv` 是

```text
/usr/bin/env -i HOME=/root USER=root … DSH_HOME=/root/.dsh … {GUEST_ENV}
```

`env -i` 之后逐条 `KEY=VALUE` **后者覆盖前者**。`DSH_HOME` 早就在 `{GUEST_ENV}` 里
覆盖了（所以会话/凭据一直在 `files/home/.dsh`，没丢），但 **`HOME` 从没被覆盖** ——
引擎进程的 `$HOME` 始终是 `/root`；`dsh-env.mjs` 只影响它 spawn 的子进程。

**改法**
1. `ProotHost` 的 `{GUEST_ENV}` 里补 `HOME=<filesDir/home>`。
2. 兼容层：客户端把上次浏览路径记在 localStorage，老用户升级后**仍会跳 `/root`**，
   所以在 `rootfs/root` 下也建同一组入口（`手机存储 / 下载 / 应用目录`），每次启动重建。

### 判据
```text
/proc/<pid>/environ 里 HOME=/data/data/<pkg>/files/home
对话框（无论从 /root 还是 files/home 进）都能看到三行入口
```

## [0.3.0-refactor.19] — 2026-11-21
vc=74

### 修复（续）：选择器起点正确了，但目录里**只有 .dsh**
vc73 把 `HOME` 改成 `filesDir/home`，探针（`ProotProbeActivity` 内跑 node）实测：

```text
os.homedir=/root                                   ← 探针进程本身，不经过 dsh-env
DSH_USER_HOME=/data/data/<pkg>/files/home
probe root=/data/data/<pkg>/files/home
.dsh dir=true link=false  enterable=true          ← 只有 .dsh！
```

**根因**：`ProotHost` 只绑了 `home/.dsh` 与 `files` 的**别名**（`/data/user/0/...`），
`/data/data/<pkg>/files` 在 guest 内只是 proot 为 bind 目标凑出来的**骨架目录**，
所以 `files/home` 里只剩 `.dsh`，三个入口链接（手机存储/下载/应用目录）全部不可见。

**改法**：`ProotHost` 显式 `bind(filesDir/home)`，让 canonical 侧的 `home` 也是**真目录**。

### 判据（探针）
```text
.dsh / 下载 / 应用目录 / 手机存储 四行，全部 enterable=true
ENTER_OK 手机存储 entries=...   ENTER_OK 下载 entries=...
```

## [0.3.0-refactor.18] — 2026-11-21
vc=73

### 修复：新建工作区对话框里**一行都没有**
**现象**（vc72 真机截图）：点「新建工作区」→「选择工作区目录」，标题是「主目录」，
下面**空白**，看不到「手机存储 / 下载 / 应用目录」。

**根因**：`dsh-host-directory-picker-auto` 的 browse 后端在没给路径时用 `homedir()` 当起点。
`dsh-env.mjs` 在 P3（`refactor.3`，清退 Termux）时把 `HOME` 硬编码成 rootfs 的 **`/root`**，
而入口链接建在 **`filesDir/home`** —— 起点走错了树，列表自然为空。

**改法**
- `ProotHost` 注入 `DSH_USER_HOME = filesDir/home`（canonicalPath，guest 内可见）。
- `dsh-env.mjs` 的 `HOME` 改为读 `DSH_USER_HOME`，兜底 `/root`。
- `docs/agents/constraints.md` 记下「`$HOME` 必须是 filesDir/home」。

### 判据
```text
对话框打开即列出「手机存储 / 下载 / 应用目录」三行
点「手机存储」可逐级进入并新建文件夹
```

## [0.3.0-refactor.17] — 2026-11-21
vc=72

### 可观测性：解包进度每 10% 记一行日志
真机验收时设备可能处于锁屏/息屏（AOD），uiautomator 抓不到界面。为了让「进度是否在推进」
可被**离线证据**证明（也方便用户报「卡住」时定位卡在 copy 还是 extract），
`EngineManager` 在进度回调里每跨 10% 打一行：

```text
runtime progress 30% (extract)
runtime progress 40% (extract)
...
```

### 判据
```text
pm clear → 启动 → grep "runtime progress" app.log
应看到 0/10/…/90/100 递增，且 phase 从 copy 过渡到 extract
```

## [0.3.0-refactor.16] — 2026-11-21
vc=71

### 修复（续）：解包进度仍看不见 —— 真因是**通知权限弹窗盖住了**
vc70 把进度接到了 `State.Extracting`，但真机复测仍然看不到百分比：
`POST_NOTIFICATIONS` 是在 `ensureStorageAccess()` 里、**解包开始之前**申请的，
系统弹窗（「允许"DSH"发送通知？」）停在整个解包过程之上 —— uiautomator 只能看到那个弹窗。

**改法**
- `storagePermissionLauncher` 回调里不再立刻申请通知权限（只记日志）。
- `ensureStorageAccess()` 的早返回路径同样不再申请。
- 新增幂等包装 `ensureNotificationAccessAfterUiReady()`，在 **`UiStage.UiReady`**（界面可用）时申请一次。

效果：解包全程只有 App 自己的覆盖层，`正在解包引擎 N%` 可见；权限弹窗出现在界面可用之后。

### 判据
```text
pm clear 后首启：解包期间 uiautomator 能读到「首次启动，正在解包引擎 N%」且 N 增长
界面可用后才出现通知权限弹窗
```

## [0.3.0-refactor.15] — 2026-11-21
vc=70

### 修复：解包时进度条消失 / 没有百分比
**根因**：`startProot()` 的 `installer.ensure(...)` 回调**只写日志**，从不更新 `State`；
`State.Extracting` 只被 0.5.0 之前的 bionic 解包路径使用。于是 PRoot 解包 1.3 GB 期间，
界面停在「正在启动引擎…」，用户看到的是「进度消失/卡死」。

**改法**
- `RootfsInstaller.extractXz()`：新增 `CountingInput` 统计 **.xz 已读字节**，把
  `Progress("extract", done, total)` 的 `total` 从 `-1` 改成真实压缩包长度。
- `EngineManager.startProot()`：按 **copy 0–30% / extract 30–98%** 加权，节流后写
  `State.Extracting(pct)`；解包结束立刻回到 `State.Starting`。

### 增强：新建工作区怎么选「其它文件夹」
`ensurePickerRoots()` 在 `filesDir/home` 下建三个入口链接：

```text
手机存储 → /sdcard
下载     → /sdcard/Download      ← 本次新增，最常用
应用目录 → filesDir
```

对话框起点是 HOME，点进去即可浏览；面包屑「主目录」返回。

### 判据
```text
清数据后首启：覆盖层出现「首次启动，正在解包引擎 N%」且 N 单调增长到 98→100
文件选择器里能看到「手机存储 / 下载 / 应用目录」三行
```

## [0.3.0-refactor.14] — 2026-11-21
vc=69

### 数据迁移演练（真机，新包 `io.github.ccch1mneyyy.dsh`）
流程：**导出 → `pm clear` 清数据 → 重新启动 → 导入 → 内容指纹核对**

| 阶段 | 实测 |
|---|---|
| 导出 | 2 个会话 + profiles/storages/skills，共 18 条目 / 56.0 KB；落点 `Android/data/<包名>/files/Download/dsh-backup-20261121-133626.zip` |
| 清数据 | `pm clear` Success；rootfs 与 `home/.dsh` 全清，重启后引擎自造 1 个新会话 `session-9aa04eb6…` |
| 导入 | 选 `dsh-backup-drill.zip` → 「开始恢复」 |
| 核对 | 会话目录恢复为 **`session-9bb9e914…` + `session-a97fddd5…`**（正是备份里那两个），`home/.dsh` 文件数回到 **89** |

### 演练暴露的真问题（本版修复）
`pm clear` 会**连 app 专属外部目录一起删**：第一次导出的两份 zip 在
`Android/data/<包名>/files/Download/` 里，清数据后全没了。

- `BackupDialog.exportResultText()`：当导出位置在 `Android/data/**` 或 `filesDir` 下时，Toast 追加
  「⚠️ 卸载或清除数据会一起删掉；建议先复制到「下载」/ 发给自己；授予「所有文件访问」后会直接写公共下载目录」。
- `docs/agents/constraints.md` 新增「数据备份位置」一节。

### 判据
```text
导出到 app 专属目录 → Toast 含「卸载或清除数据会一起删掉」
有全盘权限时 → 直接写公共 Download，无该提示
```

## [0.3.0-refactor.13] — 2026-11-21
vc=68

### 修复：冷启偶发「引擎就绪检查失败：HTTP=-1」
**现象**：安装后首次启动，引擎已打印 `dsh web <url>?token=…`，但紧接着的健康检查拿到 `HTTP=-1`，
整次启动被判失败（vc66 实测 59 s 时命中；第二次启动 13 s 正常出首帧）。

**根因**：就绪判定只做**一次** 3 s HTTP 探测。PRoot 里 node 的 `listen` 建立与 `accept` 队列就绪
之间有毫秒级间隙，单次探测正好撞上就得到 `-1`，而 `-1` 又不带原因，现场只剩一句「HTTP=-1」。

**改法**
- `ProotHost.healthProbe()` 取代 `health()`：返回 `(HTTP 码, 失败原因)`，`health()` 保留为薄包装。
- `EngineManager`：token 到达后按 **20 s 窗口 / 400 ms 间隔**重试探测；`!host.isAlive()` 立即停。
- 失败信息升级为：`HTTP=<code>（试了 N 次 / 20000ms 窗口；最后错误：<异常类型: 消息>）`。

### 判据
```text
冷启（force-stop 后首启）：引擎起 → 首帧，无 HTTP=-1 误判
人为把窗口压到 1ms 时：失败信息应包含「试了 N 次」「最后错误」
```

## [0.3.0-refactor.12] — 2026-11-21
vc=67

### 变更（P4：解除包名限制，换 applicationId）
- `applicationId`：`com.dsh.android` → **`io.github.ccch1mneyyy.dsh`**；gecko flavor → **`io.github.ccch1mneyyy.dsh.webview`**。
- **`namespace` 保持 `com.dsh.android`**：它是源码包（R / BuildConfig 的包），与安装包名无关；
  改它要搬几百个文件与全部 import，收益为零。
- `UserDataImporter.KNOWN_PACKAGES`：加入两个新 id，**保留两个旧 id** —— 老备份仍能导进来。
- 工具脚本默认包名同步：`apply-clickfix.sh`（可用 `PKG=` 覆盖）、`mcp-android-ui.mjs`、
  `dsh-sessions.sh`、`mockrun.sh`、`build-uiagent-screens.mjs`；mock 夹具里的插件绝对路径也一并改。
- 文档：`AGENTS.md` / `docs/agents/constraints.md` 的约束表新增包名一行。

### 数据迁移（换名 = 新安装，不继承）
1. 旧包（`com.dsh.android`）里：设置页 →「导出数据」，选会话/凭据/工作区，存到 `/sdcard/Download`
2. 安装新包（`io.github.ccch1mneyyy.dsh`）—— **两个包可以同时装着**，不冲突
3. 新包里：设置页 →「导入数据」，选刚才的归档；导入器会把归档里旧包名的绝对路径改写成新包名

### 判据
```text
aapt/dumpsys: 新包 applicationId = io.github.ccch1mneyyy.dsh，namespace 仍是 com.dsh.android
新包首启：解包 rootfs → 引擎起 → 首帧
旧包仍在、数据未动（可随时回退）
```

## [0.3.0-refactor.11] — 2026-11-21
vc=66

### 变更（P6 收尾第二批：删 bionic 构建脚本，version.sh 改单一来源）
- **`tools/version.sh`**：引擎版本不再从四个 bionic 脚本里 `sed`，改为读 **`tools/engine-version.txt`** 单一来源；
  `verify-engine-upgrade.sh` 的断言串若还在就作交叉校验（不一致才报错）。汇总行改用 `ENG_SRC`。
- **删除 7 个 bionic 构建脚本**（0.5.0 单运行时后不产出任何东西，`apk.yml` 也不执行它们）：
  `build-engine-bin.sh`、`build-native-assets.sh`、`build-node-pty.sh`、`build-extra-native.sh`、
  `build-node-addon-system.sh`、`build-node-addon-require-builtin.sh`、`node-runtime-wrap.sh`。
- `apk.yml`：去掉这 7 个脚本的路径触发。
- `EngineManager`：注释里「由 `tools/build-engine-bin.sh` 生成」改为历史说明。

### 判据
```text
tools/version.sh --check → VERSION PASS，且多出一行「引擎版本单一来源 0.2.2-rc.3」
grep -rn "build-engine-bin|build-node-runtime|build-bootstrap" tools .github  → 0
apk.yml 全绿，装机后引擎照常起
```

## [0.3.0-refactor.10] — 2026-11-21
vc=65

### 变更（P6 收尾第一批：清 bionic 出包链）
- **删除** `.github/workflows/android-release.yml`：0.5.0 之前的 bionic 出包链，会现场造
  `bootstrap-aarch64.zip` 并断言它在 APK 里，与当前单运行时无关（且只手动触发，从不随 tag 跑）。
- **删除** `tools/build-bootstrap.sh`、`tools/bootstrap-required.txt`。
- `tools/check-apk-assets.py`：去掉 bootstrap 的 soname 深检（连同 `required_sonames()`）。
- `tools/ci-fetch-assets.sh`：`REQUIRED` 去掉 `bootstrap-aarch64.zip`。
- `tools/verify-ci.py`：默认查询的工作流 `android-release` → `apk`。
- `docs/agents/release-signing.md`：CI 段改写为现行三段式（apk → sign → publish），并说明旧链已删。

### 判据
```text
grep -rn "bootstrap" .github tools app/build.gradle.kts  → 只剩历史文档
apk.yml / verify.py / check-apk-assets.py 全绿
```

### 已知（下一批）
- 仍有 bionic 期构建脚本：`build-engine-bin.sh` / `build-node-runtime.sh` / `build-native-assets.sh`
  / `build-node-pty.sh` / `build-extra-native.sh` / `build-node-addon-*.sh`。
  它们与 `tools/version.sh` 有耦合（version.sh 会从 `build-engine-bin.sh` 等抓引擎版本串做一致性校验），
  删除必须同时改 `version.sh`，因此单独一批处理。

## [0.3.0-refactor.9] — 2026-11-21
vc=64

### 变更（P5 第三档：targetSdk 30 → 34）
- `targetSdk = 34`（P5 最后一档）。
- `EngineService`：API 34+ 改用三参 `startForeground(..., FOREGROUND_SERVICE_TYPE_SPECIAL_USE)`，
  与 manifest 的 `foregroundServiceType="specialUse"` + `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` 对齐。
- `AndroidManifest.xml`：新增 `<queries><package android:name="moe.shizuku.privileged.api"/></queries>`
  —— targetSdk 30+ 的包可见性会让 `getPackageInfo` 抛 NameNotFound，Shizuku 特权通道会静默降级。
- 检查结论（本档无需改动）：`PendingIntent` 已全部带 `FLAG_IMMUTABLE`（AdbPairing 的可变那条带 `FLAG_MUTABLE`）；
  所有组件 `android:exported` 都已显式声明；全仓无 `registerReceiver`（34 的 receiver 导出标志要求不触发）。

### 判据
```text
装机 targetSdk=34
引擎起（token + 首帧）；前台服务通知在
Shizuku 桥仍就绪（log：Shizuku 桥已就绪）
无 EACCES / avc: denied / MissingForegroundServiceType
```

### 已知
- 35（edge-to-edge 强制）**没做**：`SystemBarAppearance` 有 vc19 回归史，作为独立议题排期。
- 下一步是 P4（包名）与 P6（收尾）。

## [0.3.0-refactor.8] — 2026-11-21
vc=63

### 修复（vc61/vc62 引擎起不来的完整根因）
两套前缀不一致，guest 里只存在一种：

```text
File.absolutePath  = /data/user/0/com.dsh.android/files/...   ← assets/overlay 里大量用它
File.canonicalPath = /data/data/com.dsh.android/files/...     ← ProotHost 只绑了这条
```

vc62 只修了 `--patch` 的参数（改用 canonical），但 overlay **内容**里仍然写着
`/data/user/0/.../agnes-multimodal/...` 之类的插件路径 ⇒ 14 个插件 `ERR_MODULE_NOT_FOUND`，引擎退出。

本版一次性解决：在 guest 里为 `filesDir` **增加别名绑定**
`-b <canonical filesDir>:<absolute filesDir>`，两套前缀都成立。
既有资产、overlay、以及未来任何用 `absolutePath` 拼出来的 guest 路径都不会再 ENOENT。

### 判据
```text
targetSdk=30；引擎打印 token 行 + 首帧
0 个 failed to import
```

## [0.3.0-refactor.7] — 2026-11-21
vc=62

### 修复（vc61 起不来的真因）
`ProotHost` 把 overlay 列表以 **`absolutePath`** 传给 guest 的 `--patch`，而 `dshHome` 是按
**`canonicalPath`** 绑定进 guest 的：

```text
dshHome.absolutePath  = /data/user/0/com.dsh.android/files/home/.dsh   ← guest 里不存在
dshHome.canonicalPath = /data/data/com.dsh.android/files/home/.dsh     ← guest 里唯一存在
```

引擎启动即 `ENOENT: failed to read overlay .../mobile-ui.patch.yml`，5 秒内退出。
`envFile` 早在用 `canonicalPath`（注释写着「按原绝对路径绑定，guest 内逐字有效」），
overlay 这条漏了。改为 `overlays.map { it.canonicalPath }`。

### 同版包含
- P5 第二档（targetSdk 30）：`MANAGE_EXTERNAL_STORAGE`、30+ 引导「所有文件访问」、
  `/sdcard` 三级取源（全盘 → app 外部目录 → 老逻辑）、`bind /sdcard ->` 日志。

### 判据
```text
引擎正常起（token 行 + 首帧）
无 failed to read overlay
targetSdk=30；logcat 见 bind / sdcard -> <路径>
```

## [0.3.0-refactor.6] — 2026-11-21
vc=61

### 变更（P5 第二档：targetSdk 29 → 30）
- `targetSdk = 30`。API 30 起 `requestLegacyExternalStorage` 被系统**忽略**，`READ/WRITE_EXTERNAL_STORAGE`
  不再授予真 `/sdcard` 的任意访问 —— 本档必须处理存储模型。
- `AndroidManifest.xml` 声明 `MANAGE_EXTERNAL_STORAGE`（`tools:ignore="ScopedStorage"`），并改写那段
  「targetSdk=28 不必申请」的过期注释。
- `MainActivity.ensureStorageAccess()`：30+ 且未授予「所有文件访问」时**引导一次**
  （`ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION`，失败退 `ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION`），
  `SharedPreferences` 记名，不反复弹设置页。
- `ProotHost.defaultPhoneStorage()` 三级取源：
  ① 30+ 且有全盘权限 → 真 `/storage/emulated/0`
  ② 30+ 且无 → `Android/data/<包名>/files/sdcard`（app 专属，始终可写）
  ③ 29- → 老逻辑（有 READ_EXTERNAL 就给真 /sdcard）
- 绑定点加日志 `bind /sdcard -> <宿主绝对路径>`，真机排障一眼看出走哪一级。

### 判据
```text
装机 targetSdk=30
有全盘权限：guest /sdcard -> /storage/emulated/0
无全盘权限：guest /sdcard -> Android/data/<包名>/files/sdcard，且写入成功
引擎照常起，日志无 EACCES / avc: denied
```

### 已知
- 回退状态下「路径不同」：`AndroidOpenWith` 把 `/sdcard/...` 归一化成 `primary:` 的 content URI，
  这种状态下指不到真实文件。要彻底一致，必须让用户授予全盘访问。
- 34 档还要处理 FGS 类型与 edge-to-edge（`SystemBarAppearance` 有 vc19 回归史）。

## [0.3.0-refactor.5] — 2026-11-21
vc=60

### 变更（P5 第一档：targetSdk 28 → 29）
- `targetSdk = 29`；`AndroidManifest.xml` 显式 `requestLegacyExternalStorage="true"`
  （API 29 仍支持 legacy 存储模型，`/sdcard` 直读直写行为不变）。
- **注释与文档修订**（旧文档仍在说「必须 15 字符 / 必须 28」，会误导下一次改动）：
  `app/build.gradle.kts` 两段、`AGENTS.md`「两条硬约束」整节、`docs/agents/constraints.md`、
  `docs/agents/dev-env.md`（11 处失效路径与已删脚本）、`EngineManager` 顶部架构注释、`DshApplication` 注释。

### 判据（本档必须逐条过）
```text
首启解包（1.3 GB）成功
工作区选 /sdcard/... 可读写
悬浮球 + 无障碍 + 截图可用
切后台 10 min 引擎不断连
日志无 EACCES / avc: denied
```

### 已知
- 下一档 30 需要 `MANAGE_EXTERNAL_STORAGE`（API 30 起 legacy 失效），届时 `READ/WRITE_EXTERNAL_STORAGE` 不再够用
- 34 还要处理 FGS 类型与 edge-to-edge（`SystemBarAppearance` 有回归史）

## [0.3.0-refactor.4] — 2026-11-21
vc=59

### 变更（P3 修订）
- **启动时也清扫**：`EngineManager` 在构造 `ProotHost` 之前调 `RuntimeFiles.sweepStale(runtime)`。
  vc58 只在 `RootfsInstaller` 的安装路径里清扫，而「装到一半被杀」的残骸因为 `.rootfs.stamp`
  仍然命中，永远不会再进安装路径 —— 真机实测就留下过 695 MB 的 `rootfs.staging-*`。
- 其余与 `0.3.0-refactor.3` 相同（P3：运行时去 Termux）。

### 判据
- 人为造一个 `files/runtime/rootfs.staging-probe/`，重启 App 后该目录消失，日志出现「启动清扫残留：…」
- 引擎照常起

## [0.3.0-refactor.3] — 2026-11-20
vc=58

### 变更（P3 · 运行时去 Termux）

| 文件 | 改动 |
|---|---|
| `assets/dsh-env.mjs` | 删 `IS_PROOT` 双分支（13 处）、`termux/usr` 兜底、`$PREFIX` 候选；`PREFIX=/usr`、`HOME=/root` 固定；`DSH_FILES` 改为「env 优先，否则取脚本自身所在目录」，不再写死任何 applicationId |
| 同上 | 删 `rewriteTermuxPaths` / `fixGradleLauncher` / `fixPrefixShims` 三个 Termux 专有修补 |
| `assets/check-devenv.mjs` | 删 `files/termux/usr/bin/node` 兜底与写死包名；`NODE=/usr/local/bin/node` |
| `assets/dsh-android-shell.mjs` | `runLocal` 候选表固定为 `/bin/bash` → `/usr/bin/bash` → `/system/bin/sh`，不再看 `$PREFIX`；错误文案不再打印 PREFIX |
| `runtime/RuntimeFiles.kt` | `retireLegacy`（归档）→ `purgeLegacy`（**删除**）：`engine` / `usr` / `termux` / `proot-libs` / `runtime/legacy-bionic` |
| 同上 | 新增 `sweepStale(runtimeDir)`：删 `rootfs.staging-*`、`rootfs.old-*` |
| `runtime/RootfsInstaller.kt` | 安装前调用 `sweepStale` 并记日志 |
| `EngineManager.kt` | 调用点改 `purgeLegacy`，事件名 `runtime.migration` → `runtime.purge` |
| `app/src/test/.../RuntimeS6Test.kt` | 单测跟随删除语义 |
| `tools/dsh-env.sh`、`tools/env-smoke.sh`、`tools/dsh-env.mjs`、`tools/check-devenv.mjs` | 删除（前两个 shebang/前缀指向 termux，后两个是 assets 的过期副本） |

### 判据
- `grep -rn "termux|Termux" app/src tools --include=*.mjs --include=*.sh` = 0
- `grep -rn "IS_PROOT" app/src` = 0
- 设备 `files/` 下无 `usr` / `termux` / `proot-libs`
- 引擎照常起、`dsh-env.mjs status --json` 可用

### 已知
- Kotlin **文档注释**里仍有历史说明（`EngineManager` 顶部「为什么用 Termux 的 node 构建」等），P6 统一清扫
- `docs/agents/dev-env.md` 等文档仍指向已删脚本，P6 同步
- 无线调试的 `adb` 二进制保持不动：它在 **guest 内**由 runner spawn，走 proot loader，不占 API 29 的 exec 面（P5 再评估）

## [0.3.0-refactor.2] — 2026-11-20
vc=57

### 变更
- **P2 · 单宿主化**：删除整条「宿主可选择」链路 —— `HostMode` 三值枚举、`TermuxBionicHost`、`ProotGlbcHost`、`EngineHost` 抽象、`EngineBootGate`（含必失败的 bionic 回落）、`HostSettingsSection`（零调用方的死 UI）。
- `EngineManager`：删 `bootWithHost()` / `legacyEndpointProvider` / `hostCapabilities()` —— 三者均**零调用方**；本地启动只剩一条 `ProotHost` 路径。
- `EngineHost.kt` 收敛为只剩 `EngineHostException`。
- 效果：启动失败不再被「回落 bionic」覆盖成第二条错误，第一条真实原因直达日志与界面。

### 判据
- `grep -rn "HostMode|TermuxBionicHost|ProotGlbcHost|EngineHosts|EngineBootGate|HostSettingsSection" app/src` = 0
- 启动日志 `宿主=proot`；破坏 rootfs 后首条错误即真因
- 引擎照常起，菜单与会话不受影响

### 已知
- 远端引擎（原 `RemoteHost`）随之移除：它此前只被 `EngineHosts.create` 引用，而后者零调用方 ⇒ 功能上从未接通。要做远端作为独立功能另行立项，不进本阶段。
- targetSdk 仍 28、包名仍 `com.dsh.android`（P4/P5）。

## [0.3.0-refactor.1] — 2026-11-20
vc=56

### 变更
- **P1 · jniLibs 全面化**：`libtalloc.so` / `libandroid-shmem.so` 收进 jniLibs；`assets/runtime/proot-libs/` 与 `files/proot-libs` 彻底移除。
- 新增 `tools/runtime/patch-dynstr.py`：对 `libproot.so` 的 `.dynstr` 做**等长原地改写**（`libtalloc.so.2` → `libtalloc.so`），不动节表、不改文件大小（patchelf 方案实测 SIGSEGV，故不用）。
- `ProotHost`：删 `ensureProotLibs()` 与 `LIB_LOCK`，`LD_LIBRARY_PATH` 只保留 `nativeLibraryDir`。
- 原生来源单一化：`nativeLibraryDir` 现有 4 个 `.so`（libproot / libproot-loader / libtalloc / libandroid-shmem）。

### 判据
- APK `lib/arm64-v8a/` 四件套齐全；设备 `runtime/manifest.json` 的 `jniLibs` 为 4 项。
- 引擎照常起（token 行可解析）；`files/` 下无 `proot-libs`。

### 已知
- 本阶段未改 targetSdk / 包名（P4/P5）。

## [0.3.0-refactor.0] — 2026-11-20
vc=55

### 变更
- **重构基线包**：本版**不含重构改动**，代码与 `0.2.2-rc.3` 功能等价，仅版本号前移，用作 A/B 对照与「重构后是否回归」的判据。
- versionName **0.3.0-refactor.0** / versionCode **55**；与 `0.2.2-rc.3`(vc54) 同签名，可覆盖安装。
- 引擎 `@deepseek-ai/dsh` **0.2.2-rc.3**（PRoot 单运行时）；移动端 UI **1.1.0-194**。
- 重构主线立项：[`docs/plan/refactor-single-host-purge.md`](docs/plan/refactor-single-host-purge.md)（P0–P6：单宿主 / 运行时去 Termux / 解除包名与 targetSdk 限制）。

### 已知
- targetSdk 仍为 28、包名仍为 `com.dsh.android`（P4/P5 才改）。
- 构建期仍从 Termux deb 取 proot/talloc/shmem（P3 只归零运行时依赖）。

## [0.2.2-rc.3]（vc54，已下线） — 2026-11-18
vc=54
### 变更
- 引擎 `@deepseek-ai/dsh` **0.2.2-rc.3**（正式版位，非 prerelease）。
- versionName **0.2.2-rc.3** / versionCode **54**；发行签名 `79d0dab6…dc96`，与 `0.2.2-rc.3-debug`(vc53) 同源，可直接覆盖升级。
- 移动端 UI **1.1.0-189**（修复 43：官方项齐后才注入，「⋯」点击不再改 DOM）。
- 构建变体：`system` + `release`（`assembleSystemRelease`），不走 debug 签名。

### 已知
- 「⋯」首次点击需点两次（待修 44）；插件市场两项为两段式渲染（待修 45）。

本文件记录本项目所有值得注意的变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **关于版本号**：`versionName` 表达「对外是不是同一版」，`versionCode` 才保证
> 唯一性。历史上存在多个内容不同但 `versionName` 相同的构建（如 `0.2.9-rescue`
> 对应 vc 21/22/23），那期间靠 `versionCode` 区分。自 **0.3.0** 起引入新产品能力
> 时改前两位版本号。

> **versionCode 机器可读**：每个版本小节标题后第一行写 `vc=<数字>`，
> `sh tools/version.sh --check` 会校验「最新小节的 vc == build.gradle.kts 的 versionCode」
> 且「严格大于上一小节的 vc」。历史上 `0.2.9-rescue` 对应 vc 20/21/22/23，
> 正是靠 versionCode 区分同一 versionName 的不同构建。

---
## [0.2.2-rc.3-debug] — 2026-11-18
vc=53

### 变更

- 引擎 `@deepseek-ai/dsh` **0.2.2-rc.3**（显式版本；`latest` 仍指 rc.1，不写死版本会静默拉回旧版）。
- versionName **0.2.2-rc.3-debug** / versionCode **53**；调试签名不变，`pm install -r` 覆盖升级，不卸载、不清数据。
- 移动端 UI **1.1.0-186**。
- **补丁语料按 rc.3 重建**：`IMG_TYPE_GUARD` / `IMG_TYPE_ANCHOR` 改为 rc.3 压缩后的单行 `isImageMediaType` 形态；`make-patches.py` 改为按版本合并 pin（不再覆盖 rc.1 记录）。
- **构建期补丁门禁**：`apply-patches.py --require-version`，缺当前版本 pin 即构建失败；`build-runtime.sh` 的 `DSH_VERSION` 改读 `tools/engine-version.txt`，`PNPM_VERSION` 对齐 `11.28.5`。
- **空间预检**：`ASSUME_UNPACKED_BYTES` `1_350` → `3_400` MiB（升级峰值 = 旧 rootfs + staging + 缓存归档）。
- **CI**：`apk.yml` 注入 `DSH_VERSION`；`REL_TAG`、资产名与 Release 说明改为动态取值；发布步骤默认关闭（`vars.PUBLISH_FROM_APK`），改由 `publish-apk.yml` 手动派发；`verify-ci.py --workflow apk.yml`。
- Office Kit 保留（`office_convert` / `office_render` / `office_recalculate`），未做重包裁剪。

### 修复

- **单运行时验收路径**：旧脚本仍指向 bionic 时代的 `files/termux/usr/bin/node` 与 `files/engine`。新增 `ProotProbeActivity --es run_script` 的 proot 执行通道与宿主侧 `tools/verify-rc3-device.sh`；rootfs 的 `usr/bin/node` 是 glibc ELF，不能 `run-as` 裸跑。
- `verify-ci.py` 固定查询 `android-release.yml`，与 `apk.yml` 出包链路不符 → 支持 `--workflow`。

### 验收

```text
sh tools/version.sh --check                        → VERSION PASS（vc=53 / engine=0.2.2-rc.3）
node tools/check-engine-anchors.mjs /root/dsh-rc3  → 5/5，EXIT=0
runtime/patches/pins.json                          → 6 个补丁 × {0.2.2-rc.1, 0.2.2-rc.3}
tools/verify-rc3-device.sh                         → engine=0.2.2-rc.3 / patch-marks=5/5
```

## [0.2.2-rc.1] — 2026-11-16
vc=52
### 变更
- **版本号对齐 DSH 引擎 `0.2.2-rc.1`**：原 `0.5.0` 命名作废，`versionName` 改为
  `0.2.2-rc.1`、`versionCode=52`（`tools/app-version.txt` 同步）。
- 随附移动端 UI `1.1.0-185`：插件页 ⓘ/▾ 点击修复、三入口市场滚动适配、
  登录授权页交系统默认浏览器打开。
- 其余变更沿用下方 `0.5.0` 小节。

## [0.5.0] — 2026-11-15
vc=51

### 变更
- **单运行时 PRoot / glibc**：引擎、`bash`、uid 2000 特权通道、root 通道、沙箱 runner 全部
  跑在 APK 内置的 Ubuntu 24.04 rootfs 里（node 24.22.1、pnpm 10.28.2、git、python3、curl）。
  bionic 资产（`engine.bin`、`node-runtime.bin`、`bootstrap-*.zip`、原生 addon）已从 APK 删除。
- **数据迁移**：`$DSH_HOME`（sessions / storages / profiles / skills / deskpet / 凭据）、
  `workspace/`、`logs/` 原地保留；0.4.x 的 `engine/`、`usr/`、`termux/usr` 在首次健康启动后
  改名进 `runtime/legacy-bionic/`（改名不删，`termux/home` 不动）。
- **救援与自愈**：L2 救援 profile 与 `try-boot` 走 PRoot；rootfs 关键文件缺失或版本戳失效时
  自动重新解包（约 80 s），用户数据不动；安全模式改为「标记 rootfs 重建」。
- **进程治理**：每次启动独立 pidfile、按进程树作用域停止；试启动不再按 cmdline 全局清杀，
  在跑的引擎不会被探测误杀。
- **密钥不出现在命令行**：调用方环境变量写进 `$DSH_HOME/.proot-env-<runId>`（0600，退出即删），
  `ps` 不再能看到 API key。
- **镜像自带开发工具**：`git` / `python3` / `curl` 随 rootfs 下发，重解包不再丢 dev-env
  （代价：APK 由 143 MB 增至 187 MB）。
- **DNS 回归修复**：dev-tools 镜像步骤把构建机的 `resolv.conf`（`nameserver 127.0.0.53` +
  `search *.compute.internal`）带进了 rootfs，导致设备上**所有域名解析失败**（登录显示
  「账号资料暂不可用」、插件市场回退离线目录且提示 `fetch failed`）。构建期改为装完即还原
  公共 DNS，`verify.py` 增加解析器硬断言，客户端对已知坏值就地自愈（老安装无需重装）。
- **图片附件**：修复 `@img/colour` 被平台裁剪误删导致的 `Cannot find module`（发图必失败），
  `verify.py` 增加硬断言。
- **window.open 页面级接管（1.1.0-185）**：WebView 里 `window.open` 返回的弹窗不会
  真的导航，登录授权页既不显示也不外跳。移动端插件在页面里接管 `window.open`：
  真实 URL 直接走主框架导航（宿主 `shouldOverrideUrlLoading` 转 `ACTION_VIEW`），
  `about:blank` 预开窗口返回带 `location.replace/assign` 的代理，同样落到默认浏览器。
- **外链与登录统一走系统默认浏览器**：`window.open` 预开的 `about:blank`
  窗口原先只交给内核、从未挂到任何窗口上，导致登录授权页既不渲染也不
  导航（日志停在「已建空白窗口」）；插件市场里用 `window.open` 打开的
  收录插件页同样静默失效。现在给 popup 挂一个 1×1 隐形宿主让内核能
  调度导航，首个非本地 URL 立即交给系统默认浏览器（如 Chrome），
  并回收宿主与 WebView。`onCreateWindow` 已知 URL 的情况保持直接外跳。
- **移动端 UI `1.1.0-184`**：修复插件页 ⓘ 说明与 ▾ 添加方式按钮「点了没反应」。
  触摸按下时重置宿主的兼容点击去重窗口，同一次手势只放行一个 click，连点两次仍能开、关；
  插件说明气泡在触摸设备上重新可见并夹在视口内。
  市场容器判据改为「前两个子节点是 DIV」，滚动过 300px 出现回顶按钮后布局适配不再整段失效；
  分类栏与回顶按钮不再 sticky/fixed 错位，三个入口滚动时宽度、字号与内边距保持一致，
  离开市场仍逐条还原原始样式。修复限定 `mobile-ui-plugin`，契约测试覆盖第三子节点、
  sticky 归位与非 DIV 结构。
- **移动端 UI `1.1.0-183`**：插件页按「标题 + 刷新/添加/下拉」「说明 + ⓘ + 更新状态」
  「已安装 / 插件市场」三层排版；内置配置与实验性插件分组标题在上、列表在下，
  「更多 ›」与实验性插件标题同行，窄屏自动换行。
  三个市场入口（设置、插件标签页、侧栏面板）统一字号与内边距，挂载微任务内完成布局，
  消除进场的缩放与宽度跳变；头部保留自然高度，列表独立承接触摸纵向滚动。
  设置内保留标题栏、配置文件/关闭按钮与横向分类导航，修复重复标题；离开市场还原原样式。
  修复代码限定 `mobile-ui-plugin`，新增布局契约回归测试与三入口真机帧级验收。
  修正市场窄屏样式对宿主导航和宽度的覆盖；移除不可达的旧设置两级化代码，
  仅用稳定属性与可还原的内联布局，切换分类/桌面尺寸时恢复宿主原有样式。
- **移动端 UI `1.1.0-181`**：左侧栏图标与右侧栏同规（28×28 / `label-secondary` / 1px 描边），
  关闭态 `visibility:hidden + contain:strict`，消除「工作区条飞出」与图标加粗。

## [0.4.3] — 2026-11-09
vc=49

### 变更

- 引擎 `@deepseek-ai/dsh` **0.2.2-alpha.2 → 0.2.2-rc.1**（`0.2.2-rc.1-1`）
- 首帧兜底日志降为 `[I]`：阈值 1.5 s 不变，本机内核常走兜底，属正常慢帧
- 救援判据修正：只认「超时兜底 + 页面仍停在官方启动页」，不再把 `plugin-load-failed` 诊断当判据
- `engine.staging-<stamp>-<pid>` 唯一化 + 过期残留清扫（并发安装不再互相覆盖）
- 日志异步档增加 1.5 s 时间兜底 flush，`engine.log` / `web.log` 不再整段丢失
- 解包目录替换三层退路（硬删复查 → 挪开旧目录 → 逐文件复制）
- mobile-ui `1.1.0-176`：座位只在会话视图退场；左按钮并入 header 布局体系
- 版本号单一来源：`tools/app-version.txt` + `tools/mobile-ui-version.txt`
- CHANGELOG 模板化：`docs/changelog/<versionName>.md`
- `verify-engine-upgrade.sh --tools` 自举 helpers，换机不再依赖 `/data/local/tmp`

### 门禁

- 引擎 0.2.2-rc.1 · 开发环境 nodejs 2/2 · 会话索引 2/4 · 补丁标记 5/5 · 工具 bubble/ui/logs/statusbar/browser PASS · root SKIP
- 真机：Xiaomi 25104RADAC / Android 16 / arm64-v8a

---

## [0.2.2-rc1] — 2026-11-07
vc=47
### 变更
- **版本号对齐 dsh 官方**：`versionName = 0.2.2-rc1`，与引擎 `@deepseek-ai/dsh@0.2.2-rc.1`
  同名；`versionCode = 47` 继续严格递增（39 → 47），保证从 0.4.9（vc46）可覆盖升级，
  不会触发 `INSTALL_FAILED_VERSION_DOWNGRADE`。
- **引擎升级到 `0.2.2-rc.1`**：`engine.bin` 81,470,515 B，
  sha256 `1d909f00489314896d7af120070df8ea90aee5b74d327e9bbbf744fa773aed73`，
  MANIFEST 52,835 文件 / 386,190,604 字节，`assetStamp = 0.2.2-rc.1-1`。
  Node `26.12.1`，pnpm `11.28.5`，会话格式 `v4`（旧会话可直接读取）。
- **移动端 UI `1.1.0-169`**：一次性带入 rc.1 的六条适配——
  ① 侧栏开合以 `data-sidebar-collapsed` 为唯一事实源；
  ② `data-sidebar-drawer` 下恢复 fixed + 宽度 + left 动画，原生 `pI_x6G_drawerMask` 置 none；
  ③ 设置弹窗排除 `.hHd-Xa_root` / `.pI_x6G_sidebarCol`（rc.1 侧栏根节点带 role=dialog/aria-modal）；
  ④ 左右栏按钮完全交回官方：不建自建按钮、不写内联 `position/top`，只清历史内联样式；
  ⑤ `[data-mobile] .pI_x6G_leadingSeat { z-index:60 }`，修复左按钮被右栏溢出面板
     （`.P3OORG_panel` 以 `right:0` 铺满、`_tabCell` z-index:40）吃掉命中；
  ⑥ 插件市场行图标整行归一化：删重复 glyph / 重复 svg，只留一个并裁成 2×2 四格。
- `@linxin666/dsh-web-all` 与 `dsh-app-pet` 在 `dsh.profile.bundles` 中启用。
- 补回 `publish-release-from-run.yml`（0.4.2 基线缺失该 workflow），资产名随 tag 推导，
  上传使用 `secrets.RELEASE_PAT`。
## [0.4.2] — 2026-11-01
vc=39

### 修复

- **设置页标题重复三层**：顶栏「设置」、居中「‹ 页面名」、内容区再一个同名 H1/H2，
  连「特权权限（uid 2000 / root）」这种带后缀的标题也重复。统一为「返回键 + 页面名」
  一层顶栏，内容区同名标题全部隐藏。
- **根页两个「设置」**：官方面板是 `flex-flow: row wrap`，返回条被挤成 60px 窄条，
  标题跑到右侧。改为绝对定位满宽顶栏，根页只保留一个标题。
- **三个退出入口并存**：`‹`、`✕`、「打开配置文件」同时存在。官方 header 隐藏，
  只留 `‹`（二级 → 列表 → 关闭）。
- **内容区只有 26px 高**：设置面板改为单列 `nowrap`，内容区 `flex:1 + overflow-y:auto`，
  顶部留 48px 给顶栏。
- **开发环境只有「…」**：加载态给文案，读取加 10s AbortController 超时，
  失败给原因 + 「重新读取」；空态不再是一片空白。
- **悬浮气泡露出原始键名**：补 `showDetails / hideDetails` 中英文词典项。
- **⋯ 菜单「对话 / 轨迹」无法连续切换**：原来标签在菜单构建时算一次、点击用闭包旧值。
  改为点击瞬间读取当前激活 tab、点完立即把本项翻成反向目标，菜单不关也能来回切。
- **会话行「⋯」菜单弹出 1–2 秒后自动消失**：`@linxin666/dsh-web-all` 的移动端
  `installMobileSidebarDismiss` 在 `sessionRow` 点击后用 rAF 程序化点击官方抽屉
  toggle，菜单锚点被带出视口。`dsh-android-mobile` 增加守卫：菜单打开期间、以及
  行操作点击后的 600ms 内，拦掉这类 `toggle.click()`；真实点击与菜单项动作不受影响。
- **「创建你的插件」只开新会话、草稿为空**：`@linxin666/dsh-web-all` 会把
  `uiWorkspace` 实例上的 `startSession` 替换成 native 空壳，调用后没有任何效果，
  所以草稿与创造模式都不落地。`dsh-android-mobile` 改为取原型链上的 DSH 原版
  `startSession` 并用正确 receiver 调用，参数与官方完全一致（`agentPreset:"cordis"`、`prompt`、`whenDraftExists:"append"`），不再做 DOM 兜底。
- **dshmarket 在移动端被压成 32px 宽**：市场根节点复用了官方 `uV2eYG_root` 的
  `align-items:center`，导致标题、搜索、卡片全部挤成一条。`dsh-android-mobile`
  在市场根节点内恢复 `align-items:stretch` 与 100% 宽，394px 视口下卡片恢复到 362px。
- **dsh-web-all 折叠态残留 52px 图标条**：web-all 的 `[data-pane="sidebar"]`
  规则把侧栏钉成 52px 绝对定位轨道，设置页正文被压到右侧。`dsh-android-mobile`
  在 `[data-mobile]` 下关闭态直接 `display:none`，仅 `.mp-drawer-open` 时恢复
  320px 固定抽屉；设置 dialog 是 body 级 portal，不受隐藏影响。
- **dsh-web-all 叠加第二层抽屉遮罩**：移动端已有 `mp-drawer-mask`，web-all 的
  `[data-dsh-frame]::after` 会再盖一层。抽屉打开时给 `<html>` 加
  `data-mp-drawer-open`，只关掉 web-all 的 `::after`，保留市场/会话全部点击。

### 变更

- **「创建你的插件」改走原版 DSH 调用**：
  `uiWorkspace.startSession(void 0, { agentPreset: "cordis", prompt, whenDraftExists: "append" })`；
  三个入口按 region 使用官方提示词（左侧栏 / 会话视图 / 右侧栏），不再回退到 DOM 流程。

### 发布

- 移动端 UI build：`1.1.0-154`（CI run `41301507952`，APK 185,668,979 B）。
- 正式修复 build：`1.1.0-161`（CI run `41775381968`，APK 185,610,007 B，client 577,643 B；
  dsh-web-all 折叠态 52px 图标条完全收起，验收 `0/9 · ✅`）。
- 第三方 UI build：`1.1.0-160`（CI run `41633704830`，APK 185,591,763 B，client 577,112 B；
  dshmarket 全宽布局 + dsh-web-all 双遮罩收敛，验收 `0/9 · ✅`）。
- 官方菜单修复 build：`1.1.0-159`（CI run `41593566860`，APK 185,593,927 B，client 575,358 B）。
- 会话视图入口 build：`1.1.0-158`（CI run `41586246550`，APK 185,529,739 B，client 573,910 B）。
- 过渡 build：`1.1.0-157`（CI run `41482760262`，含草稿 DOM 兜底，仅存档，不作为最终方案）。
- 验收记录：[`docs/agents/mobile-ui-verification.md`](docs/agents/mobile-ui-verification.md) 的 1.1.0-161 行（`0/9 · ✅`）。
- 发布产物：GitHub Release `v0.4.2` 两个附件已于 2026-11-04 替换为 `1.1.0-161`：
  - `dsh-android-0.4.2-arm64.apk`：185,610,007 B，sha256 `d75ad652ba12ead6233a5ad2b3c568368df9664ab95eee558d394f95a8e34e2e`
  - `dsh-android-0.4.2-gecko-arm64.apk`：274,685,019 B，sha256 `8c21d57e1f7fecffe61dd55241294d53833130f6881efa1540a0f769da46368a`

---

## [0.4.1] — 2026-10-23
vc=38

### 修复

- **AI 浏览器的入口不在约定的位置** —— 0.4.0 用的是右边缘贴边把手，而需求是
  「从应用右侧边栏进入」。0.4.1 把它做到官方右侧边栏里。
- 新增客户端插件 `dsh-android-browser-pane`：经 `sidebarRightTabs.register`
  注册一种 tab + 经 `slots.register("sidebar.right.pane.tab")` 提供正文。
  点开即调原生 `openAiBrowser()`（`PageBridge` 新增方法，两份 flavor 白名单
  已同步）。**独立成包**，不动 `mobile-ui.zip` —— 那个 zip 是跨工作树共享的
  符号链接资产，重打会把另一条分支的移动端修复整个回退掉。
- 右边缘把手暂时保留作退路，侧栏入口确认可用后可删。

---

## [0.4.0] — 2026-10-23
vc=31

主题：**AI 拥有一台属于自己的手机浏览器**。

### 新增

- **AI 浏览器** —— 一个独立于官方界面的原生 WebView（`AiBrowserView`）。
  引擎自带的侧栏浏览器是 `iframe`，而 GitHub（`X-Frame-Options: deny`）、
  Google（CSP）拒绝被嵌入，那个方案连登录页都加载不出来；原生 WebView
  没有这个限制，且渲染在本地、零延迟、不消耗服务器资源。
- **完整的浏览器壳**：前进/后退/刷新/首页/地址栏/加载进度/多标签（上限 6）/
  文件下载（落 App 专属外部 Download 目录，不需要存储权限）/ 文件上传 /
  视口截图。
- **`browser` 工具**（`dsh-android-browser`）—— 模型可以自己开网页、读页面、
  点按钮、填表单、登录、截图。读页面回的是**可交互元素清单**（带稳定编号），
  而不是一堆 HTML，因为让模型猜 CSS 选择器在真实站点上几乎必然落空。
- **登录态持久**：Cookie 每次 `onPageFinished` 都 flush，App 重启后仍是登录状态。
- **控制权仲裁**：AI 操作时吃掉所有触摸（避免用户随手一点让正在填的表单失焦），
  顶部 chip 显示「AI 操作中」，用户点一下即可接管 —— 共享同一个浏览器。
- **右边缘「浏览」把手**：启动层收起后常驻，浏览器打开时自动隐藏。

### 修复

- 工具栏按钮不显示 —— `ImageButton` 继承 `ImageView`、**不是 `ViewGroup`**，
  `addView(tv)` 被隐式接收者解析成外层 `FrameLayout.addView`，文字被加到根布局
  左上角（被页面盖住）。改为纯 `TextView` 按钮。
- `type` 动作的 JS 里把 `var` 写成 `val`（Kotlin 笔误），会让所有输入操作抛
  `SyntaxError`。已用 `node --check` 逐段验证拼接后的五段 JS。

---

## [Unreleased]

### 计划中

- 补齐开源仓库配置（README / LICENSE / CONTRIBUTING / SECURITY / CI）

---

## [0.3.0] — 2026-10-17

### 新增

- **Shizuku 权限通道** —— uid 2000 执行不再只依赖 adb。不需要 5555 端口、
  不需要 adbkey 被信任、重启后依然有效。此前对「Android 10 且只有有线 adb」的
  用户是结构性死锁。
- **插件市场**（`dsh-android-market`）+ 远程目录双插件。
- **配对服务端加固** + 管理面板；新增五组门禁测试。
- **界面改三标签页**。

### 修复

- **白屏真根因（HTTP 431）** —— auth cookie 累积导致请求头超限；同时 GeckoView
  不跟随 303 重定向。新增救援判据。
- **救援判据漏报** —— `parseGatewayFailure` 无法识别 typert gateway 整体下线的场景。
- **ELF 路径改写必须用运行时真实包名** —— 编译期常量在被改包名的安装上会指向
  不存在的目录。
- **补传诊断包跨进程互斥** —— 单靠 `AtomicBoolean` 挡不住重叠的主进程实例。
- **L1 隔离作用在过期快照上** + quarantine 有一条完全静默的 `false` 分支。
- **救援阶梯日志从不落盘** + `rescue/` 状态文件从不进诊断包。

---

## [0.2.9] — 2026-10-14

### 新增

- **内建 uid 2000 执行通道**（`shell` 工具）。
- **悬浮球** —— 可自定义外观、帧动画、视频图层。
- **`bubble` / `pet` / `ui` / `logs` 工具插件** —— 让模型自己操作悬浮窗、看屏幕、
  查日志。
- **四级救援阶梯 + 安全模式** —— 坏插件不再让 App 打不开。

### 修复

- **「界面反复出错」误报** —— 渲染重载计数没有时间窗，长期运行的内核回收会
  累计成「反复崩溃」。
- **界面重载永远判失败** —— 四层缺陷叠加，内核被回收后无法自动恢复。
- **「已停止自动恢复」后仍在重载** —— 在飞的重载链没有失效机制。
- **主线程卡死现场无栈** —— 补主线程栈快照，此前 4 份真实用户现场全部无法定位。
- **文件上传任何格式都失败** —— 上传 Worker 改到主线程。
- **号池「API 密钥无效、重启又恢复」** —— 固定槽位表耗尽。

---

## [0.2.7] — 2026-10-13

### 新增

- **内置 Web 内核版**（gecko flavor，GeckoView 140）—— 不依赖系统 WebView，
  与 system 版 `applicationId` 不同，可同装一台机器。
- **内置号池** —— TLS 层注入，密钥不落盘、不进 JS。

### 修复

- **旧 WebView 内核白屏** —— 改为把前端 bundle 按 chrome73 降级编译，而不是
  只打 polyfill（polyfill 补不了语法）。

---

## [0.2.6] 及更早

引入 `system` / `gecko` 双 flavor 之前的历史版本。核心适配工作在此阶段完成：

- Termux 环境自举（bootstrap / node / pnpm）
- **`link` 转译层** —— SELinux 不给 `link()` 权限
- **自带沙箱 runner** —— Android 没有 bwrap / Landlock
- **ripgrep / sharp / node-pty 的 android 变体**
- WebView 文件选择器与下载器
- 目录选择器接上手机存储

细节见 [`docs/agents/`](docs/agents/README.md)。

---

## 链接

- [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)
- [语义化版本](https://semver.org/lang/zh-CN/)
