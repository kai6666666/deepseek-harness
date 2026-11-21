# DSH for Android

**在 Android 手机上跑一个完整的 AI 编码 Agent。**

[English](README.en.md) · [文档](docs/agents/README.md) · [参与贡献](CONTRIBUTING.md)

---

## 这是什么

DSH for Android 把 [DSH](https://github.com/deepseek-ai)（DeepSeek Harness）桌面端引擎
原样搬进手机：内置一个 **PRoot + glibc 单运行时**（rootfs 自带 `/usr/bin/node`），
Node 上跑 `@deepseek-ai/dsh` 引擎，再由 WebView 加载 DSH 自带的 Web GUI。

**不再依赖 Termux**：`0.3.0` 起重构为「单宿主 PRoot」，运行期零 Termux 依赖。

**它不自绘聊天界面。** UI 完全复用官方前端，只在窄屏下由内置插件做移动端适配 ——
所以你得到的不是「手机版阉割界面」，而是**与桌面端同一个前端**，只是能装进口袋。

```
APK
APK
 ├─ jniLibs 四件套          libproot.so / libproot-loader.so / libtalloc.so / libandroid-shmem.so
 ├─ rootfs（arm64-v8a）      ubuntu 24.04 + glibc：/usr/bin/node + 引擎 /opt/dsh
 ├─ 运行时资产               assets/runtime/{manifest.json, rootfs-arm64-v8a.tar.xz}
 ├─ 原生层（可选 LD_PRELOAD） linkcompat / boosandbox（bash 工具沙箱）
 └─ 内置插件                 移动端适配 / 悬浮球 / UI 调试 / 日志 / 记忆 …
```

## 特性

- **完整的 Agent 能力** —— `bash`、文件读写、`grep`/`glob`、终端 PTY 全部可用，
  不是只读聊天框。
- **单 Web 内核（system）** —— 主发行线自 `0.3.x` 起只出 `system` 包（用设备自带 WebView）。
  `gecko` 变体（内置 GeckoView）最后一版是 `v0.4.2`，之后不再随包发布。
- **移动端 UI 适配** —— 官方前端 + 窄屏适配插件，不是另写一套界面。
- **悬浮球** —— 随时唤起，支持自定义外观、帧动画、视频图层。
- **UI 调试工具** —— 让模型自己看屏幕、点按钮，实现端到端自测。
- **救援模式** —— 插件写坏导致 App 打不开时，四级降级阶梯 + App 内自助摘除。
- **日志与诊断** —— 三层存储、崩溃现场快照、一键导出诊断包。

## 快速开始

### 安装

直接下载最新发行版（**v0.2.2-rc.3**，system 内核，arm64-v8a）：

| 包 | applicationId | 下载 |
|---|---|---|
| `dsh-android-0.2.2-rc.3-arm64.apk` | `com.dsh.android` | [点击下载](https://github.com/kai6666666/deepseek-harness/releases/download/v0.2.2-rc.3/dsh-android-0.2.2-rc.3-arm64.apk) |

其余版本与历史记录见 [Releases](https://github.com/kai6666666/deepseek-harness/releases)。

**gecko 变体**（内置 GeckoView，系统 WebView 太旧或不可用时用）最后一版是 `v0.4.2`：
`dsh-android-0.4.2-gecko-arm64.apk`（`com.dsh.webview`），可与 system 版并存；`0.3.x` 起主发行线只出 system 包。

| 包 | applicationId | 适用 |
|---|---|---|
| `DSH<版本>.apk` | `com.dsh.android` | 当前主发行线（`0.3.x` 起只出这个） |
| `dsh-android-0.4.2-gecko-arm64.apk` | `com.dsh.android.webview` | 历史 gecko 变体（停于 `v0.4.2`） |

gecko 变体的 `applicationId` 与 system 版不同，**两者可以同时安装**，数据目录互相独立。

> ⚠️ **仅支持 arm64-v8a**（`minSdk 26` / `targetSdk 35`）。
> 历史上「包名 15 字符」「targetSdk ≤ 28」两条硬约束**均已解除**，见下方[已解除的历史约束](#已解除的历史约束)。

### 从源码构建

```powershell
$env:JAVA_HOME = "<你的 JDK 17 路径>"   # 必须显式设置

.\gradlew.bat :app:assembleSystemDebug --console=plain
# → app\build\outputs\apk\system\debug\app-system-debug.apk

.\gradlew.bat :app:assembleGeckoDebug --console=plain
# → app\build\outputs\apk\gecko\debug\app-gecko-debug.apk
```

**环境**：JDK 17 · AGP 8.8.2 · Kotlin 2.0.21 · Gradle 8.13 · compileSdk 35 · minSdk 26

### ⚠️ 运行时资产不在仓库里

单运行时化之后，构建只依赖两类运行时资产，它们**都不入库**：

| 资产 | 来源 | 说明 |
|---|---|---|
| `assets/runtime/rootfs-arm64-v8a.tar.xz` + `manifest.json` | CI 的 `runtime` job（`tools/runtime/build-runtime.sh`） | ubuntu 24.04 + node + `/opt/dsh`，**解包约 1.3 GB** |
| `jniLibs/arm64-v8a/*.so`（四件套） | 同上 | `libproot.so` / `libproot-loader.so` / `libtalloc.so` / `libandroid-shmem.so` |

CI 里由 `apk.yml` 的 `runtime` job 构建后自动铺到 `app/src/main/{assets/runtime,jniLibs}`；
本地要出包就先跑一次 `bash tools/runtime/build-runtime.sh`（需要 binfmt / proot 环境）。

生成方式与校验见 [docs/agents/regen-assets.md](docs/agents/regen-assets.md)。
旧的 Termux 时代资产（`engine.bin` / `node-runtime.bin` / `bootstrap-aarch64.zip` 等）**已全部删除**。

## 已解除的历史约束（勿再照旧规则改）

这两条曾经是平台事实，`0.3.0` 的单宿主 PRoot 重构已把它们**全部解除**。
保留这段只为防止有人照旧文改回去。

| 旧约束 | 曾经为什么成立 | 现在为什么不成立 |
|---|---|---|
| ① 包名必须恰好 15 字符 | `TermuxBootstrap.patchElfInPlace()` 对 ELF `.dynstr` 做**等长原地覆盖**，`/data/data/<包名>/` 必须等于 27 字节 ⇒ N = 15 | **该函数与 `TermuxBootstrap` 已从源码树删除**。可执行体改由 jniLibs 承载，rootfs 内 ELF 由 proot loader `mmap`，运行期不再重写任何 ELF 前缀 ⇒ `applicationId` 可任意取 |
| ② targetSdk 必须 ≤ 28 | API 29 起禁止 `execve()` 应用私有目录里的文件（W^X / SELinux `untrusted_app`） | 内核 `execve` 面只剩 `nativeLibraryDir/*.so`（API 29 `execute_no_trans` 的官方例外）。当前 **`targetSdk = 35`**，29 → 30 → 34 → 35 各档均有真机数据 |

**现在唯一的硬约束是 `arm64-v8a`**（运行时 rootfs 只构建这一个 ABI）。
「只能侧载」仍然成立，但原因是自签分发，与 targetSdk 无关。

## 架构

```
MainActivity (WebView / GeckoView)
      │  加载 http://127.0.0.1:<port>
      ▼
  DSH Web GUI  ←── 官方前端 + 移动端适配插件
      │
      ▼  HTTP
  DSH 引擎（Node）
      │
      ├─ tool: bash      → 经 boo-sandbox-run 沙箱
      ├─ tool: read/write → 经 liblinkcompat.so 转译 link
      ├─ tool: grep/glob → 静态 ripgrep
      └─ tool: ui/bubble → 原生桥（文件信箱）
      │
      ▼
  PRoot rootfs（filesDir/runtime/rootfs：glibc + /usr/bin/node + /opt/dsh）
```

### 为什么需要这么多 native 层

Android 的 `process.platform` 是 `'android'` 而非 `'linux'`，而 DSH 官方的原生插件
与平台判断都是按 `linux`/`darwin`/`win32` 三选一写的。凡是「官方只认 linux、但代码
本身与 libc 无关」的地方，都要为 android 补一份。

更麻烦的是**三处 Android 主动不给的能力**，只能靠 `LD_PRELOAD` 在 libc 边界绕开：

| 层 | 解决什么 | 文档 |
|---|---|---|
| `liblinkcompat.so` | SELinux 不给 `link()` 权限（`EACCES`/`EINVAL`） | [link-compat.md](docs/agents/link-compat.md) |
| `boo-sandbox-run` + `libboosandbox.so` | Android 没有 bwrap/Landlock，但 `bash` 工具要求沙箱 | [sandbox.md](docs/agents/sandbox.md) |

## 目录结构

```
app/src/main/java/com/dsh/android/     原生宿主（Kotlin）
app/src/main/jni/                      native 层（C，LD_PRELOAD）
app/src/main/assets/                   运行时资产（⚠️ 不入库，runtime job 自动铺）
app/src/system/ · app/src/gecko/       两个 Web 内核的 flavor 源集（gecko 已停发）
mobile-ui-plugin/                      内置插件源码（TypeScript/JS）
remote-plugin/                         配对服务端 + 端到端测试
tools/                                 构建与校验脚本
docs/agents/                           开发文档（60 篇，按需检索）
```

## 文档

**别整份读 `docs/agents/`** —— 按「你要改什么」查索引：
[docs/agents/README.md](docs/agents/README.md)

| 你要改什么 | 先看 |
|---|---|
| 任何 native / 子进程相关 | [platform-android.md](docs/agents/platform-android.md) |
| `bash` 工具报 "no sandbox backend" | [sandbox.md](docs/agents/sandbox.md) |
| `write` 工具报 `EACCES/EINVAL: link` | [link-compat.md](docs/agents/link-compat.md) |
| 改任何 `.zip` / `.bin` 资产 | [asset-stamps.md](docs/agents/asset-stamps.md) |
| 构建发行包 / 签名 / 发布 | [build-and-ship.md](docs/agents/build-and-ship.md) |
| 插件改坏导致 App 打不开 | [rescue-mode.md](docs/agents/rescue-mode.md) |

## 已知边界

- **沙箱不隔离 PID 命名空间** —— `--unshare-pid` 需要 CAP_SYS_ADMIN，普通应用拿不到。
  文件写边界是完整的。
- **仅 arm64-v8a** —— 没有 arm32 / x86 构建。
- **只能侧载** —— 自签分发（targetSdk 35，与上架无关，当前不上架）。
- **APK 较大** —— 约 195 MB（rootfs + 引擎 + node 随包分发）。
- **首次启动较慢** —— 要解包约 1.3 GB 的 rootfs，本机实测约 110 秒（之后冷启约 66 秒到 `engine.ready`）。

完整清单见 [boundaries.md](docs/agents/boundaries.md)。

## 参与贡献

欢迎 Issue 与 PR。动手前请读 [CONTRIBUTING.md](CONTRIBUTING.md) ——
它记录了曾经的**两条硬约束**（现已解除，见上）与「改了资产必须同步改版本戳」
这类静默失败陷阱。

## 致谢

本项目站在这些项目的肩膀上：

- [DSH / DeepSeek Harness](https://github.com/deepseek-ai) —— 引擎与 Web 前端
- [Termux](https://github.com/termux) —— **历史来源**：`0.3.0` 之前的 bootstrap / node / adb 二进制（现已全部移除）
- [Mozilla GeckoView](https://wiki.mozilla.org/Mobile/GeckoView) —— 内置 Web 内核（gecko 变体停于 `v0.4.2`）
- [DSHAPP](https://github.com/pht88888888/DSHAPP) —— 移动端集成与登录流程参考
- [ripgrep](https://github.com/BurntSushi/ripgrep) · [sharp](https://github.com/lovell/sharp)
  · [pnpm](https://github.com/pnpm/pnpm) · [Shizuku](https://github.com/RikkaApps/Shizuku)

## 许可证

[MIT](LICENSE)
