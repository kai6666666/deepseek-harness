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

    fun missingCriticalFiles(rootfs: File): List<String> = criticalFiles.filter { name ->
        val f = File(rootfs, name)
        !contains(rootfs, f) || !f.isFile || f.length() == 0L
    }

    /** walkFileTree defaults to NOFOLLOW: a link to user data is deleted as a link. */
    fun deleteTree(root: File) {
        if (!Files.exists(root.toPath(), NOFOLLOW_LINKS)) return
        Files.walkFileTree(root.toPath(), object : SimpleFileVisitor<Path>() {
            override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                Files.delete(file)
                return FileVisitResult.CONTINUE
            }
            override fun postVisitDirectory(dir: Path, error: IOException?): FileVisitResult {
                if (error != null) throw error
                Files.delete(dir)
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

    /** Exact allowlist, rename only, after a healthy boot. termux/home stays in place. */
    fun retireLegacy(filesDir: File): List<String> {
        val base = filesDir.canonicalFile
        val runtime = File(base, "runtime")
        val archive = File(runtime, "legacy-bionic")
        require(contains(filesDir, archive) && !Files.isSymbolicLink(runtime.toPath()) && !Files.isSymbolicLink(archive.toPath()))
        val moved = ArrayList<String>()
        for (relative in listOf("engine", "usr", "termux/usr")) {
            val source = File(base, relative)
            // A symlink in a parent could redirect the rename outside filesDir.
            if (source.parentFile.canonicalFile != source.parentFile.absoluteFile) continue
            if (!Files.exists(source.toPath(), NOFOLLOW_LINKS)) continue
            if (!archive.mkdirs() && !archive.isDirectory) throw IOException("legacy archive mkdir failed")
            val target = File(archive, relative.replace('/', '-') + "-${System.nanoTime()}")
            if (!source.renameTo(target)) throw IOException("legacy rename failed: $relative")
            moved += relative
        }
        return moved
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
