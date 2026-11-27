package com.dsh.android.log

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `BootTimeline` 的纯格式化/状态逻辑（不碰 Android API）。
 *
 * 对应 A+B 计划里 B6-#3（`unpacked` 标记）与 dump 的可读性：
 * - `mark(name, extra)` 的 extra 必须原样出现在 dump 里；
 * - 同一名字只记第一次（幂等），extra 也只在第一次生效；
 * - `start()` **不能**覆盖 `markProcessStart()` 设好的 t0（否则 `app` 点会算出负数）。
 */
class BootTimelineTest {

    @Test
    fun extraShowsUpInDump() {
        BootTimeline.markProcessStart()
        BootTimeline.start()
        BootTimeline.mark("runtime", mapOf("unpacked" to "false"))
        BootTimeline.mark("health")
        val dump = BootTimeline.dump()
        assertTrue("dump 必须带 unpacked=false：\n$dump", dump.contains("unpacked=false"))
        assertTrue(dump.contains("runtime"))
        assertTrue(dump.contains("health"))
    }

    @Test
    fun markIsIdempotentAndKeepsFirstExtra() {
        BootTimeline.start()
        BootTimeline.mark("runtime", mapOf("unpacked" to "true"))
        BootTimeline.mark("runtime", mapOf("unpacked" to "false"))
        val dump = BootTimeline.dump()
        assertTrue(dump.contains("unpacked=true"))
        assertEquals(1, Regex("unpacked=").findAll(dump).count())
    }

    @Test
    fun startDoesNotResetProcessAnchor() {
        BootTimeline.markProcessStart()
        Thread.sleep(2)
        BootTimeline.start()
        BootTimeline.mark("app")
        val snapshot = BootTimeline.snapshot()
        val app = snapshot["app"]
        assertTrue("app 点必须 >= 0（t0 被 start 保留），实际=$app", app != null && app >= 0)
    }

    @Test
    fun appMarkSurvivesStart() {
        BootTimeline.markProcessStart()
        BootTimeline.mark("app")
        BootTimeline.start()          // EngineManager 在 startProot 里调这个
        BootTimeline.mark("runtime", mapOf("unpacked" to "false"))
        val dump = BootTimeline.dump()
        assertTrue("app 点必须在 start() 之后仍存在：\n" + dump, dump.contains("app"))
        assertTrue(dump.indexOf("app") < dump.indexOf("runtime"))
    }
    @Test
    fun dumpWithoutMarksIsStable() {
        BootTimeline.start()
        assertTrue(BootTimeline.dump().contains("boot.timeline"))
    }
}