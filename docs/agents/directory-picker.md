# ③.5 目录选择器只在**一棵**树里走

> 本文是 [AGENTS.md](../../AGENTS.md) 的分册之一，
索引见 [docs/agents/README.md](README.md)。

### ③.5 目录选择器只在**一棵**树里走 —— 用 HOME 下的入口链接接上手机存储

**症状**：点「选择工作区」，对话框停在 `filesDir/home`（app 私有目录），
既看不到手机上的文件夹，也**走不上去**（面包屑起点就是那里），
「选一个手机上的文件夹当工作区」在 App 里根本做不到。

**根因有两层**：

1. `dsh-host-directory-picker-auto` 在 Android 上判成 **`browse`** 后端（判定表：
   非 darwin/win32、非带 `DISPLAY` 的 linux ⇒ `browse`），其 `list()` 在没给路径时
   用 `homedir()` 当起点，而本 App 把引擎 `HOME` 设成 `filesDir/home`。
2. **更要紧的是**：Android 上手机存储与 app 私有目录**互不可达** —— app 域连
   `readdir("/")`、`readdir("/data")` 都是 EACCES（见 ⑨ 的实测表）。所以起点放在
   **哪一边，另一边就永远进不去**。

⚠️ **第一版修法是错的，别再走回去**：当时把起点直接改成 `/sdcard`，手机文件夹能选了，
但用户**再也进不了 app 私有目录**（默认工作区就在那儿）。真机反馈后推翻。

**做法**：起点**留在 HOME**，在 HOME 下建两个入口符号链接：

```
filesDir/home/手机存储  → /sdcard      选手机上的任意文件夹
filesDir/home/应用目录  → filesDir     选/建 app 私有目录里的文件夹
```

用户在对话框里看到「主目录」下的两个入口，点进去各走各的树，点面包屑上的
「主目录」就能回来 —— **有入口、也有向上导航**。

⚠️ **链接只能建在 app 私有目录这一侧**：`/sdcard` 上 `symlink()` 返回 **EPERM**
（FUSE/sdcardfs 不支持）。所以不能反过来把私有目录的入口放进手机存储。

⚠️ **browse 后端会跟随符号链接**：`directoryRow()` 对 `isSymbolicLink()` 的条目补一次
`stat()`，是目录就照常列为可进入的文件夹。真机实测两个链接都 `enterable=true`，
且经链接列目录（145 项）、建文件夹、写文件全部成功。

⚠️ 用户拒绝存储权限时「手机存储」那行 `stat()` 失败 ⇒ `directoryRow()` 返回 null ⇒
**该行不显示**（官方逻辑，不会崩），只剩「应用目录」可用。

⚠️ **`home` 字段从头到尾没被碰过**：客户端 `displayCrumbs()` 拿 `listing.home` 折叠
面包屑。把 `home` 改掉会让面包屑塌成一项，用户失去向上导航 —— 入口链接方案能成立，
正是因为起点回到了 `home`。

⚠️ **改这一处必须同时「撤回」老安装里已打进去的补丁**：引擎解包目录只在版本戳变化时
才重解包（`ensureExtracted` + `.stamp`），光改代码不还原的话，老设备会永远停在
`/sdcard` 起点上。`EngineManager.restoreDirectoryPickerStart()` 就是干这个的，
幂等判据是「打过补丁的文本在不在」。

⚠️ 涉及的两个常量（`PICKER_START_GUARD` = 官方原文，`PICKER_START_ANCHOR` = 旧补丁
文本）**两个都必须逐字保留**：少一个，老安装就撤不回来。

代码：`restoreDirectoryPickerStart()` + `ensurePickerRoots()`，调用点在 `start()` 里
`patchAttachmentDurability()` 之后。日志验收：

```
已还原目录选择器的起始目录（改由主目录下的入口链接提供）
已建工作区入口: 手机存储 → /sdcard
已建工作区入口: 应用目录 → /data/user/0/com.dsh.android/files
```

（第二、三行只在第一次启动时出现；之后链接已就位，幂等跳过。）

