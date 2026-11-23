package com.dsh.android.runtime

import com.dsh.android.log.DshLog as Log
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * GitHub Release 数据的「异步 + 缓存」包装（「关于」页的检查更新与更新日志共用）。
 *
 * 为什么是异步：JS 桥是**同步调用**，在 WebView 的 JS 线程上等网络会直接卡住界面。
 * 页面每 500ms 轮询 [get]：`ready=false` 就继续等，`ready=true` 拿数据。
 * 缓存 10 分钟：GitHub 未登录限流 60 次/小时，一个用户反复点检查更新不该把额度烧光。
 */
object ReleaseFeed {
    private const val TAG = "ReleaseFeed"
    private const val REPO = "kai6666666/deepseek-harness"
    private const val API = "https://api.github.com/repos/$REPO/releases?per_page=20"
    private const val TTL_MS = 10 * 60 * 1000L

    @Volatile private var data: String? = null
    @Volatile private var fetchedAt: Long = 0L
    @Volatile private var error: String? = null
    @Volatile private var loading: Boolean = false

    /** 给页面的 JSON：`{ready, data?:[...], error?}` */
    fun get(): String {
        val now = System.currentTimeMillis()
        val cached = data
        if (cached != null && now - fetchedAt < TTL_MS) {
            return runCatching {
                JSONObject().put("ready", true).put("data", JSONArray(cached)).toString()
            }.getOrElse { "{\"ready\":true,\"data\":[]}" }
        }
        if (!loading) {
            error = null
            loading = true
            Thread { fetch() }.apply { isDaemon = true; name = "release-feed" }.start()
        }
        val e = error
        return runCatching {
            JSONObject().apply {
                put("ready", false)
                if (e != null) put("error", e)
            }.toString()
        }.getOrElse { "{\"ready\":false}" }
    }

    /** 强制下次 [get] 重新拉。 */
    fun invalidate() {
        fetchedAt = 0L
    }

    private fun fetch() {
        var conn: HttpURLConnection? = null
        try {
            conn = (URL(API).openConnection() as HttpURLConnection).apply {
                connectTimeout = 8000
                readTimeout = 12000
                setRequestProperty("User-Agent", "dsh-android/about")
                setRequestProperty("Accept", "application/vnd.github+json")
            }
            val code = conn.responseCode
            if (code !in 200..299) throw IllegalStateException("HTTP $code")
            val txt = conn.inputStream.bufferedReader().use { it.readText() }
            val arr = JSONArray(txt)
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
                val assets = o.optJSONArray("assets")
                var apk: JSONObject? = null
                var plugin: JSONObject? = null
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
            data = slim.toString()
            fetchedAt = System.currentTimeMillis()
            Log.i(TAG, "Release 已拉取：" + slim.length() + " 条")
        } catch (t: Throwable) {
            error = t.message ?: t.toString()
            Log.w(TAG, "Release 拉取失败：" + error)
        } finally {
            loading = false
            runCatching { conn?.disconnect() }
        }
    }
}
