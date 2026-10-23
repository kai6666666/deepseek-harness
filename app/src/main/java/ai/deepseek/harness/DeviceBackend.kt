package ai.deepseek.harness

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.provider.Settings
import java.io.File

/**
 * 五套后端 —— 对齐 Operit 的 `AndroidPermissionLevel` × `ToolGetter` 模型。
 *
 * Operit 的做法是按等级切换工具实现（Standard / Accessibility / Debugger(Shizuku) / Admin / Root），
 * 这里把「UI 操作」这一族抽成统一接口 [DeviceBackend]，五套各自实现，
 * 由 [BackendRegistry.pick] 按当前最高可用等级选一个。
 */
interface DeviceBackend {
    val level: PermissionLevel
    val name: String

    fun isAvailable(ctx: Context): Boolean

    /** 返回 null 表示成功，否则返回给模型看的错误说明 */
    suspend fun tap(x: Float, y: Float): String?
    suspend fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long): String?
    suspend fun screenshotPngBase64(): String?
    fun uiDump(limit: Int): String?
}

// ---------------------------------------------------------------- 1. STANDARD

/** 无任何特权：只能看自己、截图靠 MediaProjection（未授权时明确拒绝） */
object StandardBackend : DeviceBackend {
    override val level = PermissionLevel.STANDARD
    override val name = "standard"

    override fun isAvailable(ctx: Context) = true

    override suspend fun tap(x: Float, y: Float): String? =
        "STANDARD 等级不能注入手势。请打开无障碍（request_permission kind=accessibility）或安装 Shizuku/Root。"

    override suspend fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long): String? =
        tap(x1, y1)

    override suspend fun screenshotPngBase64(): String? = null

    override fun uiDump(limit: Int): String? = null
}

// ------------------------------------------------------------ 2. ACCESSIBILITY

/** 无障碍：手势 / 截图 / 节点树，全在进程内，最省事 */
object AccessibilityBackend : DeviceBackend {
    override val level = PermissionLevel.ACCESSIBILITY
    override val name = "accessibility"

    override fun isAvailable(ctx: Context) = HarnessAccessibilityService.isReady()

    override suspend fun tap(x: Float, y: Float): String? =
        HarnessAccessibilityService.instance?.let { if (it.tap(x, y)) null else "tap cancelled" }
            ?: "无障碍服务未就绪"

    override suspend fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long): String? =
        HarnessAccessibilityService.instance
            ?.let { if (it.swipe(x1, y1, x2, y2, durationMs)) null else "swipe cancelled" }
            ?: "无障碍服务未就绪"

    override suspend fun screenshotPngBase64(): String? =
        HarnessAccessibilityService.instance?.screenshotPngBase64()

    override fun uiDump(limit: Int): String? =
        HarnessAccessibilityService.instance?.dumpNodes(limit)
}

// --------------------------------------------------------------- 3. DEBUGGER

/** Shizuku（uid 2000）：`input` / `screencap` / `uiautomator`，等价 Operit 的 DEBUGGER */
object DebuggerBackend : DeviceBackend {
    override val level = PermissionLevel.DEBUGGER
    override val name = "shizuku"

    override fun isAvailable(ctx: Context) = ShizukuShell.isReady()

    override suspend fun tap(x: Float, y: Float): String? =
        ShizukuShell.run("input tap ${x.toInt()} ${y.toInt()}")

    override suspend fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long): String? =
        ShizukuShell.run(
            "input swipe ${x1.toInt()} ${y1.toInt()} ${x2.toInt()} ${y2.toInt()} " +
                durationMs.coerceIn(50L, 5000L),
        )

    override suspend fun screenshotPngBase64(): String? =
        ShizukuShell.execOut("screencap -p")?.let { bytes ->
            android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
        }

    override fun uiDump(limit: Int): String? {
        val path = "/data/local/tmp/dsh_ui.xml"
        ShizukuShell.run("uiautomator dump $path") ?: return null
        return ShizukuShell.run("cat $path")
    }
}

// ------------------------------------------------------------------ 4. ADMIN

/** 设备管理员 / Device Owner：能改安全设置、免 root 授予运行时权限 */
object AdminBackend : DeviceBackend {
    override val level = PermissionLevel.ADMIN
    override val name = "admin"

    fun isDeviceOwner(ctx: Context): Boolean = runCatching {
        val dpm = ctx.getSystemService(DevicePolicyManager::class.java)
        dpm.isDeviceOwnerApp(ctx.packageName)
    }.getOrDefault(false)

    override fun isAvailable(ctx: Context) = isDeviceOwner(ctx) || ShizukuShell.isReady()

    override suspend fun tap(x: Float, y: Float): String? =
        ShizukuShell.run("input tap ${x.toInt()} ${y.toInt()}")

    override suspend fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long): String? =
        ShizukuShell.run(
            "input swipe ${x1.toInt()} ${y1.toInt()} ${x2.toInt()} ${y2.toInt()} $durationMs",
        )

    override suspend fun screenshotPngBase64(): String? =
        ShizukuShell.execOut("screencap -p")
            ?.let { android.util.Base64.encodeToString(it, android.util.Base64.NO_WRAP) }

    override fun uiDump(limit: Int): String? = DebuggerBackend.uiDump(limit)

    /** Admin 专属：批量授予运行时权限（Operit 里这类能力挂在管理员档） */
    fun grantRuntimePermission(pkg: String, perm: String): String? =
        ShizukuShell.run("pm grant $pkg $perm")
}

// ------------------------------------------------------------------- 5. ROOT

/** su：直接以 uid 0 跑 shell */
object RootBackend : DeviceBackend {
    override val level = PermissionLevel.ROOT
    override val name = "root"

    override fun isAvailable(ctx: Context) = SuShell.isReady()

    override suspend fun tap(x: Float, y: Float): String? =
        SuShell.run("input tap ${x.toInt()} ${y.toInt()}")

    override suspend fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long): String? =
        SuShell.run(
            "input swipe ${x1.toInt()} ${y1.toInt()} ${x2.toInt()} ${y2.toInt()} $durationMs",
        )

    override suspend fun screenshotPngBase64(): String? =
        SuShell.execOut("screencap -p")
            ?.let { android.util.Base64.encodeToString(it, android.util.Base64.NO_WRAP) }

    override fun uiDump(limit: Int): String? {
        val path = "/data/local/tmp/dsh_ui.xml"
        SuShell.run("uiautomator dump $path") ?: return null
        return SuShell.run("cat $path")
    }
}

// -------------------------------------------------------------- 选择器

/** 对应 Operit 的 `ToolGetter`：按当前最高可用等级挑后端 */
object BackendRegistry {
    private val order = listOf<DeviceBackend>(
        RootBackend, AdminBackend, DebuggerBackend, AccessibilityBackend, StandardBackend,
    )

    fun pick(ctx: Context): DeviceBackend = order.firstOrNull { it.isAvailable(ctx) } ?: StandardBackend

    fun describe(ctx: Context): String = buildString {
        appendLine("selected=${pick(ctx).name}")
        order.forEach { appendLine("${it.level.name.padEnd(13)}=${it.isAvailable(ctx)} (${it.name})") }
    }
}

// ---------------------------------------------------------------- shell 层

private object ShizukuShell {
    /** Shizuku 14.x：反射拿 `Shizuku.newProcess(String[], String[], String)` */
    fun isReady(): Boolean = runCatching {
        val cls = Class.forName("rikka.shizuku.Shizuku")
        cls.getMethod("pingBinder").invoke(null) as Boolean &&
            cls.getMethod("getUid").invoke(null) as Int != -1
    }.getOrDefault(false)

    fun run(cmd: String): String? = exec(cmd)?.first

    fun execOut(cmd: String): ByteArray? = exec(cmd)?.second

    fun exec(cmd: String): Pair<String, ByteArray>? = runCatching {
        val cls = Class.forName("rikka.shizuku.Shizuku")
        val newProcess = cls.getMethod(
            "newProcess", Array<String>::class.java, Array<String>::class.java, String::class.java,
        )
        val proc = newProcess.invoke(
            null,
            arrayOf("sh", "-c", cmd),
            null,
            "/",
        ) as java.lang.Process
        val out = proc.inputStream.readBytes()
        val code = proc.waitFor()
        if (code != 0) return null
        Pair(String(out, Charsets.UTF_8), out)
    }.getOrNull()
}

private object SuShell {
    fun isReady(): Boolean = runCatching {
        val p = ProcessBuilder("su", "-c", "id").redirectErrorStream(true).start()
        val txt = p.inputStream.bufferedReader().readText()
        p.waitFor()
        txt.contains("uid=0")
    }.getOrDefault(false)

    fun run(cmd: String): String? = exec(cmd)?.first

    fun execOut(cmd: String): ByteArray? = exec(cmd)?.second

    fun exec(cmd: String): Pair<String, ByteArray>? = runCatching {
        val p = ProcessBuilder("su", "-c", cmd).redirectErrorStream(true).start()
        val out = p.inputStream.readBytes()
        val code = p.waitFor()
        if (code != 0) return null
        Pair(String(out, Charsets.UTF_8), out)
    }.getOrNull()
}

/** 便于 UI 侧显示"当前权限档" */
fun Context.permissionSummary(): String = PermissionGate.status(this).describe()