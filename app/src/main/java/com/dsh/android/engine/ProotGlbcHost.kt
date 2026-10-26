package com.dsh.android.engine

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket

/**
 * C 方案宿主：proot(Ubuntu, glibc) 里跑官方 dsh。
 *
 * 关键点（全部来自上游源码，不是猜测）
 * ------------------------------------
 * · 跑的是 **glibc 版 node** ⇒ `process.platform === 'linux'`，
 *   官方 `PLATFORM_CHAINS.linux` / `ui-sidebar-*` / preset 判定全部走 linux 分支。
 * · `sandbox-local` 一旦拿到 `runnerCommand` 就**跳过平台探测**并断言 full enforcement
 *   （`sandbox-local/src/index.ts:328-335`），所以本机内核没有 userns / Landlock
 *   也不会 fail-closed，也不会每次白等 5 秒 probe。
 * · 沙箱强度仍是「用户态拦截」：本机 `CONFIG_USER_NS` / `CONFIG_SECURITY_LANDLOCK`
 *   均未编入（实测），这是宿主换不来的部分，必须在设置页如实告知。
 *
 * 目录约定（与 [EngineStartSpec] 一致）
 * -----------------------------------
 *   filesDir/bin/proot                      静态 aarch64 proot
 *   filesDir/ubuntu/                        Ubuntu base rootfs（glibc 2.39）
 *   filesDir/ubuntu/usr/local/bin/boo-sandbox-run
 *   filesDir/ubuntu/usr/local/lib/libboosandbox.so
 *   filesDir/ubuntu/usr/local/lib/liblinkcompat.so
 *   filesDir/home/.dsh/                     $DSH_HOME（与 bionic 宿主共用，可迁移）
 */
class ProotGlbcHost(private val filesDir: File) : EngineHost {

    override val id: String = "proot-glibc"

    private var process: Process? = null

    private val rootfs: File get() = File(filesDir, "ubuntu")
    private val prootBin: File get() = File(filesDir, "bin/proot")
    private val tmpDir: File get() = File(filesDir, "tmp").apply { mkdirs() }
    private val sandboxRunner: File get() = File(rootfs, "usr/local/bin/boo-sandbox-run")
    private val linkCompatLib: File get() = File(rootfs, "usr/local/lib/liblinkcompat.so")

    override fun capabilities(): HostCapabilities = HostCapabilities(
        platform = "linux",
        kernelSandbox = false,
        sandboxRunner = if (sandboxRunner.isFile) {
            SandboxRunner(
                command = listOf(sandboxRunner.absolutePath),
                failureSignatures = listOf("boo-sandbox-run: "),
            )
        } else {
            null
        },
        pty = true,
        imagePipeline = true,
        nativePrebuilds = NativePrebuildKind.GLIBC_PREBUILT,
        pidNamespace = false,
        summary = "官方 glibc 预编译全可用；文件沙箱为用户态拦截（本机内核无 userns/Landlock）",
    )

    override suspend fun start(spec: EngineStartSpec): EngineEndpoint = withContext(Dispatchers.IO) {
        requireReady()
        val overlay = writeOverlay(spec)
        val argv = buildCommand(spec, overlay)

        spec.engineLog.parentFile?.mkdirs()
        Log.i(TAG, "启动 proot 宿主: ${argv.joinToString(" ")}")

        val builder = ProcessBuilder(argv)
            .redirectErrorStream(true)
            .redirectOutput(ProcessBuilder.Redirect.appendTo(spec.engineLog))
        val proc = try {
            builder.start()
        } catch (t: IOException) {
            throw EngineHostException("proot 启动失败: ${t.message}", t)
        }
        process = proc

        awaitListening(spec.port, proc)
        EngineEndpoint(baseUrl = spec.baseUrl, pid = proc.pid(), logFile = spec.engineLog)
    }

    override suspend fun stop() = withContext(Dispatchers.IO) {
        process?.let { p ->
            runCatching { p.destroy() }
            delay(300)
            if (p.isAlive) runCatching { p.destroyForcibly() }
        }
        process = null
        Unit
    }

    override fun isRunning(): Boolean = process?.isAlive == true

    // ── 内部 ────────────────────────────────────────────────────────────

    private fun requireReady() {
        if (!prootBin.isFile) throw EngineHostException(
            "缺少 proot: ${prootBin.absolutePath}\n" +
                "把静态 aarch64 proot 放到 filesDir/bin/proot 并 chmod 0755。"
        )
        if (!ProotManifest.node(rootfs).isFile) throw EngineHostException(
            "rootfs 里没有 glibc node: ${ProotManifest.node(rootfs).absolutePath}\n" +
                "先解包 Ubuntu base，再装 Node 22/24（官方 linux-arm64 tarball 或 NodeSource）。"
        )
        if (!linkCompatLib.isFile) throw EngineHostException(
            "缺少 liblinkcompat.so: ${linkCompatLib.absolutePath}\n" +
                "SELinux 在 proot 里同样生效（同一内核），link() 仍会 EACCES，必须预载转译层。"
        )
    }

    /** 把宿主的运行期事实写成 overlay —— 声明而不是 Kotlin 字符串锚点。 */
    private fun writeOverlay(spec: EngineStartSpec): File {
        spec.dshHome.mkdirs()
        val file = File(spec.dshHome, "android-glibc.patch.yml")
        val policyLine = when (spec.sandboxMode) {
            SandboxMode.DANGER_FULL_ACCESS -> "- id: sandbox-policy\n  config:\n    mode: danger-full-access\n"
            else -> ""
        }
        val index = File(spec.dshHome, "session-index.sqlite").absolutePath
        val runner = capabilities().sandboxRunner
        val sandboxBlock = if (runner != null) {
            buildString {
                appendLine("- id: sandbox")
                appendLine("  config:")
                appendLine("    runnerCommand: ['${runner.command.first()}']")
                appendLine("    runnerFailureSignatures: ['${runner.failureSignatures.first()}']")
                appendLine("    probeTimeoutMs: 5000")
            }
        } else {
            ""
        }
        file.writeText(
            buildString {
                appendLine("# 由 ProotGlbcHost 生成，每次启动整体覆盖")
                append(sandboxBlock)
                append(policyLine)
                appendLine("- id: session-query-sqlite")
                appendLine("  config:")
                appendLine("    path: '$index'")
                appendLine("    openAt: first-search")
                appendLine("- id: plugin-manager")
                appendLine("  config:")
                appendLine("    registry: 'https://registry.npmmirror.com/'")
                appendLine("    fallbackRegistries:")
                appendLine("      - 'https://registry.npmmirror.com/'")
                appendLine("      - 'https://registry.npmjs.org/'")
            }
        )
        Log.i(TAG, "已写入宿主 overlay: ${file.name}")
        return file
    }

    private fun buildCommand(spec: EngineStartSpec, overlay: File): List<String> {
        val argv = mutableListOf<String>()
        argv += prootBin.absolutePath
        argv += listOf("--kill-on-exit", "-r", rootfs.absolutePath)
        // 只 bind 必要路径：系统、共享 $DSH_HOME、工作区、临时区。
        argv += listOf("-b", "/dev", "-b", "/proc", "-b", "/sys", "-b", "/system")
        argv += listOf("-b", "${spec.dshHome.absolutePath}:${spec.dshHome.absolutePath}")
        argv += listOf("-b", "${spec.workspace.absolutePath}:${spec.workspace.absolutePath}")
        argv += listOf("-b", "${tmpDir.absolutePath}:${tmpDir.absolutePath}")
        argv += listOf("-w", spec.workspace.absolutePath)
        argv += listOf(
            "/usr/bin/env", "-i",
            "HOME=/root",
            "PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "TERM=xterm-256color",
            "TMPDIR=${tmpDir.absolutePath}",
            "DSH_HOME=${spec.dshHome.absolutePath}",
            // 引擎进程自身也要转译 link()（会话日志/附件的原子发布都走它）
            "LD_PRELOAD=${linkCompatLib.absolutePath}",
            ProotManifest.node(rootfs).absolutePath,
            ProotManifest.dshBin(rootfs).absolutePath,
            "--profile", spec.profile,
            "--host", "127.0.0.1",
            "--port", spec.port.toString(),
            "--no-open",
            "--patch", overlay.absolutePath,
        )
        spec.extraPatches.forEach { argv += listOf("--patch", it.absolutePath) }
        return argv
    }

    private suspend fun awaitListening(port: Int, proc: Process) {
        val deadline = System.currentTimeMillis() + READY_TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            if (!proc.isAlive) {
                throw EngineHostException(
                    "引擎进程已退出（exit=${runCatching { proc.exitValue() }.getOrNull()}），见 engine.log"
                )
            }
            if (probe(port)) return
            delay(300)
        }
        throw EngineHostException("等待 127.0.0.1:$port 超时（${READY_TIMEOUT_MS}ms）")
    }

    private fun probe(port: Int): Boolean = try {
        Socket().use { it.connect(InetSocketAddress("127.0.0.1", port), 400) }
        true
    } catch (_: IOException) {
        false
    }

    private companion object {
        const val TAG = "DSH"
        const val READY_TIMEOUT_MS = 120_000L
    }
}

/** rootfs 内的路径约定，集中一处，避免散落的字符串拼装。 */
internal object ProotManifest {
    fun node(rootfs: File) = File(rootfs, "usr/bin/node")
    fun dshBin(rootfs: File) = File(rootfs, "usr/lib/node_modules/@deepseek-ai/dsh/bin/dsh.js")
}
