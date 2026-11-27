package com.dsh.android.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A4-#6「增量仍只下变化块」的判定层验证。
 *
 * 真机演练需要一次真实 runtime 更新（跨版本时 `planDelta` 会判成全量，属预期），
 * 所以这里把**块级判定**抽成纯函数 `changedChunkIndexes` 直接测：
 * - 没有同长度基线 → 全量；
 * - 完全一致 → 0 块；
 * - 只改一块 → 只回一块；
 * - 远端比本地长 → 多出来的块也算变化。
 */
class RuntimeDeltaChunkTest {

    private fun hashes(n: Int, seed: String = "h"): List<String> = (0 until n).map { "$seed$it" }

    @Test
    fun noBaseMeansFullDownload() {
        val remote = hashes(5)
        assertEquals(listOf(0, 1, 2, 3, 4), changedChunkIndexes(null, remote))
    }

    @Test
    fun identicalBaseNeedsNothing() {
        val remote = hashes(5)
        assertTrue(changedChunkIndexes(remote, remote).isEmpty())
    }

    @Test
    fun onlyChangedChunkIsFetched() {
        val remote = hashes(5)
        val local = remote.toMutableList().also { it[2] = "changed" }
        assertEquals(listOf(2), changedChunkIndexes(local, remote))
    }

    @Test
    fun shorterLocalCountsTailAsChanged() {
        val remote = hashes(5)
        val local = hashes(3)
        assertEquals(listOf(3, 4), changedChunkIndexes(local, remote))
    }

    @Test
    fun emptyRemoteNeedsNothing() {
        assertTrue(changedChunkIndexes(hashes(3), emptyList()).isEmpty())
    }
}