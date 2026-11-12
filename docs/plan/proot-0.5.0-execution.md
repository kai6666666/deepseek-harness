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
| **S4** | 删除 bionic：`TermuxBootstrap`、bionic 资产、`HostMode`；`EngineManager.start()` 改成唯一 proot 路径；`check-apk-assets.py` 去掉 bionic 条目 | `check-apk-assets.py` 新清单全过；APK 里无 bionic 资产 | ⬜ |
| **S4.5** | **x86_64 运行时变体**：`build-runtime.sh` ABI 参数化（amd64 ubuntu-base / node-x64 / proot_x86_64 / talloc+shmem amd64）+ Gradle x64 flavor（模拟器用） | `runtime.yml` 出 x86_64 artifact；雷电/MuMu 原生安装并跑通 | ⬜ |
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
