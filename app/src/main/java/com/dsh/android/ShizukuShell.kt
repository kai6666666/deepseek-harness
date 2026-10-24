package com.dsh.android

import android.os.ParcelFileDescriptor
import android.util.Log
import java.io.FileInputStream
import kotlin.concurrent.thread
import moe.shizuku.server.IRemoteProcess
import moe.shizuku.server.IShizukuService
import rikka.shizuku.Shizuku

/**
 * 以 **uid 2000** 执行一条 shell 命令并拿回 stdout。
 *
 * ## 为什么需要它（而不是直接用 `ProcessBuilder`）
 *
 * 本进程是普通应用 uid。凡是需要 `android.permission.DUMP` / `INSTALL_PACKAGES`
 * 之类特权权限的命令，直接 `ProcessBuilder` 跑都会被系统拒绝。典型例子：
 *
 * ```
 * $ run-as com.dsh.android dumpsys input_method
 * Permission Denial: can't dump InputMethodManagerService ... uid=10347
 *   due to missing android.permission.DUMP permission
 * ```
 *
 * 所以「读键盘状态」这条需求**只能**走 Shizuku 的 `newProcess()`（服务端以
 * uid 2000 运行，它 fork 出来的子进程也就带着特权）。
 *
 * ## 与 [ShizukuChannel] 的关系
 *
 * [ShizukuChannel] 是给 Node 侧用的 LocalSocket **服务端**，输出是 JSON 帧
 * （`{"stdout":…}`），不适合 Kotlin 内部直接消费。本对象只做最小的一件事：
 * 拿到 stdout 原文。底层调用与 `ShizukuChannel.runCommand` 完全同构 ——
 * 包括那两处踩过的坑（双路并发排空、`arrayOfNulls` 而非 `arrayOf`）。
 *
 * ## 调用开销
 *
 * 每次调用是一次 `newProcess` + 两次 `drain` 线程。单次 `dumpsys input_method`
 * 实测 95–150 ms，所以调用方**必须低频**（见 [ImeProbe.POLL_INTERVAL_MS]）。
 */
internal object ShizukuShell {

    private const val TAG = "DSH"

    /**
     * 执行命令，返回 stdout。失败（无 binder / 无授权 / 执行异常）返回 **null**。
     *
     * ⚠️ 失败一律不抛异常：调用方（[ImeProbe]）用 null 当作「读不到」并据此降级，
     *   抛异常会让轮询线程每次都走异常路径，日志刷屏还难读。
     */
    /**
     * 把 [ParcelFileDescriptor] 读干净。
     *
     * ⚠️ `IRemoteProcess.inputStream` 返回的是 **ParcelFileDescriptor** 而不是
     *   Java 的 InputStream —— Shizuku 跨进程传文件描述符，不能直接 `readBytes()`。
     */
    private fun drain(pfd: ParcelFileDescriptor?): ByteArray {
        if (pfd == null) return ByteArray(0)
        return try {
            FileInputStream(pfd.fileDescriptor).use { it.readBytes() }
        } catch (t: Throwable) {
            ByteArray(0)
        } finally {
            runCatching { pfd.close() }
        }
    }

    fun exec(command: String): String? {
        val binder = try {
            Shizuku.getBinder()
        } catch (t: Throwable) {
            null
        } ?: return null

        if (!ShizukuChannel.hasPermission()) return null

        val proc: IRemoteProcess = try {
            val service = IShizukuService.Stub.asInterface(binder)
            // env 传 null ⇒ 用服务端的 shell 环境（PATH 等齐全）。自造空环境会让
            // `dumpsys` 这类命令找不到，是 [ShizukuChannel] 里记过的坑。
            service.newProcess(arrayOf("/system/bin/sh", "-c", command), null, null)
        } catch (t: Throwable) {
            Log.w(TAG, "ShizukuShell 启动进程失败: ${t.message}")
            return null
        }

        // ⚠️ 必须是 `arrayOfNulls<ByteArray>(1)`：`arrayOf<ByteArray>()` 是**长度 0**
        //   的数组，`outBox[0] = …` 立刻 ArrayIndexOutOfBoundsException，而它跑在
        //   子线程里 —— 未捕获异常会**杀掉整个进程**（[ShizukuChannel] 真机崩过两次）。
        val outBox = arrayOfNulls<ByteArray>(1)
        val errBox = arrayOfNulls<ByteArray>(1)
        val t1 = thread(isDaemon = true) {
            runCatching { outBox[0] = drain(proc.inputStream) }
        }
        val t2 = thread(isDaemon = true) {
            // stderr 也要排空，否则子进程写满 64 KB 管道会卡死。
            runCatching { errBox[0] = drain(proc.errorStream) }
        }

        return try {
            proc.waitFor()
            t1.join(1500)
            t2.join(1500)
            outBox[0]?.toString(Charsets.UTF_8)
        } catch (t: Throwable) {
            Log.w(TAG, "ShizukuShell 执行失败: ${t.message}")
            runCatching { proc.destroy() }
            null
        }
    }
}
