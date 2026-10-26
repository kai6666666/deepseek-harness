# 宿主切换接线（EngineManager → EngineBootGate）

> 目标：把「启动引擎」从 `EngineManager` 里抽出来，改成宿主可切换；
> 一次改动 ≤ 20 行，不动那 60 多个 `ensure/patch`。

## 1. 三处改动

### ① `EngineManager`：把现有启动流程包成 launcher

现有代码结尾大致是「拼好 `--patch` 列表 → 起 node → 等端口 → 把 URL 给 WebView」。
在这段外面套一层：

```kotlin
// EngineManager.kt
private suspend fun launchLegacy(spec: EngineStartSpec): EngineEndpoint {
    // 原来的启动逻辑原样搬进来，只是把返回值改成 EngineEndpoint
    // （端口、进程 pid、engine.log 路径这里都已经有）
    return EngineEndpoint(baseUrl = "http://127.0.0.1:${spec.port}", pid = enginePid, logFile = engineLog)
}

suspend fun bootEngine(): EngineBootGate.BootResult =
    EngineBootGate.boot(
        filesDir = filesDir,
        dshHome = File(filesDir, "home/.dsh"),
        workspace = defaultWorkspace(),
        prefs = prefs,
        legacyLauncher = ::launchLegacy,
        stopLegacy = { stopEngine() },     // 已存在就复用
    )
```

### ② 调用点：拿 `baseUrl` 而不是写死 127.0.0.1

```kotlin
val boot = engineManager.bootEngine()
webHost.load(boot.baseUrl)          // SystemWebHost / GeckoWebHost 都吃 URL
if (boot.degraded) showBanner(boot.note)   // 「proot 没起来，已回落 bionic」
```

`ProotGlbcHost` 内部已经处理了端口就绪探测与错误归因（`waiting 127.0.0.1:3080 超时` /
`引擎进程已退出（exit=…），见 engine.log`），调用方不需要再写轮询。

### ③ 设置页：挂上 `HostSettingsSection`

```kotlin
HostSettingsSection(
    filesDir = filesDir,
    current = EngineBootGate.resolveMode(prefs),
    capabilities = EngineHosts.create(mode, filesDir).capabilities(),
    provisioner = RootfsProvisioner(filesDir),
    verifier = VerifyC(filesDir),
    workspace = defaultWorkspace(),
    onSelect = { mode ->
        prefs.edit().putString(EngineBootGate.PREF_HOST, mode.prefValue()).apply()
        // 提示用户重启 App（引擎在进程生命周期内不热切）
    },
    onOpenLogs = { openLogsScreen() },
)
```

偏好键：`engine_host` = `bionic` | `proot` | `remote`；`engine_remote_url` = `https://…`。

## 2. 资产与脚本落位

| 文件 | 从哪来 | 落到哪 |
|---|---|---|
| `proot`（静态 aarch64） | 手工/构建期放入 assets | `filesDir/bin/proot`（0755） |
| `ubuntu-base.tar.gz` | 同上 | `filesDir/ubuntu/` 解包 |
| `jni/*.c`（三个） | 仓库 `app/src/main/jni` | `filesDir/bin/jni/` |
| `provision-glibc-host.sh` | 仓库 `tools/` | `filesDir/bin/` |
| `verify-c.sh` | 仓库 `tools/` | `filesDir/bin/` |

启动时做一次幂等复制（已存在且哈希相同就跳过）。

## 3. 验收顺序（缺一步就别往下走）

```bash
# ① 装配
adb shell "run-as com.dsh.android sh files/bin/provision-glibc-host.sh"
# ② 验收（App 内按钮等价）
adb shell "run-as com.dsh.android sh files/bin/verify-c.sh"
# ③ 切宿主后看三行日志
adb logcat -d -s DSH:I | grep -E "宿主=|已写入宿主 overlay|启动 proot 宿主"
# ④ 端到端
adb shell "run-as com.dsh.android cat files/logs/verify-c.json"
```

四条判据：`process.platform=linux`、`anchors` 无缺、`verify-c.json` 的 `fail=0`、
`engine.log` 无 `did not activate` / `SANDBOX_UNAVAILABLE` / `SessionAlreadyOwned`。

## 4. 回退

1. 设置页切回「Termux（bionic）」→ 重启 App；
2. 或直接 `adb shell run-as com.dsh.android` 把偏好改掉：
   `settings put` 不可用（app 私有），用 App 内切换即可；
3. 引擎起不来时 `EngineBootGate` 会**自动**回落 bionic 并在界面顶部说明原因——
   这是刻意设计的：宿主是可选增强，不是启动前置。

## 5. 与「任务交接边界」

切换只允许发生在轮次边界：上一轮工具结果已持久化、下一轮模型请求尚未开始。
运行中的请求、终端进程、浏览器会话不迁移（借 Operit2 的 Binding 纪律）。
UI 上表现为：切换按钮只在「空闲」时可用，运行中置灰并提示「等本轮结束」。