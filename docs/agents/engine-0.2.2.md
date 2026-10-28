# 引擎 0.2.1-rc.3 → 0.2.2-alpha.2 适配记录

> 目标：先证伪、再打包、后上机；任何一步失败都能退回 rc.3。
> 本文只记录**已经做过并拿到回执**的步骤，推测不写进来。

---

## 阶段 1：旁路试跑（2026-10-28）✅

### 1.1 取包与版本

```text
源码树  /storage/emulated/0/MT2/apks/deepseek harness/deepseek-harness-dsh-v0.2.2-alpha.2  192 MB
版本    package.json → "0.2.2-alpha.2"
安装    /opt/dsh022  npm i @deepseek-ai/dsh@0.2.2-alpha.2 --ignore-scripts
        registry=npmmirror，added 653 packages in 8m，node_modules 927 MB
Node    Ubuntu 侧 v24.19.0；设备 Termux 侧 v26.12.1（新要求 ≥24.9，均满足）
```

### 1.2 五个文本锚点（`tools/check-engine-anchors.mjs`）

```text
== 引擎目录: /opt/dsh022
✅ flock-platform      node_modules/@deepseek-ai/node-addon-system/lib/flock.js
✅ fail-loud-app-boot  node_modules/@deepseek-ai/dsh-app-boot/lib/index.js
✅ fail-loud-release   node_modules/@deepseek-ai/dsh/lib/profile-boot-e2mS45fC.js   ← 文件名 hash 变了，脚本按前缀扫，正常
✅ terminal-shell      node_modules/@deepseek-ai/dsh-terminal-bash/lib/index.js
✅ attachment-fsync    node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js
exit=0
```

**结论：App 侧 5 处文本补丁的锚点在 alpha.2 全部仍在，EngineManager 不需要改锚点。**

### 1.3 Ubuntu 侧冷启动

```bash
DSH_HOME=/tmp/dsh022home HOME=/tmp/dsh022home \
  node node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --no-open --port 3085
```

```text
http=401        ← 服务起来了，要 token
/tmp/dsh022home/profiles/web/{cordis.yml,package.json,pnpm-workspace.yaml} 已生成
```

### 1.4 设备侧旁路启动（关键一步）

直接把 x64 的 node_modules 搬上手机是跑不起来的 —— 第一轮就撞了：

```text
Cannot find module '.../node-addon-require-builtin/build/napi/napi-v9-android-arm64/require_builtin.node'
  at tryRequireLocal (node-addon-native-custom-loader/lib/index.js)
```

npm 在 x64 上只装了 linux-x64 的可选包，android-arm64 那份没有。补四样东西后启动成功：

```text
从现网 files/engine/node_modules 复制到 files/engine022/node_modules：
  node-addon-require-builtin/build/            （android arm64 napi 产物）
  node-addon-require-builtin-android-arm64/
  @deepseek-ai/node-addon-system-android-arm64/
  node-pty/                                     （含 prebuilds/android-arm64/pty.node）
```

启动命令（与 App 同款 env，端口错开）：

```bash
cd files/engine022
HOME=$R/home DSH_HOME=$R/home/.dsh022 PREFIX=$R/termux/usr \
PATH=$R/termux/usr/bin:$PATH TMPDIR=$R/tmp022 \
  $R/termux/usr/bin/node node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile web --no-open --port 3086
```

回执：

```text
http=401
dsh web: http://127.0.0.1:3086/?token=aKmvsigabbShXwcYu93PBNdN4JrXiVRbfguVrI7OhNc
```

**结论：0.2.2-alpha.2 在 Android arm64 + 我们自带 Node 运行时上能起来（不含 App 的 patch 层）。**

### 1.5 阶段 1 的边界（别误读）

| 已验证 | 未验证 |
|---|---|
| 包完整性、5 个锚点、Ubuntu 冷启动、设备旁路冷启动 | 7 个插件能否 load、App 的 `--patch` 层是否兼容、UI 是否还认旧类名 |
| Node 版本门槛满足 | 0.2.2 官方新增的手机行为与我们插件的重叠面 |

旁路目录 `files/engine022/`（927 MB）先留着做阶段 3；确认不需要后整目录删。

---

## 阶段 2：App 侧补丁 ✅

### 2.1 `requiredStartupEntryIds` 从 4 项扩到 10 项

```text
0.2.2-alpha.2 官方集合（dsh-app-boot/lib/index.js:4324）：
  agent-loop, tool-executor-native, tool-executor-ptc, webserver,
  web-runtime, modules, connection, headless-runner, acp, sdk-jsonrpc-server
App 侧旧副本只有前 4 项里的 4 个（agent-loop/webserver/modules/connection）
→ 已同步为 10 项。少列只影响体检“少报”，不会误伤，但升级后应同源。
```

### 2.2 版本戳

```text
MainActivity.assetStamp  0.2.1-rc.2-1 → 0.2.2-alpha.2-1
```

---

## 阶段 3：插件兼容 ✅

旁路 profile 挂 10 个插件（`--patch mount.patch.yml`，全部 `file://` 绝对路径）：

```bash
node .../bin.js --profile web --patch $DSH_HOME/mount.patch.yml --no-open --port 3086
```

回执：

```text
http=401
dsh-android-pet: 状态桥已启动: .../.dsh022/bubble-state.json
dsh web: http://127.0.0.1:3086/?token=…
```

`--dump-config` 里 10 个 id 全部在（45926 字节的合成配置）：

```text
dsh-android-browser dsh-android-browser-pane dsh-android-bubble dsh-android-logs
dsh-android-mobile dsh-android-pet dsh-android-root dsh-android-shell
dsh-android-statusbar dsh-android-uiagent
```

客户端插件也真的被打包并 served：

```text
GET /plugins/??dsh-android-mobile/client.js&rev=…  → 200, 446,030 B
内容含 mp-nav-btn ×10      ← 说明 0.2.2 的 client 插件管线接受了我们的 client.js
页面 bundle：assets/index--TtJvO-i.js 964 KB（200）
```

⚠️ 踩到的坑：`--patch` 必须写在 **app 参数之前**。`bin.js --profile web --no-open --port 3086 --patch x`
会把 `--patch` 当 web app 的参数 → `error: unknown option '--patch'`。正确：
`--profile web --patch x --no-open --port 3086`。

---

## 阶段 4：UI 回归（待做，需装机态）

引擎单独跑没有 App 外壳（安全区、WebView 桥、mobile-ui 的 data-mobile 判定），
必须出包后在真机跑 `urc3.mjs` 六条。预期风险：类名哈希重算、`PanelMoreMenu` 多了
`Tooltip` 包装、右侧栏标签结构变化。

---

## 阶段 5：CI 出包（进行中）

为让 CI 现场构建 0.2.2 资产，改了 6 处硬编码：

| 文件 | 改动 |
|---|---|
| `.github/workflows/apk.yml` | `VER=0.2.1-rc.3` → `0.2.2-alpha.2`；webview 兼容 `--engine /tmp/dsh-engine-0.2.2-alpha.2` |
| `tools/build-node-pty.sh` | `ENGINE_DIR` 默认值 → 0.2.2-alpha.2 |
| `tools/build-node-addon-system.sh` | 同上 |
| `tools/build_webview_compat.py` | `--engine` 默认值 → 0.2.2-alpha.2 |
| `tools/provision-glibc-host.sh` | `DSH_VER` 默认值 → 0.2.2-alpha.2 |
| `MainActivity.kt` | `assetStamp = 0.2.2-alpha.2-1` |

资产不走 Release（仓库没有 `ASSETS_RELEASE` 变量）→ CI 会现场 `npm i` 并打包 engine.bin。

### 5.1 首次尝鲜包（40684120518）上机暴露的两个问题

**问题 A：体检误判 bundle 损坏 → 反复重解包 + 隔离用户配置**

```text
App 日志：启动前体检：核心条目缺失 headless-runner, acp, sdk-jsonrpc-server
         → 核心 bundle 损坏，正在重新解包 engine/
         → 已隔离损坏的文件 cordis.patch.yml → cordis.patch.yml.bak-1793190494597
```

根因：我把 App 侧 `REQUIRED_ENTRY_IDS` 从 4 项扩到官方的 10 项，但两份清单语义不同：

| 清单 | 语义 |
|---|---|
| 官方 `requiredStartupEntryIds` | **这些条目如果激活失败** → 抛 StartupError（条目没挂载不算失败） |
| App 体检 | **合成配置里必须存在这个 id** |

0.2.2 的 web profile 本来就不挂 `headless-runner / acp / sdk-jsonrpc-server`，于是每次启动都判损坏。
→ 已回退为 4 项，并把这段陷阱写进常量注释。

**问题 B：`require_builtin.node` 找不到（引擎根本起不来）**

```text
Cannot find module '.../node-addon-require-builtin/build/napi/napi-v9-android-arm64/require_builtin.node'
```

0.2.2 的 `node-addon-native-custom-loader` **先找包内 `build/napi/<tag>/`**，找不到才退平台包；
而 `engine.bin` 里没有 `build/` 目录（那是 CI 用 NDK 单独产出、装到平台包里的）。
→ `ensureNativeAddon()` 增加一步：把平台包的 `prebuilt/android-arm64-napi-v9.node`
再复制一份到 `node-addon-require-builtin/build/napi/napi-v9-android-arm64/require_builtin.node`。

### 5.2 待复跑

修好后重新出包 → 装机 → 确认 `engine.log` 出现 `引擎就绪`、`http=200`，再跑 `urc3.mjs` 六条。

### 5.3 第二次出包：6 PASS（0.2.2-alpha.2 装机态）

```text
APK 40688235981 / 9f2b1215 / success
engine.bin 0.2.2-alpha.2  解包 61,174 条目 / 54,100 文件 / 430,317,442 字节（MANIFEST 对账通过）
```

启动：`engine.ready ms=24025 port=3080`，`Web 界面加载完成`，`插件已激活（onUiReady）`。

`urc3.mjs` 六条：

```text
[PASS] PREFLIGHT
[PASS] D 会话视图「更多」不越界 — 复制会话为 Markdown[171,58 167x30] 下载 Session 日志[171,88]
                                  反馈[171,118] 刷新[171,148]；视口内=YES；抽屉=未动
[PASS] R 右栏「更多」→创建插件收右栏 — 右栏已收起；主区发送键=有
[PASS] F 开菜单不收起抽屉 — drawer 恒 8,8,8；三帧 menu 项 2/2/2
[PASS] E 点菜单项收起抽屉 — 「浏览更多插件」→ drawer=-330,-330,-330
[PASS] G 点遮罩收起抽屉且菜单不复活 — drawer=-330,-330,-330；menuitem=0

结果：6 PASS / 0 FAIL / 0 SKIP → 退出码 0
```

0.2.2 带来的 UI 差异（都只影响断言细节，不影响插件逻辑）：

| 差异 | 处理 |
|---|---|
| 会话「更多操作」多了一项「复制会话为 Markdown」，菜单首次展开变慢（1.2~1.6s） | `urc3.mjs` D 段改为 1.4s + 一次 0.9s 重试 |
| 抽屉展开后行 x 从 14 变 8（新布局 padding） | 断言本来就是“展开后帧间不变”，无需改 |
| `PanelMoreMenu` 多了 `Tooltip` 包装 | 左栏 F/E/G 全部照常通过 |

### 5.4 收尾

- 旁路目录 `files/engine022`（927 MB）与 `.dsh022` 已删除；回滚包保留 `nW` + `dshW2.apk`。
- 待做：dev-env 六组、bubble、uiagent 等非 UI 功能的冒烟（引擎换版后尚未逐项跑）。
