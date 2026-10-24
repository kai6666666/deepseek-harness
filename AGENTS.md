# AGENTS.md — DSH Android 客户端

原生 Android App：内置 Termux 环境跑一个 Node，在 Node 上跑 DSH 引擎，然后用 WebView
加载 DSH 自带的 Web GUI。**不自绘聊天界面**——UI 完全复用官方前端，只在窄屏下由内置插件
做移动端适配。

> ⚠️ **本文件只放「每次动手前必须知道」的东西**（硬约束 + 构建 + 索引）。
> 具体某一处的来龙去脉、踩过的坑、验收数据，全在 [`docs/agents/`](docs/agents/README.md)。
> **不要整份读那个目录**，按目录里的索引检索你需要的那一篇。

```powershell
.\gradlew.bat :app:assembleSystemDebug --console=plain   # → app\build\outputs\apk\system\debug\app-system-debug.apk
.\gradlew.bat :app:assembleGeckoDebug  --console=plain   # → app\build\outputs\apk\gecko\debug\app-gecko-debug.apk
```

## 两条硬约束（改动前必读，改错不报错但真机必炸）

### ① 包名必须恰好 15 字符

`applicationId` / `namespace` = `com.dsh.android`（15 字符）。

Termux 官方二进制把 `/data/data/com.termux/files`（27 字节）烤进 ELF 的 `.dynstr`，
`TermuxBootstrap.patchElfInPlace()` 只能做**等长原地覆盖**，替换串
`/data/data/<包名>/` = 12 + N 字节，等于 27 ⇒ **N = 15**。

长度不等时该函数直接 `return 0` **静默跳过**，不抛异常；症状是运行时
`CANNOT LINK EXECUTABLE` 或 `dpkg: Permission denied`。改包名必须同步改
`TermuxBootstrap.ELF_ROOT_REPLACEMENT`，两处字符数必须一致。

> `app/build.gradle.kts` 注释里提到的 `termux-kit/tools/verify-kit.ps1` **不在本仓库**，
> 不必去找。校验方式就是数字符。

### ② targetSdk 必须 ≤ 28

**不能升到 29+。** Android 10（API 29）起，targetSdk ≥ 29 的应用不允许 `execve()`
自身私有目录里的文件（W^X / SELinux `untrusted_app` 域禁止 `app_data_file`
`execute_no_trans`），而 node / bash / dpkg 全都装在 `filesDir` 下的 `$PREFIX` 里，
一升级就全线 Permission denied。Termux 官方 App 同样停在 28。

**代价**：只能侧载，无法上架 Google Play。

## 构建

```powershell
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-17.0.19.10-hotspot"   # 必须显式设

.\gradlew.bat :app:assembleSystemDebug --console=plain
.\gradlew.bat :app:assembleGeckoDebug --console=plain
.\gradlew.bat :app:assembleDebug --console=plain   # 两个都出
```

环境：AGP 8.8.2 / Kotlin 2.0.21 / Gradle 8.13 / JDK 17 / compileSdk 35 / minSdk 26。
工程路径含中文，靠 `gradle.properties` 里的 `android.overridePathCheck=true` 放行，别删。
构建需经代理（`127.0.0.1:7897`）。

**「构建成功」不等于「改动生效」。** 装完用日志确认（TAG 恒为 `DSH`）：

```powershell
adb install -r app\build\outputs\apk\system\debug\app-system-debug.apk
adb logcat -c ; adb shell am start -n com.dsh.android/.MainActivity
adb logcat -d -s DSH:I     # 引擎就绪 / 界面加载完成 / 各 ensureXxx 的落盘行
```

## 目录结构（速查）

运行期都在 `filesDir` 下。改动涉及这几个位置时最容易出错，**先看对应分册**：

| 位置 | 是什么 |
|---|---|
| `usr/` | `$PREFIX`，Termux 环境（含 `bin/node`、`bin/pnpm`） |
| `engine/` | 引擎解包目录（含 `.stamp` 版本戳） |
| `home/.dsh/` | `DSH_HOME`：配置、凭据、会话、`profiles/web/` |
| 　`mobile-ui/`、`shell-tool/`、`bubble-tool/`、`logs-tool/` … | 内置插件，**刻意放在 pnpm 管辖之外** |
| 　`node_modules/dsh-core-memory/`、`node_modules/dsh-preset-razor/` | **唯二**走 profile bundle 的内置包，可在「插件 → 已安装插件」里单独开关 |
| `logs/` | `app.log` / `engine.log` / `events.jsonl` / `crash/` / `export/` |

## 索引：`docs/agents/`

按「你要改什么」查，不按编号背。

### 硬约束与平台适配（踩坑密度最高，改任何 native/子进程相关先看）

| 文档 | 什么时候看 |
|---|---|
| [platform-android.md](docs/agents/platform-android.md) | 起点：为什么 `process.platform === 'android'` 会让官方代码全线失效 |
| [link-compat.md](docs/agents/link-compat.md) | `write` 工具报 `EACCES/EINVAL: link ...`；要动 `LD_PRELOAD` 时 |
| [sandbox.md](docs/agents/sandbox.md) | `bash` 工具报 "no sandbox backend is usable"；改 `runnerCommand` 时 |
| [ripgrep.md](docs/agents/ripgrep.md) | `grep`/`glob` 报 ripgrep launch failed |
| [sharp.md](docs/agents/sharp.md) | 图片附件发送失败（`agent-busy`） |
| [attachment-fsync.md](docs/agents/attachment-fsync.md) | 同上症状，但根因是 fsync 到 `/` |
| [node-pty.md](docs/agents/node-pty.md) | 侧栏终端打不开 |
| [directory-picker.md](docs/agents/directory-picker.md) | 工作区选择器看不到手机文件夹 |
| [pnpm.md](docs/agents/pnpm.md) | `spawn pnpm ENOENT`；插件被挪进 `.ignored/`；**为什么要用 11 不是 12** |
| [node-selfheal.md](docs/agents/node-selfheal.md) | `magic_number_ == kMagicNumber`；`$PREFIX` 并发写 |

### WebView / 前端

| 文档 | 什么时候看 |
|---|---|
| [webview-basics.md](docs/agents/webview-basics.md) | 选文件无反应、下载"成功"但没文件 |
| [webview-gecko.md](docs/agents/webview-gecko.md) | 改 gecko flavor、bridge、`exportFunction` |
| [webview-compat.md](docs/agents/webview-compat.md) | 旧内核白屏；要动降级编译流程 |
| [mobile-ui.md](docs/agents/mobile-ui.md) | 改移动端布局/样式、别名桥接、`+` 菜单时序 |

### 会话与引擎

| 文档 | 什么时候看 |
|---|---|
| [session-repair.md](docs/agents/session-repair.md) | 某会话**永久**发不出消息 / 从列表消失 |
| [rescue-mode.md](docs/agents/rescue-mode.md) | 插件改坏导致 App 打不开（体检 + 安全模式） |
| [logging.md](docs/agents/logging.md) | 要定位线上问题、改日志/诊断包/脱敏 |
| [keep-alive.md](docs/agents/keep-alive.md) | 切后台就断、通知栏状态、键盘遮挡输入框 |
| [web-port.md](docs/agents/web-port.md) | 3080 被占用 |

### 内置能力（这些是**产品功能**，不是适配层）

| 文档 | 什么时候看 |
|---|---|
| [shell-tool.md](docs/agents/shell-tool.md) | uid 2000 执行通道：adb 签名、密钥来源、18 条缺陷、验收 |
| [bubble.md](docs/agents/bubble.md) | 悬浮球本体、交互契约、窗口/拖动陷阱 |
| [bubble-bridge.md](docs/agents/bubble-bridge.md) | 悬浮窗外观字段、桥方法、转录通道 |
| [bubble-tool.md](docs/agents/bubble-tool.md) | `bubble` 工具（模型自己改悬浮窗） |
| [pet-bridge.md](docs/agents/pet-bridge.md) | 桌面宠物、状态→动作映射 |
| [ui-tool.md](docs/agents/ui-tool.md) | `ui` 工具：坐标系、遮挡/屏幕外/面板三类误判、持久化状态 |
| [key-pool.md](docs/agents/key-pool.md) | 内置号池、TLS 层注入、**必须降级 HTTP/1.1** |
| [plugin-source.md](docs/agents/plugin-source.md) | 「添加插件」少了 npm 官方源 |

### 构建 / 资产 / 发布

| 文档 | 什么时候看 |
|---|---|
| [build-and-ship.md](docs/agents/build-and-ship.md) | release 签名、两个 flavor、夸克网盘发布与版本整理 |
| [asset-stamps.md](docs/agents/asset-stamps.md) | **改了任何 `.zip` / `.bin` 资产都必须看**：漏改版本戳 = 静默不生效 |
| [regen-assets.md](docs/agents/regen-assets.md) | 从零重建某个资产 |
| [boundaries.md](docs/agents/boundaries.md) | 明确不做 / 做不到的事 |
| [desktop-relation.md](docs/agents/desktop-relation.md) | 与桌面端共用哪些、各管哪些 |
| [debug-device.md](docs/agents/debug-device.md) | adb 基本手法 |

## 三条最容易违反的规矩

1. **改了资产必须同步改版本戳** —— 否则老标记仍在、解包被跳过，新资产永不生效。
   清单见 [asset-stamps.md](docs/agents/asset-stamps.md)。**这个失败是完全静默的。**
2. **`assets/*.zip` 没有打包脚本，全是手打的** —— 改完源码必须**逐 zip 与源目录做字节比对**，
   不能靠"我记得打过了"。踩过一次六个里漏一个，从"改了哪几个文件"看不出来。
3. **不要为了"修"报错去升 `targetSdk` / 改包名** —— 那是硬约束①②，升了就全线崩，
   而且报错信息不会指向真正的原因。
