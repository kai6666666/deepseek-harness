# 引擎 0.2.2-alpha.2 → 0.2.2-rc.1 升级记录

日期：2026-11-06

## 基线

| 项目 | 值 |
|---|---|
| 源码仓库 | `kai6666666/deepseek-harness` |
| 源码提交 | `13d250abbaf8453988724f491fa44f1bdba5bbdb` |
| 旧引擎 | `@deepseek-ai/dsh@0.2.2-alpha.2` |
| 新引擎 | `@deepseek-ai/dsh@0.2.2-rc.1` |
| App | `0.4.3` / `vc40` |
| 移动端 UI | `1.1.0-162` |
| pnpm | `11.28.5` |
| Node | `26.12.1`（rc.1 要求 `>=24.9.0`） |

## 源码对账

本地 `EngineManager.kt` 曾停在 `MOBILE_UI_VERSION=1.1.0-139`，远端 `main` 已是
`1.1.0-161`。Gate 0 先以远端文件为基线，将本地恢复到 `1.1.0-161`，再在 rc.1
适配中提升到 `1.1.0-162`，避免把 161 的移动端适配整体回退。

## 锚点

基础锚点 5/5：

| 锚点 | 结果 |
|---|---|
| `flock-platform` | ✅ |
| `fail-loud-app-boot` | ✅ |
| `fail-loud-release` | ✅ |
| `terminal-shell` | ✅ |
| `attachment-fsync` | ✅ |

扩展锚点 10/10：

| 锚点 | 结果 |
|---|---|
| 发图格式白名单 | ✅ `dsh-client-ui-conversation` |
| DeepSeek Messages tool_use 顺序（首/尾） | ✅ `dsh-llm-deepseek` |
| pi-ai toolcall id（首/尾） | ✅ `dsh-llm-pi-ai` |
| dsh-llm toolcall id 兜底 | ✅ `dsh-llm` |
| 目录选择器起点 | ✅ `dsh-host-directory-picker-browse` |
| 进程检查器 Android 分支 | ✅ `dsh-subprocess-local/lib/runner-launch-B2zsQ1Dz.js` |
| 创造模式 persona | ✅ `dsh-web-app/presets/cordis.patch.yml` |
| HTML module 脚本注入点 | ✅ `dsh-web-frontend/dist/index.html` |
| fail-loud release | ✅ `dsh/lib/profile-boot-e2mS45fC.js` |

补丁标记模拟：

```text
✅ flock-android
✅ fail-loud-boot
✅ fail-loud-release
✅ terminal-shell
✅ attachment-fsync
----
5/5 补丁标记命中
```

## 干净 rc.1 启动

```text
DSH_HOME=/tmp/dsh-home-rc1 node node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile web --no-open --port 3099
```

结果：

```text
dsh web: http://127.0.0.1:3099/?token=…
HTTP 303（带 token）→ 200，页面标题 DeepSeek Harness
```

## 持久化

`SESSION_FORMAT_VERSION = 4`，alpha.2 与 rc.1 相同。旧会话文件名仍为
`session.v4.jsonl.zstd`，Gate 1 未发现格式升级阻塞。

## 移动端选择器

rc.1 仍保留：

```text
pI_x6G_sidebarCol / pI_x6G_centerCol / pI_x6G_rightbarCol
uV2eYG_* / wSkVaW_*
```

rc.1 新增：

```text
data-sidebar-drawer
pI_x6G_drawerMask
pI_x6G_mainPanel
```

移动端插件已加兼容规则：`[data-mobile]` 下隐藏原生 `pI_x6G_drawerMask`，
并清除原生 sidebar 的 `transform/visibility`，继续使用本插件的 `left` 动画与
`.mp-drawer-mask`。

## 插件状态

| 插件 | 状态 |
|---|---|
| `dsh-skill-mcp-manager` | 已卸载 |
| `@linxin666/dsh-web-all` | profile bundles 暂时移除，依赖保留 |
| `dsh-app-pet` | profile bundles 暂时移除，依赖保留 |
| `dshmarket` | 保留 |
| `wallpaper-engine` | 保留（配置中 disabled） |
| `skin-center` / `skill-explorer` / `claude-style` | 依赖保留，待设备回归 |

## 构建

本地：

```text
engine.bin  78 MB，MANIFEST 52,835 文件 / 386,190,604 字节
pnpm zip    5.6 MB，pnpm 11.28.5 / 454 条目
mobile-ui   206 KB，client 578,106 B
```

CI：

```text
APK 构建 run 42197373925：success
Release 构建 run 42198603761：success（首版）
Release 构建 run 42205805833：success（最终 mobile drawer 修复）
system 185,065,831 B / gecko 273,851,976 B
```

## 真机验证（0.4.3）

```text
versionName=0.4.3  versionCode=40
files/engine/.stamp=0.2.2-rc.1-1
@deepseek-ai/dsh/package.json version=0.2.2-rc.1
.mobile_ui_version=1.1.0-162
.pnpm_version=11.28.5
pnpm -v=11.28.5
HTTP 401（带 token 的引擎已就绪）
```

- 旧会话直接显示，未触发 SessionFormatError。
- 菜单 7 项：复制 Markdown、下载 Session 日志、浏览更多插件、创建你的插件、反馈、轨迹、刷新。
- 「创建你的插件」写入官方草稿：`创建一个 DSH 会话视图插件。`
- dshmarket 根节点 394 px 全宽。
- 抽屉关闭 `left=-340`，打开 `left=0`；原生 `pI_x6G_drawerMask` 为 `display:none`。
- 移动端 client 与最终源文件 SHA-256 一致：
  `e17161172062bd3c1d1e3f37316366a765ddb8a9f15c6ee6e9ad208b72d20d34`

## 待办

1. 合并 PR #1。
2. 下载 run 42205805833 的 system / gecko artifact。
3. 创建 `v0.4.3` Release 并上传双 APK；`v0.4.2` 保持不动。
