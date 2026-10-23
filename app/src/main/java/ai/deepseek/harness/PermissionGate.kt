package ai.deepseek.harness

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.text.TextUtils
import java.io.File

/**
 * 权限等级与授予流程 —— 移植自 Operit 的 `AndroidPermissionLevel` 模型。
 *
 * Operit 把能力分成五级，并按级别切换工具实现：
 *   STANDARD < ACCESSIBILITY < DEBUGGER(Shizuku) < ADMIN < ROOT
 * 我们保留「等级 + 能力探测 + 按工具声明最低等级」这三件事，
 * 工具实现只做一套（无障碍后端），等级不足时回 isError 并给出授予入口。
 */
enum class PermissionLevel(val rank: Int) {
    STANDARD(0),
    ACCESSIBILITY(1),
    DEBUGGER(2),   // Shizuku：等价 uid 2000(shell)
    ADMIN(3),      // Device Owner / 系统级（可 pm grant、改安全设置）
    ROOT(4),       // su：uid 0
}

enum class Capability(val label: String) {
    ACCESSIBILITY("无障碍服务"),
    SHIZUKU("Shizuku"),
    ROOT("Root"),
    BATTERY_WHITELIST("电池优化白名单"),
    OVERLAY("悬浮窗权限"),
}

data class CapabilityStatus(
    val accessibility: Boolean,
    val shizukuInstalled: Boolean,
    val shizukuRunning: Boolean,
    val root: Boolean,
    val batteryWhitelisted: Boolean,
) {
    /** 当前实际可用的最高等级 */
    fun level(): PermissionLevel = when {
        root -> PermissionLevel.ROOT
        shizukuRunning -> PermissionLevel.DEBUGGER
        accessibility -> PermissionLevel.ACCESSIBILITY
        else -> PermissionLevel.STANDARD
    }

    fun describe(): String = buildString {
        appendLine("level=${level().name}")
        appendLine("accessibility=$accessibility")
        appendLine("shizuku(installed=$shizukuInstalled, running=$shizukuRunning)")
        appendLine("root=$root")
        append("battery_whitelist=$batteryWhitelisted")
    }
}

object PermissionGate {

    private const val SHIZUKU_PKG = "moe.shizuku.privileged.api"

    fun status(context: Context): CapabilityStatus = CapabilityStatus(
        accessibility = isAccessibilityEnabled(context),
        shizukuInstalled = isPackageInstalled(context, SHIZUKU_PKG),
        shizukuRunning = isShizukuRunning(),
        root = hasRoot(),
        batteryWhitelisted = isBatteryWhitelisted(context),
    )

    // ------------------------------------------------------------ 探测

    /** 与 Operit 的 `UIHierarchyManager.isAccessibilityServiceEnabled` 等价 */
    fun isAccessibilityEnabled(context: Context): Boolean {
        if (HarnessAccessibilityService.isReady()) return true
        val expected = ComponentName(context, HarnessAccessibilityService::class.java)
        val enabled = runCatching {
            Settings.Secure.getString(
                context.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
            )
        }.getOrNull() ?: return false
        val splitter = TextUtils.SimpleStringSplitter(':')
        splitter.setString(enabled)
        while (splitter.hasNext()) {
            val part = splitter.next()
            if (part.equals(expected.flattenToString(), ignoreCase = true) ||
                part.equals(expected.flattenToShortString(), ignoreCase = true)
            ) {
                return true
            }
        }
        return false
    }

    private fun isPackageInstalled(context: Context, pkg: String): Boolean = runCatching {
        context.packageManager.getPackageInfo(pkg, 0)
        true
    }.getOrDefault(false)

    /** 不引 Shizuku 依赖，用进程名兜底判断服务是否在跑 */
    private fun isShizukuRunning(): Boolean = runCatching {
        File("/proc").listFiles()?.any { dir ->
            val cmd = File(dir, "cmdline").takeIf { it.canRead() }?.readText().orEmpty()
            cmd.contains("shizuku_server") || cmd.contains("rikka.shizuku")
        } ?: false
    }.getOrDefault(false)

    /** 只做检测，不主动提权：`su -c id` 由用户自己的 su 管理器弹窗 */
    fun hasRoot(): Boolean = runCatching {
        val p = ProcessBuilder("su", "-c", "id").redirectErrorStream(true).start()
        val out = p.inputStream.bufferedReader().readText()
        p.waitFor()
        out.contains("uid=0")
    }.getOrDefault(false)

    fun isBatteryWhitelisted(context: Context): Boolean = runCatching {
        val pm = context.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
        pm.isIgnoringBatteryOptimizations(context.packageName)
    }.getOrDefault(false)

    // ------------------------------------------------------------ 授予

    /**
     * 打开对应能力的授予入口。无障碍与电池优化只能跳系统页（设计如此），
     * Shizuku 走它自己的应用，Root 交给 su 弹窗。
     */
    fun openGrantScreen(context: Context, capability: Capability): Boolean = runCatching {
        val intent = when (capability) {
            Capability.ACCESSIBILITY -> Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            Capability.SHIZUKU -> context.packageManager.getLaunchIntentForPackage(SHIZUKU_PKG)
            Capability.BATTERY_WHITELIST -> Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                .setData(Uri.parse("package:${context.packageName}"))
            Capability.ROOT -> return hasRoot()
            Capability.OVERLAY -> Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:${context.packageName}"),
            )
        } ?: return false
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        true
    }.getOrDefault(false)

    /** 工具通过它做前置校验：等级不够就回一句话，模型能读懂并去触发授予 */
    fun requireTool(context: Context, need: PermissionLevel): String? {
        val st = status(context)
        val have = st.level()
        if (have.rank >= need.rank) return null
        return buildString {
            append("权限不足：该工具需要 ${need.name}，当前 ${have.name}。")
            when (need) {
                PermissionLevel.ACCESSIBILITY ->
                    append("请让用户执行 request_permission(kind=accessibility)，然后在系统设置里打开「DeepSeek Harness 屏幕控制」。")
                PermissionLevel.DEBUGGER ->
                    append("请安装并启动 Shizuku 后调用 request_permission(kind=shizuku)。")
                PermissionLevel.ADMIN ->
                    append("需要设备管理员/Device Owner：请先把本应用设为设备所有者，或改用 Shizuku/Root。")
                PermissionLevel.ROOT, PermissionLevel.STANDARD ->
                    append("请调用 request_permission 获取入口。")
            }
        }
    }
}