package com.dsh.android.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * B 阶段启动分段 wrapper 的宿主侧装配。
 *
 * 只测「可决定的纯逻辑」：NODE_OPTIONS 合并（必须保住 manifest 里的
 * `--dns-result-order=ipv4first`）、三层参数（--require / --import / --cpu-prof）
 * 的幂等、三个 guest 脚本与时间戳落盘、cpuprof 目录。
 * guest 脚本行为由真机 boot-timing*.log 验证，不在单测里假装。
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

    private fun options(homeGuest: String = "/data/data/com.dsh.android/files/home/.dsh"): String? =
        BootTimingPreload.nodeOptions(
            template, BootTimingPreload.GUEST_PATH, BootTimingPreload.GUEST_ESM_PATH, homeGuest,
        )

    @Test
    fun mergesExistingNodeOptions() {
        val v = options()
        assertTrue(v != null)
        val s = v!!
        assertTrue(s.startsWith("--dns-result-order=ipv4first"))
        assertTrue(s.contains("--require " + BootTimingPreload.GUEST_PATH))
        assertTrue(s.contains("--import file://" + BootTimingPreload.GUEST_ESM_PATH))
        assertTrue(s.contains("--cpu-prof-dir=/data/data/com.dsh.android/files/home/.dsh/" +
            BootTimingPreload.HOST_PROFILE_DIR))
        assertTrue(s.contains("--cpu-prof-interval=1000"))
    }

    @Test
    fun nodeOptionsIsIdempotent() {
        val once = options()!!
        val twice = BootTimingPreload.nodeOptions(
            listOf("NODE_OPTIONS=" + once),
            BootTimingPreload.GUEST_PATH,
            BootTimingPreload.GUEST_ESM_PATH,
            "/data/data/com.dsh.android/files/home/.dsh",
        )!!
        assertEquals(once, twice)
        assertEquals(1, twice.split("--require ").size - 1)
        assertEquals(1, twice.split("--import ").size - 1)
        assertEquals(1, twice.split("--cpu-prof ").size - 1)
    }

    @Test
    fun addsRequireWhenTemplateHasNoOptions() {
        val v = BootTimingPreload.nodeOptions(listOf("HOME=/root"), "/tmp/x.cjs", "/tmp/x.mjs", "")
        assertTrue(v != null)
        assertTrue(v!!.startsWith("--require /tmp/x.cjs"))
        assertTrue(v.contains("--import file:///tmp/x.mjs"))
        assertTrue(!v.contains("--cpu-prof"))
    }

    @Test
    fun writesThreeScriptsStampAndProfileDir() {
        val rootfs = tmp.newFolder("rootfs")
        val home = tmp.newFolder("home")
        val pair = BootTimingPreload.guestEnv(rootfs, home, template)
        assertTrue(pair != null)
        assertEquals("NODE_OPTIONS", pair!!.first)
        assertTrue(pair.second.contains(BootTimingPreload.GUEST_ESM_PATH))

        val cjs = File(rootfs, BootTimingPreload.GUEST_PATH.trimStart('/'))
        val esm = File(rootfs, BootTimingPreload.GUEST_ESM_PATH.trimStart('/'))
        val hooks = File(rootfs, BootTimingPreload.GUEST_HOOKS_PATH.trimStart('/'))
        assertTrue(cjs.isFile)
        assertTrue(esm.isFile)
        assertTrue(hooks.isFile)
        assertTrue(cjs.readText().contains("boot-timing"))
        assertTrue(esm.readText().contains("module"))
        assertTrue(hooks.readText().contains("resolve"))

        assertTrue(File(home, BootTimingPreload.HOST_STAMP).isFile)
        assertTrue(File(home, BootTimingPreload.HOST_PROFILE_DIR).isDirectory)
    }

    @Test
    fun rewriteIsStable() {
        val rootfs = tmp.newFolder("rootfs2")
        val home = tmp.newFolder("home2")
        BootTimingPreload.guestEnv(rootfs, home, template, profile = "web", now = 1_700_000_000_000L)
        val esm = File(rootfs, BootTimingPreload.GUEST_ESM_PATH.trimStart('/'))
        val first = esm.readText()
        BootTimingPreload.guestEnv(rootfs, home, template, profile = "web", now = 1_700_000_000_001L)
        assertEquals(first, esm.readText())
        assertTrue(File(home, BootTimingPreload.HOST_STAMP).readText().contains("1700000000001"))
    }
}