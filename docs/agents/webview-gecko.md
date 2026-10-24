# ⑦.7 内置 Web 内核版（gecko flavor）

> 本文是 [AGENTS.md](../../AGENTS.md) 的分册之一，
索引见 [docs/agents/README.md](README.md)。

### ⑦.7 内置 Web 内核版（productFlavor `gecko`）—— 不依赖系统 WebView

同一个工程出**两个可共存的 APK**：

| flavor | applicationId | Web 内核 | 说明 |
|---|---|---|---|
| `system` | `com.dsh.android` | 设备系统 WebView | 原有行为，**一字未改** |
| `gecko` | `com.dsh.webview` | 打进 APK 的 GeckoView | 新增，不依赖系统 WebView |

```powershell
.\gradlew.bat :app:assembleSystemDebug   # app\build\outputs\apk\system\debug\app-system-debug.apk
.\gradlew.bat :app:assembleGeckoDebug    # app\build\outputs\apk\gecko\debug\app-gecko-debug.apk
.\gradlew.bat :app:assembleDebug         # 两个都出
```

⚠️ **第二个包名必须也恰好 15 字符**（硬约束①）：`com.dsh.webview` = 15 ✅。
`TermuxBootstrap.ELF_ROOT_REPLACEMENT` 已改成**从 `BuildConfig.APPLICATION_ID` 推导**，
所以两个 flavor 各自把 ELF 里的 `/data/data/...` 改写成**自己的**私有目录 ——
写死的话另一个 flavor 会把二进制改成别的应用的路径，必炸。

⚠️ **两个包的数据目录互相独立**：会话、凭据、工作区**不共享**。这是共存的代价。

⚠️ **内核实现必须放在 flavor 源集里**（`app/src/system/java`、`app/src/gecko/java`），
**不能放 `main`** —— `GeckoWebHost` 引用 `org.mozilla.geckoview.*`，而该依赖只挂在
`geckoImplementation` 上，放 `main` 会让 system flavor 编译不过。

#### 为什么是 GeckoView，以及为什么是 140

- 唯一有**官方预编译 Maven 产物**的可嵌入内核。腾讯 X5/TBS 的**内核是运行时下载的**，
  违背「内置」这一条。
- **157 / 146 用不了**：它们的传递依赖要 AGP 9.1.0（`androidx.core:core:1.19.0`）
  与 compileSdk 36（`media3:1.11.0`），当前 AGP 8.8.2 / compileSdk 35 接不住。
  升 AGP 是另一件事，本轮没做。**140.0.20250707120347** 可用。
- 仓库要加 Mozilla 的 maven（`settings.gradle.kts`，限定 group 免得拖慢解析）：
  `https://maven.mozilla.org/maven2/`。

#### GeckoView 与 WebView 的 API 差异（写代码前必读）

| 能力 | WebView | GeckoView |
|---|---|---|
| 注入 JS 到页面 | `evaluateJavascript` | **没有**；必须 `pageWindow.eval(源码)` |
| JS ↔ 原生 | `addJavascriptInterface` | **没有**；走 WebExtension native messaging |
| console 转发 | `onConsoleMessage` | **没有**；在页面世界包 `console.*` |
| 下载 | `setDownloadListener` | **没有**；见下 |
| 读 cookie | `CookieManager.getCookie` | **没有 API**（只有 cookie 横幅那几个方法） |
| targetSdk 依赖 | 内核随系统 | **不依赖**，与系统 WebView 版本无关 |

所以 `main` 里的宿主只认 `WebHost` 接口（`app/src/main/java/com/dsh/android/web/WebHost.kt`），
两个 flavor 各给一份实现。

#### 桥（bridge）的实现要点

- 扩展在 `app/src/gecko/assets/dsh-bridge/`（MV2，`manifest.json` + `content.js`，
  **没有 background**）。
- ⚠️ **GeckoView 不实现 `browser.tabs`**，所以 content script 必须**自己**
  `browser.runtime.connectNative('browser')`；manifest 的 permissions 要有
  `["nativeMessaging","nativeMessagingFromContent","geckoViewAddons"]`。
- ⚠️ 原生侧必须用 **`session.webExtensionController.setMessageDelegate(...)`**，
  不是 `extension.setMessageDelegate(...)` —— **content script 的消息只认前者**。
- ⚠️ **content script 跑在隔离世界**，往页面世界塞东西只有一条可行的路：

  ```js
  pageWindow.eval(源码字符串)(exportFunction(fn, pageWindow), …)
  ```
  | 写法 | 结果 |
  |---|---|
  | `pageWindow.DSHAndroid = {...}` | 页面读到的是 Xray wrapper，**Permission denied** |
  | `cloneInto(obj, pageWindow)` | `Permission denied to pass a Function via structured clone`（结构化克隆**不能传函数**） |
  | `exportFunction(fn, pageWindow)` | ✅（**第二个参数不能省**，省了抛 `Function requires at least 2 arguments`） |

  对象必须在**页面世界**构造（`eval` 那段源码），要调的原生函数以参数形式喂进去。
- ⚠️ `post()` 发出的消息 `type` **必须是 `'invoke'`**：原生按 `type` 分派，漏了不报错、
  **静默丢弃**，表现为「所有动作（含 onUiReady）都到不了原生」。
- ⚠️ 扩展 manifest 的 `version` **改了 `content.js` 就必须加**，否则 GeckoView 打
  `Addon with ID … already installed, older version will be disabled` 并**继续用旧包**。

#### 文件选择（⑦ 的 gecko 版）

⚠️ **必须返回一个未完成的 `GeckoResult<PromptResponse>`**。返回 `null` 不是「稍后再说」，
而是「本 delegate 不处理」—— 内核立刻按默认行为取消，此后 `prompt.confirm(...)` 的
结果**再也送不回内核**。真机症状：选择器能弹出，选完文件**永远不落进 Web**。

⚠️ `FilePrompt.confirm(Context, Uri[])` **只接受 `file://`**，给 `content://` 会报
`NS_ERROR_FILE_UNRECOGNIZED_PATH`（Mozilla bug 1591640 / 1875732）。
所以 `GeckoWebHost.toLocalFile()` 先把 `content://` **拷进 `cacheDir`** 再 confirm
（用 `cacheDir` 而不是 `filesDir`：这是一次性上传暂存，让系统能回收）。

真机验收：

```
文件选择请求（type=2，多选=true）
所选文件已落盘: 1791728591132--31edd527-w5.png（33375 字节，源 content://…）
文件选择完成：1 个（已落盘到本地）
```

#### 下载（⑦.5 的 gecko 版）—— 踩了两条死路才找到正解

`/api/session.export` 是**纯 cookie 鉴权**，而 GeckoView **没有任何读 cookie 的 API**，
cookie 存在内核自己的 `files/mozilla/<profile>/cookies.sqlite` 里、**不写进** WebView
的 cookie jar。于是：

| 路 | 结果 |
|---|---|
| 页面报 URL → **宿主**用 `HttpURLConnection` 代发 | **必然 401**（宿主持不到 cookie） |
| 页面报 URL → 用 `GeckoSession.Loader` 让**内核**发导航 | **真机 403 forbidden**，且**错误页把整个 GUI 顶掉了** |
| ✅ 在**页面世界**用 `fetch` 拉，base64 分块经桥回传 | 通 |

第二条路的两个教训要记住：
1. 引擎的准入检查（`dsh-client-connection` 的 `isTrustedApiRequest`，看
   host / `sec-fetch-site` / `origin`）对**原生发起的导航**与**页面发起的 fetch**
   给的不是同一组取值，前者会被判 403；
2. **任何非 attachment 的响应都会被内核当主文档渲染** —— 一次失败就把界面顶掉，
   比功能不可用严重得多。

第三条路之所以对：**与 GUI 平时调 API 完全同源同头**，且响应是数据不是导航，
失败最多是一次 fetch 报错。

⚠️ 分块消息**每条都自带 url 与文件名**，不另发「开始」消息 —— 单独的开场消息被
内核 messaging 拒过一次（logcat 只有 `Invalid event data property args`，原生收不到，
而分块本身能通），结果是分块到了却没有进行中的下载、整批丢弃。

⚠️ 落盘由宿主做（`callbacks.onDownloadStream(DownloadStream(url, filename, body))`），
内核侧不碰文件系统；`MainActivity.handleDownloadStream()` 在 IO 线程读流写文件。

#### ⚠️ 三个「静默炸掉整个文件」的注释陷阱（都踩过，且症状极难查）

1. **Kotlin 块注释会嵌套**：KDoc 里写 `files/mozilla/*/cookies.sqlite`、`/api/*`
   会打开一个嵌套注释，**吞掉文件后半段**，报一连串莫名其妙的
   `Unresolved reference`（`WebHostCallbacks`、`DownloadStream`、`GECKO_MAJOR`…）
   外加 `Unclosed comment`。**提到路径一律用 `「」` 包裹**。
2. **JS 的 `//` 注释里出现 `/*`**（例如写 `/api/*`）同样提前闭合块注释，
   症状是 **content script 整体不执行**。
3. **模板字符串里出现反引号**（`PAGE_SHIM_SOURCE` / `BRIDGE_INSTALLER_SOURCE` 的内容）
   会**提前终止模板**，症状同样是 content script 完全不执行。

三者都**不会被 `node --check` 全部抓到**（第 3 种的典型表现是 `node --check` 通过、
运行时整个脚本站点级失效）。诊断依据永远是 logcat 里的
`W Web Content: [JavaScript Error: ...]` **和** `E GeckoConsole`（DSH tag 下看不到）。
建议的机械校验：见 `tools/scan-bridge.js`（扫注释里的 `/*` 与模板内的反引号）。

