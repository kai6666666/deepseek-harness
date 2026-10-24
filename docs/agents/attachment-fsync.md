# ⑨ 附件模块会 fsync 到 /

> 本文是 [AGENTS.md](../../AGENTS.md) 的分册之一，
索引见 [docs/agents/README.md](README.md)。

### ⑨ 附件模块会 fsync 到 `/` —— Android 的 SELinux 不给 open

**症状**：与 ⑧ 完全一样（`agent-busy`），但在 ⑧ 修好**之后**才浮出来。

`details.reason` 的真因：

```
Error: EACCES: permission denied, open '/data/user/0'
```

**根因**：`dsh-attachment-local` 发布附件时要证明"目录项已落盘"，
`ensureDurableDirectory()` 从 `$DSH_HOME` **逐级向上** fsync 每一层父目录
（`syncDirectory()` = `open(dir, O_RDONLY)` + `handle.sync()`），而
`ensureDurableHome()` 把 boundary 定成 `parse(home).root` —— 也就是 **`/`**，
于是这趟遍历**必然**走出应用目录。

而 Android 的 SELinux 不让应用 open 这些祖先目录。真机实测（root 的 `/` 也是 EACCES，
**不是权限位问题**，别去 `chmod`）：

| 目录 | 模式 | `open(O_RDONLY)` |
|---|---|---|
| `/` | 755 | **EACCES** |
| `/data` | 771 | **EACCES** |
| `/data/user` | 711 | **EACCES** |
| `/data/user/0` | 771 | **EACCES** |
| `/data/data` | 771 | **EACCES** |
| `/data/user/0/com.dsh.android` | 700 | OK |
| `/storage/emulated/0` | 771 | OK |

**做法**：`EngineManager.patchAttachmentDurability()` 把 `syncDirectory()` 里那次
`open` 包进 try/catch，**只把 EACCES/EPERM 改成跳过该层**，其余 errno 照旧抛出。
锚点见 `ATTACH_SYNC_GUARD` / `ATTACH_SYNC_ANCHOR`。

⚠️ 丢掉的只是"祖先目录项的崩溃持久性"这一项加固，**不是正确性**：附件字节本身的
fsync 照旧，应用自己目录（700、可 open）的 fsync 也照旧。应用目录之外的目录项在
Android 上**本来就不可达**，这不是取舍是平台事实。
⚠️ 桌面端不受影响（`/`、`/home` 在 Linux 上都是可 open 的 755），catch 分支不触发。
⚠️ 引擎升级后锚点若不匹配，补丁会跳过并打日志，不会让启动失败。

**同类站点已逐处核对**（`dsh-session-persistence-jsonl` 的 `syncDirectory`、
其 `lib/worker.cjs` 孪生、`dsh-storage-json` 的 `fsyncDirectory`）——
它们只 fsync **直接父目录**，都在 `$DSH_HOME` 以内，**安全**。
**只有 `dsh-attachment-local` 会一路走到 `/`。**

