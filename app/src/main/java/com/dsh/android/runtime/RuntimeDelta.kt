package com.dsh.android.runtime

import com.dsh.android.log.DshLog as Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlin.concurrent.thread

/**
 * runtime 文件级增量（P2 的客户端段，配 `tools/runtime-chunks.py`）。
 *
 * ## 它解决什么
 *
 * runtime 是 4 个 `rootfs-*.tar.xz`（≈ 145 MB）。引擎版本一变，旧流程要把 4 片全部重下
 * 再全解（968 MB）。而两版之间往往只差**几十字节**（debug.27 → debug.28 只差 48 B）。
 * 这里按 64 KiB 块对比清单，只对变化的块发 HTTP Range。
 *
 * ## 三条纪律（与 `PluginUpdater` 一致，都是踩出来的）
 *
 * 1. **不自动检查、不自动下载**：只在用户点「检查更新」时跑；
 * 2. **只升级不降级**：远端 `runtimeVersion` 必须与本地不同（且下载的产物要过 sha256）；
 * 3. **校验不过一律丢弃**：单块 sha256 → 整文件 sha256 两道，任何一道不符就不落地。
 *
 * ## 没有旧分片时就是全量
 *
 * 目前 `RootfsInstaller` 解包后会把 `.tar.xz` 删掉（`finally { for (f in xzFiles) f.delete() }`），
 * 所以第一次升级没有本地旧分片可对比 —— 此时走**全量**，并把下好的分片**保留**在
 * `files/runtime/parts/<ver>/`，下一次升级就能走增量。
 *
 * 产物位置：`files/runtime/parts/<ver>/<asset>`，与 `manifest.json` 同级同源，
 * 由 [RootfsInstaller] 后续读取（下一段改造点，见 docs/agents/runtime-delta.md）。
 */
object RuntimeDelta {
    private const val TAG = "RuntimeDelta"
    private const val REPO = "kai6666666/deepseek-harness"
    private const val CHUNKS_NAME = "runtime-chunks.json"
    private const val KEEP_VERSIONS = 1

    // ── 状态（页面轮询 stateJson） ─────────────────────────────
    @Volatile private var state: String = "idle" // idle|checking|ready|applying|applied|error
    @Volatile private var message: String = ""
    @Volatile private var fromVersion: String? = null
    @Volatile private var toVersion: String? = null
    @Volatile private var needBytes: Long = 0L
    @Volatile private var totalBytes: Long = 0L
    @Volatile private var incremental: Boolean = false

    /** 给页面轮询的状态 JSON。 */
    fun stateJson(filesDir: File): String = runCatching {
        JSONObject()
            .put("state", state)
            .put("message", message)
            .put("from", fromVersion ?: JSONObject.NULL)
            .put("to", toVersion ?: JSONObject.NULL)
            .put("needBytes", needBytes)
            .put("totalBytes", totalBytes)
            .put("incremental", incremental)
            .toString()
    }.getOrElse { "{}" }

    /** 触发一次检查（异步，立刻返回）；结果看 [stateJson]。 */
    fun checkAsync(filesDir: File): Boolean {
        if (state == "checking" || state == "applying") return false
        state = "checking"; message = "正在检查运行时…"
        thread(name = "RuntimeDelta-check", isDaemon = true) { runCheck(filesDir) }
        return true
    }

    /** 把已算好的差异下载并落地（异步，立刻返回）。 */
    fun applyAsync(filesDir: File): Boolean {
        if (state != "ready") return false
        state = "applying"; message = "正在下载运行时…"
        thread(name = "RuntimeDelta-apply", isDaemon = true) { runApply(filesDir) }
        return true
    }

    // ── 检查 ────────────────────────────────────────────────
    private fun runCheck(filesDir: File) {
        try {
            val local = localManifest(filesDir)
            fromVersion = local
            val rel = latestRuntimeRelease() ?: throw IllegalStateException("没找到带 $CHUNKS_NAME 的 Release")
            val chunksText = httpGet(rel.chunksUrl) ?: throw IllegalStateException("下载分块清单失败")
            val doc = JSONObject(chunksText)
            val remoteVer = doc.optString("runtimeVersion")
            if (remoteVer.isEmpty()) throw IllegalStateException("分块清单缺 runtimeVersion")
            toVersion = remoteVer
            if (local != null && local == remoteVer) {
                state = "ready"; message = "运行时已是最新（$remoteVer）"
                needBytes = 0; totalBytes = 0; incremental = false
                Log.i(TAG, message)
                return
            }
            val plan = planDelta(doc, rel, filesDir)
            totalBytes = plan.totalBytes
            needBytes = plan.needBytes
            incremental = plan.incremental
            val human = human(plan.needBytes)
            state = "ready"
            message = if (plan.incremental)
                "发现运行时 $remoteVer：增量 $human / 全量 ${human(plan.totalBytes)}"
            else
                "发现运行时 $remoteVer：全量 $human"
            Log.i(TAG, message)
        } catch (t: Throwable) {
            state = "error"; message = t.message ?: t.toString()
            Log.w(TAG, "检查失败：" + message)
        }
    }

    /** 一次检查的结论：要下哪些块、总量多少。 */
    private class Plan(
        val version: String,
        /** asset 名 → 每个文件的块计划 */
        val files: List<FilePlan>,
        val needBytes: Long,
        val totalBytes: Long,
        val incremental: Boolean,
    )

    private class FilePlan(
        val name: String,
        val url: String,
        val bytes: Long,
        val sha256: String,
        val chunk: Int,
        /** 需要从网络拿的块（其余块从本地旧文件拷） */
        val fetch: List<JSONObject>,
        /** 本地旧文件（可空：空 = 该文件全量下） */
        val base: File?,
    )

    private fun planDelta(doc: JSONObject, rel: RuntimeRelease, filesDir: File): Plan {
        val chunkSize = doc.optInt("chunkSize", 65536).coerceAtLeast(4096)
        val filesObj = doc.getJSONObject("files")
        val version = doc.optString("runtimeVersion")
        val out = ArrayList<FilePlan>()
        var need = 0L
        var total = 0L
        var anyIncremental = false
        val names = filesObj.keys().asSequence().toList()
        for (n in names) {
            val fo = filesObj.getJSONObject(n)
            val bytes = fo.optLong("bytes")
            val sha = fo.optString("sha256")
            total += bytes
            val chunks = fo.optJSONArray("chunks") ?: JSONArray()
            val url = rel.assets[n] ?: rel.assets[n.substringAfterLast('/')]
                ?: throw IllegalStateException("Release 里没有分片 $n（旧版发布缺资产）")
            // 本地旧分片：优先 parts/<本地ver>/，其次 runtime/ 根下的同名文件
            val base = localBase(filesDir, n)
            val fetch = ArrayList<JSONObject>()
            if (base != null && base.length() == bytes) {
                val localHashes = chunkHashes(base, chunkSize)
                for (i in 0 until chunks.length()) {
                    val c = chunks.getJSONObject(i)
                    val h = c.optString("h")
                    if (i >= localHashes.size || localHashes[i] != h) fetch.add(c)
                }
                if (fetch.isEmpty()) {
                    // 整文件相同：不需要任何下载
                    out.add(FilePlan(n, url, bytes, sha, chunkSize, emptyList(), base))
                    continue
                }
                anyIncremental = true
            } else {
                for (i in 0 until chunks.length()) fetch.add(chunks.getJSONObject(i))
            }
            for (c in fetch) need += c.optLong("l")
            out.add(FilePlan(n, url, bytes, sha, chunkSize, fetch, if (base != null && base.length() == bytes) base else null))
        }
        return Plan(version, out, need, total, anyIncremental)
    }

    // ── 应用 ────────────────────────────────────────────────
    private fun runApply(filesDir: File) {
        try {
            val local = localManifest(filesDir)
            val rel = latestRuntimeRelease() ?: throw IllegalStateException("没找到带 $CHUNKS_NAME 的 Release")
            val doc = JSONObject(httpGet(rel.chunksUrl) ?: throw IllegalStateException("下载分块清单失败"))
            val plan = planDelta(doc, rel, filesDir)
            if (plan.version.isEmpty()) throw IllegalStateException("清单缺 runtimeVersion")
            if (local == plan.version) {
                state = "applied"; message = "运行时已是最新（${plan.version}）"; return
            }
            val staging = File(filesDir, "runtime/parts/.staging-${plan.version}-${android.os.Process.myPid()}")
            RuntimeFiles.deleteTree(staging)
            if (!staging.mkdirs()) throw IllegalStateException("无法创建 staging")
            var done = 0L
            try {
                for (fp in plan.files) {
                    val dst = File(staging, fp.name)
                    if (fp.fetch.isEmpty() && fp.base != null) {
                        // 整文件直接拷（本地已有同样内容）
                        fp.base.copyTo(dst, overwrite = true)
                        continue
                    }
                    val raf = RandomAccessFile(dst, "rw")
                    try {
                        raf.setLength(fp.bytes)
                        // ① 先把本地旧文件整体拷进去（有的话），再覆盖变化的块
                        if (fp.base != null && fp.base.isFile) copyInto(fp.base, raf)
                        // ② 逐块 Range 下载
                        for (c in fp.fetch) {
                            val off = c.optLong("o")
                            val len = c.optLong("l")
                            val want = c.optString("h")
                            val buf = downloadRange(fp.url, off, len)
                                ?: throw IllegalStateException("分块下载失败 ${fp.name}@$off")
                            if (buf.size.toLong() != len) throw IllegalStateException("分块长度不符 ${fp.name}@$off")
                            val got = sha256(buf)
                            if (!got.equals(want, ignoreCase = true)) throw IllegalStateException("分块 sha256 不符 ${fp.name}@$off")
                            raf.seek(off)
                            raf.write(buf)
                            done += len
                            message = "正在下载运行时… " + human(done) + " / " + human(needBytes)
                        }
                    } finally {
                        runCatching { raf.close() }
                    }
                    // ③ 整文件终校
                    val whole = sha256(dst)
                    if (!whole.equals(fp.sha256, ignoreCase = true)) {
                        throw IllegalStateException("整文件 sha256 不符 ${fp.name}（期望 ${fp.sha256.take(12)}… 实际 ${whole?.take(12)}…）")
                    }
                }
                // ④ 落盘：manifest.json 一起带过去（版本号就在这里）
                val manifestJson = httpGet(rel.manifestUrl ?: rel.chunksUrl) ?: ""
                if (manifestJson.isNotEmpty()) {
                    runCatching { File(staging, "manifest.json").writeText(manifestJson) }
                }
                // ⑤ 原子替换
                val target = File(filesDir, "runtime/parts/${plan.version}")
                RuntimeFiles.deleteTree(target)
                target.parentFile?.mkdirs()
                if (!staging.renameTo(target)) {
                    // rename 失败（跨设备/占用）→ 逐文件搬
                    target.mkdirs()
                    staging.listFiles()?.forEach { f ->
                        val t = File(target, f.name)
                        t.delete()
                        if (!f.renameTo(t)) f.copyTo(t, overwrite = true)
                    }
                    RuntimeFiles.deleteTree(staging)
                }
                pruneOldParts(filesDir)
                state = "applied"
                message = "运行时 ${plan.version} 已就绪（" + (if (plan.incremental) "增量" else "全量") + " " + human(plan.needBytes) + "）"
                Log.i(TAG, message)
            } catch (t: Throwable) {
                RuntimeFiles.deleteTree(staging)
                throw t
            }
        } catch (t: Throwable) {
            state = "error"; message = t.message ?: t.toString()
            Log.w(TAG, "应用失败：" + message)
        }
    }

    /** 只保留最近 [KEEP_VERSIONS] 个版本的分片（每个约 145 MB）。 */
    private fun pruneOldParts(root: File) {
        runCatching {
            val dir = File(root, "runtime/parts")
            val versions = dir.listFiles { f -> f.isDirectory && !f.name.startsWith(".") }
                ?.sortedByDescending { it.name } ?: return@runCatching
            versions.drop(KEEP_VERSIONS).forEach { RuntimeFiles.deleteTree(it) }
        }
    }

    // ── 给 RootfsInstaller 的接口（增量 ↔ 安装的接缝）─────────────

    /** 某个版本的某个分片文件（增量产物）；没有则 null。 */
    fun partFile(filesDir: File, version: String, asset: String): File? {
        if (version.isEmpty()) return null
        val f = File(filesDir, "runtime/parts/" + version + "/" + asset)
        return if (f.isFile && f.length() > 0L) f else null
    }

    /**
     * parts 目录里「最新一版」的 manifest.json。
     *
     * [RootfsInstaller][com.dsh.android.runtime.RootfsInstaller] 启动时优先用它 ——
     * 否则用户点完「检查更新 → 应用」下载到 `runtime/parts/<new>/` 也不会被采用
     * （assets 里的 manifest.json 还是 APK 自带的旧版本）。
     */
    fun bestPartsManifest(filesDir: File): File? {
        val dir = File(filesDir, "runtime/parts")
        val files = dir.listFiles { f -> f.isDirectory && !f.name.startsWith(".") }
            ?.mapNotNull { File(it, "manifest.json").takeIf { m -> m.isFile } }
            ?: return null
        return files.maxByOrNull { it.lastModified() }
    }

    // ── 工具 ────────────────────────────────────────────────
    private class RuntimeRelease(
        val tag: String,
        val chunksUrl: String,
        val manifestUrl: String?,
        val assets: Map<String, String>,
    )

    /** 在最近的 Release 里找 `runtime-chunks.json`（手动发布的最新一版）。 */
    private fun latestRuntimeRelease(): RuntimeRelease? {
        val body = httpGet("https://api.github.com/repos/$REPO/releases?per_page=10") ?: return null
        val arr = JSONArray(body)
        for (i in 0 until arr.length()) {
            val rel = arr.optJSONObject(i) ?: continue
            val assets = rel.optJSONArray("assets") ?: continue
            var chunks: String? = null
            val map = LinkedHashMap<String, String>()
            var manifest: String? = null
            for (j in 0 until assets.length()) {
                val a = assets.optJSONObject(j) ?: continue
                val n = a.optString("name")
                val u = a.optString("browser_download_url")
                if (n == CHUNKS_NAME) { chunks = u; continue }
                if (n == "manifest.json") { manifest = u; continue }
                if (n.endsWith(".tar.xz")) map[n] = u
            }
            if (chunks != null) {
                return RuntimeRelease(rel.optString("tag_name"), chunks, manifest, map)
            }
        }
        return null
    }

    private fun localManifest(filesDir: File): String? = runCatching {
        val f = File(filesDir, "runtime/manifest.json")
        if (!f.isFile) null else JSONObject(f.readText()).optString("runtimeVersion").ifEmpty { null }
    }.getOrNull()

    /** 本地可作基线的旧分片：`runtime/parts/<ver>/<asset>`，或 `runtime/<asset>`。 */
    private fun localBase(filesDir: File, asset: String): File? {
        val direct = File(filesDir, "runtime/$asset")
        if (direct.isFile) return direct
        val parts = File(filesDir, "runtime/parts")
        val dirs = parts.listFiles { f -> f.isDirectory && !f.name.startsWith(".") } ?: return null
        for (d in dirs) {
            val f = File(d, asset)
            if (f.isFile) return f
        }
        return null
    }

    private fun chunkHashes(f: File, chunkSize: Int): List<String> {
        val out = ArrayList<String>()
        val buf = ByteArray(chunkSize)
        f.inputStream().use { ins ->
            while (true) {
                var read = 0
                while (read < chunkSize) {
                    val n = ins.read(buf, read, chunkSize - read)
                    if (n <= 0) break
                    read += n
                }
                if (read <= 0) break
                out.add(sha256(buf, read))
                if (read < chunkSize) break
            }
        }
        return out
    }

    private fun copyInto(src: File, raf: RandomAccessFile) {
        raf.seek(0)
        src.inputStream().use { ins ->
            val buf = ByteArray(1 shl 20)
            while (true) {
                val n = ins.read(buf)
                if (n <= 0) break
                raf.write(buf, 0, n)
            }
        }
    }

    private fun httpGet(url: String): String? = runCatching {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 15000
        c.readTimeout = 20000
        c.setRequestProperty("User-Agent", "dsh-android")
        c.setRequestProperty("Accept", "application/vnd.github+json")
        try {
            if (c.responseCode !in 200..299) return@runCatching null
            c.inputStream.bufferedReader().use { it.readText() }
        } finally {
            c.disconnect()
        }
    }.getOrNull()

    /** 取一个字节区间（GitHub Release 资产支持 Range：302 后裸下载即可，不带鉴权头）。 */
    private fun downloadRange(url: String, off: Long, len: Long): ByteArray? = runCatching {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 15000
        c.readTimeout = 30000
        c.instanceFollowRedirects = true
        c.setRequestProperty("User-Agent", "dsh-android")
        c.setRequestProperty("Range", "bytes=" + off + "-" + (off + len - 1))
        try {
            val code = c.responseCode
            if (code != 206 && code != 200) return@runCatching null
            val stream = c.inputStream
            val out = java.io.ByteArrayOutputStream(len.toInt().coerceAtMost(1 shl 24))
            val buf = ByteArray(64 * 1024)
            var remaining = len
            if (code == 200) {
                // 服务器忽略 Range：自己跳过前缀（仍然正确，只是多下了数据）
                var skip = off
                while (skip > 0) {
                    val n = stream.skip(skip)
                    if (n <= 0) break
                    skip -= n
                }
            }
            while (remaining > 0) {
                val n = stream.read(buf, 0, minOf(buf.size.toLong(), remaining).toInt())
                if (n <= 0) break
                out.write(buf, 0, n)
                remaining -= n
            }
            stream.close()
            out.toByteArray()
        } finally {
            c.disconnect()
        }
    }.getOrNull()

    private fun sha256(bytes: ByteArray, len: Int = bytes.size): String {
        val md = MessageDigest.getInstance("SHA-256")
        md.update(bytes, 0, len)
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    private fun sha256(f: File): String? = runCatching {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { ins ->
            val buf = ByteArray(1 shl 20)
            while (true) {
                val n = ins.read(buf)
                if (n <= 0) break
                md.update(buf, 0, n)
            }
        }
        md.digest().joinToString("") { "%02x".format(it) }
    }.getOrNull()

    private fun human(b: Long): String = when {
        b >= 1024L * 1024 * 1024 -> String.format("%.2f GB", b / 1024.0 / 1024 / 1024)
        b >= 1024L * 1024 -> String.format("%.1f MB", b / 1024.0 / 1024)
        b >= 1024L -> String.format("%d KB", b / 1024)
        else -> "$b B"
    }
}
