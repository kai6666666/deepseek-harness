package com.dsh.android.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * `RuntimeDelta.partFile` 的路径解析：manifest 里的 `asset` 带 `runtime/` 前缀，
 * 而增量下载落盘用的是 chunks 清单的键（不带前缀）。两个都要能命中 ——
 * 否则增量下好的分片永远被忽略，解包期退到 APK 旧分片并 sha256 失败（2026-11-28 真机）。
 */
class RuntimeDeltaPartFileTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private val ver = "r1-arm64-v8a-dsh0.2.2-node24.22.1-ubuntu24.04.5-deadbeef"
    private val name = "rootfs-part3-arm64-v8a.tar.xz"

    @Test
    fun findsBareNameWrittenByDelta() {
        val dir = File(tmp.root, "runtime/parts/$ver").apply { mkdirs() }
        File(dir, name).writeBytes(ByteArray(8) { 1 })
        val got = RuntimeDelta.partFile(tmp.root, ver, "runtime/$name")
        assertEquals(File(dir, name), got)
    }

    @Test
    fun findsPrefixedPathToo() {
        val dir = File(tmp.root, "runtime/parts/$ver/runtime").apply { mkdirs() }
        File(dir, name).writeBytes(ByteArray(4))
        val got = RuntimeDelta.partFile(tmp.root, ver, "runtime/$name")
        assertEquals(File(dir, name), got)
    }

    @Test
    fun missingVersionReturnsNull() {
        assertNull(RuntimeDelta.partFile(tmp.root, "", "runtime/$name"))
        assertNull(RuntimeDelta.partFile(tmp.root, ver, "runtime/$name"))
    }

    @Test
    fun emptyFileIsNotUsable() {
        val dir = File(tmp.root, "runtime/parts/$ver").apply { mkdirs() }
        File(dir, name).writeBytes(ByteArray(0))
        assertNull(RuntimeDelta.partFile(tmp.root, ver, "runtime/$name"))
    }
}
