package ai.deepseek.harness

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Bitmap
import android.graphics.Path
import android.os.Build
import android.util.Base64
import android.util.Log
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import kotlin.coroutines.resume

/**
 * 无障碍后端：手势 / 节点树 / 截图。
 *
 * 选它而不是 Shizuku 的原因：不需要配对、不需要 shell 权限、装完让用户点一下开关就能用。
 * Shizuku 之后可以作为一个额外后端加进来，接口留在 [DeviceTools] 里。
 */
class HarnessAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "HarnessA11y"

        @Volatile
        var instance: HarnessAccessibilityService? = null
            private set

        fun isReady(): Boolean = instance != null
    }

    private val shotExecutor = Executors.newSingleThreadExecutor()

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        Log.i(TAG, "accessibility connected")
        // 无障碍就绪 = MCP 工具可用，顺手把 MCP server 拉起来
        McpServer.get(this).startServer()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit

    override fun onInterrupt() = Unit

    override fun onDestroy() {
        if (instance === this) instance = null
        shotExecutor.shutdownNow()
        super.onDestroy()
    }

    // ------------------------------------------------------------------ 手势

    suspend fun tap(x: Float, y: Float): Boolean {
        val path = Path().apply { moveTo(x, y) }
        return gesture(path, 0L, 50L)
    }

    suspend fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long): Boolean {
        val path = Path().apply {
            moveTo(x1, y1)
            lineTo(x2, y2)
        }
        return gesture(path, 0L, durationMs.coerceIn(50L, 5000L))
    }

    private suspend fun gesture(path: Path, startMs: Long, durationMs: Long): Boolean =
        suspendCancellableCoroutine { cont ->
            val stroke = GestureDescription.StrokeDescription(path, startMs, durationMs)
            val description = GestureDescription.Builder().addStroke(stroke).build()
            val ok = dispatchGesture(description, object : GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription?) {
                    if (cont.isActive) cont.resume(true)
                }

                override fun onCancelled(gestureDescription: GestureDescription?) {
                    if (cont.isActive) cont.resume(false)
                }
            }, null)
            if (!ok && cont.isActive) cont.resume(false)
        }

    // ------------------------------------------------------------------ 截图

    suspend fun screenshotPngBase64(): String? = suspendCancellableCoroutine { cont ->
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            cont.resume(null); return@suspendCancellableCoroutine
        }
        takeScreenshot(
            Display.DEFAULT_DISPLAY,
            shotExecutor,
            object : TakeScreenshotCallback {
                override fun onSuccess(result: ScreenshotResult) {
                    val bmp = runCatching {
                        Bitmap.wrapHardwareBuffer(result.hardwareBuffer, result.colorSpace)
                            ?.copy(Bitmap.Config.ARGB_8888, false)
                    }.getOrNull()
                    result.hardwareBuffer.close()
                    val b64 = bmp?.let {
                        ByteArrayOutputStream().use { out ->
                            it.compress(Bitmap.CompressFormat.PNG, 100, out)
                            Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
                        }
                    }
                    bmp?.recycle()
                    if (cont.isActive) cont.resume(b64)
                }

                override fun onFailure(errorCode: Int) {
                    Log.w(TAG, "screenshot failed: $errorCode")
                    if (cont.isActive) cont.resume(null)
                }
            },
        )
    }

    // ---------------------------------------------------------------- 节点树

    /** 压平成 JSON 数组，字段刻意精简（token 敏感） */
    fun dumpNodes(limit: Int = 400): String {
        val root = rootInActiveWindow ?: return "[]"
        val out = JSONArray()
        fun walk(node: AccessibilityNodeInfo?, depth: Int) {
            if (node == null || out.length() >= limit || depth > 40) return
            val bounds = android.graphics.Rect().also { node.getBoundsInScreen(it) }
            val item = JSONObject()
                .put("cls", node.className?.toString()?.substringAfterLast('.') ?: "")
                .put("text", node.text?.toString() ?: "")
                .put("desc", node.contentDescription?.toString() ?: "")
                .put("id", node.viewIdResourceName ?: "")
                .put(
                    "b",
                    JSONArray(listOf(bounds.left, bounds.top, bounds.right, bounds.bottom)),
                )
                .put("clickable", node.isClickable)
                .put("scrollable", node.isScrollable)
                .put("editable", node.isEditable)
            if (item.getString("text").isNotEmpty() || item.getString("desc").isNotEmpty() ||
                item.getString("id").isNotEmpty() || node.isClickable
            ) {
                out.put(item)
            }
            for (i in 0 until node.childCount) walk(node.getChild(i), depth + 1)
        }
        walk(root, 0)
        return out.toString()
    }
}