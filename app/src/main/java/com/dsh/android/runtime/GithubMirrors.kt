package com.dsh.android.runtime

import com.dsh.android.log.DshLog as Log
import java.net.HttpURLConnection
import java.net.URL
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * GitHub Release 下载的多线路选择（A-1）。
 *
 * ## 为什么需要
 *
 * `RuntimeDelta` 原来只有一个 URL：`https://github.com/<repo>/releases/download/<TAG>/<name>`。
 * 国内直连这条经常超时/中断 —— 真机实测全量 143.5 MB 只有 **≈87 KB/s**（2296 次串行请求），
 * 折合 **27 分钟**。多线路解决"下得动"，并行（A-2）解决"下得快"。
 *
 * ## 设计要点（每条都对应一次踩坑或审出来的风险）
 *
 * 1. **只对 `github.com` + `/releases/download/` 生效**。`api.github.com` 与
 *    `releases.atom` 不走镜像 —— 前缀式代理不转 API，硬塞 100% 失败。
 * 2. **两段式探测，流量上限 192 KB**。Operit 那套是 `34 × 256 KB = 8.5 MB`，
 *    移动网络下是负优化：
 *    - 第一段：全部并发发 `Range: bytes=0-0`（**每条约 1 字节**），验 206 + 拿 `Content-Range` 总长
 *    - 第二段：只对存活里按 RTT 排序的**前 3 个**做 64 KB 速测 ⇒ 3 × 64 KB = 192 KB
 * 3. **必须验证 Range 真的可用**。很多代理接受 `Range` 头却返回 **200 全文**；
 *    而 `RuntimeDelta.downloadRange` 在 `200` 时会"自己跳过前缀"（off 可达几十 MB），
 *    2296 个块 × 每块重下前缀 = **O(n²) 流量灾难**。⇒ 探测就要求**响应码 206**。
 * 4. **不用 HEAD**：不少代理对 HEAD 回 405/501，或不返 `Accept-Ranges`。
 *    直接 `GET + Range: bytes=0-0`，一次拿到「206 与否 / 真实大小 / RTT」。
 * 5. **并发上限 8**：全部并发会被代理方限速甚至判定滥用。
 * 6. **直连优先**：直连探测成功且 ≥512 KiB/s 就直接用直连，**不碰镜像**
 *    （海外/科学上网用户不该为这个功能付任何额外延迟）。
 * 7. **全灭回退直连**：选路失败不是错误，行为与改动前完全一致。
 * 8. **缓存只在内存**（TTL 30 分钟）：镜像可用性变化快，落盘的过期结果比没有更糟。
 *
 * ## 可测性
 *
 * 网络调用全部通过 `probe` 注入（默认 [defaultProbe]），单测用假实现、**不碰真网络**，
 * 这样才能进 `apk.yml` 的单测门禁。
 */
internal object GithubMirrors {

    /**
     * 镜像表。**顺序 = 默认优先级**（同优先级时按它挑）。
     *
     * ⚠️ 候选来自 Operit 的 34 条里 2026 年仍在服务的那批，但**没有逐条真机实测**过
     * （见 `pa-pb-plan.md` §A5）。探测会自动淘汰失效的；表可以在实测后裁剪。
     */
    /**
     * 镜像表（**2026-11-25 真机实测后裁剪**，16 条候选里只剩 5 条可用）。
     *
     * 实测方法：设备上 `curl` 逐条打「atom（普通 URL）」+「分片（/releases/download/）」
     * +「Range: bytes=0-1023」三项，判据是 **206** 且**字节数精确**（1888）。
     *
     * | 镜像 | atom | 分片 | Range |
     * |---|---|---|---|
     * | GhProxyCom (gh-proxy.com) | **200 / 1.2s / 9316B** | 200 / 1.2s / 1888B | **206** |
     * | GhProxyNet (ghproxy.net) | 403 | 200 / 1.2s / 1888B | 206 |
     * | GhProxyCfd (ghproxy.cfd) | 000 | **200 但 22474B（HTML）+ range=200** | ✗ 淘汰 |
     * | Ghfast (ghfast.top) | 403 | 200 / 1.3s / 1888B | 206 |
     * | BokiMoe / Monlor | 404 | 200 / 1.4s / 1888B | 206 |
     * | 其余 9 条 | 全 000 / 429 / 裸 302 | — | ✗ 淘汰 |
     *
     * ⚠️ `ghproxy.cfd` 那行是最值得记的：它**接受 Range 头却返回 200 全文**
     * （还给了 22474 字节的 HTML 错误页）。如果让它通过，`downloadRange` 会走
     * "跳过前缀"分支 —— 2296 个块 × 每块重下前缀 = O(n²) 流量。所以判据必须是 206。
     *
     * 顺序 = 实测延迟升序（GhProxyCom 1.22s 最快）。
     */
    private val MIRRORS: LinkedHashMap<String, String> = linkedMapOf(
        "GhProxyCom" to "https://gh-proxy.com/",
        "GhProxyNet" to "https://ghproxy.net/",
        "Ghfast" to "https://ghfast.top/",
        "BokiMoe" to "https://github.boki.moe/",
        "Monlor" to "https://gh.monlor.com/",
    )

    /**
     * **能转普通 URL（`releases.atom`）的镜像** —— 单独一张小表。
     *
     * 为什么必须分开：实测 5 条可用镜像里，**只有 `gh-proxy.com` 能转 atom**
     * （其余对 atom 回 403 / 404）。而 atom 是整条更新链的入口：拿不到 tag
     * 就拿不到任何 `/releases/download/` 的 URL，选路根本没机会跑。
     *
     * 所以 atom 不能用"整表顺序试"，只能试**实测能转的那条**，避免白等 4 次超时。
     */
    private val ATOM_MIRRORS: LinkedHashMap<String, String> = linkedMapOf(
        "GhProxyCom" to "https://gh-proxy.com/",
    )

    /** 直连"足够快"的阈值：达到就跳过镜像全测。 */
    private const val DIRECT_GOOD_BPS = 512L * 1024L

    /** 探测并发上限。 */
    private const val PROBE_CONCURRENCY = 8

    /** 速测采样大小。 */
    private const val SPEED_SAMPLE_BYTES = 64L * 1024L

    /** 最多给几条线路做真速测（控制探测总流量：3 × 64 KB = 192 KB）。 */
    private const val SPEED_TEST_COUNT = 3

    /** 选路缓存时长。 */
    private const val CACHE_TTL_MS = 30L * 60 * 1000

    /**
     * 单条线路的探测结果。
     *
     * @param bytes 文件总长（来自 `Content-Range: bytes 0-0/TOTAL`），未知为 -1
     */
    data class Probe(
        val name: String,
        val url: String,
        val ok: Boolean = false,
        val bytes: Long = -1L,
        val ranges: Boolean = false,
        val rttMs: Long = -1L,
        val bytesPerSec: Long = -1L,
        val error: String? = null,
    )

    /** 选路结果：`base == null` 表示用直连（行为与改动前完全一致）。 */
    data class Choice(
        val base: String?,
        val name: String,
        val bytesPerSec: Long = -1L,
        val degraded: Boolean = false,
    ) {
        val via: String get() = if (base == null) "direct" else "mirror:$name"
    }

    // 进程内缓存（不落盘）
    @Volatile private var cached: Choice? = null
    @Volatile private var cachedAt = 0L
    @Volatile private var cachedFor: String? = null

    /** 清缓存（测试用，也给"用户手动重试"留口子）。 */
    fun clearCache() {
        cached = null
        cachedAt = 0L
        cachedFor = null
    }

    /** 镜像表大小（日志/诊断用）。 */
    val mirrorCount: Int get() = MIRRORS.size

    /** 能转普通 URL 的镜像数（实测=1；诊断用）。 */
    val atomMirrorCount: Int get() = ATOM_MIRRORS.size

    /**
     * 生成镜像候选。只对 `github.com` + `/releases/download/` 生效。
     *
     * 拼接用 `prefix.trimEnd('/') + "/" + url`：表里若有人写了尾斜杠，直接拼会变成
     * `https://x//https://github.com/...`，部分代理回 400。
     */
    fun mirrored(url: String): Map<String, String> {
        if (!url.contains("github.com") || !url.contains("/releases/download/")) return emptyMap()
        val out = LinkedHashMap<String, String>(MIRRORS.size)
        for ((name, prefix) in MIRRORS) {
            out[name] = prefix.trimEnd('/') + "/" + url
        }
        return out
    }

    /**
     * atom 这类**普通 URL** 的镜像候选（与 [mirrored] 分开：后者只认
     * `/releases/download/`，而 atom 的路径是 `/releases/atom`）。
     *
     * 只返回实测能转普通 URL 的镜像（当前 = GhProxyCom）。空表 ⇒ 调用方退回直连。
     */
    fun atomUrls(url: String): Map<String, String> {
        if (!url.contains("github.com")) return emptyMap()
        val out = LinkedHashMap<String, String>(ATOM_MIRRORS.size)
        for ((name, prefix) in ATOM_MIRRORS) {
            out[name] = prefix.trimEnd('/') + "/" + url
        }
        return out
    }

    /** 把 `base` 与原始 url 拼起来；`base` 为 null 时原样返回。 */
    fun rewriteOne(base: String?, url: String): String =
        if (base == null) url else base.trimEnd('/') + "/" + url

    // ── 选路 ────────────────────────────────────────────────

    /**
     * 一次选路。
     *
     * @param expectedUrl 任一 `/releases/download/` 下的真实 URL（分片或清单都行）
     * @param expectBytes 期望字节数；**-1 表示不知道**（第一次拉清单时就是这种情况）
     * @param probe       探测实现（可注入；签名见 [defaultProbe]）
     */
    fun pick(
        expectedUrl: String,
        expectBytes: Long = -1L,
        budgetMs: Int = 2500,
        probe: (String, String, Long, Int, Long) -> Probe = ::defaultProbe,
    ): Choice {
        val now = System.currentTimeMillis()

        // ① 缓存：命中且复探仍可用就直接用（只探 1 条，不再全表）
        val cachedChoice = readCache(expectedUrl, now)
        if (cachedChoice != null) {
            if (cachedChoice.base == null) {
                logI( "mirror.pick 缓存=直连（${now - cachedAt}ms 前测过）")
                return cachedChoice
            }
            val p = probe("cached", rewriteOne(cachedChoice.base, expectedUrl), expectBytes, budgetMs, 0L)
            if (p.ok && p.ranges) {
                logI( "mirror.pick 缓存命中 ${cachedChoice.name}（rtt=${p.rttMs}ms）")
                return cachedChoice
            }
            logW( "mirror.pick 缓存线路 ${cachedChoice.name} 已失效，重新全测")
            clearCache()
        }

        // ② 直连优先：先 1 字节探活，通了再补一次 64 KB 速测
        //    ⚠️ 不能拿探活结果判速度：sampleBytes=0 时 bytesPerSec 是 -1，
        //       直接比阈值会让"达标就跳过镜像"这条分支**永不生效**。
        val directHead = probe("direct", expectedUrl, expectBytes, budgetMs, 0L)
        if (directHead.ok && directHead.ranges) {
            val directSpeed = probe("direct", expectedUrl, expectBytes, budgetMs, SPEED_SAMPLE_BYTES)
            if (directSpeed.ok && directSpeed.bytesPerSec >= DIRECT_GOOD_BPS) {
                val c = Choice(base = null, name = "direct", bytesPerSec = directSpeed.bytesPerSec)
                saveCache(expectedUrl, c, now)
                logI("mirror.pick 直连达标 ${directSpeed.bytesPerSec / 1024} KB/s，跳过镜像")
                return c
            }
            logI("mirror.pick 直连可用但未达阈值（${directSpeed.bytesPerSec / 1024} KB/s），开始比镜像")
        } else {
            logW( "mirror.pick 直连不可用（${directHead.error ?: "无 Range"}），转镜像")
        }

        // ③ 第一段：全部并发探 1 字节（验 206 + 拿总长），几乎不耗流量
        val candidates = mirrored(expectedUrl)
        if (candidates.isEmpty()) {
            return Choice(base = null, name = "direct", degraded = true)
        }
        val heads = runConcurrent(candidates.entries.map { it.key to it.value }, expectBytes, budgetMs, probe, 0L)
            .filter { it.ok && it.ranges }
        if (heads.isEmpty()) {
            logW( "mirror.pick ${candidates.size} 条镜像全部不可用（Range 不可用或超时），回退直连")
            val c = Choice(base = null, name = "direct", degraded = true)
            saveCache(expectedUrl, c, now)
            return c
        }

        // ④ 第二段：只给 RTT 最快的前 N 条做 64 KB 真速测（控制总流量）
        val finalists = heads.sortedBy { it.rttMs }.take(SPEED_TEST_COUNT)
        logI( "mirror.pick 探活存活 ${heads.size}/${candidates.size}，速测前 ${finalists.size} 条")
        val speeds = runConcurrent(
            finalists.map { it.name to it.url }, expectBytes, budgetMs, probe, SPEED_SAMPLE_BYTES,
        ).filter { it.ok && it.bytesPerSec > 0 }.sortedByDescending { it.bytesPerSec }

        val best = speeds.firstOrNull()
        if (best == null) {
            logW( "mirror.pick 速测全部失败，回退直连")
            val c = Choice(base = null, name = "direct", degraded = true)
            saveCache(expectedUrl, c, now)
            return c
        }

        // best.url = prefix + expectedUrl ⇒ 反推 base
        val base = best.url.removeSuffix(expectedUrl)
        if (base.isEmpty() || base == best.url) {
            logW( "mirror.pick 无法从 ${best.url} 反推 base，回退直连")
            return Choice(base = null, name = "direct", degraded = true)
        }
        val choice = Choice(base = base, name = best.name, bytesPerSec = best.bytesPerSec)
        saveCache(expectedUrl, choice, now)
        logI( "mirror.pick 选中 ${best.name} ${best.bytesPerSec / 1024} KB/s（rtt=${best.rttMs}ms）")
        return choice
    }

    // ── 探测 ────────────────────────────────────────────────

    /**
     * 探测一条线路。
     *
     * @param sampleBytes 要读多少字节来算吞吐；**0 表示只探活**（`Range: bytes=0-0`，几乎零流量）
     *
     * 判据：响应码**必须 206**。200 说明服务器忽略了 Range —— 那会让
     * `RuntimeDelta.downloadRange` 退回"跳过前缀"模式，2296 个块会变成 O(n²) 流量。
     */
    private fun defaultProbe(
        name: String,
        url: String,
        expectBytes: Long,
        timeoutMs: Int,
        sampleBytes: Long,
    ): Probe {
        val start = System.nanoTime()
        var c: HttpURLConnection? = null
        return try {
            val want = if (sampleBytes > 0L) sampleBytes else 1L
            c = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                instanceFollowRedirects = true
                requestMethod = "GET"
                setRequestProperty("User-Agent", "dsh-android")
                setRequestProperty("Accept", "*/*")
                setRequestProperty("Range", "bytes=0-" + (want - 1))
            }
            val code = c.responseCode
            val rtt = (System.nanoTime() - start) / 1_000_000
            if (code != 206) {
                return Probe(
                    name, url, ok = false, rttMs = rtt,
                    error = if (code == 200) "不支持 Range（返回 200）" else "HTTP $code",
                )
            }
            val cr = c.getHeaderField("Content-Range") ?: ""
            val total = cr.substringAfter('/', "").trim().toLongOrNull() ?: -1L
            if (expectBytes > 0L && total > 0L && total != expectBytes) {
                return Probe(
                    name, url, ok = false, bytes = total, rttMs = rtt,
                    error = "大小不符（期望 $expectBytes，实际 $total）",
                )
            }
            var got = 0L
            if (sampleBytes > 0L) {
                val buf = ByteArray(16 * 1024)
                c.inputStream.use { ins ->
                    while (got < sampleBytes) {
                        val n = ins.read(buf, 0, minOf(buf.size.toLong(), sampleBytes - got).toInt())
                        if (n <= 0) break
                        got += n
                    }
                }
            } else {
                // 只读 1 字节确认流可用，然后断开
                runCatching { c.inputStream.use { it.read() } }
                got = 1L
            }
            val elapsedMs = ((System.nanoTime() - start) / 1_000_000).coerceAtLeast(1L)
            val bps = if (sampleBytes > 0L) got * 1000L / elapsedMs else -1L
            Probe(name, url, ok = true, bytes = total, ranges = true, rttMs = rtt, bytesPerSec = bps)
        } catch (t: Throwable) {
            Probe(name, url, ok = false, error = t.message ?: t.javaClass.simpleName)
        } finally {
            runCatching { c?.disconnect() }
        }
    }

    private fun runConcurrent(
        entries: List<Pair<String, String>>,
        expectBytes: Long,
        timeoutMs: Int,
        probe: (String, String, Long, Int, Long) -> Probe,
        sampleBytes: Long,
    ): List<Probe> {
        if (entries.isEmpty()) return emptyList()
        val pool = Executors.newFixedThreadPool(minOf(PROBE_CONCURRENCY, entries.size))
        val latch = CountDownLatch(entries.size)
        val out = Collections.synchronizedList(ArrayList<Probe>())
        try {
            for ((name, url) in entries) {
                pool.execute {
                    try {
                        out.add(probe(name, url, expectBytes, timeoutMs, sampleBytes))
                    } catch (t: Throwable) {
                        out.add(Probe(name, url, error = t.message))
                    } finally {
                        latch.countDown()
                    }
                }
            }
            latch.await(timeoutMs.toLong() + 1500L, TimeUnit.MILLISECONDS)
        } finally {
            pool.shutdownNow()
        }
        return out.toList()
    }

    // ── 缓存 ────────────────────────────────────────────────

    private fun readCache(url: String, now: Long): Choice? {
        val c = cached ?: return null
        if (cachedFor != url) return null
        if (now - cachedAt > CACHE_TTL_MS) {
            clearCache()
            return null
        }
        return c
    }

    private fun saveCache(url: String, c: Choice, now: Long) {
        cached = c
        cachedAt = now
        cachedFor = url
    }

    private const val TAG = "GithubMirrors"

    /**
     * 日志包一层。
     *
     * `DshLog.i` 最终调 `android.util.Log.i`，而 `RuntimeS6Test` 跑在**纯 JVM**上
     * （没有 Android 运行时）。直接调会在单测里抛 `NoClassDefFoundError`，
     * 让"选路逻辑"这种本该纯逻辑的部分变得不可测。`runCatching` 捕获 `Throwable`
     * （含 `Error`），所以这里既能打日志、又不影响可测性。
     */
    private fun logI(msg: String) {
        runCatching { Log.i(TAG, msg) }
    }

    private fun logW(msg: String) {
        runCatching { Log.w(TAG, msg) }
    }
}
