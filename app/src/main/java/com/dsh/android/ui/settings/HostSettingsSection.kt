package com.dsh.android.ui.settings

import android.content.Context
import android.graphics.Typeface
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.TextView
import com.dsh.android.engine.EngineHosts
import com.dsh.android.engine.HostMode
import java.io.File

/**
 * 宿主设置区：选「Termux(bionic) / proot(glibc) / 远程」，并显示该宿主的能力摘要。
 *
 * ⚠️ 为什么是纯 View 而不是 Compose：
 *   本 app 模块的依赖里**没有** compose（androidx.compose.* 全部不可解析），
 *   用 Compose 写的版本会让 :app:compileSystemDebugKotlin 直接报 118 个
 *   Unresolved reference 'compose'。这里改用 android.widget.*，零额外依赖。
 *
 * 切换纪律（与 docs/agents/host-switch.md 一致）：只在空闲时切换。
 */
object HostSettingsSection {

    fun build(
        context: Context,
        filesDir: File,
        current: HostMode,
        onSelect: (HostMode) -> Unit,
        onVerify: (() -> Unit)? = null,
    ): View {
        val dp = { v: Int -> (v * context.resources.displayMetrics.density).toInt() }

        val root = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(12), dp(16), dp(12))
        }

        root.addView(TextView(context).apply {
            text = "宿主（沙箱 / 运行时）"
            textSize = 16f
            setTypeface(typeface, Typeface.BOLD)
        })

        root.addView(TextView(context).apply {
            text = "切换只在空闲时生效；运行中切换会让本轮请求与终端悬空。"
            textSize = 12f
            setPadding(0, dp(4), 0, dp(8))
        })

        val summary = TextView(context).apply {
            textSize = 12f
            setPadding(0, dp(6), 0, dp(8))
            text = describe(filesDir, current)
        }

        val group = RadioGroup(context).apply { orientation = RadioGroup.VERTICAL }
        val modes = listOf(
            HostMode.TERMUX_BIONIC to "Termux / bionic（现状）",
            HostMode.PROOT_GLIBC to "proot / glibc（C 方案）",
            HostMode.REMOTE to "远程引擎（--host + 隧道）",
        )
        modes.forEach { (mode, label) ->
            val rb = RadioButton(context).apply {
                id = View.generateViewId()
                text = label
                textSize = 14f
                isChecked = mode == current
                setOnClickListener {
                    summary.text = describe(filesDir, mode)
                    onSelect(mode)
                }
            }
            group.addView(
                rb,
                RadioGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ),
            )
        }
        root.addView(group)
        root.addView(summary)

        onVerify?.let { verify ->
            root.addView(Button(context).apply {
                text = "运行 verify-c（沙箱矩阵）"
                textSize = 14f
                setOnClickListener { verify() }
            })
        }

        return root
    }

    /** 能力摘要来自 EngineHost.capabilities().summary，失败时降级成静态文案。 */
    private fun describe(filesDir: File, mode: HostMode): String = runCatching {
        EngineHosts.create(mode, filesDir).capabilities().summary
    }.getOrElse {
        when (mode) {
            HostMode.TERMUX_BIONIC -> "bionic 自编译绑定；原生插件需 android 产物才可用"
            HostMode.PROOT_GLIBC -> "glibc 预编译全部可用；沙箱仍是用户态拦截"
            HostMode.REMOTE -> "手机只做前端；能力取决于远端主机"
        }
    }
}
