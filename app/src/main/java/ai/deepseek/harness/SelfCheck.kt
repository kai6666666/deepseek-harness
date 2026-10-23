package ai.deepseek.harness

import android.content.Context
import android.provider.Settings
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket

/**
 * 自检：一次性回答「我现在能做什么」。
 *
 * 设计原则：只读、无副作用、失败也返回结构化结果 —— 让模型自己决定下一步，
 * 而不是靠一次次试探去撞权限墙。
 */
object SelfCheck {

    private data class Item(
        val id: String,
        val ok: Boolean,
        val detail: String,
        val hint: String = "",
    )

    fun run(ctx: Context): String {
        val items = ArrayList<Item>(12)

        // 1 无障碍
        val a11y = HarnessAccessibilityService.isReady() ||
            PermissionGate.isAccessibilityEnabled(ctx)
        items += Item(
            "accessibility", a11y,
            if (a11y) "ready" else "off",
            if (a11y) "" else "request_permission kind=accessibility",
        )

        // 2 悬浮窗
        val overlay = Settings.canDrawOverlays(ctx)
        items += Item(
            "overlay", overlay,
            if (overlay) "granted" else "denied",
            if (overlay) "" else "request_permission kind=overlay",
        )

        // 3 电池白名单
        val battery = PermissionGate.isBatteryWhitelisted(ctx)
        items += Item(
            "battery", battery,
            if (battery) "whitelisted" else "optimized",
            if (battery) "" else "request_permission kind=battery",
        )

        // 4 提权档位
        val caps = PermissionGate.status(ctx)
        items += Item("shizuku", caps.shizukuRunning, "running=${caps.shizukuRunning}, installed=${caps.shizukuInstalled}")
        items += Item("root", caps.root, if (caps.root) "uid=0" else "no su")
        items += Item("level", true, caps.level().name)

        // 5 rootfs
        val rootfs = EnvManager.isReady(ctx)
        items += Item("rootfs", rootfs, if (rootfs) "node ok" else "missing layer")

        // 6 dsh 版本
        val pkg = File(
            ctx.filesDir,
            "usr/var/lib/proot-distro/installed-rootfs/ubuntu/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json",
        )
        val dshVer = runCatching {
            JSONObject(pkg.readText()).optString("version")
        }.getOrDefault("")
        items += Item("dsh", dshVer.isNotBlank(), dshVer.ifBlank { "not installed" })

        // 7 内核状态
        val st = DshRuntime.get(ctx).state.value
        items += Item(
            "dsh_runtime", st.phase == Phase.READY,
            "${st.phase} port=${st.port} url=${if (st.url == null) "-" else "token-ok"}",
            if (st.phase == Phase.READY) "" else "见通知栏；失败会自动退避重启",
        )

        // 8 MCP 回环
        val mcpOpen = McpServer.get(ctx).isAlive && portOpen(McpServer.PORT)
        items += Item(
            "mcp", mcpOpen, "127.0.0.1:${McpServer.PORT} ${if (mcpOpen) "open" else "closed"}",
            if (mcpOpen) "" else "前台服务是否在跑？",
        )

        // 9 工具后端
        val backend = BackendRegistry.pick(ctx)
        items += Item("backend", backend.level != PermissionLevel.STANDARD, backend.name)

        val okCount = items.count { it.ok }
        val json = JSONObject().apply {
            put("ok", items.filter { it.requiredHigh() }.all { it.ok })
            put("passed", okCount)
            put("total", items.size)
            put("summary", items.joinToString(" | ") { "${if (it.ok) "✓" else "✗"}${it.id}" })
            put("items", JSONArray().apply {
                items.forEach { i ->
                    put(JSONObject().apply {
                        put("id", i.id)
                        put("ok", i.ok)
                        put("detail", i.detail)
                        if (i.hint.isNotBlank()) put("hint", i.hint)
                    })
                }
            })
        }
        return json.toString(2)
    }

    private fun Item.requiredHigh(): Boolean = id in setOf("accessibility", "rootfs", "dsh", "dsh_runtime", "mcp")

    private fun portOpen(port: Int): Boolean = runCatching {
        Socket().use { it.connect(InetSocketAddress("127.0.0.1", port), 800) }
        true
    }.getOrDefault(false)
}