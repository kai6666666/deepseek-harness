# 重构计划：单宿主 + 去 Termux + 解除包名/targetSdk 限制

> 状态：**执行中** — P0 ✅ / P1 ✅ / P2 ✅ / P3 ✅ / **P5 29 ✅ / 30 ✅**（`refactor.5` / `refactor.8`）；下一档 34，之后 P4 包名、P6 收尾
> 基线：`main` @ `ff20f6024f`（引擎 `@deepseek-ai/dsh@0.2.2-rc.3`，App `0.2.2-rc.3` / vc54，mobile-ui `1.1.0-194`）
> 目标版本：`0.3.0-refactor.N`（versionCode 从 55 起递增），发布到 prerelease `v0.3.0-refactor.N`
> 最后更新：2026-11-20
> 决策：D1–D6 已定（见 §3），全部按建议执行

---

## 0. 一页结论

| 问题 | 结论 |
|---|---|
| 包名 15 字符还成立吗 | **不成立**。`TermuxBootstrap` / `patchElfInPlace` 已从源码树删除；`libproot.so` 里 5 处 `com.termux` 只是默认值，被 `PROOT_LOADER`/`PROOT_TMP_DIR`/`LD_LIBRARY_PATH` 全覆盖 |
| targetSdk 28 还必要吗 | **不必要**。内核 exec 面只剩 jniLibs 两个 `.so`（`nativeLibraryDir` 是 API 29 `execute_no_trans` 的官方例外）。真正的成本在**存储模型**与 **API 35 edge-to-edge** |
| 现成的正确做法 | **Operit**：targetSdk 34 + 29 字符包名 + 全部可执行体改名 `lib*.so` 进 jniLibs，`filesDir/usr/bin/*` 只放**指向 nativeLibraryDir 的符号链接** |
| 本仓库当前宿主形态 | 名义 3 枚举 / 实际 1 活 2 死：`ProotHost` 活，`ProotGlbcHost`（`filesDir/bin/proot`+`filesDir/ubuntu`）与 `TermuxBionicHost` 永不成立 |
| 最危险的历史残留 | `EngineBootGate.kt:81` 的「回落 bionic」必失败，且**吞掉第一条真实错误** |
| 本计划产出 | 7 个阶段（P0–P6）、每阶段带判据与回滚；最终形态 = 任意包名 + targetSdk 34 + 单宿主 + 运行时零 Termux |

---

## 1. 目标与非目标

### 1.1 目标

1. **去 Termux（运行时）**：路径、环境变量、脚本里不再出现 `termux` / `com.termux` / `$PREFIX`；不依赖 `files/usr`、`files/termux`。
2. **单宿主**：只保留 `ProotHost`（`manifest.json` 的 `launch.argv` 为唯一启动契约），无宿主枚举、无回落。
3. **解除包名限制**：`applicationId` 可任意取值（不再受 15 字符约束）。
4. **解除 targetSdk 限制**：抬到 34，与 Operit 对齐。
5. **重构彻底**：删死代码、删过期注释、删真机垃圾，文档与代码一致。

### 1.2 非目标（本轮明确不做）

| 项 | 原因 |
|---|---|
| 构建期不再拉 Termux deb（自编 proot/talloc/shmem） | 工作量以周计；本轮只要求**运行时**零 Termux。见 D3 |
| dsh-Go 的 `runtime/direct`（无 proot 直跑 node） | 依赖**宿主侧** exec `rootfs/usr/bin/node`，与目标④冲突，会永久钉死 targetSdk ≤ 28 |
| 换 WebView 内核 / 改前端 | 与本计划正交 |
| 上架 Google Play | 需要 `MANAGE_EXTERNAL_STORAGE` 申诉，另立项 |
| 16 KB page size 兼容（重编 proot） | 独立排期；风险高于本计划，见 §7 |

---

## 2. 现状取证（2026-11-20 实测）

### 2.1 三份工程对照

| 维度 | DSH（本仓库） | dsh-Go | Operit |
|---|---|---|---|
| applicationId | `com.dsh.android`（15） | `io.github.ccch1mneyyy.dsh_app`（30） | `com.ai.assistance.operit`（29） |
| targetSdk | **28** | **28** | **34** |
| jniLibs | `libproot.so`、`libproot-loader.so` | +`libtalloc.so`、`libandroid-shmem.so`（`patch-dynstr` 改 SONAME） | `liboperit_proot.so`、`liboperit_loader.so`、`libbash.so`…（整套 userspace） |
| talloc/shmem | `assets/runtime/proot-libs/` + `LD_LIBRARY_PATH` | jniLibs | jniLibs |
| prefix | 无 | 无 | 自建 `files/usr/bin`（38 个命令，busybox 系） |
| rootfs | `files/runtime/rootfs`（1.3 GB） | `assets/runtime/rootfs-<abi>.tar.xz` | `files/usr/var/lib/proot-distro/installed-rootfs/ubuntu`（64 MB tar.xz） |
| 存储 | READ/WRITE_EXTERNAL | +MANAGE +requestLegacy | +MANAGE +requestLegacy +READ_MEDIA_AUDIO |
| 启动模式 | 3 枚举 / 1 活 2 死 | PRoot + Direct | 1 |

### 2.2 Operit 的关键做法（本次照抄的那一手）

```text
files/usr/bin/proot   -> /data/app/~~…/lib/arm64/liboperit_proot.so
files/usr/bin/loader  -> /data/app/~~…/lib/arm64/liboperit_loader.so
files/usr/bin/bash    -> /data/app/~~…/lib/arm64/libbash.so
```

`execve()` 的目标 inode 落在 `nativeLibraryDir`（`apk_data_file`，允许 exec），符号链接只是入口 ⇒ **API 29 的 `execute_no_trans` 完全失效**。这是 targetSdk 34 能成立的唯一原因。

### 2.3 DSH 侧残留清单（带位置）

| 类别 | 残留 | 位置 |
|---|---|---|
| 死宿主 | `ProotGlbcHost`（`filesDir/bin/proot` + `filesDir/ubuntu`） | `engine/ProotGlbcHost.kt:35-37, 100-108` |
| 死宿主 | `TermuxBionicHost` / `HostMode.TERMUX_BIONIC` | `engine/EngineHosts.kt:20, 33, 47-76` |
| 死回退 | 启动失败回落 bionic（必失败，吞错误） | `engine/EngineBootGate.kt:78-88` |
| 死 UI | 设置页三个宿主模式可选 | `ui/settings/HostSettingsSection.kt:62-64, 101-106` |
| 宿主侧 exec | `filesDir/usr/bin/node`（bionic 遗留） | `engine/PrivilegedRunner.kt:27`、`WirelessDebugging.kt:129-137`、`EngineManager.kt:6894, 7046, 7075, 7114` |
| 资产双分支 | `IS_PROOT` 三元组 + `termux/usr` 兜底 + `com.termux` 脚本重写 | `assets/dsh-env.mjs:11-16, 303-441` |
| 资产 | `$PREFIX/bin/bash` 候选 | `assets/dsh-android-shell.mjs:1617-1643` |
| 资产硬编码包名 | `DSH_FILES` 兜底写死 `com.dsh.android` | `assets/dsh-env.mjs:11`、`assets/check-devenv.mjs:21` |
| 工具脚本 | shebang 指向 `files/termux/usr/bin/bash` | `tools/dsh-env.sh:1`、`tools/env-smoke.sh:2` |
| Termux 二进制 | `adbwire/bin/adb`（3.5 MB，4 处 `com.termux` RUNPATH） | `EngineManager.kt:4441` 段 |
| 归档而非删除 | `retireLegacy` 把 `engine`/`usr`/`termux/usr` 搬进 `runtime/legacy-bionic` | `runtime/RuntimeFiles.kt:90-107` |
| 过期注释 | 「必须 15 字符」「targetSdk 必须 28」 | `app/build.gradle.kts:17-19, 35, 298-302`、`AGENTS.md` 规矩 3 |
| 真机垃圾 | `rootfs.staging-*` 102 MB、`rootfs.old-*` 32 KB 永久残留 | `RootfsInstaller.kt:110-115`（只删 `old`，无 staging 清扫） |

---

## 3. 决策记录（已定）

| # | 决策 | 取值 | 理由 |
|---|---|---|---|
| D1 | 新包名 | `io.github.ccch1mneyyy.dsh` | 与 dsh-Go 同族、无 15 字符约束、语义清晰 |
| D2 | targetSdk 目标 | **34**（中间档 29 / 30 逐档验） | 与 Operit 对齐；不追 35，避开 edge-to-edge 强制首年回归 |
| D3 | 构建期 Termux 来源 | **保留 deb 拉取** | Termux 仅作为 proot/talloc/shmem 的上游二进制来源；运行时零依赖。自编 proot 另立项 |
| D4 | REMOTE 宿主 | **保留** | 它是连接方式不是宿主，与「单宿主」不冲突 |
| D5 | 老装机 `files/usr` | **删除**（不归档） | 归档会永久占存储；升级日志与首启提示明示 |
| D6 | 无线调试（Termux adb） | **保留**，改 `libadb.so` + 符号链接 | 与其余可执行体同一套机制，不砍功能 |

---

## 4. 阶段计划

> 执行顺序：**P0 → P1 → P2 → P3 → P5 → P4 → P6**。
> 改包名（P4）放最后，因为它会让现设备数据不继承；放在 targetSdk 验证通过之后，保证每一步都能覆盖安装、都能回滚。

### P0 基线快照（可回滚点）— ✅ 已完成（`.backup/refactor-20261120/`，111 文件）

**动作**
- 全量快照到 `.backup/refactor-20261120/`：`app/src/main/java/com/dsh/android`、`app/src/main/assets`、`tools/runtime`、`app/build.gradle.kts`、`app/src/main/AndroidManifest.xml`、`AGENTS.md`
- 生成 `SHA256SUMS` 清单
- 记录 `main` HEAD 与当前 Release 资产 sha256

**判据**：`sha256sum -c` 全绿；快照文件数与原树一致。
**回滚**：`rsync -a --delete` 回灌。

---

### P1 jniLibs 全面化（风险最低、收益最大）— ✅ 已完成（v0.3.0-refactor.1）

**动作（文件级）**

| 文件 | 改动 |
|---|---|
| `tools/runtime/build-runtime.sh:131-137` | talloc / shmem 从 deb 抽到 `$JNI/libtalloc.so`、`$JNI/libandroid-shmem.so` |
| 同上 | 新增 `patch-dynstr`（`libtalloc.so.2` → `libtalloc.so`），实现照抄 dsh-Go `runtime/build-runtime.sh:345` |
| 同上 `:397-424` | `manifest.json` 的 `jniLibs` 增两项；`launch.env` 去掉 proot-libs 目录，只留 `{NATIVE_LIB_DIR}` |
| `runtime/ProotHost.kt` | 删 `ensureProotLibs()` 与 `files/proot-libs` 相关逻辑 |
| `EngineManager.kt` | 删 `proot-libs` 解包分支 |

**判据**
- APK 内 `lib/arm64-v8a/` 有 4 个 `.so`，`unzip -l` 可见
- 设备 `files/runtime/manifest.json` 的 `jniLibs` 为 4 项
- 引擎正常起（token 行可解析）、`dsh web` 可访问

**回滚**：只回滚 `build-runtime.sh` + `ProotHost.kt`，重出包即恢复。

---

### P2 单宿主化（删死代码）— ✅ 已完成（v0.3.0-refactor.2）

**动作**

| 文件 | 改动 |
|---|---|
| `engine/ProotGlbcHost.kt` | 整文件删除 |
| `engine/EngineHosts.kt` | 删除 `HostMode`、`EngineHosts`、`TermuxBionicHost` |
| `engine/EngineBootGate.kt:52-88` | 删 mode 解析与 bionic 回落；异常直接抛出，保留第一条真实原因 |
| `ui/settings/HostSettingsSection.kt:62-64, 101-106` | 删模式选择器；远程 URL 输入保留（D4） |
| `EngineManager.kt:5506, 6445, 7169` | 删 `legacyLauncher` 注入与 `hostCapabilities(mode)` |

**判据**
- `grep -rn "HostMode\|TermuxBionicHost\|ProotGlbcHost\|legacyLauncher" app/src` = 0 行
- 启动日志 `hostId=proot`
- 故意破坏 `rootfs` 后启动：**第一条**错误是 rootfs 缺失，而不是「回落 bionic 也失败」

**回滚**：`git revert` 单提交；本阶段无数据面变化。

**实测（2026-11-20，vc57）**
- `grep -rn "HostMode|TermuxBionicHost|ProotGlbcHost|EngineHosts|EngineBootGate|HostSettingsSection" app/src` = 0
- 启动：`engine.start.proot runtime=…-1f2f5ca4c472` → `dsh web http://127.0.0.1:43599` → `Web 内核已提交首帧`
- `grep -c "回落 bionic" app.log` = **0**
- 连带删除：`RootfsProvisioner.kt`、`VerifyC.kt`（C 方案装配/验收工具，零调用方，且 `RootfsProvisioner` 是唯一引用 `ProotManifest` 的地方）
- 守卫改造：`tools/verify-engine.sh` 由「engine 包 >60 class」改为「关键类存在 + ≥20」
  —— 删代码不再撞假报警，空产物仍会拦

**P2 期间发现（转 P3 处理）**
1. **失败注入手段要改**：移走整个 `runtime/rootfs` 时，`RootfsInstaller.isInstalled()` 判定未安装 → 直接走自愈重装（`runtime copy` 1.3 GB），
   所以「首条错误即真因」不能这样验。P3 验收改用**破坏 rootfs 内关键文件**（删 `usr/bin/node`）来触发 `ProotHost.requireReady` 失败。
2. **残留垃圾实测 797 MB**：`rootfs.staging-*`（102 MB + 695 MB 各一份）、`rootfs.old-*`（2×32 KB）。
   P3 的启动清扫必须覆盖 staging，否则每次中断的安装都留一份接近满额的半成品。

---

### P3 运行时去 Termux — ✅ 已完成（v0.3.0-refactor.3 + .4 修订）

**动作**

| 文件 | 改动 |
|---|---|
| `assets/dsh-env.mjs:11-16` | 删 `IS_PROOT` 三元组；`PREFIX=/usr`、`HOME=/root` 常量 |
| `assets/dsh-env.mjs:303-441` | 删 `rewriteTermuxPaths`、gradle wrapper/opt-gradle 的 Termux 修补 |
| `assets/dsh-env.mjs:11`、`check-devenv.mjs:21` | `FILES` 改为必须 `DSH_FILES`，缺失即报错（不再写死包名兜底） |
| `assets/dsh-android-shell.mjs:1617-1643` | bash 候选改 `/bin/bash` → `/usr/bin/bash` → `/system/bin/sh` |
| `runtime/RuntimeFiles.kt:90-107` | `retireLegacy` → `purgeLegacy`：**删除** `engine`/`usr`/`termux/usr`（D5） |
| `RootfsInstaller.kt:110-115` | `swapIn` 增加启动清扫：删所有 `rootfs.staging-*` 与遗留 `rootfs.old-*` |
| `tools/dsh-env.sh`、`tools/env-smoke.sh` | 删除 |
| `files/proot-libs`（升级安装遗留） | P1 已无生产者，但升级装机上目录仍在 ⇒ `purgeLegacy` 一并删除 |
| `EngineManager.kt:4441` 段 | `adbwire/bin/adb` → jniLibs `libadb.so` + `files/adbwire/bin/adb` 符号链接（D6） |

**判据**
- `grep -rn "termux\|com\.termux" app/src tools/runtime` 只剩 `build-runtime.sh` 的 deb URL
- 设备 `files/` 下无 `usr`、`termux`、`legacy-bionic`
- `dsh-env.mjs` 在 guest 内体检通过（分组项可列、可安装）
- 无线调试配对仍可用（若保留功能）

**回滚**：资产类改动按 zip 级回滚；`purgeLegacy` 属破坏性动作，**必须**在 P0 快照 + 用户数据导出之后执行。

**实测（2026-11-21，vc58→vc59）**
- `grep -rn "termux|Termux|IS_PROOT" app/src/main/assets tools/*.mjs tools/*.sh` = 0（只剩 `tools/build-*.sh` 里的**构建期上游 URL**，见 D3）
- 设备 `files/` 下无 `usr` / `termux` / `proot-libs` / `runtime/legacy-bionic`
- 清扫实测：造 `files/runtime/rootfs.staging-probe/` → 重启 → 目录消失，日志 `启动清扫残留：rootfs.staging-probe`
- 引擎：`dsh web http://127.0.0.1:41923` → `Web 内核已提交首帧`

**P3 期间两条判断（都写进了代码注释）**
1. **清扫必须挂在启动路径**，不能只挂在安装路径。`.rootfs.stamp` 命中时 `RootfsInstaller` 直接返回，
   「装到一半被杀」的 `rootfs.staging-*` 永远不会被清 —— 所以 `EngineManager` 在构造 `ProotHost` 前先 `sweepStale()`（`.4` 修订）。
2. **无限调试 adb 不动**。`files/adbwire/bin/adb` 是 bionic ELF，但它由 **guest 内**的 runner `spawn`，
   走 proot loader（mmap），不经过内核 `execve` ⇒ 不占 API 29 的 `execute_no_trans` 面。P5 不因它受阻；
   若将来要把它做成"纯 jniLibs"，属于可选清理，不是阻塞项。

---

### P4 包名解除

> 放在 P5 之后执行（覆盖安装连续性）。

**动作**
- `app/build.gradle.kts`：`namespace`、`debug.applicationId`（`system`/`gecko` 两个 flavor）→ `io.github.ccch1mneyyy.dsh`
- 资产硬编码：`dsh-env.mjs`、`check-devenv.mjs`、`tools/dsh-env.sh`（已删则跳过）
- 工具脚本：`tools/apply-clickfix.sh:14`、`tools/mcp-android-ui.mjs:48`、`tools/env-smoke.sh`（已删）
- `AGENTS.md`、`docs/agents/*` 里的 `com.dsh.android` 说明同步

**判据**
- `aapt dump badging` 的 `package:` 为新名
- 首启解包 ≤ 130 s，`files/runtime/*` 内容与旧版一致
- 引擎起、WebView 正常、工作区可选

**回滚**：改回包名即可（旧包仍留在设备上）。
**数据**：改包名 = 新安装，**不继承**。执行前必须 `UserDataExporter` 导出 → 新包导入，并核对会话条数。

---

### P5 targetSdk 提升（29 → 30 → 34，一档一验）— 29 ✅（refactor.5）· 30 ✅（refactor.8）

**动作**

| 档 | 必需改动 |
|---|---|
| 29 | `requestLegacyExternalStorage="true"`；`usesCleartextTraffic` 保持显式 `true` |
| 30 | `MANAGE_EXTERNAL_STORAGE` 声明 + 申请流程（`ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION`）；分区存储下 `/sdcard` 绑定改走全盘访问 |
| 31 | `PendingIntent` 显式 `FLAG_IMMUTABLE`/`FLAG_MUTABLE`；`<queries>` 补包可见性 |
| 33 | `POST_NOTIFICATIONS` 运行时申请 |
| 34 | `startForeground(id, notif, type)` 显式类型；FGS 启动限制 |

**重点回归**（历史缺陷区）
- `SystemBarAppearance` / `KeyboardAvoid`：vc19「开全面屏后顶栏整行下移」就是这套逻辑，API 35 edge-to-edge 会重定义它
- `phoneStorage` → guest `/sdcard` 绑定
- 悬浮球 `SYSTEM_ALERT_WINDOW`、无障碍服务、截图
- 前台服务保活（切后台不断连）

**判据（每档都跑）**：装机 → 首启解包 → 引擎起 → WebView 正常 → 选工作区（`/sdcard` 可写）→ 截图/无障碍/悬浮球 → 切后台 10 min 不断连 → 日志无 `EACCES`/`avc: denied`。

**回滚**：targetSdk 是单行改动，回退到上一档并保留代码分支判据。

**29 档实测（2026-11-21，vc60）**
| 判据 | 实测 |
|---|---|
| 装机 | `versionCode=60 / versionName=0.3.0-refactor.5 / targetSdk=29` |
| legacy 存储模型 | `dumpsys package` 含 `PRIVATE_FLAG_REQUEST_LEGACY_EXTERNAL_STORAGE`；`appops` `LEGACY_STORAGE: allow`、`READ/WRITE_EXTERNAL_STORAGE: allow` |
| 引擎 | 进程 `libproot.so` + `node`；`dsh web http://127.0.0.1:45801` → `Web 内核已提交首帧` |
| 悬浮窗 | `SYSTEM_ALERT_WINDOW: allow` |
| 权限错误 | `grep -c "EACCES|avc: denied" app.log` = 0 |
| CI 契约 | `check-apk-assets.py` 去掉「15 字符 / targetSdk ≤ 28」，改为「≥29 时 jniLibs 四件套齐备、无 proot-libs」 |

**⚠️ 测试方法教训（写下来免得下次再撞）**
- `run-as` 跑在 **`runas_app`** SELinux 域，**天生访问不到 `/sdcard`**（`/sdcard → /storage/self/primary` 也读不了）。
  所以「用 run-as 写 /sdcard 验证存储」是**无效判据**，只能证明 harness 的限制。
- 有效判据是系统状态：`appops get <pkg> | grep LEGACY_STORAGE` + `dumpsys package` 的 `PRIVATE_FLAG_REQUEST_LEGACY_EXTERNAL_STORAGE`。
- `ProotProbeActivity --es run_script` 要求脚本落在**已绑定进 guest 的目录**（`home/.dsh`、`workspace`），
  传 app 私有根路径会 `MODULE_NOT_FOUND`；本次探针仍未拿到 stdout，后续要做「guest 内写 /sdcard」验证时另设通道。

**30 档实测（2026-11-21，vc63 / `v0.3.0-refactor.8`）**
| 项 | 实测 |
|---|---|
| 装机 | `versionCode=63 / targetSdk=30 / versionName=0.3.0-refactor.8` |
| 全盘权限初始态 | `cmd appops get … MANAGE_EXTERNAL_STORAGE` → `Default mode: default` |
| 引导 | `app.log`：`未授予「所有文件访问」，已引导一次（ok=true）` |
| 引擎 | `dsh web http://127.0.0.1:42429` → `Web 内核已提交首帧`；本轮 `failed to import` = 0 |
| 回退 | `defaultPhoneStorage()` 无全盘权限时绑 `Android/data/<包名>/files/sdcard`（`bind /sdcard ->` 有日志） |

**⚠️ 30 档踩到的真 bug（vc61/vc62 连续两版引擎起不来）**
`proot` 的 guest 路径是**字符串匹配**，而 App 里同一个目录有两套写法：

```text
File.absolutePath  = /data/user/0/<pkg>/files/...     ← assets/overlay 内容、EngineManager 大量拼路径
File.canonicalPath = /data/data/<pkg>/files/...       ← ProotHost 原来只绑这一条
```

只要有一处把 `absolutePath` 塞进 guest 可见的东西（`--patch` 参数、overlay 里的插件路径），
guest 里就必然 `ENOENT`；表现还很误导——先是 `failed to read overlay`，修完变成
14 个插件 `ERR_MODULE_NOT_FOUND`。

**结论**：`ProotHost` 现在对 `filesDir` 做**双前缀绑定**
（`-b <canonical>:<canonical>` + `-b <canonical>:<absolute>`），两套写法都成立。
以后新增任何 guest 路径时不需要再判断用哪种前缀。

**30 档要注意**
- API 30 起 `requestLegacyExternalStorage` 被忽略 ⇒ 必须上 `MANAGE_EXTERNAL_STORAGE`（`ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION`），
  否则 `/sdcard` 工作区绑定失效。
- 34 还要处理 FGS 类型与 edge-to-edge（`SystemBarAppearance` 有 vc19 回归史）。

---

### P6 收尾与文档

- `app/build.gradle.kts:17-19, 35, 298-302`：把「必须 15 字符 / 必须 28」改写为**历史成因 + 现状**（`patchElfInPlace` 已删、proot 默认值被 env 覆盖）
- `AGENTS.md` 规矩 3 同步改写
- 新增 `docs/agents/runtime-model.md`：单宿主模型、jniLibs 契约、`manifest.json` 字段、故障判据
- `docs/PLAN.md` 索引更新
- CHANGELOG 记录 `0.3.0-refactor.N`

---

## 5. 验收矩阵（最终形态）

| 项 | 判据 | 采集方式 |
|---|---|---|
| 单宿主 | `hostId=proot`，`HostMode` 零引用 | 日志 + `grep` |
| 运行时零 Termux | 设备 `files/` 无 `usr`/`termux`；`app/src` 无 `termux` 引用 | `run-as` + `grep` |
| 可执行体全在 jniLibs | `unzip -l` 见 4+ 个 `lib*.so`；`files/**/bin/*` 均为符号链接指向 `nativeLibraryDir` | 设备 `ls -l` |
| 包名自由 | `aapt dump badging` = 新名；15 字符断言不存在 | `aapt` + `grep` |
| targetSdk 34 | `aapt dump badging` 的 `targetSdkVersion:'34'` | `aapt` |
| 存储可用 | 工作区选 `/sdcard/...` 可读写；guest 内 `touch` 成功 | 真机 |
| 菜单不回归 | 「对话/轨迹」「刷新」在、开合不闪、首击可开 | 真机（mobile-ui 1.1.0-194 判据） |
| 错误可见 | 破坏 rootfs → 第一条错误即真因 | 真机 |

---

## 6. 风险登记

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | 改包名导致数据不继承 | 高 | P4 放最后；先导出再导入；核对会话条数 |
| R2 | API 35 / 34 的 edge-to-edge 重定义状态栏逻辑 | 中高（有回归史 vc19） | D2 定在 34；逐档验；保留 `SystemBarAppearance` 前后对比截图 |
| R3 | `MANAGE_EXTERNAL_STORAGE` 在部分 ROM 被限制 | 中 | 首启引导 + 失败时退回 app 外部目录 |
| R4 | `purgeLegacy` 删掉老装机的 `usr/`（若有人仍依赖 bionic 路径） | 中 | P0 快照 + 升级日志明示 + `DSH_KEEP_LEGACY=1` 一次性开关（仅在首启读，不进常态分支） |
| R5 | 16 KB page size 机型上 `libproot.so` 加载失败 | 高（独立议题） | 本计划不解决；单独立项重编 proot/talloc |
| R6 | CI 只能在 x86_64 runner 出包，本机无法交叉构建 | 中 | 沿用 `apk.yml` → `sign-upgrade-apk.yml` → `publish-apk.yml` 三段式 |

---

## 7. 版本与发布

- 版本号：`versionName = 0.3.0-refactor.N`，`versionCode` 从 **55** 起递增
- **N=0 = 重构前基线包**（代码与 `0.2.2-rc.3` 功能等价，仅版本号前移），用于 A/B 对照与「重构后是否回归」的判据；真正的重构从 **N=1** 起
- 发布位：**prerelease** `v0.3.0-refactor.N`
- 流程：`apk.yml`（出包）→ `sign-upgrade-apk.yml`（原证书重签）→ `publish-apk.yml`（`prerelease=1`）
- **不得**发布到 `v0.2.2-rc.3`（正式版位，资产已统一为 `79d0dab6…` 证书签名）
- `publish-apk.yml` 的断言是 `tag == v$versionName`（读 `tools/app-version.txt`），改版本必须三处同步：`tools/app-version.txt`、`app/build.gradle.kts`、release tag

---

## 8. 附：本次未纳入

- 自编 proot / talloc / shmem（构建期彻底去 Termux）
- dsh-Go 的 Direct 引擎
- 16 KB page size 兼容
- Play 上架（`MANAGE_EXTERNAL_STORAGE` 申诉）
- `dsh-purge` 插件（红队工具，与本计划无关）
