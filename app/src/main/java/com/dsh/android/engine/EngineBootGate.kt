package com.dsh.android.engine

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * 宿主启动闸门：把「选哪个宿主、起不来怎么办」收在一处。
 *
 * 为什么不让 EngineManager 直接 new：
 *   · EngineManager 里已经有 60+ 个 ensure/patch 函数，再塞宿主选择会变成第二个大泥球；
 *   · 降级策略必须是显式的（proot 起不来 → 回 bionic，而不是整个 App 打不开）。
 *
 * 与 Operit2 的 Binding 同一条纪律：**切换只发生在轮次边界**
 * （上一轮工具结果已持久化、下一轮模型请求尚未开始），不搬迁运行中的请求。
 */
object EngineBootGate {

    const val PREF_HOST = "engine_host"          // "bionic" | "proot" | "remote"
    const val PREF_REMOTE_URL = "engine_remote_url"

    private const val TAG = "DSH"

    data class BootResult(
        val baseUrl: String,
        val hostId: String,
        /** true = 请求的宿主没起来，已回落到 bionic */
        val degraded: Boolean,
        val note: String,
    )

    fun resolveMode(prefs: android.content.SharedPreferences?): HostMode =
        when (prefs?.getString(PREF_HOST, null)) {
            "proot" -> HostMode.PROOT_GLIBC
            "remote" -> HostMode.REMOTE
            else -> HostMode.TERMUX_BIONIC
        }

    /**
     * @param legacyLauncher 现状宿主（Termux/bionic）的启动实现，由 EngineManager 注入。
     * @param stopLegacy 停掉现状宿主的引擎（切换前必须先停，避免两个引擎抢 3080）。
     */
    suspend fun boot(
        filesDir: File,
        dshHome: File,
        workspace: File,
        prefs: android.content.SharedPreferences?,
        legacyLauncher: suspend (EngineStartSpec) -> EngineEndpoint,
        stopLegacy: suspend () -> Unit = {},
        port: Int = 3080,
    ): BootResult = withContext(Dispatchers.IO) {
        val mode = resolveMode(prefs)
        val remoteUrl = prefs?.getString(PREF_REMOTE_URL, null)?.takeIf { it.isNotBlank() }

        val spec = EngineStartSpec(
            filesDir = filesDir,
            dshHome = dshHome,
            workspace = workspace,
            port = port,
            baseUrlOverride = if (mode == HostMode.REMOTE) remoteUrl else null,
        )

        if (mode == HostMode.TERMUX_BIONIC) {
            val host = EngineHosts.create(mode, filesDir, legacyLauncher)
            return@withContext startOrThrow(host, spec)
        }

        // 切宿主：先停旧引擎，再起新的；失败则回落 bionic 而不是让 App 黑屏。
        runCatching { stopLegacy() }
        val host = EngineHosts.create(
            mode = mode,
            filesDir = filesDir,
            termuxLauncher = legacyLauncher,
            remoteBaseUrl = remoteUrl,
        )
        try {
            startOrThrow(host, spec)
        } catch (t: Throwable) {
            Log.e(TAG, "宿主 ${host.id} 启动失败，回落 bionic：${t.message}", t)
            val fallback = EngineHosts.create(HostMode.TERMUX_BIONIC, filesDir, legacyLauncher)
            val endpoint = fallback.start(spec)
            BootResult(
                baseUrl = endpoint.baseUrl,
                hostId = fallback.id,
                degraded = true,
                note = "宿主 ${host.id} 启动失败：${t.message}；已回落 bionic",
            )
        }
    }

    private suspend fun startOrThrow(host: EngineHost, spec: EngineStartSpec): BootResult {
        val caps = host.capabilities()
        Log.i(
            TAG,
            "宿主=${host.id} platform=${caps.platform} kernelSandbox=${caps.kernelSandbox} " +
                "prebuilds=${caps.nativePrebuilds} runner=${caps.sandboxRunner != null}",
        )
        val endpoint = host.start(spec)
        return BootResult(
            baseUrl = endpoint.baseUrl,
            hostId = host.id,
            degraded = false,
            note = caps.summary,
        )
    }
}