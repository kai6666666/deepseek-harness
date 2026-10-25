package com.dsh.android.runtime

import android.content.Context
import android.util.Log
import java.io.File

/**
 * Alpine 档启动器（G-03 的核心）：把「起 node」翻译成一条 proot 命令。
 *
 * 设计原则：**可用就换、不可用就完全不动**。
 *   - `availability()` 三态清楚说明缺什么；
 *   - 引擎侧只在 `usable == true` 时改命令行，否则逐字节维持改造前的 Termux 路径 ——
 *     所以「没拉 rootfs」「缺 proot」都不会让 App 变哑。
 *
 * ⚠️ 已知硬依赖：proot 二进制（`libproot.so` + `proot-loader.so`）必须随 APK 提供。
 *    没有时这里会返回 [RuntimeAvailability.ProotMissing]，**不会假装成功**。
 *    取法见 tools/proot/README.md（从 Termux proot 包提取，或自己编）。
 */
/**
 * G-08：ABI 探测。
 *
 * 随包的 proot / rootfs 只有 aarch64（x86_64 留给模拟器变体）。armv7 / riscv 上
 * 硬跑的典型症状是 proot 一启动就 `Exec format error`，比「启动失败」难查得多。
 * 所以把判断提到最前面，判不了就明确说「不支持」，让引擎回 Termux 档。
 */
object Abi {
    /** 随包二进制覆盖的 ABI 列表（顺序即优先级）。 */
    val SUPPORTED = listOf("arm64-v8a", "x86_64")

    fun best(abis: Array<String> = android.os.Build.SUPPORTED_ABIS): String? =
        SUPPORTED.firstOrNull { it in abis }

    fun deviceSummary(abis: Array<String> = android.os.Build.SUPPORTED_ABIS): String =
        abis.joinToString(",").ifEmpty { "unknown" }
}

class AlpineRuntime private constructor(
    private val context: Context,
    private val dshHome: File,
    private val workspace: File,
) {

    val rootfs: File = File(File(context.filesDir, "runtime"), RuntimeBackend.ALPINE.dirName)

    /**
     * proot 的 DT_NEEDED 是 **`libtalloc.so.2`**（带 soname 后缀），而 jniLibs 只能打
     * `libtalloc.so` —— 系统解包目录 `nativeLibraryDir/` 里永远没有 `.so.2`，真机直接：
     *
     *     CANNOT LINK EXECUTABLE "…/lib/arm64/libproot.so": library "libtalloc.so.2" not found
     *
     * （2026-10-25 21:30:42 实证）。解法：把三件套解到 `files/runtime/native/`，
     * **按 soname 补一份 `libtalloc.so.2`**，再让 proot 从那里加载
     * （`LD_LIBRARY_PATH` 见 [prepareProcessEnvironment]）。
     */
    private fun ensureProotLibs(): File {
        val dst = nativeLibsDir()
        if (!dst.isDirectory) dst.mkdirs()
        val src = context.applicationInfo.nativeLibraryDir
        if (src.isNullOrEmpty()) return dst
        fun put(from: String, to: String) {
            val f = File(src, from)
            if (!f.isFile) return
            val t = File(dst, to)
            if (t.isFile && t.length() == f.length()) return
            runCatching { f.copyTo(t, overwrite = true) }
                .onFailure { Log.w(TAG, "解出 $to 失败：${it.message}") }
        }
        put("libtalloc.so", "libtalloc.so.2")   // ← 真正的 soname，缺它 proot 起不来
        put("libtalloc.so", "libtalloc.so")     // 兼容 dlopen("libtalloc.so") 的写法
        put("libandroid-shmem.so", "libandroid-shmem.so")
        put("libproot.so", "libproot.so")
        File(dst, "libproot.so").takeIf { it.isFile }?.setExecutable(true)
        return dst
    }

    /**
     * 清掉上一轮遗留的 proot / node 孤儿。
     *
     * 为什么需要：`--kill-on-exit` 只在 proot **正常退出**时收子进程。App 被 ROM 冻结、
     * 被 SIGKILL、或进程直接崩掉时，proot+node 会挂到 init 下（PPID=1）并继续占着
     * 3080/3081 —— 新一轮引擎「起了但 web 打不开」，表现就像启动失败。
     *
     * 只杀「PPID<=1 且命令行同时含 libproot.so 与本 rootfs 路径」的进程，
     * 不碰 Termux 档、不碰本进程、不碰别的 App。
     */
    private fun killStaleRuntime() {
        val self = android.os.Process.myPid()
        runCatching {
            val p = ProcessBuilder("ps", "-A", "-o", "PID,PPID,ARGS")
                .redirectErrorStream(true)
                .start()
            val lines = p.inputStream.bufferedReader().use { it.readLines() }
            p.waitFor()
            var killed = 0
            for (line in lines) {
                if (!line.contains("libproot.so") || !line.contains(rootfs.absolutePath)) continue
                val parts = line.trim().split(Regex("\\s+"), limit = 3)
                val pid = parts.getOrNull(0)?.toIntOrNull() ?: continue
                val ppid = parts.getOrNull(1)?.toIntOrNull() ?: continue
                if (pid == self || ppid > 1) continue
                runCatching { android.system.Os.kill(pid, android.system.OsConstants.SIGKILL) }
                    .onSuccess { killed++ }
            }
            if (killed > 0) Log.w(TAG, "清理了 $killed 个残留 proot 孤儿（上一轮 kill-on-exit 没收到信号）")
        }.onFailure { Log.w(TAG, "清理残留 proot 失败：${it.message}") }
    }

    /**
     * 把「alpine 档起不来」变成一次**有记忆的降级**，而不是每次启动都撞同一堵墙。
     *
     * 真机（Redmi / Android 16 / 2026-10-25）现状：proot 能起、命令行正确、rootfs 完整可执行位也补齐，
     * 但 guest 内所有 `execve` 都返回 EACCES（`/usr/bin/env`、`/bin/busybox` 都一样）。
     * 这需要一个专项 A/B（proot 版本 / bin 目录 st_mode / seccomp），短期不能靠改一行代码收口。
     * 因此：失败就降到 Termux 档，App 立刻可用；72 小时后自动再试一次 alpine。
     */
    fun forceTermux(reason: String) {
        runCatching {
            // 四行：时间戳 / 安装版本戳 / rootfs 指纹 / 原因。
            forceFlag().writeText(
                "${System.currentTimeMillis()}\n${installStamp()}\n${envFingerprint()}\n$reason\n",
            )
            Log.w(TAG, "alpine 档已降级为 Termux（rootfs 指纹变化时会自动重试）：$reason")
        }
    }

    /** APK 的 lastUpdateTime —— 每次重装都会变。 */
    private fun installStamp(): Long = runCatching {
        context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime
    }.getOrDefault(0L)

    /**
     * rootfs 关键二进制的 `mode + size` 指纹。
     *
     * 它变了 = 我们动过 rootfs（例如把 0755 降成 0555 试 W^X）→ 值得再试一次 alpine。
     * 这样「降级」不会把新修法一起挡住，也不需要用户清数据。
     */
    private fun envFingerprint(): Long {
        val f = File(rootfs, "bin/busybox")
        return runCatching {
            val st = android.system.Os.stat(f.absolutePath)
            ((st.st_mode and 0x1FF).toLong() shl 32) or (st.st_size and 0xFFFFFFFFL)
        }.getOrDefault(0L)
    }

    private fun forceFlag(): File = File(File(context.filesDir, "runtime"), "force-termux")

    /** 标记有效（rootfs 指纹未变）→ 跳过 alpine，直接用 Termux。 */
    private fun forcedToTermux(): Boolean {
        val f = forceFlag()
        if (!f.isFile) return false
        val lines = runCatching { f.readLines() }.getOrDefault(emptyList())
        val saved = lines.getOrNull(2)?.toLongOrNull()
        val now = envFingerprint()
        if (saved == null || (now != 0L && saved != now)) {
            runCatching { f.delete() }
            Log.i(TAG, "rootfs 指纹变了（saved=$saved now=$now），清掉降级标记并重试 alpine")
            return false
        }
        Log.i(TAG, "降级标记命中（rootfs 指纹未变），本轮用 Termux 档")
        return true
    }

    /** busybox applet 里引擎跑起来必需（或极常用）的那批，缺失就复制 busybox 顶上。 */
    private val BUSYBOX_APPLETS = listOf(
        "env", "sh", "ash", "ls", "cat", "cp", "mv", "rm", "mkdir", "rmdir", "ln",
        "chmod", "chown", "grep", "egrep", "sed", "awk", "find", "tar", "gzip",
        "gunzip", "touch", "head", "tail", "wc", "sort", "uniq", "xargs",
        "basename", "dirname", "true", "false", "sleep", "kill", "ps", "du", "df",
        "id", "whoami", "printf", "echo", "mktemp", "readlink", "stat", "cut", "tr",
        "tee", "date", "uname", "test", "expr", "seq", "sed",
    ).distinct()

    /**
     * 幂等修 rootfs 里的执行位 + 兜住 `/usr/bin/env` 缺失。
     *
     * 真机（Redmi / Android 16）表现：
     *   proot error: execve("/usr/bin/env"): Permission denied
     *   → 引擎 2846 ms 退出 → 界面「引擎启动失败」→ 连续 10 次 → 救援模式
     *
     * 两个成因一起治：
     *   ① 解包丢了 tar 的 mode 位（一律 0644）→ 补 0755；
     *   ② `/usr/bin/env` 在 Alpine 里是 busybox 的软链，若缺失/断链 → 补建 → /bin/busybox。
     */
    private fun repairExecBits(root: File): Int {
        // ① 目录位：目录缺 x 位时，proot 内 execve 一样返回 EACCES，而宿主侧
        //    `File.canExecute()` 只看 owner 位，完全看不出来 —— 这是本轮要拿的真凭据。
        var dirFixed = 0
        listOf("", "bin", "sbin", "usr", "usr/bin", "usr/sbin", "usr/libexec", "lib", "usr/lib", "etc", "tmp")
            .forEach { rel ->
                val d = if (rel.isEmpty()) root else File(root, rel)
                if (!d.isDirectory) return@forEach
                val mode = runCatching {
                    android.system.Os.stat(d.absolutePath).st_mode and 0x1FF
                }.getOrDefault(0)
                // 0755=493，01777=1023；0x49=0b001001001 是三个 x 位
                val want = if (rel == "tmp") 1023 else 493
                if ((mode and 0x49) != 0x49) {
                    runCatching { android.system.Os.chmod(d.absolutePath, want) }
                        .onSuccess { dirFixed++ }
                    Log.w(TAG, "目录 $rel mode=${"%03o".format(mode)} → 补 ${"%03o".format(want)}")
                } else if (rel == "bin" || rel == "usr/bin" || rel.isEmpty()) {
                    Log.i(TAG, "目录 $rel mode=${"%03o".format(mode)}（正常）")
                }
            }
        if (dirFixed > 0) Log.w(TAG, "目录缺执行位：已补 $dirFixed 个")
        val dirs = listOf("bin", "sbin", "usr/bin", "usr/sbin", "usr/libexec", "lib", "usr/lib")
        var fixed = 0
        dirs.forEach { rel ->
            val d = File(root, rel)
            if (!d.isDirectory) return@forEach
            d.walkTopDown().forEach { f ->
                if (f.isFile) {
                    // 统一 **0555**：Android 15/16 对 app 数据目录里 **owner 可写** 的文件
                    // 另加了 execve 限制（W^X），命中时 kernel 直接回 EACCES —— 正是
                    // `proot error: execve("/bin/busybox"): Permission denied` 的形状。
                    // 已经 0755 的老 rootfs 也必须降权，所以这里不判 canExecute。
                    val wasExec = f.canExecute()
                    runCatching { android.system.Os.chmod(f.absolutePath, 0b101_101_101) }
                        .onSuccess { if (!wasExec) fixed++ }
                }
            }
        }
        val env = File(root, "usr/bin/env")
        // 真机日志实证：`env exists=false exec=false real=…/usr/bin/env busybox=true`
        // —— 不是权限位问题，是 **`/usr/bin/env` 这一条压根不存在**。
        // 原因：Alpine 的 busybox applet 在 tar 里是**硬链接**，我们的解包器只处理
        // file/dir/symlink，硬链接条目被跳过 → env/sh/ls/cat… 全部消失。
        // 现在按「复制 busybox 并按 argv[0] 当 applet 用」补齐（busybox 天然支持）。
        val busybox = File(root, "bin/busybox")
        if (busybox.isFile && busybox.canExecute()) {
            var made = 0
            BUSYBOX_APPLETS.forEach { name ->
                val f = File(root, "usr/bin/$name")
                if (f.exists()) return@forEach
                runCatching {
                    f.parentFile?.mkdirs()
                    busybox.copyTo(f, overwrite = true)
                    android.system.Os.chmod(f.absolutePath, 0b111_101_101)
                }.onSuccess { made++ }
            }
            // /bin/sh 必须存在：引擎 spawn 子进程、node 的 child_process 都靠它
            val sh = File(root, "bin/sh")
            if (!sh.exists()) {
                runCatching {
                    busybox.copyTo(sh, overwrite = true)
                    android.system.Os.chmod(sh.absolutePath, 0b111_101_101)
                }.onSuccess { Log.w(TAG, "补建 /bin/sh（复制 busybox）") }
                    .onFailure { Log.e(TAG, "补建 /bin/sh 失败：${it.message}") }
            }
            if (made > 0) {
                Log.w(TAG, "补建 busybox applet $made 个（rootfs 解包丢了硬链接条目）")
            }
        } else {
            Log.e(TAG, "busybox 不可用：${busybox.absolutePath} exists=${busybox.exists()}")
        }
        val real = runCatching { env.canonicalPath }.getOrNull()
        Log.i(
            TAG,
            "rootfs 自检：env exists=${env.exists()} exec=${env.canExecute()} real=$real " +
                "busybox=${File(root, "bin/busybox").canExecute()} 补位=$fixed 目录补位=$dirFixed",
        )
        return dirFixed
    }

    /** `files/runtime/native/` —— 自己掌控的 proot 依赖目录（含 `libtalloc.so.2`）。 */
    private fun nativeLibsDir(): File = File(File(context.filesDir, "runtime"), "native")

    /** 优先用自己解出的副本（同目录带 `libtalloc.so.2`），再退回 jniLibs / Termux。 */
    private fun findProot(): File? {
        val local = File(ensureProotLibs(), "libproot.so")
        if (local.isFile) {
            if (!local.canExecute()) local.setExecutable(true)
            return local
        }
        return candidates(PROOT_NAMES).firstOrNull()
    }

    private fun findLoader(): File? {
        val local = File(nativeLibsDir(), "proot-loader.so")
        if (local.isFile) return local
        return candidates(LOADER_NAMES).firstOrNull()
    }

    private fun candidates(names: List<String>): Sequence<File> = sequence {
        yieldAll(names.map { File(context.filesDir, it) })
        // ⚠️ Context 没有 `nativeLibraryDir` 属性（编译期 Unresolved reference），
        //    真实入口是 ApplicationInfo.nativeLibraryDir。
        val nativeDir = context.applicationInfo.nativeLibraryDir
        if (!nativeDir.isNullOrEmpty()) {
            // jniLibs 里的 .so 会被解到 nativeLibraryDir（可执行位通常是 0755）
            yieldAll(names.map { File(nativeDir, it.substringAfterLast('/')) })
        }
        // 兜底：Termux 里若装了 proot，直接借用
        yield(File(context.filesDir, "termux/usr/bin/proot"))
    }.filter { it.isFile && it.canExecute() }

    fun availability(): RuntimeAvailability {
        // G-08：先判 ABI。跑到一半才 exec format error 是最难查的一种。
        val abi = Abi.best()
        if (abi == null) {
            Log.w(TAG, "ABI 不受支持：设备=[${Abi.deviceSummary()}]，随包=[${Abi.SUPPORTED.joinToString()}]")
            return RuntimeAvailability.UnsupportedAbi(android.os.Build.SUPPORTED_ABIS.toList())
        }
        Log.i(TAG, "运行时 ABI=$abi（设备=[${Abi.deviceSummary()}]）")
        val node = File(rootfs, "usr/bin/node")
        if (!node.isFile) {
            return RuntimeAvailability.NotProvisioned("rootfs 未解包：${rootfs.absolutePath}")
        }
        val proot = findProot() ?: return RuntimeAvailability.ProotMissing(rootfs, "libproot.so")
        // proot 5.1.x 把 loader 内嵌进二进制 → 外置 loader 可有可无
        val loader = findLoader()
        return RuntimeAvailability.Ready(rootfs, proot, loader)
    }

    /**
     * 拼引擎命令行。返回 null = 本档不可用，调用方必须原样走 Termux。
     *
     * 路径全部用 **guest 视角**：rootfs 是 `/`，`dshHome` 挂在 `/dsh-home`，
     * `workspace` 挂在 `/workspace`。宿主绝对路径一旦漏进来，guest 里就是 ENOENT。
     */
    fun engineCommand(profile: String, overlays: List<File>, port: Int?): List<String>? {
        val av = availability()
        if (av !is RuntimeAvailability.Ready) {
            Log.i(TAG, "alpine 档不可用，回退 Termux：${av.describe()}")
            return null
        }
        // 权限自愈（幂等）：**必须在 forcedToTermux() 之前**，否则降级标记会把
        // 「刚补好目录/文件执行位」的新版本也一起挡回 Termux，永远看不到 alpine 的真实结果。
        val dirFixed = repairExecBits(rootfs)
        if (dirFixed > 0) {
            Log.i(TAG, "目录执行位已补 $dirFixed 个（不删降级标记：修好一次就够，别让每轮都重撞 alpine）")
        }
        if (forcedToTermux()) {
            Log.i(TAG, "上次 alpine 启动失败，本轮直接用 Termux 档（标记：${forceFlag().absolutePath}）")
            return null
        }
        // 上一轮若被 SIGKILL / 被 ROM 冻结，`--kill-on-exit` 收不到信号，
        // proot+node 会变成 PPID=1 的孤儿并占着 3080 —— 新引擎于是「起了但连不上」。
        // 真机实证：杀完两个孤儿 (13689/19234) 后端口才回到手里。
        killStaleRuntime()
        // 引擎实际装在 `filesDir/engine`（EngineManager.engineDir），**不是** `$DSH_HOME/engine`。
        // 以前只认 .dsh/engine → 真机永久命中「engine 里没有 bin.js」→ 一直回退 Termux；
        // 而 Termux 档没有 per-guest 的 `--link2symlink`，引擎给 session 做原子写用的 link()
        // 在部分设备/ROM 上直接 EACCES（真机实证：session.v4.jsonl.zstd.tmp → .zstd）。
        // 顺序：先老布局（.dsh/engine），再当前布局（filesDir/engine）。
        val engineCandidates = listOf(
            File(dshHome, "engine"),
            File(context.filesDir, "engine"),
        )
        val hostEngine = engineCandidates.firstOrNull {
            File(it, "node_modules/@deepseek-ai/dsh/lib/bin.js").isFile
        }
        if (hostEngine == null) {
            Log.w(
                TAG,
                "两处都没有引擎 bin.js（${engineCandidates.joinToString { it.absolutePath }}），回退 Termux",
            )
            return null
        }
        if (hostEngine != engineCandidates[0]) {
            Log.i(TAG, "引擎在 ${hostEngine.absolutePath}，将额外 bind 到 guest /dsh-home/engine")
        }

        val argv = ArrayList<String>(48)
        argv += av.proot.absolutePath
        // A/B：先去掉 `--link2symlink`。它在 proot 5.1 里会重写 hardlink 的解析路径，
// 与 Android 16 的 execve 路径检查叠加时最容易出「一切权限都对、execve 却 EACCES」。
        argv += listOf("-r", av.rootfs.absolutePath, "-w", GUEST_WORKSPACE)
        argv += listOf("-b", "/dev:/dev", "-b", "/proc:/proc")
        argv += listOf("-b", "${dshHome.absolutePath}:/dsh-home")
        // 引擎若不在 `$DSH_HOME/engine`（当前布局就是），单独 bind 进去 ——
        // guest 内路径恒为 `/dsh-home/engine`，GUEST_ENGINE_BIN 因此不用改。
        // proot 的 bind 允许后一条覆盖前一条的子路径，顺序敏感，别调换。
        val legacyEngine = File(dshHome, "engine")
        if (hostEngine != legacyEngine) {
            argv += listOf("-b", "${hostEngine.absolutePath}:/dsh-home/engine")
        }
        argv += listOf("-b", "${workspace.absolutePath}:$GUEST_WORKSPACE")
        argv += "--kill-on-exit"
        // ⚠️ 不要用 `/usr/bin/env`：Alpine 里它是 **busybox 的硬链接条目**，我们的
        // TarGzExtractor 不解硬链接 → 真机上 `env exists=false`，于是 proot 第一条命令就
        // `execve("/usr/bin/env"): Permission denied`（引擎 2.8 s 退出 → 连续 10 次 → 救援模式）。
        // 直接调 `/bin/busybox env`：busybox 的 env applet 支持 `env K=V PROG` 语法，
        // 不依赖任何被丢掉的硬链接。
        val busyboxInGuest = "/bin/busybox"
        argv += busyboxInGuest
        argv += "env"
        argv += guestEnv()
        argv += "/usr/bin/node"
        argv += GUEST_ENGINE_BIN
        argv += listOf("--profile", profile)
        // overlay 在 dshHome 里 → 换成 guest 路径；不在 dshHome 下的只能放弃（不允许越界绑定）
        for (patch in overlays) {
            val rel = runCatching { patch.relativeTo(dshHome).invariantSeparatorsPath }.getOrNull() ?: continue
            if (rel.startsWith("..")) {
                Log.w(TAG, "overlay 不在 DSH_HOME 下，跳过：${patch.absolutePath}")
                continue
            }
            argv += listOf("--patch", "$GUEST_DSH_HOME/$rel")
        }
        port?.let { argv += listOf("--port", it.toString()) }
        argv += "--no-open"
        return argv
    }

    /**
     * 覆盖宿主进程环境：Termux 那套（PREFIX/PATH/SSL_CERT_FILE）指向的是 bionic 世界，
     * 带进 proot 会让 guest 里的 `/usr/bin/node` 找不到 musl loader。
     *
     * 只删明确有害的键，不做 `clear()`——保留 ANDROID_* 之类的系统变量更安全。
     */
    fun prepareProcessEnvironment(env: MutableMap<String, String>) {
        val av = availability() as? RuntimeAvailability.Ready ?: return
        DROP_KEYS.forEach { env.remove(it) }
        env["PROOT_NO_SECCOMP"] = "1"
        env["PROOT_TMP_DIR"] = context.cacheDir.absolutePath
        // 只有外置 loader 存在时才设；内嵌 loader 的 proot 不认这个变量也无害
        av.loader?.let { env["PROOT_LOADER"] = it.absolutePath }
        env["TMPDIR"] = context.cacheDir.absolutePath
        // proot 的 `libtalloc.so.2` 只有我们自己解出的目录里才有（见 ensureProotLibs），
        // 系统 nativeLibraryDir 里那个叫 `libtalloc.so`，soname 对不上。
        env["LD_LIBRARY_PATH"] = nativeLibsDir().absolutePath
        Log.i(TAG, "已切到 alpine 档：rootfs=${av.rootfs.name} proot=${av.proot.name}")
    }

    private fun guestEnv(): List<String> = listOf(
        // 去掉 `-0`（fake root）后 guest 内 uid 就是 app uid，`/root` 往往不可写 → 落到 /tmp。
        "HOME=/tmp",
        "PREFIX=/usr",
        "LANG=C.UTF-8",
        "LC_ALL=C.UTF-8",
        "TERM=xterm-256color",
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "DSH_HOME=$GUEST_DSH_HOME",
        "TMPDIR=/tmp",
        "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
        "CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt",
        "NODE_OPTIONS=--max-old-space-size=1024",
    )

    companion object {
        private const val TAG = "DSH/AlpineRuntime"
        const val GUEST_WORKSPACE = "/workspace"
        const val GUEST_DSH_HOME = "/dsh-home"
        const val GUEST_ENGINE_BIN = "$GUEST_DSH_HOME/engine/node_modules/@deepseek-ai/dsh/lib/bin.js"

        private val PROOT_NAMES = listOf("bin/libproot.so", "bin/proot")
        private val LOADER_NAMES = listOf("bin/proot-loader.so", "bin/libproot-loader.so")
        private val DROP_KEYS = listOf(
            "PREFIX", "LD_PRELOAD", "LD_LIBRARY_PATH", "SSL_CERT_FILE", "CURL_CA_BUNDLE",
            "NODE_OPTIONS", "DSH_HOME", "HOME", "TMPDIR",
        )

        fun create(context: Context, dshHome: File, workspace: File): AlpineRuntime =
            AlpineRuntime(context, dshHome, workspace)
    }
}