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
| **Kotlin 源码可编译** | 5 文件 / 31 个 class / rc=0 | Kotlin 2.0.21 + android.jar API36 + androidx + nanohttpd |
| **镜像自带 node+dsh 能启服务** | `dsh web` 打出 token URL；origin=401、token=303 | 用镜像内的 node 24.19.0 + dsh 0.2.1-rc.2 实跑 |
| 叠层解压 | layer0 34 秒 + layer1 88 秒（从 sdcard 读） | 模拟装机全流程 |

---

## 未验证（下一步）

1. **真机安装运行**：本机是 arm64，Android build-tools 的 `aapt2` 只有 x86_64 Linux 版，
   出 APK 必须在 PC 上 `./gradlew assembleDebug`。源码已通过类型检查，但没打过包。
2. **rootfs 安装链路**：`install()` 的解压/软链/假 proc 文件是在设备外用 bash 复现的，
   没有在 App 沙箱里真跑过（沙箱内 `filesDir` 的 exec 位、`nativeLibraryDir` 软链需实测）。
3. **`/dev/*` 设备节点解不出来**：proot 下无法 `mknod`，tar 会报错退出。
   `install()` 已用 `--exclude='ubuntu-noble-aarch64/dev/*' || true` 挡掉，并由 `test` 断言保底；
   真机仍建议跑一遍确认。
4. **MCP 桥**：`mcp__android__*` 尚未实现（Operit 的 `MCPLocalServer` + `ToolRegistration` 是现成料）。
5. **悬浮窗外壳**：Operit 的 `FloatingWindowManager.kt`(51 KB) 尚未移植。
6. **嵌套 proot 不可测**：本仓库的 proot 二进制链的是 Android `linker64`，
   在容器内执行会 `required file not found`；所以「容器里再开容器」这条路走不通，
   验证只能用镜像自带的 node 直接跑（已做）。

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