package com.dsh.android.runtime

import java.io.File
import java.io.IOException
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.attribute.BasicFileAttributes

/** Filesystem-only runtime rules; also exercised on the JVM without an Android device. */
internal object RuntimeFiles {
    val criticalFiles = listOf("usr/bin/node", "opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js")

    fun contains(root: File, file: File): Boolean = runCatching {
        val base = root.canonicalFile.toPath()
        file.canonicalFile.toPath().startsWith(base)
    }.getOrDefault(false)

    /** 解包预算：Ubuntu base + node + pnpm + dsh 约 1.0 GB，留 30% 余量。 */
    const val ASSUME_UNPACKED_BYTES = 3_400L * 1024 * 1024

    /**
     * 空间预检。`free <= 0` 表示系统读不到可用空间（不是「没空间」），放行 ——
     * 把「读不出来」当成「不足」会让一批设备永远装不上。
     */
    fun insufficientSpace(freeBytes: Long, needBytes: Long = ASSUME_UNPACKED_BYTES): Boolean =
        freeBytes in 1 until needBytes

    /** 设备上不可用的解析器：构建机的 systemd-resolved 桩、本机回环。 */
    private val badResolvers = listOf("127.0.0.53", "compute.internal")

    /**
     * guest `/etc/resolv.conf` 是否需要重写成公共 DNS。
     *
     * 判据是「不可用」而不是「空」：镜像曾把构建机的
     * `nameserver 127.0.0.53` + `search *.compute.internal` 打进包，手机上没有那个
     * 解析器，症状是**所有域名都解析失败**（登录、插件市场全 `no-response`）。
     * 用户自己写的公共 DNS 不动。
     */
    fun needsPublicDns(text: String): Boolean {
        if (text.isBlank()) return true
        if (badResolvers.any { it in text }) return true
        // 只认 `nameserver <ip>` 行；注释、`search`、`options` 都不算解析器。
        return text.lineSequence()
            .map { it.trim() }
            .filter { it.startsWith("nameserver") }
            .map { it.removePrefix("nameserver").trim() }
            .none { it.isNotEmpty() && it != "127.0.0.1" }
    }

    const val PUBLIC_DNS = "nameserver 223.5.5.5\nnameserver 119.29.29.29\nnameserver 8.8.8.8\n"

    fun missingCriticalFiles(rootfs: File): List<String> = criticalFiles.filter { name ->
        val f = File(rootfs, name)
        !contains(rootfs, f) || !f.isFile || f.length() == 0L
    }

    /** walkFileTree defaults to NOFOLLOW: a link to user data is deleted as a link. */
    fun deleteTree(root: File) {
        if (!Files.exists(root.toPath(), NOFOLLOW_LINKS)) return
        Files.walkFileTree(root.toPath(), object : SimpleFileVisitor<Path>() {
            // P-7：rootfs 里有 0555 目录（如 /system）。删除其子项需要目录可写，
            // 否则 AccessDeniedException 会让整个清理失败、残留 rootfs.old-*。
            override fun preVisitDirectory(dir: Path, attrs: BasicFileAttributes): FileVisitResult {
                runCatching {
                    val d = dir.toFile()
                    if (!d.canWrite()) d.setWritable(true, true)
                    if (!d.canExecute()) d.setExecutable(true, true)
                }
                return FileVisitResult.CONTINUE
            }
            override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                runCatching { Files.delete(file) }.onFailure {
                    runCatching { file.toFile().setWritable(true, true) }
                    runCatching { Files.delete(file) }
                }
                return FileVisitResult.CONTINUE
            }
            override fun postVisitDirectory(dir: Path, error: IOException?): FileVisitResult {
                // 不抛：能删多少算多少，避免一个只读目录废掉整次清扫
                runCatching { Files.delete(dir) }
                return FileVisitResult.CONTINUE
            }
        })
    }

    /** Same-directory rename transaction. A failed swap keeps/restores the previous tree. */
    fun swapRootfs(rootfs: File, staging: File): File? {
        require(rootfs.parentFile.canonicalFile == staging.parentFile.canonicalFile)
        val old = File(rootfs.parentFile, "rootfs.old-${System.nanoTime()}")
        val hadOld = Files.exists(rootfs.toPath(), NOFOLLOW_LINKS)
        if (hadOld && !rootfs.renameTo(old)) throw IOException("rootfs rename-to-backup failed")
        if (!staging.renameTo(rootfs)) {
            val restored = !hadOld || old.renameTo(rootfs)
            throw IOException("rootfs swap failed; rollback=$restored; backup=${old.absolutePath}")
        }
        return old.takeIf { hadOld }
    }

    /**
     * 删除 bionic 时代遗留（P3 起是**删除**，不再归档）。
     *
     * 精确 allowlist：只动下面这些名字；`home/`（会话与凭据）与 `workspace/` 绝不触碰。
     * 为什么不搬到 `runtime/legacy-bionic`：归档会让每个升级装机永久多背一份几百 MB
     * 的旧运行时，而它从 P1 之后已经没有任何读取方（`proot-libs` 同理）。
     */
    fun purgeLegacy(filesDir: File): List<String> {
        val base = filesDir.canonicalFile
        require(base == filesDir.absoluteFile.canonicalFile)
        val removed = ArrayList<String>()
        for (relative in listOf("engine", "usr", "termux", "proot-libs", "runtime/legacy-bionic")) {
            val source = File(base, relative)
            // 父目录若是符号链接，删除会越出 filesDir。
            if (source.parentFile.canonicalFile != source.parentFile.absoluteFile) continue
            if (!Files.exists(source.toPath(), NOFOLLOW_LINKS)) continue
            deleteTree(source)
            removed += relative
        }
        return removed
    }

    /**
     * 启动清扫：被中断的安装会留下接近满额的 `rootfs.staging-*` 与交换残留
     * `rootfs.old-*`（真机实测曾累积 797 MB）。只扫 runtimeDir 下的一级目录。
     */
    fun sweepStale(runtimeDir: File): List<String> {
        val dir = runtimeDir.canonicalFile
        require(dir == runtimeDir.absoluteFile.canonicalFile)
        val victims = (dir.listFiles() ?: emptyArray()).filter {
            it.isDirectory && (it.name.startsWith("rootfs.staging-") || it.name.startsWith("rootfs.old-"))
        }
        val removed = ArrayList<String>()
        for (v in victims) {
            deleteTree(v)
            removed += v.name
        }
        return removed
    }

    /** Guest diagnostic paths refer to rootfs files, not Android's /opt or /usr. */
    fun managedFile(raw: File, filesDir: File, dshHome: File): File? {
        val rootfs = File(filesDir, "runtime/rootfs")
        val path = raw.absolutePath
        val mapped = when {
            path == "/opt/dsh" || path.startsWith("/opt/dsh/") -> File(rootfs, path.removePrefix("/"))
            else -> raw
        }
        return mapped.takeIf {
            contains(dshHome, it) || contains(rootfs, it) || contains(File(filesDir, "engine"), it)
        }
    }
}
