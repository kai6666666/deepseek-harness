package com.dsh.android.runtime

import com.dsh.android.log.DshLog as Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * GitHub Release 数据的「异步 + 缓存 + 退避 + 兜底」包装（「关于」页的检查更新与更新日志共用）。
 *
 * 为什么是异步：JS 桥是**同步调用**，在 WebView 的 JS 线程上等网络会直接卡住界面。
 * 页面每 500ms 轮询 [get]。
 *
 * 0.2.2-rc.5 起修掉三类真实问题（真机日志实测 `HTTP 403 / X-RateLimit-Remaining: 0`）：
 * 1. **失败无退避**：旧版只缓存成功结果，403 之后每次轮询（500ms）都重新发起请求，
 *    一个用户几分钟就能把 GitHub 匿名额度（60 次/小时/IP）烧光。
 * 2. **无持久化**：进程一重启数据就空，冷启动必然再打一次 API。
 * 3. **无兜底**：API 403 后页面什么都没有。
 *
 * 现在的策略：
 * - ETag 条件请求（304 不计额度）+ 成功结果落盘（`files/release-feed-cache.json`）；
 * - 失败指数退避，并把 `X-RateLimit-Reset` 当作最早重试时刻；
 * - 有旧数据时先返回旧数据（`stale=true`），页面照常渲染；
 * - API 不可用时改拉 `releases.atom`（Atom 不走 REST 限额）。
 */
object ReleaseFeed {
    private const val TAG = "ReleaseFeed"
    private const val REPO = "kai6666666/deepseek-harness"
    private const val API = "https://api.github.com/repos/$REPO/releases?per_page=20"
    private const val ATOM = "https://github.com/$REPO/releases.atom"

    /** 成功结果的保鲜期。 */
    private const val TTL_MS = 10 * 60 * 1000L
    /** 失败后的最小 / 最大重试间隔。 */
    private const val MIN_RETRY_MS = 60 * 1000L
    private const val MAX_RETRY_MS = 30 * 60 * 1000L

    @Volatile private var data: String? = null
    @Volatile private var fetchedAt = 0L
    @Volatile private var etag: String? = null
    @Volatile private var source: String = "api"
    @Volatile private var nextTryAt = 0L
    @Volatile private var error: String? = null
    @Volatile private var loading = false
    @Volatile private var cacheFile: File? = null
    private var failures = 0

    /** 取 `filesDir` 做落盘缓存；可重复调用。 */
    fun init(filesDir: File) {
        if (cacheFile != null) return
        synchronized(this) {
            if (cacheFile != null) return
            val f = File(filesDir, "release-feed-cache.json")
            cacheFile = f
            loadFromDisk(f)
        }
    }

    private fun loadFromDisk(f: File) {
        runCatching {
            if (!f.isFile || f.length() <= 0L) return@runCatching
            val o = JSONObject(f.readText())
            val arr = o.optJSONArray("data") ?: return@runCatching
            data = arr.toString()
            fetchedAt = o.optLong("fetchedAt", 0L)
            etag = o.optString("etag").takeIf { it.isNotEmpty() && it != "null" }
            source = o.optString("source", "api")
            Log.i(TAG, "Release 缓存已载入：" + arr.length() + " 条 · " + source)
        }
    }

    private fun saveToDisk() {
        val f = cacheFile ?: return
        runCatching {
            val o = JSONObject()
                .put("data", JSONArray(data ?: "[]"))
                .put("fetchedAt", fetchedAt)
                .put("etag", etag ?: JSONObject.NULL)
                .put("source", source)
            f.writeText(o.toString())
        }
    }

    /** 给页面的 JSON：`{ready, data?, error?, stale?, retryIn?}` */
    fun get(): String {
        val now = System.currentTimeMillis()
        val cached = data

        if (cached != null && now - fetchedAt < TTL_MS) {
            return payload(cached, stale = false)
        }

        // 退避窗口内：有旧数据就给旧数据，绝不发请求（这是烧额度的那条路）。
        if (now < nextTryAt) {
            return if (cached != null) payload(cached, stale = true)
            else runCatching {
                JSONObject().apply {
                    put("ready", false)
                    error?.let { put("error", it) }
                    put("retryIn", (nextTryAt - now) / 1000)
                }.toString()
            }.getOrElse { "{\"ready\":false}" }
        }

        if (!loading) {
            loading = true
            Thread { fetch() }.apply { isDaemon = true; name = "release-feed" }.start()
        }
        return if (cached != null) payload(cached, stale = true) else runCatching {
            JSONObject().apply {
                put("ready", false)
                error?.let { put("error", it) }
            }.toString()
        }.getOrElse { "{\"ready\":false}" }
    }

    private fun payload(json: String, stale: Boolean): String = runCatching {
        JSONObject().apply {
            put("ready", true)
            put("data", JSONArray(json))
            if (stale) put("stale", true)
            put("source", source)
            error?.let { if (stale) put("error", it) }
        }.toString()
    }.getOrElse { "{\"ready\":true,\"data\":[]}" }

    /** 强制下次 [get] 重新拉（用户点「检查更新」）。 */
    fun invalidate() {
        fetchedAt = 0L
        nextTryAt = 0L
        failures = 0
    }

    private fun backoff(now: Long, rateLimitedResetSec: Long?) {
        failures += 1
        val exp = MIN_RETRY_MS shl (failures - 1).coerceIn(0, 5)
        var wait = exp.coerceAtMost(MAX_RETRY_MS)
        if (rateLimitedResetSec != null && rateLimitedResetSec > 0L) {
            val untilReset = rateLimitedResetSec * 1000L - now + 5_000L
            if (untilReset > wait) wait = untilReset.coerceAtMost(MAX_RETRY_MS)
        }
        nextTryAt = now + wait
    }

    private fun fetch() {
        try {
            tryApi()
        } catch (t: Throwable) {
            error = t.message ?: t.toString()
            Log.w(TAG, "Release API 拉取失败：" + error)
            // API 挂了（403 限额 / 网络 / DNS）→ 用 Atom 兜底，至少让「更新日志」有内容。
            try {
                if (fetchAtom()) {
                    error = null
                    Log.i(TAG, "Release 已由 Atom 兜底：" + (data?.length ?: 0) + " 字节")
                }
            } catch (e: Throwable) {
                Log.w(TAG, "Release Atom 兜底也失败：" + (e.message ?: e.toString()))
            }
        } finally {
            loading = false
        }
    }

    private fun tryApi() {
        var conn: HttpURLConnection? = null
        var resetSec: Long? = null
        try {
            conn = (URL(API).openConnection() as HttpURLConnection).apply {
                connectTimeout = 8000
                readTimeout = 12000
                setRequestProperty("User-Agent", "dsh-android/about")
                setRequestProperty("Accept", "application/vnd.github+json")
                etag?.let { setRequestProperty("If-None-Match", it) }
            }
            val code = conn.responseCode
            resetSec = conn.getHeaderField("X-RateLimit-Reset")?.trim()?.toLongOrNull()
            when (code) {
                304 -> {
                    fetchedAt = System.currentTimeMillis()
                    failures = 0
                    nextTryAt = 0L
                    saveToDisk()
                    Log.i(TAG, "Release 未变化（304，不耗额度）")
                    return
                }
                200 -> {
                    val txt = conn.inputStream.bufferedReader().use { it.readText() }
                    val slim = slimFromApi(JSONArray(txt))
                    data = slim.toString()
                    source = "api"
                    fetchedAt = System.currentTimeMillis()
                    failures = 0
                    nextTryAt = 0L
                    etag = conn.getHeaderField("ETag")
                    saveToDisk()
                    Log.i(TAG, "Release 已拉取：" + slim.length() + " 条")
                    return
                }
            }
            val remaining = conn.getHeaderField("X-RateLimit-Remaining")
            throw IllegalStateException("HTTP $code" + if (remaining != null) " (remaining=$remaining)" else "")
        } catch (t: Throwable) {
            backoff(System.currentTimeMillis(), resetSec)
            throw t
        } finally {
            runCatching { conn?.disconnect() }
        }
    }

    private fun slimFromApi(arr: JSONArray): JSONArray {
        val slim = JSONArray()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val s = JSONObject()
            s.put("tag", o.optString("tag_name"))
            s.put("name", o.optString("name"))
            s.put("date", o.optString("published_at").take(10))
            s.put("prerelease", o.optBoolean("prerelease"))
            s.put("notes", o.optString("body"))
            s.put("page", o.optString("html_url"))
            var apk: JSONObject? = null
            var plugin: JSONObject? = null
            val assets = o.optJSONArray("assets")
            if (assets != null) {
                for (j in 0 until assets.length()) {
                    val a = assets.optJSONObject(j) ?: continue
                    val n = a.optString("name")
                    val item = JSONObject()
                        .put("name", n)
                        .put("url", a.optString("browser_download_url"))
                        .put("bytes", a.optLong("size"))
                    if (n.endsWith(".apk")) apk = item
                    else if (n.startsWith("plugins-mobile-ui-") && n.endsWith(".zip")) plugin = item
                }
            }
            s.put("apk", apk ?: JSONObject.NULL)
            s.put("plugin", plugin ?: JSONObject.NULL)
            slim.put(s)
        }
        return slim
    }

    /**
     * Atom 兜底：`<entry>` 里取 tag / 标题 / 更新时间 / 链接。
     * 不带资产信息（Atom 本来就没有），页面会把「下载」按钮藏起来，属预期。
     */
    private fun fetchAtom(): Boolean {
        var conn: HttpURLConnection? = null
        try {
            conn = (URL(ATOM).openConnection() as HttpURLConnection).apply {
                connectTimeout = 8000
                readTimeout = 12000
                setRequestProperty("User-Agent", "dsh-android/about")
                setRequestProperty("Accept", "application/atom+xml")
            }
            if (conn.responseCode !in 200..299) return false
            val xml = conn.inputStream.bufferedReader().use { it.readText() }
            val slim = JSONArray()
            for (chunk in xml.split("<entry>")) {
                if (!chunk.contains("</entry>")) continue
                val id = tag(chunk, "id")
                val tagName = id.substringAfterLast("/", "")
                val title = tag(chunk, "title")
                val updated = tag(chunk, "updated").take(10)
                val link = Regex("<link[^>]*href=\"([^\"]+)\"").find(chunk)?.groupValues?.get(1) ?: ""
                if (tagName.isEmpty()) continue
                val s = JSONObject()
                s.put("tag", tagName)
                s.put("name", title.ifEmpty { tagName })
                s.put("date", updated)
                s.put("prerelease", tagName.contains("-"))
                s.put("notes", "")
                s.put("page", link)
                s.put("apk", JSONObject.NULL)
                s.put("plugin", JSONObject.NULL)
                if (slim.length() < 20) slim.put(s)
            }
            if (slim.length() == 0) return false
            data = slim.toString()
            source = "atom"
            fetchedAt = System.currentTimeMillis()
            saveToDisk()
            return true
        } finally {
            runCatching { conn?.disconnect() }
        }
    }

    private fun tag(xml: String, name: String): String =
        Regex("<$name>([\\s\\S]*?)</$name>").find(xml)?.groupValues?.get(1)?.trim() ?: ""
}
