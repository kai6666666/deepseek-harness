package com.dsh.android.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * overlay 文本的单测。
 *
 * 为什么值得测：这段 YAML 是「App 唯一能决定前端装哪些插件」的地方，写错了只会表现为
 * 「统计 tab 不出现」或「引擎起不来」，两种都很难从日志反推。
 */
class BuiltinOverlaysTest {

    private val yaml = BuiltinOverlays.uiStatsYaml()

    @Test
    fun hasIdAndName() {
        assertTrue(yaml.contains("- id: ui-stats"))
        assertTrue(yaml.contains("name: '${BuiltinOverlays.UI_STATS_PLUGIN}'"))
    }

    @Test
    fun indentationIsTwoSpaces() {
        val nameLine = yaml.lineSequence().first { it.contains("name:") }
        assertEquals("  name: '", nameLine.take(9))
    }

    @Test
    fun everyNonCommentLineIsIndentedOrListStart() {
        yaml.lineSequence()
            .filter { it.isNotBlank() && !it.trimStart().startsWith("#") }
            .forEach { line ->
                assertTrue("unexpected line: [$line]", line.startsWith("- ") || line.startsWith("  "))
            }
    }

    @Test
    fun noTabs() {
        assertFalse(yaml.contains("\t"))
    }
}
