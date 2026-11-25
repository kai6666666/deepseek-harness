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
