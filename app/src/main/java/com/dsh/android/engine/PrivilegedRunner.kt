package com.dsh.android.engine

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * uid 2000 通道的 Kotlin 侧调用器（给 MCP 的 android_shell / android_screenshot 用）。
 *
 * 复用已有 runner，不重写通道：契约来自 dsh-android-shell/lib/index.js 头部 ——
 * node <runner> '<原命令>'，runner 自己用 $DSH_HOME/adbkey 连 127.0.0.1:5555 或
 * Shizuku socket，以 uid 2000 执行；未 bootstrap 时回落 app 身份并在输出里打印
 * [dsh-adb] uid 2000 不可用。
 *
 * 截图为什么用 base64：uid 2000 读不到 app 私有目录，screencap -p 直接落盘到 /sdcard
 * 又要额外存储权限。改成 screencap -p | base64 走 stdout，Kotlin 侧解码写进 app 目录。
 */
class PrivilegedRunner(
    private val filesDir: File,
    private val dshHome: File,
) {

    private val node: File get() = File(filesDir, "usr/bin/node")
    private val runner: File get() = File(filesDir, "dsh-android-shell.mjs")

    private fun preflight() {
        if (!node.isFile) throw EngineHostException("uid2000 通道不可用：缺 node（" + node.absolutePath + "）")
        if (!runner.isFile) throw EngineHostException("uid2000 通道不可用：缺 runner（" + runner.absolutePath + "）")
    }

    /** 执行一条命令；返回 {exit, output, privileged}。 */
    suspend fun run(command: String, timeoutMs: Long = 60_000): Map<String, Any?> =
        withContext(Dispatchers.IO) {
            preflight()
            val proc = ProcessBuilder(node.absolutePath, runner.absolutePath, command)
                .redirectErrorStream(true)
                .apply {
                    environment()["DSH_HOME"] = dshHome.absolutePath
                    environment()["DSH_PRIV_RUNNER"] = runner.absolutePath
                }
                .start()

            val output = proc.inputStream.bufferedReader().use { it.readText() }
            if (!proc.waitFor(timeoutMs, TimeUnit.MILLISECONDS)) {
                proc.destroyForcibly()
                throw EngineHostException("命令超时（" + timeoutMs + "ms）：" + command)
            }
            val exit = proc.exitValue()
            val unprivileged = output.contains("uid 2000 不可用")
            Log.i(TAG, "privileged run exit=" + exit + " unprivileged=" + unprivileged)
            mapOf(
                "exit" to exit,
                "output" to output,
                // 明确把「回落成 app 身份」暴露给模型，避免它误判自己拿到了特权
                "privileged" to !unprivileged,
            )
        }

    /** 截图：screencap -p | base64 → 解码写入 app 目录，返回绝对路径。 */
    suspend fun screenshot(): Map<String, Any?> {
        val result = run("screencap -p | base64 -w0")
        val exit = (result["exit"] as? Int) ?: -1
        if (exit != 0) throw EngineHostException("screencap 失败（exit=" + exit + "）：" + result["output"])
        val b64 = result["output"] as? String ?: throw EngineHostException("screencap 无输出")

        val cleaned = b64.filterNot { it.isWhitespace() }
        val bytes = android.util.Base64.decode(cleaned, android.util.Base64.DEFAULT)
        val dir = File(filesDir, "screenshots").apply { mkdirs() }
        val out = File(dir, "shot-" + System.currentTimeMillis() + ".png")
        out.writeBytes(bytes)
        Log.i(TAG, "截图已保存: " + out.absolutePath + " (" + bytes.size + " bytes)")
        return mapOf("path" to out.absolutePath, "bytes" to bytes.size)
    }

    private companion object {
        const val TAG = "DSH"
    }
}
