# CI 构建 APK（A 方案）

## 1. 为什么必须是 x86_64 runner

本机（arm64）实测：`./gradlew :app:assembleSystemDebug` 能配置工程、能解析 AGP，
停在工具链：

```text
Failed to install … build-tools;35.0.0
```

因为 Google 的 build-tools 只发 **linux-x86_64** 二进制（`aapt2` / `d8` / `zipalign` /
`apksigner`）。Debian 的 `android-sdk-build-tools` 只提供 `aapt` 与 `aapt2`（arm64），
没有 dex 与打包工具。

所以：**本机只做编译门禁（`tools/verify-engine.sh`），出包交给 `ubuntu-latest`。**

## 2. 工作流

文件：`.github/workflows/apk.yml`

| 步骤 | 作用 |
|---|---|
| `setup-java` 17 temurin | AGP 8.x 要求 JDK 17 |
| `android-actions/setup-android@v3` | 装 `platforms;android-35` + `build-tools;35.0.0` |
| `tools/ci-fetch-assets.sh` | 从 Release 下载 `dsh-assets*.zip` 铺到 `app/src/main/assets/` |
| `tools/verify-engine.sh` | engine 包独立编译门禁（不需要资产，先失败先报） |
| `./gradlew :app:assembleSystemDebug` | 出包 |
| `upload-artifact` | `dsh-system-debug`（APK + metadata，保留 14 天） |

触发：`push`（`app/**`、`*.gradle.kts`、`bundle/**`、工作流自身）、`pull_request`、手动 `workflow_dispatch`。

## 3. 资产怎么准备（一次性）

资产共 28 项、约 135 MB，**不入库**。做法：打成一个 Release 附件。

```bash
# 在出过包的机器上（本机也行，assets 目录里已有真实文件）
cd app/src/main/assets
zip -9 -r /tmp/dsh-assets.zip . -x '*.md'

# 建 Release 并上传（gh 已登录，或 GH_TOKEN=…）
gh release create assets-v1 /tmp/dsh-assets.zip \
  --title "构建资产 v1" \
  --notes "engine.bin / node-runtime.bin / 原生 zip；供 CI 构建 APK 使用"
```

然后在仓库 **Settings → Variables** 加：

```text
ASSETS_RELEASE = assets-v1
```

没有这个变量也能跑：工作流打印 `::notice::未指定 ASSETS_TAG`，然后**现场自建两个最大的资产**：

| 资产 | 构建方式 | 体积 / 耗时 |
|---|---|---|
| `engine.bin` | `tools/build-engine-bin.sh`（npm 装 rc.3 → 裁非 arm64 → zip） | ~96 MB / 3–6 min |
| `node-runtime.bin` | `tools/build-node-runtime.sh`（Termux deb → `bin/node` + 9 库 + `LINKS.txt`） | 32 MB / 1–2 min |

仍未覆盖的是 26 个原生/插件 zip（pnpm、ripgrep、sharp、node-pty、各 tool 包……）：
它们需要本机编译或私有构建产物，所以「完整可运行包」仍建议走 `ASSETS_RELEASE`。

### node-runtime.bin 的布局（手改时必须对齐）

```text
bin/node                  → $PREFIX/bin/node
lib/libicuuc.so.78.3 …    → $PREFIX/lib/*
LINKS.txt                 → 每行「lib/xxx.so 裸目标名」，运行期建软链（zip 不存 symlink）
```

实测产出：`nodejs 26.12.1 + libicu 78.3 + c-ares 1.34.9 + libffi 3.8.0 + libsqlite 3.54.1`
⇒ 11 条目 / 14 条软链 / **32 MB**。

## 4. 手动触发与严格模式

`Actions → 构建 APK → Run workflow`：

| 输入 | 含义 |
|---|---|
| `assets_release` | 覆盖仓库变量，填 `assets-v1`；留空则读 `vars.ASSETS_RELEASE` |
| `strict_assets` | `1` = 缺任何一项资产直接失败（发布前用）；`0` = 降级出包 |

## 5. 产物与安装

```text
app/build/outputs/apk/system/debug/app-system-debug.apk   # flavor=system（WebView）
```

- 只出 `system` flavor；`gecko`（GeckoView）依赖预编译 AAR，需要另配仓库，暂不进 CI。
- `debug` 签名由 AGP 自动生成（`~/.android/debug.keystore`），**不能用于分发**；
  正式包走本地 `keystore.properties` + `assembleSystemRelease`。
- 装机注意：`targetSdk = 28`、`applicationId` 恰好 15 字符（`com.dsh.android`）——
  这两个是 Termux ELF 改写与 `execve` 限制决定的，不能改。

## 6. 失败排查表

| 症状 | 原因 | 处理 |
|---|---|---|
| `Failed to install build-tools;35.0.0` | SDK 许可未接受 | `setup-android` 的 `log-accepted-android-sdk-licenses: true` 已开；自建 runner 需手跑 `sdkmanager --licenses` |
| `Unresolved reference: R` | `android.jar` 与 compileSdk 不匹配 | 确认装了 `platforms;android-35` |
| 构建 OOM | Gradle daemon 默认堆偏小 | 在 `gradle.properties` 调 `org.gradle.jvmargs=-Xmx3g` |
| 资产步骤 404 | Release tag 写错 / 附件名不是 `dsh-assets*.zip` | 检查 tag 与附件命名 |
| APK 装完引擎起不来 | 走的无资产模式 | 看 `assets/ASSETS_MISSING.txt` 与服务日志 |

## 7. 与本地流程的关系

```text
本地（arm64，手机/Ubuntu proot）       CI（x86_64）
─────────────────────────────         ────────────────────────────
tools/verify-engine.sh   ✅ 编译门禁    tools/verify-engine.sh  ✅ 同一脚本
tools/check-engine-anchors.mjs ✅      ——（assets 就位后跑）
assembleSystemDebug      ❌ 无工具链    assembleSystemDebug     ✅ 出 APK
```

验证方式：推一次带 `app/**` 改动的提交，Actions 里应出现 `构建 APK（x86_64 runner）`
且 `assemble` job 绿；下载 `dsh-system-debug` 工件即可装机。

## 8. 首次实战记录（两次真故障，已修）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | `./gradlew: Permission denied`，exit 126 | 仓库从 Android 文件系统（FUSE，noexec）提交，posix 可执行位全丢，git 里是 `100644` | 工作流加 `chmod +x gradlew tools/*.sh`，并把调用改为 `bash ./gradlew` |
| 2 | `118 × Unresolved reference 'compose'`（`HostSettingsSection.kt`） | 该文件用 Compose 写的，而 `app` 模块**没有** compose 依赖 | 改写为 `android.widget.*` 纯 View 实现（零新增依赖） |

关键教训：`tools/verify-engine.sh` 只编 `engine/` 包，**抓不到 `app/` 里的 Compose 误用**——这类错误只有真正跑 `assembleSystemDebug` 才会暴露。

首次绿跑：run **40312131079**，`dsh-system-debug` 工件 **6.61 MB**（无资产版：APK 内没有引擎，装上可开界面）。

第二次绿跑（带资产）：run **40315026081**

| 项 | 实测值 |
|---|---|
| `assets/engine.bin`（npm 现场打） | **114 MB** |
| `assets/node-runtime.bin`（Termux deb 现场打） | **32 MB** |
| `assets/` 合计 | **145 MB** |
| `app-system-debug.apk` | **145,381,297 B（约 138.6 MiB）** |
| 工件 `dsh-system-debug` | 137.71 MB |

### 第三次绿跑（开工 NDK）：run 40316540773

`tools/build-native-assets.sh` 用 NDK 27 现场编出三个 C 适配层，并从 npm 打 pnpm：

| 资产 | 产物大小 | 说明 |
|---|---|---|
| `boosandbox.bin` | 23,488 B | `-shared -fPIC -ldl`，LD_PRELOAD 沙箱 |
| `boo-sandbox-run.bin` | 10,024 B | 可执行启动器 |
| `linkcompat.bin` | 10,440 B | `-shared -fPIC -ldl`，link/rename 转译 |
| `pnpm-android-arm64.zip` | 5.6 MB / 454 条目 | 11.28.3，条目是 `bin/pnpm.mjs`（不带顶层目录） |

三个 `.bin` 都用 `-Wl,--build-id=none` 编译，同源码两次编译字节一致，可用 sha256 判「是否真有改动」。

APK：`151,156,054 B`（约 144.2 MiB），工件 `143.22 MB`。

### 第四次绿跑（插件资产自动化）：run 40319322900

`tools/build-plugin-assets.sh` 一次打 **15 个 zip**，并做三条校验（相对条目 / 入口文件 / `lib/index.js` 字节一致）：

| 类别 | 资产 |
|---|---|
| 工具插件（7） | `shell` / `root` / `bubble` / `statusbar` / `uiagent` / `logs` / `browser` `-tool.zip` |
| 客户端/移动端（3） | `browser-pane.zip`、`pet-bridge.zip`、`mobile-ui.zip`（257 KB） |
| 数据包（5） | `market-plugin`、`core-memory`、`preset-skills`、`preset-razor`、`agnes-multimodal` |

```text
汇总：15 个已打包，0 个跳过
assets 152 MB · APK 151,612,390 B（约 144.6 MiB）· 工件 143.65 MB
```

仍缺 7 项，都需要本机私有产物/额外工具链：
`node-addon-android-arm64.zip`、`node-addon-system-android-arm64.zip`、`node-pty-android-arm64.zip`、
`sharp-wasm32.zip`、`ripgrep-android-arm64.zip`、`adb-wireless-arm64.zip`、`webview-compat.zip`（随引擎版本生成）。

### 第五次绿跑（node-pty）：run 40322232489

`tools/build-node-pty.sh` 用 NDK 27 从引擎副本里的 `node-pty/src/unix/pty.cc` 现编：

```text
node-pty ← /tmp/dsh-engine-0.2.1-rc.3/node_modules/node-pty
头文件   ← npmmirror v26.12.1 …-headers.tar.gz
命令     aarch64-linux-android26-clang++ -shared -fPIC -O2 -std=c++17 -static-libstdc++
产物     pty.node 688,072 B
NEEDED   libm.so libdl.so libc.so        ← 无 libc++_shared，静态链生效
zip 条目 node-pty/prebuilds/android-arm64/pty.node
```

APK：`151,825,101 B` · 工件 `143.86 MB`。资产覆盖升到 **22/28**；仍缺 6 项。

同时修了一个真 bug：`NODE_VERSION` / `NODE_EXECUTABLE_VERSION` 原本写死 `26.4.0`，
而 CI 装的 Termux node 是 **26.12.1** —— 不改就会 `nodeIsUsable()` 判「损坏」，
**每次启动白重解包 32 MB**。现已对齐为 `26.12.1-1` / `v26.12.1`。

APK 几乎等于 assets 总和，因为 `engine.bin` 本身就是 zip（内层 node_modules 已压缩），再压也压不动。
若要把包压回 60 MB 量级，得回到 rc.2 的依赖集（`engine.bin` 55 MB），那是**降版**不是优化。
有资产的包预计回到 ~60 MB 量级（engine.bin 压缩后约 55–60 MB）。
