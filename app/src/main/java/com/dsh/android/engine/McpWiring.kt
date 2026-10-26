package com.dsh.android.engine

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File

/**
 * 把 MCP 桥接上现有能力，**不再新写原生代码**：
 *
 * | MCP 工具 | 走的通道 | 复用对象 |
 * |---|---|---|
 * | `android_ui_dump` / `android_tap` / `android_type` | `ui-cmd.json` / `ui-result.json` | 现有 `UiProbeBridge` |
 * | `android_notify` | `NotificationManager` | 本文件内实现 |
 * | `android_screenshot` / `android_shell` | 注入 lambda | 由调用方接 |
 *
 * 为什么复用 `ui-cmd.json`：协议已被 `dsh-android-uiagent` 与 `UiProbeBridge` 验证过
 * （含坐标换算、遮挡判定、`onTarget` 回执）。MCP 只换入口，不复制实现。
 */
object McpWiring {

    private const val TAG = "DSH"
    private const val CHANNEL_ID = "dsh-mcp"
    private const val CHANNEL_NAME = "DSH MCP"

    /** 复用现有 ui 桥协议：写命令 → 等回执（按 id 匹配）。 */
    class UiCommandClient(private val dshHome: File) {
        private val cmd: File get() = File(dshHome, "ui-cmd.json")
        private val res: File get() = File(dshHome, "ui-result.json")

        suspend fun call(action: String, args: JSONObject, timeoutMs: Long = 15_000): Map<String, Any?> =
            withContext(Dispatchers.IO) {
                val id = System.nanoTime()
                cmd.writeText(
                    JSONObject()
                        .put("id", id)
                        .put("action", action)
                        .put("args", args)
                        .put("ts", System.currentTimeMillis())
                        .toString(),
                )

                val deadline = System.currentTimeMillis() + timeoutMs
                while (System.currentTimeMillis() < deadline) {
                    val text = runCatching { res.readText() }.getOrNull()
                    if (text != null) {
                        val obj = runCatching { JSONObject(text) }.getOrNull()
                        if (obj != null && obj.optLong("id") == id) {
                            res.delete()
                            if (!obj.optBoolean("ok", true)) {
                                throw EngineHostException(obj.optString("error", "$action 被原生侧拒绝"))
                            }
                            val data = obj.optJSONObject("data") ?: JSONObject()
                            return@withContext data.keys().asSequence()
                                .associateWith { k -> data.opt(k) }
                        }
                    }
                    Thread.sleep(120)
                }
                throw EngineHostException(
                    "原生 ui 桥无响应（$action > ${timeoutMs}ms）：检查 UiProbeBridge 是否在轮询 ${cmd.absolutePath}",
                )
            }
    }

    /**
     * @param shell 可选：uid2000 执行通道；未接线时 `android_shell` 明确报错
     * @param screenshot 可选：截图实现；未接线时明确报错
     */
    fun install(
        context: Context,
        dshHome: File,
        scope: CoroutineScope,
        shell: (suspend (String) -> Map<String, Any?>)? = null,
        screenshot: (suspend () -> Map<String, Any?>)? = null,
    ): McpBridge {
        val ui = UiCommandClient(dshHome)
        val caps = AndroidCapabilitiesImpl(
            dumpFn = { ui.call("dump", JSONObject()) },
            tapFn = { x, y -> ui.call("tap", JSONObject().put("x", x).put("y", y)) },
            typeFn = { text -> ui.call("type", JSONObject().put("text", text)) },
            screenshotFn = { screenshot?.invoke() ?: throw EngineHostException("screenshot 未接线") },
            shellFn = { cmd -> shell?.invoke(cmd) ?: throw EngineHostException("shell 未接线（需 Shizuku/adb/root）") },
            notifyFn = { title, text -> notify(context, title, text) },
        )
        val bridge = McpBridge(dshHome, caps)
        bridge.start(scope)
        Log.i(TAG, "MCP 桥已接线: ${dshHome.absolutePath}")
        return bridge
    }

    /** 直接发系统通知；targetSdk 28 下无需运行时通知权限。 */
    fun notify(context: Context, title: String, text: String): Map<String, Any?> {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_DEFAULT),
                )
            }
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            android.app.Notification.Builder(context, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            android.app.Notification.Builder(context)
        }
        nm.notify(
            (System.currentTimeMillis() and 0xFFFFFF).toInt(),
            builder.setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle(title)
                .setContentText(text)
                .setAutoCancel(true)
                .build(),
        )
        return mapOf("notified" to true, "title" to title)
    }
}
