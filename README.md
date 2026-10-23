# deepseek harness

Android 宿主：把 DeepSeek Harness（`@deepseek-ai/dsh`）跑在 PRoot 的 Ubuntu 容器里，
用一个前台服务持住它，用 WebView 打开它自己的 Web 客户端。

不 fork DSH、不写 DSH 插件、不改 DSH 源码 —— 只依赖三个稳定契约：

```
1. CLI      dsh web --no-open --port <N>          apps/cli/src/args.ts:93-100
2. stdout   "dsh web: http://127.0.0.1:<N>/?token=..."   packages/bundle/web-app/src/index.ts:231
3. 协议     HTTP + cookie（303 授权交换）
```

---

## 目录

```
app/
├── build.gradle.kts                       compileSdk 36 / targetSdk 34 / minSdk 30
└── src/main/
    ├── AndroidManifest.xml                specialUse 前台服务 + cleartext
    ├── assets/                                  235.8 MiB，分两层，叠在同一父目录（不做裁剪）
    │   ├── layer0-ubuntu-noble-aarch64.tar.xz             61.2 MiB  Ubuntu 24.04 arm64
    │   └── layer1-dsh-node24.19.0-dsh0.2.1-rc.2.tar.xz   174.6 MiB  node 24.19.0 + dsh 0.2.1-rc.2（含 sherpa-onnx 语音库）
    ├── jniLibs/arm64-v8a/
    │   ├── liboperit_proot.so   256 KB   → 运行时改名 proot
    │   ├── liboperit_loader.so  1.6 KB   → loader
    │   ├── libbash.so           1.7 MB   → bash
    │   └── libbusybox.so        1.5 MB   → busybox（tar / mv / chmod 全靠它）
    └── java/ai/deepseek/harness/
        ├── DshRuntime.kt        417 行   安装 / 起容器 / 抓 URL / 303 探针 / 自愈
        ├── DshService.kt        170 行   前台服务 / 通知 / WakeLock / START_STICKY
        ├── MainActivity.kt      238 行   WebView / cookie flush / 文件选择 / 下载
        ├── McpServer.kt         256 行   回环 MCP server（initialize/tools/list/tools/call）
        └── HarnessAccessibilityService.kt 154 行   手势 / 截图 / 节点树
dsh-profile/
└── mcp-android.overlay.yml                DSH 侧一条 mcp-client 配置
tools/
└── typecheck-kotlin.sh                   无 SDK、无 Gradle 的 Kotlin 类型检查
m0/
├── M0_实测报告.md                         设备上的实测数据
└── verify-dsh-web.sh                     端到端验证脚本（已实跑通过）
移植评估_OperitTerminalCore.md             可复用资产盘点
Operit-main/terminal/                     OperitTerminalCore@master（68 文件 / 68 MB）
```

---

## 已验证

| 项 | 结果 | 证据 |
|---|---|---|
| DSH 在 Android PRoot 里能装 | 613 包 / 2~3 分钟 / exit 0 | `dsh --version` → 0.2.1-rc.2 |
| Node 版本满足要求 | v24.19.0（需 `^22.19.0 \|\| >=24`） | 设备实测 |
| node-pty 可用 | 包内预编译 `prebuilds/linux-arm64/pty.node`，实测 `PTY_OK` | 不需要 build-essential |
| 裸 origin 不可用 | `GET /` → **401** | 容器内 + Android shell 双向验证 |
| 授权 URL 可用 | `<token URL>` → **303 + Set-Cookie** → 200 / 37,512 B | `m0/verify-dsh-web.sh` |
| 容器 loopback == 宿主 loopback | Android 侧 curl 容器端口 → 401（通） | 无需端口转发 |
| 冷启动 | 约 45 秒；RSS 约 411 MB | 设备实测 |
| **Kotlin 源码可编译** | 11 文件 / 74 个 class / rc=0 | Kotlin 2.0.21 + android.jar API35 + androidx + nanohttpd |
| **APK 由 GitHub Actions 云构建** | 191,441,199 B，artifact 可下载 | `kai6666666/deepseek-harness` + `.github/workflows/android.yml` |
| **真机安装** | `pm install -r` Success（同签名可覆盖升级） | 固定 keystore `app/keystore/dsh.jks` |
| **App 内解层** | layer0 15 s + layer1 43 s（从 APK assets 拷到 filesDir 后解） | `Log.i` + `run-as` 交叉核对，rootfs 1.3 GiB |
| **App 内跑通 proot** | `proot -V` → 3.3.0；`node -v` → v24.19.0 | `DshRuntime: spawn: …/bin/proot -0 -r …` |
| **App 内 dsh web 起来** | `READY http://127.0.0.1:3080/?token=…`，spawn→READY 约 39 秒 | logcat `DshRuntime` |
| **授权链路在真机成立** | token URL → **303**，裸 origin → **401** | Android shell curl 打到 app 起的 3080 |
| **WebView 真的渲染出来了** | `onPageFinished http://127.0.0.1:3080/ title=DeepSeek Harness` | logcat `DshWebView`（debug 包已开远程调试） |
| **回环 MCP 桥可用** | `initialize` / `tools/list` / `tools/call selfcheck` 全通，10 个工具在册 | curl POST `127.0.0.1:8765/mcp` |
| **DSH 侧 mcp-client 真连上了** | `initialize from dsh-mcp-client proto=2025-11-25` → `client initialized` → `tools/list -> 10 tools` | 容器内 `dsh web --patch /root/mcp-android.overlay.yml`，日志来自宿主 McpServer |
| **息屏也能装完** | 屏幕全黑状态下 3 分 38 秒完成解层+起服务（WakeLock 生效） | 22:33:39 → 22:37:17 |

---

## 真机踩出来的五个坑（都已修，写在这里省下重踩）

| 症状 | 真因 | 修法 |
|---|---|---|
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | CI 每次重建都生成新的 `debug.keystore`，签名不一致 | 仓库内固定 `app/keystore/dsh.jks`，debug/release 都用它 |
| `proot error: can't create temporary directory: Permission denied` | 没设 `PROOT_TMP_DIR`；proot 默认往 `/tmp` 写 glue rootfs | `PROOT_TMP_DIR=files/tmp`、`PROOT_LOADER=bin/loader`、`TMPDIR=files/tmp` |
| `镜像解压失败 exit=1`（无任何输出） | 解压后 `mv` / `rm` / `ln` 在 app 的 shell 环境里静默失败 | 删/改名/建软链全部改 Kotlin：`deleteRecursively` / `renameTo` / `Os.symlink`，shell 只负责 `busybox tar xf` |
| 首装「卡住」十几分钟 | 屏幕熄灭进 Doze，安装协程被冻住；WakeLock 只在 READY/STARTING 时持有 | WakeLock 覆盖 INSTALLING/STARTING/READY 全阶段 |
| 升级 APK 后 `Cannot run program …/bin/proot: error=2` | `nativeLibraryDir` 带安装路径哈希，升级后整段变了，旧软链指向已删除目录 | `bin/` 软链改成**每次启动都重建**（`ensureBinLinks()` 放进 runCycle），不只在首次安装时建 |

---

## 已知缺口

1. **模型侧的自动调用还没跑**：工具已注册进 DSH（`tools/list -> 10 tools`），但让模型自己决定去调
   `mcp__android__screenshot` 需要先配模型凭据、开一次会话；这一步只能在 UI 里点，没有 CLI 旁路。
2. **WebView 渲染未经人工目视确认**：本机屏幕被系统锁屏挡住，只能用 `onPageFinished` 日志 + HTTP 303 交叉验证。
   已开 `WebView.setWebContentsDebuggingEnabled(true)`（debug 包），可 `chrome://inspect` 直连。
3. **Shizuku / Root 档未实跑**：本机没装 Shizuku、没有 root，`BackendRegistry` 会安全回落到无障碍档。
4. **悬浮球 / 状态条 / 首启向导**：代码已编译进 APK，界面交互尚未在真机上逐项点过。
5. **嵌套 proot 不可测**：本仓库的 proot 二进制链的是 Android `linker64`，
   在容器内执行会 `required file not found`；所以「容器里再开容器」这条路走不通。
6. **`/dev/*` 设备节点**：proot 下无法 `mknod`，安装时用 `--exclude` 挡掉并在 guest 内预建挂载点；
   运行期把宿主 `/dev/null` 等按需 bind 进去。

---

## 构建（PC）

```bash
# 需要 JDK 17 + Android SDK（platform 36 + build-tools 36）
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

本机（无 SDK）只能做类型检查：

```bash
bash tools/typecheck-kotlin.sh
# TYPE CHECK OK · classes=19
```

---

## 关键实现决策（都有实测依据）

| 决策 | 依据 |
|---|---|
| `minSdk = 30` | DSH web 是 Vite 6 + React 18 产物（ES2022），Android 8 的旧 WebView 会白屏 |
| `targetSdk = 34` + `useLegacyPackaging` | Operit 同款；靠 `nativeLibraryDir` 拿可执行位，而不是降 targetSdk 绕 seccomp |
| 必须解析 stdout 拿 URL | 裸 origin 是 401；cookie 名带每安装随机后缀，无法预置 |
| `CookieManager.flush()` | cookie 是 `HttpOnly` + `SameSite=Strict` + 30 天，进程一死就丢 |
| 303 当健康检查 | `operit-health.json` 的既有约定：`{"ok":true,"statusCode":303}` |
| 端口 3080~3090 探测 | 设备上 3080 常被别的实例占用（实测有 3081 的实例在跑） |
| 假 `/proc` 文件补齐 | proot 下 `/proc/stat` 等缺失会让 node/npm 直接崩 |
| `LD_LIBRARY_PATH` 清空 | 否则 proot 会去加载 Android 自带 libc |
| `specialUse` 前台服务 | targetSdk 34 不声明类型，`startForeground` 直接抛异常 |

---

## 许可

宿主代码：随项目。`jniLibs/` 与 rootfs 资产来自
[OperitTerminalCore](https://github.com/AAswordman/OperitTerminalCore)，遵循其 LICENSE。