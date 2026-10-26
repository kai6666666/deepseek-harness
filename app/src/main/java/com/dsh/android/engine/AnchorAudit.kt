package com.dsh.android.engine

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 文本锚点审计（P3.2 第一步：让静默失败变可见）。
 *
 * EngineManager 里十几处补丁靠"引擎内部文本"定位，匹配不到只打一行 warn，
 * 行为静默回落。本审计器不改那些补丁函数，而是另起一份清单扫一遍：
 *   · 缺失项写 `$DSH_HOME/anchor-miss.json` 并 Log.e；
 *   · UI / 诊断包 / logs 工具都读这一个文件。
 */
object AnchorAudit {

    private const val TAG = "DSH"

    data class Entry(val tag: String, val relativePath: String, val anchor: String)
    data class Miss(val tag: String, val path: String, val reason: String)

    /** 与 EngineManager 常量同源：FLOCK_PLATFORM_GUARD / FAIL_LOUD_* / TERMINAL_SHELL_GUARD / ATTACH_SYNC_GUARD。 */
    val ENTRIES: List<Entry> = listOf(
        Entry("flock-platform", "node_modules/@deepseek-ai/node-addon-system/lib/flock.js", "if (platform !== 'linux' && platform !== 'darwin') {"),
        Entry("fail-loud-app-boot", "node_modules/@deepseek-ai/dsh-app-boot/lib/index.js", "proc.exit(1);"),
        Entry("fail-loud-release", "node_modules/@deepseek-ai/dsh/lib/profile-boot-*.js", "await app.current?.fiber.dispose();"),
        Entry("terminal-shell", "node_modules/@deepseek-ai/dsh-terminal-bash/lib/index.js", "const DEFAULT_BASH_SHELL = \"/bin/bash\";"),
        Entry("attachment-fsync", "node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js", "\tconst handle = await open(path, constants.O_RDONLY);"),
    )

    /**
     * 把审计结果推到用户眼前（P3.2 的“可见”部分）。
     *
     * 用通知而不是 Web 横幅：前端是复用官方的，加横幅得再写 client 插件 + host 路由；
     * 通知零侵入、立刻可见，且与状态通知同一通道（McpWiring.notify）。
     */
    fun report(context: android.content.Context?, misses: List<Miss>) {
        if (misses.isEmpty()) return
        val summary = misses.take(3).joinToString("；") { it.tag + "(" + it.reason + ")" }
        val text = if (misses.size <= 3) summary else summary + " 等 " + misses.size + " 项"
        Log.e(TAG, "锚点失效 " + misses.size + " 项：" + text)
        if (context == null) return
        runCatching { McpWiring.notify(context, "DSH 适配补丁失效 " + misses.size + " 项", text) }
            .onFailure { Log.w(TAG, "锚点失效通知发送失败: " + it.message) }
    }

    /** @return 缺失项；空列表 = 全部锚点仍在。 */
    fun audit(engineDir: File, dshHome: File): List<Miss> {
        val misses = mutableListOf<Miss>()
        for (e in ENTRIES) {
            val targets = resolve(engineDir, e.relativePath)
            if (targets.isEmpty()) {
                misses += Miss(e.tag, e.relativePath, "file-missing")
                continue
            }
            for (f in targets) {
                val text = runCatching { f.readText() }.getOrNull()
                if (text == null) misses += Miss(e.tag, f.absolutePath, "unreadable")
                else if (!text.contains(e.anchor)) misses += Miss(e.tag, f.path, "anchor-missing")
            }
        }
        write(dshHome, misses)
        misses.forEach { Log.e(TAG, "锚点失效[${it.tag}] ${it.path}: ${it.reason} —— 该补丁本轮未生效") }
        if (misses.isEmpty()) Log.i(TAG, "锚点审计通过：${ENTRIES.size} 项全部命中")
        return misses
    }

    private fun resolve(root: File, relativePath: String): List<File> {
        if (!relativePath.contains('*')) {
            val f = File(root, relativePath)
            return if (f.isFile) listOf(f) else emptyList()
        }
        val parent = File(root, relativePath.substringBeforeLast('/'))
        val prefix = relativePath.substringAfterLast('/').substringBefore('*')
        val suffix = relativePath.substringAfterLast('*')
        if (!parent.isDirectory) return emptyList()
        return parent.listFiles()
            ?.filter { it.isFile && it.name.startsWith(prefix) && it.name.endsWith(suffix) }
            ?: emptyList()
    }

    private fun write(dshHome: File, misses: List<Miss>) {
        val f = File(dshHome, "anchor-miss.json")
        runCatching {
            f.parentFile?.mkdirs()
            if (misses.isEmpty()) {
                f.delete()
                return
            }
            val arr = JSONArray()
            misses.forEach { arr.put(JSONObject().put("tag", it.tag).put("path", it.path).put("reason", it.reason)) }
            f.writeText(JSONObject().put("count", misses.size).put("items", arr).toString())
        }.onFailure { Log.w(TAG, "写 anchor-miss.json 失败: ${it.message}") }
    }
}
