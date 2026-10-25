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

    fun rootfsDir(): File =
        RuntimePaths.assertExecutableRoot(File(home, RuntimeBackend.ALPINE.dirName), context.filesDir)
    private fun stampFile(): File = File(rootfsDir(), READY_STAMP)
    private fun stagingDir(): File = File(home, "alpine.tmp")

    /** 只读探测，给日志/诊断包用。 */
    data class Status(
        val provisioned: Boolean,
        val detail: String,
        val sha256: String = "",
        /** G-05：上次解包的实测占用（0 = 没记过） */
        val measuredBytes: Long = 0L,
    )

    fun status(): Status {
        val manifest = RootfsManifest.load(context)
            ?: return Status(false, "assets/${RuntimeAssets.MANIFEST} 不存在（先跑 tools/fetch-rootfs-into-assets.sh）")
        val node = File(rootfsDir(), "usr/bin/node")
        if (!node.isFile) return Status(false, "rootfs 未解包：${rootfsDir().absolutePath}")
        val stamp = stampFile()
        if (!stamp.isFile) return Status(false, "缺 .ready 标记（上次解包未完成）", manifest.sha256)
        // .ready 三行：sha256 / 实测字节 / 时间戳（G-05：实测值用来校准下次预检）
        val lines = runCatching { stamp.readLines() }.getOrDefault(emptyList())
        val got = lines.firstOrNull()?.trim().orEmpty()
        val measured = lines.getOrNull(1)?.trim()?.toLongOrNull() ?: 0L
        if (got != manifest.sha256) {
            return Status(false, "版本不一致：.ready=${got.take(12)}… manifest=${manifest.sha256.take(12)}…", manifest.sha256)
        }
        if (!node.canExecute()) {
            return Status(false, "usr/bin/node 没有执行位（解包权限丢失）", manifest.sha256)
        }
        // 老版本只给 node 补过 0755，rootfs 里 `/usr/bin/env` 仍是 0644 →
        // `proot error: execve("/usr/bin/env"): Permission denied`（真机实证）。
        // 把「guest 第一条命令」也纳入就绪判定，命中就让上层重解包，由 fixExecBits 自愈。
        val guestEnv = File(rootfsDir(), "usr/bin/env")
        if (guestEnv.isFile && !guestEnv.canExecute()) {
            return Status(false, "usr/bin/env 没有执行位（老 rootfs 解包 mode 丢失，需重解包）", manifest.sha256)
        }
        return Status(
            true,
            "就绪（node ${manifest.nodejs}，alpine ${manifest.alpine}，占用 ${measured / 1048576} MB）",
            manifest.sha256,
            measured,
        )
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
        // G-05：预检取「压缩包 ×3」与「上次实测占用 ×1.1」的较大值。
        //   纯推测在压缩率变化的版本上会偏小；实测值才是硬数据。
        val measured = lastMeasuredBytes()
        val need = maxOf(
            manifest.bytes * RuntimeAssets.FREE_SPACE_FACTOR,
            (measured * 11L) / 10L,
        )
        Log.i(tag, "空间预检：need=${need / 1048576} MB（包=${manifest.bytes / 1048576} MB，上次实测=${measured / 1048576} MB）")
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
                        // G-05：解包中实测水位。低空间设备不再「解到一半 ENOSPC」，
                        //   而是在还剩 80 MB 时就停下、清 staging、报可读的错。
                        checkWater(counting.count)
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

            // 权限位修复：`TarGzExtractor` 不保证保留 tar 的 mode 位，真机实证
            // `proot error: execve("/usr/bin/env"): Permission denied` ——
            // 只给 `usr/bin/node` 补 0755 不够，rootfs 里其余可执行文件（env/sh/busybox…）
            // 一个都没执行位。这里在 rename 之前统一补一遍。
            fixExecBits(staging)
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
            // G-05：把实测占用一起记下，下次预检直接用真实值
            val used = dirBytes(finalDir)
            stampFile().writeText("${manifest.sha256}\n$used\n${System.currentTimeMillis()}\n")
            Log.i(tag, "实测占用：${used / 1048576} MB（.ready 已记）")
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

    /** G-05：上次解包的实测占用（读 .ready 第二行）；没记过返回 0。 */
    fun lastMeasuredBytes(): Long =
        runCatching { stampFile().readLines().getOrNull(1)?.trim()?.toLongOrNull() ?: 0L }
            .getOrDefault(0L)

    /** G-05：解包中的水位检查——剩余可用低于 SAFETY_MARGIN 就中止。 */
    private fun checkWater(written: Long) {
        val free = runCatching {
            StatFs(context.filesDir.absolutePath).availableBytes
        }.getOrDefault(Long.MAX_VALUE)
        if (free < SAFETY_MARGIN) {
            throw IllegalStateException(
                "解包中空间不足：剩余 ${free / 1048576} MB < ${SAFETY_MARGIN / 1048576} MB" +
                    "（已写入 $written B）——已清理临时目录，可腾出空间后重试",
            )
        }
    }

    /** rootfs 里应该带执行位的目录（相对路径）。 */
    private val EXEC_DIRS = listOf("bin", "sbin", "usr/bin", "usr/sbin", "usr/libexec", "lib", "usr/lib")

    /**
     * 给 rootfs 里所有「应该有执行位」的文件补 0755。
     *
     * 为什么需要：`TarGzExtractor` 不恢复 tar 的 mode 位，解出来的文件一律 0644。
     * proot 起 guest 的第一条命令就是 `/usr/bin/env`，没有执行位就直接：
     *
     *     proot error: execve("/usr/bin/env"): Permission denied
     *
     * （真机 2026-10-25 21:49:26 实证）。只补 `usr/bin/node` 修不好这一条。
     */
    private fun fixExecBits(root: File) {
        var fixed = 0
        EXEC_DIRS.forEach { rel ->
            val d = File(root, rel)
            if (!d.isDirectory) return@forEach
            d.walkTopDown().forEach { f ->
                if (f.isFile && !f.canExecute()) {
                    runCatching { android.system.Os.chmod(f.absolutePath, 0b111_101_101) }
                        .onSuccess { fixed++ }
                }
            }
        }
        if (fixed > 0) Log.i(TAG, "补可执行位：$fixed 个文件（rootfs 解包 mode 丢失）")
    }

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

        /** G-05：解包过程中必须保留的最小可用空间（低于它就中止，别把盘写满）。 */
        const val SAFETY_MARGIN = 80L * 1024 * 1024
        const val MIN_TAR_BYTES = 20L * 1024 * 1024
    }
}