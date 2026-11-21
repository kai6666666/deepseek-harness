package com.dsh.android.runtime

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Environment
import android.system.Os
import android.system.OsConstants
import android.util.Log
import com.dsh.android.engine.ProcPid
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files
import java.util.Collections
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** One launch contract for production, rescue, try-boot and one-shot Node commands. */
class ProotHost(
    private val context: Context,
    private val manifest: RuntimeManifest,
    private val rootfs: File = File(context.filesDir, "runtime/rootfs"),
    private val nativeLibDir: String = context.applicationInfo.nativeLibraryDir,
    private val tmpDir: File = File(context.cacheDir, "proot-tmp"),
    private val dshHome: File = File(context.filesDir, "home/.dsh"),
    private val workspace: File = File(context.filesDir, "workspace"),
    private val phoneStorage: File? = defaultPhoneStorage(context),
) {
    @Volatile private var process: Process? = null
    private var pump: Thread? = null
    @Volatile private var tokenUrl: String? = null
    @Volatile private var outputClosed = false
    private var readyOrEof = CountDownLatch(1)
    private val lastLines: MutableList<String> = Collections.synchronizedList(ArrayList())
    private val runId = UUID.randomUUID().toString()
    private val envFile: File get() = File(dshHome, ".proot-env-$runId")
    private val originalPidFile: File get() = File(
        manifest.stopPidFile.replace("{ROOTFS}", rootfs.canonicalPath).replace("{TMP}", tmpDir.absolutePath)
    )
    private val pidFile: File get() = File(originalPidFile.parentFile, "${originalPidFile.nameWithoutExtension}-$runId.pid")
    private val guestPidFile: String get() = "/" + pidFile.relativeTo(rootfs.canonicalFile).invariantSeparatorsPath

    fun start(
        extraEnv: Map<String, String>,
        overlays: List<File> = emptyList(),
        profile: String = "web",
        onLine: (String) -> Unit = {},
    ): Process {
        val p = launch(extraEnv, overlays, profile, null, true)
        pump = Thread({ drain(p, onLine) }, "proot-pump-$runId").apply { isDaemon = true; start() }
        return p
    }

    /** The caller owns both streams. stop() still owns this command's complete process tree. */
    fun startCommand(
        command: List<String>,
        extraEnv: Map<String, String> = emptyMap(),
        mergeError: Boolean = true,
    ): Process = launch(extraEnv, emptyList(), "web", command, mergeError)

    private fun launch(
        extraEnv: Map<String, String>, overlays: List<File>, profile: String,
        command: List<String>?, mergeError: Boolean,
    ): Process {
        check(process?.isAlive != true) { "Host already running" }
        require(rootfs.isDirectory) { "rootfs missing" }
        require(RuntimeFiles.missingCriticalFiles(rootfs).isEmpty()) { "rootfs critical files missing" }
        require(RuntimeFiles.contains(rootfs, originalPidFile)) { "pidfile outside rootfs" }
        tmpDir.mkdirs(); dshHome.mkdirs(); workspace.mkdirs()
        pidFile.parentFile?.mkdirs()
        Files.deleteIfExists(pidFile.toPath())
        tokenUrl = null; outputClosed = false; readyOrEof = CountDownLatch(1)
        synchronized(lastLines) { lastLines.clear() }
        val vars = mapOf(
            "{NATIVE_LIB_DIR}" to nativeLibDir, "{ROOTFS}" to rootfs.canonicalPath,
            "{TMP}" to tmpDir.absolutePath, "{PORT}" to "0",
        )
        fun expand(value: String) = vars.entries.fold(value) { s, (k, v) -> s.replace(k, v) }
        // Secrets go to a 0600 file inside the already-bound $DSH_HOME, not into argv.
        val envFile = this.envFile.apply {
            delete()
            writeText(ProotLaunch.envFileLines(extraEnv).joinToString("\n", postfix = "\n"))
            setReadable(false, false); setReadable(true, true)
            setWritable(false, false); setWritable(true, true)
        }
        val guestEnvFile = envFile.canonicalPath  // $DSH_HOME 按原绝对路径绑定，guest 内逐字有效
        val template = ProotLaunch.template(
            manifest.launchArgv.map(::expand), profile,
            "/" + originalPidFile.relativeTo(rootfs.canonicalFile).invariantSeparatorsPath,
            guestPidFile,
            // ⚠️ 必须是 canonicalPath：guest 里 dshHome 是按 canonicalPath 绑定的
            // （/data/data/...），而 absolutePath 是 /data/user/0/...；两者的字符串
            // 在 guest 内只存在前者，用 absolutePath 会让引擎 ENOENT 打不开 --patch。
            overlays.map { it.canonicalPath }, command, guestEnvFile,
        )
        val argv = ArrayList<String>()
        fun bind(f: File, guest: String = f.canonicalPath) {
            argv += "-b"; argv += f.canonicalPath + ":" + guest
        }
        for (raw in template) {
            when (val arg = raw) {
                "/usr/bin/env" -> {
                    bind(dshHome); bind(workspace)
                    val phone = phoneStorage?.takeIf { it.isDirectory }
                    if (phone != null) {
                        // 真机排障要看这一行：无「所有文件访问」时这里是
                        // Android/data/<包名>/files/sdcard，而不是真的 /storage/emulated/0。
                        Log.i(TAG, "bind /sdcard -> " + phone.absolutePath)
                        bind(phone, "/sdcard")
                        bind(phone)
                    }
                    File(context.filesDir, "logs").mkdirs()
                    File(context.filesDir, "devenv").mkdirs()
                    listOf("dsh-android-shell.mjs", "dsh-android-root.mjs", "adbwire",
                        "dsh-env.mjs", "check-devenv.mjs", "logs", "devenv").forEach { name ->
                        File(context.filesDir, name).takeIf { it.exists() }?.let { bind(it) }
                    }
                    argv += arg
                }
                "{GUEST_ENV}" -> {
                    // 只留非机密项：调用方传入的变量已写进 guest 侧 env 文件，
                    // 不再出现在 argv（`ps -A` 对 shell/root 可见）里。
                    val env = buildMap {
                        put("DSH_HOME", dshHome.canonicalPath)
                        put("TZ", TimeZone.getDefault().id)
                        if (File(rootfs, "etc/ssl/certs/ca-certificates.crt").isFile) {
                            put("SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt")
                            put("CURL_CA_BUNDLE", "/etc/ssl/certs/ca-certificates.crt")
                            put("REQUESTS_CA_BUNDLE", "/etc/ssl/certs/ca-certificates.crt")
                        }
                    }
                    env.forEach { (k, v) -> argv += "$k=$v" }
                }
                else -> argv += arg
            }
        }
        ensureGuestNetworkConfig()
        // jniLibs 是原生唯一来源：proot / loader / libtalloc / libandroid-shmem 全在
        // nativeLibraryDir（P1）。这里不再解 assets 到 files/proot-libs。
        val pb = ProcessBuilder(argv).directory(context.filesDir).redirectErrorStream(mergeError)
        pb.environment().apply {
            clear()
            put("PATH", "/system/bin:/system/xbin")
            put("HOME", context.filesDir.absolutePath)
            put("TMPDIR", tmpDir.absolutePath)
            put("ANDROID_ROOT", System.getenv("ANDROID_ROOT") ?: "/system")
            put("ANDROID_DATA", System.getenv("ANDROID_DATA") ?: "/data")
            manifest.launchEnv.forEach { (k, v) -> put(k, expand(v)) }
            put("LD_LIBRARY_PATH", nativeLibDir)
        }
        // Environment values may be credentials; log structural facts only.
        Log.i(TAG, "launch: profile=$profile patches=${overlays.size} pidFile=$guestPidFile command=${command?.firstOrNull() ?: "dsh"}")
        return pb.start().also { process = it }
    }

    private fun ensureGuestNetworkConfig() {
        runCatching {
            val etc = File(rootfs, "etc")
            if (!etc.isDirectory) return
            File(etc, "resolv.conf").let { f ->
                val text = runCatching { f.readText() }.getOrDefault("")
                if (RuntimeFiles.needsPublicDns(text)) {
                    f.writeText(RuntimeFiles.PUBLIC_DNS)
                    Log.w(TAG, "guest resolv.conf 不可用，已重写为公共 DNS（原长度=${text.length}）")
                }
            }
            File(etc, "hosts").let { f ->
                if (!f.isFile || f.length() == 0L) f.writeText("127.0.0.1 localhost\n::1 localhost\n")
            }
        }.onFailure { Log.w(TAG, "Guest network config: ${it.message}") }
    }

    private fun drain(p: Process, onLine: (String) -> Unit) {
        try {
            p.inputStream.bufferedReader().useLines { seq ->
                seq.forEach { line ->
                    synchronized(lastLines) {
                        lastLines.add(line)
                        if (lastLines.size > 400) lastLines.removeAt(0)
                    }
                    runCatching { onLine(line) }.onFailure { Log.w(TAG, "Output callback: ${it.message}") }
                    if (tokenUrl == null) manifest.tokenRegex.find(line)?.let { m ->
                        tokenUrl = m.groupValues[1] + "?token=" + m.groupValues.last()
                        readyOrEof.countDown()
                    }
                    Log.i(TAG, "[web] $line")
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "Output stream closed: ${t.message}")
        } finally {
            outputClosed = true
            readyOrEof.countDown()
        }
    }

    fun awaitToken(timeoutMs: Long): String? {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        while (System.nanoTime() < deadline) {
            if (readyOrEof.await(100, TimeUnit.MILLISECONDS)) return tokenUrl
            if (process?.isAlive == false) {
                pump?.join(2000)
                return tokenUrl
            }
        }
        return tokenUrl
    }

    /** Reap first, drain second: exit codes and the final error line are both available. */
    fun waitForExit(): Int {
        val p = process ?: return -1
        val code = p.waitFor()
        pump?.join(2000)
        return code
    }

    fun outputEnded(): Boolean = outputClosed
    fun exitCode(): Int? = process?.let { runCatching { it.exitValue() }.getOrNull() }
    fun recentLines(n: Int = 20): List<String> = synchronized(lastLines) { lastLines.takeLast(n) }
    fun isAlive(): Boolean = process?.isAlive == true

    fun health(timeoutMs: Int = 3000): Int {
        val endpoint = tokenUrl?.substringBefore("?") ?: return -1
        val c = URL(endpoint).openConnection() as HttpURLConnection
        return try {
            c.connectTimeout = timeoutMs; c.readTimeout = timeoutMs
            c.requestMethod = "GET"; c.instanceFollowRedirects = false
            c.responseCode
        } catch (t: Throwable) {
            Log.w(TAG, "Health: ${t.message}"); -1
        } finally { c.disconnect() }
    }

    private data class Pid(val value: Int, val parent: Int, val born: String)
    private fun pidInfo(pid: Int): Pid? = runCatching {
        val fields = File("/proc/$pid/stat").readText().substringAfterLast(") ").split(' ')
        Pid(pid, fields[1].toInt(), fields[19])
    }.getOrNull()
    private fun descendants(parent: Int): List<Pid> {
        val all = File("/proc").listFiles().orEmpty().mapNotNull { f -> f.name.toIntOrNull()?.let(::pidInfo) }
        val ids = hashSetOf(parent)
        while (true) {
            val found = all.filter { it.parent in ids && it.value !in ids }
            if (found.isEmpty()) break
            ids.addAll(found.map { it.value })
        }
        return all.filter { it.value in ids && it.value != parent }
    }
    private fun signal(pid: Pid, signal: Int) {
        if (pid.value > 1 && pidInfo(pid.value)?.born == pid.born) runCatching { Os.kill(pid.value, signal) }
    }

    /** Scoped shutdown: a try-boot host never scans-and-kills another host's Node. */
    @Synchronized fun stop(): Boolean {
        val p = process ?: return true
        val prootPid = ProcPid.of(p)?.toInt()
            ?: Regex("pid=(\\d+)").find(p.toString())?.groupValues?.get(1)?.toIntOrNull()
        val parent = prootPid?.let(::pidInfo)
        val owned = if (prootPid != null && p.isAlive) descendants(prootPid) else emptyList()
        val nodePid = runCatching { pidFile.readText().trim().toInt() }.getOrNull()
        owned.firstOrNull { it.value == nodePid }?.let { signal(it, OsConstants.SIGTERM) }
        if (p.isAlive && nodePid != null) p.waitFor(3, TimeUnit.SECONDS)
        if (p.isAlive) {
            parent?.let { signal(it, OsConstants.SIGQUIT) }
            if (!p.waitFor(5, TimeUnit.SECONDS)) {
                owned.forEach { signal(it, OsConstants.SIGKILL) }
                p.destroyForcibly()
                p.waitFor(3, TimeUnit.SECONDS)
            }
        }
        owned.forEach { signal(it, OsConstants.SIGKILL) }
        pump?.takeIf { it !== Thread.currentThread() }?.join(2000)
        val stopped = !p.isAlive
        if (stopped) {
            process = null
            tokenUrl = null
            runCatching { pidFile.delete() }
            runCatching { envFile.delete() }   // 密钥文件只在本次运行期间存在
        }
        return stopped
    }

    companion object {
        const val TAG = "ProotHost"

        /** The privileged helpers use exactly the same binds, env and loader as the engine. */
        fun startNodeCommand(
            context: Context,
            commandArgs: List<String>,
            extraEnv: Map<String, String> = emptyMap(),
            dshHome: File = File(context.filesDir, "home/.dsh"),
        ): Process {
            val host = ProotHost(context, RootfsInstaller(context).readManifestFromAssets(), dshHome = dshHome)
            val p = host.startCommand(listOf("/usr/local/bin/node") + commandArgs, extraEnv)
            Thread({ runCatching { p.waitFor(); host.stop() } }, "proot-command-reaper").apply {
                isDaemon = true; start()
            }
            return p
        }

        /**
         * 给 guest 的 `/sdcard` 选一个宿主目录。三级取源：
         *
         *   ① API 30+ 且已授予「所有文件访问」→ 真的 `/storage/emulated/0`
         *   ② API 30+ 但没授予 → `Android/data/<包名>/files/sdcard`（app 专属外部目录，始终可写）
         *   ③ API 29- → 老逻辑：有 READ_EXTERNAL 就给真 /sdcard
         *
         * 为什么要有 ②：API 30 起 `requestLegacyExternalStorage` 被系统忽略，
         * `READ/WRITE_EXTERNAL_STORAGE` 不再授予真 `/sdcard` 的任意访问。没有 ② 的话，
         * 用户没点「所有文件访问」时 guest 里 `/sdcard` 会直接 EACCES —— 插件读写全部失败，
         * 而报错只会出现在 guest 的 node 栈里，宿主侧什么都看不到。
         */
        private fun defaultPhoneStorage(context: Context): File? {
            if (Build.VERSION.SDK_INT >= 30) {
                if (Environment.isExternalStorageManager()) {
                    return Environment.getExternalStorageDirectory()?.takeIf { it.isDirectory }
                }
                val dir = context.getExternalFilesDir(null) ?: return null
                return File(dir, "sdcard").apply { mkdirs() }.takeIf { it.isDirectory }
            }
            val dir = Environment.getExternalStorageDirectory() ?: return null
            val granted = context.checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
            return dir.takeIf { granted && it.isDirectory }
        }
    }
}
