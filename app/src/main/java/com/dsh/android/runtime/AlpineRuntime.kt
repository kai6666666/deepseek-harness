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
        argv += listOf("-r", av.rootfs.absolutePath, "-0", "-w", GUEST_WORKSPACE, "--link2symlink")
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
        argv += "/usr/bin/env"
        argv += guestEnv()
        argv += "--"
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
        "HOME=/root",
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