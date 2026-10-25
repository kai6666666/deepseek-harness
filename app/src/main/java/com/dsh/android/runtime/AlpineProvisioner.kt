package com.dsh.android.runtime

import android.content.Context
import android.os.StatFs
import android.util.Log
import java.io.File
import java.io.FilterInputStream
import java.io.InputStream
import java.security.DigestInputStream
import java.security.MessageDigest

/**
 * 首启供给：把 APK 里那份 Alpine rootfs 解到 `filesDir/runtime/alpine`。
 *
 * 三条硬规矩（不遵守就会在真机上以奇怪的方式失败）：
 *  1. **落地目录必须是 filesDir**。`/storage/emulated/0` 是 FUSE，没有 exec 位，
 *     解出来的 `/usr/bin/node` 会 `Permission denied`（不是 SELinux，是挂载选项）。
 *  2. **解包前查空间**（G-05）。165 MB 解包 + 55 MB 压缩包同时在盘上，
 *     空间不足时解到一半失败，留下半个 rootfs 比"没解"更难查。
 *  3. **摘要不符就整体放弃**，绝不留半成品（用 `alpine.tmp` → 成功后 rename）。
 */
class AlpineProvisioner(
    private val context: Context,
    private val home: File = File(context.filesDir, "runtime"),
) {

    private val tag = "DSH/Alpine"

    fun rootfsDir(): File = File(home, RuntimeBackend.ALPINE.dirName)
    private fun stampFile(): File = File(rootfsDir(), READY_STAMP)
    private fun stagingDir(): File = File(home, "alpine.tmp")

    /** 只读探测，给日志/诊断包用。 */
    data class Status(val provisioned: Boolean, val detail: String, val sha256: String = "")

    fun status(): Status {
        val manifest = RootfsManifest.load(context)
            ?: return Status(false, "assets/${RuntimeAssets.MANIFEST} 不存在（先跑 tools/fetch-rootfs-into-assets.sh）")
        val node = File(rootfsDir(), "usr/bin/node")
        if (!node.isFile) return Status(false, "rootfs 未解包：${rootfsDir().absolutePath}")
        val stamp = stampFile()
        if (!stamp.isFile) return Status(false, "缺 .ready 标记（上次解包未完成）", manifest.sha256)
        val got = runCatching { stamp.readText().trim() }.getOrDefault("")
        if (got != manifest.sha256) {
            return Status(false, "版本不一致：.ready=${got.take(12)}… manifest=${manifest.sha256.take(12)}…", manifest.sha256)
        }
        if (!node.canExecute()) {
            return Status(false, "usr/bin/node 没有执行位（解包权限丢失）", manifest.sha256)
        }
        return Status(true, "就绪（node ${manifest.nodejs}，alpine ${manifest.alpine}）", manifest.sha256)
    }

    /**
     * 幂等：已就绪直接返回；否则解包。
     *
     * @param onProgress (百分比 0..100, 说明)。**在调用线程回调**，UI 用时自己切主线程。
     */
    fun provision(onProgress: (Int, String) -> Unit = { _, _ -> }): Result<File> {
        val manifest = RootfsManifest.load(context)
            ?: return Result.failure(IllegalStateException("assets/${RuntimeAssets.MANIFEST} 不存在"))
        if (manifest.nodeMajor != RuntimeAssets.EXPECT_NODE_MAJOR) {
            return Result.failure(
                IllegalStateException("rootfs 里 node 是 ${manifest.nodejs}，期望 ${RuntimeAssets.EXPECT_NODE_MAJOR}.x——换 assets 或改期望值"),
            )
        }
        if (manifest.bytes < MIN_TAR_BYTES) {
            return Result.failure(IllegalStateException("manifest.bytes=${manifest.bytes} 太小，包不完整"))
        }

        val before = status()
        if (before.provisioned) {
            Log.i(tag, "已就绪，跳过解包：${before.detail}")
            onProgress(100, before.detail)
            return Result.success(rootfsDir())
        }

        // ── G-05：空间预检 ────────────────────────────────────────────────
        val need = manifest.bytes * RuntimeAssets.FREE_SPACE_FACTOR
        val free = runCatching { StatFs(context.filesDir.absolutePath).availableBytes }.getOrDefault(-1L)
        if (free in 0 until need) {
            return Result.failure(
                IllegalStateException(
                    "空间不足：需要 ${need / 1048576} MB，可用 ${free / 1048576} MB（解包约 165 MB + 压缩包 ${manifest.bytes / 1048576} MB）",
                ),
            )
        }
        Log.i(tag, "开始解包：tar=${manifest.bytes / 1048576} MB free=${free / 1048576} MB")

        home.mkdirs()
        val staging = stagingDir()
        if (staging.exists()) staging.deleteRecursively()
        if (!staging.mkdirs()) return Result.failure(IllegalStateException("建不了 ${staging.absolutePath}"))

        val md = MessageDigest.getInstance("SHA-256")
        var entries = 0
        try {
            context.assets.open(manifest.assetsPath).use { raw ->
                val counting = CountingInputStream(DigestInputStream(raw, md))
                onProgress(1, "解包中…")
                var seen = 0
                entries = TarGzExtractor { name ->
                    // 每 500 个条目报一次。用局部计数：entries 此时还没被赋值（恒为 0）
                    seen++
                    if (seen % 500 == 0) {
                        val p = if (manifest.bytes > 0) (counting.count * 90 / manifest.bytes).toInt() else 0
                        onProgress(p.coerceIn(1, 95), name.takeLast(48))
                    }
                }.extract(counting, staging)

                val gotCount = counting.count
                val gotSha = md.digest().joinToString("") { "%02x".format(it) }
                if (gotCount != manifest.bytes) {
                    throw IllegalStateException("解出的字节数 $gotCount ≠ manifest ${manifest.bytes}（包被截断？）")
                }
                if (!gotSha.equals(manifest.sha256, ignoreCase = true)) {
                    throw IllegalStateException("sha256 不符：$gotSha ≠ ${manifest.sha256}")
                }
            }

            val node = File(staging, "usr/bin/node")
            if (!node.isFile) throw IllegalStateException("解包后没有 usr/bin/node")
            if (!node.canExecute()) {
                // 权限位没留住：补一次 0755，再验
                runCatching { android.system.Os.chmod(node.absolutePath, 0b111_101_101) }
                if (!node.canExecute()) throw IllegalStateException("usr/bin/node 无法置为可执行")
            }

            // 原子替换 + 保留一版回滚点（G-07）：
            //   alpine → alpine.prev（上一版，保留）    alpine.prev → alpine.bad（更老的，本轮删）
            //   这样「新版起不来」时还有 rollback() 可退，而不是只能重下 55 MB。
            val finalDir = rootfsDir()
            val prev = File(home, "alpine.prev")
            val bad = File(home, "alpine.bad")
            if (bad.exists()) bad.deleteRecursively()
            if (prev.exists() && !prev.renameTo(bad)) prev.deleteRecursively()
            if (finalDir.exists() && !finalDir.renameTo(prev)) {
                finalDir.deleteRecursively()
            }
            if (!staging.renameTo(finalDir)) throw IllegalStateException("rename 到 ${finalDir.absolutePath} 失败")
            bad.deleteRecursively()
            stampFile().writeText(manifest.sha256)
            onProgress(100, "完成：$entries 个条目，node ${manifest.nodejs}")
            Log.i(tag, "解包完成：entries=$entries node=${manifest.nodejs} sha=${manifest.sha256.take(12)}")
            return Result.success(finalDir)
        } catch (t: Throwable) {
            Log.e(tag, "解包失败，清理 ${staging.absolutePath}", t)
            staging.deleteRecursively()
            return Result.failure(t)
        }
    }

    /**
     * G-07：回滚到上一版 rootfs（`alpine.prev` → `alpine`）。
     *
     * 使用场景：新解包的 rootfs 起不来（node 崩、缺库、架构不符），
     * 手上又没法立刻重下 55 MB —— 直接把上一版换回来。
     * 当前这版不删，改名成 `alpine.bad.<时间戳>` 留证，交给 [prunePrevious] 清。
     */
    fun rollback(): Result<File> = runCatching {
        val finalDir = rootfsDir()
        val prev = File(home, "alpine.prev")
        require(prev.isDirectory) { "没有可回滚的上一版（缺 ${prev.absolutePath}）" }
        val bad = File(home, "alpine.bad.${System.currentTimeMillis()}")
        if (finalDir.exists() && !finalDir.renameTo(bad)) {
            throw IllegalStateException("挪走当前版本失败：${finalDir.absolutePath}")
        }
        if (!prev.renameTo(finalDir)) {
            // 换不回来就把坏的挪回去，别留下一个空目录
            bad.renameTo(finalDir)
            throw IllegalStateException("回滚 rename 失败：${prev.absolutePath}")
        }
        Log.w(tag, "已回滚到上一版 rootfs：${finalDir.absolutePath}（旧版留证 ${bad.name}）")
        finalDir
    }

    /** G-07：回滚点是否在。 */
    fun hasPrevious(): Boolean = File(home, "alpine.prev").isDirectory

    /** 任意目录的字节数（prunePrevious 用；不动 installedBytes 的既有签名）。 */
    private fun dirBytes(dir: File): Long {
        var total = 0L
        dir.walkTopDown().forEach { if (it.isFile) total += it.length() }
        return total
    }

    /**
     * G-05/G-07：清掉回滚点与所有 `alpine.bad*` 留证，腾空间。
     * 返回释放的字节数。`keepPrevious=false` 时连 `alpine.prev` 一起删 ——
     * 之后就**没得回滚**了，只有空间告急才这么干。
     */
    fun prunePrevious(keepPrevious: Boolean = true): Long {
        var freed = 0L
        home.listFiles()?.forEach { f ->
            if (f.name == "alpine.bad" || f.name.startsWith("alpine.bad.")) {
                freed += dirBytes(f)
                f.deleteRecursively()
            }
        }
        if (!keepPrevious) {
            val prev = File(home, "alpine.prev")
            if (prev.exists()) {
                freed += dirBytes(prev)
                prev.deleteRecursively()
            }
        }
        if (freed > 0) Log.i(tag, "prunePrevious: 释放 $freed B（keepPrevious=$keepPrevious）")
        return freed
    }

    /** 统计目录实际占用（诊断用）。 */
    fun installedBytes(): Long {
        var total = 0L
        rootfsDir().walkTopDown().forEach { if (it.isFile) total += it.length() }
        return total
    }

    private class CountingInputStream(inner: InputStream) : FilterInputStream(inner) {
        var count: Long = 0L
            private set

        override fun read(): Int {
            val b = super.read()
            if (b >= 0) count++
            return b
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            val n = super.read(b, off, len)
            if (n > 0) count += n
            return n
        }
    }

    private companion object {
        const val READY_STAMP = ".ready"
        const val MIN_TAR_BYTES = 20L * 1024 * 1024
    }
}