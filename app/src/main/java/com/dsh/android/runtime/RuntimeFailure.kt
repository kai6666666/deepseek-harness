package com.dsh.android.runtime

import java.io.FileNotFoundException
import java.io.IOException

/**
 * 首启失败的「用户可读」分类（P0）。
 *
 * ## 为什么需要它
 *
 * `RootfsInstaller` 抛的全是 `IOException`，message 是给开发者看的技术串：
 *
 * ```text
 * rootfs 分片校验失败：part2 sha256=8d48b3eb…
 * 存储空间不足：需要约 3244 MB，剩余 812 MB
 * rootfs critical files missing: usr/bin/node
 * ```
 *
 * 而 `EngineManager.failStart` 直接把 message 丢进 `State.Failed`，用户看到的是
 * 「运行时准备失败：rootfs 分片校验失败：part2 sha256=…\njava.io.IOException…」——
 * 既不知道**差多少空间**，也不知道**下一步该点什么**。
 *
 * 这个对象只做一件事：把 `Throwable` 归类成 `(标题, 说明, 下一步动作)`。
 * 纯函数、不碰 Android，所以能在 `RuntimeS6Test` 里直接跑。
 *
 * ## 判据为什么按 message 而不是异常类型
 *
 * 历史原因：`RootfsInstaller` 从 vc69 起就统一抛 `IOException`（避免上层 catch 分支爆炸）。
 * 现在新增了 `RootfsInstaller.Failure` 带 `info`，但**旧路径与第三方包装**仍可能只带
 * message，所以分类器必须两者都能吃：先看 `Failure.info`，退回 `message` 关键字。
 */
internal object RuntimeFailure {

    /** 失败种类。`code` 是稳定标识，日志与工单里用它，不要用中文标题。 */
    enum class Kind { INSUFFICIENT_SPACE, CORRUPT_ASSET, INCOMPLETE, PERMISSION, UNKNOWN }

    data class Info(
        val kind: Kind,
        val code: String,
        val title: String,
        val detail: String,
        val action: String,
        /** 点「重试」有没有意义。空间不足要靠用户先清理，但仍可重试。 */
        val retryable: Boolean = true,
    ) {
        /** 一整段给 UI 的文案；同时写进 `EventLog` 便于事后归因。 */
        fun message(): String = "$title\n$detail\n$action"
    }

    const val RETRY_HINT = "点『重试』会重新解包；已校验通过的分片会复用，不会重新下载。"

    private fun mb(bytes: Long): Long = if (bytes <= 0L) 0L else bytes / 1024 / 1024

    /**
     * @param t 抛出来的原始异常（可能是 [RootfsInstaller.Failure]，也可能只是 IOException）
     * @param freeBytes `filesDir.usableSpace` 的实测值；传 -1 表示没测（读不到就不猜）
     * @param needBytes 解包预算，默认 [RuntimeFiles.ASSUME_UNPACKED_BYTES]
     */
    fun classify(
        t: Throwable,
        freeBytes: Long = -1L,
        needBytes: Long = RuntimeFiles.ASSUME_UNPACKED_BYTES,
    ): Info {
        // 已经是分类过的：原样返回，别再按 message 猜一遍
        val explicit = (t as? RootfsInstaller.Failure)?.info
        if (explicit != null) return explicit

        val msg = t.message.orEmpty()
        val lower = msg.lowercase()

        // ① 存储不足：消息或实测值任一成立即可。
        //    实测值优先 —— 消息可能是上一层包装过（"解包失败：存储空间不足…"）。
        val measuredShort = freeBytes in 1 until needBytes
        if (measuredShort || msg.contains("存储空间不足") || lower.contains("no space left")) {
            val free = if (freeBytes > 0) freeBytes else 0L
            val short = (needBytes - free).coerceAtLeast(0L)
            return Info(
                kind = Kind.INSUFFICIENT_SPACE,
                code = "space",
                title = "存储空间不足，运行时装不下",
                detail = "解包大约需要 ${mb(needBytes)} MB，当前可用 ${if (free > 0) "${mb(free)} MB" else "未知"}。" +
                    if (short > 0) "还差约 ${mb(short)} MB。" else "",
                action = "请先腾出空间再重试：删掉旧的录屏/下载/别的 AI 应用都可以；" +
                    "若只是缓存占空间，可在系统「设置 → 应用 → DSH → 存储 → 清除缓存」" +
                    "（不会删会话与凭据）。$RETRY_HINT",
            )
        }

        // ② 资产损坏 / 校验不过：包本身坏了或被截断（磁盘满、下载中断、改动过 assets）
        if (lower.contains("sha256") || msg.contains("校验失败") || lower.contains("checksum")) {
            return Info(
                kind = Kind.CORRUPT_ASSET,
                code = "asset-corrupt",
                title = "运行时文件校验不通过",
                detail = "解出来的运行时与安装包内记录的校验值不一致，通常是包被改动或上次解包被中断留下的半截文件。\n技术细节：$msg",
                action = "$RETRY_HINT 若连续两次都失败，说明安装包本身不完整，请卸载后重新安装本版本。",
            )
        }

        // ③ 解包不完整（tar 出来了，但关键文件缺）
        if (lower.contains("critical files missing") || lower.contains("critical")) {
            return Info(
                kind = Kind.INCOMPLETE,
                code = "incomplete",
                title = "运行时解包不完整",
                detail = "关键文件（如 usr/bin/node）没有解出来，多数是解包中途被杀或存储写入异常。\n技术细节：$msg",
                action = "$RETRY_HINT 若反复失败，请确认设备存储没有写保护或满载。",
            )
        }

        // ④ 权限 / 路径问题
        if (t is SecurityException || t is FileNotFoundException ||
            lower.contains("eacces") || lower.contains("permission denied") ||
            lower.contains("无法创建") || msg.contains("归档路径逃逸")
        ) {
            return Info(
                kind = Kind.PERMISSION,
                code = "permission",
                title = "没有权限写入应用目录",
                detail = "安装运行时需要写入应用私有目录，但被拒绝或路径不安全。\n技术细节：$msg",
                action = "先重试一次；若仍失败，检查是否有「清理/安全」类软件限制了本应用的存储访问，或在系统设置里给本应用存储权限后重启。",
            )
        }

        // ⑤ 兜底：不假装知道原因，但也要给出可做的动作
        return Info(
            kind = Kind.UNKNOWN,
            code = "unknown",
            title = "运行时准备失败",
            detail = msg.ifBlank { t::class.java.simpleName },
            action = "$RETRY_HINT 若反复失败，请在「关于 → 导出诊断」把日志发给开发者。",
        )
    }

    /** 便利重载：只关心种类时用。 */
    fun kindOf(t: Throwable, freeBytes: Long = -1L): Kind = classify(t, freeBytes).kind

    /** 给日志用的单行摘要（不带换行，方便 grep）。 */
    fun summary(t: Throwable, freeBytes: Long = -1L): String {
        val i = classify(t, freeBytes)
        return "kind=${i.kind} code=${i.code} title=${i.title} retryable=${i.retryable}"
    }

    /** `IOException` 是这条链上的标准载体，保留一个构造点方便上层统一抛。 */
    fun asIOException(t: Throwable, freeBytes: Long = -1L): IOException =
        if (t is IOException) t else IOException(classify(t, freeBytes).message(), t)
}
