# 更新日志

## [Unreleased] — 收尾（无代码变更）

- 包名最终决定：**`com.dsh.android`**（0.4.1 起），不再变更；
- 工程进入**维护态**：只修 bug，不改身份与架构；
- 文档对齐：`AGENTS.md` / `docs/agents/constraints.md` / `docs/plan/…`；
- 设备侧清理：删除演练备份 `dsh-backup-drill.zip` 与 13 个历史 APK（约 2.4 GB）。

**不发新版**：本批只有文档与文件清理。
## [0.2.2-rc.5-debug] — 2026-11-22
vc=86
### 引擎升级（`0.2.2-rc.3` → `0.2.2-rc.5`）
- 引擎 `@deepseek-ai/dsh` **0.2.2-rc.5**；node `24.22.1` / pnpm `11.28.5` 与 rc.5 的 `engines` 要求一致；`native/` 侧 **0 变化**。
- 补丁：6 个 patch 对 rc.5 **全部可原样套用**（4 个包 `lib` 逐字节相同，`dsh-llm` 仅 1 行偏移自动吸收）；`pins.json` 新增 `0.2.2-rc.5` 节。
- `apk.yml` 删除写死的 `DSH_VERSION`，引擎版本**只由 `tools/engine-version.txt` 单一来源提供**；`REL_TAG` → `v0.2.2-rc.5-debug`。
- `sign-upgrade-apk.yml` 的 runtimeVersion 断言 → `dsh0.2.2-rc.5-`。

### rc.5 能力增量（引擎层全量继承）
- **web 搜索自动路由**：DeepSeek 模型会话走旧版 Messages 搜索（不计次费，按 token 计费，日志追加 `web/deepseek-search-llm-request`），其他路由走 DeepSeek Search API。
- LLM 错误分类（`dsh-llm/src/error.ts`）与 DeepSeek 翻译层（`llm-deepseek/src/translate.ts`）。
- 插件 API 目录（`tool-cordis` api-catalog）。
- 官方 `docs/upgrade-guide` 仅覆盖到 `v0.2.2-rc.4`；rc.5 无破坏性变更说明。

### 已知
- 引擎版本变化会让 `runtimeVersion`（含 `runtime/patches` 全部文件 sha）变化 ⇒ **升级后必重解一次 rootfs（~110 s）**，`files/home/.dsh` 与会话不受影响。

## [0.2.2-rc.3] — 2026-11-22
vc=85
### 重新发布（发布线重开）
- **内容等于 `0.4.1`**（单宿主 PRoot / targetSdk 35 / 包名 `com.dsh.android` / 引擎 `@deepseek-ai/dsh@0.2.2-rc.3`），仅**改名重发**；
- versionName **0.2.2-rc.3** / versionCode **85**；与 `0.4.1`（vc84）同签名，可覆盖安装；
- 发布线收敛：Release 只保留 `v0.2.2-rc.1` / `v0.4.2` / `v0.4.3` / `v0.2.2-rc.3`，其余 26 个历史 Release 与 tag 已删除；
- `v0.4.1` 已从 Release 下线，本机 `/sdcard/Download/dsh-rc3/upgrade/r041b.apk` 为唯一副本。
### 已知
- 历史 `0.2.2-rc.3`（vc54）已下线，同名 tag 重建指向本次提交（vc85）。

## [0.4.1] — 2026-11-22
vc=84

### 包名回到 `com.dsh.android`（新包名 `io.github.ccch1mneyyy.dsh` 不再使用）

| 项 | 0.3.x | 0.4.1 |
|---|---|---|
| system `applicationId` | `io.github.ccch1mneyyy.dsh` | **`com.dsh.android`** |
| gecko `applicationId` | `io.github.ccch1mneyyy.dsh.webview` | **`com.dsh.android.webview`** |
| `namespace` | `com.dsh.android` | 不变 |

**为什么能这样切**：包名与 targetSdk、与单运行时重构完全解耦 —— 只改 `applicationId`，
代码与运行时一处都不用动。

**代价（必须知道）**
- 覆盖安装要求「同包名 + **同签名**」。历史旧包若不是本仓库证书（`79d0dab6…dc96`）签的，
  装的时候仍会 `UPDATE_INCOMPATIBLE` —— 必须先「导出 → 卸载 → 安装 → 导入」。
- 0.3.x 的数据在 `/data/data/io.github.ccch1mneyyy.dsh/`，要导回：
  **迁移向导已改为检测该包名**，提示三步走。
- `KNOWN_PACKAGES` 仍含 4 个 id，导出→导入两个方向都通。

### 同步
- `tools/` 下开发脚本与 `mockall*.patch.yml` 的包名一并切回；
- `docs/agents/constraints.md` 记录决定与代价。

> 版本号选 `0.4.1` 而不是 `0.4.0`：`CHANGELOG` 里已存在历史上的 `## [0.4.0] — 2026-10-23`，避免重名。

## [0.3.6] — 2026-11-22
vc=83

### 迁移向导文案跟着**存储态**走
`0.3.3` 的向导只说「打开旧版导出」，但没说导出会落到哪 ——
在未授予「所有文件访问」时，备份落在 `Android/data/<包名>/files/Download`，
**卸载旧包会把它一起删**（`.14` 的坑）。

现在向导分两种文案：

| 存储态 | 第 ① 步文案 |
|---|---|
| 已授予所有文件访问 | 打开旧版 →「导出数据」（会存到 `/sdcard/Download`，卸载不删） |
| 未授予 | 先在本版授予「所有文件访问」再导出；否则备份会落在 `Android/data` 下，卸载旧包会一起删 |

### 文档
`docs/agents/constraints.md` 新增「**包名可以回退，但要算清代价**」：
覆盖安装要求「同包名 + 同签名」；回退包名等于让 `0.3.x` 用户的数据再迁移一次
（`KNOWN_PACKAGES` 已支持 4 个 id 双向导入）。

### 判据
```text
未授予（默认）：urandom 触发向导 → 第①步含「先在本版授予「所有文件访问」」
已授予：        第①步为「会存到 /sdcard/Download，卸载不删」
```

## [0.3.5] — 2026-11-22
vc=82

### 修复：导出的备份可能落进「卸载即删」的私有目录
`LogContext.publicExportDirOrNull()` 用 `WRITE_EXTERNAL_STORAGE` 判定能否写公共 Downloads ——
但 targetSdk ≥ 29 且无 legacy 时，该权限在系统侧**恒为未授予**（本机实测 `granted=false`）。
于是导出**永远**退到 `Android/data/<包名>/files/Download`，卸载/清数据即被删 ——
这正是「备份随卸载消失」的真实成因。

**改法**
- API 30+ 用 `Environment.isExternalStorageManager()`（「所有文件访问」）判定；
  低于 30 保留旧的 `WRITE_EXTERNAL_STORAGE` 判定。
- 落点打一行日志：`导出落点：公共 Download…` / `导出落点：私有目录 <path>（卸载会删）`。
- 启动时打 `存储态：isExternalStorageManager=true/false`，并注明 guest 的 `/sdcard`
  是真手机存储还是 app 私有副本。

### 判据
```text
未授予：日志「存储态：… false（guest /sdcard = app 私有副本）」
        导出 → 「导出落点：私有目录 …（卸载会删）」
已授予：日志「… true（guest /sdcard = 真手机存储）」
        导出 → 「导出落点：公共 Download」，文件在 /sdcard/Download
```

## [0.3.4] — 2026-11-22
vc=81

### 修复：设置 → 开发环境 显示「无法获取状态（引擎插件未激活？）」
**根因**（P4 换包名 + P3 去 Termux 的两处遗留叠加）：

1. 宿主 `ProotHost` **从未注入 `DSH_FILES`**；
2. 插件 `mobile-ui` 的兜底常量写死了旧包名 `com.dsh.android`。

于是插件拼出的 `/data/user/0/com.dsh.android/files/dsh-env.mjs` 根本不存在，
`spawn` 失败 → 返回 null → UI 显示「无法获取状态」。

**真机对照**：在 guest 内直接跑 `dsh-env.mjs status --json` 是**成功**的
（`exit=0`，返回完整 JSON，`builtin.node=v24.22.1`、`totalMb=363`）——
说明脚本本身没问题，纯粹是插件定位不到它。

**改法**
- `ProotHost` 注入 `DSH_FILES=<filesDir canonicalPath>`；
- 插件兜底改为 `DSH_FILES → dirname(dirname(DSH_HOME)) → cwd`，
  并删除 `termux/usr/bin/node` 分支（P3 之后那条路已不存在）。

### 工程化（B）
`publish-apk.yml` 增加 **versionCode 严格递增**校验：与上一个正式 release 比较，
不递增直接失败（防止旧版本被重新打 tag 覆盖线上产物）。读不到历史值时跳过，不阻塞首发布。

### 文档（R3）
`docs/agents/verification.md` 顶部加「历史文档（0.3.0 起不适用）」标注 ——
bionic / Termux 双宿主时代的验收步骤已在 P2/P3 删除，只作历史对照。

### 判据
```text
设置 → 开发环境：能看到 6 组（Node/Python/SSH/Java/Rust/Go）与「已用 N MB」
日志不再出现 `devenv status 失败`
```

## [0.3.3] — 2026-11-22
vc=80

### 新增：迁移向导（换包名不再「静默丢数据」）
P4 换包名后，旧包 `com.dsh.android` 与本版是**两个独立应用**：数据不通用，
卸载旧包会带走它的会话/凭据/引擎数据 —— 而此前界面上**没有任何提示**。

启动时检测旧包是否还在，在且本版**还没有会话数据**时弹一次三步向导：

```text
① 打开旧版 →「导出数据」
② 回到本版 →「导入数据」选刚导出的 zip
③ 确认会话都在，再卸载旧版
```

按钮：`打开旧版` / `稍后` / `不再提示`（后者写 `dsh_migration.dismissed`）。
本版已有 `home/.dsh/sessions` 时直接跳过，不打扰已迁移完成的用户。

### 调试入口（验收用）
```bash
adb shell am start -n io.github.ccch1mneyyy.dsh/com.dsh.android.MainActivity \
  -a com.dsh.android.action.MIGRATION_HINT --ez force true
```

### 判据
```text
有旧包 → 启动即弹「检测到旧版 DSH」，日志 migration 相关行
无旧包 → 不弹（绝大多数用户）
本版已有会话 → 不弹（日志「迁移向导跳过：本版已有会话数据」）
```

## [0.3.2] — 2026-11-22
vc=79

### 新增：全面屏有了用户入口（桌面长按快捷方式）
在此之前 `fullscreen` **只能**由模型调 `statusbar` 工具开启，用户想自己切一下没有任何
入口。现在长按桌面图标有两个动作：

```text
全面屏：开   → SystemBarAppearance.fullscreen = true
全面屏：关   → false
```

等价的命令行（验收用，也可自动化）：

```bash
adb shell am start -a com.dsh.android.action.FULLSCREEN \
  -n io.github.ccch1mneyyy.dsh/com.dsh.android.MainActivity --ez enable true
```

实现：`res/xml/shortcuts.xml` 两个 shortcut（`singleTask` 下走 `onNewIntent`）→
`MainActivity.handleFullscreenIntent()` → `SystemBarAppearance.apply(...)`，
与 `statusbar` 工具改的是**同一个字段**（会落盘、重启仍生效）。

### 判据
```text
am start -a com.dsh.android.action.FULLSCREEN … --ez enable true
  → 日志「快捷方式：全面屏=true」+「内容让位：top=0」
--ez enable false
  → 「内容让位：top=<状态栏高度>」
```

## [0.3.1] — 2026-11-22
vc=78

### edge-to-edge 加固
- 顶部让位改为 `systemBars() or displayCutout()` 的**并集**：只取 `systemBars()` 时，
  挖孔/刘海机型上状态栏高度可能小于安全区，页面标题会钻进孔里。
- 键盘：`ime()` 高度变化时打一行日志（`键盘弹出：ime=…px，底部让位=…` / `键盘收起`），
  真机上不接电脑也能从日志判读让位是否正确。

### 文档
- `docs/plan/…`：补「旧包 `com.dsh.android` 消失」的**归因结论** —— 用户手动卸载，
  与本工程清理逻辑无关（`purgeLegacy` 只动 `files/` 内 runtime 目录，从不 `pm uninstall`）。
  同时固化「换包名 = 新安装、旧数据不继承，删旧包前必须先导出」。
- `docs/agents/constraints.md`：insets 取并集的规则 + 键盘日志约定。

### 判据
```text
grep "键盘弹出" app.log   → ime>0 时出现一行，且底部让位 = ime（≥ 导航栏高度）
挖孔机：内容顶边 ≥ 挖孔安全区高度
```

## [0.3.0] — 2026-11-22
vc=77

**首个正式版**：`0.2.2-rc.1` 的 Android 移植完成单运行时架构重构后的定版。
预发布线 `0.3.0-refactor.0` … `0.3.0-refactor.21` 的改动全部收在本版内。

### 架构（P0–P6）

| 阶段 | 结果 |
|---|---|
| P0 | 基线快照（111 文件 / 3.2 MB + SHA256SUMS） |
| P1 | `libproot.so` / `libproot-loader.so` / `libtalloc.so` / `libandroid-shmem.so` 收进 jniLibs；`.dynstr` 等长原位改写（`patch-dynstr.py`），不用 patchelf |
| P2 | 单宿主化：删 `EngineHosts` / `TermuxBionicHost` / `ProotGlbcHost` / `EngineBootGate`（全零调用方） |
| P3 | 运行时去 Termux：13 处 `IS_PROOT` 双分支、`$PREFIX` 候选、三个前缀修补函数全删；`purgeLegacy`（删而不归档）+ `swapIn` 启动清扫 |
| P4 | 包名 `com.dsh.android` → `io.github.ccch1mneyyy.dsh`（只改 `applicationId`，`namespace` 不动） |
| P5 | targetSdk 29 → 30 → 34，逐档真机验；根治「`/data/user/0` 与 `/data/data` 两套前缀」 |
| P6 | bionic 出包链清零（`android-release.yml` / 7 个构建脚本 / `bootstrap-required.txt`）；引擎版本改单一来源 `tools/engine-version.txt` |

### 能力与修复

- **targetSdk 35**：系统强制 edge-to-edge，改用 `setDecorFitsSystemWindows(false)` +
  真实 `WindowInsets` 让位（`webContainer` padding），系统栏区域底色由 window 背景提供。
- **解包进度可见**：`State.Extracting` 接线（copy 0–30% / extract 30–98%）、
  `.xz` 已读字节做分母、通知权限推迟到 `UiStage.UiReady`（不再遮住进度）。
- **冷启 `HTTP=-1`**：健康探测改 20 s 窗口重试，失败文案带「试了 N 次 / 最后错误」。
- **工作区选择器**：`$HOME` 由宿主注入 `filesDir/home`、`home` 整体 bind、
  `/root` 下建兼容入口 —— 对话框可见「手机存储 / 下载 / 应用目录」三行并可进入。
- **数据迁移**：换包名后导出→清数据→导入实测通过；`exportResultText` 新增
  「卸载或清除数据会一起删掉备份」告警。

### 真机判据（全部实测）

```text
冷启          engine.ready × 3 连跑，engine.failed = 0
edge-to-edge  内容让位 top=152 == dumpsys statusBars [0,0][1280,152]
全面屏        top=0，--dsh-android-system-top = 47px（=152/3.2）
解包进度      10%→30%(copy)→40→52→61→74→80→93→100%，112.5 s 到 ready
选择器        ENTER_OK 手机存储=67 / 下载=32 / 应用目录=13
```

## [0.3.0-refactor.21] — 2026-11-22
vc=76

### targetSdk 35：edge-to-edge 改造（系统强制，必须自己让位）
API 35 起：`decorFitsSystemWindows` 恒为 false，`statusBarColor`/`navigationBarColor`
的赋值**被忽略**。原实现依赖「系统自动避开系统栏」，失效后表现为标题被时钟压住。

**改法**
- `MainActivity.enableEdgeToEdgeCompat()`：`setDecorFitsSystemWindows(false)` +
  `setOnApplyWindowInsetsListener(binding.root)`，`systemBars()` / `ime()` 的真实 insets
  落到 `webContainer` 的 padding；**全面屏时让位为 0**。
- 系统栏区域颜色改由 **window 背景** 提供（`applyPageBackground` 的 `setBackgroundDrawable`）。
- `statusBarHeightPx()` 首选运行期 `insetTopPx`（根治 vc19「整行下移」的物理/CSS 像素混用）。
- 键盘走 `ime` inset（edge-to-edge 下 `adjustResize` 不生效）。

### 判据
```text
内容顶边 y == 状态栏高度；全面屏时 == 0
键盘弹出：内容上移，输入框不被遮挡
```

## [0.3.0-refactor.20] — 2026-11-21
vc=75

### 修复（第三层，最终）：引擎进程的 `$HOME` 一直是 `/root`
vc74 截图：对话框路径框写着 **`/root/`**、下面空。查 `/proc/<proot pid>/cmdline`：

```text
HOME=/root
DSH_USER_HOME=/data/data/io.github.ccch1mneyyy.dsh/files/home
```

**根因**：`runtime/manifest.json` 的 `launch.argv` 是

```text
/usr/bin/env -i HOME=/root USER=root … DSH_HOME=/root/.dsh … {GUEST_ENV}
```

`env -i` 之后逐条 `KEY=VALUE` **后者覆盖前者**。`DSH_HOME` 早就在 `{GUEST_ENV}` 里
覆盖了（所以会话/凭据一直在 `files/home/.dsh`，没丢），但 **`HOME` 从没被覆盖** ——
引擎进程的 `$HOME` 始终是 `/root`；`dsh-env.mjs` 只影响它 spawn 的子进程。

**改法**
1. `ProotHost` 的 `{GUEST_ENV}` 里补 `HOME=<filesDir/home>`。
2. 兼容层：客户端把上次浏览路径记在 localStorage，老用户升级后**仍会跳 `/root`**，
   所以在 `rootfs/root` 下也建同一组入口（`手机存储 / 下载 / 应用目录`），每次启动重建。

### 判据
```text
/proc/<pid>/environ 里 HOME=/data/data/<pkg>/files/home
对话框（无论从 /root 还是 files/home 进）都能看到三行入口
```

## [0.3.0-refactor.19] — 2026-11-21
vc=74

### 修复（续）：选择器起点正确了，但目录里**只有 .dsh**
vc73 把 `HOME` 改成 `filesDir/home`，探针（`ProotProbeActivity` 内跑 node）实测：

```text
os.homedir=/root                                   ← 探针进程本身，不经过 dsh-env
DSH_USER_HOME=/data/data/<pkg>/files/home
probe root=/data/data/<pkg>/files/home
.dsh dir=true link=false  enterable=true          ← 只有 .dsh！
```

**根因**：`ProotHost` 只绑了 `home/.dsh` 与 `files` 的**别名**（`/data/user/0/...`），
`/data/data/<pkg>/files` 在 guest 内只是 proot 为 bind 目标凑出来的**骨架目录**，
所以 `files/home` 里只剩 `.dsh`，三个入口链接（手机存储/下载/应用目录）全部不可见。

**改法**：`ProotHost` 显式 `bind(filesDir/home)`，让 canonical 侧的 `home` 也是**真目录**。

### 判据（探针）
```text
.dsh / 下载 / 应用目录 / 手机存储 四行，全部 enterable=true
ENTER_OK 手机存储 entries=...   ENTER_OK 下载 entries=...
```

## [0.3.0-refactor.18] — 2026-11-21
vc=73

### 修复：新建工作区对话框里**一行都没有**
**现象**（vc72 真机截图）：点「新建工作区」→「选择工作区目录」，标题是「主目录」，
下面**空白**，看不到「手机存储 / 下载 / 应用目录」。

**根因**：`dsh-host-directory-picker-auto` 的 browse 后端在没给路径时用 `homedir()` 当起点。
`dsh-env.mjs` 在 P3（`refactor.3`，清退 Termux）时把 `HOME` 硬编码成 rootfs 的 **`/root`**，
而入口链接建在 **`filesDir/home`** —— 起点走错了树，列表自然为空。

**改法**
- `ProotHost` 注入 `DSH_USER_HOME = filesDir/home`（canonicalPath，guest 内可见）。
- `dsh-env.mjs` 的 `HOME` 改为读 `DSH_USER_HOME`，兜底 `/root`。
- `docs/agents/constraints.md` 记下「`$HOME` 必须是 filesDir/home」。

### 判据
```text
对话框打开即列出「手机存储 / 下载 / 应用目录」三行
点「手机存储」可逐级进入并新建文件夹
```

## [0.3.0-refactor.17] — 2026-11-21
vc=72

### 可观测性：解包进度每 10% 记一行日志
真机验收时设备可能处于锁屏/息屏（AOD），uiautomator 抓不到界面。为了让「进度是否在推进」
可被**离线证据**证明（也方便用户报「卡住」时定位卡在 copy 还是 extract），
`EngineManager` 在进度回调里每跨 10% 打一行：

```text
runtime progress 30% (extract)
runtime progress 40% (extract)
...
```

### 判据
```text
pm clear → 启动 → grep "runtime progress" app.log
应看到 0/10/…/90/100 递增，且 phase 从 copy 过渡到 extract
```

## [0.3.0-refactor.16] — 2026-11-21
vc=71

### 修复（续）：解包进度仍看不见 —— 真因是**通知权限弹窗盖住了**
vc70 把进度接到了 `State.Extracting`，但真机复测仍然看不到百分比：
`POST_NOTIFICATIONS` 是在 `ensureStorageAccess()` 里、**解包开始之前**申请的，
系统弹窗（「允许"DSH"发送通知？」）停在整个解包过程之上 —— uiautomator 只能看到那个弹窗。

**改法**
- `storagePermissionLauncher` 回调里不再立刻申请通知权限（只记日志）。
- `ensureStorageAccess()` 的早返回路径同样不再申请。
- 新增幂等包装 `ensureNotificationAccessAfterUiReady()`，在 **`UiStage.UiReady`**（界面可用）时申请一次。

效果：解包全程只有 App 自己的覆盖层，`正在解包引擎 N%` 可见；权限弹窗出现在界面可用之后。

### 判据
```text
pm clear 后首启：解包期间 uiautomator 能读到「首次启动，正在解包引擎 N%」且 N 增长
界面可用后才出现通知权限弹窗
```

## [0.3.0-refactor.15] — 2026-11-21
vc=70

### 修复：解包时进度条消失 / 没有百分比
**根因**：`startProot()` 的 `installer.ensure(...)` 回调**只写日志**，从不更新 `State`；
`State.Extracting` 只被 0.5.0 之前的 bionic 解包路径使用。于是 PRoot 解包 1.3 GB 期间，
界面停在「正在启动引擎…」，用户看到的是「进度消失/卡死」。

**改法**
- `RootfsInstaller.extractXz()`：新增 `CountingInput` 统计 **.xz 已读字节**，把
  `Progress("extract", done, total)` 的 `total` 从 `-1` 改成真实压缩包长度。
- `EngineManager.startProot()`：按 **copy 0–30% / extract 30–98%** 加权，节流后写
  `State.Extracting(pct)`；解包结束立刻回到 `State.Starting`。

### 增强：新建工作区怎么选「其它文件夹」
`ensurePickerRoots()` 在 `filesDir/home` 下建三个入口链接：

```text
手机存储 → /sdcard
下载     → /sdcard/Download      ← 本次新增，最常用
应用目录 → filesDir
```

对话框起点是 HOME，点进去即可浏览；面包屑「主目录」返回。

### 判据
```text
清数据后首启：覆盖层出现「首次启动，正在解包引擎 N%」且 N 单调增长到 98→100
文件选择器里能看到「手机存储 / 下载 / 应用目录」三行
```

## [0.3.0-refactor.14] — 2026-11-21
vc=69

### 数据迁移演练（真机，新包 `io.github.ccch1mneyyy.dsh`）
流程：**导出 → `pm clear` 清数据 → 重新启动 → 导入 → 内容指纹核对**

| 阶段 | 实测 |
|---|---|
| 导出 | 2 个会话 + profiles/storages/skills，共 18 条目 / 56.0 KB；落点 `Android/data/<包名>/files/Download/dsh-backup-20261121-133626.zip` |
| 清数据 | `pm clear` Success；rootfs 与 `home/.dsh` 全清，重启后引擎自造 1 个新会话 `session-9aa04eb6…` |
| 导入 | 选 `dsh-backup-drill.zip` → 「开始恢复」 |
| 核对 | 会话目录恢复为 **`session-9bb9e914…` + `session-a97fddd5…`**（正是备份里那两个），`home/.dsh` 文件数回到 **89** |

### 演练暴露的真问题（本版修复）
`pm clear` 会**连 app 专属外部目录一起删**：第一次导出的两份 zip 在
`Android/data/<包名>/files/Download/` 里，清数据后全没了。

- `BackupDialog.exportResultText()`：当导出位置在 `Android/data/**` 或 `filesDir` 下时，Toast 追加
  「⚠️ 卸载或清除数据会一起删掉；建议先复制到「下载」/ 发给自己；授予「所有文件访问」后会直接写公共下载目录」。
- `docs/agents/constraints.md` 新增「数据备份位置」一节。

### 判据
```text
导出到 app 专属目录 → Toast 含「卸载或清除数据会一起删掉」
有全盘权限时 → 直接写公共 Download，无该提示
```

## [0.3.0-refactor.13] — 2026-11-21
vc=68

### 修复：冷启偶发「引擎就绪检查失败：HTTP=-1」
**现象**：安装后首次启动，引擎已打印 `dsh web <url>?token=…`，但紧接着的健康检查拿到 `HTTP=-1`，
整次启动被判失败（vc66 实测 59 s 时命中；第二次启动 13 s 正常出首帧）。

**根因**：就绪判定只做**一次** 3 s HTTP 探测。PRoot 里 node 的 `listen` 建立与 `accept` 队列就绪
之间有毫秒级间隙，单次探测正好撞上就得到 `-1`，而 `-1` 又不带原因，现场只剩一句「HTTP=-1」。

**改法**
- `ProotHost.healthProbe()` 取代 `health()`：返回 `(HTTP 码, 失败原因)`，`health()` 保留为薄包装。
- `EngineManager`：token 到达后按 **20 s 窗口 / 400 ms 间隔**重试探测；`!host.isAlive()` 立即停。
- 失败信息升级为：`HTTP=<code>（试了 N 次 / 20000ms 窗口；最后错误：<异常类型: 消息>）`。

### 判据
```text
冷启（force-stop 后首启）：引擎起 → 首帧，无 HTTP=-1 误判
人为把窗口压到 1ms 时：失败信息应包含「试了 N 次」「最后错误」
```

## [0.3.0-refactor.12] — 2026-11-21
vc=67

### 变更（P4：解除包名限制，换 applicationId）
- `applicationId`：`com.dsh.android` → **`io.github.ccch1mneyyy.dsh`**；gecko flavor → **`io.github.ccch1mneyyy.dsh.webview`**。
- **`namespace` 保持 `com.dsh.android`**：它是源码包（R / BuildConfig 的包），与安装包名无关；
  改它要搬几百个文件与全部 import，收益为零。
- `UserDataImporter.KNOWN_PACKAGES`：加入两个新 id，**保留两个旧 id** —— 老备份仍能导进来。
- 工具脚本默认包名同步：`apply-clickfix.sh`（可用 `PKG=` 覆盖）、`mcp-android-ui.mjs`、
  `dsh-sessions.sh`、`mockrun.sh`、`build-uiagent-screens.mjs`；mock 夹具里的插件绝对路径也一并改。
- 文档：`AGENTS.md` / `docs/agents/constraints.md` 的约束表新增包名一行。

### 数据迁移（换名 = 新安装，不继承）
1. 旧包（`com.dsh.android`）里：设置页 →「导出数据」，选会话/凭据/工作区，存到 `/sdcard/Download`
2. 安装新包（`io.github.ccch1mneyyy.dsh`）—— **两个包可以同时装着**，不冲突
3. 新包里：设置页 →「导入数据」，选刚才的归档；导入器会把归档里旧包名的绝对路径改写成新包名

### 判据
```text
aapt/dumpsys: 新包 applicationId = io.github.ccch1mneyyy.dsh，namespace 仍是 com.dsh.android
新包首启：解包 rootfs → 引擎起 → 首帧
旧包仍在、数据未动（可随时回退）
```

## [0.3.0-refactor.11] — 2026-11-21
vc=66

### 变更（P6 收尾第二批：删 bionic 构建脚本，version.sh 改单一来源）
- **`tools/version.sh`**：引擎版本不再从四个 bionic 脚本里 `sed`，改为读 **`tools/engine-version.txt`** 单一来源；
  `verify-engine-upgrade.sh` 的断言串若还在就作交叉校验（不一致才报错）。汇总行改用 `ENG_SRC`。
- **删除 7 个 bionic 构建脚本**（0.5.0 单运行时后不产出任何东西，`apk.yml` 也不执行它们）：
  `build-engine-bin.sh`、`build-native-assets.sh`、`build-node-pty.sh`、`build-extra-native.sh`、
  `build-node-addon-system.sh`、`build-node-addon-require-builtin.sh`、`node-runtime-wrap.sh`。
- `apk.yml`：去掉这 7 个脚本的路径触发。
- `EngineManager`：注释里「由 `tools/build-engine-bin.sh` 生成」改为历史说明。

### 判据
```text
tools/version.sh --check → VERSION PASS，且多出一行「引擎版本单一来源 0.2.2-rc.3」
grep -rn "build-engine-bin|build-node-runtime|build-bootstrap" tools .github  → 0
apk.yml 全绿，装机后引擎照常起
```

## [0.3.0-refactor.10] — 2026-11-21
vc=65

### 变更（P6 收尾第一批：清 bionic 出包链）
- **删除** `.github/workflows/android-release.yml`：0.5.0 之前的 bionic 出包链，会现场造
  `bootstrap-aarch64.zip` 并断言它在 APK 里，与当前单运行时无关（且只手动触发，从不随 tag 跑）。
- **删除** `tools/build-bootstrap.sh`、`tools/bootstrap-required.txt`。
- `tools/check-apk-assets.py`：去掉 bootstrap 的 soname 深检（连同 `required_sonames()`）。
- `tools/ci-fetch-assets.sh`：`REQUIRED` 去掉 `bootstrap-aarch64.zip`。
- `tools/verify-ci.py`：默认查询的工作流 `android-release` → `apk`。
- `docs/agents/release-signing.md`：CI 段改写为现行三段式（apk → sign → publish），并说明旧链已删。

### 判据
```text
grep -rn "bootstrap" .github tools app/build.gradle.kts  → 只剩历史文档
apk.yml / verify.py / check-apk-assets.py 全绿
```

### 已知（下一批）
- 仍有 bionic 期构建脚本：`build-engine-bin.sh` / `build-node-runtime.sh` / `build-native-assets.sh`
  / `build-node-pty.sh` / `build-extra-native.sh` / `build-node-addon-*.sh`。
  它们与 `tools/version.sh` 有耦合（version.sh 会从 `build-engine-bin.sh` 等抓引擎版本串做一致性校验），
  删除必须同时改 `version.sh`，因此单独一批处理。

## [0.3.0-refactor.9] — 2026-11-21
vc=64

### 变更（P5 第三档：targetSdk 30 → 34）
- `targetSdk = 34`（P5 最后一档）。
- `EngineService`：API 34+ 改用三参 `startForeground(..., FOREGROUND_SERVICE_TYPE_SPECIAL_USE)`，
  与 manifest 的 `foregroundServiceType="specialUse"` + `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` 对齐。
- `AndroidManifest.xml`：新增 `<queries><package android:name="moe.shizuku.privileged.api"/></queries>`
  —— targetSdk 30+ 的包可见性会让 `getPackageInfo` 抛 NameNotFound，Shizuku 特权通道会静默降级。
- 检查结论（本档无需改动）：`PendingIntent` 已全部带 `FLAG_IMMUTABLE`（AdbPairing 的可变那条带 `FLAG_MUTABLE`）；
  所有组件 `android:exported` 都已显式声明；全仓无 `registerReceiver`（34 的 receiver 导出标志要求不触发）。

### 判据
```text
装机 targetSdk=34
引擎起（token + 首帧）；前台服务通知在
Shizuku 桥仍就绪（log：Shizuku 桥已就绪）
无 EACCES / avc: denied / MissingForegroundServiceType
```

### 已知
- 35（edge-to-edge 强制）**没做**：`SystemBarAppearance` 有 vc19 回归史，作为独立议题排期。
- 下一步是 P4（包名）与 P6（收尾）。

## [0.3.0-refactor.8] — 2026-11-21
vc=63

### 修复（vc61/vc62 引擎起不来的完整根因）
两套前缀不一致，guest 里只存在一种：

```text
File.absolutePath  = /data/user/0/com.dsh.android/files/...   ← assets/overlay 里大量用它
File.canonicalPath = /data/data/com.dsh.android/files/...     ← ProotHost 只绑了这条
```

vc62 只修了 `--patch` 的参数（改用 canonical），但 overlay **内容**里仍然写着
`/data/user/0/.../agnes-multimodal/...` 之类的插件路径 ⇒ 14 个插件 `ERR_MODULE_NOT_FOUND`，引擎退出。

本版一次性解决：在 guest 里为 `filesDir` **增加别名绑定**
`-b <canonical filesDir>:<absolute filesDir>`，两套前缀都成立。
既有资产、overlay、以及未来任何用 `absolutePath` 拼出来的 guest 路径都不会再 ENOENT。

### 判据
```text
targetSdk=30；引擎打印 token 行 + 首帧
0 个 failed to import
```

## [0.3.0-refactor.7] — 2026-11-21
vc=62

### 修复（vc61 起不来的真因）
`ProotHost` 把 overlay 列表以 **`absolutePath`** 传给 guest 的 `--patch`，而 `dshHome` 是按
**`canonicalPath`** 绑定进 guest 的：

```text
dshHome.absolutePath  = /data/user/0/com.dsh.android/files/home/.dsh   ← guest 里不存在
dshHome.canonicalPath = /data/data/com.dsh.android/files/home/.dsh     ← guest 里唯一存在
```

引擎启动即 `ENOENT: failed to read overlay .../mobile-ui.patch.yml`，5 秒内退出。
`envFile` 早在用 `canonicalPath`（注释写着「按原绝对路径绑定，guest 内逐字有效」），
overlay 这条漏了。改为 `overlays.map { it.canonicalPath }`。

### 同版包含
- P5 第二档（targetSdk 30）：`MANAGE_EXTERNAL_STORAGE`、30+ 引导「所有文件访问」、
  `/sdcard` 三级取源（全盘 → app 外部目录 → 老逻辑）、`bind /sdcard ->` 日志。

### 判据
```text
引擎正常起（token 行 + 首帧）
无 failed to read overlay
targetSdk=30；logcat 见 bind / sdcard -> <路径>
```

## [0.3.0-refactor.6] — 2026-11-21
vc=61

### 变更（P5 第二档：targetSdk 29 → 30）
- `targetSdk = 30`。API 30 起 `requestLegacyExternalStorage` 被系统**忽略**，`READ/WRITE_EXTERNAL_STORAGE`
  不再授予真 `/sdcard` 的任意访问 —— 本档必须处理存储模型。
- `AndroidManifest.xml` 声明 `MANAGE_EXTERNAL_STORAGE`（`tools:ignore="ScopedStorage"`），并改写那段
  「targetSdk=28 不必申请」的过期注释。
- `MainActivity.ensureStorageAccess()`：30+ 且未授予「所有文件访问」时**引导一次**
  （`ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION`，失败退 `ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION`），
  `SharedPreferences` 记名，不反复弹设置页。
- `ProotHost.defaultPhoneStorage()` 三级取源：
  ① 30+ 且有全盘权限 → 真 `/storage/emulated/0`
  ② 30+ 且无 → `Android/data/<包名>/files/sdcard`（app 专属，始终可写）
  ③ 29- → 老逻辑（有 READ_EXTERNAL 就给真 /sdcard）
- 绑定点加日志 `bind /sdcard -> <宿主绝对路径>`，真机排障一眼看出走哪一级。

### 判据
```text
装机 targetSdk=30
有全盘权限：guest /sdcard -> /storage/emulated/0
无全盘权限：guest /sdcard -> Android/data/<包名>/files/sdcard，且写入成功
引擎照常起，日志无 EACCES / avc: denied
```

### 已知
- 回退状态下「路径不同」：`AndroidOpenWith` 把 `/sdcard/...` 归一化成 `primary:` 的 content URI，
  这种状态下指不到真实文件。要彻底一致，必须让用户授予全盘访问。
- 34 档还要处理 FGS 类型与 edge-to-edge（`SystemBarAppearance` 有 vc19 回归史）。

## [0.3.0-refactor.5] — 2026-11-21
vc=60

### 变更（P5 第一档：targetSdk 28 → 29）
- `targetSdk = 29`；`AndroidManifest.xml` 显式 `requestLegacyExternalStorage="true"`
  （API 29 仍支持 legacy 存储模型，`/sdcard` 直读直写行为不变）。
- **注释与文档修订**（旧文档仍在说「必须 15 字符 / 必须 28」，会误导下一次改动）：
  `app/build.gradle.kts` 两段、`AGENTS.md`「两条硬约束」整节、`docs/agents/constraints.md`、
  `docs/agents/dev-env.md`（11 处失效路径与已删脚本）、`EngineManager` 顶部架构注释、`DshApplication` 注释。

### 判据（本档必须逐条过）
```text
首启解包（1.3 GB）成功
工作区选 /sdcard/... 可读写
悬浮球 + 无障碍 + 截图可用
切后台 10 min 引擎不断连
日志无 EACCES / avc: denied
```

### 已知
- 下一档 30 需要 `MANAGE_EXTERNAL_STORAGE`（API 30 起 legacy 失效），届时 `READ/WRITE_EXTERNAL_STORAGE` 不再够用
- 34 还要处理 FGS 类型与 edge-to-edge（`SystemBarAppearance` 有回归史）

## [0.3.0-refactor.4] — 2026-11-21
vc=59

### 变更（P3 修订）
- **启动时也清扫**：`EngineManager` 在构造 `ProotHost` 之前调 `RuntimeFiles.sweepStale(runtime)`。
  vc58 只在 `RootfsInstaller` 的安装路径里清扫，而「装到一半被杀」的残骸因为 `.rootfs.stamp`
  仍然命中，永远不会再进安装路径 —— 真机实测就留下过 695 MB 的 `rootfs.staging-*`。
- 其余与 `0.3.0-refactor.3` 相同（P3：运行时去 Termux）。

### 判据
- 人为造一个 `files/runtime/rootfs.staging-probe/`，重启 App 后该目录消失，日志出现「启动清扫残留：…」
- 引擎照常起

## [0.3.0-refactor.3] — 2026-11-20
vc=58

### 变更（P3 · 运行时去 Termux）

| 文件 | 改动 |
|---|---|
| `assets/dsh-env.mjs` | 删 `IS_PROOT` 双分支（13 处）、`termux/usr` 兜底、`$PREFIX` 候选；`PREFIX=/usr`、`HOME=/root` 固定；`DSH_FILES` 改为「env 优先，否则取脚本自身所在目录」，不再写死任何 applicationId |
| 同上 | 删 `rewriteTermuxPaths` / `fixGradleLauncher` / `fixPrefixShims` 三个 Termux 专有修补 |
| `assets/check-devenv.mjs` | 删 `files/termux/usr/bin/node` 兜底与写死包名；`NODE=/usr/local/bin/node` |
| `assets/dsh-android-shell.mjs` | `runLocal` 候选表固定为 `/bin/bash` → `/usr/bin/bash` → `/system/bin/sh`，不再看 `$PREFIX`；错误文案不再打印 PREFIX |
| `runtime/RuntimeFiles.kt` | `retireLegacy`（归档）→ `purgeLegacy`（**删除**）：`engine` / `usr` / `termux` / `proot-libs` / `runtime/legacy-bionic` |
| 同上 | 新增 `sweepStale(runtimeDir)`：删 `rootfs.staging-*`、`rootfs.old-*` |
| `runtime/RootfsInstaller.kt` | 安装前调用 `sweepStale` 并记日志 |
| `EngineManager.kt` | 调用点改 `purgeLegacy`，事件名 `runtime.migration` → `runtime.purge` |
| `app/src/test/.../RuntimeS6Test.kt` | 单测跟随删除语义 |
| `tools/dsh-env.sh`、`tools/env-smoke.sh`、`tools/dsh-env.mjs`、`tools/check-devenv.mjs` | 删除（前两个 shebang/前缀指向 termux，后两个是 assets 的过期副本） |

### 判据
- `grep -rn "termux|Termux" app/src tools --include=*.mjs --include=*.sh` = 0
- `grep -rn "IS_PROOT" app/src` = 0
- 设备 `files/` 下无 `usr` / `termux` / `proot-libs`
- 引擎照常起、`dsh-env.mjs status --json` 可用

### 已知
- Kotlin **文档注释**里仍有历史说明（`EngineManager` 顶部「为什么用 Termux 的 node 构建」等），P6 统一清扫
- `docs/agents/dev-env.md` 等文档仍指向已删脚本，P6 同步
- 无线调试的 `adb` 二进制保持不动：它在 **guest 内**由 runner spawn，走 proot loader，不占 API 29 的 exec 面（P5 再评估）

## [0.3.0-refactor.2] — 2026-11-20
vc=57

### 变更
- **P2 · 单宿主化**：删除整条「宿主可选择」链路 —— `HostMode` 三值枚举、`TermuxBionicHost`、`ProotGlbcHost`、`EngineHost` 抽象、`EngineBootGate`（含必失败的 bionic 回落）、`HostSettingsSection`（零调用方的死 UI）。
- `EngineManager`：删 `bootWithHost()` / `legacyEndpointProvider` / `hostCapabilities()` —— 三者均**零调用方**；本地启动只剩一条 `ProotHost` 路径。
- `EngineHost.kt` 收敛为只剩 `EngineHostException`。
- 效果：启动失败不再被「回落 bionic」覆盖成第二条错误，第一条真实原因直达日志与界面。

### 判据
- `grep -rn "HostMode|TermuxBionicHost|ProotGlbcHost|EngineHosts|EngineBootGate|HostSettingsSection" app/src` = 0
- 启动日志 `宿主=proot`；破坏 rootfs 后首条错误即真因
- 引擎照常起，菜单与会话不受影响

### 已知
- 远端引擎（原 `RemoteHost`）随之移除：它此前只被 `EngineHosts.create` 引用，而后者零调用方 ⇒ 功能上从未接通。要做远端作为独立功能另行立项，不进本阶段。
- targetSdk 仍 28、包名仍 `com.dsh.android`（P4/P5）。

## [0.3.0-refactor.1] — 2026-11-20
vc=56

### 变更
- **P1 · jniLibs 全面化**：`libtalloc.so` / `libandroid-shmem.so` 收进 jniLibs；`assets/runtime/proot-libs/` 与 `files/proot-libs` 彻底移除。
- 新增 `tools/runtime/patch-dynstr.py`：对 `libproot.so` 的 `.dynstr` 做**等长原地改写**（`libtalloc.so.2` → `libtalloc.so`），不动节表、不改文件大小（patchelf 方案实测 SIGSEGV，故不用）。
- `ProotHost`：删 `ensureProotLibs()` 与 `LIB_LOCK`，`LD_LIBRARY_PATH` 只保留 `nativeLibraryDir`。
- 原生来源单一化：`nativeLibraryDir` 现有 4 个 `.so`（libproot / libproot-loader / libtalloc / libandroid-shmem）。

### 判据
- APK `lib/arm64-v8a/` 四件套齐全；设备 `runtime/manifest.json` 的 `jniLibs` 为 4 项。
- 引擎照常起（token 行可解析）；`files/` 下无 `proot-libs`。

### 已知
- 本阶段未改 targetSdk / 包名（P4/P5）。

## [0.3.0-refactor.0] — 2026-11-20
vc=55

### 变更
- **重构基线包**：本版**不含重构改动**，代码与 `0.2.2-rc.3` 功能等价，仅版本号前移，用作 A/B 对照与「重构后是否回归」的判据。
- versionName **0.3.0-refactor.0** / versionCode **55**；与 `0.2.2-rc.3`(vc54) 同签名，可覆盖安装。
- 引擎 `@deepseek-ai/dsh` **0.2.2-rc.3**（PRoot 单运行时）；移动端 UI **1.1.0-194**。
- 重构主线立项：[`docs/plan/refactor-single-host-purge.md`](docs/plan/refactor-single-host-purge.md)（P0–P6：单宿主 / 运行时去 Termux / 解除包名与 targetSdk 限制）。

### 已知
- targetSdk 仍为 28、包名仍为 `com.dsh.android`（P4/P5 才改）。
- 构建期仍从 Termux deb 取 proot/talloc/shmem（P3 只归零运行时依赖）。

## [0.2.2-rc.3]（vc54，已下线） — 2026-11-18
vc=54
### 变更
- 引擎 `@deepseek-ai/dsh` **0.2.2-rc.3**（正式版位，非 prerelease）。
- versionName **0.2.2-rc.3** / versionCode **54**；发行签名 `79d0dab6…dc96`，与 `0.2.2-rc.3-debug`(vc53) 同源，可直接覆盖升级。
- 移动端 UI **1.1.0-189**（修复 43：官方项齐后才注入，「⋯」点击不再改 DOM）。
- 构建变体：`system` + `release`（`assembleSystemRelease`），不走 debug 签名。

### 已知
- 「⋯」首次点击需点两次（待修 44）；插件市场两项为两段式渲染（待修 45）。

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
## [0.2.2-rc.3-debug] — 2026-11-18
vc=53

### 变更

- 引擎 `@deepseek-ai/dsh` **0.2.2-rc.3**（显式版本；`latest` 仍指 rc.1，不写死版本会静默拉回旧版）。
- versionName **0.2.2-rc.3-debug** / versionCode **53**；调试签名不变，`pm install -r` 覆盖升级，不卸载、不清数据。
- 移动端 UI **1.1.0-186**。
- **补丁语料按 rc.3 重建**：`IMG_TYPE_GUARD` / `IMG_TYPE_ANCHOR` 改为 rc.3 压缩后的单行 `isImageMediaType` 形态；`make-patches.py` 改为按版本合并 pin（不再覆盖 rc.1 记录）。
- **构建期补丁门禁**：`apply-patches.py --require-version`，缺当前版本 pin 即构建失败；`build-runtime.sh` 的 `DSH_VERSION` 改读 `tools/engine-version.txt`，`PNPM_VERSION` 对齐 `11.28.5`。
- **空间预检**：`ASSUME_UNPACKED_BYTES` `1_350` → `3_400` MiB（升级峰值 = 旧 rootfs + staging + 缓存归档）。
- **CI**：`apk.yml` 注入 `DSH_VERSION`；`REL_TAG`、资产名与 Release 说明改为动态取值；发布步骤默认关闭（`vars.PUBLISH_FROM_APK`），改由 `publish-apk.yml` 手动派发；`verify-ci.py --workflow apk.yml`。
- Office Kit 保留（`office_convert` / `office_render` / `office_recalculate`），未做重包裁剪。

### 修复

- **单运行时验收路径**：旧脚本仍指向 bionic 时代的 `files/termux/usr/bin/node` 与 `files/engine`。新增 `ProotProbeActivity --es run_script` 的 proot 执行通道与宿主侧 `tools/verify-rc3-device.sh`；rootfs 的 `usr/bin/node` 是 glibc ELF，不能 `run-as` 裸跑。
- `verify-ci.py` 固定查询 `android-release.yml`，与 `apk.yml` 出包链路不符 → 支持 `--workflow`。

### 验收

```text
sh tools/version.sh --check                        → VERSION PASS（vc=53 / engine=0.2.2-rc.3）
node tools/check-engine-anchors.mjs /root/dsh-rc3  → 5/5，EXIT=0
runtime/patches/pins.json                          → 6 个补丁 × {0.2.2-rc.1, 0.2.2-rc.3}
tools/verify-rc3-device.sh                         → engine=0.2.2-rc.3 / patch-marks=5/5
```

## [0.2.2-rc.1] — 2026-11-16
vc=52
### 变更
- **版本号对齐 DSH 引擎 `0.2.2-rc.1`**：原 `0.5.0` 命名作废，`versionName` 改为
  `0.2.2-rc.1`、`versionCode=52`（`tools/app-version.txt` 同步）。
- 随附移动端 UI `1.1.0-185`：插件页 ⓘ/▾ 点击修复、三入口市场滚动适配、
  登录授权页交系统默认浏览器打开。
- 其余变更沿用下方 `0.5.0` 小节。

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
- **window.open 页面级接管（1.1.0-185）**：WebView 里 `window.open` 返回的弹窗不会
  真的导航，登录授权页既不显示也不外跳。移动端插件在页面里接管 `window.open`：
  真实 URL 直接走主框架导航（宿主 `shouldOverrideUrlLoading` 转 `ACTION_VIEW`），
  `about:blank` 预开窗口返回带 `location.replace/assign` 的代理，同样落到默认浏览器。
- **外链与登录统一走系统默认浏览器**：`window.open` 预开的 `about:blank`
  窗口原先只交给内核、从未挂到任何窗口上，导致登录授权页既不渲染也不
  导航（日志停在「已建空白窗口」）；插件市场里用 `window.open` 打开的
  收录插件页同样静默失效。现在给 popup 挂一个 1×1 隐形宿主让内核能
  调度导航，首个非本地 URL 立即交给系统默认浏览器（如 Chrome），
  并回收宿主与 WebView。`onCreateWindow` 已知 URL 的情况保持直接外跳。
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
