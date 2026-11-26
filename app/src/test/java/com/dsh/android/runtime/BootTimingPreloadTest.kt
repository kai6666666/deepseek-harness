package com.dsh.android.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * B 阶段第 1 层：guest 侧时间戳 wrapper 的宿主侧装配。
 *
 * 只测「可决定的纯逻辑」：NODE_OPTIONS 合并（必须保住 manifest 里的
 * `--dns-result-order=ipv4first`）、幂等、脚本与时间戳落盘。
 * guest 脚本本身的行为由真机 boot-timing.log 验证，不在单测里假装。
 */
class BootTimingPreloadTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private val template = listOf(
        "{NATIVE_LIB_DIR}/libproot.so",
        "--kill-on-exit", "--rootfs={ROOTFS}",
        "/usr/bin/env", "-i", "HOME=/root", "NODE_OPTIONS=--dns-result-order=ipv4first",
        "{GUEST_ENV}", "/bin/sh", "-c",
        "exec /usr/local/bin/dsh web {PATCHES}",
    )

    @Test
    fun mergesExistingNodeOptions() {
        val v = BootTimingPreload.nodeOptions(template, BootTimingPreload.GUEST_PATH)
        assertTrue(v != null)
        assertTrue(v!!.startsWith("--dns-result-order=ipv4first"))
        assertTrue(v.contains("--require " + BootTimingPreload.GUEST_PATH))
    }

    @Test
    fun nodeOptionsIsIdempotent() {
        val once = BootTimingPreload.nodeOptions(template, BootTimingPreload.GUEST_PATH)!!
        val twice = BootTimingPreload.nodeOptions(listOf("NODE_OPTIONS=" + once), BootTimingPreload.GUEST_PATH)!!
        assertEquals(once, twice)
        assertEquals(1, twice.split("--require ").size - 1)
    }

    @Test
    fun addsRequireWhenTemplateHasNoOptions() {
        val v = BootTimingPreload.nodeOptions(listOf("HOME=/root", "/usr/bin/env"), "/tmp/x.cjs")
        assertEquals("--require /tmp/x.cjs", v)
    }

    @Test
    fun writesScriptAndHostStamp() {
        val rootfs = tmp.newFolder("rootfs")
        val home = tmp.newFolder("home")
        val pair = BootTimingPreload.guestEnv(rootfs, home, template)
        assertTrue(pair != null)
        assertEquals("NODE_OPTIONS", pair!!.first)
        assertTrue(pair.second.contains(BootTimingPreload.GUEST_PATH))

        val script = File(rootfs, BootTimingPreload.GUEST_PATH.trimStart('/'))
        assertTrue(script.isFile)
        assertTrue(script.readText().contains("boot-timing"))
        assertTrue(script.readText().contains("process.hrtime.bigint"))

        val stamp = File(home, BootTimingPreload.HOST_STAMP)
        assertTrue(stamp.isFile)
        assertTrue(stamp.readText().contains("hostEpoch"))
    }

    @Test
    fun rewriteIsStable() {
        val rootfs = tmp.newFolder("rootfs2")
        val home = tmp.newFolder("home2")
        BootTimingPreload.guestEnv(rootfs, home, template, profile = "web", now = 1_700_000_000_000L)
        val script = File(rootfs, BootTimingPreload.GUEST_PATH.trimStart('/'))
        val first = script.readText()
        BootTimingPreload.guestEnv(rootfs, home, template, profile = "web", now = 1_700_000_000_001L)
        assertEquals(first, script.readText())
        assertTrue(File(home, BootTimingPreload.HOST_STAMP).readText().contains("1700000000001"))
    }
}
