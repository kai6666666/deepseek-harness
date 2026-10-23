package ai.deepseek.harness

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File

/**
 * DSH 插件 ←→ 宿主 App 的文件信箱桥。
 *
 * 插件 `dsh-android-bridge`（容器内 /usr/local/lib/node_modules）把
 * `{id, tool, args}` 写进 `$DSH_HOME/android-bridge/req.json`，这里每 200 ms 轮询一次，
 * 交给 [McpServer] 里同一套工具实现执行，再把 `{id, ok, text}` 写回 `res-<id>.json`。
 *
 * 为什么不用 MCP：插件形态下模型看到的是原生工具名（`android_tap`），
 * 而且不依赖 HTTP / SSE / 协议握手，失败面只剩“文件写没写上”。
 */
object AndroidToolBridge {

    private const val TAG = "ToolBridge"
    private const val POLL_MS = 200L
    private const val RESULT_TTL_MS = 120_000L

    private var job: Job? = null

    fun start(app: Context) {
        if (job?.isActive == true) return
        val ctx = app.applicationContext
        job = CoroutineScope(SupervisorJob() + Dispatchers.IO).launch { poll(ctx) }
        Log.i(TAG, "文件信箱桥已启动")
    }

    fun stop() {
        job?.cancel()
        job = null
    }

    private fun mailboxDir(app: Context): File = File(
        app.filesDir,
        "usr/var/lib/proot-distro/installed-rootfs/ubuntu/root/.dsh/android-bridge",
    )

    private suspend fun poll(app: Context) {
        var lastId = -1L
        while (currentCoroutineContext().isActive) {
            val dir = mailboxDir(app)
            try {
                if (!dir.isDirectory) dir.mkdirs()
                val req = File(dir, "req.json")
                if (req.isFile) {
                    val obj = runCatching { JSONObject(req.readText()) }.getOrNull()
                    val id = obj?.optLong("id", -1L) ?: -1L
                    if (obj != null && id > 0 && id != lastId) {
                        lastId = id
                        val tool = obj.optString("tool")
                        val args = obj.optJSONObject("args") ?: JSONObject()
                        val started = System.currentTimeMillis()
                        val (ok, text) = McpServer.get(app).invoke(tool, args)
                        Log.i(TAG, "invoke #$id $tool ok=$ok ${System.currentTimeMillis() - started}ms")
                        val out = JSONObject()
                            .put("id", id)
                            .put("ok", ok)
                            .put("text", text)
                            .put("ts", System.currentTimeMillis())
                        val target = File(dir, "res-$id.json")
                        val tmp = File(dir, "res-$id.json.tmp")
                        tmp.writeText(out.toString())
                        if (!tmp.renameTo(target)) {
                            target.writeText(out.toString())
                            tmp.delete()
                        }
                        req.delete()
                        // 回执与请求都处理完，清掉过期的历史回执，避免信箱无限长大
                        dir.listFiles { f ->
                            f.name.startsWith("res-") && System.currentTimeMillis() - f.lastModified() > RESULT_TTL_MS
                        }?.forEach { it.delete() }
                    }
                }
            } catch (t: Throwable) {
                Log.w(TAG, "poll: ${t.message}")
            }
            delay(POLL_MS)
        }
    }
}