# DSH for Android · 进度与计划

> 快照时间：2026-11-24 19:40（UTC+8）　当前发布：`v0.2.2-rc.5-debug.36` / vc121
> 架构：单宿主 PRoot + glibc 单运行时（rootfs 内 `/usr/bin/node`、`/opt/dsh`），WebView 加载官方 Web GUI
> 身份：`com.dsh.android` / targetSdk 35 / 维护态（只修 bug，不改身份与架构）

**本轮（debug.35）**：单测门禁并入 `apk.yml`（单测挂了就不出包）+ 删除仓库根目录陈旧
`app-version.txt`（debug.31/vc116，会让人改错文件）+ `publish-apk.yml` 末自动重建全量
`SHA256SUMS.txt`（原来只算 APK 一行，分片是后续 job 才上传的）。

> 设备侧已装 `debug.36 / vc121`：runtime stamp 保持 `…4ef4d5ef4ac0`（未重解包）、
> `DETAIL.md` 15 个、`parts` 144 MB 保留。启动日志：`engine.ready ms=49134` →
> `插件已激活（onUiReady）`。

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
