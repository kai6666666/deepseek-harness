package com.dsh.android.engine

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * 宿主选择器。
 *
 * `HostMode` 只有三个值，对应三条真实可落地的路线：
 *   · [HostMode.TERMUX_BIONIC] —— 现状（Termux + 自编译原生绑定 + boo-sandbox）
 *   · [HostMode.PROOT_GLIBC]   —— C 方案（glibc 引擎 + 官方预编译全解锁）
 *   · [HostMode.REMOTE]        —— 远端引擎（电脑/NAS/云），手机只做前端
 *
 * ⚠️ 迁移纪律（借自 Operit2 的「任务交接边界」）：切换宿主必须在
 * 「上一轮工具结果已持久化、下一轮模型请求尚未开始」的边界上做，
 * 不搬迁运行中的请求、终端进程或浏览器会话。
 */
enum class HostMode { TERMUX_BIONIC, PROOT_GLIBC, REMOTE }

object EngineHosts {

    /**
     * @param termuxLauncher 现状宿主的启动入口。由 `EngineManager` 注入，
     *   这样本文件不必反向依赖它（避免循环依赖，也让单测能注入假实现）。
     */
    fun create(
        mode: HostMode,
        filesDir: File,
        termuxLauncher: (suspend (EngineStartSpec) -> EngineEndpoint)? = null,
        remoteBaseUrl: String? = null,
    ): EngineHost = when (mode) {
        HostMode.TERMUX_BIONIC -> TermuxBionicHost(filesDir, termuxLauncher)
        HostMode.PROOT_GLIBC -> ProotGlbcHost(filesDir)
        HostMode.REMOTE -> RemoteHost(requireNotNull(remoteBaseUrl) { "REMOTE 宿主需要 baseUrl" })
    }
}

/**
 * 现状宿主：Termux(bionic) + **为 android 自编译**的原生绑定。
 *
 * 与 C 方案的差别只有三处（其余全部相同）：
 *   ① `process.platform === 'android'`，官方 linux 分支不生效 → 靠 `--patch` 与锚点补丁；
 *   ② 原生模块要自己编（flock / node-pty / system.node）；
 *   ③ sharp 只能走 wasm32 变体。
 */
class TermuxBionicHost(
    private val filesDir: File,
    private val launcher: (suspend (EngineStartSpec) -> EngineEndpoint)?,
) : EngineHost {

    override val id: String = "termux-bionic"

    override fun capabilities(): HostCapabilities {
        val runner = File(filesDir, "boo-sandbox-run")
        return HostCapabilities(
            platform = "android",
            kernelSandbox = false,
            sandboxRunner = if (runner.isFile) {
                SandboxRunner(listOf(runner.absolutePath), listOf("boo-sandbox-run: "))
            } else {
                null
            },
            pty = true,
            imagePipeline = true, // sharp wasm32
            nativePrebuilds = NativePrebuildKind.ANDROID_SELF_BUILT,
            pidNamespace = false,
            summary = "bionic 自编译绑定；原生插件需 android 产物才可用",
        )
    }

    override suspend fun start(spec: EngineStartSpec): EngineEndpoint =
        launcher?.invoke(spec)
            ?: throw EngineHostException("TermuxBionicHost 未注入 launcher：请在 EngineManager 初始化时传入")

    override suspend fun stop() = Unit

    override fun isRunning(): Boolean = false
}

/**
 * 远端宿主：引擎跑在别的机器上，本机 WebView 只是显示器。
 *
 * 唯一能做到 100% 原版的路线（`computer-use`、`pwsh`、真 bwrap 全部回来），
 * 代价是需要一台常开机器 + 网络。
 */
class RemoteHost(private val baseUrl: String) : EngineHost {

    override val id: String = "remote"

    override fun capabilities(): HostCapabilities = HostCapabilities(
        platform = "linux",
        kernelSandbox = true,
        sandboxRunner = null,
        pty = true,
        imagePipeline = true,
        nativePrebuilds = NativePrebuildKind.GLIBC_PREBUILT,
        pidNamespace = true,
        summary = "引擎在远端主机，能力取决于那台机器",
    )

    override suspend fun start(spec: EngineStartSpec): EngineEndpoint = withContext(Dispatchers.IO) {
        EngineEndpoint(baseUrl = baseUrl, pid = null, logFile = null)
    }

    override suspend fun stop() = Unit

    override fun isRunning(): Boolean = true
}