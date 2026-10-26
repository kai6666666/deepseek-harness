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

### 第六次绿跑（sharp / ripgrep / adb）：run 40324602759

`tools/build-extra-native.sh` 一次补三个：

| 资产 | 来源 | 体积 / 条目 | 校验 |
|---|---|---|---|
| `sharp-wasm32.zip` | npm `@img/sharp-wasm32@0.35.5` + `@emnapi/*` | 3.6 MB / 24 | 必须含 `@img/sharp-wasm32/lib/sharp-wasm32-0.35.5.node.wasm` |
| `ripgrep-android-arm64.zip` | Termux `ripgrep` deb 的 `bin/rg` + 合成 package.json | 1.8 MB | 条目 `@vscode/ripgrep-android-arm64/bin/rg` |
| `adb-wireless-arm64.zip` | Termux `android-tools` + **9 个 Depends**（libc++ / abseil-cpp / brotli / fmt / liblz4 / libprotobuf / pcre2 / zlib / zstd） | 5.9 MB / 109 | `bin/adb` + 108 个库 |

坑：`android-tools` 的 `Depends` 是 9 个包，v1 只取了 `libc++` → 只打进去 2 个条目，真机会 `cannot locate symbol`。

APK：`163,344,475 B`（≈155.8 MiB）· 工件 `154.84 MB`。

**资产覆盖 25/28**，只剩 3 项：`node-addon-android-arm64.zip`、
`node-addon-system-android-arm64.zip`（需 NDK 编 C++ N-API 插件）、`webview-compat.zip`（随 engine 版本生成）。

### 第七次绿跑（node-addon-system）：run 40327674561

`tools/build-node-addon-system.sh` 从引擎副本里的 `src/flock.c + src/main.c` 现编：

```text
system.node  15,848 B
NEEDED       libdl.so libc.so
符号表        ✅ napi_register_module_v1（合法 N-API 模块）
zip          bin/system.node + package.json + prebuilds.json
```

APK：`163,471,815 B` · 工件 `154.96 MB`。资产覆盖 **26/28**。

### 第八次绿跑（webview-compat）：run 40336517026

`tools/build_webview_compat.py` 把 PowerShell 版移植到 Linux：esbuild 只装一次、8 线程并行。

```text
扫描 149 个 js/css（chrome74）
需要降级 83 个：{'dist': 3, 'engine': 79, 'mobileui': 1}
已生成 webview-compat.zip：条目 84 个，9,657,122 字节
戳 = chrome74-v34
APK 173,112,142 B · 工件 164.16 MB
```

两个移植差异（有意为之）：

| 点 | PowerShell | Python |
|---|---|---|
| 运行时 API 审计 | 有缺口就 throw | 默认只报告，`--strict-audit` 才失败 |
| 性能 | 逐文件 `npx esbuild` | 装一次 + 8 线程（手机上 3m30s，CI ~1min） |

坑：CI 里 `check-frontend-syntax.mjs` 自装 acorn 会因 npm 告警返回 rc=2（＝跳检），
所以工作流先 `npm i --no-save acorn@8` 预装。

**资产覆盖 27/28**：只剩 `node-addon-android-arm64.zip`（npm 包无 C 源码）。

### 收尾绿跑：run 40344696924

新增 `node-addon-require-builtin（插槽）` 步骤，日志里是一条可见告警而不是失败：

```text
##[warning]node-addon-android-arm64.zip 未生成（CI 缺少上游源码）
（跳过，资产覆盖停在 27/28；exit 0，不阻塞出包）
APK 172,976,706 B · 工件 164.03 MB

### 28/28 收尾：run 40354163802

源码镜像（`native/require-builtin-src.zip`，52 文件 / 62 KB，取自 jsDelivr 的 `@HEAD`）
进位后，`require-builtin（源码模式）` 真正跑起来了：

```text
源码：解压 native/require-builtin-src.zip → packages/native
源文件      30 个（按 binding.gyp 的 sources，排除 nodeabi 支）
头文件      node v26.12.1
产物        node-addon-android-arm64.zip 374 KB
NEEDED      libm.so libdl.so libc.so          ← 无 libc++_shared
zip         prebuilt/android-arm64-napi-v9.node + prebuilds.json + package.json
```

顺手修了一个真 bug：脚本名 `build_webview_compat.py`（下划线）与仓库里的
`build-webview_compat.py`（连字符）不一致，CI 报 `can't open file` —— 已按 CI 调用统一成下划线。

最终：**28/28 资产全部自建**，APK `173,420,051 B`，工件 `164.45 MB`。

⚠️ 仍要在真机确认的一点：源码的 `platform.cc` 用 `#if defined(__linux__) && defined(__aarch64__)`
路由到 **Linux/glibc** 探针（解析 glibc loader/malloc 布局），bionic 与 glibc 不同源。
“能编过”不等于“探针能拿到 getter” —— 运行期由加载器 `getNativeBindingInfo()` 与
引擎 try/catch 兜底，失败时会退化成 `ERR_REQUIRE_BUILTIN_UNAVAILABLE`，不会拖垮主链路。
```

插槽的三种行为（见 `tools/build-node-addon-require-builtin.sh`）：

| 模式 | 触发 | 结果 |
|---|---|---|
| 源码 | `native/require-builtin/src/*.c` 存在 | NDK 现编并打包 |
| 外部产物 | `EXTERNAL_ADDON=…/android-arm64-napi-v9.node` | 校验 ELF/AArch64/NEEDED 后打包 |
| 都没有 | 当前 CI | `::warning::` + `exit 0` |

---

## 9. 资产自建总表（26/28）

| 资产 | 脚本 | 来源 |
|---|---|---|
| `engine.bin` | `build-engine-bin.sh` | npm `@deepseek-ai/dsh@0.2.1-rc.3` → 裁剪 → zip |
| `node-runtime.bin` | `build-node-runtime.sh` | Termux `nodejs` + `libicu/c-ares/libffi/libsqlite` |
| `pnpm-android-arm64.zip` | `build-native-assets.sh` | npm `pnpm@11.28.3` |
| `boosandbox.bin` / `boo-sandbox-run.bin` / `linkcompat.bin` | `build-native-assets.sh` | 仓库 `app/src/main/jni/*.c` + NDK 27 |
| 15 个插件 zip | `build-plugin-assets.sh` | 仓库各插件目录（带字节一致校验） |
| `node-pty-android-arm64.zip` | `build-node-pty.sh` | 引擎副本 `node-pty/src/unix/pty.cc` + NDK |
| `sharp-wasm32.zip` | `build-extra-native.sh` | npm `@img/sharp-wasm32` + `@emnapi/*` |
| `ripgrep-android-arm64.zip` | `build-extra-native.sh` | Termux `ripgrep` |
| `adb-wireless-arm64.zip` | `build-extra-native.sh` | Termux `android-tools` + 9 个 Depends |
| `node-addon-system-android-arm64.zip` | `build-node-addon-system.sh` | 引擎副本 `node-addon-system/src/*.c` + NDK |

剩余 2 项：

**这两项现在都已解决（28/28 全自建）**：

| 资产 | 曾经的缺口 | 现在的做法 |
|---|---|---|
| `node-addon-android-arm64.zip` | npm 包只发 JS，无 C 源码 | 源码镜像为 `native/require-builtin-src.zip`（52 文件 / 61,753 B，取自上游 master），CI 用 NDK 编 30 个 `.cc`，产物 374 KB |
| `webview-compat.zip` | 只有 PowerShell 生成器 | `tools/build_webview_compat.py`（esbuild 一次安装 + 8 线程，83 个降级 / 84 条目） |

收口实测（run 40354163802）：

```text
node-addon-android-arm64.zip  374 KB   NEEDED libm/libdl/libc
webview-compat.zip            84 条目 9,657,122 B
APK                           173,420,051 B（~165.4 MiB）
工件                          164.45 MB
```

同时修了一个真 bug：`NODE_VERSION` / `NODE_EXECUTABLE_VERSION` 原本写死 `26.4.0`，
而 CI 装的 Termux node 是 **26.12.1** —— 不改就会 `nodeIsUsable()` 判「损坏」，
**每次启动白重解包 32 MB**。现已对齐为 `26.12.1-1` / `v26.12.1`。

APK 几乎等于 assets 总和，因为 `engine.bin` 本身就是 zip（内层 node_modules 已压缩），再压也压不动。
若要把包压回 60 MB 量级，得回到 rc.2 的依赖集（`engine.bin` 55 MB），那是**降版**不是优化。
有资产的包预计回到 ~60 MB 量级（engine.bin 压缩后约 55–60 MB）。
