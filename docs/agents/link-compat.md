# ③ SELinux 不给 link 权限

> 本文是 [AGENTS.md](../../AGENTS.md) 的分册之一，
索引见 [docs/agents/README.md](README.md)。

### ③ SELinux 不给 `link` 权限 —— 用 LD_PRELOAD 转译（不是改源码）

**这是第三处、也是唯一一处不能靠「补平台白名单」解决的适配**，因为它不是
「官方漏了 android」，而是 Android 的 SELinux 策略**主动**不给：

```
avc: denied { link } for comm="libuv-worker"
  name="session.v4.jsonl.zstd.<hex>.tmp"
  scontext=u:r:untrusted_app_27:s0  tcontext=u:object_r:app_data_file:s0
  tclass=file permissive=0
```

`untrusted_app(_27)` 对 `app_data_file` 没有 `link`，AOSP 为防沙箱数据外泄硬移除。
而 DSH 上游用硬链接做**独占原子发布**，并靠 `EEXIST` 判定「已被别人发布」：

```js
try { await link(staged, currentPath); }
catch (e) { if (e.code === 'EEXIST') return false; throw e; }  // ← EACCES 走这里
```

EACCES 不是 EEXIST，于是冒泡成「本轮运行失败 EACCES: permission denied, link ...」。

**真机 syscall 实测 —— 两个文件系统的 errno 不一样，这是本节的要害**：

| 调用 | app 私有目录（`app_data_file`） | `/sdcard`（FUSE / sdcardfs） |
|---|---|---|
| `link()` / `linkat()` | **EACCES** | **EINVAL**（node 进程内）／**EPERM**（裸 C 探针） |
| `rename()` | OK | OK |
| `renameat2(RENAME_NOREPLACE)` | **OK**（目标不存在则成功，已存在则 EEXIST 且不覆盖） | **EINVAL**（FUSE 不认这个 flag） |
| `symlink()` | OK | **EPERM** |
| `copyFile()` / `unlink()` / `mkdir()` / `fsync()` / `O_EXCL` 建文件 | OK | OK |

⚠️ **`/sdcard` 上的 `link()` 不是 EACCES**，这一点最初判断错了 —— 转译层因此**根本没被
触发**（触发条件只写了 EACCES/EPERM），用户把工作区设在 `/sdcard` 时 `write` 工具直接报
`EINVAL: invalid argument, link ...`。而 `bash`、`edit` 正常（`edit` 走 `dsh-atomic-write`
的纯 `rename`，不碰 link），所以症状只在 `write` 上。

⚠️ 同一个调用在 node 与裸 C 探针下 errno 不同（EINVAL vs EPERM），所以**两个都得接受**，
不能只认一个。

⚠️ 即使在 `/sdcard` 上触发了转译，`renameat2(RENAME_NOREPLACE)` 那一层**也会 EINVAL** ——
降级分支原来只认 `ENOSYS`，于是 EINVAL 原样冒泡，症状与「没触发」一模一样。两处都得改。

**为什么不能靠 JS 侧打补丁**：引擎用 `import { link } from "node:fs/promises"`（ESM 具名
导入）。实测 `--import` 预加载里改 `fsPromises.link` 得到
`named_import_is_patched = false`（default 属性改了，具名绑定没改）→ JS 侧此路不通。

**做法**：`app/src/main/jni/linkcompat.c` 编译成 `assets/linkcompat.bin`，
`EngineManager.ensureLinkCompat()` 解到 `filesDir/liblinkcompat.so`，启动 node 时
`LD_PRELOAD` 它。只 hook `link`/`linkat` 两个符号，**先试原生调用，只有被系统拒
（EACCES / EPERM / EINVAL）才转译**，其余 errno 原样返回。

⚠️ **EINVAL 必须在触发条件里**：`/sdcard` 上 `link()` 返回的是 EINVAL，漏了它转译
根本不会启动（这正是 `write` 工具在 `/sdcard` 工作区失效的根因）。三个 errno 都收，
是因为同一个调用在不同文件系统、不同调用方（node 的 libuv 线程 vs 裸 C）下报的不一样。

转译语义 = `link(from,to)` ≡ 「把 from 的内容复制到 to，且 to 必须原本不存在」，
三个性质都要保住：

- **独占**：`renameat2(RENAME_NOREPLACE)` 发布 → 目标存在时内核保证失败且不覆盖。
- **保源**：真 link 不消耗 `from`。**不能图省事换成 `rename()`** —— rename 会移走源，
  而 `dsh-attachment-local` 的 `publishImmutableAlias` 其 source 是 content-addressed
  持久对象，会被反复 link 到不同 ref（同文件 `lib/index.js` 第 690 与 708 行指向同一个
  object），第一次 rename 后第二次就 ENOENT。这是与「`O_EXCL` 占位 + `rename`」朴素写法
  的关键差别，那种写法会破坏数据。
- **原子**：先复制到**目标同目录**临时文件（保证同文件系统），再 rename 发布。

与真 link 的差异：inode 不同（复制而非共享）、空间翻倍。已逐处核对全部调用方，只依赖
EEXIST 语义与内容摘要校验，**没有任何一处依赖同 inode**。

验收（`lctest.c`，14 项断言全过）：独占、保源、内容一致、linkat 路径、ENOENT、目录 EPERM、
无残留临时文件、800KB 跨缓冲区完整性。真机 node 进程内 `fs.linkSync` 由 `EACCES` → 成功。

⚠️ `LD_PRELOAD` 会继承给 node spawn 的子进程（如 shell 工具）。本库只 hook
`link`/`linkat` 且先试原生，对系统二进制无害；但**将来要往 `LD_PRELOAD` 里追加别的库时，
务必确认不会破坏系统二进制**。

⚠️ `renameat2` 是 glibc 扩展，bionic **没有导出**，必须走 `syscall(__NR_renameat2, ...)`。
降级分支认 `ENOSYS | EINVAL | ENOTSUP`：前者是老内核（< 3.15）没有这个系统调用，
后两者是 **FUSE/sdcardfs 拒绝 `RENAME_NOREPLACE`** —— 也就是说在 `/sdcard` 上
**永远**走降级路径，那是正常路径而不是异常路径。

降级 = 「`O_EXCL` 占位 + `rename`」：独占性仍由 `O_EXCL` 保证，但两步之间被杀会留下
空占位文件，导致该文件名此后永久 `EEXIST`。这个窗口在 `/sdcard` 上是**真实存在**的
（`app_data_file` 上走不到这里，内核 4.14 支持 renameat2）。取舍依据：占位与 rename
之间只隔一次系统调用，且被杀的后果是「该文件名写不进去」，不是数据损坏 —— 相比
「`/sdcard` 工作区里 `write` 工具完全不可用」，代价明显更小。

⚠️ 降级路径的全部原语已在真机 `/sdcard` 上逐条验过（`O_EXCL` 建占位、`rename` 覆盖、
`fsync`/`fdatasync`/`futimens`、`chmod`、清理），不是推测。

⚠️ 真机验收（`/sdcard`、app 域、`LD_PRELOAD` 新库、node 进程内 `fs.linkSync`）：
独占新建 ✅、内容一致 ✅、**源文件保留** ✅、二次 link 正确报 `EEXIST` ✅、
目标目录不存在正确报 `ENOENT` ✅。

