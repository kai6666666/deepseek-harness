package com.dsh.android.backup

import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.provider.Settings
import com.dsh.android.log.DshLog as Log

/**
 * 换包名后的**迁移向导**（`0.3.3`）。
 *
 * ## 为什么需要它
 *
 * P4 把 `applicationId` 从 `com.dsh.android` 换成了 `io.github.ccch1mneyyy.dsh`。
 * 对 Android 来说这是**另一个应用**：会话、凭据、rootfs 全都不继承。
 * 用户在旧包里可能攒了几十个会话，卸载旧包 = 全部丢掉，而界面上**没有任何提示**
 * （`.` 实测：真机上一次误卸直接带走 1 个会话 / 2.2 MB 测试数据）。
 *
 * ## 做什么
 *
 * 启动时看一眼旧包在不在：
 * - 在 ⇒ 弹三步向导：**① 打开旧版 → ② 导出数据 → ③ 导出完成后再卸载旧版**；
 *   导入口就在本版的「导入数据」按钮（覆盖层上）。
 * - 不在 ⇒ 什么都不做（绝大多数人看到的是这条）。
 *
 * ## 为什么用 AlertDialog 而不是横幅
 *
 * 横幅要改布局、还要处理 WebView 抢占焦点；而这一步**一辈子只该出现一次**，
 * 用系统对话框最省事，也能保证盖在 WebView 之上。
 *
 * ⚠️ 只在**本版还没有会话数据**时提示：已经导入过的人不需要再被念一遍。
 */
internal object MigrationWizard {

    private const val TAG = "DSH"

    /** 旧包名（P4 之前的 `applicationId`）。 */
    private const val LEGACY_PACKAGE = "com.dsh.android"

    /** 本版是否已经提示过（进程级；重启 App 会再看一眼旧包在不在）。 */
    @Volatile
    private var shownThisRun = false

    /** 旧包是否还装着。 */
    fun legacyInstalled(context: Context): Boolean = try {
        context.packageManager.getPackageInfo(LEGACY_PACKAGE, 0)
        true
    } catch (t: Throwable) {
        false
    }

    /**
     * 需要时弹一次向导。
     *
     * @param force 忽略「本版已有数据」「本次已提示」两道门（调试/验收用）。
     */
    fun showIfNeeded(context: Context, force: Boolean = false) {
        if (shownThisRun && !force) return
        // 用户点过「不再提示」就不再弹（除非 force）
        val dismissed = context.getSharedPreferences("dsh_migration", Context.MODE_PRIVATE)
            .getBoolean("dismissed", false)
        if (dismissed && !force) return
        val legacy = legacyInstalled(context)
        if (!legacy && !force) return
        // 已经导入过数据（本版有会话目录）就不再打扰
        val hasData = java.io.File(context.filesDir, "home/.dsh/sessions").exists()
        if (hasData && !force) {
            Log.i(TAG, "迁移向导跳过：本版已有会话数据")
            return
        }
        shownThisRun = true
        Log.i(TAG, "迁移向导：检测到旧包 $LEGACY_PACKAGE 仍安装，提示先导出")
        val activity = context as? android.app.Activity ?: return
        activity.runOnUiThread {
            AlertDialog.Builder(activity)
                .setTitle("检测到旧版 DSH")
                .setMessage(
                    "旧版（com.dsh.android）与本版是**两个独立应用**，数据不通用。\n\n" +
                        "卸载旧版会连同它的会话 / 凭据 / 引擎数据一起删掉。建议按顺序做：\n\n" +
                        "① 打开旧版 →「导出数据」\n" +
                        "② 回到本版 →「导入数据」选择刚导出的 zip\n" +
                        "③ 确认本版能看到会话后，再卸载旧版",
                )
                .setPositiveButton("打开旧版") { _, _ ->
                    try {
                        val intent: Intent? = activity.packageManager
                            .getLaunchIntentForPackage(LEGACY_PACKAGE)
                        if (intent != null) activity.startActivity(intent)
                        else openAppSettings(activity)
                    } catch (t: Throwable) {
                        Log.w(TAG, "打开旧版失败: ${t.message}")
                        openAppSettings(activity)
                    }
                }
                .setNeutralButton("稍后", null)
                .setNegativeButton("不再提示") { _, _ ->
                    activity.getSharedPreferences("dsh_migration", Context.MODE_PRIVATE)
                        .edit().putBoolean("dismissed", true).apply()
                }
                .show()
        }
    }

    private fun openAppSettings(activity: android.app.Activity) {
        runCatching {
            activity.startActivity(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(android.net.Uri.parse("package:$LEGACY_PACKAGE")),
            )
        }
    }
}
