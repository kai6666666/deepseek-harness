package com.dsh.android.runtime

import com.dsh.android.log.DshLog as Log
import com.dsh.android.log.EventLog
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.StandardOpenOption
import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
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

    /**
     * `runCheck` 算出来的结论，给 `runApply` 复用。
     *
     * 为什么需要：`runApply` 原本自己又调一次 `latestRuntimeRelease()` + `planDelta()` ——
     * 那意味着用户在界面上看到「全量 143.5 MB」并点应用之后，**还要再等一遍
     * atom + 多 tag 探测**（走镜像也要 6~10 秒）。缓存后这一步直接省掉。
     *
     * 5 分钟 TTL：用户可能看完提示去干别的，回来再点应用 —— 太久的结果不该直接信。
     * 过了 TTL 或版本对不上就重算（`runApply` 里已有 fallback 路径）。
     */
    @Volatile private var cachedPlan: Plan? = null
    @Volatile private var cachedRel: RuntimeRelease? = null
    @Volatile private var cachedAtMs: Long = 0L
    private const val PLAN_TTL_MS = 5L * 60 * 1000
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

    /**
     * 把已算好的差异下载并落地（异步，立刻返回）。
     *
     * ⚠️ 返回 `false` 时**必须留下痕迹**：dryrun 钩子原来固定 `sleep(10s)` 后调这里，
     * 而 `runCheck` 走镜像 + 探测多个 tag 要 20+ 秒 ⇒ `state` 还是 `"checking"`，
     * 于是这次调用**静默返回 false**，30 秒后打印的还是 `state=ready`，看起来像"apply 没跑"。
     * 现在把原因写进 `message` 并打日志。
     */
    fun applyAsync(filesDir: File): Boolean {
        val cur = state
        if (cur != "ready") {
            message = "还不能应用：当前状态=$cur（检查还没完成或已失败）"
            Log.w(TAG, "applyAsync 被拒绝：$message")
            return false
        }
        state = "applying"; message = "正在下载运行时…"
        thread(name = "RuntimeDelta-apply", isDaemon = true) { runApply(filesDir) }
        return true
    }

    // ── 检查 ────────────────────────────────────────────────
    private fun runCheck(filesDir: File) {
        try {
            val local = localManifest(filesDir)
            fromVersion = local
            val rel = latestRuntimeRelease()
                ?: throw IllegalStateException(lastReleaseError ?: "检查更新失败：原因未知（既没拿到 atom 也没拿到清单，试了 ${ReleaseFailKind.values().size} 类判据）")
            val chunksText = rel.chunksText ?: httpGetWithMirrors(rel.chunksUrl)
                ?: throw IllegalStateException("下载分块清单失败：${rel.chunksUrl}")
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
            // 存起来给 runApply 复用（省掉 apply 侧重复的 atom + 探测）
            cachedPlan = plan
            cachedRel = rel
            cachedAtMs = System.currentTimeMillis()
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
                ?: rel.baseUrl?.let { it + n }
                ?: throw IllegalStateException("Release 里没有分片 $n（旧版发布缺资产）")
            // 本地旧分片：优先 parts/<本地ver>/，其次 runtime/ 根下的同名文件
            val base = localBase(filesDir, n)
            val remoteHashes = ArrayList<String>(chunks.length())
            for (i in 0 until chunks.length()) remoteHashes.add(chunks.getJSONObject(i).optString("h"))
            val localHashes = if (base != null && base.length() == bytes) chunkHashes(base, chunkSize) else null
            // A4-#6：只取 hash 变化的块（纯函数，见文件末尾 `changedChunkIndexes`）
            val idx = changedChunkIndexes(localHashes, remoteHashes)
            val fetch = ArrayList<JSONObject>(idx.size)
            for (i in idx) fetch.add(chunks.getJSONObject(i))
            if (localHashes != null && fetch.isEmpty()) {
                // 整文件相同：不需要任何下载
                out.add(FilePlan(n, url, bytes, sha, chunkSize, emptyList(), base))
                continue
            }
            if (localHashes != null) anyIncremental = true
            for (c in fetch) need += c.optLong("l")
            out.add(FilePlan(n, url, bytes, sha, chunkSize, fetch, if (base != null && base.length() == bytes) base else null))
        }
        return Plan(version, out, need, total, anyIncremental)
    }

    // ── 应用 ────────────────────────────────────────────────
    private fun runApply(filesDir: File) {
        try {
            val local = localManifest(filesDir)
            val rel0 = latestRuntimeRelease()
                ?: throw IllegalStateException(lastReleaseError ?: "检查更新失败：原因未知（既没拿到 atom 也没拿到清单，试了 ${ReleaseFailKind.values().size} 类判据）")
            // 优先复用 runCheck 的结论（省掉重复的 atom + 多 tag 探测）
            val cached = cachedPlan
            val cachedAge = System.currentTimeMillis() - cachedAtMs
            val plan: Plan
            val rel: RuntimeRelease
            if (cached != null && cachedAge in 0..PLAN_TTL_MS) {
                plan = cached
                rel = cachedRel ?: latestRuntimeRelease()
                    ?: throw IllegalStateException(lastReleaseError ?: "检查更新失败")
                Log.i(TAG, "apply 复用检查结果（${cachedAge}ms 前算的，need=${plan.needBytes}）")
            } else {
                val doc = JSONObject(rel0.chunksText ?: httpGetWithMirrors(rel0.chunksUrl)
                    ?: throw IllegalStateException("下载分块清单失败：${rel0.chunksUrl}"))
                plan = planDelta(doc, rel0, filesDir)
                rel = rel0
                Log.i(TAG, "apply 重新计算计划（缓存过期或不存在）")
            }
            if (plan.version.isEmpty()) throw IllegalStateException("清单缺 runtimeVersion")
            if (local == plan.version) {
                state = "applied"; message = "运行时已是最新（${plan.version}）"; return
            }
            // ── A-1：整个 apply 只选一次线路，全程复用（绝不每个块都探一次） ──
            runCatching {
                val probeUrl = plan.files.firstOrNull()?.let { fp ->
                    fp.url.ifEmpty { rel.baseUrl?.let { it + fp.name } ?: "" }
                }.orEmpty()
                val probeBytes = plan.files.firstOrNull()?.bytes ?: -1L
                if (probeUrl.isNotEmpty()) {
                    val choice = GithubMirrors.pick(probeUrl, probeBytes)
                    downloadBase = choice.base
                    downloadVia = choice.via
                    EventLog.record(
                        "runtime.download.via",
                        mapOf(
                            "via" to choice.via,
                            "bps" to choice.bytesPerSec.toString(),
                            "degraded" to choice.degraded.toString(),
                        ),
                    )
                    Log.i(TAG, "选路结果：${choice.via}（${choice.bytesPerSec / 1024} KB/s）")
                }
            }.onFailure {
                // 选路失败不是错误：downloadBase 保持 null ⇒ 与改动前行为完全一致
                downloadBase = null
                downloadVia = "direct"
                Log.w(TAG, "选路失败，回退直连：" + it.message)
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
                    val base = downloadBase
                    // 先把文件撑到目标长度，并把本地旧内容整体拷进去（并行时各线程只覆盖自己的块）
                    RandomAccessFile(dst, "rw").use { raf ->
                        raf.setLength(fp.bytes)
                        if (fp.base != null && fp.base.isFile) copyInto(fp.base, raf)
                    }
                    // ② 分块下载：块多就并行（A-2），块少就串行（增量的常态）
                    if (fp.fetch.size >= PARALLEL_MIN_CHUNKS) {
                        done = fetchParallel(fp, dst, base, done)
                    } else {
                        done = fetchSerial(fp, dst, base, done, needBytes)
                    }
                    // ③ 整文件终校
                    val whole = sha256(dst)
                    if (!whole.equals(fp.sha256, ignoreCase = true)) {
                        throw IllegalStateException("整文件 sha256 不符 ${fp.name}（期望 ${fp.sha256.take(12)}… 实际 ${whole?.take(12)}…）")
                    }
                }
                // ④ 落盘：manifest.json 一起带过去（版本号就在这里）
                val manifestJson = httpGetWithMirrors(rel.manifestUrl ?: rel.chunksUrl) ?: ""
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

    /** 进度节流：并行时 6 个线程会疯狂更新，日志会被刷屏且看不到真正的错误。 */
    private val lastProgressAt = AtomicLong(0L)

    private fun reportProgress(done: Long, total: Long) {
        val now = System.currentTimeMillis()
        val prev = lastProgressAt.get()
        if (now - prev < PROGRESS_MIN_INTERVAL_MS) return
        if (!lastProgressAt.compareAndSet(prev, now)) return
        message = "正在下载运行时… " + human(done) + " / " + human(total)
    }

    /** 串行下载（增量的常态路径；块少时比开线程池快）。 */
    private fun fetchSerial(
        fp: FilePlan,
        dst: File,
        base: String?,
        startDone: Long,
        total: Long,
    ): Long {
        var done = startDone
        RandomAccessFile(dst, "rw").use { raf ->
            for (c in fp.fetch) {
                val off = c.optLong("o")
                val len = c.optLong("l")
                val want = c.optString("h")
                val buf = downloadRange(fp.url, off, len, base)
                    ?: throw IllegalStateException("分块下载失败 ${fp.name}@$off")
                if (buf.size.toLong() != len) throw IllegalStateException("分块长度不符 ${fp.name}@$off")
                if (!sha256(buf).equals(want, ignoreCase = true)) {
                    throw IllegalStateException("分块 sha256 不符 ${fp.name}@$off")
                }
                raf.seek(off)
                raf.write(buf)
                done += len
                reportProgress(done, total)
            }
        }
        return done
    }

    /**
     * 并行块下载（A-2）。
     *
     * ⚠️ **写入必须用 `FileChannel.write(buf, position)`**，不能用 `RandomAccessFile`：
     * `seek()` + `write()` 是**两步、非原子**，6 个线程交错会把块写到错误偏移 ——
     * 而且是**静默损坏**（块的 sha256 在写入**之前**校验，写完不再验，只靠最后整文件终校兜底，
     * 那时只能整个重下）。positional write 在内核层面是原子的。见 `pa-pb-plan.md` §E2。
     */
    private fun fetchParallel(fp: FilePlan, dst: File, base: String?, startDone: Long): Long {
        val done = AtomicLong(startDone)
        val total = fp.fetch.sumOf { it.optLong("l") } + startDone
        val errors = Collections.synchronizedList(ArrayList<Throwable>())
        val latch = CountDownLatch(fp.fetch.size)
        val pool = Executors.newFixedThreadPool(FETCH_THREADS)
        FileChannel.open(
            dst.toPath(),
            StandardOpenOption.WRITE, StandardOpenOption.CREATE,
        ).use { ch ->
            try {
                for (c in fp.fetch) {
                    pool.execute {
                        try {
                            val off = c.optLong("o")
                            val len = c.optLong("l")
                            val want = c.optString("h")
                            val buf = downloadRange(fp.url, off, len, base)
                                ?: throw IllegalStateException("分块下载失败 ${fp.name}@$off")
                            if (buf.size.toLong() != len) {
                                throw IllegalStateException("分块长度不符 ${fp.name}@$off")
                            }
                            if (!sha256(buf).equals(want, ignoreCase = true)) {
                                throw IllegalStateException("分块 sha256 不符 ${fp.name}@$off")
                            }
                            // positional write：不依赖共享的文件指针，线程安全
                            val bb = ByteBuffer.wrap(buf)
                            var written = 0
                            while (bb.hasRemaining()) {
                                written += ch.write(bb, off + written)
                            }
                            reportProgress(done.addAndGet(len), total)
                        } catch (t: Throwable) {
                            errors.add(t)
                        } finally {
                            latch.countDown()
                        }
                    }
                }
                latch.await(60, TimeUnit.MINUTES)
            } finally {
                pool.shutdownNow()
            }
        }
        if (errors.isNotEmpty()) throw errors.first()
        return done.get()
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
        /** 资产下载前缀（Atom 模式按固定前缀拼 URL）；API 模式为 null */
        val baseUrl: String? = null,
        /** 已下载的清单文本（Atom 探测时已取回，避免二次下载） */
        val chunksText: String? = null,
    )

    /** 最近一次取 Release 失败的真实原因（避免把 403 误报成「没找到」）。 */
    /**
     * 检查更新失败的三类原因 —— 用户该做的事完全不同，不能都报"没找到 Release"。
     *
     * 历史：`debug.34`（D2）修的是「匿名 API 限流 403 被误报成没找到带清单的 Release」。
     * 但**网络整体不通**仍会落进同一句话，用户会以为是发布缺资产、去翻 Release 页 ——
     * 方向完全错。见 `docs/plan/pa-pb-plan.md` §V7。
     */
    internal enum class ReleaseFailKind(val label: String) {
        NETWORK("网络层失败"),
        NO_MANIFEST("Release 里没有运行时清单"),
        PARSE("响应解析失败"),
    }

    /** 最近一次检查失败的分类，`null` 表示没失败过。 */
    /**
     * 块下载的并发度（A-2）。
     *
     * 全量 143.5 MB = 2296 个 64 KiB 块；串行时每次请求要建连 + 302 + Range，
     * 真机实测只有 **≈87 KB/s ⇒ 27 分钟**（见 `pa-pb-plan.md` §A0）。
     * 6 与 Operit 的 `DOWNLOAD_THREAD_COUNT` 一致；再高在移动网络下会被限速。
     */
    private const val FETCH_THREADS = 6

    /**
     * 只有块数 ≥ 这个值才开并行。
     *
     * 增量常态只下几块（几十 KB），为它起 6 个线程 + 6 条 HTTP 连接纯属浪费，
     * 反而比串行慢。见 `pa-pb-plan.md` §A-R8。
     */
    private const val PARALLEL_MIN_CHUNKS = 32

    /** 进度上报节流间隔（并行时 6 线程会疯狂更新 message）。 */
    private const val PROGRESS_MIN_INTERVAL_MS = 200L

    /**
     * 最近一次选路结果（A-1 的 `GithubMirrors.pick`）。
     * `base == null` = 走直连，行为与改动前完全一致。
     */
    @Volatile private var downloadBase: String? = null
    @Volatile private var downloadVia: String = "direct"

    private var lastReleaseKind: ReleaseFailKind? = null
    private var lastReleaseError: String? = null

    private fun failRelease(kind: ReleaseFailKind, detail: String): RuntimeRelease? {
        lastReleaseKind = kind
        lastReleaseError = kind.label + "：" + detail
        return null
    }

    /**
     * 最近一次检查失败的种类（`null` = 没失败过）。
     *
     * 存在的意义：UI 可以据此决定"要不要引导用户检查网络"（NETWORK）而不是
     * "去 Release 页看看是不是发布缺资产"（NO_MANIFEST）。
     */
    val lastFailureKind: String? get() = lastReleaseKind?.name

    /** 给 UI/诊断用的完整失败描述（含分类前缀）；成功时为 `null`。 */
    val lastFailureMessage: String? get() = lastReleaseError

    /** 在最近的 Release 里找 `runtime-chunks.json`（手动发布的最新一版）。
     *
     * **不调 GitHub API**：匿名 REST 配额只有 60 次/小时/出口 IP（全网共享），
     * 打空时 Releases 列表返回 403，旧实现会把它误报成「没找到这样的 Release」。
     * 现在改走 `releases.atom`（无认证、不严格限流）取 tag，再按固定前缀拼资产 URL：
     *
     * ```
     * https://github.com/<repo>/releases/download/<TAG>/runtime-chunks.json
     * https://github.com/<repo>/releases/download/<TAG>/manifest.json
     * https://github.com/<repo>/releases/download/<TAG>/<分片名>   ← 分片名来自清单 files.keys
     * ```
     *
     * 取前 5 个 tag 逐个探测（可跳过只挂了 APK 的版本），首个成功即返回。
     */
    private fun latestRuntimeRelease(): RuntimeRelease? {
        lastReleaseError = null
        lastReleaseKind = null
        try {
            val atom = httpGetWithMirrors("https://github.com/$REPO/releases.atom")
                ?: return failRelease(
                    ReleaseFailKind.NETWORK,
                    "读取 releases.atom 失败（超时 / 连接被拒 / 被拦截）—— 与「发布缺资产」无关",
                )
            val tags = Regex("""/releases/tag/([^"<\s]+)""").findAll(atom)
                .map { it.groupValues[1] }
                .distinct()
                .take(5)
                .toList()
            if (tags.isEmpty()) {
                return failRelease(ReleaseFailKind.PARSE, "releases.atom 能取到，但里面解析不出任何 tag")
            }
            // 沿途记下每个 tag 的失败原因，最后拼成一句人能看懂的
            val misses = ArrayList<String>()
            for (tag in tags) {
                val base = "https://github.com/$REPO/releases/download/$tag/"
                // ⚠️ 必须走镜像。这里原来直接 `httpGet` ⇒ 直连 `github.com/.../releases/download/...`，
                // 而真机实测**直连分片根本不通**（000 / 25s 超时），于是 5 个 tag 全部"下载失败"，
                // 报出来的却是「Release 里没有运行时清单」—— 把网络问题误导成发布缺资产。
                // 2026-11-25 真机：atom 走 GhProxyCom 成功，紧接着 5 个 tag 的 chunks 全失败 = 这个 bug。
                val txt = httpGetWithMirrors(base + CHUNKS_NAME)
                if (txt == null) {
                    misses += "$tag（下载失败）"
                    continue
                }
                if (!txt.contains("\"runtimeVersion\"")) {
                    misses += "$tag（清单里没有 runtimeVersion）"
                    continue
                }
                return RuntimeRelease(
                    tag = tag,
                    chunksUrl = base + CHUNKS_NAME,
                    manifestUrl = base + "manifest.json",
                    assets = emptyMap(),
                    baseUrl = base,
                    chunksText = txt,
                )
            }
            // 网络是通的（atom 拿到了），只是这 5 个 tag 都没有清单 ⇒ 这才是"发布缺资产"
            return failRelease(
                ReleaseFailKind.NO_MANIFEST,
                "最近 ${tags.size} 个 tag（${tags.joinToString(", ")}）都没有可用的 $CHUNKS_NAME；明细：${misses.joinToString("；")}",
            )
        } catch (t: Throwable) {
            return failRelease(ReleaseFailKind.NETWORK, t.message ?: t.toString())
        }
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

    /**
     * 小文件的取回：**先直连，失败再按镜像表顺序试**（E1 的结论）。
     *
     * 为什么不能"测速选最快"：`runtime-chunks.json` / `manifest.json` 本身就在
     * `/releases/download/` 下，直连不通时**连"要下什么"都拿不到** —— 此时还没有
     * 任何速度可比。所以这里用「顺序试 + 短超时」，拿到就返回。
     *
     * 只试前 6 条：小文件几十 KB，试太多反而慢；剩下 10 条留给分片下载的测速阶段。
     */
    private fun httpGetWithMirrors(url: String): String? {
        httpGet(url)?.let { return it }
        // 两类 URL 走不同候选表：
        //  · `/releases/download/*`（清单 / manifest / 分片）→ [GithubMirrors.mirrored]
        //  · 其它（`releases.atom`）→ [GithubMirrors.atomUrls]，只试**实测能转普通 URL** 的那条
        //    ⚠️ atom 是整条更新链的**入口**：拿不到 tag 就拿不到任何下载 URL，
        //       选路根本没机会跑。2026-11-25 实测 5 条可用镜像里只有 gh-proxy.com 能转 atom。
        val isDownload = url.contains("/releases/download/")
        val candidates = if (isDownload) {
            GithubMirrors.mirrored(url).entries.take(6)
        } else {
            GithubMirrors.atomUrls(url).entries
        }
        if (candidates.isEmpty()) return null
        for ((name, mirrored) in candidates) {
            val txt = httpGet(mirrored)
            if (txt != null && txt.isNotEmpty()) {
                Log.i(TAG, "小文件走镜像 $name：${url.substringAfterLast('/')}")
                return txt
            }
        }
        return null
    }

    private fun httpGet(url: String): String? = runCatching {
        val c = URL(url).openConnection() as HttpURLConnection
        // ⚠️ 6 秒而不是 15 秒：2026-11-25 真机实测，当前网络下直连 github.com
        //    的 `releases.atom` 拉到 25 秒仍 `size=0`（等于不通），而镜像只要 **1.2 秒**。
        //    把直连超时压短 ⇒ 快速失败、立刻交给镜像，总耗时从"15s 白等"变成"6s+1.2s"。
        //    海外/网络好的用户 6 秒内就成功了，不受影响。
        c.connectTimeout = 6000
        c.readTimeout = 20000
        c.setRequestProperty("User-Agent", "dsh-android")
        c.setRequestProperty("Accept", "*/*")
        try {
            if (c.responseCode !in 200..299) return@runCatching null
            c.inputStream.bufferedReader().use { it.readText() }
        } finally {
            c.disconnect()
        }
    }.getOrNull()

    /**
     * 取一个字节区间（GitHub Release 资产支持 Range：302 后裸下载即可，不带鉴权头）。
     *
     * @param base 选中的镜像前缀；非空时把 url 改写成「镜像 + 原 URL」。
     *             镜像**必须真的支持 Range**（探测阶段已验 206），否则下面的
     *             `code == 200` 分支会退化成"每块重下前缀"，2296 个块就是 O(n²)。
     */
    private fun downloadRange(url: String, off: Long, len: Long, base: String? = null): ByteArray? = runCatching {
        val target = GithubMirrors.rewriteOne(base, url)
        val c = URL(target).openConnection() as HttpURLConnection
        // connect 8s：选中线路大概率正常，8 秒连不上就是这条线路坏了，快速失败好让上层换
        // read 60s：64 KiB 的块就算镜像慢也读得完；原来是 30s，对慢镜像偏紧
        c.connectTimeout = 8000
        c.readTimeout = 60000
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

/**
 * A4-#6：分块增量判定（纯函数，不碰 JSON/网络，便于 JVM 单测）。
 *
 * @param local 本地基线按同一 chunkSize 算出的块 hash；`null` 表示没有“同长度基线” ⇒ 全量。
 * @param remote 远端清单里的块 hash（顺序即块号）。
 * @return 需要重新下载的块号（升序）；空表示整文件可复用。
 */
internal fun changedChunkIndexes(local: List<String>?, remote: List<String>): List<Int> {
    if (local == null) return remote.indices.toList()
    val out = ArrayList<Int>()
    for (i in remote.indices) {
        if (i >= local.size || local[i] != remote[i]) out.add(i)
    }
    return out
}
