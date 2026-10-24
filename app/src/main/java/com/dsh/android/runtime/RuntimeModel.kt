package com.dsh.android.runtime

import android.content.Context
import org.json.JSONObject

/**
 * 运行时后端。**只有一个运行档**：ALPINE。
 *
 * TERMUX 保留为「工具链模式」——只用于装东西/跑一次性命令，**不承载引擎**。
 * 原因见 docs/RUNTIME-ARCH-PLAN.md（ADR-1）：两套 engine 的 .node ABI 互斥。
 */
enum class RuntimeBackend(val dirName: String) {
    ALPINE("alpine"),
    ;

    companion object {
        fun parse(raw: String?): RuntimeBackend =
            values().firstOrNull { it.dirName.equals(raw, ignoreCase = true) } ?: ALPINE
    }
}

/** APK 内置资产的位置（相对 assets/）。改这里要同步 tools/fetch-rootfs-into-assets.sh。 */
object RuntimeAssets {
    const val DIR = "runtime"
    // ⚠️ 必须是 .bin，不能是 .tar.gz：AGP 会按扩展名做格式推断，把 .tar.gz 自动解压并
    //    改名成 .tar（见 app/build.gradle.kts 里 noCompress 那段注释）。我们用 .bin 绕开。
    const val ROOTFS_TAR_GZ = "$DIR/alpine-rootfs.bin"
    const val MANIFEST = "$DIR/alpine-rootfs.manifest.json"

    /** 解包后需要的最小可用体积倍数（G-05：解包 165 MB，务必留余量）。 */
    const val FREE_SPACE_FACTOR = 3L

    /** 期望的 Node 主版本；与 CI 的 --expect-node-major 必须一致。 */
    const val EXPECT_NODE_MAJOR = 24
}

/**
 * 可用性三态 —— **不许把"缺东西"揉成一句"启动失败"**。
 *
 * 真机上的三种情况要能分别说清：没解包 / 解了但缺 proot / 都齐了。
 * 这样日志与诊断包才能直接指路，而不是让模型去猜。
 */
sealed class RuntimeAvailability {
    /** 齐全，可以用。loader 可能为 null —— proot 5.1.x 把 loader 内嵌进二进制。 */
    data class Ready(val rootfs: java.io.File, val proot: java.io.File, val loader: java.io.File?) :
        RuntimeAvailability()

    /** rootfs 已就绪，但缺 proot（libproot.so）或 proot-loader。 */
    data class ProotMissing(val rootfs: java.io.File, val missing: String) : RuntimeAvailability()

    /** 还没解包（首启、或 assets 里没有 rootfs）。 */
    data class NotProvisioned(val reason: String) : RuntimeAvailability()

    val usable: Boolean get() = this is Ready

    fun describe(): String = when (this) {
        is Ready -> "alpine 就绪: ${rootfs.absolutePath}"
        is ProotMissing -> "alpine rootfs 已就绪，但缺 $missing —— 引擎回退 Termux 档"
        is NotProvisioned -> "alpine 未就绪: $reason"
    }
}

/**
 * assets 里那份 manifest（schema 3，由 fetch-rootfs-into-assets.sh 写）。
 *
 * 它存在的唯一理由：**让 App 知道自己该配哪一版 rootfs**，
 * 而不是"assets 里有个 tar.gz 就当它能用"。
 */
data class RootfsManifest(
    val schema: Int,
    val assetsPath: String,
    val bytes: Long,
    val sha256: String,
    val nodejs: String,
    val alpine: String,
    val packages: List<String>,
) {
    val nodeMajor: Int get() = nodejs.substringBefore('.').toIntOrNull() ?: -1

    companion object {
        fun load(context: Context): RootfsManifest? = runCatching {
            context.assets.open(RuntimeAssets.MANIFEST).use { input ->
                parse(input.bufferedReader().readText())
            }
        }.getOrNull()

        fun parse(json: String): RootfsManifest {
            val o = JSONObject(json)
            val pkgs = o.optJSONArray("packages")?.let { arr ->
                (0 until arr.length()).mapNotNull { arr.optString(it).takeIf(String::isNotEmpty) }
            } ?: emptyList()
            return RootfsManifest(
                schema = o.optInt("schema", 0),
                assetsPath = o.optString("assetsPath", RuntimeAssets.ROOTFS_TAR_GZ),
                bytes = o.optLong("bytes", 0L),
                sha256 = o.optString("sha256", ""),
                nodejs = o.optString("nodejs", ""),
                alpine = o.optString("alpine", ""),
                packages = pkgs,
            )
        }
    }
}