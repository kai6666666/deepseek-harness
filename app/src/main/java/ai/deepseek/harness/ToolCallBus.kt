package ai.deepseek.harness

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/**
 * MCP 工具调用事件总线：给悬浮窗状态条用，也让日志有结构。
 *
 * 只在进程内广播，不做持久化 —— 目的是「让人看见 agent 正在干什么」，
 * 历史记录仍在 DSH 的 session 里。
 */
data class ToolEvent(
    val name: String,
    val phase: Phase,
    val detail: String = "",
    val elapsedMs: Long = 0L,
) {
    enum class Phase { START, OK, ERROR }
}

object ToolCallBus {

    private val _events = MutableSharedFlow<ToolEvent>(extraBufferCapacity = 32)
    val events: SharedFlow<ToolEvent> = _events.asSharedFlow()

    /** 最近一次调用，给刚打开的界面补状态用 */
    @Volatile
    var last: ToolEvent? = null
        private set

    fun emit(event: ToolEvent) {
        last = event
        _events.tryEmit(event)
    }

    /** 一行紧凑描述，直接贴到状态条上 */
    fun render(e: ToolEvent): String = when (e.phase) {
        ToolEvent.Phase.START -> "▶ ${e.name}"
        ToolEvent.Phase.OK -> "✓ ${e.name} ${e.elapsedMs}ms${if (e.detail.isBlank()) "" else " · ${e.detail}"}"
        ToolEvent.Phase.ERROR -> "✗ ${e.name}${if (e.detail.isBlank()) "" else " · ${e.detail}"}"
    }
}