# 运行时总体方案（Alpine 单档 + 工具链三层）

> **目标**：让 DSHAPP 在 Android 上有一份**可复现、可验收、可回滚**的运行时方案：
> 引擎跑在 Alpine（musl），原生插件走官方 prebuild 对齐；需要 apt 的东西走可抛弃工具链层；
> 所有"能不能跑"都用脚本断言，不靠人记忆。
>
> **状态**：设计已落地为脚本（部分实跑验证），**App 侧（Kotlin）尚未接入**——这是本方案最大的空白，见 §5 G-03。
>
> **证据等级**：本文所有数字都来自工作区文件或本机实测输出。
> 标 `【实测】` = 本轮真跑过；标 `【待验】` = 只有设计、没有真机输出。

---

## 1. 目标与非目标

### 目标

| # | 目标 | 判据 |
|---|---|---|
| G1 | 引擎只部署一份 | `engine/` 只有一套 `node_modules`，不存在 bionic/musl 混放 |
| G2 | 官方原生插件零改造可用 | `process.platform === 'linux'`、`libc = musl`，命中官方 `bin/musl/system.node` |
| G3 | 需要 apt 的场景不污染运行档 | overlay 里不启动 DSH；产物过 ABI 守卫才进引擎 |
| G4 | 一切可验收 | 6 个 `verify-*` 脚本，任一项 FAIL 即拒绝发布 |
| G5 | 体积可控 | 默认档 ≤ 100 MB；工具链层可删且删了不影响启动 |

### 非目标（明确不做）

- 不做"Ubuntu 当运行档"（体积 3 倍 + 要第二份 engine）
- 不做双档热切换（`engine/` ABI 互斥，切换必须迁移，收益不抵成本）
- 不追求 `targetSdk` 提到 34（会触发 API 29 的 `execve` 限制，等于重写落地策略）
- 不在构建期下载 rootfs（500 MB 不进 APK）

---

## 2. 现状事实

### 2.1 四仓定位

| 仓 | 是什么 | 主语言 | 对本方案的作用 |
|---|---|---|---|
| `deepseek-harness-master` | 引擎本体（Node/TS，Cordis 插件树） | TS | 补丁锚点、prebuild 目录结构、插件契约 |
| `DSHAPP-main` | Android 宿主壳（Kotlin + Termux 资产） | Kotlin | 施工主战场 |
| `Operit-main` | 1 代 Android Agent 单体 App | Kotlin | 借"可执行体伪装 `lib*.so` + `useLegacyPackaging`" |
| `Operit2-main` | 2 代跨设备 Agent（Rust + Flutter + CLI） | Rust | 借 PRoot+Alpine 配方、`apk` 装包脚本、契约 codegen |

### 2.2 硬约束（不可绕）

| 约束 | 出处 | 后果 |
|---|---|---|
| `applicationId` 恰好 15 字符 | `docs/agents/constraints.md:8` | `patchElfInPlace()` 按 `.dynstr` 等长覆盖，长度不符静默 `return 0` |
| `targetSdk ≤ 28` | 同上 `:23` | API 29+ 禁止 `execve()` 私有目录文件 → node/bash 只能放 `filesDir/$PREFIX` 这套老路 |
| `process.platform === 'android'` | 当前实现 | 官方 prebuild 无 android 分支 → 必须改平台语义（见 ADR-2） |

### 2.3 代码体量（决定改造风险）

```
Kotlin 总量            44 429 行 / 63 文件【实测】
EngineManager.kt       10 123 行（单文件）【实测】
FloatingBubble.kt       5 046 行
MainActivity.kt         4 385 行
docs/agents             37 篇（索引式，按"坑"组织）
```

**含义**：`EngineManager.kt` 是唯一的启动总闸，任何"换运行时"的改动都必须从这里切一刀，且必须可回退。

### 2.4 已落盘产物（本方案的家底）

| 目录 | 内容 | 状态 |
|---|---|---|
| `tools/alpine-runtime/` | `build-rootfs.sh` / `proot-launch.sh` / `pathmap.mjs` / `backend-select.mjs` / `verify-rootfs.sh` / `verify-alpine-node.sh` | 脚本 6 个，`pathmap` 自测 9/9【实测】 |
| `tools/toolchain-overlay/` | `install-overlay.sh` / `tc-run.sh` / `apt-shim.sh` / `deb-extract.sh` / `verify-toolchain.sh` / `toolchain.json` | 7 文件 1046 行，全脚本语法通过【实测】 |
| `tools/` 根 | `apply-patches.mjs`（幂等）/ `verify-dsh-compat.sh`（15 项）/ `dsh-plugin-compat.sh`（装前判定）/ `dsh-runtime.sh`（总控） | 幂等实测 `applied=2 skipped=2`【实测】 |
| `patches/` | `manifest.json` + `sandbox.patch.yml.tmpl` | dry-run 4 条全通【实测】 |
| `plugin-src/dsh-android-toolchain/` | `package.json` / `cordis.patch.yml` / `provision.json` / `lib/index.js` / `lib/client.js` | 6 文件，`node --check` 通过【实测】 |
| `tools/upstream-pr/android-arm64/` | `package.json` / `prebuilds.json` / `README.md` | 3 文件，待提 PR |

---

## 3. 总体架构

```text
┌──────────────────────────────────────────────────────────────┐
│  App（Kotlin，未接入本方案 —— G-03）                          │
│  EngineManager.kt 10 123 行 ── 唯一启动总闸                   │
└───────────────┬──────────────────────────────────────────────┘
                │  exec
┌───────────────▼──────────────────────────────────────────────┐
│  运行时总控 tools/dsh-runtime.sh                             │
│  status / doctor / up / run / verify / gc                    │
└──────┬──────────────────┬───────────────────┬────────────────┘
       │                  │                   │
┌──────▼──────┐   ┌───────▼────────┐   ┌──────▼──────────────┐
│ L1 运行档    │   │ L2 deb 层      │   │ L3 overlay 层        │
│ Alpine musl │   │ .deb 单文件     │   │ Ubuntu base + apt    │
│ gz56/解包165 │   │ 可删 5–15 MB/个 │   │ 可删 90–300 MB       │
│ engine 唯一  │   │ + gcompat      │   │ 永不跑引擎            │
└──────┬──────┘   └───────┬────────┘   └──────┬──────────────┘
       │                  │                   │
       └──────────────────┴───────────────────┘
                          │
                  ┌───────▼─────────┐
                  │ ABI 守卫         │
                  │ musl/static 放行 │
                  │ glibc/bionic 拒 │
                  └─────────────────┘
```

### 五个已定决策（ADR）

| # | 决策 | 理由（一句话） | 翻案条件 |
|---|---|---|---|
| ADR-1 | **单档 Alpine**，Termux 降级为工具链 | 双档=两套 engine，ABI 互斥、必然污染 | 出现"必须 bionic 才能跑"的插件 >30% |
| ADR-2 | 运行时**声明 `linux` + `musl`**，不发明 `android` 平台 | 官方 `flock` 已有 `bin/musl/system.node`，零改造对齐 | 上游合并 `android-arm64` 平台包（PR 已备） |
| ADR-3 | 工具链做**三层**，overlay 是可抛弃缓存 | 300 MB 只在需要时存在，删了不影响启动 | overlay 被引擎依赖（违反铁律 3 即作废） |
| ADR-4 | 补丁改**声明式队列 + fail-fast** | 文本锚点必漂移，静默失败是最大坑 | 上游提供稳定插件 API |
| ADR-5 | 产物进引擎前过 **ABI 守卫** | 20 样本实测 15% 插件带原生依赖，混入即崩 | —— |

---

## 4. 实施路线

| Phase | 内容 | 产出 | 验收 | 状态 |
|---|---|---|---|---|
| **P0** | 现状对齐：四仓对比、功能分账、锚点表 | 文档 + `verify-dsh-compat.sh` | 15 项体检可跑 | ✅ 完成 |
| **P1** | 补丁工程：声明式队列、幂等、revert | `patches/` + `apply-patches.mjs` | `--dry-run` 4/4、`applied=2 skipped=2`、revert 归零 | ✅ 完成【实测】 |
| **P2** | 插件供给：`dsh-android-toolchain` + 装前判定 | `plugin-src/`、`dsh-plugin-compat.sh` | 20 样本实测 17 纯 JS / 3 原生 | ✅ 完成【实测】 |
| **P3** | Alpine 骨架：构建/启动/映射/切档/验收 | `tools/alpine-runtime/` 6 文件 + **真 rootfs** | pathmap 9/9；CI `run 40114426384` success；产物 `nodejs 24.22.1-r0` / 55.4 MB / 解包 165 MB | ✅ **rootfs 已产出** |
| **P4** | 工具链三层：apt overlay / deb 提取 / ABI 守卫 | `tools/toolchain-overlay/` 7 文件 | `--dry-run` 探测到 24.04.5 + sha256；hello deb 真解包 | ✅ 完成【实测】 |
| **P5** | **接 App**：Kotlin 接入 + 资产入包 + preBuild 验收 | `runtime/` 4 文件 + `EngineManager` 3 处 + `tools/proot/README.md` | 资产入包、preBuild 闸门生效；**CI `kotlin-compile` run `40116990495` = BUILD SUCCESSFUL in 47s**（首轮 2 个编译错误已修） | ✅ **编译通过**，缺 proot 二进制（G-23） |
| **P6** | 上游 PR：`android-arm64` 平台包 | `tools/upstream-pr/` 三文件（590+195+3683 B） | 官方接受 | ⏸ **暂停**（主人 2026-10-25 决定「先放着」）——重启条件：①要长期跟上游版本走 ②其他插件也开始依赖 flock ③官方愿意接 bionic 枚举 |

---

## 5. 查漏补缺（Gap 表）

> 这一节是本文的重点。**P0 = 不做就跑不起来；P1 = 能跑但会在真实场景翻车；P2 = 降低体验或安全强度。**

### P0（阻塞级）

| # | 缺口 | 现状证据 | 影响 | 补法 |
|---|---|---|---|---|
| ~~G-01~~ ✅ | ~~档位仍枚举 termux~~ | **已完成单档收口**：`backend-select.mjs switch termux` 现在**直接拒绝（rc=2）**并提示"只作工具链模式"；`switch alpine` 正常写入；`engine/` 只可能有一份 | —— | `proot-launch.sh` 仍保留 termux 直通分支，但仅作兜底（Alpine 不可用时才走） |
| **G-02** | ~~**Alpine rootfs 真实产物未产出**~~ ✅ **已完成** | CI run `40114426384` = success；产物 `nodejs 24.22.1-r0` / 55.4 MB / sha256 `d253d66f…` | 已解决 | 后续只需在换包集时重跑 workflow |
| **G-03** | ~~**App 侧零接入**~~ ✅ **已接入且编译通过** | `com.dsh.android.runtime` 4 文件 + `EngineManager` 3 处；`compileSystemDebugKotlin` **BUILD SUCCESSFUL**（CI run `40116990495`）；缺 proot 时**零行为变化** | 只剩 proot 供给 | 见 **G-23** |
| ~~G-23~~ ✅ | ~~缺 proot 二进制~~ | **已完成**：Termux `proot 5.1.107.101` + `libtalloc 2.5.0` + `libandroid-shmem 0.7` 放进 `jniLibs/arm64-v8a/`；**真机日志实证 `DSH/AlpineRuntime: 已切到 alpine 档：rootfs=alpine proot=libproot.so`**，且进程表里 `com.dsh.android → node` 父子链成立 | —— | 换 proot 版本时按 `tools/proot/README.md` 重做 |
| ~~G-04~~ ✅ | ~~assets 无 rootfs~~ | **已落地**：CI 产出 tarball 55.4 MB（`nodejs 24.22.1-r0`，7515 条目，**解包 165 MB**），已拉到 `app/src/main/assets/runtime/`，闸门 exit 0 | —— | 随 APK 分发；rootfs 本体不入 git，只入库 manifest + 摘要 |

### P1（真实场景会翻车）

| # | 缺口 | 现象 | 补法 |
|---|---|---|---|
| ~~G-05~~ ✅ | **磁盘水位不检查** | 低空间设备解到一半失败，留下半个 rootfs | 解包前 `StatFs.availableBytes > 压缩包×3`，不足直接拒绝并给提示 |
| ~~G-06~~ ✅ | 无**断点续传/半包清理** | 下载中断 → 下次重新下 30 MB | 已加 sha256 校验（本轮），还需 `.part` + Range 续传 |
| ~~G-07~~ ✅ | 无**版本升级/回滚** | 换 rootfs 版本只能全删重装 | 保留 `alpine-<ver>` 双目录 + `current` 符号链接（`gc --old` 清理） |
| ~~G-08~~ ✅ | **架构探测缺失** | arm64 包在 x86_64 模拟器上必失败 | 启动前 `Build.SUPPORTED_ABIS`，非 `arm64-v8a` 直接给出"不支持"而不是崩 |
| ~~G-09~~ ✅ | **rootfs 落地路径约束没写死** | `/storage/emulated/0` 是 FUSE 无 exec | 强制 `filesDir`（或 `noBackupFilesDir`），并在 `RuntimePaths` 里断言前缀 |
| ~~G-10~~ ✅ | `resolv.conf` 写死三个 IP | 国内网络下 `1.1.1.1` 可能超时 | 三级：Android `netd` 拿到的 DNS → 223.5.5.5 → env 覆盖 |
| ~~G-11~~ ✅ | 补丁**锚点无自动重定位** | 上游改一行，`includes()` 判据全 False → 静默跳过 | 加"锚点模糊匹配 + 命中多处即 FAIL"；`manifest.json` 记录上游 commit |
| **G-12** | 上游 PR 的 `libc: "bionic"` 是新枚举值 | 官方 `verify-*` 可能拒绝 | 同 PR 改校验脚本白名单；PR 描述里注明向后兼容 |
| ⚠️ G-13（半） | `index.js` install 两处瑕疵 | 未用 `virtualPrefix`；`spawn` 超时只杀父进程 | 用 `virtualPrefix`；超时 `process.kill(-pid, 'SIGKILL')` 杀进程组 |
| **G-14** | 市场快照落后 | `seed.json` 9 个 vs npm 关键词 10 个（漏 `dsh-zen-free`） | `market-collect.mjs` 定时刷新 + 记录 `generatedAt` 并在 UI 提示新鲜度 |
| **G-15** | 无**版本矩阵** | DSH 版本 × rootfs 版本 × node 版本没有一张对照表 | 新增 `docs/agents/version-matrix.md`，由 `verify-*` 自动比对 |

### P2（体验/安全）

| # | 缺口 | 说明 | 补法 |
|---|---|---|---|
| **G-16** | overlay 源校验降级 | 无 keyring 时写 `Trusted: yes`（关校验） | 缺 keyring 就 `exit 33`，让用户显式 `--insecure` |
| **G-17** | `proot -0` + 共享 `$DSH_HOME` | guest 内假 root 可写 `/dsh-home` 任意位置 | overlay 档改为 `readonly` + 只绑 `workspace`；写操作显式 `--allow-write` |
| **G-18** | deb 层缺库只提示不装 | `verify --deb` 报 glibc 需 gcompat，但不自动装 | `deb-extract --auto-deps` 调 `apk add gcompat libstdc++` |
| **G-19** | 无离线/随身包 | 首启必须联网 | 提供 `--offline` 产物（rootfs 打进 APK 的 `assets`） |
| **G-20** | overlay 首次 `apt update` 在国内镜像可能慢 | 默认清华源已选好，但无回退 | 失败自动换 `aliyun` → `ports.ubuntu.com` |
| **G-21** | `verify-rootfs.sh` 未串到开机自检 | 只是命令行脚本 | 接 `DiagnosticBundle`，一键导出"档位+5 项" |
| **G-22** | 文档缺运行时索引 | `docs/agents/README.md` 无 runtime 条目 | 本轮已补（见 §9） |

### 5.1 G-03 接口草案（Kotlin 侧，待实现）

```kotlin
// RuntimeBackend.kt —— 唯一档位真相，取代散落的字符串判断
enum class RuntimeBackend(val dirName: String) {
    ALPINE("alpine"),      // 唯一运行档（musl）
    TERMUX_TOOLCHAIN("termux-toolchain"); // 只装不跑
}

// AlpineProvisioner.kt —— 首启供给：校验 → 解包 → 自检 → 落状态
class AlpineProvisioner(private val filesDir: File) {
    fun ensure(): Result<Unit>            // 幂等：已就绪直接返回
    fun verifyArchive(sha256: String): Boolean
    fun freeSpaceOk(bytes: Long): Boolean // G-05：可用空间 > 压缩包 × 3
    fun unpack(archive: File, dest: File) // G-09：dest 必须在 filesDir 下
}

// RuntimePaths.kt —— host/guest 双视角，杜绝路径拼错
object RuntimePaths {
    fun hostRootfs(): File                // ${filesDir}/runtime/alpine
    fun guestPath(host: File): String     // /workspace/... ，越界直接抛
}
```

**接入点只有一个**：`EngineManager.kt` 里"拼启动命令"的那一处，改成

```kotlin
val argv = RuntimeLauncher.argv(backend = RuntimeBackend.ALPINE, cmd = nodeArgs)
ProcessBuilder(argv).start()
```

其余 10 123 行不动。这样改造面可测、可回退。

---

## 6. 验收矩阵

| 命令 | 期望 | 频率 |
|---|---|---|
| `bash tools/dsh-runtime.sh status` | 档位 + 三层 + 体积一屏 | 每次改动后 |
| `bash tools/dsh-runtime.sh doctor` | 缺什么给什么修复命令 | 换设备时 |
| `bash tools/dsh-runtime.sh verify` | `runtime/compat/toolchain` 三项退出码汇总 | **发布前必须全 0** |
| `bash tools/alpine-runtime/pathmap.mjs self-test` | `9/9 pass` | 改路径规则后 |
| `bash tools/alpine-runtime/verify-alpine-node.sh <rootfs>` | 主版本 24 / 拒 20 / 无包拒 / 缺失返回 2 | 每次出 rootfs |
| `bash tools/apply-patches.mjs --dry-run --root <dsh>` | 4 条全通，锚点失配即非 0 | 换 DSH 版本 |
| `bash tools/verify-dsh-compat.sh <dsh>` | 15 项全绿 | 换 DSH 版本 |
| `bash tools/dsh-plugin-compat.sh <pkg...>` | 每个包一行判定 | 上架新插件 |
| `bash tools/toolchain-overlay/verify-toolchain.sh` | overlay/deb/路由/ABI 四段 | 动工具链后 |
| `bash tools/toolchain-overlay/install-overlay.sh --dry-run` | 探测到 tarball + **sha256** | 每次装前 |

---

## 7. 翻案条件（什么时候该改主意）

| 决策 | 翻案阈值 | 当前实测 |
|---|---|---|
| 单档 Alpine | "只有 glibc 能用"的插件 > 30% | **10%**（2/20），未达线 |
| Alpine 生态够用 | 原生依赖命中 = 0 | **15%**，其中 canvas 有 musl、onnxruntime 无 → 需 wasm |
| 不做双档 | 出现"必须 bionic"的插件 > 30% | 0% |
| overlay 可抛弃 | 引擎出现对 overlay 的依赖 | 目前零依赖 |

---

## 8. 待拍板

1. **G-01 单档收口**：是否现在就把 `termux` 从 `backend-select` 的档位枚举里摘掉？（迁移脚本要先写）
2. **G-02 CI**：出不出 `.github/workflows/alpine-rootfs.yml`？出了才有真 rootfs。
3. **G-04 打包策略**：rootfs 随 APK（+40 MB，离线可用）还是首启下载（APK 小，需联网）？
4. **G-03 接入顺序**：先写 `RuntimePaths` + `AlpineProvisioner`（能跑起来），还是先写 `RuntimeLauncher`（能自检）？

---

## 9. 索引入口

- 本文：`docs/RUNTIME-ARCH-PLAN.md`
- 运行档细节：`tools/alpine-runtime/README.md`
- 工具链细节：`tools/toolchain-overlay/README.md`
- 坑位档案：`docs/agents/README.md`（加了一行 `runtime-arch.md` 指向本文摘要）
- 契约与边界：`docs/agents/constraints.md`、`docs/agents/boundaries.md`
