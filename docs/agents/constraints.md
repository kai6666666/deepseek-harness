# 两条硬约束

> 本文是 [AGENTS.md](../../AGENTS.md) 的分册之一，
索引见 [docs/agents/README.md](README.md)。

## 两条硬约束（改动前必读，改错不报错但真机必炸）

## 当前约束（2026-11-21 起；历史成因见 `docs/plan/refactor-single-host-purge.md`）

| 约束 | 现状 | 依据 |
|---|---|---|
| 包名长度 | **已解除**，`applicationId` 可任意取 | P1/P2 之后运行期不再做任何 ELF 前缀重写（`patchElfInPlace` 已删）；`libproot.so` 里的 `com.termux` 只是默认值，被 `PROOT_LOADER` / `PROOT_TMP_DIR` / `LD_LIBRARY_PATH` 全覆盖 |
| targetSdk | **可抬**，逐档验（29 → 30 → 34），当前值看 `app/build.gradle.kts` | 内核 `execve` 面只剩 `nativeLibraryDir/*.so`（API 29 `execute_no_trans` 的官方例外）；rootfs 内 ELF 由 proot loader mmap，不经内核 exec |
| 可执行体位置 | jniLibs 四件套：`libproot.so` / `libproot-loader.so` / `libtalloc.so` / `libandroid-shmem.so` | P1；`assets/runtime/proot-libs` 已删除 |
| 宿主 | **只有 PRoot 一条**（`ProotHost`），无枚举、无 bionic 回落 | P2 |
| 运行时前缀 | guest 内 `/usr`；宿主 `files/` 下不得出现 `usr` / `termux` / `proot-libs` | P3（`purgeLegacy` + 启动 `sweepStale`） |

⚠️ 改包名仍有一件事要做：**换包名 = 新安装**，会话 / 凭据 / rootfs 都不继承，必须先 `UserDataExporter` 导出再导入。


