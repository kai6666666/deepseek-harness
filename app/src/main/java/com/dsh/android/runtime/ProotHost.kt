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
import com.dsh.android.log.DshLog
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

    /** 本次 launch 是否走了 direct（免 proot）；EngineManager 用它写 engine.ready 的 runtime 字段。 */
    @Volatile var launchedDirect: Boolean = false
        private set
    private var readyOrEof = CountDownLatch(1)
    private val lastLines: MutableList<String> = Collections.synchronizedList(ArrayList())
    private val runId = UUID.randomUUID().toString()

    /** direct 等 token 行的宽限：实测 6.5 s 就绪，这里给 4 倍余量。 */
    private val DIRECT_GRACE_MS = 25_000L
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
        var p = launch(extraEnv, overlays, profile, null, true)
        pump = Thread({ drain(p, onLine) }, "proot-pump-$runId").apply { isDaemon = true; start() }
        if (launchedDirect) {
            // direct 的第一道关是「能不能在宽限内打印 token 行」。拿不到就当场回退，
            // 并把这次失败写进 direct-failed-<runtimeVersion>：同一 runtime 不再试。
            val t0 = System.currentTimeMillis()
            val url = awaitToken(DIRECT_GRACE_MS)
            if (url == null) {
                val alive = process?.isAlive == true
                DshLog.w(TAG, "direct 未就绪（alive=$alive, ${System.currentTimeMillis() - t0} ms），回退 proot")
                runCatching { p.destroyForcibly() }
                pump?.join(1500)
                DirectLaunch.markFailed(context.filesDir, manifest.runtimeVersion)
                launchedDirect = false
                p = launch(extraEnv, overlays, profile, null, true, forceProot = true)
                pump = Thread({ drain(p, onLine) }, "proot-pump-$runId-fallback").apply { isDaemon = true; start() }
            } else {
                DshLog.i(TAG, "direct=on token ready in ${System.currentTimeMillis() - t0} ms")
            }
        }
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
        command: List<String>?, mergeError: Boolean, forceProot: Boolean = false,
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
        // ── P4-a：direct（免 proot）直启 ──────────────────────────────────────
        // 只对 web profile 尝试；工具/诊断的一次性 node 命令（startCommand）恒走 proot：
        //   direct 下 guest 绝对路径没有 bind 语义，工具输出会跟 proot 对不上。
        if (!forceProot && command == null && profile == "web") {
            val filesDir = context.filesDir
            if (!DirectLaunch.enabled(filesDir)) {
                DshLog.i(TAG, "direct=off reason=disabled")
            } else if (DirectLaunch.failed(filesDir, manifest.runtimeVersion)) {
                DshLog.i(TAG, "direct=off reason=directFailed")
            } else {
                val libDir = File(nativeLibDir)
                val reason = DirectLaunch.unavailable(rootfs, manifest.abi, libDir)
                val plan = if (reason == null) {
                    DirectLaunch.plan(rootfs, filesDir, manifest.abi, profile, overlays, extraEnv,
                        nativeLibDir = libDir)
                } else null
                if (reason != null) {
                    DshLog.w(TAG, "direct=off reason=$reason")
                } else if (plan == null) {
                    DshLog.w(TAG, "direct=off reason=planUnavailable")
                } else {
                    // direct 不走 proot 的 bind，但同样需要可用的 resolv.conf/hosts。
                    ensureGuestNetworkConfig()
                    return spawnDirect(plan, mergeError)
                }
            }
        }

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
                    // ⚠️ home 必须**整体**绑一次（canonical 路径）。
                    //   只绑 dshHome(=home/.dsh) 与 files 的 **别名** 时，guest 里的
                    //   `/data/data/<pkg>/files` 只是一个由 bind 目标路径凑出来的**骨架**，
                    //   里面仅有 .dsh —— 目录选择器以 $HOME(=files/home) 为起点，看到的
                    //   就是空列表（vc73 探针实测：只有 .dsh，三个入口链接全不可见）。
                    bind(File(context.filesDir, "home"))
                    // ⚠️ 别名绑：guest 里同时提供 /data/user/0/<pkg>/files 这条路。
                    // 事实：assets 里的插件 overlay、以及 EngineManager 拼的很多路径用的是
                    // File.absolutePath（/data/user/0/...），而 proot 只按 canonicalPath
                    // （/data/data/...）绑定 —— 只挂后者时这些字符串在 guest 内全是 ENOENT，
                    // 表现为「14 个插件 failed to import」甚至引擎直接退出。
                    // 把 filesDir 再以绝对路径为 guest 路径绑一次，两套前缀都成立。
                    val filesAlias = context.filesDir.absolutePath
                    if (filesAlias != context.filesDir.canonicalPath) bind(context.filesDir, filesAlias)
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
                        // 用户主目录：目录选择器的起点就是 $HOME。
                        // 必须与 ensurePickerRoots() 里建入口链接的位置一致，
                        // 否则选择器打开是空列表（vc72 实测）。
                        put("DSH_USER_HOME", File(context.filesDir, "home").canonicalPath)
                        // ⚠️ **必须在这里再覆盖一次 HOME**：
                        //   runtime/manifest.json 的 launch.argv 里是
                        //   `/usr/bin/env -i HOME=/root USER=root ... DSH_HOME=/root/.dsh`，
                        //   而 `env -i` 之后逐条 KEY=VALUE **后者覆盖前者**。
                        //   DSH_HOME 早就被这一段覆盖成 files/home/.dsh（所以会话没丢），
                        //   但 HOME 一直没人覆盖 —— 引擎进程的 $HOME 始终是 /root，
                        //   目录选择器（homedir() 起点）因此打开就是空的（vc74 截图）。
                        put("HOME", File(context.filesDir, "home").canonicalPath)
                        // ⚠️ 必须注入 DSH_FILES：引擎内的插件（mobile-ui 等）靠它定位
                        //   `dsh-env.mjs` / `devenv/` / `logs/`。宿主此前**没有**注入，
                        //   插件只能用自己的兜底常量 —— 那个常量写死了旧包名
                        //   `com.dsh.android`，P4 换包名后路径全部落空，
                        //   表现为「设置 → 开发环境：无法获取状态（引擎插件未激活？）」。
                        put("DSH_FILES", context.filesDir.canonicalPath)
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

    /**
     * direct 直启：loader + node + 引擎 bin.js，完全绕过 proot。
     *
     * pid 文件由宿主写（direct 下没有 guest 的 `echo $$`）：内容是 node 的**宿主 pid**，
     * stop() 的祖先扫描仍以本对象的 process 为准。
     */
    private fun spawnDirect(plan: DirectLaunch.Plan, mergeError: Boolean): Process {
        val pb = ProcessBuilder(plan.argv).directory(plan.cwd).redirectErrorStream(mergeError)
        pb.environment().apply {
            clear()
            putAll(plan.environment)
        }
        DshLog.i(TAG, "launch: direct=on profile=web patches=${plan.patches} cwd=${plan.cwd.absolutePath}")
        val p = pb.start()
        process = p
        launchedDirect = true
        // android 的 java.lang.Process 没有 pid()：复用本工程已有的 ProcPid（与 stop() 同一来源）。
        runCatching {
            plan.pidFile.parentFile?.mkdirs()
            val hostPid = ProcPid.of(p)
            DshLog.i(TAG, "direct.spawn pid=" + (hostPid ?: "?") + " argv0=" + plan.argv.first())
            if (hostPid != null && hostPid > 0) plan.pidFile.writeText(hostPid.toString() + "\n")
        }.onFailure { DshLog.w(TAG, "direct pidfile: ${it.message}") }
        return p
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

    /**
     * 探测引擎健康：返回 (HTTP 码, 失败原因)。
     *
     * 为什么要把失败原因带出来：冷启阶段「打印了 URL 但监听还没 accept」会得到 -1，
     * 只回一个 -1 无法区分「连接被拒」「超时」「DNS/端口没起来」。调用方需要这个字符串
     * 才能把现场写进崩溃文件，而不是只留一句 HTTP=-1。
     */
    fun healthProbe(timeoutMs: Int = 3000): Pair<Int, String?> {
        val endpoint = tokenUrl?.substringBefore("?") ?: return -1 to "no token line yet"
        val c = URL(endpoint).openConnection() as HttpURLConnection
        return try {
            c.connectTimeout = timeoutMs; c.readTimeout = timeoutMs
            c.requestMethod = "GET"; c.instanceFollowRedirects = false
            c.responseCode to null
        } catch (t: Throwable) {
            Log.w(TAG, "Health: ${t.message}")
            -1 to (t.javaClass.simpleName + ": " + (t.message ?: ""))
        } finally { c.disconnect() }
    }

    fun health(timeoutMs: Int = 3000): Int = healthProbe(timeoutMs).first

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
