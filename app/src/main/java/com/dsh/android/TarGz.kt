package com.dsh.android

/**
 * 从 APK assets 中解出 tar.gz 归档。
 *
 * 之所以自己解析 tar 而不用第三方库：Android 平台自带 GZIPInputStream，
 * 而 tar 头部结构极其简单，手写解析可以完全避免额外依赖。
 *
 * ## 2026-10-27 真机事故：只解出 45 MB / 52 537 条 里的 2 463 条，却报「解包完成」
 *
 * 三个连着的缺陷，缺一个都不会出事：
 *
 * 1. **非普通条目的数据体没被跳过**。旧代码 `else -> {}` 的注释写着「只跳过数据」，
 *    实际只跳了**对齐填充** `size % 512`。GNU tar 对超过 100 字符的路径会先写一条
 *    `././@LongLink`（typeFlag `'L'`，size>0，数据体就是真名），
 *    于是流错位 136 字节 → 下一条「头部」是垃圾。
 * 2. **名字读空就 `break`**，当成「归档结束标记」。垃圾头部里 name 字段常常是空的，
 *    于是解包在 2 463 条（`@smithy/core/dist-es/legacy-root-exports/...` 那串长路径）
 *    悄悄停住，`staging` 被 rename 成正式目录，日志写「引擎资产解包完成」。
 * 3. **没有任何完整性断言**。存档 52 537 条 / 532 MB，落地 45 MB，没人对比。
 *
 * 现在的规则：
 *   - `'L'/'K'`（GNU 长名/长链接）、`'x'/'g'`（PAX 扩展头）都**先读完数据体**再继续；
 *   - 其他非普通条目的 `size` 字节也要跳过（符号链接 size=0，所以旧代码一直没暴露）；
 *   - 读不到名字 → 抛异常。归档结束只认「零块」和「流 EOF」两种；
 *   - 返回 [Stats]，供上层与 `MANIFEST.txt` 声明值对照（见 EngineManager.verifyEngineManifest）。
 */
internal object TarGz {

    private const val BLOCK = 512

    /**
     * 解包结果。
     *
     * @param entries 解析到的头部条目数（含目录、含 `L`/`x` 元数据条目）
     * @param nodeModulesFiles `node_modules/` 下的普通文件数
     * @param nodeModulesBytes 这些文件按头部声明累加的字节数
     */
    data class Stats(
        val entries: Int,
        val nodeModulesFiles: Long,
        val nodeModulesBytes: Long,
    )

    /**
     * 解压 [input]（tar.gz 流）到 [destDir]。
     *
     * @param onProgress 已写出字节数回调，用于展示进度。
     */
    fun extract(
        input: java.io.InputStream,
        destDir: java.io.File,
        onProgress: (Long) -> Unit = {},
    ): Stats {
        val gz = java.util.zip.GZIPInputStream(input, 64 * 1024)
        val destRoot = destDir.canonicalPath

        var entries = 0
        var nmFiles = 0L
        var nmBytes = 0L
        var written = 0L

        // GNU/PAX 元数据：作用于「下一个条目」，用完即清
        var pendingName: String? = null
        @Suppress("UNUSED_VARIABLE")
        var pendingLink: String? = null
        val pax = HashMap<String, String>()

        gz.use { stream ->
            val header = ByteArray(BLOCK)

            while (true) {
                if (!readFully(stream, header)) break
                if (isZeroBlock(header)) break // 归档结束标记：两个全零块中的第一个

                entries++
                val name = readString(header, 0, 100)
                val prefix = readString(header, 345, 155)
                val size = readOctal(header, 124, 12)
                val typeFlag = header[156].toInt().and(0xFF).toChar()

                // ① 元数据条目：数据体里是「下一个条目的真名 / 真链接 / 扩展属性」
                if (typeFlag == 'L' || typeFlag == 'K' || typeFlag == 'x' || typeFlag == 'g') {
                    val payload = readPayload(stream, size)
                    when (typeFlag) {
                        'L' -> pendingName = String(payload, Charsets.UTF_8).trimEnd('\u0000').trim()
                        'K' -> pendingLink = String(payload, Charsets.UTF_8).trimEnd('\u0000').trim()
                        else -> parsePax(payload, pax)
                    }
                    skipPadding(stream, size)
                    continue
                }

                // ② 普通条目：真名可能来自上一个 L / x 头
                val rawFull = if (prefix.isEmpty()) name else "$prefix/$name"
                val fullName = (pendingName ?: pax["path"] ?: rawFull).trimEnd('/')
                pendingName = null
                pendingLink = null
                pax.clear()

                if (fullName.isEmpty()) {
                    // ⚠️ 这里曾经是 `break`：垃圾头部让解包静默停在 2 463/52 537 条。
                    throw java.io.IOException(
                        "tar 头部损坏：第 $entries 个条目没有名字（type=$typeFlag, size=$size）"
                    )
                }

                val target = java.io.File(destDir, fullName)
                // 防御路径穿越（归档里出现 ../ 时拒绝）
                val targetPath = target.canonicalPath
                if (targetPath != destRoot &&
                    !targetPath.startsWith(destRoot + java.io.File.separator)
                ) {
                    throw java.io.IOException("tar 条目越界: $fullName")
                }

                when (typeFlag) {
                    '5' -> { // 目录
                        target.mkdirs()
                    }
                    '0', '\u0000', '7' -> { // 普通文件
                        target.parentFile?.mkdirs()
                        java.io.FileOutputStream(target).use { out ->
                            var remaining = size
                            val buf = ByteArray(64 * 1024)
                            while (remaining > 0) {
                                val want = minOf(remaining, buf.size.toLong()).toInt()
                                val read = stream.read(buf, 0, want)
                                if (read <= 0) throw java.io.IOException("tar 数据截断: $fullName")
                                out.write(buf, 0, read)
                                remaining -= read
                                written += read
                                onProgress(written)
                            }
                        }
                        if (fullName.startsWith("node_modules/")) {
                            nmFiles++
                            nmBytes += size
                        }
                    }
                    else -> { // 符号链接 / 硬链接 / 设备等：数据体按 size 跳过（多数为 0）
                        skipFully(stream, size)
                    }
                }

                // tar 每个条目按 512 字节对齐
                skipPadding(stream, size)
            }
        }

        return Stats(entries, nmFiles, nmBytes)
    }

    /** 读 [size] 字节的数据体（元数据条目只有几百字节，直接进内存）。 */
    private fun readPayload(stream: java.io.InputStream, size: Long): ByteArray {
        if (size <= 0L) return ByteArray(0)
        if (size > 8L * 1024 * 1024) throw java.io.IOException("tar 元数据条目过大: $size")
        val out = ByteArray(size.toInt())
        var off = 0
        while (off < out.size) {
            val n = stream.read(out, off, out.size - off)
            if (n <= 0) throw java.io.IOException("tar 元数据截断：只读到 $off/${out.size} 字节")
            off += n
        }
        return out
    }

    /** PAX 记录格式：`<长度> key=value\n`，长度含自身。 */
    private fun parsePax(payload: ByteArray, out: MutableMap<String, String>) {
        val text = String(payload, Charsets.UTF_8)
        var i = 0
        while (i < text.length) {
            val sp = text.indexOf(' ', i)
            if (sp < 0) break
            val len = text.substring(i, sp).toIntOrNull() ?: break
            if (len <= 0 || i + len > text.length) break
            val record = text.substring(sp + 1, i + len).trimEnd('\n')
            val eq = record.indexOf('=')
            if (eq > 0) out[record.substring(0, eq)] = record.substring(eq + 1)
            i += len
        }
    }

    private fun skipPadding(stream: java.io.InputStream, size: Long) {
        val padding = (BLOCK - (size % BLOCK)) % BLOCK
        if (padding > 0) skipFully(stream, padding)
    }

    /**
     * 读满一整块返回 true；读不到任何字节（归档正常结束）返回 false。
     * 合法 tar 的块总是 512 的整数倍，因此部分读取只可能出现在文件被截断时。
     */
    private fun readFully(stream: java.io.InputStream, buf: ByteArray): Boolean {
        var off = 0
        while (off < buf.size) {
            val n = stream.read(buf, off, buf.size - off)
            if (n < 0) break
            off += n
        }
        if (off == 0) return false
        if (off < buf.size) throw java.io.IOException("tar 头部被截断：只读到 $off/${buf.size} 字节")
        return true
    }

    private fun skipFully(stream: java.io.InputStream, count: Long) {
        var remaining = count
        while (remaining > 0) {
            val skipped = stream.skip(remaining)
            if (skipped <= 0) {
                if (stream.read() < 0) return
                remaining--
            } else {
                remaining -= skipped
            }
        }
    }

    private fun isZeroBlock(buf: ByteArray): Boolean {
        for (b in buf) if (b.toInt() != 0) return false
        return true
    }

    /** tar 字符串字段：以 NUL 结尾，可能含尾部垃圾。 */
    private fun readString(buf: ByteArray, offset: Int, length: Int): String {
        var end = offset
        val limit = offset + length
        while (end < limit && buf[end].toInt() != 0) end++
        return String(buf, offset, end - offset, Charsets.UTF_8).trim()
    }

    /** tar 数字字段：八进制 ASCII，可能以 NUL 或空格结尾。 */
    private fun readOctal(buf: ByteArray, offset: Int, length: Int): Long {
        var value = 0L
        var i = offset
        val limit = offset + length
        // 跳过前导空格
        while (i < limit && (buf[i].toInt() == 0x20 || buf[i].toInt() == 0)) i++
        while (i < limit) {
            val c = buf[i].toInt()
            if (c < '0'.code || c > '7'.code) break
            value = value * 8 + (c - '0'.code)
            i++
        }
        return value
    }
}