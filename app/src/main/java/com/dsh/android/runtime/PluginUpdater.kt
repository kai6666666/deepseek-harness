package com.dsh.android.runtime

import com.dsh.android.log.DshLog as Log
import org.json.JSONArray
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * 插件热更新包下载器（P1-b 第二段）。
 *
 * 工作方式：每次启动在**后台线程**查一次 GitHub Release，找出
 * `plugins-mobile-ui-<ver>.zip` 里版本最高的一个；比内置版本新就下载到
 * `files/runtime/plugins/mobile-ui-<ver>.zip`。**本次启动不生效** ——
 * 下一次启动时 [com.dsh.android.EngineManager.ensureMobileUi] 会优先解这个包。
 *
 * 三条铁则：
 * 1. **任何失败都静默**：没网、限流、资产不存在、sha 不符 → 返回 null，不影响启动；
 * 2. **只升级不降级**：版本必须严格大于内置版本，否则旧包永远抢不过新包；
 * 3. **可关**：`files/plugin-update-disabled` 存在就整个跳过（线上出问题时的急救开关）。
 */
object PluginUpdater {
    private const val TAG = "PluginUpdater"
    private const val REPO = "kai6666666/deepseek-harness"
    private const val PREFIX = "plugins-mobile-ui-"
    private const val KEEP_BUNDLES = 2

    /** @return 已就绪的热包版本号（下次启动生效），没有则为 null。 */
    fun checkAndDownload(filesDir: File, bundledVersion: String, timeoutMs: Int = 8000): String? {
        if (File(filesDir, "plugin-update-disabled").isFile) {
            Log.i(TAG, "已关闭（存在 files/plugin-update-disabled）")
            return null
        }
        val body = httpGet("https://api.github.com/repos/$REPO/releases?per_page=8", timeoutMs) ?: return null
        val arr = runCatching { JSONArray(body) }.getOrNull() ?: return null
        var bestVer: String? = null
        var bestUrl: String? = null
        var bestDigest: String? = null
        for (i in 0 until arr.length()) {
            val assets = arr.optJSONObject(i)?.optJSONArray("assets") ?: continue
            for (j in 0 until assets.length()) {
                val a = assets.optJSONObject(j) ?: continue
                val name = a.optString("name")
                if (!name.startsWith(PREFIX) || !name.endsWith(".zip")) continue
                val ver = name.removePrefix(PREFIX).removeSuffix(".zip").trim()
                if (ver.isEmpty()) continue
                if (bestVer == null || cmp(ver, bestVer) > 0) {
                    bestVer = ver
                    bestUrl = a.optString("browser_download_url")
                    bestDigest = a.optString("digest")
                }
            }
        }
        val ver = bestVer
        if (ver == null || bestUrl == null) {
            Log.i(TAG, "Release 里没有 $PREFIX<ver>.zip")
            return null
        }
        if (cmp(ver, bundledVersion) <= 0) {
            Log.i(TAG, "已是最新（release=$ver 内置=$bundledVersion）")
            return null
        }
        val dir = File(filesDir, "runtime/plugins")
        val dst = File(dir, "mobile-ui-$ver.zip")
        if (dst.isFile && dst.length() > 0L) {
            Log.i(TAG, "热包已存在 mobile-ui-$ver.zip")
            return ver
        }
        dir.mkdirs()
        val tmp = File(dir, "mobile-ui-$ver.zip.part")
        tmp.delete()
        if (!download(bestUrl, tmp, timeoutMs)) {
            tmp.delete()
            return null
        }
        val want = bestDigest?.removePrefix("sha256:")?.trim()?.lowercase()
        if (!want.isNullOrEmpty()) {
            val got = sha256(tmp)
            if (got == null || got != want) {
                Log.w(TAG, "sha256 不符，丢弃（got=$got want=$want）")
                tmp.delete()
                return null
            }
        }
        if (!tmp.renameTo(dst)) {
            tmp.delete()
            return null
        }
        // 只留最新的两个，避免长期占用
        dir.listFiles { f -> f.isFile && f.name.startsWith("mobile-ui-") && f.name.endsWith(".zip") }
            ?.sortedByDescending { it.name }
            ?.drop(KEEP_BUNDLES)
            ?.forEach { runCatching { it.delete() } }
        Log.i(TAG, "已就绪 mobile-ui-$ver.zip (${dst.length()} 字节)，下次启动生效")
        return ver
    }

    /** `1.1.0-204` 逐段比较（全数字段按数值，否则按字典序）。 */
    private fun cmp(a: String, b: String): Int {
        val pa = a.split('.', '-', '_')
        val pb = b.split('.', '-', '_')
        for (i in 0 until maxOf(pa.size, pb.size)) {
            val x = pa.getOrNull(i) ?: "0"
            val y = pb.getOrNull(i) ?: "0"
            val nx = x.toIntOrNull()
            val ny = y.toIntOrNull()
            val c = if (nx != null && ny != null) nx.compareTo(ny) else x.compareTo(y)
            if (c != 0) return c
        }
        return 0
    }

    private fun httpGet(url: String, timeoutMs: Int): String? = runCatching {
        val c = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            requestMethod = "GET"
            setRequestProperty("User-Agent", "dsh-android/plugin-updater")
            setRequestProperty("Accept", "application/vnd.github+json")
        }
        try {
            if (c.responseCode !in 200..299) return@runCatching null
            c.inputStream.bufferedReader().use { it.readText() }
        } finally {
            c.disconnect()
        }
    }.getOrNull()

    private fun download(url: String, out: File, timeoutMs: Int): Boolean = runCatching {
        val c = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = timeoutMs
            readTimeout = timeoutMs * 3
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", "dsh-android/plugin-updater")
        }
        try {
            if (c.responseCode !in 200..299) return@runCatching false
            c.inputStream.use { input ->
                out.outputStream().use { input.copyTo(it, 256 * 1024) }
            }
            out.length() > 0L
        } finally {
            c.disconnect()
        }
    }.getOrDefault(false)

    private fun sha256(f: File): String? = runCatching {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { input ->
            val buf = ByteArray(256 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                md.update(buf, 0, n)
            }
        }
        md.digest().joinToString("") { "%02x".format(it.toInt() and 0xFF) }
    }.getOrNull()
}
