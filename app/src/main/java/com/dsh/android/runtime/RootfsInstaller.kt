package com.dsh.android.runtime

import android.content.Context
import android.util.Log
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.tukaani.xz.XZInputStream
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest

/**
 * rootfs 安装器：assets 的 runtime/rootfs-arm64-v8a.tar.xz -> filesDir/runtime/rootfs，
 * 并把 manifest 落到 filesDir/runtime/manifest.json。
 *
 * 三条硬约定：
 *  1. 原子替换：先解到 rootfs.staging-<version>-<pid>，校验通过再 rename。
 *     解到一半失败时旧 rootfs 仍然可用，这是「首启变砖」与「重试一次」的区别。
 *  2. 先落 cache 再校验 sha256：assets 不能随机读，边拷边算；哈希不符直接删，
 *     绝不把半个 rootfs 交给 ProotHost。
 *  3. canonical 前缀校验：tar 里的 ../ 与绝对路径都不能逃出 staging。
 *
 * 不用 tar 命令：Android 没有，rootfs 里也还没有。
 */
class RootfsInstaller(private val context: Context) {

    data class Progress(val phase: String, val done: Long, val total: Long, val note: String = "")

    private val runtimeDir: File get() = File(context.filesDir, "runtime")
    private val rootfs: File get() = File(runtimeDir, "rootfs")
    private val stamp: File get() = File(runtimeDir, ".rootfs.stamp")
    private val manifestFile: File get() = File(runtimeDir, "manifest.json")

    fun isInstalled(manifest: RuntimeManifest): Boolean = runCatching {
        stamp.isFile && stamp.readText().trim() == manifest.runtimeVersion &&
            RuntimeFiles.missingCriticalFiles(rootfs).isEmpty()
    }.getOrDefault(false)

    /** Invalidate only the runtime marker. User data lives outside runtime/rootfs. */
    fun invalidate(): Boolean = synchronized(INSTALL_LOCK) {
        val present = java.nio.file.Files.exists(stamp.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS)
        if (present && !stamp.delete()) throw IOException("rootfs stamp removal failed")
        Log.i(TAG, "rootfs invalidated; hadStamp=$present")
        present
    }

    /**
     * 幂等安装。onProgress 在调用线程执行（本函数是阻塞 IO，调用方自己放到 IO 线程）。
     *
     * @throws IOException 空间不足、资产缺失、sha256 不符、解包失败
     */
    fun ensure(manifest: RuntimeManifest, onProgress: (Progress) -> Unit = {}): File =
        synchronized(INSTALL_LOCK) { ensureLocked(manifest, onProgress) }

    /** 已持有 INSTALL_LOCK 的安装实现；禁止外部直接调用。 */
    private fun ensureLocked(manifest: RuntimeManifest, onProgress: (Progress) -> Unit): File {
        if (isInstalled(manifest)) {
            onProgress(Progress("ready", 1, 1, manifest.runtimeVersion))
            return rootfs
        }

        runtimeDir.mkdirs()
        // P3：每次安装前清扫上次中断留下的 staging/old（真机曾累积 797 MB）。
        runCatching { RuntimeFiles.sweepStale(runtimeDir) }
            .onSuccess { if (it.isNotEmpty()) Log.i(TAG, "清扫中断残留：" + it.joinToString()) }
            .onFailure { Log.w(TAG, "清扫残留失败：" + it.message) }
        val free = context.filesDir.usableSpace
        if (RuntimeFiles.insufficientSpace(free)) {
            throw IOException(
                "存储空间不足：需要约 " + (RuntimeFiles.ASSUME_UNPACKED_BYTES / 1024 / 1024) +
                    " MB，剩余 " + (free / 1024 / 1024) + " MB"
            )
        }

        val xz = File(context.cacheDir, "rootfs-" + manifest.runtimeVersion + ".tar.xz")
        val tCopy = System.currentTimeMillis()
        copyAsset(manifest.rootfsAsset, xz, manifest.rootfsBytes, onProgress)
        Log.i(TAG, "stage copy: " + xz.length() + " bytes in " + (System.currentTimeMillis() - tCopy) + " ms")

        val tSha = System.currentTimeMillis()
        val got = sha256(xz)
        Log.i(TAG, "stage sha256: " + (System.currentTimeMillis() - tSha) + " ms")
        if (!got.equals(manifest.rootfsSha256, ignoreCase = true)) {
            xz.delete()
            throw IOException("rootfs 校验失败：sha256=" + got + "，manifest=" + manifest.rootfsSha256)
        }

        val staging = File(
            runtimeDir,
            "rootfs.staging-" + manifest.runtimeVersion + "-" + android.os.Process.myPid() +
                "-" + System.nanoTime()
        )
        RuntimeFiles.deleteTree(staging)
        if (!staging.mkdirs()) throw IOException("无法创建 staging：" + staging.absolutePath)

        try {
            val tExtract = System.currentTimeMillis()
            extractXz(xz, staging, onProgress)
            Log.i(TAG, "stage extract: " + (System.currentTimeMillis() - tExtract) + " ms")
            val missing = RuntimeFiles.missingCriticalFiles(staging)
            if (missing.isNotEmpty()) throw IOException("rootfs critical files missing: ${missing.joinToString()}")
            swapIn(staging)
        } catch (t: Throwable) {
            RuntimeFiles.deleteTree(staging)
            throw if (t is IOException) t else IOException("解包失败：" + t.message, t)
        } finally {
            xz.delete()
        }

        copyAsset("runtime/manifest.json", manifestFile, -1, onProgress)
        stamp.writeText(manifest.runtimeVersion)
        onProgress(Progress("done", 1, 1, manifest.runtimeVersion))
        Log.i(TAG, "rootfs 就绪：" + rootfs.absolutePath + "（" + manifest.runtimeVersion + "）")
        return rootfs
    }

    /** Rename transaction; tree cleanup treats symlinks as leaf entries. */
    private fun swapIn(staging: File) {
        val old = RuntimeFiles.swapRootfs(rootfs, staging)
        stamp.delete()
        if (old != null) runCatching { RuntimeFiles.deleteTree(old) }
            .onFailure { Log.w(TAG, "Old rootfs retained: ${old.absolutePath}: ${it.message}") }
    }

    private fun copyAsset(
        assetName: String,
        dest: File,
        expectedBytes: Long,
        onProgress: (Progress) -> Unit,
    ) {
        dest.parentFile?.mkdirs()
        dest.delete()
        var done = 0L
        context.assets.open(assetName).use { input ->
            FileOutputStream(dest).use { out ->
                val buf = ByteArray(1 shl 20)
                while (true) {
                    val n = input.read(buf)
                    if (n <= 0) break
                    out.write(buf, 0, n)
                    done += n
                    onProgress(Progress("copy", done, expectedBytes.coerceAtLeast(1), assetName))
                }
            }
        }
        if (expectedBytes > 0 && dest.length() != expectedBytes) {
            val actual = dest.length()
            dest.delete()
            throw IOException("资产长度不符：" + actual + " != " + expectedBytes + "（" + assetName + "）")
        }
    }

    /**
     * 统计「从 .xz 文件里读掉了多少字节」。
     *
     * 为什么需要它：解包阶段（xz → tar）**没有天然的总量**（tar 条目数未知、
     * 解压后大小未知），原来只能报 `total = -1`，UI 就只能显示一个转圈。
     * 而 `.xz` 文件本身的长度是已知的，压缩流读到哪里是线性推进的 ——
     * 用它做分母，就能给出**真实**的百分比（真机实测 1.3 GB rootfs 读数线性）。
     */
    private class CountingInput(input: java.io.InputStream) : java.io.FilterInputStream(input) {
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

    private fun extractXz(xz: File, dest: File, onProgress: (Progress) -> Unit) {
        var done = 0L
        val counted = CountingInput(BufferedInputStream(FileInputStream(xz), 1 shl 20))
        val xzTotal = xz.length().coerceAtLeast(1)
        XZInputStream(counted).use { xzIn ->
            TarArchiveInputStream(xzIn).use { tar ->
                while (true) {
                    @Suppress("DEPRECATION")
                    val entry: TarArchiveEntry = tar.nextEntry ?: break
                    // 雷电/MuMu 这类模拟器会拦截文件名恰好是 su 的创建（ENOENT），
                    // 与路径、权限、tar 类型都无关（同目录其它 14 个 pam 文件都能写）。
                    // rootfs 里的 su 我们用不到（Android root 通道走宿主 su），
                    // 跳过并记录，避免整个安装失败。
                    if (!entry.isDirectory && entry.name.substringAfterLast('/') == "su") {
                        Log.w(TAG, "跳过 su（模拟器安全策略禁止创建该文件名）：" + entry.name)
                        continue
                    }
                    val target = safeTarget(dest, entry.name)
                    if (entry.name.contains("pam.d")) {
                        Log.i(TAG, "entry " + entry.name + " dir=" + entry.isDirectory +
                            " sym=" + entry.isSymbolicLink + " link=" + entry.isLink)
                    }
                    when {
                        entry.isDirectory -> {
                            target.mkdirs()
                            applyMode(target, entry.mode, true)
                        }
                        entry.isSymbolicLink -> {
                            target.parentFile?.mkdirs()
                            target.delete()
                            java.nio.file.Files.createSymbolicLink(
                                target.toPath(),
                                java.nio.file.Paths.get(entry.linkName),
                            )
                        }
                        entry.isLink -> {
                            target.parentFile?.mkdirs()
                            target.delete()
                            val source = safeTarget(dest, entry.linkName)
                            val linked = runCatching {
                                java.nio.file.Files.createLink(target.toPath(), source.toPath())
                            }.isSuccess
                            if (!linked && source.isFile) {
                                source.copyTo(target, overwrite = true)
                            }
                        }
                        else -> {
                            val parent = target.parentFile
                            if (parent != null && !parent.isDirectory) {
                                val ok = parent.mkdirs() || parent.isDirectory
                                if (!ok) {
                                    // 目录项缺失或被同名文件占位时，NIO 会给出具体的失败原因；
                                    // 直接 open 只会得到一句 ENOENT，查不出来是哪个祖先坏了。
                                    Log.e(
                                        TAG,
                                        "目录创建失败 parent=" + parent +
                                            " exists=" + parent.exists() +
                                            " isDir=" + parent.isDirectory +
                                            " canon=" + parent.canonicalPath +
                                            " entry=" + entry.name,
                                    )
                                    java.nio.file.Files.createDirectories(parent.toPath())
                                }
                            }
                            try {
                                FileOutputStream(target).use { out ->
                                    val buf = ByteArray(1 shl 20)
                                    while (true) {
                                        val n = tar.read(buf)
                                        if (n <= 0) break
                                        out.write(buf, 0, n)
                                        done += n
                                    }
                                }
                            } catch (e: java.io.FileNotFoundException) {
                                Log.e(
                                    TAG,
                                    "open 失败 target=" + target +
                                        " parent=" + parent +
                                        " exists=" + (parent?.exists()) +
                                        " isDir=" + (parent?.isDirectory) +
                                        " canon=" + target.canonicalPath +
                                        " parentCanon=" + parent?.canonicalPath,
                                    e,
                                )
                                throw e
                            }
                            applyMode(target, entry.mode, false)
                        }
                    }
                    runCatching { target.setLastModified(entry.modTime.time) }
                    // 分母用 .xz 已读字节（真实、线性），不再给 -1
                    onProgress(Progress("extract", counted.count, xzTotal, entry.name.takeLast(48)))
                }
            }
        }
    }

    private fun safeTarget(root: File, name: String): File {
        // 归档条目以 "./" 开头。Android 的 File/mkdirs 对 "./" 段的行为在真机上
        // 出过 ENOENT（LDPlayer x86_64：同目录前 14 个文件都写成功，第 15 个
        // su 却打不开），统一去掉前缀后路径只含正常段。
        var cleaned = name.trimStart('/')
        while (cleaned.startsWith("./")) cleaned = cleaned.substring(2)
        val f = File(root, cleaned)
        val rootPath = root.canonicalPath + File.separator
        if (!f.canonicalPath.startsWith(rootPath) && f.canonicalPath != root.canonicalPath) {
            throw IOException("归档路径逃逸：" + name)
        }
        return f
    }

    private fun applyMode(file: File, mode: Int, directory: Boolean) {
        val ownerExec = (mode and 0b001_000_000) != 0
        runCatching {
            if (directory) file.setExecutable(true, false) else file.setExecutable(ownerExec, false)
            file.setReadable(true, false)
            if ((mode and 0b000_010_000) != 0) file.setWritable(true, false)
        }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buf = ByteArray(1 shl 20)
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                digest.update(buf, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    /** 从 assets 读 manifest（安装器自己用；装完 ProotHost 读 files 里的副本）。 */
    fun readManifestFromAssets(): RuntimeManifest =
        context.assets.open("runtime/manifest.json").use { input ->
            RuntimeManifest.parse(input.bufferedReader().readText())
        }

    private companion object {
        /** 进程内安装单飞：探针 Activity 重建与引擎启动可能同时调 ensure。 */
        val INSTALL_LOCK = Any()

        const val TAG = "RootfsInstaller"

        /** 解包后预算见 [RuntimeFiles.ASSUME_UNPACKED_BYTES]（单一真相源）。 */
    }
}
