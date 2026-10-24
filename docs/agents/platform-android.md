# android 平台适配总览

> 本文是 [AGENTS.md](../../AGENTS.md) 的分册之一，
索引见 [docs/agents/README.md](README.md)。

## android 平台适配（这是本项目反复出问题的地方）

**根本原因**：Node 在 Android 上 `process.platform === 'android'`（不是 `'linux'`），
而 DSH 官方的原生插件和平台判断都是按 `linux`/`darwin`/`win32` 三选一写的。
凡是遇到「官方只认 linux，但代码本身与 libc 无关」的地方，都要为 android 补一份。

前两处是**自编译 android-arm64 原生绑定 + 打平台白名单补丁**；第三处性质不同，见下。

| 插件 | 官方判断 | 症状 |
|---|---|---|
| `node-addon-require-builtin` | 无 android 平台包 | 启动即 `No usable native binding found` |
| `node-addon-system`（flock） | `flock.js` 白名单排除 android | 每轮回复「本轮运行失败 flock is not supported on android-arm64」 |

第二个的具体链路：`dsh-session-persistence-jsonl` 的 `SessionWriteLease.acquire()`
要拿一把会话写入锁（内核 flock），失败即抛 `SessionAlreadyOwnedError` → 回复失败。
但 bionic 的 `sys/file.h` 里就有 `flock(int,int)`，Android 支持 flock(2)，
所以**正解是编译绑定，不是把锁 stub 掉**。

补丁锚点写死在 `EngineManager.FLOCK_PLATFORM_GUARD`。引擎升级后若该文本不再匹配，
`patchFlockPlatform()` 会跳过并打日志（不会让启动失败），届时按新文本更新锚点即可。

⚠️ 别把 flock 改成 no-op。官方在浏览器 worker 里确实 stub 成直接成功，但那是**单进程**
场景（进程内写声明已经足够互斥）；本 App 是真多进程（引擎可能再 spawn 子进程），
stub 掉会失去跨进程排他，可能撕裂会话日志。

