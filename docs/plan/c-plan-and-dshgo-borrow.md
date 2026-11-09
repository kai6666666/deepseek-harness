# 双路线演进计划：C 方案（proot/glibc）落地 + 从 dsh-Go 借鉴工程资产

> 基线：`0.4.3-debug` / vc=48 / 引擎 `@deepseek-ai/dsh@0.2.2-rc.1` / 运行时 Termux(bionic) / 真机 r29
> 计划周期：M0–M6，约 11 周（单人全职当量），可裁剪
> 依据文档：`deepseek-harness-0.4.2/docs/agents/proot-glibc-host.md`（C 方案原文）、`dsh-Go-main/docs/design/runtime-cold-start.md`、`dsh-Go-main/docs/official-parity.md`
> 落盘日期：2026-11-09

---

## 〇、目标与边界

### 做

1. 把「C 方案」从设计文档变成**可切换的第二宿主**：`HostMode.PROOT_GLIBC`，与现有 `TERMUX_BIONIC` 并行存在，运行期可切、可回退。
2. 从 dsh-Go 吸收六项工程资产：**补丁 pin 门禁 / UI 契约解耦 / 远程协议矩阵 / CI 测试网 / 增量更新 / i18n 与系统联动**。
3. 全程保持**同一条验收口径**：设备侧 `verify-engine-upgrade.sh --tools` 必须维持 `9 PASS / 0 FAIL / 1 SKIP`，任何里程碑都不得把它变成红。

### 不做

- 不做沙箱升级承诺：内核无 `CONFIG_USER_NS`、无 Landlock，proot 共享同一内核，**文件写边界仍是用户态拦截**（`boosandbox` 词法 normalize，不解析 symlink）。
- 不引入 PID 命名空间、不引入 AVF/VM。
- 不替换官方 Web 前端（继续走 polyfill + mobile-ui 注入路线），dsh-Go 的 Flutter 自绘不作为备选。

### 一句话取舍

**沙箱拿不到，生态拿得到；速度留在 bionic，生态交给 proot。**

---

## 一、现状基线（可量化，作为回归对照）

| 项 | 当前值 | 采集方式 |
|---|---|---|
| 引擎版本 | `0.2.2-rc.1`（`.stamp=0.2.2-rc.1-1`） | `verify-engine-upgrade.sh` |
| 运行时 | Termux bootstrap（bionic），node 26.13.0-1（包内） | `files/termux/usr/bin/node.real` |
| 补丁 | 10 个文本补丁函数 + 13 对 `*_GUARD` | `EngineManager.kt` grep `GUARD` |
| 锚点门禁 | 官方 5/5、EngineManager 13/13 | `tools/check-engine-anchors.mjs` |
| 原生层 | `liblinkcompat.so` / `libboosandbox.so` / `libkeyinject.so`（bionic） | `files/` 根 |
| UI 耦合 | 87 个 webpack 哈希类名 | 正则统计（见附录 A） |
| 门禁 | 9 PASS / 0 FAIL / 1 SKIP | 设备侧 ve 脚本 |
| 冷启 | 引擎就绪 t+15.9 s（已解包）/ t+74 s（首解包），页面就绪 +15.9 s | `app.log` `engine.ready` |

> 关键：C 方案会把冷启动**变慢**（proot ptrace 开销，同机实测引擎段 +80%）。所以本计划**不替换默认宿主**，只新增可选宿主。

---

## 二、目标架构：宿主抽象 + 双后端

```
MainActivity / EngineService
        │
        ▼
┌───────────────────────────────────────────────┐
│                 EngineManager                 │  ← 只依赖接口，不知道下面是 bionic 还是 proot
│  ensureExtracted / start / stop / healthCheck │
└───────────────┬───────────────────────────────┘
                │ HostMode ∈ {TERMUX_BIONIC, PROOT_GLIBC}
        ┌───────┴────────┐
        ▼                ▼
┌───────────────┐  ┌──────────────────────────────┐
│ BionicHost    │  │ ProotGlbcHost                │
│ (现状，保留)   │  │  · files/ubuntu/  (rootfs)   │
│               │  │  · files/bin/proot           │
│ Termux $PREFIX│  │  · jniLibs 版 proot（可执行）│
│ LD_PRELOAD 3件│  │  · LD_PRELOAD=/usr/local/lib │
└───────────────┘  └──────────────────────────────┘
        │                │
        └──────┬─────────┘
               ▼
        $DSH_HOME（两侧路径**逐字相同**）
        + workspace + tmp 绑定
```

### 2.1 抽象接口（Kotlin）

```kotlin
interface EngineHost {
    val id: HostId                        // BIONIC / PROOT_GLIBC
    suspend fun ensureReady(): ReadyInfo   // 解包/校验 rootfs 或 bootstrap
    suspend fun launch(profile: String, extraArgs: List<String>): Process
    fun envFor(child: Profile): Map<String, String>
    fun healthProbe(): HealthProbe         // 端口 connect + HTTP 401 判据
    fun onDestroy()
}
```

`EngineManager` 现有 10 299 行里的启动段收敛为：`host.ensureReady()` → `host.launch()` → `host.healthProbe()`；`HostMode` 由 `files/home/.dsh/host-mode`（单行文本）+ 设置页开关共同决定，切换需满足**切换纪律**（见 §6.3）。

### 2.2 为什么不是「全量切换」

| 指标 | bionic | proot |
|---|---|---|
| 冷启引擎段 | 基准 | +80%（同机 1.07 s → 1.93 s） |
| 存储 | +300 MB | +750 MB～1 GB |
| 生态 | 需自编/降级 | 官方 linux-arm64 直用 |
| 包名 | 必须 15 字符 | 任意 |

结论：**默认 bionic，proot 作为「重生态模式」按需开启**（用户装 glibc 原生插件、或未来放开包名/上架时整体切换）。

---

## 三、从 dsh-Go 借鉴的六项（映射到里程碑）

| # | 借鉴项 | dsh-Go 现成资产 | 本计划落点 |
|---|---|---|---|
| 1 | **构建期 diff + 双哈希 pin** | `runtime/patches/*.diff`（121 个）+ `pins.json`（before/after SHA-256） | M1：把 10 个运行期文本补丁迁到构建期，CI 硬失败 |
| 2 | **UI 契约解耦** | 纯协议层（HTTP/SSE/mux），不碰 DOM | M2：class map 抽取 + `data-*` 契约层，砍掉哈希类名依赖 |
| 3 | **远程协议矩阵** | `packages/dsh_remote`：SSH / mDNS / WebRTC / TURN / E2E | M4：`remote.mux` 客户端 + 配对 UI |
| 4 | **CI 测试网** | 936 Dart 测试 + 227 Node 测试 + PR/主干分流 | M3：把离线判据全部搬进 Actions |
| 5 | **增量更新 + 资产分离** | `docs/design/delta-update.md`：差分补丁 + SHA-256 + 原子回滚 | M5：`engine.bin` 与 APK 解耦，热修通道 |
| 6 | **i18n + 系统联动** | 120 ARB 分片、Widgets/Shortcuts/Tile | M6：`values-en` + 快捷方式 + 磁贴 |

---

## 四、里程碑与验收门禁

### M0 · 准备（0.5 周）

- [ ] 冻结回归基线：r29 产物 sha256、`verify` 的 9/0/1、冷启时间、APK 体积写入 `docs/baseline/r29.md`
- [ ] 建 `docs/plan/` 与 `tools/runtime/` 目录骨架
- [ ] `HostMode` 枚举 + `EngineHost` 接口落地（**只重构不换实现**，等价重构）
- **门禁 G0**：重构后 r29 行为不变（`verify` 9/0/1，冷启 ±1 s）

### M1 · 补丁工程化（构建期 diff + pin 门禁）（2 周）

**目标**：补丁不再在手机上做字符串替换，改在 CI 打，且上游一漂移就构建失败。

- [ ] 把 `EngineManager.kt` 里 10 个补丁抽成 `runtime/patches/*.diff`（每补丁一个文件，含中文注释头）
- [ ] `runtime/pins.json`：每个补丁登记 `file`、`before_sha256`、`after_sha256`、`anchor`
- [ ] `tools/runtime/apply-patches.py`：三态（apply / already-applied / mismatch-fail），`--check` 只校验
- [ ] `apk.yml` 在打包 `engine.bin` 前插入该步骤；`mismatch` 直接 `exit 1`
- [ ] 保留运行期兜底：`pins.json` 未覆盖的补丁（如 `patchImageMediaType`）继续走 Kotlin，但**GUARD miss 由 warn 升级为 `State.Failed` + 救援横幅**
- **门禁 G1**：①故意改坏一个 anchor → CI 红；②r30 装机后 `check-engine-patch-marks.mjs` 5/5、`verify` 9/0/1；③冷启不回退

### M2 · UI 契约层（2 周）

**目标**：87 个哈希类名依赖降到 0，前端重编译不再打断壳工程。

- [ ] `tools/ui-contract/extract.mjs`：从官方前端 dist 抽取 `hash → 语义名` 映射，产出 `runtime/ui-contract.json`（随包分发）
- [ ] `mobile-ui-plugin` 与 `webview-polyfill.js` 全部改为「语义选择器」：优先 `data-*`（官方已有 `data-conversation-header-*`、`data-sidebar-*`、`data-mobile`），其次 ARIA role，最后用 contract 映射兜底
- [ ] 新增 `unstable-selector` 审计脚本：CI 中 `grep` 出任何 `\.[A-Za-z0-9]{6,8}_[A-Za-z0-9]{2,5}` 选择器即失败
- [ ] 回归：抽屉/按钮/面板页/多模态四条 UI 缺陷按 r25/r28 的判据复验
- **门禁 G2**：①审计脚本 0 命中；②前端换一次模拟哈希（本地改 dist 重命名类）后，壳工程 UI 仍正常；③`verify` 9/0/1

### M3 · 宿主并行 + CI 测试网（2.5 周）

**M3a 双宿主（1.5 周）**

- [ ] `files/bin/proot`（静态 aarch64）+ 同时提供 `jniLibs/arm64-v8a/libproot.so`（`nativeLibraryDir` 可执行，绕 targetSdk 28 私有目录 exec）
- [ ] `build-runtime.sh` 等价物：拉 Ubuntu base 24.04 + node glibc 24.x + `npm i -g @deepseek-ai/dsh@<pin>` → `rootfs.tar.xz`（带 sha256 清单）
- [ ] `ProotGlbcHost`：按 C 方案原文的 argv 拉起（见附录 B），绑定 `/dev /proc /sys /system` + `$DSH_HOME` + workspace + tmp
- [ ] **路径逐字一致**：`/data/user/0/<pkg>/files/home/.dsh` 两侧拼写必须相同，否则历史会话 `cwd` 全失效
- [ ] glibc 重编 `boo-sandbox-run` / `libboosandbox.so` / `liblinkcompat.so`（`tools/apply-glibc-patches.py` 已就绪）
- [ ] `android-glibc.patch.yml` overlay 三行（`sandbox.runnerCommand` + `runnerFailureSignatures`、`session-query-sqlite.openAt: first-search`、`plugin-manager.registry/fallbackRegistries`）
- [ ] 设置页入口：「重生态模式（proot/glibc）」，切换前展示体积/耗时提示
- **门禁 G3a**：`tools/verify-c.sh` 四组判据全绿（平台翻面 / 官方预编译 / 沙箱边界含 `mkdirat` 逃逸 / 端到端）

**M3b CI 测试网（1 周）**

- [ ] `ci.yml` 增加 jobs：`anchors`（5/5、13/13）、`frontend-syntax`、`ui-contract`、`pins`、`proot-rootfs-check`
- [ ] PR 增量 / 主干全量分流（对齐 dsh-Go 的 ci.yml）
- [ ] 冒烟：x86_64 runner 上跑 `proot --version` + rootfs 起 `node -e`（不等同真机，但能挡低级错）
- **门禁 G3b**：任一 job 红则禁止出包；绿灯需 ≤ 12 分钟

### M4 · 远程协议矩阵（2 周）

- [ ] `remote/` 模块：`/api/remote.mux` 客户端（握手 → 多路复用 → 断线重连 → 心跳）
- [ ] 传输层：LAN mDNS 自动发现 → WebRTC DataChannel（P2P）→ TURN/relay 兜底
- [ ] 端到端加密：配对码派生密钥（X25519 + AES-GCM），附件分块校验
- [ ] 手机端「远程主机」列表 UI + 一键切换（本地引擎 ↔ 远程主机，会话不重建）
- **门禁 G4**：①同局域网 3 秒内发现；②外网经 TURN 连上；③断网 30 秒重连恢复；④远程模式下 `verify --tools` 走远端仍 9/0/1

### M5 · 增量更新与资产分离（1.5 周）

- [ ] `engine.bin` 从 APK 拆出为可选资产（`assets/engine.bin` → 首次下载/本地导入）
- [ ] 差分包格式：`base_sha256` + `target_sha256` + `bsdiff` 补丁 + 清单签名
- [ ] 设备侧原子替换：临时目录 → 校验 → `rename`（复用 r24 的 `engine.staging-<stamp>-<pid>` 机制）
- [ ] 失败回滚：保留 `engine.old-<ts>`，启动失败自动回退并上报
- **门禁 G5**：①`0.2.2-rc.1 → 假想 rc.2` 差分包 ≤ 15 MB；②装机后 `.stamp` 正确；③断点续传 + 校验失败拒绝启用

### M6 · i18n 与系统联动（1 周）

- [ ] `values-en/strings.xml` 全量翻译（当前 UI 仅中文）
- [ ] 桌面快捷方式：长按 → 「新建会话」「继续上次会话」「运行任务」
- [ ] 快速设置磁贴：启停引擎（复用 `EngineService`）
- [ ] App Shortcuts 与通知渠道整理
- **门禁 G6**：①切英文后无硬编码中文漏出（脚本扫描 `values/strings.xml` 引用）；②磁贴启停后 `http=401` 正常；③快捷方式冷启 ≤ 现有冷启 + 0.5 s

---

## 五、关键设计细节

### 5.1 C 方案目录布局（设备侧）

```
files/
├─ bin/proot                      静态 aarch64（jniLibs 副本兜底）
├─ ubuntu/                        Ubuntu base 24.04 (glibc)
│  ├─ usr/bin/node                glibc 版（24.x）
│  ├─ usr/lib/node_modules/@deepseek-ai/dsh/
│  └─ usr/local/{bin,lib}         boo-sandbox-run / libboosandbox.so / liblinkcompat.so
├─ home/.dsh/                     $DSH_HOME（两宿主共用，可迁移）
└─ tmp/                           TMPDIR
```

### 5.2 启动 argv（见附录 B）

### 5.3 引擎补丁三态协议

```text
apply-patches.py 对每个 patch：
  1. 读 pins.json[补丁] = {file, before_sha256, after_sha256}
  2. 现文件 sha256 == after  → already-applied（幂等，跳过）
  3. 现文件 sha256 == before → 打 diff，校验产物 == after → 写入
  4. 其它                    → mismatch：打印 git diff 片段 + exit 1
```

**为什么必须硬失败**：dsh-Go 的 121 个补丁全部登记双哈希，未登记版本构建期就炸；我们现在是「运行时字符串替换 + warn 静默跳过」，r23/r28 两轮都是靠事后审计才发现的。

### 5.4 UI 契约层三级选择器

```text
① 稳定 data-*      data-conversation-header-leading / data-sidebar-collapsed / data-mobile
② ARIA / role      role=dialog, aria-modal, aria-label
③ contract 映射    runtime/ui-contract.json：{ "O_Ebla_root": "settings.root", ... }
```

三级全部失败时**降级为不注入**（而不是猜），并把 miss 写进 `web.log`，由 `ui-contract` 审计在 CI 里提示更新映射。

### 5.5 远程协议分层

```
应用层   /api/remote.mux（会话多路复用、附件分块、心跳）
加密层   X25519 配对 → HKDF → AES-GCM（每帧 nonce）
传输层   mDNS(LAN) → WebRTC DataChannel(P2P) → TURN(兜底) → SSH(开发者)
```

### 5.6 增量更新校验链

```text
下载 → sha256(补丁包) == manifest
     → bsdiff 合成 → sha256(产物) == manifest.target
     → 解压到 engine.staging-<stamp>-<pid> → 校验文件数/大小 → rename(engine)
     → 失败则保留 engine.old-<ts> 并回退
```

---

## 六、兼容与迁移纪律

### 6.1 `$DSH_HOME` 逐字一致

引擎把绝对路径写进会话与工作区。`/data/user/0/<pkg>/files/home/.dsh` 与 `/data/data/<pkg>/...` 是同一目录的两种拼写——**切换宿主时路径字符串必须完全相同**，否则历史会话 `cwd` 全部失效（`boosandbox.c` 里的 `g_allow_real` 就是为此存在的）。

### 6.2 数据迁移方向

`bionic → proot`：`$DSH_HOME` 直接复用（不改路径）；`node_modules` 需在 rootfs 内重新安装（glibc 版），旧 bionic 版保留为 `node_modules.bionic.bak` 以便回退。

`proot → bionic`：反向同理，`$DSH_HOME` 不动。

### 6.3 切换纪律（借 Operit2 的 Binding 设计）

只在「**上一轮工具结果已持久化、下一轮模型请求尚未开始**」的边界上迁移；不搬迁运行中的请求 / 终端进程 / 浏览器会话。UI 上给一个「引擎空闲时才可切换」的置灰判据。

---

## 七、验收矩阵（总表）

| 里程碑 | 判据 | 命令/位置 |
|---|---|---|
| G0 | 等价重构无行为变化 | `verify-engine-upgrade.sh --tools` = 9/0/1 |
| G1 | 补丁 pin 门禁 | 改坏 anchor → CI 红；正常 → 绿 + `check-engine-patch-marks` 5/5 |
| G2 | 0 个哈希类选择器 | `tools/ui-contract/audit.mjs` 命中 0 |
| G3a | C 方案四组判据 | `tools/verify-c.sh`（平台翻面/官方预编译/沙箱边界/端到端） |
| G3b | CI ≤ 12 min 全绿 | Actions 运行时长 |
| G4 | 远程三链路 | mDNS 3 s / TURN 连通 / 30 s 重连 |
| G5 | 差分包 | ≤ 15 MB，校验失败拒绝启用 |
| G6 | 英文无漏出 | 脚本扫描 + 人工抽检 |

**每轮都要复跑**：`verify --tools`、冷启计时、APK 体积、`dumpsys package` 的 `firstInstallTime` 不变（覆盖安装）。

---

## 八、风险与回退

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| proot 在 Android 16+ 被 seccomp 拦截（dsh-Go 文档实证：直跑会杀 glibc loader） | 中 | C 宿主起不来 | 保留 bionic 默认；proot 启动失败自动回落并提示 |
| ptrace 开销拖慢工具链（大仓库 grep 慢 10–30%） | 高 | 体验 | 默认不开；对大仓库给出「切回 bionic」引导 |
| rootfs 体积 750 MB～1 GB | 高 | 存储 | 只在用户选择「重生态模式」时下载；提供一键清理 |
| 补丁 pin 迁移漏项 | 中 | 引擎异常 | 三态协议 + 迁移期双向校验（新旧两套同时跑一版） |
| UI 契约抽取遗漏 | 中 | 局部样式失效 | 三级选择器 + 不注入降级 + CI 审计 |
| 远程 E2E 实现缺陷 | 中 | 数据泄露 | 复用成熟密码学原语（X25519/AES-GCM），配对码短时效 |

**全局回退开关**：`files/home/.dsh/host-mode` 写 `bionic` + 设置页「恢复默认宿主」，一次性回退；`engine.old-<ts>` 保留一代。

---

## 九、工期与资源

| 里程碑 | 内容 | 人日 |
|---|---|---|
| M0 | 基线冻结 + 接口等价重构 | 3 |
| M1 | 构建期补丁 + pin 门禁 | 10 |
| M2 | UI 契约层 | 10 |
| M3a | 双宿主（proot） | 8 |
| M3b | CI 测试网 | 5 |
| M4 | 远程协议矩阵 | 10 |
| M5 | 增量更新 | 8 |
| M6 | i18n + 系统联动 | 5 |
| 合计 | | **59 人日**（≈12 周单人，可并行压缩到 7 周双人） |

**建议顺序**：M1 → M3b → M2 → M3a → M5 → M4 → M6。
（先把「防回归」和「构建门禁」立起来，再动架构；远程与 i18n 属于产品化增益，放后面。）

---

## 附录 A：现状统计命令

```bash
cd '/storage/emulated/0/MT2/apks/deepseek harness'

# 哈希类名数量（现状 87）
grep -rhoE '\.[A-Za-z0-9_]{5,8}_[A-Za-z0-9]{2,5}\b' \
  deepseek-harness-0.4.2/mobile-ui-plugin \
  deepseek-harness-0.4.2/app/src/main | sort -u | wc -l

# 补丁锚点数量
grep -c 'GUARD' deepseek-harness-0.4.2/app/src/main/java/com/dsh/android/EngineManager.kt

# 引擎版本与戳
cat deepseek-harness-0.4.2/tools/engine-version.txt
run-as com.dsh.android cat files/engine/.stamp
```

## 附录 B：proot 启动 argv（照抄 C 方案原文）

```bash
exec "$FILES/bin/proot" --kill-on-exit -r "$ROOT" \
  -b /dev -b /proc -b /sys -b /system \
  -b "$DSH_HOME:$DSH_HOME" -b "$WORKSPACE:$WORKSPACE" -b "$TMPDIR:$TMPDIR" \
  -w "$WORKSPACE" \
  /usr/bin/env -i HOME=/root PATH=/usr/local/bin:/usr/bin:/bin \
    TERM=xterm-256color TMPDIR="$TMPDIR" DSH_HOME="$DSH_HOME" \
    LD_PRELOAD=/usr/local/lib/liblinkcompat.so \
  /usr/bin/node /usr/lib/node_modules/@deepseek-ai/dsh/bin/dsh.js \
    --profile web --host 127.0.0.1 --port 3080 --no-open \
    --patch "$DSH_HOME/android-glibc.patch.yml"
```

## 附录 C：overlay 三行（缺一即坏）

```yaml
sandbox.runnerCommand: /usr/local/bin/boo-sandbox-run
sandbox.runnerFailureSignatures: [ ... ]      # 与上一行必须同时非空，否则 sandbox 服务不注册
session-query-sqlite.openAt: first-search      # 上游默认 never → session_search 直接 DISABLED
plugin-manager.registry: [...]                 # name 必须与 base 层一致，否则整条静默跳过
plugin-manager.fallbackRegistries: [...]
```

## 附录 D：切换到 C 宿主的操作清单

1. 设置页 → 「重生态模式」→ 确认体积/耗时提示
2. 下载 rootfs 资产（或侧载 `rootfs-arm64.tar.xz`）
3. 等解包完成（`.rootfs.stamp` 落盘）
4. 引擎空闲时切 `host-mode=proot_glibc`，重启 App
5. 验证：`http=401`、`files/engine/.stamp` 正确、`verify --tools` 9/0/1
6. 回退：`host-mode=bionic` + 重启；`node_modules.bionic.bak` 自动复位