package com.dsh.android.engine

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import java.io.File

/**
 * “在别的 App 里打开”——Android 版 Open In。
 *
 * 边界（刻意做窄）：
 *   · 只支持 /sdcard（含 /storage/emulated/0）下的路径：走
 *     content://com.android.externalstorage.documents，不需要 FileProvider、不改 Manifest；
 *   · app 私有目录走不了这条 URI，直接抛 EngineHostException 并说明原因；
 *   · ACTION_VIEW + chooser：让用户选目标 App，而不是“猜默认应用”。
 */
object AndroidOpenWith {

    private const val TAG = "DSH"
    private const val DOCS_AUTHORITY = "com.android.externalstorage.documents"

    fun open(context: Context, path: String, mime: String? = null): Map<String, Any?> {
        val file = File(path)
        if (!file.exists()) throw EngineHostException("路径不存在: " + path)

        val absolute = file.absolutePath
        val uri = toExternalStorageUri(absolute)
            ?: throw EngineHostException(
                "该路径不在 /sdcard 下（" + absolute + "）；app 私有目录无法交给外部 App，" +
                    "请把工作区设在 /sdcard 或使用分享/导出。",
            )

        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, mime ?: guessMime(file))
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(intent, "打开方式").apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(chooser)
        Log.i(TAG, "open-with: " + absolute + " → " + uri)
        return mapOf("opened" to true, "uri" to uri.toString(), "path" to absolute)
    }

    /** /sdcard 与 /storage/emulated/0 都归一化成 primary:<相对路径>。 */
    private fun toExternalStorageUri(absolute: String): Uri? {
        val roots = listOf("/storage/emulated/0/", "/sdcard/")
        val root = roots.firstOrNull { absolute.startsWith(it) } ?: return null
        val rel = absolute.removePrefix(root)
        val docId = "primary:" + rel
        return Uri.parse("content://" + DOCS_AUTHORITY + "/document/" + Uri.encode(docId))
    }

    private fun guessMime(file: File): String = when (file.extension.lowercase()) {
        "txt", "md", "log" -> "text/plain"
        "json" -> "application/json"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "pdf" -> "application/pdf"
        "apk" -> "application/vnd.android.package-archive"
        "zip" -> "application/zip"
        else -> if (file.isDirectory) "vnd.android.document/directory" else "*/*"
    }
}
