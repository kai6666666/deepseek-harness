package com.dsh.android.runtime

import android.util.Log
import java.io.File

/**
 * G-09：runtime 落地路径**只允许** app 私有目录。
 *
 * `/storage/emulated/0`（sdcard）、`/sdcard`、`/mnt/*` 全是 FUSE + noexec：
 * 把 rootfs 解到那儿能写、能读，但 `usr/bin/node` 一 exec 就是 EACCES/EPERM ——
 * 在设备上表现出来的样子是「node 莫名其妙崩了」，极难定位。
 *
 * 所以这条约束做成**硬断言**，而不是注释里的约定：
 * 目标目录不在 `filesDir` / `noBackupFilesDir` 之下 → 直接抛 `IllegalArgumentException`。
 */
object RuntimePaths {
    private const val TAG = "DSH/RuntimePaths"

    /** 这些前缀一律禁止（FUSE / 只读 / noexec）。 */
    private val FORBIDDEN = listOf(
        "/storage/",
        "/sdcard",
        "/mnt/",
        "/data/local/tmp",
        "/system/",
        "/vendor/",
        "/data/misc",
    )

    fun runtimeHome(filesDir: File): File = File(filesDir, "runtime")

    fun rootfsDir(filesDir: File): File = File(runtimeHome(filesDir), "alpine")

    fun stagingDir(filesDir: File): File = File(runtimeHome(filesDir), "alpine.tmp")

    /**
     * 断言 [dir] 位于 app 私有可执行区。返回原对象，方便链式调用。
     *
     * @throws IllegalArgumentException 命中禁写前缀，或不在 [filesDir] 之下
     */
    fun assertExecutableRoot(dir: File, filesDir: File): File {
        val abs = dir.absolutePath.replace('\\', '/')
        FORBIDDEN.firstOrNull { abs == it || abs.startsWith(it) }?.let { hit ->
            throw IllegalArgumentException(
                "G-09：runtime 不允许落在 $hit（FUSE/noexec，node 无法 exec）：$abs",
            )
        }
        val base = filesDir.absolutePath.replace('\\', '/').trimEnd('/') + "/"
        if (!abs.startsWith(base)) {
            throw IllegalArgumentException("G-09：runtime 必须在 app 私有目录 $base 之下，实际=$abs")
        }
        return dir
    }

    /** 只判断、不抛；给 UI / 诊断包用。 */
    fun isExecutableRoot(dir: File, filesDir: File): Boolean =
        runCatching { assertExecutableRoot(dir, filesDir) }.isSuccess

    /** 一次性体检：返回人类可读的结论（写进日志，便于线上定位）。 */
    fun describe(dir: File, filesDir: File): String {
        val ok = isExecutableRoot(dir, filesDir)
        val line = "G-09 路径体检：${dir.absolutePath} → ${if (ok) "OK（app 私有，可 exec）" else "非法"}"
        if (ok) Log.i(TAG, line) else Log.e(TAG, line)
        return line
    }
}