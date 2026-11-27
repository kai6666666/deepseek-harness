package com.dsh.android.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * B 阶段启动分段 wrapper 的宿主侧装配。
 *
 * 两层开关语义：
 * - 第 1 层（`--require` CJS wrapper）**常开**，成本是 token 时一次落盘；
 * - 第 2 层（`--import` ESM 钩子 + `--cpu-prof`）只在 `files/boot-trace.enable` 存在时注入，
 *   真机实测常开会把冷启从 42 s 拉到 71 s（progress §4.20.4）。
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

    private val homeGuest = "/data/data/com.dsh.android/files/home/.dsh"

    private fun options(trace: Boolean, home: String = homeGuest): String? =
        BootTimingPreload.nodeOptions(
            template, BootTimingPreload.GUEST_PATH, BootTimingPreload.GUEST_ESM_PATH, home, trace,
        )

    @Test
    fun traceOffKeepsOnlyLayerOne() {
        val s = options(trace = false)!!
        assertTrue(s.startsWith("--dns-result-order=ipv4first"))
        assertTrue(s.contains("--require " + BootTimingPreload.GUEST_PATH))
        assertFalse(s.contains("--import "))
        assertFalse(s.contains("--cpu-prof"))
    }

    @Test
    fun traceOnAddsEsmAndProfile() {
        val s = options(trace = true)!!
        assertTrue(s.contains("--import file://" + BootTimingPreload.GUEST_ESM_PATH))
        assertTrue(s.contains("--cpu-prof"))
        assertTrue(s.contains("--cpu-prof-dir=$homeGuest/" + BootTimingPreload.HOST_PROFILE_DIR))
        assertTrue(s.contains("--cpu-prof-interval=1000"))
    }

    @Test
    fun nodeOptionsIsIdempotent() {
        val once = options(trace = true)!!
        val twice = BootTimingPreload.nodeOptions(
            listOf("NODE_OPTIONS=" + once),
            BootTimingPreload.GUEST_PATH,
            BootTimingPreload.GUEST_ESM_PATH,
            homeGuest,
            true,
        )!!
        assertEquals(once, twice)
        assertEquals(1, twice.split("--require ").size - 1)
        assertEquals(1, twice.split("--import ").size - 1)
        assertEquals(1, twice.split("--cpu-prof ").size - 1)
    }

    @Test
    fun addsRequireWhenTemplateHasNoOptions() {
        val v = BootTimingPreload.nodeOptions(listOf("HOME=/root"), "/tmp/x.cjs", "/tmp/x.mjs", "", false)
        assertTrue(v != null)
        assertTrue(v!!.startsWith("--require /tmp/x.cjs"))
        assertFalse(v.contains("--import"))
    }

    @Test
    fun traceFlagIsAFileMarker() {
        val files = tmp.newFolder("files")
        assertFalse(BootTimingPreload.traceEnabled(files))
        File(files, BootTimingPreload.TRACE_FLAG).writeText("")
        assertTrue(BootTimingPreload.traceEnabled(files))
    }

    @Test
    fun traceOffWritesOnlyLayerOneScripts() {
        val rootfs = tmp.newFolder("rootfs")
        val home = tmp.newFolder("home")
        val pair = BootTimingPreload.guestEnv(rootfs, home, template, trace = false)
        assertTrue(pair != null)
        assertEquals("NODE_OPTIONS", pair!!.first)
        assertTrue(File(rootfs, BootTimingPreload.GUEST_PATH.trimStart('/')).isFile)
        assertFalse(File(rootfs, BootTimingPreload.GUEST_ESM_PATH.trimStart('/')).exists())
        assertFalse(File(home, BootTimingPreload.HOST_PROFILE_DIR).exists())
        assertTrue(File(home, BootTimingPreload.HOST_STAMP).isFile)
        // V8 编译缓存与 trace 开关无关：默认就建目录（第一次冷启写入，之后读）
        assertTrue(File(home, BootTimingPreload.V8_CACHE_DIR).isDirectory)
    }

    @Test
    fun traceOnWritesThreeScriptsAndProfileDir() {
        val rootfs = tmp.newFolder("rootfs2")
        val home = tmp.newFolder("home2")
        val pair = BootTimingPreload.guestEnv(rootfs, home, template, trace = true)
        assertTrue(pair != null)
        assertTrue(pair!!.second.contains(BootTimingPreload.GUEST_ESM_PATH))
        assertTrue(File(rootfs, BootTimingPreload.GUEST_ESM_PATH.trimStart('/')).isFile)
        assertTrue(File(rootfs, BootTimingPreload.GUEST_HOOKS_PATH.trimStart('/')).isFile)
        assertTrue(File(home, BootTimingPreload.HOST_PROFILE_DIR).isDirectory)
    }

    @Test
    fun compileCacheIsWiredIntoGuestScript() {
        assertTrue(BootTimingPreload.SCRIPT_CJS.contains("enableCompileCache"))
        assertTrue(BootTimingPreload.SCRIPT_CJS.contains(BootTimingPreload.V8_CACHE_DIR))
        assertTrue(BootTimingPreload.V8_CACHE_MAX_BYTES > 0)
    }

    @Test
    fun ensureV8CacheCreatesDirAndReportsSize() {
        val home = tmp.newFolder("home-cache")
        val first = BootTimingPreload.ensureV8Cache(home)
        assertEquals(0L, first)
        val dir = File(home, BootTimingPreload.V8_CACHE_DIR)
        assertTrue(dir.isDirectory)
        File(dir, "a.cache").writeBytes(ByteArray(1024))
        assertEquals(1024L, BootTimingPreload.ensureV8Cache(home))
    }

    @Test
    fun rewriteIsStable() {
        val rootfs = tmp.newFolder("rootfs3")
        val home = tmp.newFolder("home3")
        BootTimingPreload.guestEnv(rootfs, home, template, now = 1_700_000_000_000L, trace = true)
        val esm = File(rootfs, BootTimingPreload.GUEST_ESM_PATH.trimStart('/'))
        val first = esm.readText()
        BootTimingPreload.guestEnv(rootfs, home, template, now = 1_700_000_000_001L, trace = true)
        assertEquals(first, esm.readText())
        assertTrue(File(home, BootTimingPreload.HOST_STAMP).readText().contains("1700000000001"))
    }
}