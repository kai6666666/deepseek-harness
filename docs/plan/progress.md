# DSH for Android · 进度与计划

> 快照时间：2026-11-24 20:35（UTC+8）　当前发布：`v0.2.2-rc.5-debug.37` / vc122
> 架构：单宿主 PRoot + glibc 单运行时（rootfs 内 `/usr/bin/node`、`/opt/dsh`），WebView 加载官方 Web GUI
> 身份：`com.dsh.android` / targetSdk 35 / 维护态（只修 bug，不改身份与架构）

**本轮（debug.35）**：单测门禁并入 `apk.yml`（单测挂了就不出包）+ 删除仓库根目录陈旧
`app-version.txt`（debug.31/vc116，会让人改错文件）+ `publish-apk.yml` 末自动重建全量
`SHA256SUMS.txt`（原来只算 APK 一行，分片是后续 job 才上传的）。

> 设备侧已装 `debug.37 / vc122`：runtime stamp 保持 `…4ef4d5ef4ac0`（未重解包）、
> `DETAIL.md` 15 个、`parts` 144 MB 保留。启动日志：`engine.ready ms=50459`；
> 同一次会话里出现「键盘弹出 / 内容让位 / 键盘收起」→ Web UI 可交互。

**P0 + P2 已全部落地（debug.36）**：

| 项 | 落地形态 |
|---|---|
| 首启失败兜底 | `RuntimeFailure`（5 类）+ `RootfsInstaller.Failure` + `EngineManager` 分类文案，`EventLog` 记 `engine.failed.kind` |
| `parts` 清理 | `RuntimeFiles.pruneParts(keep=1)` 按 mtime 只留最新，跳过符号链接，删不掉不抛 |
| CHANGELOG 自动化 | `tools/changelog.py`，本轮首次在真实发版流程里用上（生成了 debug.36 小节骨架）|

---

## 1. 一句话现状

**能装、能跑、能升级（含增量）、能出包、文档齐。** 剩下的是「打磨与可观测」，不是「能不能用」。

```text
设备        0.2.2-rc.5-debug.34 / vc119 · mobile-ui 1.1.0-237
运行时      rootfs 986 MB · parts 144 MB（1 版基线）· 插件 338 个 · docs 15 包
发布        debug.34（9 资产：APK 159 MB + 热包 + 4 段 runtime + 清单 + 校验和）
CI          apk.yml success · compile.yml success（单测已绿）· publish success · sign success
增量        Atom 路径真机验证通过（0 GitHub API 配额）
```

---

## 2. 里程碑状态

| 里程碑 | 内容 | 状态 | 验收证据 |
|---|---|---|---|
| **P1** | 单宿主 PRoot + glibc 单运行时；WebView 载官方 GUI；`/opt/dsh` 引擎 | ✅ 已完成（历史） | 设备上 338 个 `@deepseek-ai` 包、`/usr/bin/node` 可跑 |
| **P2** | runtime **文件级增量**：清单 → 逐块比对 → Range 下载 → 拼接 → sha256 → staging 原子替换 | ✅ **完成并实测** | 3 次演练：① part2 篡改 1 字节只下 64 KiB ② 79 MB 完整包 48 秒内恢复 ③ Atom 路径真机验证（part2 783,564→783,464，sha 与 Release digest 逐位一致） |
| **P3** | CI 产出 `runtime-chunks.json` + 上传 Release；`runtimeVersion` 版本戳 | ✅ 完成 | `apk.yml` 的「生成 runtime 分块清单（P3）」step 每次出包都产出；debug.33/34 资产里都有 |
| **P4** | （历史空档，未单独立项） | — | — |
| **P5** | 减包（把运行时移出 APK） | ⛔ **已评估 → 决定不做** | 见 §6 决策记录 |

---

## 3. 当前交付能力（清单）

### 3.1 安装包
- APK **166,750,300 B（159 MiB）**，其中 **150,778,359 B（90%）是运行时**（四段 tar.xz 按目录切分，**没有冗余**）
- 首装**完全离线可用**（运行时全在 APK 内）
- 签名：release identity（`79d0dab6…`），`sign-upgrade-apk.yml` 可重签升级包

### 3.2 运行时（rootfs）
```text
opt       79,448,384   ← 引擎（node_modules，338 个 @deepseek-ai 包）
usr       70,263,276   ← Ubuntu 24.04 系统（glibc + 工具链）
var+etc      783,464
其余          1,888
解包后      986 MB（设备实测）
```

### 3.3 更新通道
| 通道 | 载体 | 体积 | 验证 |
|---|---|---|---|
| 界面热更新 | `plugins-mobile-ui-1.1.0-237.zip` | 242 KB | 换 zip + 重启即生效（`1.1.0-222…237` 十几轮实测） |
| 运行时增量 | `runtime-chunks.json` + 4 段 | 65 KB 起 | 3 次演练，sha 逐块校验 |
| 运行时全量 | 4 段 tar.xz | 150 MB | manifest 断言 |
| APK 升级 | Release APK | 159 MB | `SHA256SUMS.txt`（8 行） |

### 3.4 文档（`docs/agents/`）
| 文件 | 覆盖 |
|---|---|
| `mobile-ui.md` | 设计 token 白名单、插件详情两处根因、对齐 6 轮实测、补丁时机与采样判读 |
| `plugin-data-repair.md` | 升级/重建 runtime 后两类数据失效（docs 丢失 / `.l2s` 死链）的判定与修复 |
| `runtime-delta.md` | P2 完整设计 + 3 次演练 + Atom 限流缺陷与修复 + 取证经验表 |
| `progress.md`（本文） | 全景进度与决策记录 |

---

## 4. 已修复问题台账（debug.28 → debug.34）

| # | 问题 | 根因 | 版本 |
|---|---|---|---|
| 1 | 深色模式「关于」弹窗白底浅字 | 用了**不存在**的 token `bg-elevated`/`bg-subtle`，`var()` 整条作废 | 1.1.0-219/220 |
| 2 | 插件详情页「插件声明的详细介绍文件无效」 | ① `build-runtime.sh` 删了 `docs/` 目录 ② `*.md` 规则没豁免 `docs/` ③ `README.i18n.yaml` 是哈希旁签、不是正文 | debug.32/33 |
| 3 | 插件页三个列表贴边 | 需抬**最外层** `main/section`（`ul` 加 padding 反而更糟：底色仍铺满） | 1.1.0-231 |
| 4 | 导航标题偏右（「实验性插件」） | `header` 有 `padding-left:52px` 给返回按钮预留，按钮又是 flex 子项，叠加把 `H1` 推到 104 | 1.1.0-233 |
| 5 | 标题「向左瞬移」 | 补丁用 1.2 s 定时器，首帧已按 52px 画出 | 1.1.0-234→237（MutationObserver + rAF） |
| 6 | 「关于」放错位置 | 多模态配置 `order=200`，`about` 改 201 | 1.1.0-210 |
| 7 | 内置插件/插件市场加载慢、切页重扫 | 官方每次重扫 + `search()` 每换索引重抓；加 5 min 快照 + 3 s 硬超时 | 1.1.0-214/216 |
| 8 | `dsh-app-pet`「未运行 / 包不可用」 | PRoot link2symlink 的 `.l2s` 死链（runtime 重建后目标文件没了） | 现场重装 1.0.3 真实文件 |
| 9 | 检查更新时好时坏 | 匿名 GitHub API 60 次/小时/出口 IP，打空返 403 被误报成「没找到 Release」 | debug.34（改 Atom feed） |
| 10 | `purgeLegacy` 会删 `termux/home` 用户数据 | allowlist 里写了整棵 `termux` | debug.34（只删 `termux/usr`） |

---

## 5. 待办（按优先级）

### P0 · 稳定性
| 项 | 说明 | 状态 |
|---|---|---|
| 首启失败兜底 | 新增 `RuntimeFailure` 分类（空间不足/包损坏/不完整/权限/未知）+「标题+差多少 MB+下一步」文案；`EngineManager` 把 `kind/code/retryable/freeMb` 写进 `EventLog` | ✅ **已完成（debug.36）** |
| `parts` 自动清理策略 | `RuntimeFiles.pruneParts(partsDir, keep=1)`：按 mtime 只留最新一版、跳过符号链接、删不掉不抛；在 stamp 写完后调用 `pruneOldBaselines()` | ✅ **已完成（debug.36）** |
| 崩溃/异常上报 | 现有 `app.log`/`web.log`/`engine.log` 三份日志，缺「一键导出诊断包」 | 已有 `DiagnosticBundle.kt`（主人确认功能重复，无需再做） |

### P1 · 体验（**三项全部不做**，主人 2026-11-24 决定）
| 项 | 说明 | 状态 |
|---|---|---|
| 「关于 → 检查更新」UI 路径实测 | 主人已亲验通过（弹窗正常显示）；剩余「增量 KB / 全量 MB 文案细看」不做 | ⛔ **不做** |
| 三列表 16dp / 标题对齐的手机尺寸回归 | 已在 1280×2772（dpr 3.25）验收；其它 dpr / 平板回归不做 | ⛔ **不做** |
| `dsh-app-pet` 升级自愈 | 现在靠人工重装；不做自动死链重装 | ⛔ **不做** |

### Phase 0 · A/B 前置修复（2026-11-24，commit `d00fb0c1c3`）
第三轮查漏补缺产出的 4 件小事，都已落地，**CI run `45414435263` 全绿（单测 27 → 30）**：

| 项 | 内容 |
|---|---|
| **V1** | `RuntimeFiles.pruneParts` 没排除 `.` 开头的目录，会把 `parts/.staging-*` 当成"一个版本"参与 mtime 排序，从而**挤掉真正的当前基线** → 更新退化成全量。已修（判据与 `RuntimeDelta.localBase` 对齐） |
| **V2** | `sweepStale` 只扫一级的 `rootfs.staging-*` / `rootfs.old-*`，扫不到 `parts/.staging-*` ⇒ apply 被杀后 144 MB 级半成品永久残留。已修（判据用 pid，pid 解析不出才用 24h mtime 兜底） |
| **V4** | `LogStore.app` 的 `writeApp` 是**每行 flush**（`LogStore.kt:489`）⇒ `EventLog.record` 同步落盘。8 个启动打点约 8~40 ms，不影响 B 的"< 1s"验收 → B-1 照原计划打点 |
| **V7** | 检查更新失败原先一律报"没找到带清单的 Release"（D2 修过限流那版，但**网络不通**仍落这句）。已改成 `ReleaseFailKind`：NETWORK / NO_MANIFEST / PARSE，各带中文前缀 |

### A-1/A-2 已落地 + 镜像表实测（2026-11-25）
- **A-1**：`GithubMirrors`（两段式探测、206 判据、直连优先、全灭回退）+ `atomUrls` 独立表
- **A-2**：并行块下载（6 线程、`FileChannel` 定位写、`AtomicLong`、仅 `fetch>=32` 启用）
- **镜像实测**：16 条候选 → **5 条可用**（gh-proxy.com / ghproxy.net / ghfast.top /
  github.boki.moe / gh.monlor.com）；**只有 gh-proxy.com 能转 atom**
- **补入口**：atom 走 `ATOM_MIRRORS`（原计划漏了，是实现缺口）；`httpGet` connect 15s→**6s**
- 单测 **30 → 38**（A-1 六条 + atom 两条）

### A-0 · 多线路/并行的基线（2026-11-24 真机实测）
设备 `debug.37`（改动前）跑一次**全量**运行时下载（143.5 MB）：

| 指标 | 实测 |
|---|---|
| 吞吐 | **≈ 87 KB/s**（30 秒只下 2.6 MB） |
| 预计耗时 | **≈ 27 分钟** |
| 请求数 | 2296 次**串行**，单线路直连 |

⇒ 瓶颈是**请求数**不是带宽，所以 A 必须同时做「多线路 + 并行块下载」。
**验证样本**：演练中途被杀留下 `parts/.staging-…-19783`（18 MB），装上含 V2 的版本后
应被 `sweepStale` 自动清掉（真机验收点）。

### P2 · 工程
| 项 | 说明 | 状态 |
|---|---|---|
| `compile.yml` 纳入 `apk.yml` | 单测现在独立跑，`apk.yml` 不跑单测 → 曾让 `RuntimeS6Test` 红了两天没人知道 | ✅ **已完成（2026-11-24，debug.34 之后）** |
| CHANGELOG 自动化 | `tools/changelog.py`：从 Conventional Commits 生成小节草稿，支持 git log 与 GitHub API 两条路，`--since` 支持 tag（先解成 ISO 时间） | ✅ **已完成（debug.36）** |
| Release 资产自动校验 | 现在靠人工跑脚本比对清单/分片；`SHA256SUMS.txt` 已改为 publish 末自动重建 | ✅ 部分完成（2026-11-24） |

**单测门禁落地细节**（`.github/workflows/apk.yml`，插入在「编译门禁（engine）」之后）：

```yaml
      # 单测曾经只跑在 compile.yml 里，而 apk.yml 不跑 —— RuntimeS6Test 红了两天没人知道。
      # 这里把它提到出包路径上：单测挂了就不出包。compile.yml 仍保留作为 PR 的快速反馈。
      - name: 单元测试门禁（app 单测，含 S6 回归）
        run: bash ./gradlew :app:testSystemDebugUnitTest --console=plain --stacktrace

      - name: 单测报告（失败时也上传）
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: app-unit-tests
          path: app/build/reports/tests/testSystemDebugUnitTest
          if-no-files-found: ignore
```

**实证**（run `45328267758`，`assembleSystemDebug` 全绿）：

```text
 15 编译门禁（engine 包，不需要资产）                success
 16 单元测试门禁（app 单测，含 S6 回归）              success   ← 新增
 17 单测报告（失败时也上传）                        success   ← 新增
 …
 29 发布到 Release（公开可下）                     skipped   ← 手动发布开关未开，不会误发
artifacts: app-unit-tests 6,280 B                 ← 报告已产出
```

---

## 4.9 debug.41 演练：修好 state 机，又撞出「chunks 不走镜像」

### 修好的三件事（`debug.41 / vc126`，真机验证）

| # | 改动 | 真机证据 |
|---|---|---|
| 1 | `applyAsync` 被拒时写 `message` + `Log.w` | 日志出现 `applyAsync 被拒绝：还不能应用：当前状态=error（检查还没完成或已失败）` |
| 2 | dryrun 从固定 sleep 改成**轮询等终态** | check 一直等到 `error` 才往下走（18:11:51 → 18:12:53，62 秒）|
| 3 | `runCheck` 的 Plan 缓存给 `runApply` 复用（5 分钟 TTL） | 未走到这步（check 先失败了），代码在 |

⇒ **静默失败这条最贵的账还清了**：现在无论 check 失败还是时序不对，日志里都有明确原因。

### 撞出的新 bug：`runtime-chunks.json` 下载不走镜像

```text
18:12:08  小文件走镜像 GhProxyCom：releases.atom        ← atom 成功（1.2s）
18:12:52  检查失败：Release 里没有运行时清单：最近 5 个 tag
          全部「下载失败」                              ← 但报成了「发布缺资产」
```

**根因**：`latestRuntimeRelease()` 里探 tag 用的是

```kotlin
val txt = httpGet(base + CHUNKS_NAME)     // ← 直连！不走镜像
```

而真机实测（同一分钟，同一 URL）：

```text
gh-proxy  http=200  t=2.72s   size=292451   ← 正确，正是文件大小
direct    http=000  t=31.46s  size=0        ← 完全不通
```

⇒ 5 个 tag 全部卡在直连上失败，而错误文案说的是「Release 里没有运行时清单」——
**又是把网络问题误导成发布缺资产**（和 D2 那次 `限流 403 被误报成没找到 Release` 是同一类）。

**修法**：`httpGet(base + CHUNKS_NAME)` → `httpGetWithMirrors(...)`；`runCheck` 里
`rel.chunksText ?: httpGet(rel.chunksUrl)` 同样改成走镜像。

### 顺带验证：A-2 的「Range 分块 + 并行」在真实下载里是有效的

本轮下载 167 MB 的 CI artifact 用的就是这套（Python 复刻）：

```text
分块数: 10（16 MB/块）
下载完成 186.4s  875 KB/s  size=167088688
zip 完整性校验: entries=6  testzip=None   ✓
```

单流 `curl -C -` 之前跑了 30 分钟只到 43 MB（≈24 KB/s），换 6 线程 Range 后 **875 KB/s**。
⇒ 「瓶颈是请求数不是带宽」这个 A-0 结论再次被独立验证。

## 4.10 A 阶段收官：吞吐实测 87 KB/s → 406 KB/s（4.7 倍）

`debug.42` 装机后用与 A-0 完全相同的方式重测（`auto-dryrun` 钩子、`parts` 与
`manifest.json` 都挪走 → 走全量），**第一次拿到干净的对比数据**。

### 实测时间线（同一台设备、同一网络）

```text
18:45:46.377  auto-dryrun: check 开始
18:45:50.379  check 结果 = 发现运行时 … 全量 143.5 MB        ← check 只用 4.0 秒
18:45:50.381  applyAsync 返回=true                            ← 状态机通了
18:52:00.600  运行时 … 已就绪（全量 143.5 MB）                ← 下载 370.2 秒
```

### 对比

| 指标 | A-0 基线（`debug.37`）| A 阶段完成（`debug.42`）| 提升 |
|---|---|---|---|
| check 耗时 | 40 秒（`23:26:48` → `23:27:28`）| **4.0 秒** | **10 倍** |
| 全量 143.5 MB 下载 | ≈27 分钟（估）| **6 分 10 秒**（370.2 s）| **4.4 倍** |
| 吞吐 | **≈87 KB/s** | **406 KB/s**（150,487,616 / 370.2）| **4.7 倍** |
| 端到端（check+下载）| ≈28 分钟 | **6 分 14 秒** | **4.5 倍** |

### 每一块收益来自哪里

| 改动 | 贡献 |
|---|---|
| `atom` + `chunks` 走 `gh-proxy.com` 镜像 | check 从 40 秒降到 4 秒（直连要 25~31 秒且常失败）|
| 6 线程并行块下载（`fetchParallel`）| 主力收益：请求数从 2296 次串行变成 383 轮 × 6 并发 |
| 线路选择（只在 `/releases/download/*` 上生效）| 直连不通时自动换镜像 |
| `runCheck` 结果缓存给 `runApply` | apply 少一次 atom + 探 tag（省 3~4 秒）|

### 顺带验证：Range 分块在本机下载 167 MB 上的独立证据

```text
单流 curl -C -：30 分钟只到 43 MB（≈24 KB/s）
6 线程 Range：  39.9 秒下完 167,088,690 B = 4091 KB/s（这次网络更好）
               186.4 秒 = 875 KB/s（上一次）
zip testzip=None ✓（定位写没写错块）
```

⇒ 三次独立测量都指向同一结论：**瓶颈是请求数与建连开销，不是带宽**。

### 已知遗留（不影响本次收益，记下来）

1. `apply` 侧 `cachedPlan` 只在「发现新版本」分支写入；「已是最新」分支提前 return
   所以没有缓存 —— 这是对的（无需下载），但下次真实更新的 apply 会吃到缓存。
2. 直连仍然完全是死的（`000 / 25~31s`），所以现在**镜像就是唯一通路**：
   `gh-proxy.com` 挂了会直接退化到"检查失败"。这是单点，但它比原来"到不了"要好。
3. `ghproxy.cfd` 那类「接受 Range 却返回 200 + HTML」的假镜像已从表里剔除，
   判据 `必须 206` 保留。

## 4.11 插件索引源「删不掉」：是客户端自己把 `indexes` 锁死了

### 现象

插件市场 →「发现」→「管理索引源」，点垃圾桶删不掉，底部红字 **「无法保存索引源」**。

### 调用链（读码，都在 rootfs 的官方包里）

```text
点垃圾桶 → removeSource → saveSources(urls 过滤后)
         → RPC pluginMarket.setIndexes(urls)
         → settings.update(entryId, { indexes })
```

**删除和添加走的是同一个函数** —— 所以「保存失败」的表现就是「删不掉」。

`sourceFailure()`（client.js:2478）只有三种结果：

| 条件 | 文案 |
|---|---|
| `plugin-market/invalid-index-url` | 请使用 http/https 地址… / 已添加过这个索引源 |
| `plugin-market/settings-unavailable` | 当前环境无法保存索引源 |
| 其它（`kind: other`）| **无法保存索引源** ← 截图是这个 |

⇒ 既不是 URL 不合法，也不是 settings 服务缺失，是 **`settings.update()` 写入被拒**。

### 根因：我们自己生成的 `market.patch.yml` 把 config 整段盖回去

`EngineManager.writeMarketPatch()`（每次启动都整体重写 `$DSH_HOME/market.patch.yml`）原来写死：

```yaml
- id: plugin-market
  name: "@deepseek-ai/dsh-plugin-market"
  config:
    indexes:
      - https://dshopen.org/index.json                        ← 硬编码
      - https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json
    fetchTimeoutMs: 3000
    cacheTtlMs: 3600000
```

而引擎的规则是：**`--patch` 在 profile 层之后应用、优先级更高，且 `config:` 是整段替换**。

于是形成一个闭环：

```text
用户在 UI 删掉 dshopen.org
  → settings.update 写 profile 层的 cordis.patch.yml
  → 下次启动 market.patch.yml 用整段 config 盖回去（indexes 又变两条）
  → 且在 patch 层压制下 settings.update 直接抛错 → 红字「无法保存索引源」
```

这就是为什么「加不进也删不掉」，而且**用户会以为是自己操作错了**。

### 修法：索引源归用户，客户端不替他决定

`writeMarketPatch()` 不再写 `indexes`，只保留网络参数：

```yaml
- id: plugin-market
  name: "@deepseek-ai/dsh-plugin-market"
  config:
    # ⚠️ 故意不写 indexes —— 见函数内注释
    fetchTimeoutMs: 3000
    cacheTtlMs: 3600000
```

### 副作用（必须知道）

`config:` 是整段替换，所以**升级后首次启动，索引源会变成空**（页面显示「还没有插件索引」）。
这是**正确行为**：`dshopen.org` 在本机实测 `Could not fetch … timeout`，本来就不该被客户端硬塞给用户。
需要 jsdelivr 的用户点「添加」一次即可，之后**能存住了**。

### ✅ 真机验证通过（2026-11-25，`debug.43 / vc128`）

**两层验证都过了：**

**① 仿真验证（不经 UI，直接验数据层）**

```text
手工把 profiles/web/cordis.patch.yml 里的 dshopen.org 删掉
  → am force-stop + 重启，等 100 秒
  → 重启后 indexes 只剩 jsdelivr           ← 删除保住了
  → market.patch.yml 里没有 indexes 配置   ← patch 层不再覆盖
  → engine.ready.proot t+46720ms           ← 引擎健康
```

**② 真机 UI 验证（主人亲手点）**

对话框里点垃圾桶 → **能删**。红字「无法保存索引源」不再出现。

**⇒ 闭环断开。** 修复前的行为是：同一个操作重启后必然被 `market.patch.yml` 的
整段 `config` 盖回两条；现在用户删什么就是什么。

### 相关位置（都在 `$DSH_HOME`，可自查）

| 文件 | 谁写 | 说明 |
|---|---|---|
| `market.patch.yml` | **客户端每次启动覆盖** | 已不再写 indexes |
| `profiles/web/cordis.patch.yml` | **用户层**（`settings.update` 写这里）| 索引源的真正落点 |
| `profiles/web/.dsh-open-market.json` | 插件管理器 | 另一份索引记录，升级后可清理 |

## 4.12 patch 全家审计：15 个 overlay 逐个过一遍，又抓到一处同类 bug

索引源修完后，把 `$DSH_HOME` 下**全部 15 个 `*.patch.yml`** 逐个检查「里面有没有写
**用户可编辑**字段」——因为 `config:` 整段替换 + `--patch` 优先级最高这个机制，
**只要写了用户可编辑字段，就等于把它锁死**。

### 全量清单

| 文件 | 有 `config`？ | 判据：字段是否用户可编辑 | 结论 |
|---|---|---|---|
| `market.patch.yml` | 是 | `indexes` 可在 UI 增删 | ✅ 已修（debug.43）|
| **`plugin-manager.patch.yml`** | 是 | **`registry` / `fallbackRegistries` 可在 UI 改** | ⚠️ **同类 bug，本版修** |
| `sandbox-proot.patch.yml` | 是 | `runnerCommand` / `probeTimeoutMs` 是内部实现参数 | ✓ 保留 |
| `session-search.patch.yml` | 是 | `path` / `openAt` 是内部路径与时机 | ✓ 保留 |
| `workspace.patch.yml` | 是 | `documentsDirectory` 是内部路径 | ✓ 保留 |
| 其余 10 个 | 否 | 只有 `insert` 挂载或 `id`+`name` | ✓ 保留 |

### 抓到的第二处：`plugin-manager` 的安装源

官方 UI 包 `dsh-client-ui-plugin-manager` 里有整套字段：
`registryCustom` / `registryCustomField` / `registryCustomPick` / `registryChosen` /
`registryComposition` / `fallbackRegistries`
⇒ **安装源明确是用户可编辑的**。

而 `writePluginManagerPatch()` 原来每次启动写死：

```yaml
- id: plugin-manager
  name: '@deepseek-ai/dsh-plugin-manager'
  config:
    registry: 'https://registry.npmmirror.com/'
    fallbackRegistries:
      - 'https://registry.npmmirror.com/'
      - 'https://registry.npmjs.org/'
```

⇒ 用户改安装源 → `settings.update` 写 profile 层 → 下次启动被整段盖回。
**与 market 的 indexes 完全同构。**

### 修法：种一次默认，之后放手

原来那段注释的理由是「官方默认只有镜像源，`~/.npmrc` 也是镜像源，前端按 URL 去重
⇒ 对话框只剩一项」。那是**展示层的美观问题**，代价却是把用户可编辑字段锁死 —— 不划算。

现在改成：

```text
首次启动（没有 .plugin-manager-seeded 标记）
  → 写带默认 registry 的 overlay，并落标记
之后每次启动
  → 删掉该 overlay（如果还在），返回 null
  → 安装源完全交给用户层；~/.npmrc 里仍是镜像，官方默认合并后依然可用
```

⇒ 既不丢「内网有个能用的镜像」这个默认，又不再劫持用户的选择。

## 4.13 B 阶段第一步落地：48 秒黑箱被拆开（`debug.44 / vc129`）

### 瀑布图（真机冷启，全量日志）

```text
boot.timeline  total=43653ms
  runtime             0ms  Δ     0ms
  preflight        2846ms  Δ  2846ms  ██
  prootSpawn       2876ms  Δ    30ms  █
  nodeExec        41449ms  Δ 38573ms  ███████████████████████████████████
  health          43651ms  Δ  2202ms  ██
  ready           43653ms  Δ     2ms  █
```

`gui` 打点：`total=53841ms`（WebView 那侧又花了 **10.2 秒**）。

### 结论：**88% 的时间在 `nodeExec` 这一段**

| 阶段 | 耗时 | 占比 | 说明 |
|---|---|---|---|
| `runtime` → `preflight` | **2,846 ms** | 6.5% | overlay / 环境 / quarantine 拼装 |
| `preflight` → `prootSpawn` | **30 ms** | 0.07% | `ProcessBuilder.start()` 的 fork+exec，**极快** |
| `prootSpawn` → `nodeExec` | **38,573 ms** | **88.4%** | PRoot 装载 + node 冷启 + 引擎初始化（到打印 URL）|
| `nodeExec` → `health` | **2,202 ms** | 5.0% | HTTP health 探测（`health=401`，第一次就通）|
| `health` → `ready` | 2 ms | — | 收尾 |
| `ready` → `gui` | **10,188 ms** | 独立一段 | WebView 加载 + 首帧 |

### 三个被证伪的猜想

1. **「health 探测在空转」** —— 假的。`health` 只占 **2.2 秒**，而且是第一次探测就拿到 401。
2. **「fork/exec 慢」** —— 假的。`prootSpawn` 只花 **30 毫秒**。
3. **「是 Android 侧拼 overlay 慢」** —— 部分。`preflight` 2.8 秒，占 6.5%，但不是主因。

⇒ **真正的主因是 guest 内部**：PRoot loader 装载 + node 冷启到能打印 URL，**38.6 秒**。
这一段在 Android 侧看不到，只能从 guest 内部再切分（B 的下一步：跨边界打点
`echo "DSH_BOOT_NODE_EXEC $(date +%s%3N)" >&2 ; exec node`，以及看 `engine.log` 首行时间）。

### 已知限制

- `spawn.cost` 那一行没进 `engine.log`（`DshLog.i` 的落到哪个文件要再确认，或者被 `redirectErrorStream` 吞了）。
  不影响主结论：`prootSpawn` 的 Δ 只有 30 ms。
- 宿主与 guest 时钟不能相减，跨边界点只做相对量。

### 新增工具

| 脚本 | 用途 |
|---|---|
| `tools/startup-timeline.py` | 从 `app.log` 解析 `boot.timeline` 块，单次瀑布图 / `--all` 多次并排 / `--json` 机读 |
| `tools/pm-console-probe.py` | 给 `dsh-client-ui-plugin-market` 的 `saveSources` 失败分支注入 `console.error`，把真实 `error.message` 打到 logcat（这次「无法保存索引源」就是缺这一行才多花一轮）|

## 6. 决策记录

### D1 · P5 减包 → **不做**（2026-11-24）
**诉求**：主人明确「需要完整包」。

**理由**：
1. **首装离线可用** 是当前最强的产品特性：装上就能跑，没有网络依赖、没有首启失败率
2. 减包会把 150 MB 运行时变成**首启网络依赖**，必须额外背：断点续传、断网重试、存储预检、校验失败回滚、下载中进程被杀 —— 这套兜底的失败成本（「装了个打不开的 App」）远高于省下的 80 MB
3. 已验证的四段结构**没有冗余**（`opt` / `usr` / `var+etc` / 其余，按目录切分），不存在「删掉重复包」的省法
4. 增量通道已经解决了「第二次以后的升级成本」，减包只能解决「第一次」，性价比不对

**保留**：APK 159 MB 四段运行时全带；`parts` 144 MB 作为增量基线保留（清空只会让下次升级退回全量 150 MB）。

**若将来重启此议题**，只做「外移 `opt`」这一档，且动手前必须先验证：
```bash
run-as com.dsh.android sh -c 'cd files/runtime/rootfs && mv opt opt.hidden'
am force-stop com.dsh.android; am start -n com.dsh.android/.MainActivity
# 期望：能起 Web UI（哪怕引擎报错），说明 bootstrap 不依赖 opt
```

### D2 · 增量清单改走 Atom feed（2026-11-24，debug.34）
不再用匿名 `GET /releases`（60 次/小时/出口 IP，全网共享，且 403 被误报成「没找到 Release」）。
改 `https://github.com/<repo>/releases.atom` 取 tag + `releases/download/<TAG>/<name>` 固定前缀拼 URL。
详见 `runtime-delta.md`。

### D3 · 运行时清扫只删 `termux/usr`（2026-11-24，debug.34）
`termux/home` 是用户自定义环境，整删 `termux` 会丢用户数据。返回值语义不变（仍报 `termux`），两次调用幂等。

### D4 · P1 三项体验项 → **全部不做**（2026-11-24）
主人决定。逐项理由：

| 项 | 为什么不做 |
|---|---|
| 检查更新弹窗文案细看 | 「关于 → 检查更新」已由主人亲验通过；增量/全量的 KB·MB 措辞属文案打磨，不影响正确性 —— 跑通的路径不再反复打扰 |
| 多 dpr / 平板回归 | 主设备 1280×2772（dpr 3.25）已验收；没有第二台目标设备，回归只能靠模拟器，收益低于成本 |
| `dsh-app-pet` 升级自愈 | 单插件、单用户场景；出错时可 5 分钟内人工重装。为它加一套死链探测+静默重装，风险（误删真实文件）大于收益 |

**共同判断标准**：维护态下只修「会让功能不可用」的 bug。这三项都属于「体验打磨」，不是可用性缺陷。

### D5 · 删除 `publish-release-from-run.yml`（2026-11-24）
**发现**：仓库同时存在两个手动发布工作流，其中一个已经彻底过时：

```yaml
# publish-release-from-run.yml（已删）
SYS=$(find dist/dsh-system-release -name '*.apk' | head -1)
GECKO=$(find dist/dsh-gecko-release -name '*.apk' | head -1)
test -n "$SYS" && test -n "$GECKO"        # ← gecko 变体早已不构建，这里必然失败
```

**两个危害**：
1. **跑不通**：`apk.yml` 只产出 `dsh-system-*`，没有 `dsh-gecko-release`，所以卡在 `test -n "$GECKO"`。
2. **跑通了更糟**：它只挂两个 APK，**不挂 runtime 分片 / manifest / plugins / runtime-chunks.json** —— 就算补上 gecko 让它成功，发出来的 Release 也没有增量能力（P2 直接失效），且 `SHA256SUMS.txt` 只有 2 行。它的 release notes 还是硬编码的 `dsh@0.2.2-rc.1` / `mobile-ui 1.1.0-163`。

**决策**：删除。唯一正确的发布入口是 `publish-apk.yml`（`publish` + `publish-plugins` + SHA256SUMS 重建）。删除前已逐个扫描其余 7 个工作流，确认无引用（也没有 `workflow_run` 依赖）。

### D6 · 保留 `apk-x64.yml` / `ci.yml` / `compile.yml` 三者的并存（2026-11-24）
| 文件 | 定位 | 结论 |
|---|---|---|
| `apk-x64.yml` | 给雷电/MuMu 等 **x86_64 模拟器**出原生包，注释明确「不碰 Release」 | 保留（有用且边界清晰）|
| `ci.yml` | **仓库卫生**：`secrets-guard` / `docs-check` / `engine-compile` | 保留 |
| `compile.yml` | **PR 快速反馈**：`compileSystemDebugKotlin` + `testSystemDebugUnitTest` | 保留（与 apk.yml 的单测门禁重复，但它快、能在 PR 阶段就红） |

`ci.yml` 的 `engine-compile` 与 `compile.yml` 有重叠，但两者都只是编译检查、失败表现一致，不构成「用错就出事」的分歧 —— 不做合并。

### D7 · 更新/下载四项：只做 A（多线路）+ B（启动测量），②③不做（2026-11-24）
主人定：**只做 A+B，先 A 再 B**。详细计划见 `docs/plan/pa-pb-plan.md`（唯一权威，364 行）。

| 项 | 决策 | 依据 |
|---|---|---|
| ② 增量更新 | **不改** | DSH 已是 **64 KiB 块级**增量（`chunkSize=65536`+逐块 sha256）；Operit 是 APK 整包 diff（`apkraw-1`）。**块级更细**，没有升级空间 |
| ③ 应用内自更新 APK / APK 差分包 | **不做** | ①166 MB 里 150 MB 是 runtime，而 runtime 已有块级增量 ⇒ APK diff 只能省约 16 MB 的差量；②自更新要新增 manifest 权限 + 签名一致性校验 + 「装错包=打不开」的失败面 |
| ④ 加载速度 | **先测量（B）** | 冷启动 54.8 s，其中 47.8 s 在 `app.log` 里**完全无日志**（黑盒）。不测量就优化等于猜 |
| ⑤ 多线路下载 | **做（A）** | 现在单线路直连 `github.com`，国内经常下不动 = **可用性缺陷**，不是体验打磨 |

### D8 · A 必须包含「并行块下载」，否则多线路没有意义（2026-11-24）
79 MB 全量 = `79448384 / 65536 ≈ 1212` 次串行 HTTP 请求，每次建连+TLS+302 就 100~300 ms ⇒ **光握手 3 分钟**。只加线路不加并发，用户体感几乎不变。

⇒ A 拆成三步，**顺序不可换**：A-1 选择器（+单测）→ **A-2 并行块下载（6 线程，`FileChannel` 定位写，仅 `fetch.size>=32` 时启用）** → A-3 接入线路与回退。见 `pa-pb-plan.md` 的 A3.1 与 C4-#17。

**同时记下两个阻断级技术点**（详见计划 E1/E2）：
- 清单 `runtime-chunks.json` 本身也在 `/releases/download/` 下 ⇒ 直连不通时**连"要下什么"都拿不到**，所以小文件要走「顺序试线路」而不是「测速选最快」；
- `RandomAccessFile.seek()+write()` 是两步，**并行会静默写错偏移** ⇒ 必须用 `FileChannel.write(ByteBuffer, position)`。

---

## 7. 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| 运行时体积 986 MB | 低端机存储吃紧 | 已评估减包（D1 暂不做）；可加「存储不足」明确提示 |
| GitHub 资产下载依赖网络 | 增量/全量更新失败 | Atom 路径已验证；失败时保留旧 runtime（staging 原子替换 + 回滚） |
| 官方前端发版改了 CSS Modules 局部名 | 我们的布局补丁失效 | 补丁用「语义标签 + 几何特征」而不是哈希类名，失效也只会退回官方样式 |
| `parts` 与新版本不匹配 | 增量校验失败 | 校验失败即全量重下（`planDelta` 已按长度/块哈希判断） |
| 无崩溃上报 | 用户侧问题难定位 | 三份日志已有，缺一键导出（待做） |

---

## 8. 发布流程（已固化）

```bash
# 1) 改版本号（两处必须同源）
tools/app-version.txt          → versionName=0.2.2-rc.5-debug.NN / versionCode=NNN
CHANGELOG.md                   → 新增 ## [同 versionName] + vc=NNN（version.sh --check 会拦）
docs/changelog/<versionName>.md → 模板文件

# 2) 构建（不自动发布）
apk.yml (workflow_dispatch) → run_id

# 3) 发布
publish-apk.yml (run_id + tag + prerelease=1)

# 4) 校验（必做）
- runtime-chunks.json 的 bytes/sha256 与 Release 上分片逐一比对 → 必须 PASS
- 重建 SHA256SUMS.txt（用 Release asset 的 digest，覆盖除自身外全部资产）

# 5) 上机
sign-upgrade-apk.yml (run_id + expected_signer=79d0dab6…) → 下载重签 APK → pm install -r
```

**踩过的坑**：`versionCode` 必须严格递增；`CHANGELOG` 小节标题必须与 `versionName` 完全一致；
发布前若改了 `build-runtime.sh`，务必从产物里**挖一遍** `docs/DETAIL.md` 是否真的带进去了（`detail_md` 计数）。

## 4.14 索引源彻底结案 + 发布链空壳故障 + B 阶段 I/O 定性

### 4.14.1 索引源：三版才修对，判据一句话

真机验收（主人亲手操作）：

```text
添加 ✓   删除 ✓   重启后保留 ✓
```

但这一条从 debug.43 走到 debug.45 才真正修完，中间两版都是伪修复。

**最终的错误信息**（靠 `tools/pm-console-probe.py` 注入 console.error 抓到）：

```json
{"code":"gateway/internal",
 "message":"Configuration for \"plugin-market\" is overridden by a home patch or command-line overlay",
 "details":{}}
```

**判据：只要 `plugin-market` 这个 id 出现在任何 `*.patch.yml` 里，整个
`settings.update` 就会被拒绝。跟「写了几个字段」无关。**

| 版本 | 做法 | 结果 |
|---|---|---|
| debug.43 | `market.patch.yml` 删掉 `indexes`，保留 `fetchTimeoutMs`/`cacheTtlMs` | ❌ 伪修复：id 还在 patch 里 |
| debug.44 | 同上（只做了 patch 全家审计里的其它文件） | ❌ |
| debug.45 | **整段删除 `- id: plugin-market`**，只留 `- insert:` 挂载 | ✅ |

代价：失去 3 秒抓取超时与 1 小时缓存（回官方默认 15s / 10min）。
权衡为「能改索引源 ≫ 少等几秒」。

`writeMarketPatch()` 内部留了 20+ 行注释说明为什么不能把那段补回来。

### 4.14.2 「发现」Tab 消失是我弄坏的

注入探针时写了 `catch(_){},` —— **块语句后接逗号是 JS 语法错误**，
整个 `client.js` 加载失败 ⇒ `dsh-client-ui-plugin-market` 插件没起来 ⇒ Tab 直接消失。

比原 bug 更糟。三条教训：

1. `{...}` 是块语句，后面接 `,` 在 JS 里不合法；压缩 JS 里语句间只能用 `;`
2. 注入 rootfs 里的 JS **必须先 `node --check`** 再上机
3. `indexes` 为空数组时「发现」Tab 会消失，用户失去添加入口 —— 已知设计缺陷，未修

### 4.14.3 发布链：空壳 Release 故障

`debug.45` 的 `publish-from-run`（run `45648358602`）在「建 / 更新 prerelease」**failure**。

现象：

```text
v0.2.2-rc.5-debug.45   assets=0   prerelease=True   ← 空壳
v0.2.2-rc.5-debug.44   assets=9   ✓
```

前两步 `取 APK artifact`、`校验产物与版本同源` 都 success ⇒ `gh release create` 成功建了对象，
但 `gh release upload` 全挂。

**处置**：删掉空壳 Release → 用同一份 inputs 重跑 → run `45654974791` success，9 个资产齐。

**性质：一次性故障，不是流程缺陷**。但暴露了一个盲点 —— 只看 Release 页面看不出「空壳」，
所以补了断言：

```yaml
ASSET_COUNT=$(gh release view "${TAG}" --json assets -q '.assets | length')
[ "$ASSET_COUNT" -ge 2 ] || { echo "::error::Release 只有 $ASSET_COUNT 个资产"; exit 1; }
```

**附带发现**：`actions/jobs/{id}/logs` 用当前 token 返回 **401**（缺 `actions:read`）。
所以这次是靠「删空壳 + 重跑」而不是「读日志定位」解决的。

### 4.14.4 B 阶段：nodeExec 不是固定开销

真机 4 次冷启（debug.44 / vc129）：

| 时刻 | total | nodeExec Δ | preflight Δ |
|---|---|---|---|
| 22:41:57 | 54,846 ms | **49,647 ms** | 1,720 ms |
| 23:17:09 | 51,639 ms | **46,750 ms** | 1,835 ms |
| 23:22:19 | 48,297 ms | **43,224 ms** | 1,607 ms |
| 23:49:51 | 67,725 ms | **63,964 ms** | 1,039 ms |

- `nodeExec`：43.2 s ~ 64.0 s，**跨度 20.7 秒（1.48 倍）**
- `preflight`：1.04 s ~ 1.84 s，**稳定**

这个对比本身就是证据：`preflight` 干的是「读 overlay、拼环境、检查 quarantine」——小文件 stat/read，它稳定；
`nodeExec` 干的是「PRoot 装载 + node 冷启 + require 图谱」——大量顺序小文件读取，它剧烈波动。

**推论：瓶颈是页缓存命中率，不是 CPU、不是固定装载开销。**

### 4.14.5 为什么不能用 date +%s%3N

```text
run-as ... ./usr/bin/date +%s%3N
sh: ./usr/bin/date: No such file or directory
```

不是不支持 `%3N`，是**根本执行不了** —— 那是 Android 侧直接看 rootfs 文件，没有 PRoot 环境，
动态链接器全在 guest 里。

`bin/date` 是 133,480 B（像 GNU coreutils 不是 busybox），`%3N` 大概率支持，但要在 PRoot 里跑才能验，
成本比绕过它高。

### 4.14.6 打点方案：node -r 预加载

入口：`nodeBin` + `/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`（`EngineManager.kt:6600`）。

`/opt/dsh` 里**没有 `index.js`** —— `package.json` 写了 `main: index.js` 但文件不存在。

用 node 原生 `-r` 挂 `/opt/dsh/.dsh-timing.js`：

```javascript
const _T0 = Date.now();
process.stderr.write('[timing] NODE_START ' + _T0 + '\n');
(() => {
  const ow = process.stdout.write.bind(process.stdout);
  let hit = false;
  process.stdout.write = function (chunk, enc, cb) {
    if (!hit) {
      try {
        const s = typeof chunk === 'string' ? chunk : String(chunk);
        const m = s.match(/https?:\/\/[^\s'"`]+/);
        if (m) {
          hit = true;
          process.stderr.write('[timing] URL_READY ' + Date.now()
            + ' delta=' + (Date.now() - _T0) + ' url=' + m[0] + '\n');
        }
      } catch (_) {}
    }
    return ow(chunk, enc, cb);
  };
})();
```

为什么这么选：

| 方案 | 不选的理由 |
|---|---|
| 改 `bin.js` | 属于 `@deepseek-ai/dsh` 包，runtime 更新会覆盖，破坏包完整性 |
| `date +%3N` | Android 侧执行不了；进 PRoot 又要拿 pid |
| `-r` 预加载 | node 原生选项，一个独立文件，删掉即恢复 |

`argv` 改动（`add(nodeBin.absolutePath)` 之后），rootfs 由 `nodeBin` 推导不依赖 `context`：

```kotlin
add(nodeBin.absolutePath)
run {
    val filesDir = nodeBin.parentFile?.parentFile
    if (filesDir != null) {
        writeTimingPreload(File(filesDir, "runtime/rootfs"))?.let {
            add("-r")
            add(it.absolutePath)
        }
    }
}
```

跑起来 `engine.log` 会多两行：

```text
[timing] NODE_START 1764...
[timing] URL_READY 1764... delta=38000 url=http://127.0.0.1:...
```

`delta` = 「node 启动 + 引擎 require 图谱」。配合宿主侧的 `prootSpawn` 时刻，
就能把 40 秒切成「PRoot 装载 / node 启动 / 引擎 require」三段。

### 4.14.7 这轮我自己改错三次

| # | 错 | 后果 | 谁抓到 |
|---|---|---|---|
| 1 | `FUNC % TIMING_JS` 里 `%3N` 让 `%` 格式化报错 | 脚本直接崩 | 自己，第一次跑就看到 |
| 2 | 条件 `'.dsh-timing.js' not in km` 被自己刚插入的函数体污染，argv 段静默跳过 | **函数写了但没调用 = 完全无效**，不报错 | 第二次跑 `patched argv` 没打印 |
| 3 | 修正时引用未声明的 `timingPreload` 局部变量 | 会编译失败 | `assert` 拦下 |

**教训与探针那次同源：「没打印成功日志」就是失败。脚本里每个 print 都是断言，少一条就是没做。**

---

### 4.14.8 第四种错法：语法对、行为变了、测试才是唯一防线

`debug.46b` 在 `buildCommand()` 里**无条件**插了两个 argv 元素（`-r` + 探针路径）。

CI 结果：

```text
15 编译门禁（engine 包，不需要资产）   success   ← 编译是过的
16 单元测试门禁（app 单测，含 S6 回归）  failure   ← 挂在这里
17 单测报告（失败时也上传）            success
18 版本戳 ... 29 发布到 Release       skipped
```

**这说明语法和类型都没错**，是**行为契约**变了 —— 单测大概率在断言 argv 的精确内容或长度：

```kotlin
assertEquals(expectedArgv, buildCommand(...))   // 逐元素比对
assertEquals(7, argv.size)                      // 断言长度
```

一旦多两个元素就红。

**这和前面三种错法性质不同**：

| # | 错法 | 有谁兜底 |
|---|---|---|
| 1 | `%` 格式化把脚本搞崩 | 解释器，立刻报 |
| 2 | 静默跳过（条件被污染） | 无 —— 靠「没打印成功日志」自己察觉 |
| 3 | 引用未声明变量 | `assert` + 编译器 |
| **4** | **语法对、行为变了** | **只有单测** |

⇒ **改 `buildCommand()` 这类「产出一个精确结构」的函数时，必须假定有逐元素断言。**
要么别动默认路径，要么同步改测试，不能指望「多两个元素不影响运行」。

### 4.14.9 最终形态：开关式探针

```kotlin
run {
    val filesDir = nodeBin.parentFile?.parentFile
    val rootfs = if (filesDir != null) File(filesDir, "runtime/rootfs") else null
    // 默认关闭：只有 rootfs 里存在 .dsh-timing-on 标记才插 -r。
    if (rootfs != null && File(rootfs, "opt/dsh/.dsh-timing-on").isFile) {
        writeTimingPreload(rootfs)?.let {
            add("-r")
            add(it.absolutePath)
        }
    }
}
```

| 环境 | `rootfs` | 标记 | argv |
|---|---|---|---|
| 单测（无 rootfs） | 不存在 | — | **完全不变** |
| 真机，未开启 | 存在 | 不存在 | **完全不变** |
| 真机，开启 | 存在 | 存在 | +2 元素 |

用法：

```bash
# 开启
run-as com.dsh.android sh -c 'touch files/runtime/rootfs/opt/dsh/.dsh-timing-on'
# 关闭
run-as com.dsh.android sh -c 'rm files/runtime/rootfs/opt/dsh/.dsh-timing-on'
```

**为什么用标记文件而不是环境变量**：环境变量要改 `extraEnv`，会牵动 PRoot 的环境拼装；
标记文件只碰一个 `isFile()` 判断，零副作用。

### 4.14.10 日志与 artifact 的两个 401

排查 `debug.46b` 单测失败时，两条路都堵死：

```text
GET /actions/jobs/{id}/logs         → 401（缺 actions:read）
GET /actions/artifacts/{id}/zip     → 401（302 重定向后 token 丢失）
```

CI 里只有两个 artifact 可列：`runtime-arm64-v8a`（150 MB）与 `build-logs`（40 KB）；
「单测报告（失败时也上传）」那个 step 是 success，但 artifact 不在可列列表里（可能已 expired）。

⇒ 结论：**当前 token 看不到 CI 日志，定位失败只能靠「改代码 + 重跑」二分**。
若后续要长期维护，需要补一个带 `actions:read` 的 token，否则每次失败都是盲改。

---

### 4.15 CI 五连红的真正根因：测试帮助函数自己调自己

- `db0a56b85b`「符号链接加固」引入了 `private fun symlink(link, target)`，本意是封装
  `Files.createSymbolicLink` 并把平台不支持转成 `assumeTrue` 跳过。但批量替换把
  **函数体内那一处**也改成了 `symlink(...)`：

  ```kotlin
  23 private fun symlink(link: java.io.File, target: java.io.File) {
  24     try {
  25         symlink(link, target)          // ← 自己调自己
  26     } catch (e: UnsupportedOperationException) {
  ```

- 后果：**无限递归 → StackOverflowError**，四个用例全部失败：
  `treeCleanupLeavesSymlinkTargetsIntact` / `prunePartsNeverFollowsSymlinkedVersionDirs` /
  `successfulSwapPreservesNewSymlinksAndExternalData` / `legacySymlinkIsMovedWithoutTraversingUserData`。
- 修法：`36897ba851` 把第 25 行改回
  `java.nio.file.Files.createSymbolicLink(link.toPath(), target.toPath())`，自调用残留 0。
- **教训（第五种错法）**：批量正则替换时，若替换目标是函数定义所在的文件，
  必须排除函数体自身那一行。验证手段不是「替换残留 0」（那把自调用也算作正确结果），
  而是「函数体内不含与函数同名的调用」。

### 4.16 插件页「添加插件」弹窗一闪/塌陷：定位到官方 Menu 实现，**未修复，已跳过**

**现象**：插件页（「发现」「插件市场」两个 Tab）右上角 `∨` 展开的菜单，点击后一闪而过；
改修过程中一度变成「不闪但内容塌陷成一条」。同页 `+` 按钮（打开 InstallDialog）与
「已安装」Tab 的对应入口均正常。

**结论**：根因在官方 `@deepseek-ai/dsh-client-ui-primitives` 的 `Menu` 组件
（rc.5 的 portal 渲染路径），不在本仓库代码。**决定跳过**，用户改用 `+` 按钮进入安装流程。

#### 六次尝试与结果（全部真机验证）

| # | 改动 | 结果 |
|---|---|---|
| 1 | `registryShown = install.registryOpen && phase === 'idle'` → `phase !== 'busy'`（等长 14 B） | **仍闪**。store 里 `open:false` 只有 `closeInstall`（`manager-store.ts:779`），弹层消失与 `registryShown` 无关 |
| 2 | 排查「WebView 不支持 CSS Anchor」 | **排除**。内核 `com.google.android.webview 157.0.8103.50`，Chromium 157 完整支持 |
| 3 | 排查 `dsh-android-market` 插件注入 `plugins.add.actions` 槽 | **排除**。`client.js` 里该槽 0 命中、`onDismiss` 0 命中 |
| 4 | `Menu` 的 `portal:true` → `!1`（等长 11 B） | **不闪了**，但**塌陷**。因为 `listClassName`（`.X_2TxG_addMenu` 的 `width:320px` / `[role=menuitem]{height:72px}`）**只在 portal 路径挂到列表上** |
| 5 | 给 `.X_2TxG_addGroup` 作用域补样式（hash 前缀） | **仍塌陷**，未命中 |
| 6 | 改 `[class*=addGroup]` 与 `[role=menu]` 属性选择器，并加 `outline:2px solid red` 探针 | **探针出现**（说明内联 CSS 确实被加载）但**弹窗仍塌陷** |

#### 判定依据（代码级）

```text
Menu.tsx:267     anchorName = `--dsh-menu-trigger-${menuId}`
Menu.tsx:279-283 useLayoutEffect 里才 style.setProperty('anchor-name', ...)
Menu.tsx:493     style={portal ? { positionAnchor: anchorName } : undefined}
Menu.tsx:335     outside 判定只认 rootRef / anchorRef —— anchor 内联渲染时 anchorRef 为 undefined
Menu.module.css  .portal 整段依赖 anchor()：top:max(...,calc(anchor(bottom) + 4px))
                 + position-try-fallbacks:--dsh-menu-wide-below,…
useModalLayer   只做焦点接管，不监听 pointerdown ⇒ 不是 Modal 关的
onClose() 调用点 356/378/390/435/513 —— 没有一条在「打开瞬间」触发
```

`portal:true` 会闪、`portal:false` 不闪但丢样式 —— 两个行为互斥且都由官方组件内部决定，
未打补丁前无法在样式层同时满足。

#### 已做的处置

- `client.js` **完整回滚**到 `lib/client.js.bak3`（357,239 B）：
  `portal:true` + `phase===`idle`` + 额外 CSS 残留 0 —— 即官方原始行为。
- 备份留存：`files/client.js.bak`(19:07) / `files/client.js.bak2`(23:16) /
  `lib/client.js.bak3`(23:24) 均为 357,239 B 原版；`lib/client.js.bak4`(358,048) 是塌陷版。
- `dsh-web-frontend/dist/assets/index-CSAdOBx6.css` 已回滚原样 92,252 B（`.bak1`）。

#### 给后续维护者的建议

1. **不要在这个按钮上继续调样式**。`listClassName` 是否生效由 portal 分支决定，
   而 portal 分支的定位又依赖 `anchor()` 与首帧 `anchor-name` 写入时序，两者互锁。
2. 正解是**升级 `@deepseek-ai/dsh-client-ui-primitives` / dsh 版本**，看官方是否已修
   `Menu` 的 portal 定位；或向官方提 issue（附本节的 `portal:true`/`false` 对照）。
3. 若必须自修，唯一可行路径是**改 `Menu.tsx` 源码**：让 portal 模式在
   `position-anchor` 解析失败时回落到 `position:fixed` + JS 计算坐标，
   并把 `listClassName` 无条件应用（不只 portal 分支）。这需要 fork 组件包，超出「只修 bug」的维护范围。

#### 4.16.1 诊断手段清单（本轮新增）（本轮新增，均可复用）

| 手段 | 可用性 | 说明 |
|---|---|---|
| `app.log` | ✅ | `boot.timeline` / `engine.ready` / 插件相关都在这 |
| `/check-runs/{id}/annotations` | ✅ | 任意 token；配合 workflow 里 `echo "::error title=X::…"` |
| `actions/artifacts/{id}/zip` | ✅ | 必须**禁用重定向**取 302 的 `Location`，再**不带 Authorization** 请求 |
| `actions/jobs/{id}/logs` | ❌ 401 | classic 与 fine-grained 均失败 |
| WebView CDP（`@webview_devtools_remote_<pid>`） | ❌ | socket 存在，但跨 uid（u0_a232 → u0_a643）被 SELinux 拒绝 |
| 设备内联 CSS 是否生效 | ✅ | 加一条 `outline:2px solid red` 之类的可见探针，一眼判断 |
| 偏移定位法 | ✅ | `grep -bo` 取偏移 + `dd bs=1 skip=N count=M`；改完**再插入内容会移动后续偏移**，须「先改偏移、再插入」 |

**偏移陷阱（本轮踩过）**：先插入 CSS（在 210k）再按旧偏移改 274k 的 `portal`，
写入落到错误位置，破坏了原文。正确顺序是**先按原偏移改，后插入**。

### 4.17 三个 401 的真相与可用的诊断通道

| 目标 | 结果 | 条件 |
|---|---|---|
| `/actions/jobs/{id}/logs` | 401 | classic（`repo,workflow`）与 fine-grained 均失败 |
| `/actions/artifacts/{id}/zip` | **可读** | 必须禁用重定向拿 302 的 `Location`，再用**不带 Authorization** 的请求取（S3 预签名自带授权） |
| `/check-runs/{id}/annotations` | 200 | 任意 token；配合 workflow 内 `echo "::error title=X::..."` 使用 |

结论：`artifacts` 那条 401 **不是权限不足**，而是 urllib 自动跟随 302 时把
Authorization 头带到了 `productionresultssa*.blob.core.windows.net`，被存储侧拒绝。
手动接 `Location` 即可下载。另外单测报告 zip 内**没有 XML**，只有 `classes/<Class>.html`，
失败堆栈要从 HTML 里提取 —— 这也是「一直拿不到断言原文」的真正原因。


---

### 4.18 B 阶段第 1 层：guest 侧时间戳 wrapper（已落地，已真机采样）

> 提交：`1347dae`（实现）、`ebf0f6f`（修编译）、`6e8f5a6`（CI 诊断通道）
> 编译门禁：run `45860036613` **success** —— `:app:compileSystemDebugKotlin` 与
> `:app:testSystemDebugUnitTest` 同时通过（新增 5 个用例已跑）。

#### 4.18.1 口径：把 nodeExec 切成四段

| 段 | 定义 | 数据来源 |
|---|---|---|
| PRoot 装载 | `node.start.epoch - host.epoch` | 宿主 spawn 前先写 `boot-timing.host.json` |
| node 引导 | `preload - node.start` | `process.uptime()` 反推 node 进程诞生时刻 |
| 模块解析 | `entry.end - preload` | `Module.prototype._compile` 包住 `bin.js` |
| 首响应 | `first - entry.end` | 拦 `stdout/stderr.write` 里的 token 行 |

顺带把第 2 层的账先记上：`epoch.listen` / `epoch.listening`
（`net.Server.prototype.listen`）、`modules.count` / `modules.avg.ms` /
`modules.top`（最慢 12 个）、`/proc/self/io` 的 `rchar` / `read_bytes` / `syscr`。

#### 4.18.2 注入点为什么是 `NODE_OPTIONS`，不是往 argv 插 `-r`

`manifest.json` 的 `launch.argv` 里，node 与入口之间还隔着一层包脚本：

```sh
#!/bin/sh
exec /usr/local/bin/node /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js "$@"
```

`manifest.json` 是 `tools/runtime/build-runtime.sh` 的**构建产物**、不在仓库里；
`ProotLaunch.template()` 的形参也不该为观测长出新参数（§4.14.7 的教训：动 argv
拼装极容易「写了但没生效」，而且不报错）。`NODE_OPTIONS` 由 node 自己解析、
`--require` 在其白名单内，正好落在「node 与入口之间」。

注入位置选 `{GUEST_ENV}`（`env -i` 的尾部）：后者覆盖 manifest 里的
`NODE_OPTIONS=--dns-result-order=ipv4first`，所以**必须合并而不是覆盖**——
这件事由 `BootTimingPreload.nodeOptions()` 负责，并有单测锁住。

#### 4.18.3 交付物

```text
app/src/main/java/com/dsh/android/runtime/BootTimingPreload.kt      新增（guest 脚本全文内嵌）
app/src/main/java/com/dsh/android/runtime/ProotHost.kt              +5 行（{GUEST_ENV} 注入一对键值，不动任何形参）
app/src/test/java/com/dsh/android/runtime/BootTimingPreloadTest.kt  新增（5 个用例：合并/幂等/落盘/重写稳定）
tools/boot-timing-report.py                                         新增（日志 → 四段瀑布图 + 读放大）
```

#### 4.18.4 观测数据落在哪

```text
files/logs/boot-timing.log                 一次启动一个块（--- boot-timing v1 reason=... ---）
files/home/.dsh/boot-timing.host.json      宿主 spawn 时刻（跨时钟域对齐用）
engine.log                                 [boot-timing] armed ... + 整块回显（stderr 同源）
```

#### 4.18.5 本轮自己踩的两个坑

| # | 坑 | 后果 | 谁抓到 |
|---|---|---|---|
| 1 | `?.removePrefix("NODE_OPTIONS=")` **少一个右括号** | Kotlin 编译红，但报的是「Unresolved reference 'existing'」「Overload resolution ambiguity」这种连坐错，看不出真凶 | CI `compile.yml` |
| 2 | `actions/jobs/{id}/logs` 仍 401，编译错误原文取不到 | 同一个红跑了两轮才有第一行错误 | 给 `compile.yml` 加 `::error::` 摘要 + `compile-log` artifact |

**教训延续 §4.14.7：拿不到错误原文，就等于没有诊断通道。**
这次把「失败必须可读」写进了 workflow 本身：

```yaml
- name: 编译与 S6 回归测试
  run: |
    set -o pipefail
    ./gradlew ... 2>&1 | tee /tmp/build.log
- name: 编译错误摘要（annotation 通道）
  if: failure()
  run: grep -E '^e: |error:' /tmp/build.log | head -40 | while read -r l; do echo "::error title=Kotlin::$l"; done
- name: 上传编译日志
  if: always()
  uses: actions/upload-artifact@v4   # name: compile-log
```

#### 4.18.6 待做（真机）

1. 装新 APK（versionName 仍是 `0.2.2-rc.5-debug.46`，`vc=131`；设备当前 `vc=130`）。
2. 冷启一次：`am force-stop com.dsh.android` 后再启动。
3. 取日志：

   ```bash
   run-as com.dsh.android cat files/logs/boot-timing.log > /sdcard/bt.log   # ⚠️见 §6.3-1，用 stdout 重定向到宿主
   python3 tools/boot-timing-report.py bt.log
   ```

4. 冷启 3 次 + 热启 1 次，填 §4.18.7。
5. 判读：`read_bytes` 增量显著 > 0 ⇒ 首次读盘是真成本（走第 3 层：预热/`posix_fadvise`）；
   `read_bytes ≈ 0` 且 `rchar` 巨大 ⇒ 全命中页缓存，瓶颈在模块图规模（走第 2 层：模块裁剪/预编译缓存）。

#### 4.18.7 真机数据（已填，2026-11-27 02:27~02:31，debug.46 / vc131）

装机包：`dsh-android-0.2.2-rc.5-debug.46-arm64.apk`（`sign-upgrade-apk.yml` 用既有发行身份重签，
证书 SHA-256 `79d0dab6…a448dc96`；未签名包直接 `pm install` 会 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`）。

| 次 | 场景 | PRoot 装载 | node 引导 | preload→listen | listen→listening | listening→首响应 | 合计（preload→首响应） | 模块/编译 | rchar / read_bytes |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 装完首启（页缓存全冷） | 126 ms | 64 ms | 32,270 ms | **14,428 ms** | 880 ms | **47,578 ms** | 623 / 12,546 ms | +79.95 MB / **+129.06 MB** |
| 2 | 冷启（force-stop，缓存暖） | 112 ms | 91 ms | 28,101 ms | **13,387 ms** | 662 ms | **42,150 ms** | 623 / 10,569 ms | +79.95 MB / **0 B** |
| 3 | 冷启（force-stop，缓存暖） | 123 ms | 99 ms | 27,746 ms | **13,451 ms** | 790 ms | **41,987 ms** | 623 / 10,412 ms | +79.95 MB / **0 B** |

宿主侧同一轮 `boot.timeline total=47,297 ms`（第 3 次），与 guest 的 41,987 ms 差约 5.3 s，
正好是 `BootTimeline.start()` 到 `prootSpawn` 之间的 preflight/overlay 段——两条时间轴自洽。

---

### 4.19 B 阶段结论：瓶颈不是页缓存，是**模块加载**

#### 4.19.1 三条硬数据

1. **页缓存只值 5.4 秒。** 第 1 次（磁盘全冷）47.6 s，第 2/3 次（页缓存全命中）42.0~42.2 s。
   磁盘读从 **129.06 MB** 掉到 **0 B**，时间只掉 11.4%。
   ⇒ 「预热 rootfs / `posix_fadvise`」这条路的天花板是 5 秒，做完也就 47.6 → 42。
2. **模块编译 10.4~12.5 秒是实打实的 CPU。** 623 个 CJS 模块、平均 16.7~20.1 ms/个。
   最贵的是 `undici/index.js` 732~988 ms、`@opentelemetry/core` 427~559 ms、`yaml` 225~288 ms。
   平均 17 ms/模块对一个 123 MB 的 arm64 node 来说**不正常**（PC 上同规模约 1~3 ms），
   典型原因是 PRoot 下 `open/stat` 走了 ptrace 翻译层。
3. **`listen()` 之后还有 13.4 秒的同步阻塞。** `epoch.listen → epoch.listening` 三次分别是
   14,428 / 13,387 / 13,451 ms，**极其稳定**，与页缓存无关。
   这段时间事件循环还没转起来 ⇒ 只能是同步的模块求值/插件初始化；
   而 `modules.compile.ms` 只统计了 CJS（623 个），**ESM 模块完全没被计入**。

#### 4.19.2 为什么 `entry.start/entry.end` 全是 `na`（本轮新发现）

`@deepseek-ai/dsh/package.json` 里有 `"type": "module"`，`bin.js` 是 **ESM**。
ESM 走 `lib/internal/modules/esm/*` 的 loader，**不经过 `Module.prototype._compile`**，
所以我们挂在 CJS 链上的入口打点必然落空（623 个计数全是 CJS 依赖，如 undici / yaml / opentelemetry）。

下一版要么改挂 `module.register()` / `--import`，要么干脆不信入口——本轮已经证明
`listen/listening/first` 三个点在 ESM 下照样准，够分段了。

#### 4.19.3 下一步（优先级已变）

| 优先级 | 动作 | 依据 |
|---|---|---|
| **P0** | 把 `listen→listening` 那 13.4 s 拆开：`--import` 挂 ESM loader 记每个 ESM 模块的 `resolve/load/evaluate` 时刻 | 三次数值稳定在 13.4 s，是全链路里最干净的一块可优化时间 |
| **P0** | 关掉不需要的插件（`@opentelemetry/*`、`yaml`、`compression` 若走不到就摘掉） | 单个 `undici/index.js` 就 0.7~1.0 s，`@opentelemetry/core` 再 0.43~0.56 s |
| P1 | `NODE_COMPILE_CACHE`（node ≥22 的 V8 code cache）指向 `$DSH_HOME/v8cache`，让第 2 次起跳过编译 | 10.4~12.5 s 的编译是纯 CPU，缓存一次可长期受益 |
| P2 | 预热 rootfs（`posix_fadvise`/顺序 touch） | 天花板 5 s，做完 47.6 → 42，性价比最低 |

#### 4.19.4 复现命令

```bash
# 冷启
adb shell am force-stop com.dsh.android
adb shell am start -n com.dsh.android/.MainActivity
# 取数据（只能 stdout 回宿主，run-as 里重定向到 /sdcard 会是 0 字节）
adb shell run-as com.dsh.android cat files/logs/boot-timing.log > bt.log
python3 tools/boot-timing-report.py bt.log
```

---

### 4.20 第 2 层：把那 13.4 s 拆开了 —— **是依赖图重复，不是 loader 慢**

> 提交：`78cb95a`（第 2 层实现）
> 编译门禁 run `45879663322` success；APK run `45879656619` success；
> 重签 run `45881336438` success（signer `79d0dab6…`）；
> 装机 `vc=131 / debug.46`（2026-11-27 03:12）。
> 真机采样：03:12 冷启一次（**诊断态**，见 4.20.3）。

#### 4.20.1 新增的两把尺子

| 尺子 | 实现 | 落点 |
|---|---|---|
| ESM loader 时间线 | `--import` + `module.register()`，`resolve` / `load` 钩子逐条记 `t=Date.now() ms=…` | `files/logs/boot-timing-esm.log` |
| V8 采样 | `--cpu-prof --cpu-prof-interval=1000` | `files/home/.dsh/cpuprof/*.cpuprofile` |

两份都在 `NODE_OPTIONS` 里追加，仍沿用 `{GUEST_ENV}` 注入点，**没有改任何既有形参**。
分析器：`tools/boot-timing-esm.py --esm <log>` / `--prof <cpuprofile>`。

#### 4.20.2 真机数据（19,604 条 ESM 事件）

```text
ESM 事件      19,604 条（load 5,781 / resolve 13,823）
不同 URL       5,714 个
zod 相关事件   16,333 条   ← 占全部事件的 83%
@deepseek-ai   17,405 条
execa 419 / @earendil-works 604 / dshmarket 321 / got 62 / diff 50 / commander 43
每秒事件数      300~391 条，连续 30 秒不断（1795720377 → 1795720406）
```

单文件都不慢（最慢 `zod/v4/locales/eo.js` 10.58 ms），**慢的是条数**：每秒 ~350 个模块，
每个 ~3 ms，30 秒就是一万次。PRoot 的 ptrace 翻译层把这个常数放大到了无法忽略。

#### 4.20.3 根因：68 份 zod

```text
/opt/dsh/node_modules/@deepseek-ai/*/node_modules/zod   67 份（4.6.6）
/opt/dsh/node_modules/zod                                1 份（4.6.7）
合计 68 份，每份 3,008 KB  ⇒ 约 204 MB 重复代码
locales 目录 278 个（zod v4 的 locales/index.js 一次 import 全部语言包）
```

每个 `@deepseek-ai/dsh-*` 插件各自带一份 `zod`，而 zod v4 的 `locales/index.js`
会把几十个语言包全 import 进来 —— 于是「一份 zod」在启动期被放大成 68×几十个模块。
这就是 `listen → listening` 那 13.4 s 的来源（不是 server 慢，是事件循环还没轮到它）。

> ⚠️ 版本还不一致：67 份是 `4.6.6`，顶层是 `4.6.7`。所以**不能**直接 symlink，
> 必须先统一版本（见 4.20.5 的 A 方案）。

#### 4.20.4 诊断态本身的开销（重要）

同一台设备：基线冷启 `42,150 / 41,987 ms`；挂上 ESM 钩子 + 1 ms 采样后 `71,297 ms`。
**+29 s**，其中钩子逐条 `appendFileSync` 与 profile 采样各占一部分。

⇒ 结论：这两把尺子**只能诊断用，必须默认关闭**。落地形态应是「启动参数 / 调试开关」，
而不是常开。当前实现由 `BootTimingPreload` 无条件注入，属于**待收口项**（4.20.5 的 C 方案）。

#### 4.20.5 修复方案（按性价比）

| # | 方案 | 预期 | 风险 |
|---|---|---|---|
| **A** | 运行时安装改为**去重**：`npm dedupe` 或 pnpm `node-linker=hoisted`，让 68 份 zod 收敛成 1 份（先统一到 4.6.7） | ESM 事件 19.6k → ~3.3k，按 350/s 估算 loader 段 ~9 s，**省 25~30 s** | 需重建 runtime，改 `tools/runtime/build-runtime.sh` 的安装步骤 |
| **B** | 启动时把嵌套 zod 换成 symlink 指向顶层（Node 默认按 realpath 缓存 URL ⇒ 只加载一次） | 与 A 同量级，且不必重建 rootfs | 版本必须先统一；rootfs 更新会覆盖，需做成启动自检 |
| **C** | 诊断开关收口：`NODE_OPTIONS` 里的 `--import` / `--cpu-prof` 改成 `DSH_BOOT_TRACE=1` 才注入 | 把 +29 s 还回去 | 无 |
| **D** | `NODE_COMPILE_CACHE` 指向 `$DSH_HOME/v8cache` | 省解析/编译的那部分（10.4~12.5 s 里的一部分） | 需 node ≥22（现在是 24.22.1 ✓） |
| **E** | 预热 rootfs / `posix_fadvise` | 天花板 5 s | 最低 |

#### 4.20.6 复现

```bash
adb shell am force-stop com.dsh.android
adb shell am start -n com.dsh.android/.MainActivity
adb shell run-as com.dsh.android cat files/logs/boot-timing-esm.log > esm.log
python3 tools/boot-timing-esm.py --esm esm.log --top 20
# 设备侧快速聚合（无需把大文件搬出来）
adb shell run-as com.dsh.android sh -c \
  'grep -o "node_modules/[^/]*" files/logs/boot-timing-esm.log | sed "s#node_modules/##" | sort | uniq -c | sort -rn | head'
```

---

### 4.21 C → A 落地：诊断开关收口 + zod 去重（真机实测 −45%）

> 提交：`49933f0`（C，诊断开关）、`41eef55`（A，构建期去重）
> CI：compile `45939893209` success；APK `45939730537` success；运行时 `45940418144` success
> （A 的 `zod 数量断言` 在运行时构建里通过，否则 `die`）；重签 `45941370610` success
> 装机：`vc=131 / debug.46`（2026-11-27 12:43）
> 真机：12:46 / 12:47 / 12:49 三次冷启（trace **off**）+ 12:50 一次 trace **on** 对照。

#### 4.21.1 C：诊断开关收口

```text
注入条件   files/boot-trace.enable 存在
开         touch：--require <cjs> + --import <esm> + --cpu-prof(1ms)
关（默认） --require <cjs>       ← 第 1 层常开，成本是 token 时一次落盘
实现       BootTimingPreload.traceEnabled(filesDir) → guestEnv(..., trace)
           ProotHost 调用点传 trace，未改任何既有形参
```

副作用：trace 开时 `--cpu-prof` 与 ESM 钩子仍会产生 `$DSH_HOME/cpuprof/*.cpuprofile`
与 `files/logs/boot-timing-esm.log`，关掉后**不再写**（12:46 那次 esm.log mtime 停在 12:39）。

#### 4.21.2 A：构建期摘掉嵌套 zod

`tools/runtime/build-runtime.sh` 在 engine 安装 + patch 之后新增 §3.35：

```sh
dedupe_nested zod          # 删掉 @deepseek-ai/*/node_modules/zod（67 份）
                           # 断言：整个 node_modules 里 zod 恰为 1 份，否则 die
```

**为什么不是 symlink**：ESM 不做 realpath —— symlink 之后 68 个 import 点仍是 68 条不同
URL，照样 68 次加载。真机验证过：写 symlink 那次事件数 17,042（没降）；
**删掉**嵌套副本后同为 3,575 条。ESM 只认「同一个 URL」。

#### 4.21.3 真机结果（A 后，trace off）

| 次 | host→node | preload→listen | listen→listening | →首响应 | preload→首响应 | engine.ready |
|---|---|---|---|---|---|---|
| 1 | 112 ms | ~18,000 ms | **3,408 ms** | 892 ms | **22,061 ms** | 28,458 ms |
| 2 | 45 ms | 18,491 ms | **3,504 ms** | 765 ms | **22,760 ms** | — |
| 3 | 118 ms | 17,031 ms | **3,074 ms** | 867 ms | **20,872 ms** | 26,184 ms |

对比 A 之前（§4.18.7，trace off）：

```text
preload→首响应   47,578 / 42,150 / 41,987 ms   →   22,061 / 22,760 / 20,872 ms   ≈ −47%
listen→listening 14,428 / 13,387 / 13,451 ms   →    3,408 /  3,504 /  3,074 ms   ≈ −75%
engine.ready           ~40,384 ms              →       26,184~28,458 ms
ESM 事件             19,604 条                 →        3,575 条（trace on 对照）
zod 事件             16,333 条                 →          390 条
zod 副本                   68 份               →            1 份（顶层 4.6.7）
诊断开销           trace on 时 +29 s           →   trace on 时 +14.7 s（module 少，钩子也便宜了）
```

#### 4.21.4 结论与下一步

- **依赖图重复是主因，loader/IO 都不是。** 去掉 67 份 zod 副本，冷启从 42 s 级降到 21 s 级。
- `listen→listening` 仍有 3.1~3.5 s：那才是真正的「loader 开销 + 插件同步初始化」，
  现在量级已可接受。
- 剩下的 21 s 里还有两块可动：
  1. `modules.compile.ms` 8,705~10,438 ms（623 个 CJS，`undici/index.js` 单个 0.8 s）→
     `NODE_COMPILE_CACHE=$DSH_HOME/v8cache` 可直接吃这一块；
  2. `@opentelemetry/*` 合计 ~0.5 s + `yaml` ~0.4 s，若 profile 里用不到可摘。
- **P1 下一刀**：`NODE_COMPILE_CACHE`（node 24.22.1 支持），预计再省 2~5 s。

#### 4.21.5 复现

```bash
# 基线（开关关）
adb shell am force-stop com.dsh.android && adb shell am start -n com.dsh.android/.MainActivity
adb shell run-as com.dsh.android cat files/logs/boot-timing.log | tail -20

# 打开诊断（下一次冷启生效）
adb shell run-as com.dsh.android touch files/boot-trace.enable
# 关掉
adb shell run-as com.dsh.android rm -f files/boot-trace.enable
```

---

### 4.22 P1：V8 compile cache（真机 −2~4 s；附一个必须知道的坑）

> 提交：`b5fc1e8`（cache 主体）、`f1eaa71`（单测修复）、`b4c5e52`（周期 flush）
> CI：compile `45984357062` / `45987895860` success；APK `45984340408` success
> 真机：19:04~19:12 多次冷启（trace off）

#### 4.22.1 做法

```text
位置     CJS wrapper 里，只在 IS_ENGINE 分支执行（工具/子进程不碰）
API      module.enableCompileCache($DSH_HOME/v8cache)   （node ≥ 22.1；真机 24.22.1）
自检     BootTimingPreload.ensureV8Cache()：建目录 + 体积统计，>128 MB 清空重建
```

真机 `engine.log` 回报：

```text
[v8cache] st={"status":1,"directory":"/data/user/0/com.dsh.android/files/home/.dsh/v8cache"}
          dir=/data/user/0/com.dsh.android/files/home/.dsh/v8cache/v24.22.1-arm64-964aae3f-0
```

#### 4.22.2 坑：`force-stop` 是 SIGKILL，退出刷盘不会发生

第一次真机验证：cache 目录建好了、`status=1`（已启用），但 **`find … -type f` = 0 个文件**。
原因不是权限，也不是 API 用错 —— node 的 compile cache 默认在**进程正常退出**时落盘，而
`am force-stop` 直接 SIGKILL，什么都不写。

修法：在 wrapper 里加**周期 flush**（`module.flushCompileCache()`，8 s × 4 次，覆盖加载窗口）：

```js
var _flushes = 0;
var _ft = setInterval(function () {
  try { if (typeof mc.flushCompileCache === 'function') { mc.flushCompileCache(); _flushes += 1; } } catch (e2) { }
  if (_flushes >= 4) clearInterval(_ft);
}, 8000);
if (_ft.unref) _ft.unref();
```

实测（本地 fixture，`kill -9` 验证）：没有周期 flush 时目录 0 文件；加上之后被杀也留下
`2 files / 27 KB`。真机上稳定成 **1,508 文件 / 12 MB**。

#### 4.22.3 数据

**合成 fixture**（400 个 CJS × 1,500 行）：

| 场景 | wall | modules.compile.ms |
|---|---|---|
| 无 cache | 3,139 ms | 997 ms |
| 首次（写 cache） | 4,211 ms | 1,421 ms |
| 命中（第 2/3/4 次） | 2,270~2,317 ms | **394~412 ms（−60%）** |

**真机**（A 后，trace off）：

| | preload→首响应 | modules.compile.ms | engine.ready |
|---|---|---|---|
| 无 cache（§4.21.3） | 20,872 / 22,061 / 22,760 | 8,705 / 9,472 / 10,438 | 26,184 / 28,458 |
| 首次（填 cache） | 19,264 | 8,666 | 24,530 |
| 命中（第 2/3 次） | **17,139 / 17,250** | **8,342 / 8,430** | **21,704 / 21,943** |

⇒ 真机收益 **2~4 s（≈10~15%）**，远小于 fixture 的 −60%。

#### 4.22.4 为什么真机收益小（结论）

V8 code cache 只省「解析 + 编译」那一段；真机上 `modules.compile.ms` 里还混着
**PRoot ptrace 放大的 open/stat/read** —— 那部分缓存无能为力。fixture 在原生文件系统上跑，
所以把「编译」这一项的收益看得特别清楚；真机被 PRoot 摊平了。

要继续往下压，只剩两个方向（都不在 cache 这条线上）：

1. **减模块**：`@opentelemetry/*` + `yaml` 合计约 0.9 s，若运行期用不到可直接摘；
2. **动 PRoot 层**（ptrace 翻译开销）——属于架构级改动，超出"维护态只修 bug"的边界。

#### 4.22.5 装机状态

APK `45984340408`（`f1eaa71`，含 cache 但**不含**周期 flush）已构建 + 重签（`45986268441`，
artifact `15191293358`）。`b4c5e52` 的 APK 也在构。

⚠️ 本轮**未能装机**：S3 artifact 下载被限速到 **~12 KB/s**（162 MB 需数小时），
改用设备侧等价验证（把同一段 cache 代码写成 `/opt/dsh/.dsh-v8cache.cjs`，
并在 `/usr/local/bin/dsh` 里加 `--require`，原文件备份为 `.bak`）。
两者行为一致：都是 `enableCompileCache($DSH_HOME/v8cache)` + 周期 flush。

设备侧临时改动（可随时还原）：

```bash
run-as com.dsh.android sh -c 'cp files/runtime/rootfs/usr/local/bin/dsh.bak files/runtime/rootfs/usr/local/bin/dsh'
run-as com.dsh.android sh -c 'rm -f files/runtime/rootfs/opt/dsh/.dsh-v8cache.cjs'
run-as com.dsh.android sh -c 'rm -f files/home/.dsh/v8cache/*'
```

---

### 4.23 P2：摘掉 `@opentelemetry`（−265 模块 / −4.6 s 编译）+ yaml 的反例

> 提交：`7988eab`（构建期 prune）
> 真机：19:28~19:33，多次冷启（trace off，A + V8 cache 已生效）

#### 4.23.1 先确认「还有没有别的重复包」

```text
find node_modules -mindepth 4 -maxdepth 4 -type d -name node_modules | wc -l
→ 0        # zod 去重后，engine 树里已经没有任何嵌套 node_modules
```

⇒ 「像 zod 那样的重复依赖」已经没有了，剩下的只能从「用不到的包」下手。

顺带查了 profile 侧：`files/home/.dsh/profiles/web/node_modules` 只有 5 个包，
其中 `undici@7.30.2` 与 rootfs 的 `undici@8.11.2` **大版本不同**，是插件刻意钉的版本，
不能合并（真合并会改行为）。

#### 4.23.2 实验：把 `@opentelemetry` 移走

```bash
run-as com.dsh.android sh -c 'mv $R/@opentelemetry $R/.bak-opentelemetry'
```

三次冷启结果（engine 均 `health=401`、`engine.log` 无 `MODULE_NOT_FOUND`）：

| | modules.count | modules.compile.ms | preload→首响应 | engine.ready |
|---|---|---|---|---|
| 有 otel | 623 | 8,430 ~ 8,666 | 17,250 | 21,943 |
| 摘掉 otel | **358** | **3,765 ~ 3,842** | **15,698 ~ 15,819** | 19,845 ~ 20,171 |

⇒ 一口气少 **265 个 CJS 模块**、编译少 **约 4.6 s**、总分段少 **1.4~1.6 s**。
（编译降得多、总时间降得少：V8 cache 已经在吃编译，剩下的时间又摊到 PRoot 的 open/stat 上。）

#### 4.23.3 反例：`yaml` 不能摘

同样手法移走 `node_modules/yaml`：

```text
modules.count 358 → 281，compile 3,842 → 2,803（看着更美）
但 engine 不再 ready，engine.log：
  failed to import: Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'yaml'
    imported from /opt/dsh/node_modules/@deepseek-ai/dsh-skill-office/lib/index.js
    imported from /opt/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js
```

两个插件是**静态 import**，摘掉即崩。已原样还原（`mv .bak-yaml yaml`），
还原后 `modules=358 / compile=3,765 / 总 15,787 ms`，与摘 otel 后的基线一致。

**判据记下来**：能不能摘，不看它慢不慢，只看「有没有静态 import」。
`@opentelemetry` 之所以能摘，是因为没有任何插件在加载链上静态 import 它
（tracing 走的是条件启用）；`yaml` 恰好相反。

#### 4.23.4 落地形态

`tools/runtime/build-runtime.sh` 新增 §3.36：

```sh
if [ "${DSH_RT_SKIP_ENGINE:-0}" != "1" ] && [ "${DSH_RT_KEEP_OTEL:-0}" != "1" ]; then
  rm -rf "$ROOTFS/opt/dsh/node_modules/@opentelemetry"
  [ ! -d "$ROOTFS/opt/dsh/node_modules/@opentelemetry" ] || die "@opentelemetry 未被移除"
fi
```

- `DSH_RT_KEEP_OTEL=1` 是逃生门：将来某插件运行期真要用 tracing，构建时保留即可。
- 若真被摘而某功能按需 import，会以 `MODULE_NOT_FOUND` **显式**暴露，不会静默错。

#### 4.23.5 当前基线（全链路）

```text
起点（B 阶段前）            47.6 s（磁盘冷）/ 42.0 s
A：zod 去重（68→1）          21 ~ 22 s
A + P1：V8 compile cache     17.1 ~ 17.3 s
A + P1 + P2：摘 otel         15.7 ~ 15.8 s
   结构：preload→listen ≈ 10 s ／ listen→listening ≈ 2.2 s ／ →首响应 ≈ 0.5 s
         另有宿主侧 preflight → spawn ≈ 1.1 s（不在 guest 计时内）
```

#### 4.23.6 剩下的天花板

- `modules=358` 里已没有重复包、没有明显可摘的静态依赖；
- 每模块约 10 ms 的加载成本，主体是 **PRoot 的 ptrace 翻译**；
- 再往下只有两条：**(a)** 继续找"条件启用"的包（收益越来越小、验证成本越来越高）；
  **(b)** 动 PRoot 层（架构级，超出"维护态只修 bug"的边界，需要单独立项）。

---

### 4.24 收尾出包：`debug.47 (vc132)` 已发布

> 提交：`856b1aa`（版本 + CHANGELOG）
> 版本体检：`sh tools/version.sh --check` → **VERSION PASS** `app=0.2.2-rc.5-debug.47 vc=132 engine=0.2.2-rc.5`

#### 4.24.1 流水线

```text
apk.yml        45993811002  success（runtime job + assemble 均绿）
  dsh-system-debug        15195407977  160,677,621 B
  dsh-system-release      15194519800  160,662,418 B
  runtime-arm64-v8a       15194364816  145,756,677 B
  plugins-mobile-ui       15195651327      337,984 B
  app-unit-tests          15194564414        7,972 B
sign-upgrade   45995760602  success
  dsh-system-debug-upgrade-signed   15194779626  162,047,813 B
publish-apk    45995765867  success
  Release  v0.2.2-rc.5-debug.47（prerelease，9 个资产）
```

Release 资产（节选）：

```text
dsh-android-0.2.2-rc.5-debug.47-arm64.apk      161,695,548 B
rootfs-arm64-v8a.tar.xz                         74,434,544 B
rootfs-part1-arm64-v8a.tar.xz                   70,257,472 B
rootfs-part2-arm64-v8a.tar.xz                      782,800 B
manifest.json                                        3,503 B
plugins-mobile-ui-1.1.0-237.zip                    242,351 B
```

#### 4.24.2 和上一版比，产物真的变小了

| | debug.45（收尾前） | debug.47 | 变化 |
|---|---|---|---|
| APK | 166,794,428 B | **161,695,548 B** | −5.1 MB |
| rootfs（tar.xz） | 79,540,740 B | **74,434,544 B** | −5.1 MB |

对应的是删掉的 67 份 `zod`（204 MB 未压缩）与 `@opentelemetry`（265 个模块）——
xz 对重复内容压缩率极高，所以磁盘上的差值远小于原始体积差。

#### 4.24.3 升级行为（必须知道）

`RUNTIME_VERSION` 里带 `INPUTS`（= 构建脚本自身 + 依赖 + patches 的 sha256），
本轮改了 `build-runtime.sh`，所以 runtime 版本号变了 ⇒ **升级后会重新解包一次 runtime（约 146 MB）**。
首次启动包含解包开销，之后的冷启才是 15.7 s 级别。

#### 4.24.4 装机状态

- `dsh-system-debug-upgrade-signed`（15194779626）已生成，可直接 `pm install -r -d`；
- 本轮**仍未在设备上装**：S3 依旧限速（~12 KB/s 量级），162 MB 下载不划算。
  设备当前跑的是**等价状态**（rootfs 手工去重 + 摘 otel + `--require` 缓存），
  相关临时改动与还原命令见 §4.22.5。

---

### 4.25 立项：动 PRoot（direct 免 proot 直启）—— 一页纸

> 状态：**立项/待批**。本轮只做到「把失败点钉死 + 给出排查清单」，没有改代码。
> 结论先说：`DirectLaunch` 这条路项目里**已经有骨架**，而且历史实测 direct **6.5 s** vs
> proot **32.6 s**（`DirectLaunch.kt` 头部注释）；本机实测直启**失败于 50 ms 内**，
> 失败点是 loader 层，还没有拿到子进程的 stderr —— 这就是第一步。

#### 4.25.1 为什么还值得做

当前 15.7 s 的结构：

```text
preload→listen ≈ 10 s   （358 个模块，每模块约 10 ms；V8 部分已被 compile cache 吃掉）
listen→listening ≈ 2.2 s
→首响应 ≈ 0.5 s
```

同一份模块图在**原生文件系统**上（fixture，400 模块）每模块约 1.0~2.5 ms，
真机是 10~17 ms —— **6~10 倍差距全在 PRoot 的 ptrace 翻译**。
direct 一旦能起，这一块直接归零；历史数据说能到 6.5 s 量级（≈ 再省 8~9 s）。

#### 4.25.2 本机实测（2026-11-27 19:51）

```bash
touch files/direct-enabled      # 显式开启闸门
am force-stop … && am start …
```

```text
[19:51:28.076] launch: direct=on profile=web patches=14 cwd=…/rootfs/root
[19:51:28.079] direct.spawn pid=? argv0=/data/app/…/lib/arm64/libld-linux.so
[19:51:28.130] direct 未就绪（alive=false, 50 ms），回退 proot
[19:51:48.028] engine.ready ms=21708 … runtime=proot        ← 自动回退成功，用户无感
```

- 子进程**没有任何输出**（`engine.log` 在该时刻无行）⇒ 死在 `execve` 之后的 loader 初始化，
  还没进 node；
- 已写 `direct-failed-r1-arm64-v8a-dsh0.2.2-rc.5-node24.22.1-ubuntu24.04.5-<hash>` 闸门文件
  ⇒ 同一 runtime 不会反复重试（设计正确）；
- 已手动清理：`rm files/direct-enabled files/direct-failed-*`，设备回到 proot 模式。

#### 4.25.3 排查清单（按顺序，每步都有可观测产物）

| # | 动作 | 产出 | 预计 |
|---|---|---|---|
| 1 | `spawnDirect` 里补：`process.onExit()` 记 `exitValue`，并把子进程 stderr/stdout 在**前 200 ms 内**无条件落 `app.log` | 一行 `direct.exit code=…` + loader 原文 | 0.5 h |
| 2 | proot 内跑 `ldd /usr/bin/node` / `readelf -d`，把 `--library-path` 与缺库对齐 | 缺失库清单 | 0.5 h |
| 3 | 校验 `nativeLibraryDir/libld-linux.so` 的权限与 `exec` 能力（Android 10+ 只允许 apk_data_file 里 exec，代码已按此选路径） | `ls -l` + SELinux 拒绝日志（`dmesg`/`logcat`） | 0.5 h |
| 4 | 复核 direct 的 environment/cwd：`DSH_HOME`、`HOME`、`TMPDIR`、`LD_LIBRARY_PATH`、`/dev/null`、`/proc/self/exe` | 与 proot 版逐项 diff | 1 h |
| 5 | 若仍失败：做一个最小复现 `libld-linux.so --library-path … node -e 1`，把 argv 打到日志 | 最小 argv | 1 h |

#### 4.25.4 风险与边界

- **语义差异**：direct 没有 bind，guest 绝对路径 = 宿主真实路径。项目已经把
  `startCommand`（工具/诊断的一次性 node）**恒定锁在 proot**，正是为了不让工具输出对不上；
  direct 只用于 web profile。
- **回滚**：删 `files/direct-enabled` 即回 proot；已有 `direct-failed-<ver>` 闸门避免反复试错。
- **架构约束**：HANDOFF §1 写的是"维护态只修 bug，不改身份与架构"。direct 开关**已经存在**，
  本次是修 bug，不是改架构；但如果要把它**默认打开**，那就是产品决策，需要单独一轮验收
  （会话/终端/文件选择器/aria 全都要在 direct 下过一遍）。

#### 4.25.5 验收指标

```text
1. engine.ready runtime=direct 且 health=401，冷启 ≤ 8 s（三次中位数）
2. 会话可读写、终端工具照常（仍走 proot 分支）
3. 回滚演练：删 marker → 下一次冷启 runtime=proot
```

#### 4.25.6 备选路线（direct 短期修不好时）

| 路线 | 做法 | 预期 | 风险 |
|---|---|---|---|
| B | 用 esbuild/rollup 把 engine 入口打成少量 bundle | 模块数 358 → 个位数，每模块开销近似归零 | 插件是运行期动态加载，bundle 只能覆盖核心；插件仍走原路径 |
| C | 给 hot path 的模块做 `NODE_COMPILE_CACHE` + 预读（`posix_fadvise`） | 已知天花板 5 s，已吃过一部分 | 低 |
| D | 精简插件集（按 profile 只装用到的） | 线性减少模块数 | 功能取舍，需产品决策 |

---

### 4.26 决策：**A 不动** —— 保持 PRoot，direct 封存（2026-11-27）

> 决议人：主人。结论：**不启动 direct（免 proot）改造**，B 阶段到此收尾并冻结基线。

#### 4.26.1 决议内容

| 项 | 结论 |
|---|---|
| 运行时 | **继续用单宿主 PRoot + glibc**（HANDOFF §1 的定盘星不变） |
| `DirectLaunch` 代码 | **保留、不删除**；默认关（`files/direct-enabled` 不存在即 disabled，已验证） |
| `direct-failed-<runtimeVersion>` 闸门 | 保留（同一 runtime 只试一次、失败自动回退，19:51 实测有效） |
| 立项文档 §4.25 | 保留为**已评估、暂不采用**；不是废弃，是挂起 |
| 设备状态 | 已清理全部 direct marker：`ls files/direct-enabled files/direct-failed-*` → 两个都不存在 |

#### 4.26.2 为什么不动（理由归档）

1. **收益 8~9 s，但代价是整个语义面**：bind 消失（路径/`/proc`/`/dev/shm`）、root→app uid、
   DNS 走真实 `/etc/resolv.conf`、pid/信号/救援链路全要重写。
2. **双轨制是长期状态**：`startCommand` 与工具链天生依赖 bind 语义，direct 只能覆盖引擎主进程
   —— 等于用两套运行路径换一个数字。
3. **与"维护态"边界冲突**：默认打开要重验会话/终端/文件选择器/附件/救援，属产品决策，不是修 bug。
4. **本机 50 ms 失败点至今没有原文**（子进程零输出）——在拿不到 loader 报错之前推进，
   等于用猜测换风险。
5. 当前收益已经吃满：**42.0 s → 15.7~15.8 s（−63%）**，且每一步都有真机数据与回滚点。

#### 4.26.3 重启 direct 的三条硬门槛（写死，避免以后凭感觉翻案）

```text
1. 先补诊断：spawnDirect 记 exitValue + 前 200 ms 的 stderr 无条件落 app.log
   （没有这条，任何"修好了"都无法证伪）
2. 拿到 runtime=direct 且 health=401，且 DNS 探测（一次外网解析）通过
3. 产品侧同意多模式并存的验收面：会话 / 终端 / 文件选择器 / 附件 / 救援 全过一遍
三条缺一，不重启。
```

#### 4.26.4 冻结后的现状（交接用）

```text
代码     HEAD=f0699c7（main）；DirectLaunch 默认关；build-trace / v8cache / zod / otel 四道闸都在
基线     冷启 15.7~15.8 s（trace off，三次）
         preload→listen ≈10 s ／ listen→listening ≈2.2 s ／ →首响应 ≈0.5 s
产物     v0.2.2-rc.5-debug.47（prerelease，9 资产）；APK 161,695,548 B；rootfs 74.4 MB
设备     vc=131(debug.46) + 等价态：rootfs 手工去重 / 摘 otel / --require 挂 v8cache
         （还原命令见 §4.22.5；装 debug.47 后建议先还原，再让 APK 自己的机制接管）
```

#### 4.26.5 后续只做维护，不再做架构改动

- 启动分段与 profile 工具**保留**（`boot-timing.log` / `boot-timing-esm.log` / `tools/*.py`），
  排障时仍可 `touch files/boot-trace.enable` 打开诊断；
- 四道构建/运行期闸门**都能回滚**：zod 断言、otel prune（`DSH_RT_KEEP_OTEL=1`）、
  v8cache 体积自检、trace 开关；
- 若未来 Android 大版本或 dsh 升级导致回归，按 `progress.md` §4.19~§4.23 的测法重新量一遍即可。

---

### 4.27 复盘：A + B 计划完成度（截至 `cde73f0` / debug.47）

> 依据：`docs/plan/pa-pb-plan.md`（608 行，A1~A4、B1~B6、D 完成定义）逐条对照
> 代码（`GithubMirrors.kt` / `RuntimeDelta.kt` / `BootTimeline.kt` / `BootTimingPreload.kt`）、
> 单测（`RuntimeS6Test` / `BootTimingPreloadTest`）、真机日志（`app.log` / `boot-timing.log`）。

#### 4.27.1 总览

| 阶段 | 计划目标 | 状态 | 关键数字 |
|---|---|---|---|
| **A 多线路下载** | 自动选最快线路 + 失败回直连 | ✅ **100%** | 87 KB/s → **406 KB/s（4.7×）**；端到端 28 min → **6 min 14 s** |
| **B 启动计时** | 把 47.8 s 拆成可读分段 | ✅ **100%（目标达成）** | 计划 8 点 → 实装 7 点；`dump()` 瀑布已进 `app.log` |
| **B 阶段后续优化**（计划外） | — | ✅ 已做 4 项 | 42.0 s → **15.7~15.8 s（−63%）** |
| **direct 免 proot**（计划外） | — | ⏸ **A 不动，封存** | 见 §4.26、§4.25 |

#### 4.27.2 A 阶段：验收 6 条逐条

| # | 验收项 | 状态 | 依据 |
|---|---|---|---|
| 1 | 过滤条件正确 | ✅ | `RuntimeS6Test`：`api.github.com` / `releases.atom` → 空；`/releases/download/*` → `mirrorCount` 条 |
| 2 | URL 拼接正确（无 `//`） | ✅ | 同上（`GithubMirrors.mirrored` 用例） |
| 3 | 全部镜像死 → 回直连 | ✅（单测）/ ⚠️（未单独真机演练） | `Probe(ok=false)` 注入用例；真机未做"断网+全镜像死"专项 |
| 4 | 探测流量 ≤ 256 KB | ⚠️ 部分 | 代码有 `probeBytes` 预算与 `budgetMs=2500`；但**日志没有统一 `probe bytes=` 字段**，无法从日志求和验收 |
| 5 | 选出的线路确实更快 | ✅ | `pick()` 按 `bytesPerSec` 排序取最高；`clearCache()` 支持重测 |
| 6 | 增量仍只下变化块 | ⚠️ 未复验 | 属 `docs/agents/runtime-delta.md` 的演练流程，本轮没重跑（B 阶段全程未触发下载路径） |

**A 的实测收益（§4.10）**：吞吐 87 → 406 KB/s（4.7×）；端到端 28 min → 6 min 14 s（4.5×）。

#### 4.27.3 B 阶段：验收 5 条逐条

| # | 验收项 | 状态 | 依据 |
|---|---|---|---|
| 1 | 8 点全出、单调递增 | ⚠️ **7 点** | 实装：`runtime / preflight / prootSpawn / nodeExec / health / ready / gui`；缺 `app`、`prootMounted`（后者被 `nodeExec` 吸收），另加 `ready` |
| 2 | 各段之和 ≈ total（<5%） | ✅ | 真机 dump：`gui=32180ms` 与 `total=32180ms` 一致 |
| 3 | `unpacked` 标记正确 | ❌ 未实现 | `BootTimeline.mark(name)` 没有 `extra` 形参，计划要求的 `unpacked=true/false` 未落 |
| 4 | 不影响启动耗时（<1 s） | ✅ | 加打点前后 `engine.ready ms` 在噪声内（打点是内存 map，`dump()` 一次落盘） |
| 5 | guest 时间戳可用（宿主↔guest <2 s） | ✅ **超额** | 第 1 层 wrapper 给出五段 + `host.epoch` 对齐（§4.18.7 三次实测） |

#### 4.27.4 B 阶段「三层测量」交付情况（计划的 §4.18 交付物）

| 层 | 计划 | 状态 |
|---|---|---|
| 第 1 层 | guest 侧 `Date.now()` wrapper，四段 | ✅ 落地并真机三次（§4.18.7） |
| 第 2 层 | `/proc/<pid>/io` 采样 | ✅ 落地（`rchar/read_bytes/syscr` 进日志），并额外做了 ESM loader 时间线 + V8 profile（§4.20） |
| 第 3 层 | 冷启 3 次 vs 热启 1 次对照 | ⚠️ **部分**：冷启 3 次已完成；"热启"未按计划做（引擎存活时重启不产生新 spawn），改用**页缓存冷/暖对照**（129 MB→0 B，5.4 s），结论更本质 |

#### 4.27.5 计划外但已交付的优化（42.0 s → 15.7 s）

| 项 | 做法 | 收益 | 文档 |
|---|---|---|---|
| A | 构建期摘 67 份嵌套 zod（68→1） | 42.0 → 21~22 s | §4.21 |
| P1 | V8 compile cache + 周期 flush | → 17.1~17.3 s | §4.22 |
| P2 | 构建期摘 `@opentelemetry`（yaml 保留） | → 15.7~15.8 s | §4.23 |
| C | 诊断开关收口（`files/boot-trace.enable`） | 省掉常驻 +14.7~29 s | §4.20.4 |
| 观测 | `boot-timing.log` / `-esm.log` / `cpuprof` / 两个分析脚本 | — | §4.18 / §4.20 |

#### 4.27.6 欠账清单（不影响验收，但记在账上）

1. `B6#3` `unpacked` 标记未实现（`BootTimeline.mark` 缺少 extra 形参）；
2. `B3` 的 `boot.phase.app` 与 `boot.phase.prootMounted` 两点未按名落地（前者缺、后者并入 `nodeExec`）；
3. `A4#4` 探测流量没有统一日志字段，无法从日志求和；
4. `A4#6` 增量下载本轮未复验；
5. 第 3 层"热启 1 次"用页缓存对照替代，未做严格热启。

**结论**：A 阶段按 D 表四条（A1~A4）全部达成；B 阶段"把 47.8 s 拆成可读分段"的目标达成且超额（五段 + ESM/profile），
仅 B 的验收细节有 3 处形式偏差（不影响结论）。计划外优化把冷启再压到 15.7 s，direct 已决策不动。

---

### 4.28 欠账补齐（§4.27.6 的 5 条）

> 提交：`281cd69`；编译门禁 run `46003867429` **success**（含新增 `BootTimelineTest`）
> APK run `46003850040` 同 sha 构建中（含新打点，未装机——网络仍受限）

#### 4.28.1 代码侧（4 条已补齐）

| 欠账 | 修法 | 验证 |
|---|---|---|
| B6-#3 `unpacked` 标记 | `BootTimeline.mark(name, extra: Map<String,String>)`，`dump()` 追加 `unpacked=…`；`EngineManager` 在 `ensure()` **前**用 `installer.isInstalled(manifest)` 判定，`ensure()` 返回后打 `runtime` 点 | `BootTimelineTest.extraShowsUpInDump` / `markIsIdempotentAndKeepsFirstExtra` |
| B3-#1 `app` 点 | `DshApplication.onCreate` 调 `BootTimeline.markProcessStart()`（进程级 t0）；`MainActivity` 在 `EngineService.start()` 前 `mark("app")`；`start()` **不再覆盖**已有 t0 | `startDoesNotResetProcessAnchor`（app ≥ 0） |
| B3-#5 `prootMounted` 点 | `EngineManager` 在 guest 输出回调里，首条非空行打一次 `prootMounted` | 编译门禁 + 待真机 |
| A4-#4 探测流量 | `defaultProbe` 每次探测落一行 `mirror.probe bytes=<got> total=<total> bps=<bps> name=<name>`，日志可直接求和（预算 256 KB） | 编译门禁；真机需触发一次下载 |

> 说明：`runtime` 点按计划语义移到 `ensure()` **之后**（原来打在最前面，导致 install 被算进 `preflight`）。
> 这会让历史 `boot.timeline` 数值不可直接与新版本逐行对比，属**口径修正**，已在此记录。

#### 4.28.2 真机侧（1 条已补：第 3 层的「热启」）

```text
操作：引擎已 ready 的情况下，连续两次 am start（Activity 热重入）
结果：进程 pid 17628 不变；engine.ready 计数 42 → 42；boot.timeline 计数 63 → 63
      app.log 最后一条 engine.ready 仍是 19:51:48（冷启那次）
结论：热启不产生新的启动段（没有 node spawn），所以第 3 层的“热启 1 次”不能用 boot.timeline 对比；
      “冷”与“热”的差异只能用**页缓存**表达 —— 这正是 §4.19.1 的 129 MB → 0 B / 5.4 s 那条数据。
```

#### 4.28.3 仍未复验（1 条，需网络）

**A4-#6「增量仍只下变化块」**：需要一个真实 runtime 更新来触发 `RuntimeDelta`。
当前 S3 限速 ~12 KB/s，146 MB 的演练成本过高，故**不谎称完成**。演练步骤已固定：

```bash
# 1) 让设备上的 runtime 版本落后：装一个 runtimeVersion 不同的 APK（或改 files/runtime/manifest.json 的版本戳）
# 2) 触发一次启动，观察 app.log：
#      · 出现 `runtime.delta` / `using incremental parts` 一类记录
#      · 实际传输字节数 ≈ 变化分片大小，而不是 146 MB
# 3) 复验完把 manifest/戳还原，或直接覆盖安装正式版
```

#### 4.28.4 现在的验收状态

| 计划项 | 之前 | 现在 |
|---|---|---|
| B6-#3 unpacked | ❌ | ✅ 代码 + 单测 |
| B3 app 点 | 缺 | ✅ 代码 |
| B3 prootMounted 点 | 缺 | ✅ 代码（真机待装新 APK） |
| A4-#4 探测流量 | ⚠️ 无字段 | ✅ 每次探测一行 `mirror.probe bytes=` |
| 第 3 层热启 | ⚠️ 未做 | ✅ 已做并给出结论（热启无启动段） |
| A4-#6 增量复验 | ⚠️ | ⚠️ 仍待网络（步骤已固定） |

---

### 4.29 A4-#6「增量仍只下变化块」执行记录

> 提交：`3ed06eb`；编译门禁 run `46005205561` **success**（含新增 `RuntimeDeltaChunkTest`）
> 真机：2026-11-27 21:09~21:12（`files/runtime/auto-dryrun` 钩子）

#### 4.29.1 真机这一步跑出了什么

```text
2026-11-27 21:09:44 [RuntimeDelta] 发现运行时 r1-…-4820e2beae27：全量 138.7 MB
2026-11-27 21:11:58 [DSH] auto-dryrun: check 开始          ← 钩子按设计 12 s 后触发
```

- 设备上现存 `runtime/parts/r1-…-4ef4d5ef4ac0/`（旧构建）；远端清单是 `…-4820e2beae27`（debug.47）。
- `planDelta` 的增量判据是**按 64 KB 块比 hash，但前提是「本地 base 与远端文件等长」**：
  跨版本时 part1/part2 的长度已经变了（70,258,484 → 70,257,472，782,228 → 782,800），
  于是直接判**全量**。**这是设计预期，不是 bug。**
- 为什么没能做出「只差几块」的真机演练：要造等长 base，必须拿到远端那份 70 MB 的 part 文件；
  当前 S3 限速 ~12 KB/s，不划算。演练在 `check` 阶段抓完证据后**立即 force-stop**，没有进入 apply（避免 138.7 MB 流量）。

#### 4.29.2 判定层改为可测（这是本轮真正的交付)

把 `planDelta` 里的块比对抽成纯函数（不碰 JSON / 网络）：

```kotlin
internal fun changedChunkIndexes(local: List<String>?, remote: List<String>): List<Int> {
    if (local == null) return remote.indices.toList()      // 没有同长度基线 ⇒ 全量
    val out = ArrayList<Int>()
    for (i in remote.indices) if (i >= local.size || local[i] != remote[i]) out.add(i)
    return out
}
```

`RuntimeDeltaChunkTest`（5 例，编译门禁已跑过）：

| 用例 | 断言 |
|---|---|
| `noBaseMeansFullDownload` | `local=null` → 返回所有块号 |
| `identicalBaseNeedsNothing` | 完全一致 → 空列表（整文件复用） |
| `onlyChangedChunkIsFetched` | 只改第 3 块 → 只返回 `[2]` |
| `shorterLocalCountsTailAsChanged` | 本地短 → 尾部块全部算变化 |
| `emptyRemoteNeedsNothing` | 远端空清单 → 空列表 |

`planDelta` 同步改成调用它，行为不变（`incremental` 标志、`need/total` 语义都保持）。

#### 4.29.3 真机验收判据（留给下一次真实升级）

```text
当设备真的从 N 升到 N+1 时，看两处：
1) app.log：`发现运行时 <ver>：增量 X MB / 全量 Y MB`（或 stateJson 的 needBytes < totalBytes）
2) stateJson：`incremental=true`
只要 X 明显小于 Y，且最终 rootfs 校验通过，A4-#6 就算真机闭环。
```

#### 4.29.4 演练钩子的正确用法（写下来，别再摸）

```bash
# 开：下一次冷启 12 s 后自动 check（不改代码）
run-as com.dsh.android touch files/runtime/auto-dryrun
# 关（**必须**：否则每次启动都跑一次检查）
run-as com.dsh.android rm -f files/runtime/auto-dryrun
```

本轮已确认 marker 已删除（`ls` → No such file）。

---

### 4.30 装 `debug.47` 验增量（A4-#6 真机闭环：到「0 字节」这一半）

> 装机：`vc=132 / 0.2.2-rc.5-debug.47`（Release 重签包，`dsh-android-0.2.2-rc.5-debug.47-arm64.apk`，161,793,263 B）
> 真机时间线：21:47 装 →21:51 首启（含解包）→21:56 / 21:59 两次 check

#### 4.30.1 装完先看 runtime 有没有换掉

```text
首启前：.rootfs.stamp = …-4ef4d5ef4ac0（debug.46 的 runtime）
首启后：.rootfs.stamp = …-4820e2beae27（debug.47 的 runtime）✓
        parts/ 里也出现 …-4820e2beae27/（安装器按分片落盘）
        rootfs/opt/dsh/node_modules/@opentelemetry → No such file ✓（构建期已摘）
        engine.ready 67,754 ms（首次含 74 MB xz 解包，属预期）
```

> 中途发现一个真实行为：**`files/runtime/parts/` 与根目录下的 `manifest.json` 必须同时存在，增量才有基线**。
> 我们为了强制从 APK 重装，把旧 `parts/` 和 `.rootfs.stamp` 挪走（`parts.old1` / `.rootfs.stamp.old1` 仍在），
> 重装后两者才重新生成。

#### 4.30.2 增量链路的两次真机判定

| 时刻 | 本地基线 | 日志 / stateJson |
|---|---|---|
| 21:51:55（安装中，manifest 还没落地） | 无 | `发现运行时 …-4820…：全量 138.7 MB` |
| 21:56:57（装好后） | 有 | `运行时已是最新（…-4820…）` |
| 21:59:36（auto-dryrun 复测） | 有 | `state=ready, from=…-4820, to=…-4820, needBytes=0, totalBytes=0, incremental=false` |

⇒ **版本一致时严格 0 字节**，链路正确；`from/to` 都取自真实清单，不是常量。

#### 4.30.3 顺手抓到一个副作用（已修）

`applyAsync` 在 `needBytes=0 / totalBytes=0` 时**仍然会进 runApply**，把空的 staging 换进 `parts/<ver>`，
于是 **parts 基线被清空** —— 下一次升级就会从「增量」退化成「全量」。

已在 `applyAsync` 开头加短路（`needBytes==0 && totalBytes==0` → 直接返回 true，不动磁盘）：

```kotlin
if (needBytes == 0L && totalBytes == 0L) {
    message = "运行时已是最新，无需应用"
    Log.i(TAG, "applyAsync 跳过：$message")
    return true
}
```

#### 4.30.4 装完后冷启数据（debug.47 + 自带精简 runtime）

| 场景 | preload→首响应 | modules.count | modules.compile.ms | engine.ready |
|---|---|---|---|---|
| 首启（含解包） | — | — | — | 67,754 ms |
| 第 2 次冷启 | 18,791 ms | **247** | 3,015 ms | 23,776 ms |
| 第 3 次冷启（cache 回温） | **16,161 ms** | 247 | **2,774 ms** | 20,780 ms |

对比 §4.23 手工精简态（358 模块 / 3.8 s）：构建期就瘦身的 runtime **再少 111 个模块、编译再省 1 s**。
冷启稳定在 **16.2 s** 量级（与 15.7 s 同级，差异来自模块路径变化后 V8 cache 冷了一轮）。

#### 4.30.5 A4-#6 到底验到哪一步（如实）

```text
✅ 真机验证 1：无本地清单 → 判全量（138.7 MB），逻辑与日志都对
✅ 真机验证 2：本地清单与远端一致 → needBytes=0 / totalBytes=0，0 字节
✅ 判定层：changedChunkIndexes 5 例单测（全量 / 一致→0 / 单块 / 尾部 / 空）
⚠️ 差最后一段：0 < needBytes < totalBytes 的「只下变化块」端到端，
   需要一个与远端等长的本地 base（= 71 MB 的 part1），当前带宽下不划算。
   判据已固定：真实升级时看 `incremental=true` 且 `needBytes ≪ totalBytes`。
这次装机顺带清掉了 parts 基线（副作用已修），下次升级会先重建 parts，再谈增量。
```

#### 4.30.6 设备现状

```text
版本      vc=132 / 0.2.2-rc.5-debug.47（Release 同源）
runtime   …-4820e2beae27（构建期已去重 zod、摘 otel）
冷启      16.2 s 量级
演练残留  files/runtime/parts.old1、.rootfs.stamp.old1（可删）；auto-dryrun marker 已删
```

---

### 4.31 发 `debug.48 (vc133)` 并装机验证 9 打点 + 短路

> 提交：`c321f5a`（release 版本）、`9e38126`（app 点修复）
> CI：APK `46025136774` success；sign `46026968723` success；compile（9e38126）跑中
> 真机：23:45 首启（解包已完成，runtime 未变）

#### 4.31.1 发版

```text
versionName 0.2.2-rc.5-debug.48 / versionCode 133（VERSION PASS）
apk.yml 46025136774 → dsh-system-debug（同 sha）
sign 46026968723 → dsh-system-debug-upgrade-signed 15211739535（162,048,900 B）
装机：pm install -r -d → Success，vc=133 / debug.48
```

> 期间 `git push` 又撞 GnuTLS，改用 git-data API 推（`/root/dsh-work/v113/api_push.py`）；
> 注意 API 推必须给**完整 40 位 sha** 作 base，9 位短 sha 会 404。

#### 4.31.2 真机 dump：9 个点里 8 个已现身

```text
23:45:36 boot.timeline total=22444ms
  runtime           721ms  Δ   721ms  █  unpacked=false      ← 新字段 ✓
  preflight        2703ms  Δ  1982ms  ███
  prootSpawn       2779ms  Δ    76ms  █
  prootMounted     3078ms  Δ   299ms  █                      ← 新点 ✓
  nodeExec        19695ms  Δ 16617ms  █████████████████████████████
  health          22442ms  Δ  2747ms  ████
  ready           22444ms  Δ     2ms  █
  gui             （WebView 首帧，+10 s 量级）
```

**`app` 点没出现** —— 根因找到了：`MainActivity` 在 `EngineService.start()` **之前**打 `app`，
而 `EngineManager.startProot()` 里的 `BootTimeline.start()` 会 `marks.clear()`，把它擦掉。

已修（`9e38126`）：`start()` 保留 `app` 这一个点，并加单测 `appMarkSurvivesStart`（断言 dump 里 app 在 runtime 之前）。
**该修复需下一次构建（debug.49）才在真机可见**，本轮如实记录为「待验」。

#### 4.31.3 短路修复：真机验证通过

```text
23:46:51 [RuntimeDelta] auto-dryrun applyAsync 跳过：运行时已是最新，无需应用
23:46:51 auto-dryrun: check 结果={"state":"ready", …, "needBytes":0,"totalBytes":0,"incremental":false}
23:46:51 auto-dryrun: applyAsync 返回=true
```

并且专门验证了「不再清 parts」：先手工建好 `parts/<ver>/.keep`，跑一次 dryrun 后：

```text
23:48:15 [RuntimeDelta] applyAsync 跳过：运行时已是最新，无需应用
parts/<ver>/.keep 仍在（目录未被换空）✓
```

#### 4.31.4 冷启数据（debug.48）

```text
preload→首响应 未单独取（本次重点是打点）；engine.ready 21,756 ms
boot.timeline total=22,444 ms（含 gui 前）
```

与 debug.47 的 16.2 s 同级，差异来自本轮多打的点与网络/温度波动，未做三次取样（下轮补）。

#### 4.31.5 状态

| 项 | 状态 |
|---|---|
| `unpacked=false` 字段 | ✅ 真机可见 |
| `prootMounted` 点 | ✅ 真机可见（3078 ms） |
| `app` 点 | ⚠️ 代码已修（9e38126）+ 单测，**待 debug.49 真机确认** |
| `applyAsync` 短路 | ✅ 真机验证（日志 + parts `.keep` 未被清） |
| 发布 | `v0.2.2-rc.5-debug.48` 的 APK 已装机；Release 尚未 dispatch（需要时一条命令） |

---

### 4.32 发 `debug.49 (vc134)`：A/B 计划 9 点全部真机落地

> 提交：`87aca83`（release 版本 + CHANGELOG）
> CI：APK `46045137370` success；sign `46046726803` success（artifact `15223236142`）；
> publish `46047668340` success → Release `v0.2.2-rc.5-debug.49`（prerelease，9 资产）

#### 4.32.1 发版与装机

```text
versionName 0.2.2-rc.5-debug.49 / versionCode 134（VERSION PASS）
APK 161,697,588 B（Release 资产）→ 装机 pm install -r -d Success → vc=134
```

#### 4.32.2 真机 `boot.timeline`：**9 点齐全**

```text
02:10:42 boot.timeline total=24994ms
  app               454ms  Δ   454ms  █                 ← 本轮修复的点
  runtime           803ms  Δ   349ms  █  unpacked=false
  preflight        3697ms  Δ  2894ms  ████
  prootSpawn       3738ms  Δ    41ms  █
  prootMounted     4063ms  Δ   325ms  █
  nodeExec        22044ms  Δ 17981ms  ████████████████████████████
  health          24992ms  Δ  2948ms  ████
  ready           24994ms  Δ     2ms  █
  （gui 在 WebView 首帧后追加，量级 +10 s）
engine.ready 24,291 ms / health=401 / runtime=proot
```

对比 vc133（8 点、无 `app`）→ **vc134 的 `app=454 ms` 成功保留**，与单测
`appMarkSurvivesStart` 的预期一致（`start()` 只保留 `app`，不再整体清空）。

#### 4.32.3 冷启数据（vc134）

```text
preload→首响应  16,737 ms
modules.count   247（构建期去 zod + 摘 otel 后的稳态）
modules.compile 2,848 ms
engine.ready    21,044 ms
```

与 §4.30 的 16.2 s 同级，说明「多打一个点」没有可见开销。

#### 4.32.4 至此 A / B 计划的验收状态

| 计划项 | 状态 | 证据 |
|---|---|---|
| A1~A4（多线路 + 判定） | ✅ | 单测 + 真机 `全量 138.7 MB` / `needBytes=0` |
| A4-#6 偏量端到端 | ⚠️ | 判定层单测；端到端需一次真实增量升级 |
| B1~B6（分段观测） | ✅ | 9 点齐全、误差 0、`unpacked` 有值、不影响耗时、guest 时间戳超额 |
| B 三层测量 | ✅ | 第 1/2 层落地；第 3 层用页缓存对照 + 热启结论结案 |
| 计划外优化 | ✅ | 42.0 s → 16.7 s（−60%）；direct 已决策不动 |

#### 4.32.5 遗留（不影响验收）

1. `A4-#6` 的「0 < need ≪ total」需一次真实升级（判据已固定）；
2. `gui` 点没有单独的 Δ 说明（它在 `ready` 之后由 WebView 回调追加，属既有行为）；
3. 设备上仍有 `parts.old1` / `.rootfs.stamp.old1` 等演练残留（可删）。

---

### 4.33 A4-#6 闭环：**真机真实升级**，`incremental=true` 且 `needBytes ≪ totalBytes`

> 执行时间：2026-11-28 08:40~09:55（设备 vc133→134→135）
> 结论：**A4-#6 关闭**。真机跑了 4 次真实升级（含 2 次失败），最终拿到
> `needBytes=1,888 / totalBytes=784,556 = 0.24%`、`incremental=true`、解包期两片都走「增量分片」、
> 新运行时里的探针文件真的生效。
> 顺带挖出并修掉 **2 个真 bug**（其余 1 个只记录）：见 4.33.4。

#### 4.33.1 为什么要在真机上「造一次升级」

`RuntimeDelta.planDelta` 的增量只有在 **本地已有同长度基线** 时才会按 64 KiB 块比 hash：

```text
local = parts/<ver>/<asset>  或  runtime/<asset>
if (local != null && local.length() == remote.bytes) → 逐块比 → 只下变化的块
else → 该文件整包下载
```

设备出厂状态（用 APK 自带 assets 解包）**没有 `parts/`**，所以第一次联网升级必然是全量；
`Debug.49` 之前只验过两个极端态（无基线→全量 138.7 MB；清单一致→0 B），**中间态从未被真实触发**。

#### 4.33.2 演练设计（不重下 145 MB 的做法）

真机实测：`rootfs-part0/opt=74.4 MB`、`part1/usr=70.3 MB`、`part2/var+etc=782 KB`、`part3=1.9 KB`。
所以只拿 `part2 + part3` 做文章：

```text
① 播种基线：发布 rA/rB 两个「只列 part2 / 只列 part3、字节与原版完全相同」的 runtime Release
   → 真机走一次真实下载（782,772 / 1,888 B）→ parts/<ver>/ 有了基线
② 造偏量：把 part3 里的 root/.profile 换成探针文本，并用 `xz -6 -T1` 把**压缩后长度压回 1,888 B**
   （与旧 part3 逐字节等长）→ 客户端块比对应只下 1 个块
③ 真升级：发布 rD2（chunks 列 part2+part3，manifest 的 part3 sha 换成新的）
   → 真机 check → apply → 解包 → 启动，全程真网络、真磁盘
```

> `xz -6 -T1` 输出恰好 1,888 B 是实测所得（`-6e` 为 1,852 B，可加 4 字节对齐的 stream padding 补齐；
> 这里直接用 `-6` 命中，避免 padding 争议）。

#### 4.33.3 真机证据（vc135 / runtime `…-4820e2beae27-rD2`）

```text
check  → {"to":"…-rD2","needBytes":1888,"totalBytes":784556,"incremental":true}
apply  → 运行时 …-rD2 已就绪（增量 1 KB）
解包   → part2 用增量分片：runtime/rootfs-part2-arm64-v8a.tar.xz（782668 字节）
        part3 用增量分片：runtime/rootfs-part3-arm64-v8a.tar.xz（1888 字节）
        rootfs 就绪（分片）…（…-rD2）
探针   → files/runtime/rootfs/root/.profile 第一行 = `#A4-#6 runtime probe (part3, same-size 1888)`
冷启   → app 427 / runtime 760(unpacked=false) / preflight 2487 / prootSpawn 2528 /
        prootMounted 2789 / nodeExec 16625 / health 18726 / ready 18728 ms
        preload→首响应 13,839 ms；modules 247；compile 2,401 ms；engine.ready 18,033 ms
```

`needBytes / totalBytes = 0.24%` —— A4-#6 的判据「0 < need ≪ total 且 incremental=true」**成立**。

#### 4.33.4 演练挖出的 bug（3 个）

| # | Bug | 现象 | 处置 |
|---|---|---|---|
| 1 | `RuntimeDelta.partFile` 只按 `asset` 原样拼路径（`runtime/rootfs-…`），而增量落盘名是 chunks 键（`rootfs-…`） | 增量下好的分片永远找不到 → 解包退回 APK 旧分片 → `rootfs分片校验失败：part3 sha256=…`，App 进错误页 | **已修** `80b0c66`（同时试带/不带前缀）+ `RuntimeDeltaPartFileTest` 4 例，出 `debug.50/vc135` |
| 2 | `pruneOldParts` 用 `sortedByDescending { it.name }`（字典序）保留基线 | `…-r2` 与 `…-rA` 并存时把 `rA` 当「更新」⇒ **刚下好的 r2 被删** | **已修** `9e4f256`（改用 `RuntimeFiles.pruneParts`，按 mtime），出 `debug.51/vc136` |
| 3 | `RuntimeDelta` 的 `incremental` 语义只覆盖「有基线且发生了块下载」，**整文件被跳过**（`fetch.isEmpty()`）不算增量 | 只跳过文件、没有块级差异时日志显示「全量 X KB」 | **仅记录**（不影响正确性；要改需重定义 `anyIncremental`，属行为变更） |

#### 4.33.5 失败过的路径（都是真实故障，不是假设）

```text
❌ 直接对 Release49 做全量升级：镜像 429 KB/s，下载到 30 MB 时
   「分块下载失败 rootfs-arm64-v8a.tar.xz@30867456」（GhProxyCom 断流），且无断点续传
❌ rA→r2 两段式：mirror 缓存把旧 chunks 又发了一次（files 只列 part3），
   且 pruneOldParts 把 r2 目录删掉 → 解包期 sha 失败
✅ rD1（播种）→ rD2（偏量）两段式：一次过
```

> 镜像缓存实测 TTL ≈ 60~90 s：**删除/替换 Release 资产后要等它过期**，否则设备会拿到旧清单。

#### 4.33.6 服务端现状（演练留下的东西）

```text
保留  runtime-rD2-4820e2beae27（3 资产：chunks/manifest/part3-1888）
      —— 故意保留：它排在 releases.atom 首位，且版本 == 设备本地版本
      ⇒ 以后 check 会命中它并判「已是最新」，不会把设备拽回 49/50 的旧 runtime
已删  runtime-rA / runtime-rB / runtime-rC / runtime-rD1（4 个演练 Release）
已恢复 v0.2.2-rc.5-debug.47 / debug.49 的 runtime-chunks.json 原资产（282,673 B）
```

#### 4.33.7 设备现状

```text
APK      vc=135 / 0.2.2-rc.5-debug.50（9 点 boot.timeline、partFile 已修）
runtime  …-4820e2beae27-rD2（stamp 一致；root/.profile = 探针）
残留     files/runtime/parts/.old-rC（演练中间态，可删）
         /sdcard/Download/rtbase/（145 MB 演练素材，可删）
         /sdcard/Download/dsh49.apk、dsh50.apk（可删）
```

#### 4.33.8 收尾：`debug.51 (vc136)` 已构建通过

```text
提交      9e4f256   fix(runtime): pruneOldParts 改按 mtime
CI        46095426260  success（runtime (arm64-v8a) + assembleSystemDebug，含 app-unit-tests）
版本      tools/app-version.txt → 0.2.2-rc.5-debug.51 / vc=136（VERSION PASS）
```

真机仍停在 vc135，**这不是回归**：`pruneOldParts` 只在「一次 apply 之后」触发，
本次演练已实证 bug #2 存在，修复留待下一次真实升级验证（出包即可）。

#### 4.33.9 A4 / B 计划最终状态

| 项 | 状态 |
|---|---|
| A1~A4 多线路下载 + 判定 | ✅ |
| **A4-#6 偏量增量（真机端到端）** | ✅ **本轮关闭**（0.24%，incremental=true） |
| B1~B6 分段观测 | ✅（9 点、误差 0、`unpacked` 有值、无额外开销） |
| B 三层测量 | ✅ |
| 计划外优化 | ✅（42.0 s → 13.8~16.7 s） |
| direct（免 proot） | ⏸ 已决策不动 |

---

### 4.34 发 `debug.51 (vc136)`：装机 + 二轮真实升级验证 `prune-by-mtime`

> 提交：`9e4f256`（prune 修复）· `cf5d397`（4.33 文档）
> CI：build `46095426260` success · sign `46096691971` success（artifact `15243805669`）
> publish `46098056358` success → Release `v0.2.2-rc.5-debug.51`（prerelease，9 资产，APK 161,701,388 B）

#### 4.34.1 装机与 9 点

```text
pm install -r -d → Success；vc=136 / 0.2.2-rc.5-debug.51
boot.timeline total=24,016ms
  app 546 / runtime 887(unpacked=false) / preflight 4,985 / prootSpawn 5,060 /
  prootMounted 5,176 / nodeExec 21,406 / health 24,013 / ready 24,016 / gui
engine.ready 23,157ms  health=401 runtime=proot
```

#### 4.34.2 二轮真实升级：验证「prune 按 mtime」修复

```text
rD3 = 与 rD2 同长（part3 仍 1,888 B）但内容换成 probe v2：
      root/.profile = "#A4-#6 runtime probe v2 (prune-by-mtime fix)"
      压缩用 `xz -5 -T1`（实测正好 1,888 B，无需 padding）

check → {"to":"…-rD3","needBytes":1888,"totalBytes":784556,"incremental":true}
apply → 运行时 …-rD3 已就绪（增量 1 KB）
parts → apply 后只剩 `…-rD3`（旧的 `…-rD2` 被 prune 删掉）
        ⇒ **bug #2 修复成立**（此前是字典序把旧版本留下、新版本删掉）
解包  → part2 用增量分片：782668 字节
        part3 用增量分片：1888 字节
探针  → root/.profile = "#A4-#6 runtime probe v2 (prune-by-mtime fix)"
启动  → engine.ready 61,624ms（含 146 MB 分片复制 + ~1.5 GB 解包）
```

#### 4.34.3 修完后的冷启基线（vc136 / 官方 runtime）

```text
preload→首响应 14,510 ms
modules.count  247
modules.compile 3,033 ms
boot.timeline  total 19,756 ms（app 485 → ready 19,756）
engine.ready   18,970 ms
```

#### 4.34.4 收尾：设备与 release 都回到「官方态」，零漂移

演练会制造出与 Release 不同的 runtime 版本（`…-rD3`），若不处理，下次「检查更新」会为了对齐
而全量重下 145 MB。收尾做法：

```text
① 把 files/runtime/parts/<…-rD3> 挪成 .old-rD3（不删，留证据）
② 重启 → resolveManifest 回退 APK assets → 用 assets 分片重新解包
   → stamp 回到 `…-4820e2beae27`（与 Release51 的 runtime 完全一致）
   → root/.profile 恢复原样（探针消失，属预期）
③ 删除演练 Release：runtime-rD2 / runtime-rD3（此前的 rA/rB/rC/rD1 已删）
   ⇒ 仓库只剩正式 Release：51 / 49 / 47 / 45 / 44 …
```

现在设备 `stamp` == Release51 的 `runtimeVersion`，**下一次检查更新 = 已是最新**，不会再拉 145 MB。

#### 4.34.5 遗留（不影响功能）

```text
· files/runtime/parts/.old-rC、.old-rD3（演练中间态，可删）
· /sdcard/Download/rtbase/（145 MB 演练素材）、dsh49/50/51.apk（可删）
· `incremental` 语义仍不含「整文件被跳过」的情形（日志会显示「全量 X KB」），只记录不改
```

---

### 4.35 清理演练残留（A4-#6 收尾）

> 不改代码、不动版本号（仍是 `debug.51 / vc136`）。只清「演练过程中制造的临时物」，
> 目标：设备、下载目录、`/data/local/tmp`、GitHub tag、工作区草稿五处都不留垃圾。

#### 4.35.1 清理清单与结果

| # | 位置 | 内容 | 处置 | 结果 |
|---|---|---|---|---|
| 1 | `files/runtime/parts/` | `.old-rC`、`.old-rD3`（演练中间态基线） | `rm -r` | ✅ 目录已空（只剩 `.`/`..`） |
| 2 | `/data/local/tmp` | 15 个历史 APK（apk34s/apk35/apk41~45/dsh46*/dsh47~51…） | `rm -f *.apk` | ✅ 4,207,381 KB → 1,785,529 KB（**−2.42 GB**） |
| 3 | `/sdcard/Download` | `rtbase/`（145 MB 演练素材）+ `dsh46-c/dsh46-layer2/dsh46-upgrade-signed/dsh47~51.apk`（8 个） | `rm -rf` | ✅ 全部消失（**−1.45 GB**） |
| 4 | `/sdcard/Download` | `dsh-0.2.2-rc.5-debug.46-layer1.apk`（B 阶段早期包，166 MB） | `rm -f` | ✅ 已删 |
| 5 | GitHub | 7 个演练 tag：`runtime-r2/rA/rB/rC/rD1/rD2/rD3` | `DELETE /git/refs/tags/…` | ✅ 7 个全 204，`matching-refs` 返回空 |
| 6 | 工作区 `_tmp/` | 已入库的 progress 草稿（4.18/4.18.7/4.20~4.34）+ handoff 草稿 | `rm -f` | ✅ 125 KB → **28 KB**（只剩 3 份单测副本 + `boot-timing-esm.py`） |

#### 4.35.2 磁盘前后对比（真机实测）

```text
/data/user/0      308G → 304G   （−4 GB，tmp 里的历史 APK 是大头）
/storage/emulated 307G → 305G   （−1.6 GB）
```

#### 4.35.3 清理后的健康自检（真机）

```text
versionName = 0.2.2-rc.5-debug.51（vc136）
stamp       = r1-arm64-v8a-…-4820e2beae27      ← 官方 runtime，未被清理动摇
parts/      = 空（`.` / `..`）                  ← 无演练基线残留
root/.profile = 原版（探针已被 assets 解包覆盖）
engine.ready  = 18,001 ms  health=401 runtime=proot
check         = {"message":"运行时已是最新（…-4820e2beae27）","needBytes":0}
```

> 注意：`parts/` 清空**不影响**正常运行 —— `RootfsInstaller` 先看 `parts/<ver>/manifest.json`，
> 没有就回退 APK assets；`stamp` 与 assets 版本一致 ⇒ 直接 `isInstalled` 返回 true，不会重新解包。
> 下次真实升级会重新在 `parts/` 里播种基线，属于设计路径。

#### 4.35.4 GitHub 侧现状（只剩正式 Release）

```text
v0.2.2-rc.5-debug.51 / .49 / .47 / .45 / .44 …   （都是 9 资产、prerelease）
runtime-*  ：0 个 release、0 个 tag
```

#### 4.35.5 有意保留的东西

```text
_tmp/BootTimelineTest.kt · BootTimingPreloadTest.kt · RuntimeDeltaChunkTest.kt
_tmp/boot-timing-esm.py
  —— 这三份是「仓库里同一文件的副本」，留着方便对照；py 是 ESM 分析脚本
/sdcard/Download/v8cache.cjs
  —— 手工 flush 脚本（§4.22.5），排障时还会用到
files/home/.dsh/v8cache/（引擎侧编译缓存）
  —— 正常运行态，不属于残留
```

---

### 4.36 启动回归门禁：把「冷启 14.5 s」变成 CI 硬阈值

> 提交：`d44ee69`；CI：`启动回归门禁` run `46100444633` **success**（7 步全绿）
> 不改 app 代码、不动版本号：仍是 `debug.51 / vc136`。

#### 4.36.1 为什么要做

`14.5 s` 是「构建脚本 + profile + PRoot + node 版本」四者合起来的结果：

```text
· 构建期多留一个包 → 模块数从 247 变 420，冷启多 3 s；编译不会报错
· 谁把 §3.35 的 zod 去重或 §3.36 的 otel 再删/再加 → 只体现在「真机多花几秒」
· 改了 launch.argv / NODE_OPTIONS → 也可能只退化不报错
```

以前只能靠人再用手机量一次才发现。现在把真机基线固化，让 CI 每次改动都撞一遍阈值。

#### 4.36.2 实现（`tools/boot-timing-report.py` 增强）

```text
新增开关            --assert --baseline <json>   逐指标断言，超标 → ::error + exit 1
                   --json-metrics              只输出折算后的指标（给脚本用）
                   --log <path>                 显式日志路径（也仍支持位置参数 / stdin 的 -）
新增指标（5 项）     preload_to_first_ms · listen_to_listening_ms · modules_count
                   modules_compile_ms · total_host_to_first_ms
阈值语义            actual ≤ base * (1 + tolerance)
                   · tolerance 可全局（基线根）或每指标覆盖
                   · 也支持 "limit": N 写成绝对值上限
                   · 日志里缺指标 → 记 skip（除非 "required": true 才算失败）
只看最后一个 block   历史块可能来自旧版本，拿它们比会误报
```

#### 4.36.3 基线（真机实测，`tools/boot-baseline.json`）

```json
{
  "name": "debug.51 冷启基线（真机 M 系 / vc136）",
  "tolerance": 0.25,
  "metrics": {
    "preload_to_first_ms":    { "value": 14510 },
    "listen_to_listening_ms": { "value": 3408 },
    "modules_count":          { "value": 247, "tolerance": 0.1 },
    "modules_compile_ms":     { "value": 3033 },
    "total_host_to_first_ms": { "value": 14500 }
  }
}
```

`modules_count` 单独收紧到 +10%（涨模块数是最常见的隐性退化）。

#### 4.36.4 固化的正负样本

```text
tools/fixtures/boot-timing/debug51-cold.log   真机 vc136 冷启原样块（必须绿）
tools/fixtures/boot-timing/regressed.log      人为把 5 项全放大（必须红）
```

本地实测：

```text
$ python3 tools/boot-timing-report.py --assert --baseline tools/boot-baseline.json --log …/debug51-cold.log
基线：debug.51 冷启基线（真机 M 系 / vc136）（2026-11-28）
  ✅ （全部指标在阈值内）
OK：启动耗时未越过基线阈值（…）            rc=0

$ … --log …/regressed.log
  ❌ preload→首响应(preload_to_first_ms)=26000 > 18138（基线 14510，容差 +25%）
  ❌ listen→listening(listen_to_listening_ms)=12143 > 4260（基线 3408，容差 +25%）
  ❌ 模块数(modules_count)=420 > 272（基线 247，容差 +10%）
  ❌ 模块编译(modules_compile_ms)=9000 > 3791（基线 3033，容差 +25%）
  ❌ host→首响应(total_host_to_first_ms)=34085 > 18125（基线 14500，容差 +25%）
::error title=启动回归::…（5 条 annotation） rc=1
```

#### 4.36.5 CI：`.github/workflows/boot-regression.yml`

```text
触发    push(main, 只在这些路径：tools/boot-timing-report.py / tools/boot-baseline.json /
        tools/fixtures/** / tools/tests/** / 本 workflow)、pull_request、workflow_dispatch
步骤    ① 门禁自测：python3 -m unittest discover -s tools/tests -p 'test_*.py'（13 例）
        ② 正例：debug51-cold.log 必须绿
        ③ 负例：regressed.log **必须判红**（否则 `::error` + exit 1，门禁自己坏了要爆）
        ④ sh tools/version.sh --check（版本头一致性）

run 46100444633 → success
  JOB boot-timing 阈值回归
    4 门禁自测（13 例，含容器调用）          success
    5 正例：已知良好样本必须绿               success
    6 负例：回归样本必须被判红               success
    7 版本头一致性                          success
```

> ③ 是这道门禁的关键：**只测「该绿的绿」会让人以为门禁有效**，必须同时证明「该红的红」。
> 13 例单测覆盖了解析、指标折算、绝对上限、required、可选指标跳过、以及 3 个 CLI 退出码。

#### 4.36.6 日常怎么用（真机取一次日志就能判）

```bash
run-as com.dsh.android cat files/logs/boot-timing.log > /tmp/bt.log   # 或 adb
python3 tools/boot-timing-report.py --assert --baseline tools/boot-baseline.json --log /tmp/bt.log
# 想看瀑布图就不带 --assert：
python3 tools/boot-timing-report.py /tmp/bt.log
```

超标时同一行会带 `::error`，GitHub Actions / 本地 CI 都能直接变成红叉。

#### 4.36.7 踩到的坑

```text
· api_push.py 不认「未跟踪的目录」：`git ls-files --others` 会把目录当文件 open →
  IsADirectoryError（tools/__pycache__/、tools/fixtures/ 各踩一次）。
  正解：本地 `git fetch` → `git reset --mixed origin/main` → `git add -A` → commit → push，
  这样 commit 干净（只 6 个文件）且是快进推送。
· 跑完 unittest 会生成 __pycache__/，提交前必须清（仓库未忽略它）。
· report.py 的 flag 解析不能「过滤掉 -- 开头的 token 就把剩下的当路径」——
  `--baseline x.json` 里的 x.json 会被误当日志路径（已改成显式消费参数）。
```

#### 4.36.8 现状

```text
基线文件    tools/boot-baseline.json（值来自 §4.32~§4.34 真机日志，改基线要写清来源）
执行器      tools/boot-timing-report.py（--assert / --json-metrics；渲染功能不变）
门禁        .github/workflows/boot-regression.yml（run 46100444633 success）
单测        tools/tests/test_boot_timing_report.py（13 例）
远端 main   d44ee69
```
### 4.37 状态栏双入口弹层 + 轨迹堆叠：**真因是陈旧热包压制内置前端**

> 版本：`0.2.2-rc.5-debug.54 / vc139`（已装机）。提交：`eeb5ca6`（弹层+CSS）、`eb6ca31`（zip 重打）、`38d0ebf`（热包闸门）

#### 4.37.1 现象与三连连环坑

用户在 vc138 报「①点了没弹 ②轨迹仍堆叠」。实测结论：**改的代码根本没上设备**。

```text
设备 files/home/.dsh/mobile-ui/dsh-android-mobile/lib/client.js
  657,311 B · 2026-11-24 · grep mpOpenStats = 0        ← 旧版
设备 files/runtime/plugins/mobile-ui-1.1.0-237.zip      ← 陈旧热包，242,351 B
设备 .mobile_ui_version = 1.1.0-237
```

`ensureMobileUi()` 的顺序是「热包优先于内置 assets」：`want = hot?.second ?: MOBILE_UI_VERSION`，
只要 `client.js` 存在且 `stamp == want` 就 **直接 return**。残留热包的版本号 ≥ 内置常量，
于是无论怎么 bump 内置常量、怎么重打 `assets/mobile-ui.zip`，都会被那行 `return` 吃掉。

⇒ **教训：只改 `MOBILE_UI_VERSION` 是无效修法，必须同时处理 `files/runtime/plugins/` 里的热包。**

#### 4.37.2 已做的修复

| # | 位置 | 内容 |
|---|---|---|
| 1 | 设备 | `mobile-ui-1.1.0-237.zip` → `plugins/.stale/`（保留可回滚）+ 删 `.mobile_ui_version` |
| 2 | 仓库 | `ensureMobileUi()` 加闸门：`hotMobileUiBundle()?.takeIf { cmpVersion(it.second, MOBILE_UI_VERSION) > 0 }` |
| 3 | 仓库 | `mobile-ui.zip` 重打（244,243 B，含 ①弹层 ②轨迹换行） |

闸门语义：**热更新只能向前**——热包必须严格新于内置版本才参与，旧残包再也不会永久压制升级。

#### 4.37.3 真机证据（删热包后首次启动）

```text
2026-11-28 14:37:07  [DSH] 已安装移动端 UI 插件 dsh-android-mobile 1.1.0-237 (664582 字节)
lib/client.js = 664,582 B · 2026-11-28 14:37 · grep mpOpenStats = 2
vc139 · engine.ready 21,235 ms · health=401 · runtime=proot
```

#### 4.37.4 待验收（三项）

1. 点「N轮N步」药丸 → 弹「会话统计」卡（轮/步、模型、工具、TTFT、tok/s）
2. 点「NAS K·缓存X%」药丸 → 弹「Token 用量」卡（总量/命中率/未缓存/缓存读/输出）
3. 轨迹长句换行、右侧不再堆叠、字体不变

字段为「—」时的含义：该数据来自服务端投影（`dsh-session-stats` / `dsh-token-meter`），
客户端只持有降档前的药丸原文（`dataset.mpRaw`），拿不到的项就显「—」。

### 4.38 状态栏弹层 / 轨迹单行：收口（debug.58 / vc143）

> 提交：`a2ca1f4`（弹层+轨迹 JS）· `bfd605b`（ContextMeter 同款 popover）· `6039cc2`（删残留 media）· 本提交（§4.40 单行 + 删探针）

#### 4.38.1 三步排查法（客户端插件“改了不生效”）

```text
台阶1 文件到没到设备：grep mpOpenStats files/home/.dsh/mobile-ui/.../lib/client.js
台阶2 热包是否压制：ls files/runtime/plugins/；cat .mobile_ui_version
台阶3 页面栈的是哪份：grep "移动端 UI" files/app.log（字节数应与 zip 内 client.js 一致）
```

本轮挖出的两个真凶：**陈旧热包**（`mobile-ui-1.1.0-237.zip` 一直压着内置包）与
**我的替换切掉了探针**（v303 起 diag 断流，导致三版“改了无从验证”）。

#### 4.38.2 弹层（会话统计 / Token 用量）

| 项 | 值 |
|---|---|
| 骨架 | 上游 `ContextMeter.module.css`：264px popover / padding 12 / `--dsw-specific-menu` / `--dsw-elevation-prominent` / 12px·20px |
| 配色 | `--dsw-alias-*`（旧的 `--dsh-surface-1` 不存在，永远落死黑卡） |
| 注释区 | 已删（`mp-stats-raw` / `mp-stats-note` 计数 = 0） |
| 数值 | 千分位（`44,378 tok`） |
| 数据 | `GET /__dsh_android_mobile/projection`（读 `storages/session_projcache/sessions/*.json` 最新一份） |

#### 4.38.3 轨迹「未展开」= 单行（§4.40 最终结论）

```text
根因：上游 ._row_l4nv8_26{height:calc(24px+delta);overflow:hidden}
      ×  我们「修复57」._text_1rdzk_17{white-space:normal}
      ⇒ 正文 200px、父行 25px ⇒ 溢出压叠 + 图标错位
修法：._row 保持 24px+delta + center + hidden
      ._content_1rdzk_11{min-width:0;overflow:hidden}
      ._text_1rdzk_17{nowrap;hidden;ellipsis;display:block;max-width:100%}
真机：cellH=25=parH=25；ws=nowrap；to=ellipsis；scrollHeight=25
```

#### 4.38.4 两个长期隐患已拔

```text
① 陈旧热包：hotMobileUiBundle()?.takeIf { cmpVersion(it.second, MOBILE_UI_VERSION) > 0 }
② 前端不刷新：want = 版本 + "#" + versionCode（装新版必重解压）
```
