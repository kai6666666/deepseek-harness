package com.dsh.android.engine

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * MCP 桥的 Android 半边：轮询 `mcp-cmd.json` → 调能力 → 原子写 `mcp-result.json`。
 *
 * 对端是 `bridge/mcp-android/server.mjs`（MCP stdio server）。
 * 选文件信箱而不是 socket 的理由：与 DSHAPP 现有 `ui-cmd.json` / `bubble` 同构，
 * 零端口、可审计、跨 proot/远端都能用（远端只要同步 $DSH_HOME）。
 *
 * 三条纪律（`docs/agents/ecosystem-bridge.md` §5）：
 *  1. 幂等 —— 每条命令带 `id`，消费后**删除**命令文件；
 *  2. 失败显式 —— 返回 `{ok:false,error}`，不让调用方干等；
 *  3. 原子落盘 —— 先写 `.tmp` 再 rename，避免对端读到半个 JSON。
 */
class McpBridge(
    private val dshHome: File,
    private val capabilities: AndroidCapabilities,
) {

    private val cmdFile: File get() = File(dshHome, "mcp-cmd.json")
    private val resultFile: File get() = File(dshHome, "mcp-result.json")
    private val resultTmp: File get() = File(dshHome, "mcp-result.json.tmp")

    private val running = AtomicBoolean(false)
    private var job: Job? = null

    /** 单次轮询；返回 true 表示处理了一条命令（便于测试断言）。 */
    suspend fun pollOnce(): Boolean {
        val file = cmdFile
        if (!file.isFile) return false

        val raw = runCatching { file.readText() }.getOrNull() ?: return false
        val msg = runCatching { JSONObject(raw) }.getOrNull()
        if (msg == null) {
            // 半截写入/非 JSON：删掉，避免每 120ms 空转
            Log.w(TAG, "mcp-cmd 非法 JSON，已丢弃")
            file.delete()
            return false
        }

        val id = msg.optLong("id", -1L)
        val action = msg.optString("action")
        val args = msg.optJSONObject("args") ?: JSONObject()
        val ts = msg.optLong("ts", 0L)

        // 陈旧命令（App 被杀后残留）直接丢弃，避免"开机自己点一下"
        if (ts > 0 && System.currentTimeMillis() - ts > STALE_MS) {
            Log.w(TAG, "mcp-cmd 已过期（${System.currentTimeMillis() - ts}ms），丢弃 id=$id action=$action")
            file.delete()
            return false
        }

        // 先删命令，再执行：宁可丢一次调用，也不重复点一次
        file.delete()

        val result = try {
            dispatch(action, args)
        } catch (t: Throwable) {
            Log.e(TAG, "MCP action=$action 失败", t)
            failure(t.message ?: t::class.java.simpleName)
        }

        result.put("id", id)
        writeAtomically(result.toString())
        Log.i(TAG, "MCP 已处理 id=$id action=$action ok=${result.optBoolean("ok")}")
        return true
    }

    private suspend fun dispatch(action: String, args: JSONObject): JSONObject = when (action) {
        "dump" -> ok(capabilities.dump())
        "tap" -> ok(capabilities.tap(args.optInt("x"), args.optInt("y")))
        "type" -> ok(capabilities.type(args.optString("text")))
        "screenshot" -> ok(capabilities.screenshot())
        "shell" -> ok(capabilities.shell(args.optString("command")))
        "notify" -> ok(capabilities.notify(args.optString("title"), args.optString("text")))
        "open_with" -> ok(capabilities.openWith(args.optString("path"), args.optString("mime").ifBlank { null }))
        else -> failure("未知 action: $action")
    }

    private fun ok(data: Map<String, Any?>): JSONObject =
        JSONObject().put("ok", true).put("data", JSONObject(data))

    private fun failure(message: String): JSONObject =
        JSONObject().put("ok", false).put("error", message)

    private fun writeAtomically(text: String) {
        resultTmp.writeText(text)
        if (!resultTmp.renameTo(resultFile)) {
            // 某些文件系统 rename 覆盖会失败：退化为直接写（对端有 JSON 容错）
            resultFile.writeText(text)
            resultTmp.delete()
        }
    }

    /** 启动轮询；重复调用无副作用。 */
    fun start(scope: CoroutineScope, intervalMs: Long = POLL_MS): Job? {
        if (!running.compareAndSet(false, true)) return job
        job = scope.launch(Dispatchers.IO) {
            Log.i(TAG, "MCP 桥启动: ${cmdFile.absolutePath}")
            while (isActive && running.get()) {
                runCatching { pollOnce() }
                    .onFailure { Log.w(TAG, "MCP 轮询异常: ${it.message}") }
                delay(intervalMs)
            }
        }
        return job
    }

    fun stop() {
        running.set(false)
        job?.cancel()
        job = null
    }

    private companion object {
        const val TAG = "DSH"
        const val POLL_MS = 120L
        const val STALE_MS = 30_000L
    }
}

/**
 * MCP 桥依赖的 Android 能力面。
 *
 * 刻意用接口而不是直接调现有桥：这样单测可以注入假实现，
 * 也不会把 `McpBridge` 绑死到 `UiProbeBridge` / `ShellPrivilege` 的具体类上。
 * 生产实现直接转发给现有能力即可（`ui-probe` / `PrivilegedShell` / 通知）。
 */
interface AndroidCapabilities {
    suspend fun dump(): Map<String, Any?>
    suspend fun tap(x: Int, y: Int): Map<String, Any?>
    suspend fun type(text: String): Map<String, Any?>
    suspend fun screenshot(): Map<String, Any?>
    suspend fun shell(command: String): Map<String, Any?>
    suspend fun notify(title: String, text: String): Map<String, Any?>
    suspend fun openWith(path: String, mime: String?): Map<String, Any?>
}