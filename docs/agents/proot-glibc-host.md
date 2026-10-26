# C 方案：proot(glibc) 引擎 + DSHAPP 原生壳

> 本文是 [AGENTS.md](../../AGENTS.md) 的分册之一。
> 目标：**保持官方引擎不改、把原生能力留在 Android、两者只靠一个共享目录通信。**

## 为什么是这个方案

本机实测（`/proc/config.gz`，kernel 6.1.138-android14）：

```text
# CONFIG_USER_NS is not set          → bwrap 物理上不可能
# CONFIG_SECURITY_LANDLOCK is not set → 官方 landlock-run 探测 exit 125
CONFIG_SECCOMP=y / FILTER=y          → 只能过滤 syscall，不能做路径级文件围栏
```

所以：**proot / root chroot 都不改善沙箱**（共享同一内核），只有换内核（AVF VM）或换机器（远端）才行。
但 proot 能改善**插件生态**：它给的是 glibc，于是官方 `linux-arm64` 预编译全部可用。

一句话：**沙箱拿不到，生态拿得到。**

## 与现状（bionic 宿主）的差别

| 维度 | Termux(bionic) | proot(glibc) |
|---|---|---|
| `process.platform` | `android`（官方 linux 分支不生效，全靠 `--patch` + 锚点） | `linux`（官方分支全走） |
| flock | 自编译 android 绑定 | 官方 `system.node`（glibc 版） |
| sharp | wasm32 变体（慢、格式窄） | 官方 `@img/sharp-linux-arm64` |
| node-pty | 自编译 | 官方预编译或现编 |
| 第三方原生插件 | 需自备 android 产物 | linux-arm64 glibc 预编译基本直接可用 |
| 沙箱 | `boo-sandbox-run`（C） | 同一套 C，**为 glibc 重编** |

## 目录约定

```text
filesDir/
├─ bin/proot                              静态 aarch64 proot
├─ ubuntu/                                Ubuntu base rootfs（glibc）
│  ├─ usr/bin/node                        glibc 版 node（22/24）
│  ├─ usr/lib/node_modules/@deepseek-ai/dsh/
│  └─ usr/local/
│     ├─ bin/boo-sandbox-run              重编
│     └─ lib/{libboosandbox.so,liblinkcompat.so}
├─ home/.dsh/                             $DSH_HOME（与 bionic 宿主共用，可迁移）
└─ tmp/                                   TMPDIR（bwrap 方言的 --tmpfs 会映射到这里）
```

绑定只给必要的：`/dev /proc /sys /system`、`$DSH_HOME`、workspace、`tmp`。
**`$DSH_HOME` 两侧路径必须逐字相同**——引擎会把绝对路径写进会话与工作区，换拼写=历史会话 `cwd` 全部失效。
（`/data/user/0/<pkg>` 与 `/data/data/<pkg>` 是同一目录的两种拼写，`boosandbox.c` 里专门用 `g_allow_real` 兜住。）

## 编译（在 proot Ubuntu 内）

```bash
apt install -y build-essential
cd <repo>/app/src/main/jni
gcc -O2 -o /usr/local/bin/boo-sandbox-run boo-sandbox-run.c
gcc -O2 -shared -fPIC -o /usr/local/lib/libboosandbox.so boosandbox.c -ldl
gcc -O2 -shared -fPIC -o /usr/local/lib/liblinkcompat.so linkcompat.c -ldl
```

`boo-sandbox-run.c` 零改动；另外两个文件需要先打补丁：

```bash
python3 tools/apply-glibc-patches.py          # 幂等
python3 tools/apply-glibc-patches.py --check  # 只检查
```

### 补丁 1：`linkcompat.c` 认 `ENOSYS`

proot 的 ptrace 层可能让 `link/linkat` 直接返回 `ENOSYS`，而原实现只在
`EACCES/EPERM` 时转译 → DSH 的独占原子发布会冒泡失败 → 每轮回复报错。
（SELinux 在 proot 里同样生效，`EACCES` 也仍然会出现，所以这不是"只在 proot 下"的补丁。）

### 补丁 2：`boosandbox.c` 补 8 个缺失符号

原文件已经覆盖 `open/open64/openat/fopen/fopen64/creat/mkdir/mkdirat/
unlink/unlinkat/rename/renameat/renameat2/truncate/symlink/link/chmod/access`，
**缺的是这 8 个**（`tools/apply-glibc-patches.py` 只追加它们，不重复定义已有符号）：

| 符号 | 为什么必须补 |
|---|---|
| `openat64` | 带 dirfd 的 64 位变体；bionic 调用方少，glibc 上常见 |
| `creat64` | 同上 |
| `__open_2` / `__open64_2` / `__openat_2` / `__openat64_2` | Ubuntu 默认开 `_FORTIFY_SOURCE`，程序走这四个二参快路径，不补就是真缺口 |
| `freopen` / `freopen64` | C 库层重定向（`freopen(path,"w",stdout)` 这类） |

⚠️ **踩过的坑**：曾试图「整块重写 `open64`、C 名换 `boo_open64` + `__asm__("open64")`」，
结果同一 TU 里 `open64` 被定义两次（原文件 `:358` + 追加块），汇编器报
`symbol 'open64' is already defined`。正解是**只补缺失符号、用普通函数名**——
与文件既有风格一致，glibc 允许这样覆盖 `bits/fcntl2.h` 的 fortify inline。

### 已实测（本机 proot / glibc 2.39，2026-10）

```text
readonly 写 /tmp          → [boo] permission denied ... (mode=read-only)          ✅
workspace-write 写 ws 内  → ok                                                    ✅
workspace-write 写 ws 外  → permission denied（/root/outside/b.txt）              ✅
mkdir ws 外（mkdirat）    → permission denied                                     ✅
echo > /dev/null          → devnull-ok                                            ✅
python3 open(ws 内,'w')   → inside-ok                                             ✅
python3 open(ws 外,'w')   → PermissionError [Errno 13]                            ✅
tee ws 外                 → Permission denied                                     ✅
sed -i ws 外              → permission denied + cannot rename ...                 ✅
```

三个产物均以 glibc 编译通过：

```text
boo-sandbox-run        71,304 B
libboosandbox.so       73,344 B   （导出 openat64/creat64/freopen*/__open*_2）
liblinkcompat.so       70,992 B
```

## 启动

```bash
exec "$FILES/bin/proot" --kill-on-exit -r "$ROOT" \
  -b /dev -b /proc -b /sys -b /system \
  -b "$DSH_HOME:$DSH_HOME" -b "$WORKSPACE:$WORKSPACE" -b "$TMPDIR:$TMPDIR" \
  -w "$WORKSPACE" \
  /usr/bin/env -i HOME=/root PATH=/usr/local/bin:/usr/bin:/bin \
    TERM=xterm-256color TMPDIR="$TMPDIR" DSH_HOME="$DSH_HOME" \
    LD_PRELOAD=/usr/local/lib/liblinkcompat.so \
  /usr/bin/node /usr/lib/node_modules/@deepseek-ai/dsh/bin/dsh.js \
    --profile web --host 127.0.0.1 --port 3080 --no-open \
    --patch "$DSH_HOME/android-glibc.patch.yml"
```

Kotlin 侧由 `engine/ProotGlbcHost.kt` 负责同样的 argv，并把运行期事实写进
`$DSH_HOME/android-glibc.patch.yml`（模板见 `tools/overlays/android-glibc.patch.yml`）。

## 为什么 overlay 里必须有那三行

| overlay 行 | 依据 |
|---|---|
| `sandbox.runnerCommand` + `runnerFailureSignatures` | `sandbox-local/src/index.ts:285-293`：两者必须同时非空，否则**构造时抛错**，整条 sandbox 服务不注册；`:328-335`：有 runnerCommand 就跳过平台探测并断言 `full` |
| `session-query-sqlite.openAt: first-search` | 上游 `bundle/web-app/cordis.patch.yml:27-30` 默认 `never`，即 `session_search` 直接 `SESSION_QUERY_SEARCH_DISABLED` |
| `plugin-manager.registry/fallbackRegistries` | `docs/agents/plugin-source.md`：手机 `.npmrc` 被写成 npmmirror 后，官方源入口被前端**去重合并**掉；`name` 与 base 层不一致则整条静默跳过 |

## 验收

```bash
DSH_HOME=... WORKSPACE=... ./tools/verify-c.sh
RUN_HEADLESS=1 ./tools/verify-c.sh     # 加跑端到端
```

四组判据：平台翻面 / 官方预编译 / 沙箱边界（含 mkdirat 逃逸与未知 flag fail-closed）/ 端到端。
**任何一条 ❌ 都不要继续**——尤其 `workspace 外写入未被拦截` 与 `mkdirat 逃逸未被拦截`。

## 已知限制（宿主换不来的）

- **无 PID 命名空间**：内核无 `CLONE_NEWPID` 权限，`--unshare-pid` 只能忽略；文件写边界才是承诺。
- **沙箱是用户态拦截**，不是内核边界：故意构造的竞态（TOCTOU、symlink 换向）仍可能绕过；`normalize()` 是纯词法、不解析 symlink（源码里明确记录）。
- **proot 开销**：每次系统调用被 ptrace，大仓库 grep 慢 10–30%。
- **`landlock-run` 用不上**：内核关掉了 Landlock，与 glibc 无关。
- **`pwsh` 仍不建议**：`pwsh` linux-arm64 是 glibc 二进制，在 proot 里能跑，但 Windows 专属语义（ConstrainedLanguage / 命名管道）没有，官方 `tool-pwsh` 在 preset 里只对 win32 启用。

## 回退

1. 先把 `sandbox.runnerCommand` 两行注释掉、改用 `sandbox-policy.mode: danger-full-access`（官方支持的"无隔离"模式，`bash-sandbox/src/index.ts:92` 明确绕过 provider）。
2. 再把宿主切回 `HostMode.TERMUX_BIONIC`（`engine/EngineHosts.kt`）。

**切换纪律**：只在「上一轮工具结果已持久化、下一轮模型请求尚未开始」的边界上迁移，不搬迁运行中的请求 / 终端进程 / 浏览器会话（该约定借自 Operit2 的 Binding 设计）。
