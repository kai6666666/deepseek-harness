package com.dsh.android.runtime

import android.content.Context
import android.system.Os
import android.system.OsConstants
import android.util.Log
import com.dsh.android.engine.ProcPid
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.ServerSocket
import java.net.URL
import java.util.Collections
import java.util.TimeZone

/**
 * PRoot/glibc 启动器：按 manifest 模板拼 argv、抓 token、按约定停进程。
 *
 * 约定来自 manifest：
 *  · {NATIVE_LIB_DIR} / {ROOTFS} / {TMP} / {PORT} / {PATCHES} 由这里替换；
 *  · {GUEST_ENV} 是独立元素，展开成 0..N 个 KEY=VALUE；
 *  · 绑定目录插在 /usr/bin/env 之前；
 *  · 停止 = SIGTERM 给 pidfile 里的 node，兜底 SIGQUIT 给 proot。
 *
 * 与 P2 探针版的差别（每一条都是接进产品后才暴露的）：
 *  1. bind 从「只绑 DSH_HOME」扩到「DSH_HOME 映射到 guest 的 /root/.dsh + workspace 原路径」，
 *     否则 bash 工具看不到工作区、会话写到 rootfs 里而不是宿主 home；
 *  2. manifest 的启动命令带 {PATCHES}，overlay 由这里注入，不再只靠试启动；
 *  3. stop 真正发 SIGQUIT 给 proot（ProotHost 之前只 destroy，proot 不理 SIGTERM）。
 */
class ProotHost(
    private val context: Context,
    private val manifest: RuntimeManifest,
    private val rootfs: File = File(context.filesDir, "runtime/rootfs"),
    private val nativeLibDir: String = context.applicationInfo.nativeLibraryDir,
    private val tmpDir: File = File(context.cacheDir, "proot-tmp"),
    private val dshHome: File = File(context.filesDir, "home/.dsh"),
    private val workspace: File = File(context.filesDir, "workspace"),
    private val phoneStorage: File? = null,
) {
    private var process: Process? = null
    private var pump: Thread? = null

    @Volatile
    private var tokenUrl: String? = null

    private val lastLines: MutableList<String> = Collections.synchronizedList(ArrayList())

    fun start(extraEnv: Map<String, String>, overlays: List<File> = emptyList()): Process {
        require(rootfs.isDirectory) { "rootfs 不存在：" + rootfs.absolutePath }
        require(File(rootfs, "usr/bin/node").isFile) { "rootfs 缺 node" }
        tmpDir.mkdirs()
        dshHome.mkdirs()
        workspace.mkdirs()
        // DSH_HOME 按**原绝对路径**绑定：EngineManager 写的所有 overlay、插件目录、
        // 会话索引路径都基于宿主 filesDir 的绝对路径，绑定到 /root/.dsh 会让它们全部失效。
        // 同一路径绑定的代价只是 guest 里能看到这个目录，收益是零路径改写。

        val port = ServerSocket(0).use { it.localPort }
        val vars = mapOf(
            "{NATIVE_LIB_DIR}" to nativeLibDir,
            "{ROOTFS}" to rootfs.canonicalPath,
            "{TMP}" to tmpDir.absolutePath,
            "{PORT}" to port.toString(),
        )
        fun expand(s: String) = vars.entries.fold(s) { acc, (k, v) -> acc.replace(k, v) }

        val patchArgs = overlays.joinToString(" ") { "--patch " + it.absolutePath }
        val argv = ArrayList<String>()
        var bindsPlaced = false
        var patchesPlaced = false
        for (raw in manifest.launchArgv) {
            val replaced = expand(raw)
            val arg = if (replaced.contains("{PATCHES}")) {
                patchesPlaced = true
                replaced.replace("{PATCHES}", patchArgs)
            } else replaced
            when {
                !bindsPlaced && arg == "/usr/bin/env" -> {
                    argv += "-b"
                    argv += dshHome.canonicalPath + ":" + dshHome.canonicalPath
                    argv += "-b"
                    argv += workspace.canonicalPath + ":" + workspace.canonicalPath
                    phoneStorage?.takeIf { it.isDirectory }?.let {
                        argv += "-b"
                        argv += it.canonicalPath + ":/sdcard"
                    }
                    argv += arg
                    bindsPlaced = true
                }
                arg == "{GUEST_ENV}" -> {
                    val env = buildMap {
                        put("DSH_HOME", "/root/.dsh")
                        put("TZ", TimeZone.getDefault().id)
                        putAll(extraEnv)
                    }
                    env.forEach { (k, v) -> argv += k + "=" + v }
                }
                else -> argv += arg
            }
        }
        require(bindsPlaced) { "manifest 里没有 /usr/bin/env 锚点" }
        // 没有 {PATCHES} 的 manifest 会让引擎在无沙箱 / 无索引 / 无插件源配置下启动：
        // 那是「能跑但悄悄缺能力」，比启动失败更难查，所以直接拒绝。
        require(patchesPlaced) { "manifest 缺 {PATCHES} 占位符（运行时资产过旧）" }

        val pb = ProcessBuilder(argv).directory(context.filesDir)
        pb.environment().apply {
            clear()
            put("PATH", "/system/bin:/system/xbin")
            put("HOME", context.filesDir.absolutePath)
            put("TMPDIR", tmpDir.absolutePath)
            put("ANDROID_ROOT", System.getenv("ANDROID_ROOT") ?: "/system")
            put("ANDROID_DATA", System.getenv("ANDROID_DATA") ?: "/data")
            manifest.launchEnv.forEach { (k, v) -> put(k, expand(v)) }
        }

        Log.i(TAG, "launch: " + argv.joinToString(" "))
        val p = pb.start()
        process = p
        pump = Thread({ drain(p) }, "proot-pump").apply {
            isDaemon = true
            start()
        }
        return p
    }

    private fun drain(p: Process) {
        try {
            BufferedReader(InputStreamReader(p.inputStream)).use { r ->
                r.lineSequence().forEach { line ->
                    synchronized(lastLines) {
                        lastLines.add(line)
                        if (lastLines.size > 200) lastLines.removeAt(0)
                    }
                    val m = manifest.tokenRegex.find(line)
                    if (m != null) {
                        tokenUrl = m.groupValues[1] + "?token=" + m.groupValues[m.groupValues.size - 1]
                        Log.i(TAG, "token: " + tokenUrl)
                    }
                    Log.i(TAG, "[web] " + line)
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "stdout 读取结束: " + t.message)
        }
    }

    fun awaitToken(timeoutMs: Long): String? {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            tokenUrl?.let { return it }
            if (process?.isAlive == false) return tokenUrl
            Thread.sleep(100)
        }
        return tokenUrl
    }

    /** 不带 cookie 请求根路径；服务活着时按 manifest 约定返回 401。 */
    fun health(timeoutMs: Int = 3000): Int {
        val url = tokenUrl?.substringBefore("?") ?: return -1
        return try {
            val c = URL(url).openConnection() as HttpURLConnection
            c.connectTimeout = timeoutMs
            c.readTimeout = timeoutMs
            c.requestMethod = "GET"
            c.instanceFollowRedirects = false
            c.responseCode
        } catch (t: Throwable) {
            Log.w(TAG, "health 失败: " + t.message)
            -1
        }
    }

    fun recentLines(n: Int = 20): List<String> = synchronized(lastLines) {
        lastLines.takeLast(n)
    }

    fun stop(): Boolean {
        val pidFile = File(
            manifest.stopPidFile
                .replace("{ROOTFS}", rootfs.canonicalPath)
                .replace("{TMP}", tmpDir.absolutePath)
        )
        val nodePid = runCatching { pidFile.readText().trim().toInt() }.getOrNull()
        if (nodePid != null && nodePid > 0) {
            runCatching { Os.kill(nodePid.toLong(), OsConstants.SIGTERM) }
                .onFailure { Log.w(TAG, "SIGTERM " + nodePid + " 失败: " + it.message) }
            val deadline = System.currentTimeMillis() + 5000
            while (System.currentTimeMillis() < deadline && File("/proc/" + nodePid).exists()) {
                Thread.sleep(100)
            }
        }

        val p = process ?: return true
        if (p.isAlive) {
            // proot 忽略 SIGTERM/SIGINT/SIGHUP；node 死后 --kill-on-exit 通常会收尾，
            // 但异常退出时必须显式 SIGQUIT，否则 tracee 变孤儿、端口不释放。
            val pid = ProcPid.of(p)
            if (pid != null) {
                runCatching { Os.kill(pid, OsConstants.SIGQUIT) }
                    .onFailure { Log.w(TAG, "SIGQUIT " + pid + " 失败: " + it.message) }
            }
            if (!p.waitFor(8, java.util.concurrent.TimeUnit.SECONDS)) {
                Log.w(TAG, "SIGQUIT 后 proot 仍未退，destroyForcibly")
                p.destroyForcibly()
                p.waitFor(3, java.util.concurrent.TimeUnit.SECONDS)
            }
        }
        pump?.interrupt()
        process = null
        tokenUrl = null
        runCatching { pidFile.delete() }
        return !p.isAlive
    }

    fun isAlive(): Boolean = process?.isAlive == true

    companion object {
        const val TAG = "ProotHost"
    }
}
