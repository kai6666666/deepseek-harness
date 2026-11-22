package com.dsh.android.runtime

import java.io.File
import java.util.TimeZone

/**
 * direct（免 proot）启动的决策与计划层。纯 JVM，不碰 Android API，可直接单测。
 *
 * ## 为什么需要它
 * 真机实测（Xiaomi 25104RADAC / Android 16 / arm64-v8a）：
 * 用 glibc 的 `ld-linux-aarch64.so.1` 直起 rootfs 里的 node + 引擎：
 * - 到 `dsh web:` 就绪 **6.5 s**；同口径 proot 是 **32.6 s**（省 ≈26 s）。
 * - `bin.js --version` → `0.2.2-rc.5`，HTTP 探测 `401`（健康语义与 proot 一致）。
 *
 * ## 三道闸（缺一不可）
 * 1. **默认关**：存在 `files/direct-enabled` 才尝试（P4-c 验收通过后再考虑默认开）。
 * 2. **每 runtime 只试一次**：失败写 `files/direct-failed-<runtimeVersion>`，之后恒走 proot。
 * 3. **只管 web profile**：`startCommand`（工具/诊断的一次性 node 命令）恒走 proot，
 *    否则 guest 绝对路径的语义会跟工具输出对不上。
 */
internal object DirectLaunch {
    const val ENABLED_MARKER = "direct-enabled"
    private const val FAILED_PREFIX = "direct-failed-"

    private fun safe(version: String) = version.replace(Regex("[^A-Za-z0-9._-]"), "_")

    fun enabled(filesDir: File): Boolean = File(filesDir, ENABLED_MARKER).exists()

    fun failed(filesDir: File, runtimeVersion: String): Boolean =
        File(filesDir, FAILED_PREFIX + safe(runtimeVersion)).exists()

    fun markFailed(filesDir: File, runtimeVersion: String) {
        runCatching {
            File(filesDir, FAILED_PREFIX + safe(runtimeVersion))
                .writeText(System.currentTimeMillis().toString() + "\n")
        }
    }

    /**
     * loader 的选择顺序（P4-a′ 的关键）：
     * 1. `nativeLibraryDir/libld-linux.so` —— **唯一保证可执行的位置**（apk_data_file）；
     *    Android 10+ 不允许 untrusted_app execve app data 目录里的文件，vc93 真机实测
     *    `error=13, Permission denied`。
     * 2. rootfs 里的那份 —— 只对探针/调试（adb shell 域）有意义，App 进程会用不到。
     */
    fun loaderPath(rootfs: File, abi: String, nativeLibDir: File? = null): File? {
        nativeLibDir?.let { dir ->
            File(dir, "libld-linux.so").takeIf { it.isFile }?.let { return it }
        }
        return when (abi) {
            "arm64-v8a" -> File(rootfs, "usr/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1")
            "x86_64" -> File(rootfs, "usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2")
            else -> null
        }
    }

    private fun libraryPath(rootfs: File, abi: String): String {
        val triple = if (abi == "x86_64") "x86_64-linux-gnu" else "aarch64-linux-gnu"
        return listOf(
            File(rootfs, "usr/lib/$triple"),
            File(rootfs, "lib/$triple"),
            File(rootfs, "usr/lib"),
            File(rootfs, "lib"),
        ).joinToString(":") { it.absolutePath }
    }

    /** 缺失原因；null = 可以直启。 */
    fun unavailable(rootfs: File, abi: String, nativeLibDir: File? = null): String? {
        val loader = loaderPath(rootfs, abi, nativeLibDir) ?: return "unsupportedAbi"
        if (!File(rootfs, "usr/bin/node").canExecute()) return "runtimeIncomplete"
        if (!loader.canExecute()) return "runtimeIncomplete"
        if (!File(rootfs, "opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js").isFile) return "runtimeUpdateRequired"
        return null
    }

    data class Plan(
        val argv: List<String>,
        val environment: Map<String, String>,
        val cwd: File,
        val pidFile: File,
        val patches: Int,
    )

    /**
     * 组装 direct 启动计划；返回 null = 本次不直启（调用方走 proot）。
     *
     * @param port "0" 让引擎自选回环端口（与 manifest 模板里的 {PORT} 一致）。
     */
    fun plan(
        rootfs: File,
        filesDir: File,
        abi: String,
        profile: String,
        overlays: List<File>,
        extraEnv: Map<String, String>,
        port: String = "0",
        nativeLibDir: File? = null,
    ): Plan? {
        if (unavailable(rootfs, abi, nativeLibDir) != null) return null
        val loader = loaderPath(rootfs, abi, nativeLibDir) ?: return null
        val node = File(rootfs, "usr/bin/node")
        val binJs = File(rootfs, "opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js")
        val home = File(filesDir, "home")
        val dshHome = File(home, ".dsh")
        val tmp = File(rootfs, "tmp")
        val ca = File(rootfs, "etc/ssl/certs/ca-certificates.crt")
        val root = File(rootfs, "root")
        listOf(tmp, home, dshHome, root).forEach { it.mkdirs() }

        val argv = buildList {
            add(loader.absolutePath)
            add("--library-path")
            add(libraryPath(rootfs, abi))
            add(node.absolutePath)
            add(binJs.absolutePath)
            add("--profile")
            add(profile)
            overlays.forEach { o ->
                add("--patch")
                add(o.absolutePath)
            }
            // 子命令必须在全局选项之后（与 manifest 模板 `/usr/local/bin/dsh --profile web … web` 同序）。
            add("web")
            add("--host")
            add("127.0.0.1")
            add("--port")
            add(port)
            add("--no-open")
        }

        val env = buildMap {
            put("HOME", home.absolutePath)
            put("DSH_HOME", dshHome.absolutePath)
            put("DSH_USER_HOME", home.absolutePath)
            put("DSH_FILES", filesDir.absolutePath)
            // ⚠️ direct 必需：宿主的 /tmp 不存在，缺它 spill-local 直接 EACCES mkdtemp。
            put("TMPDIR", tmp.absolutePath)
            put("TMP", tmp.absolutePath)
            put("TEMP", tmp.absolutePath)
            put(
                "PATH",
                listOf("usr/local/sbin", "usr/local/bin", "usr/sbin", "usr/bin", "sbin", "bin")
                    .joinToString(":") { File(rootfs, it).absolutePath },
            )
            put("NODE_PATH", File(rootfs, "opt/dsh/node_modules").absolutePath)
            put("NODE_OPTIONS", "--dns-result-order=ipv4first")
            put("LANG", "C.UTF-8")
            put("TERM", "xterm-256color")
            put("SHELL", "/bin/bash")
            if (ca.isFile) {
                put("SSL_CERT_FILE", ca.absolutePath)
                put("CURL_CA_BUNDLE", ca.absolutePath)
                put("REQUESTS_CA_BUNDLE", ca.absolutePath)
            }
            runCatching { put("TZ", TimeZone.getDefault().id) }
            putAll(extraEnv)
        }

        return Plan(argv, env, root, File(tmp, "dsh-web.pid"), overlays.size)
    }
}
