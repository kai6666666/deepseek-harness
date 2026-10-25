package com.dsh.android.runtime

import android.system.Os
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.util.zip.GZIPInputStream

/**
 * 纯 Kotlin 的 tar.gz 解包器。
 *
 * 为什么不用 `/system/bin/tar`：
 *   1. 不同 ROM 的 toybox 行为不一致（有的不支持 `--numeric-owner`）；4. 失败时错误信息没法映射到 Kotlin 异常。
 * 为什么不用 commons-compress：不想为一个解包动作给 APK 加依赖。
 *
 * 支持的 tar 特性（GNU tar 打的包必用到的几种）：
 *   - ustar 前缀拼接（prefix + name）
 *   - GNU 长文件名 `L` / 长链接名 `K`（`././@LongLink`）
 *   - pax 扩展头 `x` / `g`（直接跳过）
 *   - 目录 `5` / 普通文件 `0` / 符号链接 `2` / 硬链接 `1`
 *   - 权限位（用 [Os.chmod]，可执行位必须留住，否则 /usr/bin/node 起不来）
 *
 * 解包后必须校验：`usr/bin/node` 存在且**可执行**，见 [AlpineProvisioner]。
 */
class TarGzExtractor(private val onEntry: ((String) -> Unit)? = null) {

    /** @return 实际落地的条目数 */
    fun extract(stream: InputStream, destDir: File): Int {
        destDir.mkdirs()
        val destRoot = destDir.absolutePath
        val header = ByteArray(BLOCK)
        var count = 0
        var longName: String? = null
        var longLink: String? = null

        GZIPInputStream(BufferedInputStream(stream, 1 shl 16)).use { gz ->
            while (true) {
                if (!readFully(gz, header, BLOCK)) break
                if (isZeroBlock(header)) break        // 两个全零块 = 归档结束

                val nameRaw = cstr(header, 0, 100)
                val mode = cstr(header, 100, 8).trim().toIntOrNull(8) ?: 0
                val size = cstr(header, 124, 12).trim().toLongOrNull(8) ?: 0L
                val type = (header[156].toInt() and 0xFF).toChar()
                val linkRaw = cstr(header, 157, 100)
                val prefix = if (cstr(header, 257, 6).startsWith("ustar")) cstr(header, 345, 155) else ""

                when (type) {
                    'L' -> { longName = readString(gz, size); skipPadding(gz, size); continue }
                    'K' -> { longLink = readString(gz, size); skipPadding(gz, size); continue }
                    'x', 'g' -> { skipFully(gz, size); skipPadding(gz, size); continue }
                    else -> Unit
                }

                val rawName = longName ?: if (prefix.isNotEmpty()) "$prefix/$nameRaw" else nameRaw
                val link = longLink ?: linkRaw
                longName = null
                longLink = null

                val rel = rawName.removePrefix("./").trimEnd('/')
                if (rel.isNotEmpty()) {
                    val out = File(destDir, rel)
                    // ⚠️ 用 **字面路径** 判 ZipSlip，不要 canonicalPath：
                    // Alpine 里 `bin -> /usr/bin` 是**绝对** symlink，canonical 会穿到
                    // 宿主的 `/usr/bin` → 之后所有 `bin/*` 条目都被当越界跳过，
                    // 真机表现为 `/usr/bin/env`、`/bin/sh` 全都 exists=false。
                    val canon = out.absolutePath
                    // ZipSlip：只允许落在 destDir 内
                    if (canon == destRoot || canon.startsWith(destRoot + File.separator)) {
                        when (type) {
                            '5' -> { out.mkdirs(); chmod(out, mode) }
                            '2' -> {
                                out.parentFile?.mkdirs()
                                runCatching { out.delete() }
                                // 绝对 target 必须转成**相对**再建，否则在宿主体内会穿出 rootfs
                                // （`bin -> /usr/bin` 指到宿主的 /usr/bin，后续 bin/* 全丢）。
                                // guest 内 proot 会按 rootfs 重新解析，相对路径语义完全等价。
                                val resolved = if (link.startsWith("/")) {
                                    runCatching {
                                        File(destDir, link.removePrefix("/"))
                                            .relativeTo(out.parentFile ?: destDir)
                                            .invariantSeparatorsPath
                                    }.getOrDefault(link)
                                } else {
                                    link
                                }
                                runCatching { Os.symlink(resolved, out.absolutePath) }
                                    .onFailure { if (it is SecurityException) throw it }
                            }
                            '1' -> {
                                out.parentFile?.mkdirs()
                                // 硬链接目标同样可能写成 `/bin/busybox`，必须落到 destDir 里
                                val target = File(destDir, link.removePrefix("/").removePrefix("./"))
                                val ok = runCatching {
                                    runCatching { out.delete() }
                                    Os.link(target.absolutePath, out.absolutePath)
                                }.isSuccess
                                if (!ok) runCatching { target.copyTo(out, overwrite = true) }
                                skipFully(gz, size)
                            }
                            '0', '\u0000' -> {
                                out.parentFile?.mkdirs()
                                FileOutputStream(out).use { fos -> copyExactly(gz, fos, size) }
                                chmod(out, mode)
                            }
                            else -> skipFully(gz, size)     // 设备节点 / FIFO 等：跳过
                        }
                        count++
                        onEntry?.invoke(rel)
                    } else {
                        skipFully(gz, size)
                    }
                } else {
                    skipFully(gz, size)
                }
                skipPadding(gz, size)
            }
        }
        return count
    }

    private fun chmod(f: File, mode: Int) {
        if (mode == 0) return
        runCatching { Os.chmod(f.absolutePath, mode and 0xFFF) }
    }

    private fun isZeroBlock(b: ByteArray): Boolean {
        for (i in 0 until BLOCK) if (b[i] != 0.toByte()) return false
        return true
    }

    /** 读满一整块；EOF 返回 false。 */
    private fun readFully(input: InputStream, buf: ByteArray, len: Int): Boolean {
        var off = 0
        while (off < len) {
            val n = input.read(buf, off, len - off)
            if (n < 0) return false
            off += n
        }
        return true
    }

    private fun copyExactly(input: InputStream, out: FileOutputStream, size: Long) {
        val buf = ByteArray(1 shl 16)
        var left = size
        while (left > 0) {
            val n = input.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
            if (n < 0) break
            out.write(buf, 0, n)
            left -= n
        }
    }

    private fun readString(input: InputStream, size: Long): String {
        val buf = ByteArray(size.toInt())
        var off = 0
        while (off < buf.size) {
            val n = input.read(buf, off, buf.size - off)
            if (n < 0) break
            off += n
        }
        return String(buf, 0, off, Charsets.UTF_8).trimEnd('\u0000')
    }

    private fun skipFully(input: InputStream, size: Long) {
        var left = size
        val buf = ByteArray(1 shl 12)
        while (left > 0) {
            val n = input.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
            if (n < 0) return
            left -= n
        }
    }

    private fun skipPadding(input: InputStream, size: Long) {
        val pad = ((BLOCK - (size % BLOCK)) % BLOCK).toInt()
        if (pad != 0) skipFully(input, pad.toLong())
    }

    /** 定长字段 → C 字符串（到第一个 NUL 为止）。 */
    private fun cstr(b: ByteArray, off: Int, len: Int): String {
        var end = off
        val limit = minOf(b.size, off + len)
        while (end < limit && b[end] != 0.toByte()) end++
        return String(b, off, end - off, Charsets.US_ASCII)
    }

    private companion object {
        const val BLOCK = 512
    }
}