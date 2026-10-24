# ④ Android 没有内核级沙箱后端

> 本文是 [AGENTS.md](../../AGENTS.md) 的分册之一，
索引见 [docs/agents/README.md](README.md)。

### ④ Android 没有内核级沙箱后端 —— 用自带 runner 保住写边界

**症状**：`bash` 工具完全不可用，报

```
sandbox mode "workspace-write" is requested but no sandbox backend is usable on
this host; refusing to run the command unconfined.
Install bubblewrap or run a Landlock-enforcing kernel...
```

`grep`/`glob` 也全废（那是另一处，见 ⑤）。AI 实测只能靠 `read` 硬啃整个文件。

**根因**：`dsh-sandbox-local` 按平台挑后端

```js
const PLATFORM_CHAINS = {
  linux:  ["bwrap", "landlock"],
  darwin: ["seatbelt"],
  win32:  ["windows-acl"],
};
```

Android 落不进任何一条，`confine()` 又是 **fail-closed** 的。设备实测：内核
**4.14.116**（Landlock 需 5.13+）、无 `bwrap`、无 `/sys/kernel/security/lsm`、
无 `/proc/sys/user/max_user_namespaces`，`unshare -U` 因缺 CAP_SYS_ADMIN 而 EPERM。

**做法**：该 provider 留了操作员口子 `Config.runnerCommand`。非空时**跳过平台探测**、
直接 `enforcement: "full"`，并按 bwrap 方言拼参数：

```
[ ...runnerCommand, ...bwrapProfileArgs(policy), "--", ...argv ]
```

`bwrapProfileArgs` 的实际内容（android 走 `workspace-write` 时）：

```
--ro-bind / /  --dev /dev  --unshare-pid  --proc /proc  --die-with-parent
--tmpfs /tmp   --bind <workspaceRoot> <workspaceRoot>
```

所以**不必改引擎源码**，只要提供一个听得懂这套参数的 runner。两个组件：

| 文件 | 作用 |
|---|---|
| `app/src/main/jni/boo-sandbox-run.c` | 解析上述方言 → 翻译成拦截器配置 → `execvp` 真实命令 |
| `app/src/main/jni/boosandbox.c` | `LD_PRELOAD` 写拦截器，在 libc 边界挡 allowlist 外的写 |

runner 的翻译规则：`--bind SRC DST` → 写白名单加一条（`--ro-bind`/`--dev-bind`
不授权写）；`--tmpfs` → 额外放行 `$TMPDIR` 与 `/tmp`；`--die-with-parent` →
`prctl(PR_SET_PDEATHSIG, SIGKILL)`；**未知 flag → exit 125（fail closed）**。
`nroots > 0` 即 `workspace` 模式，否则 `readonly`。它把 `BOO_SANDBOX_LIB`
**追加**进已有的 `LD_PRELOAD`，所以 link 转译层同时生效。

⚠️ **与真 bwrap 的差异**：`--unshare-pid` 无法实现（同样缺 CAP_SYS_ADMIN），
**PID 命名空间没有隔离**。文件写边界是完整的，那是本方案承诺的部分。
`--ro-bind / /` 也不做只读挂载，靠拦截器拦写。

⚠️ **拦截器的 deny 文案是接口**：引擎靠
`DENIAL_SIGNATURES.runnerCommand = ["read-only file system", "permission denied"]`
把失败归类成沙箱拒绝。改 `deny()` 的输出前先看 `boosandbox.c` 里那条注释。

overlay 由 `EngineManager.writeSandboxPatch()` 生成
（`$DSH_HOME/sandbox.patch.yml`），`runnerCommand` 指向 `filesDir/boo-sandbox-run`。
patch 是**整行替换 config**，不是合并 —— 要动这行时记得把需要的 config 一并重述。

⚠️ **`runnerFailureSignatures` 不能留空，留空会让整个沙箱服务注册失败。**
provider 构造函数有一对硬校验：

```js
if (runner.length > 0 && runnerFailureSignatures.length === 0)
  throw new Error("sandbox-local: runnerCommand requires at least one runnerFailureSignatures entry");
```

它映射到 `ConfinedArgv.runnerFailureRules[].fatalSignatures`，即「runner 自己挂了、
命令根本没跑起来」的 stderr 子串（与 bwrap 的 `"bwrap: "`、landlock 的
`"landlock-launcher: "` 同构）。填错的后果**不是降级而是整条服务链断裂**：

```
[engine] sandbox (@deepseek-ai/dsh-sandbox-local): Error: sandbox-local:
           runnerCommand requires at least one runnerFailureSignatures entry
[engine] dsh: warning: 4 entries did not activate
[engine] bash-sandbox: pending (waiting for service: sandbox)
[engine] permission:   pending (waiting for service: shell)
[engine] ptc-runtime:  pending (waiting for service: sandbox)
```

界面表现是**新建会话直接失败**：

```
新建会话失败：agent-preset/invalid: tool-bash (@deepseek-ai/dsh-tool-bash):
waiting for shell workflow-ptc (@deepseek-ai/dsh-workflow-ptc):
waiting for ptcRuntime tool-workflow (@deepseek-ai/dsh-tool-workflow):
waiting for workflowEngine
```

注意这条报错链的**尾**是 `workflowEngine`，容易被误导去查 workflow 相关包；
真正的**根**是第一行的 `sandbox` 行注册失败。**排查这类 `waiting for` 要先看
`did not activate` 那几行。**

当前填的是 `'boo-sandbox-run: '` —— `boo-sandbox-run.c` 的每条 fail-closed 路径
都用这个前缀。**改 runner 的输出前缀必须同步改这里。**

「沙箱拒绝」与「runner 失败」是两回事：前者靠 provider 内置的
`DENIAL_SIGNATURES.runnerCommand = ["read-only file system", "permission denied"]`
识别（`libboosandbox.so` 的 deny 输出正好含 `permission denied`），后者才是上面这个字段。

验收（`sbtest2.sh` 8/8 + runner 10/10）：workspace 内写放行、app 私有目录写被拒、
`/sdcard` 写被拒、`..` 与 `/proc/self/../..` 逃逸被拒、`/dev/null` 放行、读不受限、
`readonly` 下连 workspace 也拒、`$TMPDIR` 放行、退出码透传、未知 flag → 125。
`boosandbox.c` 从 Boo 的 kit 逐字节照搬后**只改了 allowlist 从单根变多根**
（`MAX_ALLOW_ROOTS 8` + `strtok_r` 切 `:`）。

