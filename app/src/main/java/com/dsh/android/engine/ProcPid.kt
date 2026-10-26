package com.dsh.android.engine

/**
 * 取进程 pid 的兼容层。
 *
 * 为什么不用 Process.pid()：那是 Java 9 的 API，而 Android 编译用的 android.jar 里
 * java.lang.Process 是 libcore 桩，可能没有这个方法（platform-35 实测
 * unresolved reference 'pid'）。反射一次，编得过、跑得动；取不到返回 null。
 */
object ProcPid {

    fun of(process: Process?): Long? {
        if (process == null) return null
        return runCatching {
            val m = process.javaClass.getMethod("pid")
            (m.invoke(process) as? Long)
        }.getOrNull()
    }
}
