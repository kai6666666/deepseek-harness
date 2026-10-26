package com.dsh.android.engine

import java.io.File

/**
 * 引擎宿主抽象。
 *
 * 为什么需要它
 * ------------
 * 现在 `EngineManager` 里 60+ 个 `ensure*` / `patch*` / `write*` 函数同时承担两件事：
 *   ① 准备一个能跑 Node 的环境（Termux / proot / 远端）；
 *   ② 给引擎打 Android 适配层（沙箱 runner、rg、link 兼容、插件源…）。
 * 于是「换宿主」= 改 60 个函数。C 方案（proot glibc）只是第一个新宿主，
 * 后面还会有远端引擎、AVF Linux VM —— 所以先把 ① 抽出来。
 *
 * 约定：实现方只负责「把引擎跑起来并给出 baseUrl」，不碰 UI、不碰救援。
 */
interface EngineHost {

    /** 稳定标识，用于日志、偏好存储与诊断包。 */
    val id: String

    /** 运行期能力声明：UI 据此置灰开关，而不是让用户点了没反应。 */
    fun capabilities(): HostCapabilities

    /** 启动引擎；成功返回可连接的端点，失败抛 [EngineHostException]。 */
    suspend fun start(spec: EngineStartSpec): EngineEndpoint

    /** 停止引擎（幂等）。 */
    suspend fun stop()

    fun isRunning(): Boolean
}

/** 引擎承载方式的能力声明。 */
data class HostCapabilities(
    /** 引擎进程看到的 `process.platform`：`android`（bionic）或 `linux`（glibc）。 */
    val platform: String,
    /** 是否有内核级文件沙箱（bwrap / Landlock / Seatbelt）。 */
    val kernelSandbox: Boolean,
    /** 用户态 runner（LD_PRELOAD 拦截）。为空表示只能走 danger-full-access。 */
    val sandboxRunner: SandboxRunner?,
    /** PTY 终端可用（node-pty）。 */
    val pty: Boolean,
    /** 图片管线可用（sharp）。 */
    val imagePipeline: Boolean,
    /** 原生模块来自哪里。 */
    val nativePrebuilds: NativePrebuildKind,
    /** 是否有 PID 命名空间隔离。 */
    val pidNamespace: Boolean,
    /** 人类可读的一句话，用于设置页副标题。 */
    val summary: String,
)

enum class NativePrebuildKind {
    /** 没有可用原生模块（纯 JS 兜底）。 */
    NONE,

    /** 为 bionic 自编译（flock / node-pty / system.node）。 */
    ANDROID_SELF_BUILT,

    /** 官方 linux-arm64 glibc 预编译（flock / sharp / node-pty / better-sqlite3）。 */
    GLIBC_PREBUILT,
}

/** 沙箱 runner 的声明，对应 `dsh-sandbox-local` 的 `Config.runnerCommand`。 */
data class SandboxRunner(
    /** 绝对路径 argv，例如 [filesDir/boo-sandbox-run]。 */
    val command: List<String>,
    /**
     * runner 自身失败的 stderr 前缀。
     *
     * ⚠️ 两个硬约束（`sandbox-local/src/index.ts:285-293`）：
     *   · 有 runnerCommand 而无签名 → 构造时抛错，整条 sandbox 服务注册失败；
     *   · 有签名而无 runnerCommand → 同样抛错。
     * 而且这个前缀必须与 runner 源码里每条 fail-closed 路径的输出逐字一致。
     */
    val failureSignatures: List<String>,
)

enum class SandboxMode { READ_ONLY, WORKSPACE_WRITE, DANGER_FULL_ACCESS }

/** 一次启动所需的全部输入。 */
data class EngineStartSpec(
    val filesDir: File,
    val dshHome: File,
    val workspace: File,
    val port: Int = 3080,
    val profile: String = "web",
    /** 额外 overlay，按顺序传给 `--patch`。 */
    val extraPatches: List<File> = emptyList(),
    val sandboxMode: SandboxMode = SandboxMode.WORKSPACE_WRITE,
    /** 非空则跳过本地启动，直接把该 URL 当作引擎端点（远端宿主用）。 */
    val baseUrlOverride: String? = null,
) {
    val baseUrl: String get() = baseUrlOverride ?: "http://127.0.0.1:$port"
    val engineLog: File get() = File(dshHome, "logs/engine.log")
}

data class EngineEndpoint(
    val baseUrl: String,
    val pid: Long?,
    val logFile: File?,
)

class EngineHostException(message: String, cause: Throwable? = null) : Exception(message, cause)
