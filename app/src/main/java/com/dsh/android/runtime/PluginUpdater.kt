package com.dsh.android.runtime

import com.dsh.android.log.DshLog as Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.zip.ZipFile

/**
 * 移动端 UI 插件热更新（**手动触发**，P1-b）。
 *
 * 三条铁则（都是踩出来的）：
 * 1. **不做自动检查/自动下载**：启动不联网，「检查更新」只由用户点击触发；
 * 2. **只升级不降级**：候选版本必须严格大于当前已装版本（stamp）；
 * 3. **完整性校验不过一律丢弃**：必需文件 `package.json` / `lib/client.js` /
 *    `lib/index.js` / `lib/drawer-fix-170.js` 缺一个就不生效 —— 曾经因为热包里
 *    漏了 `lib/index.js`，插件挂载直接失败、整页回退桌面布局且就绪超时。
 *
 * 急救开关：`files/plugin-update-disabled` 存在则 [checkAsync] 直接返回 false。
 */
object PluginUpdater {
    private const val TAG = "PluginUpdater"
    private const val REPO = "kai6666666/deepseek-harness"
    private const val PREFIX = "plugins-mobile-ui-"
    private const val STAMP = ".mobile_ui_version"
    private const val KEEP_BUNDLES = 2

    /** 缺一个就不算完整包。 */
    private val REQUIRED = listOf(
        "package.json",
        "lib/client.js",
        "lib/index.js",
        "lib/drawer-fix-170.js",
    )

    // ── 状态（页面轮询 stateJson） ──────────────────────────────
    @Volatile private var state: String = "idle" // idle|checking|ready|applying|applied|error
    @Volatile private var message: String = ""
    @Volatile private var availVersion: String? = null
    @Volatile private var availKind: String? = null
    @Volatile private var availBytes: Long = 0L
    @Volatile private var pendingZip: File? = null

    fun stateJson(installedDir: File): String = runCatching {
        val o = JSONObject()
        o.put("state", state)
        o.put("message", message)
        o.put("installed", installedVersion(installedDir))
        val v = availVersion
        if (v != null) {
            o.put("available", JSONObject()
                .put("version", v)
                .put("kind", availKind ?: "full")
                .put("bytes", availBytes))
        }
        o.toString()
    }.getOrElse { "{\"state\":\"error\",\"message\":\"state 序列化失败\"}" }

    fun installedVersion(installedDir: File): String =
        runCatching {
            val f = File(installedDir, STAMP)
            if (f.isFile) f.readText().trim() else ""
        }.getOrDefault("")

    // ── 检查（异步） ────────────────────────────────────────
    fun checkAsync(filesDir: File, installedDir: File): Boolean {
        if (File(filesDir, "plugin-update-disabled").isFile) {
            state = "disabled"
            message = "已关闭（存在 files/plugin-update-disabled）"
            Log.i(TAG, message)
            return false
        }
        if (state == "checking" || state == "applying") return false
        state = "checking"
        message = "正在检查…"
        Thread { runCheck(filesDir, installedDir) }.apply { isDaemon = true; name = "plugin-check" }.start()
        return true
    }

    private fun runCheck(filesDir: File, installedDir: File) {
        try {
            val cur = installedVersion(installedDir)
            val body = httpGet("https://api.github.com/repos/$REPO/releases?per_page=10") ?: throw IllegalStateException("网络请求失败")
            val arr = JSONArray(body)
            var bestVer: String? = null
            var bestUrl: String? = null
            var bestDigest: String? = null
            var bestKind: String? = null
            var bestBytes = 0L
            for (i in 0 until arr.length()) {
                val assets = arr.optJSONObject(i)?.optJSONArray("assets") ?: continue
                for (j in 0 until assets.length()) {
                    val a = assets.optJSONObject(j) ?: continue
                    val n = a.optString("name")
                    if (!n.startsWith(PREFIX) || !n.endsWith(".zip")) continue
                    val parsed = parseAssetName(n) ?: continue
                    val ver = parsed.second
                    if (cur.isNotEmpty() && cmp(ver, cur) <= 0) continue
                    if (bestVer == null || cmp(ver, bestVer) > 0) {
                        bestVer = ver
                        bestKind = parsed.first
                        bestUrl = a.optString("browser_download_url")
                        bestDigest = a.optString("digest")
                        bestBytes = a.optLong("size")
                    }
                }
            }
            val ver = bestVer
            val url = bestUrl
            if (ver == null || url == null) {
                state = "ready"
                message = if (cur.isEmpty()) "已是最新（无可用热更新包）" else "已是最新（当前 $cur）"
                availVersion = null
                Log.i(TAG, message)
                return
            }
            val dir = File(filesDir, "runtime/plugins").apply { mkdirs() }
            val dst = File(dir, "mobile-ui-$ver.zip")
            if (!(dst.isFile && dst.length() > 0L)) {
                val tmp = File(dir, "mobile-ui-$ver.zip.part")
                tmp.delete()
                if (!download(url, tmp)) throw IllegalStateException("下载失败")
                val want = bestDigest?.removePrefix("sha256:")?.trim()?.lowercase()
                if (!want.isNullOrEmpty()) {
                    val got = sha256(tmp)
                    if (got == null || got != want) {
                        tmp.delete()
                        throw IllegalStateException("sha256 不符")
                    }
                }
                if (!tmp.renameTo(dst)) {
                    tmp.delete()
                    throw IllegalStateException("落盘失败")
                }
            }
            dir.listFiles { f -> f.isFile && f.name.startsWith("mobile-ui-") && f.name.endsWith(".zip") }
                ?.sortedByDescending { it.name }?.drop(KEEP_BUNDLES)?.forEach { runCatching { it.delete() } }
            availVersion = ver
            availKind = bestKind ?: "full"
            availBytes = if (bestBytes > 0) bestBytes else dst.length()
            pendingZip = dst
            state = "ready"
            message = "发现 $ver（$availKind，$availBytes 字节）"
            Log.i(TAG, message + " src=" + dst.name)
        } catch (t: Throwable) {
            state = "error"
            message = t.message ?: t.toString()
            Log.w(TAG, "检查失败：" + message)
        }
    }

    // ── 应用（异步） ────────────────────────────────────────
    fun applyAsync(installedDir: File): Boolean {
        if (state == "applying") return false
        val zip = pendingZip ?: return false
        val ver = availVersion ?: return false
        state = "applying"
        message = "正在应用 $ver…"
        Thread {
            try {
                installFrom(zip, installedDir, ver)
                state = "applied"
                message = "已更新到 $ver"
                Log.i(TAG, message)
            } catch (t: Throwable) {
                state = "error"
                message = "应用失败：" + (t.message ?: t.toString())
                Log.w(TAG, message)
                runCatching {
                    val rejected = File(zip.parentFile, ".rejected").apply { mkdirs() }
                    zip.renameTo(File(rejected, zip.name))
                }
            }
        }.apply { isDaemon = true; name = "plugin-apply" }.start()
        return true
    }

    /**
     * 把 [zip] 装到 [target]（全量或增量）。失败**抛异常**，由调用方决定回退。
     *
     * 流程：解到 `.staging-<ver>` →（增量时先复制现目录）→ 覆盖/删除 → 完整性校验
     * → 原子 rename → 写 stamp。**任何一步失败都不会动到现有目录**。
     */
    fun installFrom(zip: File, target: File, version: String) {
        val parent = target.parentFile ?: throw IllegalStateException("无父目录")
        val staging = File(parent, ".staging-$version")
        staging.deleteRecursively()
        staging.mkdirs()
        var manifest: JSONObject? = null
        ZipFile(zip).use { zf ->
            val mf = zf.getEntry("plugin-manifest.json")
            if (mf != null) {
                val txt = zf.getInputStream(mf).use { it.readBytes().toString(Charsets.UTF_8) }
                manifest = runCatching { JSONObject(txt) }.getOrNull()
            }
            val kind = manifest?.optString("kind", "full") ?: "full"
            if (kind == "delta") {
                val base = manifest?.optString("base", "") ?: ""
                val cur = installedVersion(target)
                if (base.isBlank()) throw IllegalStateException("增量包缺 base")
                if (cur != base) throw IllegalStateException("增量基线不符（当前 \"$cur\"，包要求 \"$base\"）")
                copyTree(target, staging)
            }
            val en = zf.entries()
            while (en.hasMoreElements()) {
                val e = en.nextElement()
                if (e.isDirectory || e.name == "plugin-manifest.json") continue
                val out = File(staging, e.name)
                if (!out.canonicalPath.startsWith(staging.canonicalPath + File.separator)) continue
                out.parentFile?.mkdirs()
                zf.getInputStream(e).use { input -> out.outputStream().use { input.copyTo(it, 256 * 1024) } }
            }
            if ((manifest?.optString("kind", "full") ?: "full") == "delta") {
                manifest?.optJSONArray("deletes")?.let { a ->
                    for (i in 0 until a.length()) {
                        runCatching { File(staging, a.getString(i)).deleteRecursively() }
                    }
                }
            }
        }
        val missing = REQUIRED.filter { rel ->
            val f = File(staging, rel)
            !f.isFile || f.length() <= 0L
        }
        if (missing.isNotEmpty()) {
            staging.deleteRecursively()
            throw IllegalStateException("补丁不完整，缺 " + missing.joinToString(","))
        }
        val old = File(parent, ".old-" + System.currentTimeMillis())
        if (target.exists() && !target.renameTo(old)) {
            staging.deleteRecursively()
            throw IllegalStateException("无法移开旧目录")
        }
        if (!staging.renameTo(target)) {
            old.renameTo(target)
            throw IllegalStateException("无法启用新目录")
        }
        old.deleteRecursively()
        File(target, STAMP).writeText(version)
    }

    /** 资产名 → (kind, version)。`plugins-mobile-ui-1.1.0-205.zip` = full；`…-203-205.delta.zip` = delta。 */
    private fun parseAssetName(name: String): Pair<String, String>? {
        val core = name.removePrefix(PREFIX).removeSuffix(".zip")
        if (core.isEmpty()) return null
        if (core.endsWith(".delta")) {
            val v = core.removeSuffix(".delta")
            return "delta" to v
        }
        return "full" to core
    }

    private fun copyTree(src: File, dst: File) {
        if (!src.isDirectory) return
        src.listFiles()?.forEach { f ->
            val to = File(dst, f.name)
            if (f.isDirectory) copyTree(f, to)
            else {
                to.parentFile?.mkdirs()
                f.copyTo(to, overwrite = true)
            }
        }
    }

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

    private fun httpGet(url: String): String? = runCatching {
        val c = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 8000
            readTimeout = 12000
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

    private fun download(url: String, out: File): Boolean = runCatching {
        val c = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 10000
            readTimeout = 60000
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", "dsh-android/plugin-updater")
        }
        try {
            if (c.responseCode !in 200..299) return@runCatching false
            c.inputStream.use { input -> out.outputStream().use { input.copyTo(it, 256 * 1024) } }
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
