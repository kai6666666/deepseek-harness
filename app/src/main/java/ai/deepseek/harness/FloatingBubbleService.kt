package ai.deepseek.harness

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.TextView
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import kotlin.math.abs

/**
 * 悬浮外壳 —— 参考 Operit `FloatingWindowManager` 的窗口参数：
 *   TYPE_APPLICATION_OVERLAY + FLAG_NOT_FOCUSABLE + FLAG_LAYOUT_NO_LIMITS
 *   球：56dp，安全边距 16dp，拖动后贴边吸附（判据：球心过屏幕中线）
 *   面板：宽 = min(屏宽*0.92, 420dp)，高 = 屏高*0.7，TOP|CENTER_HORIZONTAL
 *
 * 与 dsh 的关系：面板里的 WebView 加载 `DshRuntime.state.url`（带 token 的授权 URL），
 * 面板收起时**只移除窗口，不销毁 WebView**，cookie 与页面状态都留着。
 */
class FloatingBubbleService : LifecycleService() {

    companion object {
        private const val TAG = "FloatingBubble"
        private const val BALL_DP = 56
        private const val SAFE_MARGIN_DP = 16

        fun canDraw(ctx: Context): Boolean = Settings.canDrawOverlays(ctx)

        fun start(ctx: Context): Boolean {
            if (!canDraw(ctx)) return false
            ctx.startService(Intent(ctx, FloatingBubbleService::class.java))
            return true
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, FloatingBubbleService::class.java))
        }
    }

    private lateinit var wm: WindowManager
    private var bubble: View? = null
    private var panel: LinearLayout? = null
    private lateinit var bubbleParams: WindowManager.LayoutParams
    private lateinit var panelParams: WindowManager.LayoutParams
    private var web: WebView? = null
    private var lastUrl: String? = null

    private val density get() = resources.displayMetrics.density
    private fun dp(v: Int) = (v * density).toInt()

    override fun onCreate() {
        super.onCreate()
        wm = getSystemService(WindowManager::class.java)
        showBubble()
        watchRuntime()
    }

    override fun onDestroy() {
        runCatching { panel?.let { if (it.parent != null) wm.removeView(it) } }
        runCatching { bubble?.let { if (it.parent != null) wm.removeView(it) } }
        web?.destroy()
        web = null
        super.onDestroy()
    }

    // ------------------------------------------------------------------ 球

    @SuppressLint("ClickableViewAccessibility")
    private fun showBubble() {
        val view = TextView(this).apply {
            text = "DSH"
            setTextColor(Color.WHITE)
            textSize = 11f
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#2F6FEB"))
            }
        }

        bubbleParams = WindowManager.LayoutParams(
            dp(BALL_DP), dp(BALL_DP),
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = resources.displayMetrics.widthPixels - dp(BALL_DP + SAFE_MARGIN_DP)
            y = resources.displayMetrics.heightPixels / 3
        }

        var downX = 0f
        var downY = 0f
        var startX = 0
        var startY = 0

        view.setOnTouchListener { _, e ->
            when (e.action) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX; downY = e.rawY
                    startX = bubbleParams.x; startY = bubbleParams.y
                    true
                }

                MotionEvent.ACTION_MOVE -> {
                    bubbleParams.x = startX + (e.rawX - downX).toInt()
                    bubbleParams.y = startY + (e.rawY - downY).toInt()
                    runCatching { wm.updateViewLayout(view, bubbleParams) }
                    true
                }

                MotionEvent.ACTION_UP -> {
                    val moved = abs(e.rawX - downX) + abs(e.rawY - downY)
                    if (moved < dp(6)) togglePanel() else snap(view)
                    true
                }

                else -> false
            }
        }
        view.setOnLongClickListener {
            stopSelf()
            true
        }

        bubble = view
        wm.addView(view, bubbleParams)
    }

    /** 贴边吸附：越过中线贴右，否则贴左；竖向夹在安全区内 */
    private fun snap(view: View) {
        val screenW = resources.displayMetrics.widthPixels
        val screenH = resources.displayMetrics.heightPixels
        bubbleParams.x = if (bubbleParams.x + dp(BALL_DP) / 2 > screenW / 2) {
            screenW - dp(BALL_DP + SAFE_MARGIN_DP)
        } else {
            dp(SAFE_MARGIN_DP)
        }
        bubbleParams.y = bubbleParams.y.coerceIn(dp(SAFE_MARGIN_DP), screenH - dp(BALL_DP + SAFE_MARGIN_DP))
        runCatching { wm.updateViewLayout(view, bubbleParams) }
    }

    // ---------------------------------------------------------------- 面板

    private fun togglePanel() {
        val p = panel ?: buildPanel().also { panel = it }
        if (p.parent == null) {
            wm.addView(p, panelParams)
            bubble?.visibility = View.GONE
            lastUrl?.let { loadIntoWeb(it) }
        } else {
            wm.removeView(p)          // 只摘窗口，View 与 WebView 都留着
            bubble?.visibility = View.VISIBLE
        }
    }

    private fun buildPanel(): LinearLayout {
        val screenW = resources.displayMetrics.widthPixels
        val screenH = resources.displayMetrics.heightPixels
        val width = minOf((screenW * 0.92f).toInt(), dp(420))
        val height = (screenH * 0.7f).toInt()

        panelParams = WindowManager.LayoutParams(
            width, height,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
            y = dp(80)
        }

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(12), dp(8), dp(8), dp(8))
            setBackgroundColor(Color.parseColor("#1B1B1F"))
        }
        val title = TextView(this).apply {
            text = "DeepSeek Harness"
            setTextColor(Color.WHITE)
            textSize = 13f
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        val close = TextView(this).apply {
            text = "✕"
            setTextColor(Color.parseColor("#BBBBBB"))
            textSize = 16f
            setPadding(dp(10), 0, dp(10), 0)
            setOnClickListener { togglePanel() }
        }
        header.addView(title)
        header.addView(close)

        val wv = WebView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f,
            )
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                mediaPlaybackRequiresUserGesture = false
                cacheMode = WebSettings.LOAD_DEFAULT
            }
            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) {
                    CookieManager.getInstance().flush()
                }
            }
        }
        web = wv

        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#111114"))
            addView(header)
            addView(wv)
        }
    }

    private fun loadIntoWeb(url: String) {
        if (web?.url != url) web?.loadUrl(url)
    }

    // ------------------------------------------------------------ 跟随内核

    private fun watchRuntime() {
        lifecycleScope.launch {
            DshRuntime.get(this@FloatingBubbleService).state.collect { st ->
                if (st.url != null) lastUrl = st.url
                val view = panel
                if (st.phase == Phase.READY && st.url != null && view?.parent != null) {
                    loadIntoWeb(st.url)
                }
                bubble?.alpha = if (st.phase == Phase.READY) 1f else 0.55f
            }
        }
    }
}