# docs/agents 索引

从原 `AGENTS.md`（5872 行 / 354 KB）拆出来的分册。
根目录的 [AGENTS.md](../../AGENTS.md) 只留**必读硬约束 + 构建命令 + 本索引**；
细节全在这里，按需检索，不要整份读。

## 5 分钟自检（三块环境各一条命令）

| 线 | 命令 | 绿灯判据 |
|---|---|---|
| 宿主：mock 矩阵 + 三条真模型线 | `sh /data/local/tmp/verify-full.sh` | `---- FULL 4 PASS / 0 FAIL` |
| 宿主快检（≈3 分钟） | `sh /data/local/tmp/verify-full.sh --quick` | `---- FULL 2 PASS / 0 FAIL` |
| VMOS guest：7 工具含 root | `VMOS_ADB=127.0.0.1:5666 sh tools/verify-guest.sh` | `---- GUEST PASS  8 PASS / 0 FAIL / 2 SKIP` |
| CI Release APK | `python3 tools/verify-ci.py` | `---- CI PASS  run=<id>` |
| 版本号同源 | `sh tools/version.sh --check` | `---- VERSION PASS` |

三条硬前提：App 在前台且已解锁、`svc power stayon true`、**不要**把 `verify-all.sh` 包进 `run-as`。
逐段回执与踩坑见 [verification.md](verification.md) ⑩ ~ ⑭。

| 文件 | 主题 | 一句话 |
|---|---|---|
|---|---|---|
| [constraints.md](constraints.md) | 两条硬约束 | 包名 15 字符、targetSdk ≤ 28。改错不报错但真机必炸 |
| [build-and-ship.md](build-and-ship.md) | 构建、发行与发布 | gradle 任务、签名、夸克网盘上传与版本整理 |
| [server-build-env.md](server-build-env.md) | 服务器构建环境 | 八壹云部署、GRADLE_USER_HOME / DSH_HOME 两处必须存在的绝对路径、一键发布脚本 |
| [platform-android.md](platform-android.md) | android 平台适配总览 | 为什么 Node 在 Android 上是 android 而不是 linux |
| [link-compat.md](link-compat.md) | ③ SELinux 不给 link 权限 | LD_PRELOAD 转译层：为什么必须转译、转译语义、降级路径 |
| [directory-picker.md](directory-picker.md) | ③.5 目录选择器只在**一棵**树里走 | HOME 下的入口链接接上手机存储 |
| [sandbox.md](sandbox.md) | ④ Android 没有内核级沙箱后端 | 自带 boo-sandbox-run runner 保住写边界 |
| [ripgrep.md](ripgrep.md) | ⑤ @vscode/ripgrep 没有 android 包 | 补一个静态 rg 二进制 |
| [pnpm.md](pnpm.md) | ⑥ Termux 里没有 pnpm | 装 pnpm 11 纯 JS 版；为什么不能用 12；core-memory 是例外 |
| [asset-stamps.md](asset-stamps.md) | 资产版本戳 | 改了哪个资产必须同步改哪个代码常量，以及手工重打 zip 的判据 |
| [webview-basics.md](webview-basics.md) | ⑦ 文件选择器 / ⑦.5 下载器 | WebView 默认实现静默失败，必须自己接 |
| [webview-gecko.md](webview-gecko.md) | ⑦.7 内置 Web 内核版（gecko flavor） | GeckoView API 差异、桥、注释陷阱 |
| [sharp.md](sharp.md) | ⑧ sharp 没有 android 预编译二进制 | 装 wasm32 变体 |
| [attachment-fsync.md](attachment-fsync.md) | ⑨ 附件模块会 fsync 到 / | SELinux 不给 open 祖先目录 |
| [session-repair.md](session-repair.md) | ⑨.5 / ⑨.6 会话永久损坏的两种形态 | tool_use 块顺序、第三方路由不给 tool_call id |
| [node-pty.md](node-pty.md) | ⑩ 侧栏终端打不开 | node-pty 缺 android 绑定 + 进程检查器只认三平台 |
| [shell-tool.md](shell-tool.md) | ⑪ 内建 uid 2000 执行通道 | shell 工具、adb 签名、密钥来源、18 条缺陷修复、验收 |
| [bubble.md](bubble.md) | ⑫ / ⑫.1 悬浮气泡 | 悬浮球、四项交互契约、窗口与拖动陷阱 |
| [bubble-bridge.md](bubble-bridge.md) | ⑫.2 悬浮窗接进插件生态 | 外观字段、桥方法三处同步、转录通道 |
| [bubble-tool.md](bubble-tool.md) | ⑫.3 bubble 工具 | 文件信箱，让模型自己改悬浮窗 |
| [pet-bridge.md](pet-bridge.md) | ⑫.4 桌面宠物 | 状态→动作映射、两条状态通道 |
| [ui-tool.md](ui-tool.md) | ⑫.5 ui 工具 | 让模型自己看和点界面：坐标系、遮挡、屏幕外、面板、持久化状态 |
| [dev-env.md](dev-env.md) | 开发环境六项 | Node 内建；Python / SSH / Java / Rust / Go 走 apt，`tools/dsh-env.sh` 一键体检与安装 |
| [browser.md](browser.md) | ⑫.8 AI 浏览器 | 模型自己的 WebView：为什么不用 iframe、官方右侧边栏入口的两个接缝、文件信箱链路、控制权仲裁、页面 JS 三条硬规矩 |
| [logging.md](logging.md) | ⑫.6 / ⑫.7 日志与诊断 | 三层存储、崩溃入口、脱敏、诊断包、归因写错的五处 |
| [plugin-source.md](plugin-source.md) | ⑬ 添加插件少了「npm 官方源」 | 不是漏配，是被去重合并掉了 |
| [web-port.md](web-port.md) | ⑭ Web 端口 3080 被占用 | 默认沿用，撞车才让内核分配 |
| [key-pool.md](key-pool.md) | ⑮ 内置号池 | TLS 层注入、固定槽位表耗尽、必须降级 HTTP/1.1、等长替换 |
| [webview-compat.md](webview-compat.md) | ⑯ 旧 WebView 内核白屏 | 前端 bundle 降级编译（不是 polyfill），v2/v19 两轮教训 |
| [keep-alive.md](keep-alive.md) | 后台保活与通知栏实时状态 | 任务切后台不能断；键盘升起遮挡 |
| [mobile-ui.md](mobile-ui.md) | 移动端 UI 插件 | 为什么解到 $DSH_HOME/mobile-ui、别名桥接、+ 菜单时序、安全键盘 |
| [mobile-ui-rc3.md](mobile-ui-rc3.md) | 移动端 UI × rc3 | 三处「更多」菜单与抽屉的冲突、右栏创建插件收右栏；一条命令跑 6 条断言 |
| [engine-0.2.2.md](engine-0.2.2.md) | 引擎升级到 0.2.2-alpha.2 | 锚点 5/5、UI 6/6、7 个工具插件 mock 跑通、dev-env 六组、装机出包 |
| [engine-0.2.2-compat.md](engine-0.2.2-compat.md) | **0.2.2 适配清单（照做）** | 必改点 5 条、锚点、插件兼容、工具矩阵、验证矩阵、回滚 |
| [debug-device.md](debug-device.md) | 调试真机 | adb 基本手法 |
| [rescue-mode.md](rescue-mode.md) | 插件改坏导致 App 打不开 | 启动前体检 + 安全模式 |
| [node-selfheal.md](node-selfheal.md) | $PREFIX/bin/node 会坏 | 自校验 + 自愈、$PREFIX 并发写互斥 |
| [boundaries.md](boundaries.md) | 已知边界 | 明确不做 / 做不到的事 |
| [regen-assets.md](regen-assets.md) | 重新生成资产 | 各资产从哪来、怎么打 |
| [ci-build.md](ci-build.md) | CI 构建 APK | x86_64 runner、资产自建、失败排查 |
| [node-addon-require-builtin.md](node-addon-require-builtin.md) | require-builtin 原生插件 | 源码镜像与编译配方、两个编译坑、运行时验证方法 |
| [desktop-relation.md](desktop-relation.md) | 与 DSH 桌面端的关系 | 哪些东西两端共用、哪些各管各的 |
## 一条命令验收移动端 UI（rc3）

```bash
# 先解锁屏幕！熄屏时 dump 能返回坐标，但 tap 全被 keyguard 吃掉
run-as com.dsh.android sh -c 'files/termux/usr/bin/node /data/local/tmp/urc3.mjs'
# 6 条：PREFLIGHT / D / R / F / E / G；退出码 0 = 全过
```

脚本源码：[tools/ui-regression-rc3.mjs](../../tools/ui-regression-rc3.mjs)；判据定义：[verification.md ⑥](verification.md)。

> ⑤⑥ 是**设备侧判据**：需要真机 + 已解锁屏幕；①~④ 可在纯主机环境跑。
