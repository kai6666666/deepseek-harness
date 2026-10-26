package com.dsh.android.engine

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * glibc 宿主的「环境装配」。
 *
 * 设计原则：**只做搬运与校验，不做下载魔法**。
 *   · 资产（proot 静态二进制 / ubuntu-base tarball / node tarball）由 APK 的
 *     assets 或用户手工放进 filesDir；
 *   · 装配逻辑放在 `tools/provision-glibc-host.sh`（可单独跑、可复现、可测）；
 *   · 本类负责：检查前置、调脚本、把结果写成 `logs/provision.json` 供 UI/诊断包读取。
 *
 * 为什么不让 Kotlin 直接解 tar：要处理 symlink/权限/设备文件/hardlink，
 * 纯 Kotlin 解包最容易在「符号链接权限」上出错；交给 coreutils 的 tar 更可靠。
 */
class RootfsProvisioner(private val filesDir: File) {

    private val dshHome: File get() = File(filesDir, "home/.dsh")
    private val rootfs: File get() = File(filesDir, "ubuntu")
    private val proot: File get() = File(filesDir, "bin/proot")
    private val script: File get() = File(filesDir, "bin/provision-glibc-host.sh")
    private val log: File get() = File(dshHome, "logs/provision.log")
    private val report: File get() = File(dshHome, "logs/provision.json")

    data class Check(
        val id: String,
        val ok: Boolean,
        val detail: String,
        /** 缺失时给用户的一句话修复动作（UI 直接显示，不要让用户猜）。 */
        val fix: String = "",
    )

    fun preflight(): List<Check> = listOf(
        Check("proot", proot.isFile, proot.absolutePath, "把静态 aarch64 proot 放到 filesDir/bin/proot"),
        Check("rootfs", File(rootfs, "usr/bin/env").isFile, rootfs.absolutePath, "解包 ubuntu-base 到 filesDir/ubuntu"),
        Check("node", File(rootfs, "usr/bin/node").isFile, ProotManifest.node(rootfs).absolutePath, "在 rootfs 内安装 Node 22/24（glibc 版）"),
        Check("dsh", ProotManifest.dshBin(rootfs).isFile, ProotManifest.dshBin(rootfs).absolutePath, "npm i -g @deepseek-ai/dsh@<版本>"),
        Check("runner", File(rootfs, "usr/local/bin/boo-sandbox-run").isFile, "", "编译 app/src/main/jni 三个 C 文件（见 docs/agents/proot-glibc-host.md）"),
        Check("linkcompat", File(rootfs, "usr/local/lib/liblinkcompat.so").isFile, "", "同上"),
        Check("boosandbox", File(rootfs, "usr/local/lib/libboosandbox.so").isFile, "", "同上"),
        Check("script", script.isFile, script.absolutePath, "从 assets/tools 复制 provision-glibc-host.sh 到 filesDir/bin"),
    )

    fun isReady(): Boolean = preflight().all { it.ok }

    /**
     * 跑装配脚本。前置不全时**不启动**，直接返回带 fix 提示的结论——
     * 比「跑一半失败」更容易定位。
     */
    suspend fun provision(): Result<String> = withContext(Dispatchers.IO) {
        val missing = preflight().filterNot { it.ok }
        // proot/rootfs/script 三项必须先在，其余（node/dsh/runner）由脚本自己装
        val hardBlockers = missing.filter { it.id in setOf("proot", "rootfs", "script") }
        if (hardBlockers.isNotEmpty()) {
            return@withContext Result.failure(
                EngineHostException(hardBlockers.joinToString("\n") { "${it.id}: ${it.fix}" }),
            )
        }

        log.parentFile?.mkdirs()
        val argv = listOf("/system/bin/sh", script.absolutePath)
        Log.i(TAG, "装配 glibc 宿主: ${argv.joinToString(" ")}")

        runCatching {
            val proc = ProcessBuilder(argv)
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.appendTo(log))
                .start()
            val code = proc.waitFor()
            val checks = preflight()
            report.writeText(
                buildString {
                    appendLine("{")
                    appendLine("  \"exitCode\": $code,")
                    appendLine("  \"checks\": [")
                    checks.forEachIndexed { i, c ->
                        append("    {\"id\":\"${c.id}\",\"ok\":${c.ok},\"detail\":\"${c.detail.escape()}\"}")
                        appendLine(if (i == checks.lastIndex) "" else ",")
                    }
                    appendLine("  ]")
                    appendLine("}")
                },
            )
            if (code == 0 && checks.all { it.ok }) {
                Result.success("环境就绪；日志: ${log.absolutePath}")
            } else {
                Result.failure(
                    EngineHostException(
                        "装配未完成（exit=$code）：" + checks.filterNot { it.ok }
                            .joinToString("; ") { "${it.id} 缺（${it.fix}）" },
                    ),
                )
            }
        }.getOrElse { Result.failure(EngineHostException("装配脚本执行失败: ${it.message}", it)) }
    }

    private fun String.escape(): String = replace("\\", "\\\\").replace("\"", "\\\"")

    private companion object {
        const val TAG = "DSH"
    }
}