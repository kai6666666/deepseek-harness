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

### 4.18 B 阶段第 1 层：guest 侧时间戳 wrapper（已落地，待真机采样）

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

#### 4.18.7 真机数据（待填）

| 次 | 场景 | PRoot 装载 | node 引导 | 模块解析 | 首响应 | 合计 | rchar / read_bytes |
|---|---|---|---|---|---|---|---|
| 1 | 冷启（force-stop） | — | — | — | — | — | — |
| 2 | 冷启（force-stop） | — | — | — | — | — | — |
| 3 | 冷启（force-stop） | — | — | — | — | — | — |
| 4 | 热启 | — | — | — | — | — | — |
