package com.dsh.android.runtime

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * 运行时清单（assets/runtime/manifest.json 或 files/runtime/manifest.json）。
 *
 * 只做「读 + 校验」，不含任何启动逻辑 —— 启动在 [ProotHost]。
 */
data class RuntimeManifest(
    val runtimeVersion: String,
    val abi: String,
    val rootfsAsset: String,
    val rootfsSha256: String,
    val rootfsBytes: Long,
    val jniLibs: Map<String, String>,
    val launchArgv: List<String>,
    val launchEnv: Map<String, String>,
    val tokenRegex: Regex,
    val stopPidFile: String,
    val unauthStatus: Int,
    val authStatus: Int,
) {
    companion object {
        fun load(context: Context): RuntimeManifest {
            val f = File(context.filesDir, "runtime/manifest.json")
            require(f.isFile) { "缺少 " + f.absolutePath }
            return parse(f.readText())
        }

        /** 纯解析：assets 与 files 共用（RootfsInstaller 先读 assets 再落盘）。 */
        fun parse(text: String): RuntimeManifest {
            val o = JSONObject(text)
            val launch = o.getJSONObject("launch")
            val argv = launch.getJSONArray("argv").let { a ->
                List(a.length()) { a.getString(it) }
            }
            val envObj = launch.optJSONObject("env")
            val env = buildMap {
                envObj?.keys()?.forEach { k -> put(k, envObj.getString(k)) }
            }
            val jniObj = o.optJSONObject("jniLibs")
            val jni = buildMap {
                jniObj?.keys()?.forEach { k ->
                    put(k, jniObj.getJSONObject(k).optString("sha256"))
                }
            }
            val health = o.optJSONObject("health")
            val stop = o.getJSONObject("stop")
            val token = o.getJSONObject("tokenLine").getString("regex")
            return RuntimeManifest(
                runtimeVersion = o.getString("runtimeVersion"),
                abi = o.getString("abi"),
                rootfsAsset = o.getJSONObject("rootfs").optString("asset", "runtime/rootfs-arm64-v8a.tar.xz"),
                rootfsSha256 = o.getJSONObject("rootfs").getString("sha256"),
                rootfsBytes = o.getJSONObject("rootfs").getLong("bytes"),
                jniLibs = jni,
                launchArgv = argv,
                launchEnv = env,
                tokenRegex = Regex(token),
                stopPidFile = stop.getString("pidFile"),
                unauthStatus = health?.optInt("unauthStatus", 401) ?: 401,
                authStatus = health?.optInt("authStatus", 200) ?: 200,
            )
        }
    }
}
