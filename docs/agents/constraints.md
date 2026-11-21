# 两条硬约束

> 本文是 [AGENTS.md](../../AGENTS.md) 的分册之一，
索引见 [docs/agents/README.md](README.md)。

## 两条硬约束（改动前必读，改错不报错但真机必炸）

## 当前约束（2026-11-21 起；历史成因见 `docs/plan/refactor-single-host-purge.md`）

| 约束 | 现状 | 依据 |
|---|---|---|
| 包名 | `applicationId` = `io.github.ccch1mneyyy.dsh`（gecko: `io.github.ccch1mneyyy.dsh.webview`）；`namespace` 仍是 `com.dsh.android`（源码包，与安装包名无关） |
| 包名长度 | **已解除**，`applicationId` 可任意取 | P1/P2 之后运行期不再做任何 ELF 前缀重写（`patchElfInPlace` 已删）；`libproot.so` 里的 `com.termux` 只是默认值，被 `PROOT_LOADER` / `PROOT_TMP_DIR` / `LD_LIBRARY_PATH` 全覆盖 |
| targetSdk | **可抬**，逐档验（29 → 30 → 34），当前值看 `app/build.gradle.kts` | 内核 `execve` 面只剩 `nativeLibraryDir/*.so`（API 29 `execute_no_trans` 的官方例外）；rootfs 内 ELF 由 proot loader mmap，不经内核 exec |
| 可执行体位置 | jniLibs 四件套：`libproot.so` / `libproot-loader.so` / `libtalloc.so` / `libandroid-shmem.so` | P1；`assets/runtime/proot-libs` 已删除 |
| 宿主 | **只有 PRoot 一条**（`ProotHost`），无枚举、无 bionic 回落 | P2 |
| 运行时前缀 | guest 内 `/usr`；宿主 `files/` 下不得出现 `usr` / `termux` / `proot-libs` | P3（`purgeLegacy` + 启动 `sweepStale`） |

⚠️ 顶部让位必须取 `systemBars() or displayCutout()` 的并集：只取 `systemBars()`
时挖孔机上状态栏高度可能小于安全区，标题会钻进孔里。
键盘走 `ime()`；底边取 `max(navigationBars.bottom, ime.bottom)`，高度变化打一行
`键盘弹出/收起` 日志（便于真机排障）。

**targetSdk 35 的 edge-to-edge（别再用资源高度硬推）**
API 35 起系统强制 `decorFitsSystemWindows=false`，且 `statusBarColor` /
`navigationBarColor` 的赋值被忽略。做法：

```text
WindowCompat.setDecorFitsSystemWindows(window, false)
ViewCompat.setOnApplyWindowInsetsListener(binding.root) { … systemBars()/ime() … }
applyContentInsets()   // padding 加到 webContainer：全面屏 0，否则真实 inset
```

⚠️ 让位值必须取 `WindowInsets` 的**实际高度**：vc19「顶栏整行下移」就是把
`status_bar_height` 资源（物理像素）当 CSS 像素推给页面（36 变 108）。
`statusBarHeightPx()` 现在首选 `insetTopPx`。
⚠️ 系统栏区域的颜色现在由 **window 背景**提供（`applyPageBackground` 的
`setBackgroundDrawable`），不再是 `window.statusBarColor`。

**⚠️ 0.4.0 起包名回到 `com.dsh.android`**
决定：**新包名 `io.github.ccch1mneyyy.dsh` 不再使用**。理由是老用户可无感升级
（同包名 + 同签名即可覆盖），也不必再迁一次数据。
代价与注意事项：
- 覆盖安装的硬条件仍是「同包名 + 同签名」——历史包若不是本仓库证书签的，
  仍会 `UPDATE_INCOMPATIBLE`，必须先「导出 → 卸载 → 安装 → 导入」；
- 0.3.x（io.github…）那条线的数据要导回来：迁移向导现在**检测 `io.github.ccch1mneyyy.dsh`**；
- `KNOWN_PACKAGES` 仍含 4 个 id，双向导入不受影响。

**包名（`applicationId`）可以回退，但要算清代价**
`applicationId` 与 targetSdk、与「单运行时重构」**完全解耦** —— 换回去工程照样跑。
真正的约束只有一条：**覆盖安装要求「同包名 + 同签名」**。

| 场景 | 结果 |
|---|---|
| 旧包名 + 我方签名（与已装旧版不同） | `INSTALL_FAILED_UPDATE_INCOMPATIBLE` ⇒ 必须先卸载 ⇒ 旧数据全丢 |
| 旧包名 + 与已装版本**同一签名** | 可覆盖升级，数据保留（最省事的路） |
| 新包名（现状） | 与旧包可并存；代价是新安装，需导出→导入迁移 |

⚠️ 若回退包名，**已发布 `0.3.x`（新包名）用户的数据**在 `/data/data/io.github.ccch1mneyyy.dsh/`，
回退后不再被读取 —— 等于再迁移一次。`UserDataImporter.KNOWN_PACKAGES` 已含 4 个 id，可双向导入。

**⚠️ `HOME` 有三处来源，`launch.argv` 里那条最容易被忘**：
`runtime/manifest.json` 的 `launch.argv` 是 `/usr/bin/env -i HOME=/root …`，
`env -i` 之后逐条 `KEY=VALUE` 是**后者覆盖前者** —— 所以 `ProotHost` 的 `{GUEST_ENV}`
里必须再写一次 `HOME=`（`DSH_HOME` 早就这么覆盖了，`HOME` 曾经漏了，导致引擎进程
`$HOME=/root`，目录选择器打开空白）。
另外客户端会把上次浏览路径记在 localStorage，老用户升级后仍会跳 `/root`，
所以 `/root` 下也建同一组入口做兼容。

**⚠️ `$HOME` 必须 = `filesDir/home`，且 `home` 必须整体 bind 一次**：
只绑 `home/.dsh` + `files` 的**别名**时，guest 里的 `/data/data/<pkg>/files`
只是 proot 凑出来的骨架目录（只有 `.dsh`），选择器打开就是空列表（vc73 探针实测）。
`ProotHost` 现在显式 `bind(filesDir/home)`。

**⚠️ `$HOME` 必须 = `filesDir/home`**：目录选择器的起点是 `homedir()`。
P3 曾把它硬编码成 rootfs 的 `/root`，结果「选择工作区」对话框里**一行都没有**
（入口链接在 `filesDir/home`，选择器走的是 `/root`）。
现在由 `ProotHost` 注入 `DSH_USER_HOME`，`dsh-env.mjs` 读它；改这两处任一处都必须同步。

**新建工作区选文件夹**：`ensurePickerRoots()` 在 `filesDir/home` 下建三个入口链接 ——
`手机存储 → /sdcard`、`下载 → /sdcard/Download`、`应用目录 → filesDir`。
对话框起点是 HOME，点这三个入口即可进入各自的树；面包屑「主目录」可返回。
（链接只能建在 app 私有目录一侧：`/sdcard` 上 `symlink()` 返回 EPERM。）

**数据备份位置**：`UserDataExporter` 优先写公共下载目录；targetSdk 34 且没有「所有文件访问」时
会退到 `Android/data/<包名>/files/Download/` —— 该目录**随「清除数据 / 卸载」一起删除**。
迁移前务必先把备份复制出 app 专属目录（或先授权全盘访问）。

**启动就绪检查**：引擎打印 token 行之后仍可能短暂拿不到 HTTP 200/401（PRoot 里 listen 刚建立）。
`EngineManager` 在 20 s 窗口内每 400 ms 重试一次；只有重试窗口耗尽或进程已死才判启动失败，
失败信息里带「试了几次 / 最后错误」。

**34+ 的前台服务**：`startForeground` 必须能对上 manifest 的 `foregroundServiceType`，
`EngineService` 现在显式传 `FOREGROUND_SERVICE_TYPE_SPECIAL_USE`（API 34+ 分支），
manifest 侧同时有 `specialUse` + `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` 说明。
另外 targetSdk 30+ 的包可见性要求把 Shizuku Manager 写进 `<queries>`，否则特权通道会静默降级。

**30+ 的存储**：`requestLegacyExternalStorage` 被忽略，`READ/WRITE_EXTERNAL_STORAGE` 不再授予真 `/sdcard`；
要么让用户授予「所有文件访问」（`MANAGE_EXTERNAL_STORAGE`），要么走回退：guest 的 `/sdcard` 绑到
`Android/data/<包名>/files/sdcard`。回退下功能可用，但**路径不同**（`AndroidOpenWith` 的 `/sdcard` 归一化在这种状态下指不到真实文件）。

⚠️ 改包名仍有一件事要做：**换包名 = 新安装**，会话 / 凭据 / rootfs 都不继承，必须先 `UserDataExporter` 导出再导入。


