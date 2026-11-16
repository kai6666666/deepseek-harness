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

## [0.5.0] — 2026-11-15
vc=51

### 变更
- **单运行时 PRoot / glibc**：引擎、`bash`、uid 2000 特权通道、root 通道、沙箱 runner 全部
  跑在 APK 内置的 Ubuntu 24.04 rootfs 里（node 24.22.1、pnpm 10.28.2、git、python3、curl）。
  bionic 资产（`engine.bin`、`node-runtime.bin`、`bootstrap-*.zip`、原生 addon）已从 APK 删除。
- **数据迁移**：`$DSH_HOME`（sessions / storages / profiles / skills / deskpet / 凭据）、
  `workspace/`、`logs/` 原地保留；0.4.x 的 `engine/`、`usr/`、`termux/usr` 在首次健康启动后
  改名进 `runtime/legacy-bionic/`（改名不删，`termux/home` 不动）。
- **救援与自愈**：L2 救援 profile 与 `try-boot` 走 PRoot；rootfs 关键文件缺失或版本戳失效时
  自动重新解包（约 80 s），用户数据不动；安全模式改为「标记 rootfs 重建」。
- **进程治理**：每次启动独立 pidfile、按进程树作用域停止；试启动不再按 cmdline 全局清杀，
  在跑的引擎不会被探测误杀。
- **密钥不出现在命令行**：调用方环境变量写进 `$DSH_HOME/.proot-env-<runId>`（0600，退出即删），
  `ps` 不再能看到 API key。
- **镜像自带开发工具**：`git` / `python3` / `curl` 随 rootfs 下发，重解包不再丢 dev-env
  （代价：APK 由 143 MB 增至 187 MB）。
- **DNS 回归修复**：dev-tools 镜像步骤把构建机的 `resolv.conf`（`nameserver 127.0.0.53` +
  `search *.compute.internal`）带进了 rootfs，导致设备上**所有域名解析失败**（登录显示
  「账号资料暂不可用」、插件市场回退离线目录且提示 `fetch failed`）。构建期改为装完即还原
  公共 DNS，`verify.py` 增加解析器硬断言，客户端对已知坏值就地自愈（老安装无需重装）。
- **图片附件**：修复 `@img/colour` 被平台裁剪误删导致的 `Cannot find module`（发图必失败），
  `verify.py` 增加硬断言。
- **登录**：修复「点登录没反应」。官方 `BrowserLogin` 用 `window.open("about:blank")`
  预开窗口再导航到授权页，而宿主只把 WebView 交给内核、从未挂到任何窗口上，
  于是授权页既不渲染也不调度导航（日志停在「window.open 已建空白窗口」）。
  现在把窗口放进应用内 Dialog 显示，授权链正常跳转，回到本地引擎即关闭；
  cookie 仍落在本 App 的 WebView jar 里，登录态能回填。
- **登录**：修复「点登录没反应」。官方 `BrowserLogin` 用 `window.open("about:blank")`
  预开窗口再导航到授权页，而宿主只把 WebView 交给内核、从未挂到任何窗口上，
  于是授权页既不渲染也不调度导航（日志停在「window.open 已建空白窗口」）。
  现在把窗口放进应用内 Dialog 显示，授权链正常跳转，回到本地引擎即关闭；
  cookie 仍落在本 App 的 WebView jar 里，登录态能回填。
- **移动端 UI `1.1.0-184`**：修复插件页 ⓘ 说明与 ▾ 添加方式按钮「点了没反应」。
  触摸按下时重置宿主的兼容点击去重窗口，同一次手势只放行一个 click，连点两次仍能开、关；
  插件说明气泡在触摸设备上重新可见并夹在视口内。
  市场容器判据改为「前两个子节点是 DIV」，滚动过 300px 出现回顶按钮后布局适配不再整段失效；
  分类栏与回顶按钮不再 sticky/fixed 错位，三个入口滚动时宽度、字号与内边距保持一致，
  离开市场仍逐条还原原始样式。修复限定 `mobile-ui-plugin`，契约测试覆盖第三子节点、
  sticky 归位与非 DIV 结构。
- **移动端 UI `1.1.0-183`**：插件页按「标题 + 刷新/添加/下拉」「说明 + ⓘ + 更新状态」
  「已安装 / 插件市场」三层排版；内置配置与实验性插件分组标题在上、列表在下，
  「更多 ›」与实验性插件标题同行，窄屏自动换行。
  三个市场入口（设置、插件标签页、侧栏面板）统一字号与内边距，挂载微任务内完成布局，
  消除进场的缩放与宽度跳变；头部保留自然高度，列表独立承接触摸纵向滚动。
  设置内保留标题栏、配置文件/关闭按钮与横向分类导航，修复重复标题；离开市场还原原样式。
  修复代码限定 `mobile-ui-plugin`，新增布局契约回归测试与三入口真机帧级验收。
  修正市场窄屏样式对宿主导航和宽度的覆盖；移除不可达的旧设置两级化代码，
  仅用稳定属性与可还原的内联布局，切换分类/桌面尺寸时恢复宿主原有样式。
- **移动端 UI `1.1.0-181`**：左侧栏图标与右侧栏同规（28×28 / `label-secondary` / 1px 描边），
  关闭态 `visibility:hidden + contain:strict`，消除「工作区条飞出」与图标加粗。

## [0.4.4-test] — 2026-11-11
vc=50

### 变更
- 单运行时（PRoot + Ubuntu 24.04 + Node 24）测试线，与 0.4.3 正式版分线。
- 0.4.3 正式版冻结在分支 `release/0.4.3`（未含 PRoot 重构），其 Release 资产只能由该分支构建。
- 移动端 UI 实验只允许出现在 0.4.4-test，不再回写到 0.4.3。

## [0.4.3] — 2026-11-09
vc=49

### 变更

- 引擎 `@deepseek-ai/dsh` **0.2.2-alpha.2 → 0.2.2-rc.1**（`0.2.2-rc.1-1`）
- 首帧兜底日志降为 `[I]`：阈值 1.5 s 不变，本机内核常走兜底，属正常慢帧
- 救援判据修正：只认「超时兜底 + 页面仍停在官方启动页」，不再把 `plugin-load-failed` 诊断当判据
- `engine.staging-<stamp>-<pid>` 唯一化 + 过期残留清扫（并发安装不再互相覆盖）
- 日志异步档增加 1.5 s 时间兜底 flush，`engine.log` / `web.log` 不再整段丢失
- 解包目录替换三层退路（硬删复查 → 挪开旧目录 → 逐文件复制）
- mobile-ui `1.1.0-176`：座位只在会话视图退场；左按钮并入 header 布局体系
- 版本号单一来源：`tools/app-version.txt` + `tools/mobile-ui-version.txt`
- CHANGELOG 模板化：`docs/changelog/<versionName>.md`
- `verify-engine-upgrade.sh --tools` 自举 helpers，换机不再依赖 `/data/local/tmp`

### 门禁

- 引擎 0.2.2-rc.1 · 开发环境 nodejs 2/2 · 会话索引 2/4 · 补丁标记 5/5 · 工具 bubble/ui/logs/statusbar/browser PASS · root SKIP
- 真机：Xiaomi 25104RADAC / Android 16 / arm64-v8a

---

## [0.2.2-rc1] — 2026-11-07
vc=47
### 变更
- **版本号对齐 dsh 官方**：`versionName = 0.2.2-rc1`，与引擎 `@deepseek-ai/dsh@0.2.2-rc.1`
  同名；`versionCode = 47` 继续严格递增（39 → 47），保证从 0.4.9（vc46）可覆盖升级，
  不会触发 `INSTALL_FAILED_VERSION_DOWNGRADE`。
- **引擎升级到 `0.2.2-rc.1`**：`engine.bin` 81,470,515 B，
  sha256 `1d909f00489314896d7af120070df8ea90aee5b74d327e9bbbf744fa773aed73`，
  MANIFEST 52,835 文件 / 386,190,604 字节，`assetStamp = 0.2.2-rc.1-1`。
  Node `26.12.1`，pnpm `11.28.5`，会话格式 `v4`（旧会话可直接读取）。
- **移动端 UI `1.1.0-169`**：一次性带入 rc.1 的六条适配——
  ① 侧栏开合以 `data-sidebar-collapsed` 为唯一事实源；
  ② `data-sidebar-drawer` 下恢复 fixed + 宽度 + left 动画，原生 `pI_x6G_drawerMask` 置 none；
  ③ 设置弹窗排除 `.hHd-Xa_root` / `.pI_x6G_sidebarCol`（rc.1 侧栏根节点带 role=dialog/aria-modal）；
  ④ 左右栏按钮完全交回官方：不建自建按钮、不写内联 `position/top`，只清历史内联样式；
  ⑤ `[data-mobile] .pI_x6G_leadingSeat { z-index:60 }`，修复左按钮被右栏溢出面板
     （`.P3OORG_panel` 以 `right:0` 铺满、`_tabCell` z-index:40）吃掉命中；
  ⑥ 插件市场行图标整行归一化：删重复 glyph / 重复 svg，只留一个并裁成 2×2 四格。
- `@linxin666/dsh-web-all` 与 `dsh-app-pet` 在 `dsh.profile.bundles` 中启用。
- 补回 `publish-release-from-run.yml`（0.4.2 基线缺失该 workflow），资产名随 tag 推导，
  上传使用 `secrets.RELEASE_PAT`。
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
