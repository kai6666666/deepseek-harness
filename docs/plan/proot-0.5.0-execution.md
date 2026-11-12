# 0.5.0 执行计划：单运行时 PRoot / glibc

> 状态：**执行中** · 建立 2026-11-12
> 设计依据：[c-plan-and-dshgo-borrow.md](c-plan-and-dshgo-borrow.md)（P0–P4 已完成）
> 目标版本：**0.5.0**（vc = 51；0.4.4-test = vc50 已弃用）
> 本文只记「谁在什么时候做到哪一步」，设计理由看 c-plan，不重复。

---

## 一、基线

| 项 | 值 |
|---|---|
| 分支 | `main` @ `d5a3d6e` |
| 版本 | `0.4.4-test` / vc=50（已弃用，Release 标 Pre-release） |
| 引擎 | `@deepseek-ai/dsh@0.2.2-rc.1` |
| 运行时 | `tools/runtime/build-runtime.sh` 产出 `rootfs-arm64-v8a.tar.xz`（约 124 MB）、`manifest.json`、jniLibs 四件套 |
| 真机 | Xiaomi 25104RADAC / Android 16 / arm64-v8a |

## 二、现状核对（2026-11-12）

| 能力 | 状态 | 证据 |
|---|---|---|
| 运行时资产管线（P1） | ✅ 有脚本、本机实测可复现 | `tools/runtime/build-runtime.sh` + `README.md` |
| 补丁工程化（P4） | ✅ 6 个 diff + pins.json | `runtime/patches/` |
| 运行时 CI | ❌ 没有（workflow 从不构建 rootfs） | `apk.yml` 只构建 bionic 资产 |
| 清单与启动器（P2） | 🟡 有代码、**没接线** | `runtime/RuntimeManifest.kt`、`runtime/ProotHost.kt`、`runtime/ProotProbeActivity.kt`；`EngineManager.bootWithHost()` **零调用** |
| rootfs 安装器 | ❌ 没有 | 全仓无 `RootfsInstaller` / 解 xz 的代码 |
| 默认宿主 | ❌ 仍是 bionic | `EngineManager.start()` 走 `TermuxBootstrap` |
| APK 资产 | ❌ 仍要求 bootstrap / node-runtime / android 原生包 | `tools/ci-fetch-assets.sh`、`app/src/main/assets` |
| 能力搬迁（bash/shell/root） | ❌ 未开始 | `bash` 目前跑在宿主；`shell`/`root` 依赖宿主 node |

**结论**：0.4.4-test 只做到了「探针能起 proot」，产品路径仍全是 bionic。0.5.0 的工作是把探针变成唯一路径。

## 三、工作分解

| 编号 | 内容 | 验收 | 状态 |
|---|---|---|---|
| **S1** | 运行时资产进 CI：交叉编译 + 硬断言 + artifact | `runtime.yml` 绿、artifact 有 rootfs/manifest/jniLibs、`verify.py` PASS | ✅ 2026-11-12（run 43215359752，22 OK / 0 FAIL） |
| **S2** | rootfs 安装器：解 `tar.xz`、原子替换、`.stamp`、空间预检、失败可重试 | 真机首启解包成功；重复启动不重解；坏包能报错 | 🟡 代码完成 + CI 编译通过（run 43216285582），待真机 |
| **S3** | 启动接线：`ProotHost` 补 bind（workspace/`/sdcard`）与 `DSH_HOME`；`{PATCHES}` 注入；停止语义；APK 内置运行时资产 | 冷启出 token、页面可加载、无孤儿 node、重启不撞端口 | 🟡 前半完成（PR #5）；`EngineManager` 接线与 S4 合并做（见 §七） |
| **S4** | 删除 bionic：bionic 资产下线（S4b）+ 代码删除（S4c） | `check-apk-assets.py` 新清单全过；APK 里无 bionic 资产 | ✅ S4b；🟡 S4c 进行中 |
| **S4.5** | **x86_64 运行时变体**：ABI 参数化 + `-PtargetAbi` + `apk-x64.yml` | x86_64 artifact/APK 可出；雷电能否跑 PRoot 见 §九 | 🟡 构建链路完成；雷电被 ptrace 拦截（§九），验收需 AVD/真机 |
| **S5** | 能力搬迁：`bash` 身份、`/sdcard` 绑定、`shell`(uid2000)、`root`(uid0)、无线调试、dev-env、镜像 | 真机 D-03…D-11 全过 | ⬜ |
| **S6** | 数据迁移与救援：`$DSH_HOME` 复用、索引重建、救援 profile 走 proot、rootfs 修复 | 0.4.3/0.4.4 → 0.5.0 升级不丢会话 | ⬜ |
| **S7** | 真机矩阵：冷启、附件、终端、检索、沙箱、插件、断网、存储不足 | 见 c-plan §P5 判据 | ⬜ |
| **S8** | 发布 0.5.0：vc51、CHANGELOG、release notes、0.4.4-test 撤下 | CI 出包 + 真机 smoke | ⬜ |

## 四、本轮完成（2026-11-12）

- 新增 `.github/workflows/runtime.yml`：ubuntu runner 上装 `aarch64-linux-gnu-gcc` + patchelf + xz，跑 `build-runtime.sh`，产物上传 artifact。
- 新增 `tools/runtime/verify.py`：对产物做硬断言（AArch64、无 x64 包、manifest 对账、DT_NEEDED）。这是 R-03（构包机 x64 装错 optionalDependencies）的唯一自动门禁。
- 修 `build-runtime.sh`：`CC` 可覆盖（CI 用交叉编译器；原脚本章节里写死 `gcc`，在 x86_64 runner 上会把 **x86_64** 的 C 产物打进 arm64 rootfs）；npm 安装补 `npm_config_os=linux npm_config_cpu=arm64`。

## 五、下一步（S2）

1. Gradle 依赖：`org.tukaani:xz` + `org.apache.commons:commons-compress`（Apache-2.0 / public domain，MIT 兼容；**不要**抄 dsh-Go 的 AGPL 实现）。
2. `RootfsInstaller`：读 assets 里的 `runtime/rootfs-arm64-v8a.tar.xz` → 解到 `runtime/rootfs.staging-<ver>-<pid>` → 校验 `manifest.json` 的 sha256 → `rename` 原子替换 → 写 `.rootfs.stamp`。
3. 首启 UI：进度、空间预检（解包后约 1 GB）、失败卡片（重试 / 导出诊断）。
4. 验收：真机断网首启成功；重复启动不重解；手动删一个 rootfs 文件后能重装。

## 六、日志

| 日期 | 事项 |
|---|---|
| 2026-11-12 | S1 完成：运行时构建进 CI；新增 verify.py；修交叉编译与 npm 平台参数 |
| 2026-11-12 | S2 代码：RootfsInstaller（xz 解包 / 原子替换 / sha256 / 空间预检）+ Gradle 依赖；CI 编译通过，待真机验收 |
| 2026-11-12 | 事故：apk.yml 的「发布到 Release」只在 `if: success()` 上，PR 构建把 `v0.4.4-test` 的 APK 覆盖成了 PR 代码。已加 `event != pull_request && ref == refs/heads/main` 门禁 |
| 2026-11-12 | S3 前半：ProotHost 加固（DSH_HOME→/root/.dsh、workspace 与 /sdcard 绑定、{PATCHES} 注入且缺占位符即拒绝、SIGQUIT 停止）；manifest 与 verify 同步；探针改走安装器 |
| 2026-11-12 | S3 后半（资产侧）：apk.yml 新增 runtime job 并把 rootfs/manifest/jniLibs 铺进 APK；check-apk-assets 增加运行时与四个 jniLib 断言。EngineManager 接线与 S4 合并，理由见 §七 |
| 2026-11-12 | 计划调整：x86_64 运行时变体插在 S4 之后（S4.5），用于雷电/MuMu 原生测试 |

## 七、为什么 `EngineManager` 接线与 S4 合并做

`start()` 是一条 700 行的单一流程：Termux 安装 → 体检 → 建救援 profile → 12 个
`ensureXxx`（原生插件、flock、rg、sharp、node-pty、pnpm…）→ 写 15 个 overlay →
拼 argv → 起进程 → 就绪/救援/网关检查。

这些步骤里的**路径与产物全都按 bionic 写死**：

| 步骤 | 写的值 | proot 下应该是 |
|---|---|---|
| `writeSandboxPatch` | `filesDir/boo-sandbox-run` | `/usr/local/bin/boo-sandbox-run`（guest） |
| `writeSessionSearchPatch` | `filesDir/home/.dsh/session-index.sqlite` | `/root/.dsh/session-index.sqlite`（guest） |
| 原生插件 ensure | bionic 自编译 `.node` | rootfs 里官方 linux-arm64 预编译 |
| pnpm / rg / sharp | android 资产 | rootfs 自带 |

如果现在就在 `start()` 里加一条 `if (proot)` 分支而不同时删除 bionic，
会出现**两套半成品路径**：proot 分支要跳过 12 个 ensure，又得重新生成 3 个 overlay；
bionic 分支继续留在下面等下次运行 —— 这正是 0.4.4-test 停在「探针能起、产品路径仍是
bionic」的原因，也是 0.4.4 被判失败的直接原因。

所以顺序定为：

1. S3（本 PR）：把运行时**契约**与**资产**准备好（ProotHost 加固、{PATCHES}、
   apk.yml 内置 rootfs + jniLibs、APK 资产断言）。此时 App 行为不变，但
   `ProotProbeActivity` 可以在真机/模拟器上跑完整链路。
2. S4：**一次**把 `start()` 改成 proot 单路径，同时删除 `TermuxBootstrap`、
   12 个 bionic ensure、bionic 资产与 `HostMode`，并把三个 overlay 写成 guest 路径。
   编译与真机验收都在同一个 PR 里完成 —— 不会出现「两条都不完整」的中间态。
3. S4.5：x86_64 运行时变体（S4 之后单独做，见上表）。

这也是「单宿主」的代价：切换必须是一次原子替换，不能分两次半切换。

## 八、S4.5：x86_64 运行时变体（雷电 / MuMu 原生测试）

> 目的：模拟器是 x86_64。arm64 APK 只能靠转译层跑，proot 的 ptrace 语义在转译下
> 不可靠。做一个原生 x86_64 变体，模拟器才能当回归环境。

### 8.1 运行时构建参数化

`tools/runtime/build-runtime.sh` 现在把 ABI 写死为 `arm64-v8a`。改成：

| 维度 | arm64-v8a | x86_64 |
|---|---|---|
| Ubuntu base | `ubuntu-base-24.04.5-base-arm64.tar.gz` | `...-amd64.tar.gz` |
| Node | `node-v24.22.1-linux-arm64.tar.xz` | `...-linux-x64.tar.xz` |
| proot | `proot_5.1.107.102_aarch64.deb` | `proot_5.1.107.102_x86_64.deb` |
| talloc / shmem | `aarch64` deb | `x86_64` deb |
| C 适配层 | `aarch64-linux-gnu-gcc` | 宿主 `gcc`（runner 本身就是 x86_64） |
| 产物 | `rootfs-arm64-v8a.tar.xz` | `rootfs-x86_64.tar.xz` |
| verify `e_machine` | 183 | 62 |

`verify.py` 的 `BAD_PKG_FRAGMENTS` 要按 ABI 反转：x86_64 构建禁止
`linux-arm64` / `android-arm64`，允许 `linux-x64`。

### 8.2 两个 CI 产物

- `runtime.yml` / `apk.yml` 的 runtime job 用 **matrix**：`[arm64-v8a, x86_64]`；
- artifact 名 `runtime-<abi>`，互不覆盖。

### 8.3 Gradle flavor

`flavorDimensions += "abi"`，两个 productFlavor：`arm64` / `x64`，各自：

- `ndk { abiFilters += "<abi>" }`；
- `src/<flavor>/jniLibs/<abi>/*.so`（proot 四件套）；
- `src/<flavor>/assets/runtime/*`（rootfs + manifest）。

APK 体积：两个 flavor 各自只带自己的 rootfs，不会翻倍；x64 包仅用于模拟器，
发布仍然只发 arm64。

### 8.4 验收

| 项 | 判据 |
|---|---|
| 构建 | `runtime-x86_64` artifact + `x64` APK 绿 |
| 安装 | 雷电 14 / MuMu（API 34，x86_64）`adb install` 成功 |
| 运行 | `ProotProbeActivity` 输出 `health=PASS`、`leftover_node=0` |
| 冷启 | 记录解包与引擎两段耗时，写回本文 |
| 2026-11-12 | S4a：`EngineManager.start()` 命中 manifest 即走 `startProot()`（安装 rootfs → 共用插件写入 → proot 启动 → token/Ready）；`stop()` 走 ProotHost 的 pidfile+SIGQUIT；新增 `compile.yml` 做 5 分钟级 Kotlin 编译门禁。bionic 代码暂时保留为死路径，S4b 删 |
| 2026-11-12 | S4a CI 绿：编译检查 43224299560、runtime 43224299477、APK 43224299419；APK 310 MB（bionic + runtime 同时在内，S4b 删 bionic 后回落） |
| 2026-11-12 | S4b：apk.yml 删掉 engine.bin / node-runtime / bootstrap / 原生 addon / pnpm / sharp / rg / adb / webview-compat 的现场构建与资产闸门；`check-apk-assets.py` 只剩 runtime + 插件资产；`DshApplication` 检测到 runtime manifest 即跳过 Termux bootstrap。APK 预期从 310 MB 回落到 ~190 MB |
| 2026-11-12 | S4b 绿：run 43227977619 APK 成功，**136 MB**（310 → 136，低于 0.4.4 的 184 MB）；bionic 资产已不在包里。同日把 `check-apk-assets.py` 接进 apk.yml 作为出包门禁 |
| 2026-11-12 | S4.5 代码：`build-runtime.sh` 按 ABI 选 ubuntu/node/proot/talloc/shmem 与 CC，x86_64 三个 deb 的 sha256 已从 Termux x86_64 Packages 索引核对；`verify.py` 按 abi 判 e_machine（183/62）与平台包黑名单；Gradle 增加 `-PtargetAbi`；新增手动 `apk-x64.yml`；`check-apk-assets.py` 支持 `--abi` |

## 九、LDPlayer x86_64 实测结论（2026-11-12）

### 9.1 能走通的

- x86_64 rootfs/manifest/jniLibs 构建、verify、x64 APK、`check-apk-assets --abi x86_64` 全部通过；
- APK 在雷电 14（Android 14 / API 34）安装成功（同一 applicationId、debug 签名）。

### 9.2 两个真实发现（已修）

1. **patchelf 会改坏 proot**：原版 `proot --version` 正常；`patchelf --replace-needed libtalloc.so.2 libtalloc.so` 之后同一二进制 **SIGSEGV**。
   → 改为 **不 patchelf**：`libtalloc.so.2` / `libandroid-shmem.so` 以 assets 原名下发，ProotHost 解到 `files/proot-libs`，`LD_LIBRARY_PATH=<nativeLibDir>:<proot-libs>`。
2. **模拟器拦截 `su` 文件名**：解包时 `./etc/pam.d/su` 必定 ENOENT（同目录前 14 个文件全部成功；mkdir su 目录反而可以），是模拟器安全策略，不是我们的路径/类型判断。
   → 解包跳过 basename 为 su 的条目（rootfs 里的 su 本 App 用不到；Android root 通道走宿主 su）。

### 9.3 走不通的：LDPlayer 拒绝 ptrace

```text
proot error: ptrace(TRACEME): Permission denied
proot error: execve("/usr/bin/env"): Permission denied
```

- 同一份原版 proot 在 app 数据目录里 `--version` 正常，一旦进入 trace 就 Permission denied；
- `adbd cannot run as root in production builds`，无法用 root 侧绕过；
- 这是 **LDPlayer 的 Android 镜像限制**（seccomp/SELinux），与 ABI、rootfs、我们的启动参数无关。

**结论**：雷电/MuMu 这类模拟器不能作为 PRoot 的验收环境。可选替代：
1. Android Studio AVD（Google APIs x86_64 镜像）——dsh-Go 的模拟器验证走的是这类镜像；
2. arm64 真机（最可靠）；
3. 若必须用雷电，只能验证「bionic 路径」或非 PRoot 功能，不能验证 S4 之后的运行时。
| 2026-11-13 | AVD 验证：AEHD 2.2 + Google APIs x86_64 API34 起机成功；PRoot 在该镜像里可 trace（`proot -r rootfs /bin/echo` rc=0），dsh 打印 token，`GET /` 返回 401。发现裁剪 bug：`@deepseek-ai/dsh-win32-process` 被当成平台包删掉，导致 subprocess/sandbox 服务 import 失败；裁剪改为只删 `@img/sharp-*` 与 `node-addon-system-*` 的原生包 |

### 9.4 AVD 端到端探针 PASS（2026-11-13）

环境：Google APIs x86_64 API34 + AEHD 2.2，`emulator-5556`，本地 Gradle（阿里云镜像）出包。

```text
install=done
runtimeVersion=r1-x86_64-dsh0.2.2-rc.1-node24.22.1-ubuntu24.04.5-7bf4b287f5dc
started (+18ms)
token_after_ms=46746
http=401
health=PASS
stopped=true
leftover_node=0
RESULT=PASS
```

期间修掉的三处（都已进本 PR）：

1. `build-runtime.sh` 的 pidfile 命令被 JS/替换吃掉一个 `$`，写成 `echo $ >`；恢复 `echo $$`，pidfile 才有 node pid；
2. `ProotHost.stop()` 在 pidfile 无效时按 `/proc/*/cmdline` 兜底杀 guest node；
3. manifest 缺 `{PATCHES}` 的守卫、proot-libs 从 assets 解出并加进 `LD_LIBRARY_PATH`。
| 2026-11-13 | S4c：`EngineManager.start()` 改为 proot 单路径（bionic 分支整段删除）；删除 `TermuxBootstrap.kt`、`MirrorProbe.kt`、`termux/tool/*`、`termux/util/*` 与 6 个仅定义未调用的 ensure（约 20 KB 源码）；剩余 bionic 辅助函数待随救援/无线调试重构一并删。新增 `tools/local/gradle-mirrors.gradle`（阿里云镜像，仅本地开发用） |

### 9.5 真 App 启动（不是探针）—— AVD 上官方前端已加载

`MainActivity` 启动 → `ensureExtracted` 命中单运行时早返回 → `startProot`：
15 个 `--patch` overlay（mobile-ui / sandbox-proot / session-search / 工具插件…）全部传入，
engine 打印 token，WebView 加载官方前端成功（“Into the Unknown” 首页 + 工作区选择器）。

过程中修掉：`MainActivity` 仍会调 `ensureExtracted(assetStamp)`，单运行时下没有
`engine.bin` → `FileNotFoundException: engine.bin`。在 `ensureExtracted` 开头检测
`assets/runtime/manifest.json`，命中即返回。

遗留：首页停在「Choose workspace」——引擎侧没有默认工作区，需要用户在 UI 里选
（或由 App 启动时把 `filesDir/workspace` 注册为默认工作区）。下一步处理。
