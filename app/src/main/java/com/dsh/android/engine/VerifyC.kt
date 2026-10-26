package com.dsh.android.engine

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * 把 `tools/verify-c.sh` 的判据搬进 App：一键跑、结构化落盘、进诊断包。
 *
 * 为什么值得做：
 *   · C 方案的失败几乎都在「跑起来之后」——runner 没编、link 没转译、ws 拼写不一致；
 *   · 用户看不懂 proot/glibc，但看得懂「9 项里 3 项 ❌」；
 *   · 结果写成 JSON，救援界面与 `logs` 工具都能直接读（AI 自己也能查）。
 */
class VerifyC(private val filesDir: File) {

    private val dshHome: File get() = File(filesDir, "home/.dsh")
    private val rootfs: File get() = File(filesDir, "ubuntu")
    private val proot: File get() = File(filesDir, "bin/proot")
    private val scriptInRootfs: File get() = File(rootfs, "opt/dshapp/verify-c.sh")
    private val log: File get() = File(dshHome, "logs/verify-c.log")
    private val report: File get() = File(dshHome, "logs/verify-c.json")

    data class Item(val name: String, val ok: Boolean, val detail: String)
    data class Result(val pass: Int, val fail: Int, val items: List<Item>, val logPath: String) {
        val ok: Boolean get() = fail == 0 && pass > 0
    }

    /** @param script 仓库里的 tools/verify-c.sh（由调用方从 assets 复制出来） */
    suspend fun run(script: File, workspace: File, runHeadless: Boolean = false): Result =
        withContext(Dispatchers.IO) {
            require(script.isFile) { "缺少 verify 脚本: ${script.absolutePath}" }
            scriptInRootfs.parentFile?.mkdirs()
            script.copyTo(scriptInRootfs, overwrite = true)
            scriptInRootfs.setExecutable(true)

            val argv = buildList {
                add(proot.absolutePath)
                addAll(listOf("--kill-on-exit", "-r", rootfs.absolutePath))
                addAll(listOf("-b", "/dev", "-b", "/proc", "-b", "/sys"))
                addAll(listOf("-b", "${dshHome.absolutePath}:${dshHome.absolutePath}"))
                addAll(listOf("-b", "${workspace.absolutePath}:${workspace.absolutePath}"))
                addAll(
                    listOf(
                        "/usr/bin/env", "-i",
                        "PATH=/usr/local/bin:/usr/bin:/bin",
                        "HOME=/root",
                        "DSH_HOME=${dshHome.absolutePath}",
                        "WORKSPACE=${workspace.absolutePath}",
                        "RUNNER=/usr/local/bin/boo-sandbox-run",
                        "BOOLIB=/usr/local/lib/libboosandbox.so",
                        "LINKLIB=/usr/local/lib/liblinkcompat.so",
                        if (runHeadless) "RUN_HEADLESS=1" else "RUN_HEADLESS=0",
                        "/bin/bash", scriptInRootfs.absolutePath,
                    ),
                )
            }

            log.parentFile?.mkdirs()
            Log.i(TAG, "运行验收: ${argv.joinToString(" ")}")
            val proc = ProcessBuilder(argv)
                .redirectErrorStream(true)
                .start()
            val output = proc.inputStream.bufferedReader().use { it.readText() }
            val code = proc.waitFor()
            log.writeText(output)

            val items = output.lineSequence()
                .mapNotNull { line ->
                    when {
                        line.startsWith("✅") -> Item(line.removePrefix("✅").trim(), true, "")
                        line.startsWith("❌") -> Item(line.removePrefix("❌").trim(), false, "")
                        else -> null
                    }
                }
                .toList()

            // 明细行（❌ 下面那一行是修复提示，单独挂到上一个失败项）
            val withDetail = buildList {
                val raw = output.lines()
                for (i in raw.indices) {
                    val line = raw[i]
                    when {
                        line.startsWith("✅") -> add(Item(line.removePrefix("✅").trim(), true, ""))
                        line.startsWith("❌") -> add(
                            Item(
                                line.removePrefix("❌").trim(),
                                false,
                                raw.getOrNull(i + 1)?.trim()?.takeIf { it.isNotEmpty() && !it.startsWith("❌") && !it.startsWith("✅") } ?: "",
                            ),
                        )
                    }
                }
            }.ifEmpty { items }

            val pass = withDetail.count { it.ok }
            val fail = withDetail.size - pass
            report.writeText(toJson(code, pass, fail, withDetail))

            Result(pass = pass, fail = fail, items = withDetail, logPath = log.absolutePath)
        }

    private fun toJson(exit: Int, pass: Int, fail: Int, items: List<Item>): String = buildString {
        appendLine("{")
        appendLine("  \"exitCode\": $exit,")
        appendLine("  \"pass\": $pass,")
        appendLine("  \"fail\": $fail,")
        appendLine("  \"items\": [")
        items.forEachIndexed { i, it ->
            append("    {\"name\":\"${it.name.escape()}\",\"ok\":${it.ok},\"detail\":\"${it.detail.escape()}\"}")
            appendLine(if (i == items.lastIndex) "" else ",")
        }
        appendLine("  ]")
        appendLine("}")
    }

    private fun String.escape() = replace("\\", "\\\\").replace("\"", "\\\"")

    private companion object {
        const val TAG = "DSH"
    }
}