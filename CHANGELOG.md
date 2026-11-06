# 更新日志

本文件记录本项目所有值得注意的变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **关于版本号**：`versionName` 表达「对外是不是同一版」，`versionCode` 才保证
> 唯一性。历史上存在多个内容不同但 `versionName` 相同的构建（如 `0.2.9-rescue`
> 对应 vc 21/22/23），那期间靠 `versionCode` 区分。自 **0.3.0** 起引入新产品能力
> 时改前两位版本号。

> **versionCode 机器可读**：每个版本小节标题后第一行写 `vc=<数字>`，
> `sh tools/version.sh --check` 会校验「最新小节的 vc == build.gradle.kts 的 versionCode」
> 且「严格大于上一小节的 vc」。历史上 `0.2.9-rescue` 对应 vc 20/21/22/23，
> 正是靠 versionCode 区分同一 versionName 的不同构建。

---
## [0.4.7] — 2026-11-06
vc=44
### 修复
- **直接采用 DSH 官方侧栏入口**：rc.1 会话 header 已有官方
  `IW6AQa_iconButton`（`panel-left` 图标）。检测到官方按钮时隐藏自建按钮，
  保留的只有官方图标与官方打开逻辑；自建按钮仅作为官方按钮缺席时兜底。
- **不再出现两个左栏图标**：自建按钮与官方按钮不再同时显示。
- **打开后不自动收回**：官方按钮自身的状态机负责开合，实测 3 秒保持。
- **插件市场图标继续按每次渲染裁剪**：React 更新 rect 后仍只保留 2×2。
- 移动端 UI 版本提升到 `1.1.0-166`。

## [0.4.6] — 2026-11-06
vc=43
### 修复
- **侧栏入口彻底使用官方图标**：使用与圈选按钮相同的 16px
  `dsw-icon-panel-left-outline-regular`，并带上官方 `hHd-Xa_panelIcon` 样式类。
- **打开后不再自动收回**：在 `window` 捕获阶段拦截 web-all 的
  `pointerdown/touchstart/click`，避免它的 mobile sidebar dismiss 在同一手势里
  又把抽屉关掉；实测打开后 3 秒仍保持。
- **插件市场图标每次渲染后重新裁剪**：React 可能只更新 rect 子节点而不换 SVG，
  所以不再只看一次性标记；始终保留 2×2 四格。
- **遮罩点击关闭**：原生整屏遮罩被点击时调用官方 toggle。
- 移动端 UI 版本提升到 `1.1.0-165`。

## [0.4.5] — 2026-11-06
vc=42
### 修复
- **侧栏入口恢复官方图标**：汉堡三条杠改为官方
  `dsw-icon-panel-left-outline-regular`（左侧栏面板图标），与 DSH 原版一致。
- **侧栏入口改为视觉状态优先**：只要抽屉当前不可见，点击就执行打开，
  不再被 web-all 下「官方 expanded 但 CSS 隐藏」的陈旧状态吃掉第一次点击。
- **web-all 0.4.15 拦截 click**：入口同时监听 `pointerdown/touchstart`，
  350ms 防抖，click 仅作桌面与脚本兜底。
- **抽屉遮罩可点击关闭**：原生 `[data-dsh-frame]::after` 遮罩被点到时
  直接调用官方 toggle，避免“打开后卡在侧栏出不去”。
- **插件市场图标去重**：去掉 web-all 0.4.15 图标多出的 3 列和旋转块，只保留
  2×2 网格；侧栏入口使用官方 16px 面板图标。
- 移动端 UI 版本提升到 `1.1.0-164`。

## [0.4.4] — 2026-11-06
vc=41
### 修复
- **侧栏被误当设置弹窗全屏化**：rc.1 的侧栏根节点在窄屏也带
  `role=dialog/aria-modal`，移动端脚本把它当成设置面板，写入
  `100vw/100vh` 并插入「设置」返回条，导致侧栏铺满、无法返回会话。
  现在排除 `.hHd-Xa_root` / 侧栏子树，只处理真正的设置 dialog。
- **抽屉程序化打开被自身捕获监听器吞掉**：打开前先清掉残留
  `mp-drawer-open`，再点官方 toggle，避免 document 捕获层把它误判成关闭。
- 移动端 UI 版本提升到 `1.1.0-163`。

### 插件
- `@linxin666/dsh-web-all` 更新到 `0.4.15` 并重新加入 bundles。
- `dsh-app-pet 1.0.3` 重新加入 bundles，桌宠配置继续下发。

## [0.4.3] — 2026-11-06
vc=40
### 内核
- 升级到 `@deepseek-ai/dsh@0.2.2-rc.1`，Node 仍为 `26.12.1`（满足 `>=24.9.0`）。
- 引擎锚点 15/15 命中：5 个基础锚点、4 个 tool-call/图片格式锚点、目录选择器、
  进程检查器、创造模式 persona、HTML module 注入和 fail-loud release。
- `assetStamp` 改为 `0.2.2-rc.1-1`，确保旧设备重新解包 `engine.bin`。
- `tools/version.sh` 的引擎正则扩展为 `-alpha.N / -beta.N / -rc.N`，
  避免 rc.1 被误判为版本不一致。

### 依赖
- pnpm 从 `11.28.3` 升到 `11.28.5`，与 rc.1 的 `packageManager` 对齐。
- `dsh-app-pet 1.0.3` 与 `@linxin666/dsh-web-all 0.4.14` 在本次验证中暂时从
  profile bundles 移除，依赖保留，可无损恢复；不阻塞内核升级。

### 验证
- 干净 rc.1 服务启动成功：`DeepSeek Harness` 页面 200，版本 `0.2.2-rc.1`。
- 旧会话格式仍为 v4（`session.v4.jsonl.zstd`），持久化格式版本未变。
- 移动端核心选择器 `pI_x6G_*`、`uV2eYG_*`、`wSkVaW_*` 仍在；rc.1 新增原生
  `data-sidebar-drawer` / `pI_x6G_drawerMask`。

## [0.4.2] — 2026-11-01
vc=39

### 修复

- **设置页标题重复三层**：顶栏「设置」、居中「‹ 页面名」、内容区再一个同名 H1/H2，
  连「特权权限（uid 2000 / root）」这种带后缀的标题也重复。统一为「返回键 + 页面名」
  一层顶栏，内容区同名标题全部隐藏。
- **根页两个「设置」**：官方面板是 `flex-flow: row wrap`，返回条被挤成 60px 窄条，
  标题跑到右侧。改为绝对定位满宽顶栏，根页只保留一个标题。
- **三个退出入口并存**：`‹`、`✕`、「打开配置文件」同时存在。官方 header 隐藏，
  只留 `‹`（二级 → 列表 → 关闭）。
- **内容区只有 26px 高**：设置面板改为单列 `nowrap`，内容区 `flex:1 + overflow-y:auto`，
  顶部留 48px 给顶栏。
- **开发环境只有「…」**：加载态给文案，读取加 10s AbortController 超时，
  失败给原因 + 「重新读取」；空态不再是一片空白。
- **悬浮气泡露出原始键名**：补 `showDetails / hideDetails` 中英文词典项。
- **⋯ 菜单「对话 / 轨迹」无法连续切换**：原来标签在菜单构建时算一次、点击用闭包旧值。
  改为点击瞬间读取当前激活 tab、点完立即把本项翻成反向目标，菜单不关也能来回切。
- **会话行「⋯」菜单弹出 1–2 秒后自动消失**：`@linxin666/dsh-web-all` 的移动端
  `installMobileSidebarDismiss` 在 `sessionRow` 点击后用 rAF 程序化点击官方抽屉
  toggle，菜单锚点被带出视口。`dsh-android-mobile` 增加守卫：菜单打开期间、以及
  行操作点击后的 600ms 内，拦掉这类 `toggle.click()`；真实点击与菜单项动作不受影响。
- **「创建你的插件」只开新会话、草稿为空**：`@linxin666/dsh-web-all` 会把
  `uiWorkspace` 实例上的 `startSession` 替换成 native 空壳，调用后没有任何效果，
  所以草稿与创造模式都不落地。`dsh-android-mobile` 改为取原型链上的 DSH 原版
  `startSession` 并用正确 receiver 调用，参数与官方完全一致（`agentPreset:"cordis"`、`prompt`、`whenDraftExists:"append"`），不再做 DOM 兜底。
- **dshmarket 在移动端被压成 32px 宽**：市场根节点复用了官方 `uV2eYG_root` 的
  `align-items:center`，导致标题、搜索、卡片全部挤成一条。`dsh-android-mobile`
  在市场根节点内恢复 `align-items:stretch` 与 100% 宽，394px 视口下卡片恢复到 362px。
- **dsh-web-all 折叠态残留 52px 图标条**：web-all 的 `[data-pane="sidebar"]`
  规则把侧栏钉成 52px 绝对定位轨道，设置页正文被压到右侧。`dsh-android-mobile`
  在 `[data-mobile]` 下关闭态直接 `display:none`，仅 `.mp-drawer-open` 时恢复
  320px 固定抽屉；设置 dialog 是 body 级 portal，不受隐藏影响。
- **dsh-web-all 叠加第二层抽屉遮罩**：移动端已有 `mp-drawer-mask`，web-all 的
  `[data-dsh-frame]::after` 会再盖一层。抽屉打开时给 `<html>` 加
  `data-mp-drawer-open`，只关掉 web-all 的 `::after`，保留市场/会话全部点击。

### 变更

- **「创建你的插件」改走原版 DSH 调用**：
  `uiWorkspace.startSession(void 0, { agentPreset: "cordis", prompt, whenDraftExists: "append" })`；
  三个入口按 region 使用官方提示词（左侧栏 / 会话视图 / 右侧栏），不再回退到 DOM 流程。

### 发布

- 移动端 UI build：`1.1.0-154`（CI run `41301507952`，APK 185,668,979 B）。
- 正式修复 build：`1.1.0-161`（CI run `41775381968`，APK 185,610,007 B，client 577,643 B；
  dsh-web-all 折叠态 52px 图标条完全收起，验收 `0/9 · ✅`）。
- 第三方 UI build：`1.1.0-160`（CI run `41633704830`，APK 185,591,763 B，client 577,112 B；
  dshmarket 全宽布局 + dsh-web-all 双遮罩收敛，验收 `0/9 · ✅`）。
- 官方菜单修复 build：`1.1.0-159`（CI run `41593566860`，APK 185,593,927 B，client 575,358 B）。
- 会话视图入口 build：`1.1.0-158`（CI run `41586246550`，APK 185,529,739 B，client 573,910 B）。
- 过渡 build：`1.1.0-157`（CI run `41482760262`，含草稿 DOM 兜底，仅存档，不作为最终方案）。
- 验收记录：[`docs/agents/mobile-ui-verification.md`](docs/agents/mobile-ui-verification.md) 的 1.1.0-161 行（`0/9 · ✅`）。
- 发布产物：GitHub Release `v0.4.2` 两个附件已于 2026-11-04 替换为 `1.1.0-161`：
  - `dsh-android-0.4.2-arm64.apk`：185,610,007 B，sha256 `d75ad652ba12ead6233a5ad2b3c568368df9664ab95eee558d394f95a8e34e2e`
  - `dsh-android-0.4.2-gecko-arm64.apk`：274,685,019 B，sha256 `8c21d57e1f7fecffe61dd55241294d53833130f6881efa1540a0f769da46368a`

---

## [0.4.1] — 2026-10-23
vc=38

### 修复

- **AI 浏览器的入口不在约定的位置** —— 0.4.0 用的是右边缘贴边把手，而需求是
  「从应用右侧边栏进入」。0.4.1 把它做到官方右侧边栏里。
- 新增客户端插件 `dsh-android-browser-pane`：经 `sidebarRightTabs.register`
  注册一种 tab + 经 `slots.register("sidebar.right.pane.tab")` 提供正文。
  点开即调原生 `openAiBrowser()`（`PageBridge` 新增方法，两份 flavor 白名单
  已同步）。**独立成包**，不动 `mobile-ui.zip` —— 那个 zip 是跨工作树共享的
  符号链接资产，重打会把另一条分支的移动端修复整个回退掉。
- 右边缘把手暂时保留作退路，侧栏入口确认可用后可删。

---

## [0.4.0] — 2026-10-23
vc=31

主题：**AI 拥有一台属于自己的手机浏览器**。

### 新增

- **AI 浏览器** —— 一个独立于官方界面的原生 WebView（`AiBrowserView`）。
  引擎自带的侧栏浏览器是 `iframe`，而 GitHub（`X-Frame-Options: deny`）、
  Google（CSP）拒绝被嵌入，那个方案连登录页都加载不出来；原生 WebView
  没有这个限制，且渲染在本地、零延迟、不消耗服务器资源。
- **完整的浏览器壳**：前进/后退/刷新/首页/地址栏/加载进度/多标签（上限 6）/
  文件下载（落 App 专属外部 Download 目录，不需要存储权限）/ 文件上传 /
  视口截图。
- **`browser` 工具**（`dsh-android-browser`）—— 模型可以自己开网页、读页面、
  点按钮、填表单、登录、截图。读页面回的是**可交互元素清单**（带稳定编号），
  而不是一堆 HTML，因为让模型猜 CSS 选择器在真实站点上几乎必然落空。
- **登录态持久**：Cookie 每次 `onPageFinished` 都 flush，App 重启后仍是登录状态。
- **控制权仲裁**：AI 操作时吃掉所有触摸（避免用户随手一点让正在填的表单失焦），
  顶部 chip 显示「AI 操作中」，用户点一下即可接管 —— 共享同一个浏览器。
- **右边缘「浏览」把手**：启动层收起后常驻，浏览器打开时自动隐藏。

### 修复

- 工具栏按钮不显示 —— `ImageButton` 继承 `ImageView`、**不是 `ViewGroup`**，
  `addView(tv)` 被隐式接收者解析成外层 `FrameLayout.addView`，文字被加到根布局
  左上角（被页面盖住）。改为纯 `TextView` 按钮。
- `type` 动作的 JS 里把 `var` 写成 `val`（Kotlin 笔误），会让所有输入操作抛
  `SyntaxError`。已用 `node --check` 逐段验证拼接后的五段 JS。

---

## [Unreleased]

### 计划中

- 补齐开源仓库配置（README / LICENSE / CONTRIBUTING / SECURITY / CI）

---

## [0.3.0] — 2026-10-17

### 新增

- **Shizuku 权限通道** —— uid 2000 执行不再只依赖 adb。不需要 5555 端口、
  不需要 adbkey 被信任、重启后依然有效。此前对「Android 10 且只有有线 adb」的
  用户是结构性死锁。
- **插件市场**（`dsh-android-market`）+ 远程目录双插件。
- **配对服务端加固** + 管理面板；新增五组门禁测试。
- **界面改三标签页**。

### 修复

- **白屏真根因（HTTP 431）** —— auth cookie 累积导致请求头超限；同时 GeckoView
  不跟随 303 重定向。新增救援判据。
- **救援判据漏报** —— `parseGatewayFailure` 无法识别 typert gateway 整体下线的场景。
- **ELF 路径改写必须用运行时真实包名** —— 编译期常量在被改包名的安装上会指向
  不存在的目录。
- **补传诊断包跨进程互斥** —— 单靠 `AtomicBoolean` 挡不住重叠的主进程实例。
- **L1 隔离作用在过期快照上** + quarantine 有一条完全静默的 `false` 分支。
- **救援阶梯日志从不落盘** + `rescue/` 状态文件从不进诊断包。

---

## [0.2.9] — 2026-10-14

### 新增

- **内建 uid 2000 执行通道**（`shell` 工具）。
- **悬浮球** —— 可自定义外观、帧动画、视频图层。
- **`bubble` / `pet` / `ui` / `logs` 工具插件** —— 让模型自己操作悬浮窗、看屏幕、
  查日志。
- **四级救援阶梯 + 安全模式** —— 坏插件不再让 App 打不开。

### 修复

- **「界面反复出错」误报** —— 渲染重载计数没有时间窗，长期运行的内核回收会
  累计成「反复崩溃」。
- **界面重载永远判失败** —— 四层缺陷叠加，内核被回收后无法自动恢复。
- **「已停止自动恢复」后仍在重载** —— 在飞的重载链没有失效机制。
- **主线程卡死现场无栈** —— 补主线程栈快照，此前 4 份真实用户现场全部无法定位。
- **文件上传任何格式都失败** —— 上传 Worker 改到主线程。
- **号池「API 密钥无效、重启又恢复」** —— 固定槽位表耗尽。

---

## [0.2.7] — 2026-10-13

### 新增

- **内置 Web 内核版**（gecko flavor，GeckoView 140）—— 不依赖系统 WebView，
  与 system 版 `applicationId` 不同，可同装一台机器。
- **内置号池** —— TLS 层注入，密钥不落盘、不进 JS。

### 修复

- **旧 WebView 内核白屏** —— 改为把前端 bundle 按 chrome73 降级编译，而不是
  只打 polyfill（polyfill 补不了语法）。

---

## [0.2.6] 及更早

引入 `system` / `gecko` 双 flavor 之前的历史版本。核心适配工作在此阶段完成：

- Termux 环境自举（bootstrap / node / pnpm）
- **`link` 转译层** —— SELinux 不给 `link()` 权限
- **自带沙箱 runner** —— Android 没有 bwrap / Landlock
- **ripgrep / sharp / node-pty 的 android 变体**
- WebView 文件选择器与下载器
- 目录选择器接上手机存储

细节见 [`docs/agents/`](docs/agents/README.md)。

---

## 链接

- [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)
- [语义化版本](https://semver.org/lang/zh-CN/)
