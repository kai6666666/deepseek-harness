#!/usr/bin/env python3
"""wire-toolchain-plugin.py —— 把 dsh-android-toolchain.zip 接进 EngineManager

四处改动，每处都断言「命中恰好 1 次」，任何一处不符就不写盘。
⚠️ 本文件里 Kotlin 的 `${...}` **原样写**，不加反斜杠（$ 在 Python 里没有特殊含义）。
"""
import sys
from pathlib import Path

P = Path(__file__).resolve().parents[1] / "app/src/main/java/com/dsh/android/EngineManager.kt"
src = P.read_text(encoding="utf-8")
subs = []


def sub(old: str, new: str, why: str) -> None:
    subs.append((old, new, why))


# ── 1) 常量 ───────────────────────────────────────────────────────────
sub(
    '        private const val LOGS_TOOL_DIR = "logs-tool"',
    '''        private const val LOGS_TOOL_DIR = "logs-tool"

        // ── 工具链插件 ───────────────────────────────────────────────
        //
        // 与 bubble / statusbar / ui / logs **同一套做法**（独立工具 + 解到 $DSH_HOME 下
        // 自己的目录，绕开 pnpm 管辖的 node_modules）。
        //
        // 它对外提供的能力：判断一个依赖该装进 Alpine guest 还是宿主、按需调 apk 装包、
        // 并在超时/取消时杀掉**整个进程组**（proot 拉起的 node 不会留孤儿 —— G-13）。
        /** 注册 toolchain 工具的 host 插件；打包成 zip 随 APK 分发。 */
        private const val TOOLCHAIN_TOOL_ASSET = "dsh-android-toolchain.zip"
        private const val TOOLCHAIN_TOOL_PACKAGE = "dsh-android-toolchain"
        private const val TOOLCHAIN_TOOL_PATCH = "toolchain.patch.yml"
        private const val TOOLCHAIN_TOOL_DIR = "toolchain"''',
    "常量块",
)

# ── 2) 两个函数（插在 ensureLogsTool 之前）────────────────────────────
sub(
    "    private fun ensureLogsTool() {",
    '''    /**
     * 解出**工具链**插件（`dsh-android-toolchain.zip` → `$DSH_HOME/toolchain/dsh-android-toolchain/`）。
     *
     * 与 [ensureLogsTool] 同构：不做版本戳（包很小），每次启动覆盖写；
     * 装不上就只是没有这个工具，绝不拖垮引擎启动。
     */
    private fun ensureToolchainTool() {
        val target = File(dshHome, "$TOOLCHAIN_TOOL_DIR/$TOOLCHAIN_TOOL_PACKAGE")
        val entry = File(target, "lib/index.js")
        try {
            context.assets.open(TOOLCHAIN_TOOL_ASSET).use { input ->
                java.util.zip.ZipInputStream(input.buffered()).use { zis ->
                    var e = zis.nextEntry
                    while (e != null) {
                        if (!e.isDirectory) {
                            val out = File(target, e.name)
                            out.parentFile?.mkdirs()
                            out.outputStream().use { zis.copyTo(it) }
                        }
                        zis.closeEntry()
                        e = zis.nextEntry
                    }
                }
            }
            Log.i(TAG, "已安装工具链插件 $TOOLCHAIN_TOOL_PACKAGE (${entry.length()} 字节)")
        } catch (t: Throwable) {
            Log.w(TAG, "安装工具链插件失败: ${t.message}")
        }
    }

    /**
     * 写出挂载工具链插件的 overlay，返回其路径；入口不存在时返回 null。
     *
     * 与 [writeLogsToolPatch] 同构。
     */
    private fun writeToolchainToolPatch(): File? {
        val patch = File(dshHome, TOOLCHAIN_TOOL_PATCH)
        val entry = File(dshHome, "$TOOLCHAIN_TOOL_DIR/$TOOLCHAIN_TOOL_PACKAGE/lib/index.js")
        if (!entry.isFile) {
            if (patch.isFile) patch.delete()
            Log.w(TAG, "工具链插件入口不存在，跳过挂载: ${entry.absolutePath}")
            return null
        }
        return try {
            val url = "file://${entry.absolutePath}"
            patch.writeText(
                """
                # 由 DSH Android 客户端生成，请勿手改（每次启动会整体覆盖）。
                # 挂载工具链插件：注册一个独立的 `toolchain` 工具，
                # 让模型能按需把依赖装进 Alpine guest，并安全地杀掉残留进程组。
                - insert:
                    - id: $TOOLCHAIN_TOOL_PACKAGE
                      name: '$url'
                """.trimIndent() + "\\n"
            )
            Log.i(TAG, "已写入工具链 overlay: ${patch.name}")
            patch
        } catch (t: Throwable) {
            Log.w(TAG, "写入工具链 overlay 失败: ${t.message}")
            null
        }
    }

    private fun ensureLogsTool() {''',
    "安装/挂载函数",
)

# ── 3) 启动流程里调用 ─────────────────────────────────────────────────
sub(
    """        ensureLogsTool()
        val logsToolPatch = writeLogsToolPatch()""",
    """        ensureLogsTool()
        val logsToolPatch = writeLogsToolPatch()
        // 工具链插件：让模型能把依赖装进 Alpine guest，并在超时时杀整个进程组。
        // ⚠️ 与上面几条并列且独立；必须早于引擎启动（overlay 要在 profile 解析前落盘）。
        ensureToolchainTool()
        val toolchainToolPatch = writeToolchainToolPatch()""",
    "启动调用",
)

# ── 4) patch 收集列表 ─────────────────────────────────────────────────
sub(
    "            logsToolPatch,",
    """            logsToolPatch,
            toolchainToolPatch,""",
    "patch 收集",
)

fail = 0
for old, new, why in subs:
    n = src.count(old)
    if n != 1:
        print(f"✗ {why}: 命中 {n} 次（应为 1）", file=sys.stderr)
        fail += 1
        continue
    src = src.replace(old, new, 1)
    print(f"✓ {why}")

if fail:
    print(f"\n{fail} 处失败，未写盘", file=sys.stderr)
    raise SystemExit(1)

P.write_text(src, encoding="utf-8")
print(f"\n已写入 {P}（{len(src)} B）")