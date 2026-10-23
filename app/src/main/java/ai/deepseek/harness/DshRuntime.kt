package ai.deepseek.harness

import android.content.Context
import android.system.Os
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.URL
import java.nio.file.Files

enum class Phase { IDLE, INSTALLING, STARTING, READY, RESTARTING, FAILED, STOPPED }

data class DshState(
    val phase: Phase = Phase.IDLE,
    val url: String? = null,
    val port: Int = 0,
    val pid: Long = 0L,
    val restarts: Int = 0,
    val detail: String = "",
)

/**
 * deepseek harness 运行时：在 PRoot 容器里托管 `dsh web`。
 *
 * 生命周期：
 *   ensureInstalled() -> pickPort() -> spawn(proot) -> 解析 stdout 的授权 URL
 *     -> 303 健康检查 -> READY -> waitFor() -> 崩溃则指数退避重启
 *
 * 设计约束（全部来自 M0 实测）：
 *  - 裸 origin 返回 401，入口只能是 stdout 打印的 `http://127.0.0.1:<port>/?token=...`
 *  - token URL 返回 303 + Set-Cookie，跟随后才是 200
 *  - 容器 network namespace 与宿主共享，127.0.0.1 直通
 */
class DshRuntime private constructor(private val app: Context) {

    companion object {
        private const val TAG = "DshRuntime"

        /**
         * 分层镜像：先铺 base，再把运行时层盖上去。
         * 换 DSH 版本时只替换 layer1，不必重下 279 MiB 的 Ubuntu。
         * 两层的顶层目录都叫 ubuntu-noble-aarch64，直接叠到同一父目录即可。
         */
        val ROOTFS_LAYERS = listOf(
            "layer0-ubuntu-noble-aarch64.tar.xz",
            "layer1-dsh-node24.19.0-dsh0.2.1-rc.2.tar.xz",
        )
        private const val INSTALL_MARKER = ".deepseek_harness_installed"

        /** 两层归档共同的顶层目录名；解压后 rename 成 rootfsDir 的最后一段 */
        private const val LAYER_TOP = "ubuntu-noble-aarch64"

        /** DSH 侧 MCP 桥：APK assets 里一份，装完写进 guest 的 /root */
        private const val OVERLAY_ASSET = "mcp-android.overlay.yml"
        private const val GUEST_OVERLAY = "/root/mcp-android.overlay.yml"

        private const val PORT_FIRST = 3080
        private const val PORT_LAST = 3090
        private const val URL_TIMEOUT_MS = 120_000L

        /** `dsh web: http://127.0.0.1:3080/?token=xxx` */
        private val URL_RE = Regex("""dsh web:\s*(http://127\.0\.0\.1:(\d+)/\?token=[A-Za-z0-9_\-]+)""")

        @Volatile
        private var instance: DshRuntime? = null

        fun get(context: Context): DshRuntime =
            instance ?: synchronized(this) {
                instance ?: DshRuntime(context.applicationContext).also { instance = it }
            }
    }

    private val _state = MutableStateFlow(DshState())
    val state: StateFlow<DshState> = _state.asStateFlow()

    private val filesDir: File get() = app.filesDir
    private val binDir get() = File(filesDir, "bin")
    private val tmpDir get() = File(filesDir, "tmp").apply { mkdirs() }
    private val rootfsDir
        get() = File(filesDir, "usr/var/lib/proot-distro/installed-rootfs/ubuntu")

    private val logTail = ArrayDeque<String>(64)
    private var scope: CoroutineScope? = null
    private var supervisor: Job? = null
    private var process: Process? = null

    @Volatile
    private var stopping = false

    // ---------------------------------------------------------------- public

    fun start() {
        if (supervisor?.isActive == true) return
        stopping = false
        val s = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        scope = s
        supervisor = s.launch { supervise() }
    }

    fun stop() {
        stopping = true
        process?.let { p ->
            runCatching { p.destroy() }
            runCatching { p.waitFor(3, java.util.concurrent.TimeUnit.SECONDS) }
            runCatching { p.destroyForcibly() }
        }
        process = null
        supervisor?.cancel()
        supervisor = null
        scope?.cancel()
        scope = null
        _state.value = DshState(phase = Phase.STOPPED, detail = "stopped by user")
    }

    fun restartNow() {
        process?.destroyForcibly()
        if (supervisor?.isActive != true) start()
    }

    // ------------------------------------------------------------- supervise

    private suspend fun supervise() {
        var restarts = 0
        while ((scope?.isActive ?: false) && !stopping) {
            val cycleStart = System.currentTimeMillis()
            try {
                runCycle()

                // 正常路径不会走到这里：waitFor 返回说明 dsh 退出了
                throw IOException("dsh 进程退出 code=${process?.exitValue()}")
            } catch (e: CancellationException) {
                throw e
            } catch (t: Throwable) {
                val readyFor = System.currentTimeMillis() - cycleStart
                if (readyFor > 10 * 60_000L) restarts = 0   // 稳定运行过，重置预算
                restarts++
                val backoffMs = minOf(30_000L, 1_000L shl minOf(restarts, 5))
                Log.w(TAG, "cycle failed (restarts=$restarts, backoff=${backoffMs}ms): ${t.message}")
                _state.value = _state.value.copy(
                    phase = Phase.RESTARTING,
                    restarts = restarts,
                    detail = "${t.message}  retry in ${backoffMs}ms\n${tail()}",
                )
                delay(backoffMs)
            }
        }
        _state.value = _state.value.copy(phase = Phase.STOPPED)
    }

    private suspend fun runCycle() {
        _state.value = DshState(phase = if (isInstalled()) Phase.STARTING else Phase.INSTALLING)
        if (!isInstalled()) install()

        val port = pickPort()
        _state.value = _state.value.copy(phase = Phase.STARTING, port = port, detail = "spawning proot…")

        // 每次启动前都把 MCP overlay 重写一遍：rootfs 可能是老版本装的，overlay 必须跟 APK 一致
        seedOverlay()

        val p = spawn(port)
        process = p
        _state.value = _state.value.copy(pid = findPidOf(p) ?: 0L)

        val url = awaitUrl(p) ?: throw IOException("${URL_TIMEOUT_MS / 1000}s 内未出现授权 URL")
        if (!probe(url)) throw IOException("授权 URL 未返回 303")

        _state.value = _state.value.copy(
            phase = Phase.READY, url = url, port = port,
            detail = "ready on port $port\n${tail()}",
        )
        Log.i(TAG, "READY $url")

        p.waitFor()   // 一直阻塞到进程退出
    }

    // --------------------------------------------------------------- install

    fun isInstalled(): Boolean = File(rootfsDir, INSTALL_MARKER).isFile()

    private suspend fun install() {
        _state.value = _state.value.copy(phase = Phase.INSTALLING, detail = "准备二进制…")
        ensureBinLinks()

        // 1) 逐层把资产从 APK assets 释放到 filesDir（缺哪层补哪层）
        ROOTFS_LAYERS.forEach { name ->
            val f = File(filesDir, name)
            if (!f.isFile || f.length() < 1_000_000L) {
                _state.value = _state.value.copy(detail = "释放 $name …")
                app.assets.open(name).use { input ->
                    f.outputStream().use { output -> input.copyTo(output, 1 shl 20) }
                }
            }
        }

        // 2) 只有「解压」交给 busybox：mv / rm / ln 全部搬回 Kotlin。
        //    真机踩到的坑：in-app 里 shell 的 mv 不可用（PATH 与登录 shell 环境差异），
        //    失败现场没有任何输出，只剩 exit=1。改成 Java 的 renameTo / deleteRecursively / Os.symlink
        //    之后，这条链路上不再依赖任何外部命令。
        _state.value = _state.value.copy(detail = "解压镜像层（busybox tar xf）…")
        val parent = rootfsDir.parentFile
            ?: throw IOException("rootfs 路径异常：${rootfsDir.absolutePath}")
        parent.mkdirs()
        val top = File(parent, LAYER_TOP)

        _state.value = _state.value.copy(detail = "清理旧 rootfs…")
        deleteTree(rootfsDir)
        deleteTree(top)
        deleteTree(File(filesDir.parentFile, LAYER_TOP))   // 旧路径 bug 留下的 1.4 GiB

        val script = buildString {
            appendLine("BIN='${binDir.absolutePath}'")
            appendLine("PARENT='${parent.absolutePath}'")
            ROOTFS_LAYERS.forEach { name ->
                appendLine("echo \"[install] untar $name\"")
                appendLine(
                    "\"\$BIN/busybox\" tar xf '${File(filesDir, name).absolutePath}' -C \"\$PARENT\" " +
                        "--exclude='$LAYER_TOP/dev/*' 2>\"\$PARENT/.tar.err\""
                )
                appendLine("rc=\$?; echo \"[install] tar rc=\$rc\"")
                appendLine("if [ \$rc -ne 0 ]; then head -c 500 \"\$PARENT/.tar.err\" 2>/dev/null; echo; fi")
            }
            appendLine("echo \"[install] untar done\"")
        }

        val code = runHostShell(script, timeoutMs = 20 * 60_000L)
        if (code != 0) throw IOException("镜像解压失败，exit=$code\n${tail()}")
        if (!top.isDirectory) throw IOException("解压后没有 $LAYER_TOP 目录\n${tail()}")

        _state.value = _state.value.copy(detail = "落盘 rootfs…")
        if (!top.renameTo(rootfsDir)) {
            // 同盘 rename 正常是瞬时；失败通常意味着跨挂载点，退回「逐个文件搬」
            copyTree(top, rootfsDir)
            deleteTree(top)
        }
        if (!rootfsDir.isDirectory) throw IOException("rootfs 目录创建失败：${rootfsDir.absolutePath}")

        seedDevNodes()

        val node = File(rootfsDir, "usr/local/bin/node")
        if (!node.isFile) throw IOException("node 未进镜像：${node.absolutePath}")
        if (!node.canExecute()) node.setExecutable(true, false)
        val dshPkg = File(rootfsDir, "usr/local/lib/node_modules/@deepseek-ai/dsh/package.json")
        if (!dshPkg.isFile) throw IOException("dsh 包未进镜像：${dshPkg.absolutePath}")
        File(rootfsDir, INSTALL_MARKER).writeText("ok\n")

        if (!File(rootfsDir, "etc").isDirectory) throw IOException("rootfs 结构异常：缺 etc/")

        seedFakeProcFiles()
        seedResolvConf()
        seedOverlay()
        Log.i(TAG, "installed rootfs -> ${rootfsDir.absolutePath}")
    }

    /** 递归删除：不走 shell 的 rm，避免 PATH / 权限造成的静默失败 */
    private fun deleteTree(f: File) {
        if (!f.exists()) return
        val t0 = System.currentTimeMillis()
        runCatching { f.deleteRecursively() }
            .onFailure { Log.w(TAG, "deleteTree ${f.name}: ${it.message}") }
        Log.i(TAG, "deleteTree ${f.name} ${System.currentTimeMillis() - t0}ms")
    }

    /** renameTo 失败时的退路：逐项复制（保留权限位与软链本身） */
    private fun copyTree(src: File, dst: File) {
        dst.mkdirs()
        src.listFiles()?.forEach { s ->
            val d = File(dst, s.name)
            if (s.isDirectory) {
                copyTree(s, d)
            } else {
                runCatching {
                    Files.copy(
                        s.toPath(), d.toPath(),
                        java.nio.file.LinkOption.NOFOLLOW_LINKS,
                        java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                        java.nio.file.StandardCopyOption.COPY_ATTRIBUTES,
                    )
                }.onFailure { Log.w(TAG, "copy ${s.name}: ${it.message}") }
            }
        }
        runCatching { dst.setLastModified(src.lastModified()) }
    }

    /** guest 内的 /dev：proot 需要这些挂载点存在，标准流用软链指到 /proc/self/fd */
    private fun seedDevNodes() {
        File(rootfsDir, "dev/pts").mkdirs()
        File(rootfsDir, "dev/shm").mkdirs()
        File(rootfsDir, "tmp").mkdirs()
        mapOf(
            "dev/fd" to "/proc/self/fd",
            "dev/stdin" to "/proc/self/fd/0",
            "dev/stdout" to "/proc/self/fd/1",
            "dev/stderr" to "/proc/self/fd/2",
        ).forEach { (rel, target) ->
            val f = File(rootfsDir, rel)
            if (f.exists() || Files.isSymbolicLink(f.toPath())) return@forEach
            runCatching { Os.symlink(target, f.absolutePath) }
                .onFailure { Log.w(TAG, "symlink $rel -> $target: ${it.message}") }
        }
    }

    /** 把 MCP overlay 写进 guest 的 /root：DSH 启动时用 --patch 加载它 */
    private fun seedOverlay() {
        runCatching {
            val dst = File(rootfsDir, GUEST_OVERLAY.trimStart('/'))
            dst.parentFile?.mkdirs()
            app.assets.open(OVERLAY_ASSET).use { input ->
                dst.outputStream().use { output -> input.copyTo(output) }
            }
            Log.i(TAG, "overlay -> ${dst.absolutePath} (${dst.length()} B)")
        }.onFailure { Log.w(TAG, "overlay 写入失败: ${it.message}") }
    }

    /** Operit 的坑位 4：proot 下 /proc 部分文件缺失会让 node/npm 直接崩 */
    private fun seedFakeProcFiles() {
        val proc = File(rootfsDir, "proc").apply { mkdirs() }
        mapOf(
            ".stat" to "cpu  0 0 0 0 0 0 0 0 0 0\nbtime 0\n",
            ".loadavg" to "0.00 0.00 0.00 1/1 1\n",
            ".uptime" to "0.00 0.00\n",
            ".version" to "Linux version 5.10.0-android (deepseek-harness@proot) #1 SMP\n",
            ".vmstat" to "nr_free_pages 0\n",
            ".sysctl_entry_cap_last_cap" to "40\n",
            ".sysctl_inotify_max_user_watches" to "65536\n",
        ).forEach { (name, body) ->
            val f = File(proc, name)
            if (!f.exists()) runCatching { f.writeText(body) }
        }
    }

    private fun seedResolvConf() {
        val f = File(rootfsDir, "etc/resolv.conf")
        if (f.exists() && f.length() > 0) return
        runCatching {
            f.parentFile?.mkdirs()
            f.writeText(
                """
                nameserver 8.8.8.8
                nameserver 1.1.1.1
                nameserver 223.5.5.5
                nameserver 223.6.6.6
                """.trimIndent() + "\n"
            )
        }
    }

    /** 把 nativeLibraryDir 里的 libX.so 软链成 bin/X —— Operit 同款做法 */
    private fun ensureBinLinks() {
        binDir.mkdirs()
        val map = linkedMapOf(
            "liboperit_proot.so" to "proot",
            "liboperit_loader.so" to "loader",
            "libbash.so" to "bash",
            "libbusybox.so" to "busybox",
        )
        val nativeDir = File(app.applicationInfo.nativeLibraryDir)
        map.forEach { (lib, name) ->
            val target = File(nativeDir, lib)
            if (!target.isFile) { Log.w(TAG, "缺少二进制: $lib"); return@forEach }
            target.setExecutable(true, false)
            val link = File(binDir, name)
            runCatching {
                Files.deleteIfExists(link.toPath())
                Files.createSymbolicLink(link.toPath(), target.toPath())
            }.onFailure { Log.e(TAG, "link $name failed: ${it.message}") }
        }
        listOf("proot", "bash", "busybox").forEach {
            val f = File(binDir, it)
            if (!f.canExecute()) Log.w(TAG, "bin/$it 不可执行，proot 会启动失败")
        }
    }

    // ---------------------------------------------------------------- launch

    private fun pickPort(): Int {
        for (p in PORT_FIRST..PORT_LAST) {
            try {
                ServerSocket().use { it.bind(InetSocketAddress("127.0.0.1", p)) }
                return p
            } catch (_: IOException) {
                // 端口被占，试下一个
            }
        }
        return PORT_FIRST
    }

    private fun prootBinds(): List<String> {
        val binds = ArrayList<String>(28)
        fun add(src: String, dst: String? = null) {
            val f = File(src)
            // 关键：app 读不到的东西绑进去只会让 proot 报 "can't sanitize binding" 并拖慢启动
            if (!f.exists() || !f.canRead()) {
                Log.i(TAG, "skip bind $src（不可读）")
                return
            }
            binds += if (dst == null || dst == src) listOf("-b", src) else listOf("-b", "$src:$dst")
        }
        // 目标目录必须存在于 guest 内，否则 proot 会自己去 glue rootfs 里造（更慢，且老内核上会失败）
        fun ensureGuestDir(path: String) {
            runCatching { File(rootfsDir, path.trimStart('/')).mkdirs() }
        }
        ensureGuestDir("/dev")
        ensureGuestDir("/dev/pts")
        ensureGuestDir("/dev/shm")
        add("/dev"); add("/proc"); add("/sys"); add("/dev/pts")
        // /dev 目录本身若被 SELinux 挡住，至少把 node 运行时真正会碰的几个设备节点绑进去
        listOf("/dev/null", "/dev/zero", "/dev/random", "/dev/urandom").forEach { add(it) }
        add(tmpDir.absolutePath, "/dev/shm")
        add("/proc/self/fd", "/dev/fd")
        add("/proc/self/fd/0", "/dev/stdin")
        add("/proc/self/fd/1", "/dev/stdout")
        add("/proc/self/fd/2", "/dev/stderr")
        // 外部存储：拿不到就退到 app 专属目录（无需任何存储权限也能读写）
        if (File("/storage/emulated/0").canRead()) {
            add("/storage/emulated/0", "/sdcard")
            add("/storage/emulated/0")
        } else {
            app.getExternalFilesDir(null)?.let { ext ->
                if (ext.isDirectory) add(ext.absolutePath, "/sdcard")
            }
        }
        add("/data/local/tmp")
        add(app.applicationInfo.dataDir, "/data/data/${app.packageName}")
        add(filesDir.absolutePath)

        // 真 /proc 缺什么就用 rootfs 内的假文件顶上（Operit 的探针逻辑，简化为存在性判断）
        val fake = mapOf(
            "/proc/stat" to ".stat",
            "/proc/loadavg" to ".loadavg",
            "/proc/uptime" to ".uptime",
            "/proc/version" to ".version",
            "/proc/vmstat" to ".vmstat",
            "/proc/sys/kernel/cap_last_cap" to ".sysctl_entry_cap_last_cap",
            "/proc/sys/fs/inotify/max_user_watches" to ".sysctl_inotify_max_user_watches",
        )
        fake.forEach { (real, f) ->
            if (File(real).exists()) return@forEach
            val src = File(rootfsDir, "proc/$f")
            if (src.isFile) binds += listOf("-b", "${src.absolutePath}:$real")
        }
        return binds
    }

    private fun buildCommand(port: Int): List<String> {
        val cmd = ArrayList<String>(64)
        cmd += File(binDir, "proot").absolutePath
        cmd += listOf("-0", "-r", rootfsDir.absolutePath, "--link2symlink")
        cmd += prootBinds()
        cmd += listOf("-w", "/root")
        cmd += listOf(
            "/usr/bin/env", "-i",
            "HOME=/root",
            "TMPDIR=/tmp",
            "TERM=xterm-256color",
            "LANG=en_US.UTF-8",
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "/bin/bash", "-lc",
            // --patch 是 launcher 级 flag，必须排在 --no-open/--port 这类 inner 参数之前，
            // 否则会被当成 web app 的参数。overlay 由 seedOverlay() 写进 /root。
            "mkdir -p /tmp && cd /root && exec dsh web --patch $GUEST_OVERLAY --no-open --port $port",
        )
        return cmd
    }

    /** 给环境管理用：在同一个 rootfs 里跑任意脚本（不带 dsh 参数）。 */
    fun containerCommand(script: String): List<String> =
        buildCommand(0).dropLast(3) + listOf("/bin/bash", "-lc", script)

    private fun spawn(port: Int): Process {
        val pb = ProcessBuilder(buildCommand(port))
        pb.directory(filesDir)
        pb.redirectErrorStream(true)
        // 关键：清掉 Android 自带的库搜索路径，否则 proot 会去加载系统的 libc
        pb.environment().remove("LD_LIBRARY_PATH")
        pb.environment()["TMPDIR"] = tmpDir.absolutePath
        // 真机实测：没有这两个变量 proot 直接死在
        //   "proot error: can't create temporary directory: Permission denied"
        // PROOT_TMP_DIR 给 glue rootfs 用；PROOT_LOADER 指到改名后的 loader，
        // 否则 proot 会去 /proc/self/exe 同目录找 "loader"（那里只有 liboperit_proot.so）
        pb.environment()["PROOT_TMP_DIR"] = tmpDir.absolutePath
        pb.environment()["PROOT_LOADER"] = File(binDir, "loader").absolutePath
        Log.i(TAG, "spawn: ${buildCommand(port).joinToString(" ")}")
        return pb.start()
    }

    /** 从 stdout 抓 `dsh web: <授权URL>`；同时把最近的输出留在 logTail 里 */
    private fun awaitUrl(p: Process): String? {
        val deadline = System.currentTimeMillis() + URL_TIMEOUT_MS
        p.inputStream.bufferedReader().useLines { lines ->
            for (line in lines) {
                push(line)
                URL_RE.find(line)?.let { return it.groupValues[1] }
                if (System.currentTimeMillis() > deadline) return null
            }
        }
        return null
    }

    /** 303 才算 ready；401 说明服务活着但没带 token */
    private fun probe(url: String): Boolean = runCatching {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.instanceFollowRedirects = false
        conn.connectTimeout = 5_000
        conn.readTimeout = 5_000
        conn.requestMethod = "GET"
        val code = conn.responseCode
        conn.disconnect()
        Log.i(TAG, "probe $code")
        code == HttpURLConnection.HTTP_SEE_OTHER   // 303
    }.getOrDefault(false)

    // ---------------------------------------------------------------- helper

    private fun runHostShell(script: String, timeoutMs: Long): Int {
        val bash = File(binDir, "bash")
        // -c 而不是 -lc：登录 shell 会去 source /etc/profile 之类，PATH 可能被换掉，
        // 导致 rm/mv 变成 command not found，且失败现场只剩一行 exit=1。
        val pb = ProcessBuilder(bash.absolutePath, "-c", script)
        pb.directory(filesDir)
        pb.redirectErrorStream(true)
        pb.environment().remove("LD_LIBRARY_PATH")
        val p = pb.start()
        p.inputStream.bufferedReader().useLines { lines -> lines.forEach { push(it) } }
        val done = p.waitFor(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
        if (!done) { p.destroyForcibly(); return -1 }
        return p.exitValue()
    }

    private fun push(line: String) {
        synchronized(logTail) {
            if (logTail.size >= 64) logTail.removeFirst()
            logTail.addLast(line)
        }
    }

    private fun tail(): String = synchronized(logTail) {
        logTail.takeLast(12).joinToString("\n")
    }

    /** java.lang.Process 在 Android 上没有 pid()，扫 /proc 兜底 */
    private fun findPidOf(p: Process): Long? = runCatching {
        val marker = rootfsDir.absolutePath
        File("/proc").listFiles()?.firstOrNull { dir ->
            val pid = dir.name.toLongOrNull() ?: return@firstOrNull false
            val cmdline = File(dir, "cmdline").takeIf { it.canRead() }?.readText() ?: return@firstOrNull false
            pid > 0 && cmdline.contains(marker) && cmdline.contains("proot")
        }?.name?.toLongOrNull()
    }.getOrNull()
}
