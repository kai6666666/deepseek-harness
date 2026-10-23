# DSH_0.3.4.apk 逆向与实机分析（对照我们的实现）

分析对象：`DSH_0.3.4.apk`（146,917,250 B）
方法：静态（mt_mcp 反编译 + assets 解包核对）+ 真机安装实跑（2026-10-23 23:49 冷启）
结论一句话：**它不用 PRoot**。把 Termux 用户态打进 APK，靠 `targetSdk=28` 保留的 `exec` 特权，直接从
`files/termux/usr/bin/node` 跑 DSH。

---

## 1. 基本身份

| 项 | 值 |
|---|---|
| 包名 / 版本 | `com.dsh.android` / versionName **0.3.4** / versionCode **30** |
| sdk | minSdk **26** / targetSdk **28** / compileSdk **35** |
| 签名 | 仅 V2，cert sha256 `ef6afe33…d9d3f385` |
| 组件 | `MainActivity`、`LogViewerActivity`、`EngineService`(specialUse)、`BubbleA11yService`、`AdbPairingReceiver`、`ShizukuProvider` |
| 额外权限 | `DUMP`、`INTERACT_ACROSS_USERS_FULL`、`RECORD_AUDIO`、`SYSTEM_ALERT_WINDOW` |
| dex | 1 个 / 9.6 MB / **7190 类** / 966 zip 条目 |

`targetSdk 28` 是关键：API 29+ 起 `untrusted_app` 域禁止 `exec` `app_data_file`；停在 28 就保留了
“私有目录里的二进制直接跑”这条 Termux 老路。

---

## 2. 资产清单（33 个 assets，逐个验过）

| 资产 | 大小 | 真实内容 |
|---|---|---|
| `engine.bin` | 57.7 MB | **gzip tar**：`node_modules/` 30,411 条、`@deepseek-ai/*` **304 包**、`dsh@0.2.1-rc.2`；npm **平铺**（无 `.pnpm`） |
| `node-runtime.bin` | 31.6 MB | ZIP：`bin/node`（**Node v26.4.0**，interp `/system/bin/linker64`）+ `libicu*78.3`、`libsqlite3 3.53.4`、`libcares`、`libffi` + `LINKS.txt` |
| `bootstrap-aarch64.zip` | 24.2 MB | **Termux bootstrap** 1819 条（apt/dpkg/termux-exec…） |
| `webview-compat.zip` | 9.7 MB | 降级版前端：覆盖 `dsh-web-frontend/dist` |
| `pnpm-android-arm64.zip` | 5.9 MB | 运行期装插件用 |
| `adb-wireless-arm64.zip` | 5.5 MB | `bin/adb` 3.5 MB |
| `mobile-ui.zip` | 256 KB | DSH 前端插件 `dsh-android-mobile`（`lib/client.js` 628 KB） |
| `node-pty…zip` / `sharp-wasm32.zip` / `ripgrep…zip` / `linkcompat.bin` | 小 | 原生模块补丁（运行期塞进 node_modules） |
| 12 个 `*-tool.zip` | 小 | DSH 插件（`package.json` + `lib/index.js`），解到 `$DSH_HOME/node_modules` 再写 overlay |

---

## 3. 目录布局与启动命令（smali 原文 + 实机日志双向确认）

```text
files/termux/usr/          ← Termux prefix（bootstrap 解这儿）
files/engine/node_modules/@deepseek-ai/dsh/lib/bin.js
files/home/                ← HOME
files/home/.dsh/           ← DSH_HOME（profiles / cordis.patch.yml / 插件）
files/workspace/           ← ProcessBuilder.directory()
```

`buildEngineArgs()` 拼出来的 argv：

```bash
<prefix>/bin/node <engine>/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile web --patch <a>.yml --patch <b>.yml … --port 0 --no-open
```

实机（12 条 overlay，端口 0 = 内核分配）：

```text
23:50:09.373 启动引擎: …/termux/usr/bin/node …/dsh/lib/bin.js --profile web --patch×12 --port 0 --no-open
23:50:17.633 [engine] dsh web: http://127.0.0.1:33959/?token=PF9P…
```

环境变量：`PREFIX`、`DSH_HOME`、`HOME`、`TMPDIR=cacheDir`、
`PATH=$PREFIX/bin:$PREFIX/bin/applets:/system/bin:/system/xbin`、`SSL_CERT_FILE=$PREFIX/etc/tls/cert.pem`。
**没有 `LD_LIBRARY_PATH`**——Termux 二进制带 `DT_RUNPATH=$ORIGIN/../lib`。

---

## 4. 实机首次启动耗时（冷启）

| 阶段 | 耗时 |
|---|---|
| Termux bootstrap 解包（24 MB） | **5.5 s** |
| engine.bin 解包（57.7 MB） | **12.2 s** |
| node 进程启动 → 打出 token URL | **8.26 s** |
| 应用启动 → 首帧（`Web 内核已提交首帧`） | **25 s** |
| 常驻内存 | node RSS **173 MB**，App 总 **330 MB** |

对照我们自己：安装 59 s（亮屏）+ spawn→READY 39 s，node RSS ≈ 411 MB。

---

## 5. `webview-compat.zip` 到底是什么（量化）

同文件名、内容不同、体积更大（未压缩重建）：

| 文件 | engine 原版 | compat 版 | 换行 |
|---|---|---|---|
| `assets/index-CN7NIWNw.js` | 939,867 | 1,241,787 | 191 → 18,955 |
| `assets/vendor-DcuzkuQH.js` | 741,114 | 883,634 | 411 → 11,945 |
| `assets/index-BxpfOGf3.css` | 77,343 | 91,840 | 1 → 3,932 |

语法差异（关键）：

| 语法 | engine | compat |
|---|---|---|
| `?.`（ES2020） | 377 / 126 | **0 / 9** |
| `??`（ES2020） | 725 / 63 | **1 / 34** |
| `__defProp`（esbuild 未 minify 标志） | 无 | **有** |

→ 同一份源码**用低 target 重建 + 关 minify**，把 `?.`/`??` 降级。旧 WebView（Chrome<80）解析 `?.`
会语法报错 → 白屏；这一步把白屏变可渲染。**我们 minSdk 30（WebView≥83）暂时不需要**，但把它作为
「minSdk 下探」的前置条件是必须的。

---

## 6. 崩溃策略

- 启动前先跑 `--dump-config` 预检组合，通过才真启动；
- `AUTO_SAFE_MODE_MIN_FAILURES = 3`：连续失败 3 次进安全模式；
- 状态落盘：`files/rescue/state.json`、`rescue/last-boot-failure.json`、`crashes/`、`engine-startup/`；
- 启动时写 `AGENTS.md` 告诉模型“当前层级 normal、inject=false”（降级态可解释）。

---

## 7. 特权通道（比我们狠的地方）

`dsh-android-shell.mjs`（111 KB）自研 ADB 协议客户端，给 bash 工具一个 uid 2000 身份：

| 命令 | app 域 | shell 域 |
|---|---|---|
| `screencap -p x.png` | rc=1、stderr 空、0 字节文件 | rc=0 真图 |
| `input keyevent 3` | rc=0 但屏幕不动 | 真生效 |
| `dumpsys battery` | rc=0 但 `Can't find service` | 完整 |

三条来源：**Shizuku → legacy 5555 → 无线调试（Android 11+ 配对，含 mDNS 发现）**。
踩坑记录：ADB 签名不是 `crypto.sign('sha1', token)`，AOSP 手工拼 PKCS#1 块、把 **token 原文**放进摘要槽。

---

## 8. 构建流水线

| 环节 | 证据 |
|---|---|
| Gradle **8.13** / AGP **8.8.2** / Kotlin **2.0.21** / Java 17 | `kotlin-tooling-metadata.json` + `app-metadata.properties` |
| 无 .git（`NO_VALID_GIT_FOUND`） | `META-INF/version-control-info.textproto` |
| 只签 V2 | 无 `META-INF/*.RSA` |
| 引擎/前端/原生产物各自构建后当 assets 塞入 | `engine.bin` 是 npm 平铺树；前端是独立 dist 重建；`node-pty` 等是预编译补丁包 |

**APK 只是分发容器，真正的构建在 APK 之外。**

---

## 9. 我们从它身上拿了什么 / 不拿什么

**已拿（本次提交）**

1. `--port 0` 交给内核 + 从 token URL 回读真实端口 → 不再抢 3080；
2. 启动前 `--dump-config` 组合预检 → 坏 overlay 直接报错，不再表现为“URL 超时”；
3. 连续失败 3 次进安全模式（`Phase.FAILED` + 完整错误），不再无限退避刷日志。

**不拿**

- `targetSdk 28`：它换到「免 PRoot 直跑 Termux 二进制」，我们换到「完整 Linux 用户态 + apt」。用户要求全量能力，这条不动。

**待议**

- `webview-compat` 降级前端（只在 minSdk 下探时必需）；
- `dsh-android-mobile` 式前端插件（移动端布局）；
- `dsh-android-shell` 的无线 ADB 配对通道（我们目前是五档后端 + 无障碍）。
