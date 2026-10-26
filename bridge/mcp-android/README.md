# mcp-android

把 Android 能力做成**标准 MCP server**，让 dsh（本机 / 远端 / 别的 agent）都能调用。

## 为什么用 MCP，而不是再写一个 dsh 插件

| 方式 | 只对本机 dsh 有效 | 远端 dsh 可用 | 别的 agent 可用 | 需要新原生代码 |
|---|---|---|---|---|
| dsh 插件（`cordis.patch.yml`） | ✅ | ❌ | ❌ | 可能要 |
| **MCP server** | ✅ | ✅ | ✅ | ❌ |

dsh 内置 `@deepseek-ai/dsh-mcp-client`，MCP 工具会被当作**原生工具**注册进模型工具表 —— 这条桥一次写好，处处能用。

## 通道协议（与 DSHAPP 现有文件信箱同构）

```text
$DSH_HOME/mcp-cmd.json      ← server 写：{ "id": 1, "action": "tap", "args": {"x":10,"y":20} }
$DSH_HOME/mcp-result.json   ← Kotlin 写：{ "id": 1, "ok": true, "data": { ... } }
```

Kotlin 侧只需要在现有的信箱轮询里加一路（与 `ui-cmd.json` 同一个循环，120ms）：

```kotlin
// McpBridge.kt（骨架）
fun poll() {
    val cmd = File(dshHome, "mcp-cmd.json")
    if (!cmd.isFile) return
    val msg = JSONObject(cmd.readText())
    val id = msg.getLong("id")
    val result = when (msg.getString("action")) {
        "dump"       -> uiProbe.dump()
        "tap"        -> uiProbe.tap(msg.getJSONObject("args").getInt("x"), msg.getJSONObject("args").getInt("y"))
        "type"       -> uiProbe.type(msg.getJSONObject("args").getString("text"))
        "screenshot" -> screenshotter.capture()
        "shell"      -> shellRunner.run(msg.getJSONObject("args").getString("command"))
        "notify"     -> notifier.post(msg.getJSONObject("args").getString("title"), msg.getJSONObject("args").getString("text"))
        else         -> mapOf("ok" to false, "error" to "未知 action")
    }
    File(dshHome, "mcp-result.json").writeText(JSONObject(result).put("id", id).toString())
    cmd.delete()   // 消费即删，避免重复执行
}
```

> `cmd.delete()` 这一步是**接口的一部分**：上次 DSHAPP 的 ui 桥就吃过「结果文件没删导致重复点击」的亏。

## 开启

```bash
# 1) 把 bridge/mcp-android 复制进 filesDir（构建期放 assets，启动时幂等复制）
cp -r bridge/mcp-android "$FILES/bridge/"

# 2) 挂 overlay（或写进 profile 用户层）
dsh --profile web --patch "$DSH_HOME/mcp-android.patch.yml"
```

## 验收

```bash
# 手搓一条 JSON-RPC，确认 server 活着（stdout 必须只有 JSON）
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  | DSH_HOME=$DSH_HOME node bridge/mcp-android/server.mjs
# 期望：{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05",...}}

# 再问工具表
printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | DSH_HOME=$DSH_HOME node bridge/mcp-android/server.mjs
```

在 dsh 会话里，工具表应出现 `android_ui_dump` / `android_tap` / …；
调用 `android_tap` 时如果 20s 无响应，说明 Kotlin 侧轮询没接上（报错文案会直接点出这一点）。

## 安全边界

- `android_shell` 只在宿主**确实**拿到 Shizuku/adb/root 授权时可用；否则返回明确错误，不静默降级。
- 桥只交换本地文件，不开网络端口；远端 dsh 想用这套能力，需要把 `$DSH_HOME` 同步过去（或用 DSHAPP 的配对服务）。
- 每次调用都带 `id`，结果按 id 匹配 —— 并发调用不会串。