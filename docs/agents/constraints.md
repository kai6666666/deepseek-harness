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


