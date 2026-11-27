package com.dsh.android.log

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * 启动分段计时（B 阶段）。
 *
 * ## 为什么要有它
 *
 * 真机实测 `engine.ready.proot` 在 **t+46~53 秒**，而 `ProotHost` 启动到 `engine.ready`
 * 之间**约 48 秒没有任何日志**。到底是「proot 挂载慢」「node 冷启慢」还是「health
 * 探测空转」，单看现有事件流分不出来 —— 拆不开就优化不了。
 *
 * ## 为什么用内存 + 一次落盘
 *
 * `LogStore.writeApp` 是**每行 flush**（`LogStore.kt:489`，注释写"这就是崩溃时日志
 * 完整的代价"）。8 个打点各写一次 = 8 次 fsync，在主线程上足以造成卡顿。
 * 所以这里只做 `System.nanoTime()` 与 `ConcurrentHashMap`，全部打完后由
 * [dump] 一次性落盘（并经 `EventLog.record("boot.timeline")` 进事件流）。
 *
 * ⇒ 单点开销是「一次 nanoTime + 一次 map.put」，几十纳秒级，8 个点合计 < 1 ms。
 *
 * ## 时间基准
 *
 * 全部是**相对 [start] 的毫秒数**。宿主与 guest 的时钟**不能相减**（PRoot 里
 * `date` 与宿主可能差几秒），所以跨边界的那两个点（`proot.mounted` /
 * `node.exec`）只在**各自的时间轴**上记录，dump 时单独标注。
 */
object BootTimeline {

    /** 打点顺序（用于瀑布图按发生顺序输出）。 */
    private val order = CopyOnWriteArrayList<String>()

    /** 名称 → 相对 start() 的毫秒数。 */
    private val marks = ConcurrentHashMap<String, Long>()

    /** 每个打点的附加字段（如 `unpacked=true`），随 `dump()` 一起输出。 */
    private val extras = ConcurrentHashMap<String, Map<String, String>>()

    @Volatile
    private var t0: Long = 0L

    /** 总耗时（毫秒），未开始时为 -1。 */
    @Volatile
    var totalMs: Long = -1L
        private set

    /** 重置并开始计时。每次 `EngineManager.start()` 开头调用一次。 */
    fun start() {
        // `app` 点在 `EngineManager` 之前打（进程级），start() 不能把它丢掉，
        // 否则 dump 里永远看不到它（真机 vc133 实测）。
        val keepApp = marks["app"]
        marks.clear()
        order.clear()
        extras.clear()
        totalMs = -1L
        if (t0 == 0L) t0 = System.nanoTime()
        if (keepApp != null) { marks["app"] = keepApp; order.add("app") }
    }

    /** 进程级起点：在 `Application.onCreate` 最初调用一次，之后所有点都相对它。 */
    fun markProcessStart() {
        if (t0 == 0L) t0 = System.nanoTime()
    }

    /**
     * 打一个点。**幂等**：同名只记第一次（避免重试路径把耗时改小）。
     *
     * 未调用 [start] 时自动开始（例如 `Application.onCreate` 早于引擎启动）。
     */
    fun mark(name: String, extra: Map<String, String> = emptyMap()) {
        if (t0 == 0L) t0 = System.nanoTime()
        val ms = (System.nanoTime() - t0) / 1_000_000
        if (marks.putIfAbsent(name, ms) == null) {
            order.add(name)
            if (extra.isNotEmpty()) extras[name] = extra
        }
    }

    /** 结束计时，返回总毫秒数。 */
    fun finish(): Long {
        if (t0 == 0L) return -1L
        totalMs = (System.nanoTime() - t0) / 1_000_000
        return totalMs
    }

    /**
     * 渲染成瀑布图（等宽，便于在 `app.log` 里一眼看出哪段最长）。
     *
     * ```text
     * boot.timeline  total=46720ms
     *   app             0ms  ▏
     *   runtime       966ms  ██
     *   preflight    1021ms  ██
     *   prootSpawn   1088ms  ██
     *   token       44180ms  ███████████████████████████████████████
     *   health      46718ms  █████████████████████████████████████████
     * ```
     */
    fun dump(): String {
        if (order.isEmpty()) return "boot.timeline  (无打点)"
        val total = if (totalMs >= 0) totalMs else (System.nanoTime() - t0) / 1_000_000
        val sb = StringBuilder()
        sb.append("boot.timeline  total=").append(total).append("ms")
        // 最长的一段取整到 40 格，短的按比例，至少 1 格，方便看出量级差异
        val maxBar = 40
        val longest = order.maxOf { marks[it] ?: 0L }.coerceAtLeast(1L)
        var prev = 0L
        for (name in order) {
            val at = marks[name] ?: 0L
            val delta = at - prev
            val cells = ((delta * maxBar) / longest).toInt().coerceIn(0, maxBar)
            sb.append('\n')
                .append("  ")
                .append(name.padEnd(14))
                .append(at.toString().padStart(7))
                .append("ms  Δ")
                .append(delta.toString().padStart(6))
                .append("ms  ")
                .append("█".repeat(cells.ifAtLeastOne(delta)))
            extras[name]?.takeIf { it.isNotEmpty() }?.let { e ->
                sb.append("  ").append(e.entries.joinToString(" ") { "${it.key}=${it.value}" })
            }
            prev = at
        }
        return sb.toString()
    }

    private fun Int.ifAtLeastOne(delta: Long): Int = if (delta > 0) coerceAtLeast(1) else 0

    /** 已打点的名称 → 毫秒（只读快照，给 `stateJson` / 单测用）。 */
    fun snapshot(): Map<String, Long> = LinkedHashMap(marks).let { m ->
        val ordered = LinkedHashMap<String, Long>()
        for (k in order) marks[k]?.let { ordered[k] = it }
        for ((k, v) in m) if (!ordered.containsKey(k)) ordered[k] = v
        ordered
    }
}
