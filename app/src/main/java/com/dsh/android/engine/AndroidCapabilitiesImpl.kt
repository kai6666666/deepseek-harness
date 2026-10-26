package com.dsh.android.engine

/**
 * [AndroidCapabilities] 的生产实现：把 MCP 桥接到**已有**的原生通道上。
 *
 * 设计：不在这个类里直接调用 `MainActivity` 的内部方法，而是注入函数——
 * 这样 App 侧接线只需在初始化时传 6 个 lambda，桥本身零改动，单测也能注入假实现。
 *
 * 生产接线示例：
 * ```kotlin
 * val mcp = McpBridge(
 *     dshHome = manager.dshHomeDir,
 *     capabilities = AndroidCapabilitiesImpl(
 *         dumpFn = { uiProbeBridge.dump() },
 *         tapFn = { x, y -> uiProbeBridge.tap(x, y) },
 *         typeFn = { text -> uiProbeBridge.type(text) },
 *         screenshotFn = { screenshotter.captureToAppDir() },
 *         shellFn = { cmd -> privilegedShell.run(cmd) },
 *         notifyFn = { title, text -> notifier.post(title, text) },
 *     ),
 * )
 * mcp.start(lifecycleScope)
 * ```
 *
 * 未接线的能力**明确报错**，不返回假成功——桥的纪律之一（失败要显式）。
 */
class AndroidCapabilitiesImpl(
    private val dumpFn: suspend () -> Map<String, Any?>,
    private val tapFn: suspend (x: Int, y: Int) -> Map<String, Any?>,
    private val typeFn: suspend (text: String) -> Map<String, Any?>,
    private val screenshotFn: suspend () -> Map<String, Any?>,
    private val shellFn: suspend (command: String) -> Map<String, Any?>,
    private val notifyFn: suspend (title: String, text: String) -> Map<String, Any?>,
    private val openWithFn: suspend (path: String, mime: String?) -> Map<String, Any?>,
) : AndroidCapabilities {

    override suspend fun dump(): Map<String, Any?> = dumpFn()
    override suspend fun tap(x: Int, y: Int): Map<String, Any?> = tapFn(x, y)
    override suspend fun type(text: String): Map<String, Any?> = typeFn(text)
    override suspend fun screenshot(): Map<String, Any?> = screenshotFn()
    override suspend fun shell(command: String): Map<String, Any?> = shellFn(command)
    override suspend fun notify(title: String, text: String): Map<String, Any?> = notifyFn(title, text)
    override suspend fun openWith(path: String, mime: String?): Map<String, Any?> = openWithFn(path, mime)
}

/** 未接线的能力集：每个调用都以明确错误返回，便于“桥通了但能力没接”时快速定位。 */
object UnwiredCapabilities : AndroidCapabilities {
    private fun nope(what: String): Nothing =
        throw EngineHostException("MCP 能力未接线: $what（在 AndroidCapabilitiesImpl 里注入实现）")

    override suspend fun dump(): Map<String, Any?> = nope("dump")
    override suspend fun tap(x: Int, y: Int): Map<String, Any?> = nope("tap")
    override suspend fun type(text: String): Map<String, Any?> = nope("type")
    override suspend fun screenshot(): Map<String, Any?> = nope("screenshot")
    override suspend fun shell(command: String): Map<String, Any?> = nope("shell")
    override suspend fun notify(title: String, text: String): Map<String, Any?> = nope("notify")
    override suspend fun openWith(path: String, mime: String?): Map<String, Any?> = nope("openWith")
}
