# ⑭ Web 端口 3080 被占用

> 本文是 [AGENTS.md](../../AGENTS.md) 的分册之一，
索引见 [docs/agents/README.md](README.md)。

### ⑭ Web 端口 3080 被占用 —— 默认沿用，撞车才让内核分配

**症状**（粉丝反馈的真机截图）：启动页停在

```
引擎启动失败（引擎进程已退出）。最后输出:
dsh: startup failed: 2 required plugins did not activate

Failed plugins (1):
webserver (required)
Package: @deepseek-ai/dsh-host-webserver
Error: listen EADDRINUSE: address already in use 127.0.0.1:3080
...
Plugins waiting for services (10):
connection (required)  webRuntime
open-in-app            webServer, connection
...（10 行全是连锁反应）
```

**根因**：`3080` 是引擎自己的默认值（`dsh-web-app/cordis.patch.yml` 的
`port: !!js ctx.webStartup.port ?? 3080`），而 App 原来**不传 `--port`**，
于是每次启动都去抢 3080。而 `dsh-host-webserver` 的 `listen()` 失败是
**直接 reject 插件激活**（`server.once("error", reject)`），它是 required 插件
⇒ 整个引擎退出。**没有「端口被占就换一个」的退路。**

⚠️ **那 10 行 `waiting for services` 是连锁反应，不是独立故障。** 根只有
webserver 一个 —— 与 ④ 那条教训同构：**排查 `waiting for` 先看 `did not activate`。**

**占用者是谁**（截图判断不了，但分支有限，按概率排）：

1. **上一次残留的引擎进程**（最可能）。全工程**没有任何地方调用
   `EngineManager.stop()`** —— 只有定义、没有调用者。`ProcessBuilder` 起的 node
   是普通子进程，父进程被 LMK / 国产 ROM 清理时它**不会跟着死**（没设 PDEATHSIG），
   被 reparent 到 init 后继续占着 3080。特征是**稳定复现**，重启手机才解。
2. **应用分身 / 双开 / 工作资料**。`127.0.0.1` 是共享回环，两份实例抢同一个端口。
   特征是「先开的那份永远正常，后开的必失败」。
3. **引擎侧被手动跑过第二个 `dsh --profile web`**（本 App 带终端面板，见 ⑩）。
4. 别的 App 占了 3080（>1024 任何 App 都能 bind），概率最低。

**做法**（`EngineManager.resolveWebPort()` + `isLoopbackPortBusy()`）：
启动前先探一次 `127.0.0.1:3080`，**空闲就照旧不传 `--port`**（行为与改动前逐字一致），
**被占就传 `--port 0`** 让内核挑一个空闲端口。

```kotlin
// start() 的 buildList 里
resolveWebPort()?.let { port -> add("--port"); add(port.toString()) }
```

⚠️⚠️ **`--port` 必须排在所有 `--patch` 之后，紧邻 `--no-open`。位置是硬性的。**

`--port` 属于 **web app 的内层 flag**，而 `@deepseek-ai/dsh/lib/bin.js` 的 launcher
**只解析自己的 `--profile` / `--patch`**，规则是「**第一个不认识的 token 就是内层参数的
起点，其后原样转交**」（`bin.js` 顶部注释原文）。所以插到 `--patch` 前面时，
后面的 `--patch` 全被当成内层参数：

```
[engine] error: unknown option '--patch'
```

引擎**直接起不来**，且报错指向 `--patch` 而完全看不出是 `--port` 的位置问题。
真机实测踩过（第一次装上去就是这个症状）。改这一处时**先看 `bin.js` 的参数归属**
再决定插入点，别按「越早传越保险」的直觉排。

⚠️ **判据与 `AdbMdns.isPortInUse` 是反的**：那里「bind 失败 = adbd 在听」是**成功**，
这里「bind 失败」就是**真被占用**。两处语义不同，别互相抄。

⚠️ **不能一律传 `--port 0`**：那样每次启动端口都变，而移动端 UI 插件与用户的
收藏/书签都可能记着 `127.0.0.1:3080`。只在真被占时才让出端口。

⚠️ **`--port 0` 是官方支持的**（`dsh-web-app/lib/startup.js` 的
`"--port <port>"` 帮助文本明写 "pass 0 to let the OS pick a free one"），
`WebServer` 回填 `listenedPort = server.address().port`，打印的 URL 用的也是它 ——
所以 App 侧**不用改任何解析逻辑**（`start()` 里的正则本来就是 `\d+`）。

⚠️ **探测与真正 `listen` 之间天然有竞态**（探测完端口被抢走）。窗口只有毫秒级，
且失败后果与改动前完全相同（引擎报错退出），所以**不为此加重试** ——
真正的占用源是上一个残留进程，它不是并发抢端口。

⚠️ **browser-trust fence 不受影响**：`dsh-client-connection` 的
`isTrustedApiRequest()` 对 `isLoopbackHostname()` 的 Host **不比对端口**
（`127.0.0.1:任意端口` 都算 loopback），所以换端口不会让 `/api` 403。

日志验收：正常路径出现 `Web 端口 3080 空闲，沿用引擎默认值`；撞车时出现
`Web 端口 3080 已被占用（多半是上一次残留的引擎进程），改由内核分配空闲端口`，
随后 `[engine] dsh web: http://127.0.0.1:<非 3080 端口>/?token=...` 与
`引擎就绪: http://...` 照常。

