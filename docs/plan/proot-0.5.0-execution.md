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
| **S1** | 运行时资产进 CI：交叉编译 + 硬断言 + artifact | `runtime.yml` 绿、artifact 有 rootfs/manifest/jniLibs、`verify.py` PASS | ✅ 2026-11-12 |
| **S2** | rootfs 安装器：解 `tar.xz`、原子替换、`.stamp`、空间预检、失败可重试 | 真机首启解包成功；重复启动不重解；坏包能报错 | ⬜ |
| **S3** | 启动接线：`ProotHost` 补 bind（workspace/engine/tmp/`/sdcard`）与 `DSH_HOME`；`EngineManager.start()` 改走 proot；停止语义与健康判据 | 冷启出 token、页面可加载、无孤儿 node、重启不撞端口 | ⬜ |
| **S4** | 删除 bionic：`TermuxBootstrap`、bionic 资产、`HostMode`；`apk.yml` 改消费 runtime artifact | `check-apk-assets.py` 新清单全过；APK 里无 bionic 资产 | ⬜ |
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
