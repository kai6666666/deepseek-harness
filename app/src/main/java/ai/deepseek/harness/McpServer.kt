package ai.deepseek.harness

import android.content.Context
import android.util.Log
import fi.iki.elonen.NanoHTTPD
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject

/**
 * 本机回环 MCP server（streamable-http 的无状态子集）。
 *
 * 为什么自己写而不是引官方 Kotlin SDK：
 *  - 只需要 4 个方法（initialize / tools/list / tools/call / ping），无状态、无 SSE、无 session；
 *  - 少一条 ktor 依赖链，APK 体积和多版本冲突都能省掉。
 *
 * DSH 侧配置（profile 的 cordis.yml）：
 * ```yaml
 * - id: mcp-android
 *   name: '@deepseek-ai/dsh-mcp-client'
 *   config:
 *     serverName: android
 *     transport: streamable-http
 *     url: http://127.0.0.1:8765/mcp
 * ```
 * 工具会以 `mcp__android__tap` 之类的名字出现在模型工具表里。
 */
class McpServer private constructor(private val app: Context) : NanoHTTPD("127.0.0.1", PORT) {

    companion object {
        private const val TAG = "McpServer"
        const val PORT = 8765
        private const val PATH = "/mcp"
        private const val PROTOCOL_FALLBACK = "2025-06-18"

        @Volatile
        private var instance: McpServer? = null

        fun get(context: Context): McpServer =
            instance ?: synchronized(this) {
                instance ?: McpServer(context.applicationContext).also { instance = it }
            }
    }

    private val tools: List<ToolDef> = buildTools()

    fun startServer() {
        if (isAlive) return
        runCatching {
            start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)
            Log.i(TAG, "MCP listening on http://127.0.0.1:$PORT$PATH")
        }.onFailure { Log.e(TAG, "MCP start failed: ${it.message}") }
    }

    fun stopServer() = runCatching { stop() }.let { }

    // --------------------------------------------------------------- HTTP

    override fun serve(session: IHTTPSession): Response {
        if (session.uri != PATH) {
            return json(Response.Status.NOT_FOUND, errorBody(null, -32601, "unknown path"))
        }
        if (session.method == Method.GET) {
            // 无状态服务器不提供 SSE 流
            return json(Response.Status.METHOD_NOT_ALLOWED, errorBody(null, -32600, "SSE not supported"))
        }
        if (session.method != Method.POST) {
            return json(Response.Status.METHOD_NOT_ALLOWED, errorBody(null, -32600, "POST only"))
        }

        val body = runCatching {
            val map = HashMap<String, String>()
            session.parseBody(map)
            map["postData"] ?: ""
        }.getOrDefault("")

        if (body.isBlank()) return json(Response.Status.BAD_REQUEST, errorBody(null, -32700, "empty body"))

        return runCatching {
            val trimmed = body.trim()
            if (trimmed.startsWith("[")) {
                val input = JSONArray(trimmed)
                val out = JSONArray()
                for (i in 0 until input.length()) {
                    val r = handleOne(input.optJSONObject(i))
                    if (r != null) out.put(r)
                }
                if (out.length() == 0) empty() else json(Response.Status.OK, out.toString())
            } else {
                val r = handleOne(JSONObject(trimmed))
                if (r == null) empty() else json(Response.Status.OK, r.toString())
            }
        }.getOrElse {
            json(Response.Status.OK, errorBody(null, -32603, it.message ?: "internal error").toString())
        }
    }

    private fun json(status: Response.Status, body: String): Response =
        newFixedLengthResponse(status, "application/json", body)

    private fun json(status: Response.Status, body: JSONObject): Response =
        json(status, body.toString())

    private fun empty(): Response =
        newFixedLengthResponse(Response.Status.OK, "application/json", "")

    // ---------------------------------------------------------- JSON-RPC

    private fun handleOne(req: JSONObject?): JSONObject? {
        if (req == null) return errorBody(null, -32600, "invalid request")
        val id = req.opt("id")
        val method = req.optString("method", "")
        val params = req.optJSONObject("params") ?: JSONObject()

        // 通知（无 id）不回复
        if (id == null || id == JSONObject.NULL) {
            if (method == "notifications/initialized") Log.i(TAG, "client initialized")
            return null
        }

        return when (method) {
            "initialize" -> {
                val proto = params.optString("protocolVersion").ifBlank { PROTOCOL_FALLBACK }
                ok(
                    id,
                    JSONObject()
                        .put("protocolVersion", proto)
                        .put(
                            "capabilities",
                            JSONObject().put("tools", JSONObject().put("listChanged", false)),
                        )
                        .put("serverInfo", JSONObject().put("name", "android-tools").put("version", "1.0.0")),
                )
            }

            "ping" -> ok(id, JSONObject())

            "tools/list" -> {
                val arr = JSONArray()
                tools.forEach { arr.put(it.describe()) }
                ok(id, JSONObject().put("tools", arr))
            }

            "tools/call" -> {
                val name = params.optString("name")
                val args = params.optJSONObject("arguments") ?: JSONObject()
                val tool = tools.firstOrNull { it.name == name }
                    ?: return errorBody(id, -32602, "unknown tool: $name")
                val result = runCatching { runBlocking { tool.call(args) } }
                    .getOrElse { return ok(id, toolError(it.message ?: "tool failed")) }
                ok(id, result)
            }

            else -> errorBody(id, -32601, "method not found: $method")
        }
    }

    private fun ok(id: Any, result: JSONObject): JSONObject =
        JSONObject().put("jsonrpc", "2.0").put("id", id).put("result", result)

    private fun errorBody(id: Any?, code: Int, message: String): JSONObject =
        JSONObject().put("jsonrpc", "2.0")
            .put("id", id ?: JSONObject.NULL)
            .put("error", JSONObject().put("code", code).put("message", message))

    private fun textContent(text: String): JSONObject =
        JSONObject().put("content", JSONArray().put(JSONObject().put("type", "text").put("text", text)))

    private fun toolError(message: String): JSONObject =
        textContent(message).put("isError", true)

    // ------------------------------------------------------------- tools

    private class ToolDef(
        val name: String,
        val description: String,
        val schema: JSONObject,
        val call: suspend (JSONObject) -> JSONObject,
    ) {
        fun describe(): JSONObject = JSONObject()
            .put("name", name)
            .put("description", description)
            .put("inputSchema", schema)
    }

    private fun schema(vararg props: Pair<String, String>, required: List<String> = emptyList()): JSONObject {
        val properties = JSONObject()
        props.forEach { (k, t) -> properties.put(k, JSONObject().put("type", t)) }
        return JSONObject()
            .put("type", "object")
            .put("properties", properties)
            .put("required", JSONArray(required))
            .put("additionalProperties", false)
    }

    private fun buildTools(): List<ToolDef> = listOf(
        ToolDef(
            "tap",
            "点击安卓屏幕上的绝对坐标（像素）。",
            schema("x" to "number", "y" to "number", required = listOf("x", "y")),
        ) { args ->
            val be = BackendRegistry.pick(app)
            be.tap(args.getDouble("x").toFloat(), args.getDouble("y").toFloat())
                ?.let { return@ToolDef toolError(it) }
            textContent("tapped (${args.getDouble("x")}, ${args.getDouble("y")}) via ${be.name}")
        },

        ToolDef(
            "swipe",
            "从一点滑动到另一点，duration_ms 默认 300。",
            schema(
                "x1" to "number", "y1" to "number", "x2" to "number", "y2" to "number",
                "duration_ms" to "number", required = listOf("x1", "y1", "x2", "y2"),
            ),
        ) { args ->
            val be = BackendRegistry.pick(app)
            be.swipe(
                args.getDouble("x1").toFloat(), args.getDouble("y1").toFloat(),
                args.getDouble("x2").toFloat(), args.getDouble("y2").toFloat(),
                args.optLong("duration_ms", 300L),
            )?.let { return@ToolDef toolError(it) }
            textContent("swiped via ${be.name}")
        },

        ToolDef(
            "screenshot",
            "抓取当前屏幕截图，返回 PNG 图片。",
            schema(),
        ) {
            val be = BackendRegistry.pick(app)
            val b64 = be.screenshotPngBase64()
                ?: return@ToolDef toolError("截图失败（${be.name}）：权限不足、屏幕处于安全窗口或系统版本不支持")
            JSONObject().put(
                "content",
                JSONArray().put(
                    JSONObject().put("type", "image").put("data", b64).put("mimeType", "image/png"),
                ),
            )
        },

        ToolDef(
            "ui_dump",
            "导出当前窗口的可交互节点（文字/描述/资源 id/屏幕矩形/是否可点）。",
            schema("limit" to "number"),
        ) { args ->
            val be = BackendRegistry.pick(app)
            val dump = be.uiDump(args.optInt("limit", 400))
                ?: return@ToolDef toolError(
                    PermissionGate.requireTool(app, PermissionLevel.ACCESSIBILITY) ?: notReady(),
                )
            textContent(dump)
        },

        ToolDef(
            "permission_status",
            "查询本机权限等级（STANDARD/ACCESSIBILITY/DEBUGGER/ROOT）与各能力可用性。",
            schema(),
        ) {
            textContent(PermissionGate.status(app).describe() + "\n" + BackendRegistry.describe(app))
        },

        ToolDef(
            "env_status",
            "查询容器环境：rootfs/node/dsh 是否就位、当前镜像源、可用生态。",
            schema(),
        ) {
            textContent(EnvManager.status(app))
        },

        ToolDef(
            "env_mirror",
            "切换镜像源：official / aliyun / tuna / ustc（同时改 apt、npm、pip）。",
            schema("preset" to "string", required = listOf("preset")),
        ) { args ->
            val id = args.optString("preset")
            val preset = MirrorPreset.byId(id)
                ?: return@ToolDef toolError(
                    "未知源：$id（可选 ${MirrorPreset.presets.joinToString("/") { it.id }}）",
                )
            val touched = EnvManager.applyMirror(app, preset)
            textContent("已切到 ${preset.label}（${preset.id}）：${touched.joinToString(", ")}\n" + EnvManager.status(app))
        },

        ToolDef(
            "env_install",
            "在容器里装包：ecosystem=apt/npm/pip/cargo，packages 逗号分隔。",
            schema(
                "ecosystem" to "string", "packages" to "string", "mirror" to "string",
                required = listOf("ecosystem", "packages"),
            ),
        ) { args ->
            val eco = Ecosystem.entries.firstOrNull { it.id.equals(args.optString("ecosystem"), true) }
                ?: return@ToolDef toolError("未知生态：${args.optString("ecosystem")}（apt/npm/pip/cargo）")
            val pkgs = args.optString("packages").split(',', ' ')
                .map { it.trim() }.filter { it.isNotEmpty() }
            if (pkgs.isEmpty()) return@ToolDef toolError("packages 为空")
            val preset = args.optString("mirror").takeIf { it.isNotBlank() }?.let { MirrorPreset.byId(it) }
            val script = buildString {
                appendLine("set -e")
                appendLine(EnvManager.installCommand(eco, pkgs, preset))
                appendLine(EnvManager.fixPermissionsScript())
                appendLine("echo ENV_INSTALL_OK")
            }
            val out = runInContainer(script)
            textContent(out.takeLast(4000))
        },
        ToolDef(
            "request_permission",
            "打开某项能力的授予入口：accessibility / shizuku / root / battery。",
            schema("kind" to "string", required = listOf("kind")),
        ) { args ->
            val kindRaw = args.optString("kind").lowercase()
            val cap = when (kindRaw) {
                "accessibility", "a11y" -> Capability.ACCESSIBILITY
                "shizuku" -> Capability.SHIZUKU
                "root", "su" -> Capability.ROOT
                "battery", "battery_whitelist" -> Capability.BATTERY_WHITELIST
                else -> return@ToolDef toolError("未知 kind：$kindRaw（可选 accessibility / shizuku / root / battery）")
            }
            val opened = PermissionGate.openGrantScreen(app, cap)
            val after = PermissionGate.status(app).describe()
            textContent(
                (if (opened) "已打开 ${cap.label} 的授予入口，请让用户在系统界面上完成授权。"
                else "无法打开 ${cap.label} 的授予入口（可能未安装或系统限制）。") +
                    "\n当前状态：\n$after"
            )
        },
    )

    private fun runInContainer(script: String, timeoutMs: Long = 300_000L): String {
        val pb = ProcessBuilder(DshRuntime.get(app).containerCommand(script))
        pb.redirectErrorStream(true)
        pb.environment().remove("LD_LIBRARY_PATH")
        val p = pb.start()
        val sb = StringBuilder()
        val deadline = System.currentTimeMillis() + timeoutMs
        val reader = p.inputStream.bufferedReader()
        try {
            while (true) {
                val line = reader.readLine() ?: break
                sb.appendLine(line)
                if (System.currentTimeMillis() > deadline) {
                    p.destroyForcibly()
                    sb.appendLine("[timeout ${timeoutMs}ms]")
                    break
                }
            }
        } finally {
            runCatching { reader.close() }
        }
        runCatching { p.waitFor(5, java.util.concurrent.TimeUnit.SECONDS) }
        return sb.toString().ifBlank { "exit=${runCatching { p.exitValue() }.getOrDefault(-1)}" }
    }

    private fun notReady(): String =
        "无障碍服务未启用：请在 系统设置 → 无障碍 → DeepSeek Harness 屏幕控制 中打开，然后重试"
}