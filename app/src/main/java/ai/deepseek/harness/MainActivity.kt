package ai.deepseek.harness

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.launch

/**
 * 外壳：状态栏 + WebView。
 *
 * 关键点（全部由 M0 实测驱动）：
 *  - 只加载 DshRuntime 给出的**带 token 的授权 URL**，绝不拼 origin（裸 origin 是 401）
 *  - 进入页面必须带 cookie：CookieManager 开 cookie + 第三方 cookie，并在 onPause flush
 *  - 文件选择器 / 下载 / 新窗口必须自己接，否则附件与 deliverables 全废
 */
class MainActivity : AppCompatActivity() {

    private lateinit var status: TextView
    private lateinit var progress: ProgressBar
    private lateinit var webView: WebView

    private var loadedUrl: String? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    private val fileChooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val cb = fileCallback ?: return@registerForActivityResult
        fileCallback = null
        val data = result.data
        cb.onReceiveValue(
            if (result.resultCode == RESULT_OK && data != null) {
                data.clipData?.let { clip -> Array(clip.itemCount) { clip.getItemAt(it).uri } }
                    ?: data.data?.let { arrayOf(it) }
            } else {
                null
            }
        )
    }

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* 拒绝也能跑，只是没有通知 */ }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = ViewGroup.LayoutParams(MATCH, MATCH)
        }

        status = TextView(this).apply {
            text = "准备中…"
            textSize = 12f
            setPadding(24, 18, 24, 18)
            maxLines = 3
        }

        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(status, LinearLayout.LayoutParams(0, WRAP, 1f))
        }

        val reload = Button(this).apply {
            text = "重启"
            setOnClickListener { DshRuntime.get(this@MainActivity).restartNow() }
        }
        val btnSettings = Button(this).apply {
            text = "设置"
            setOnClickListener { openBatterySettings() }
        }
        val btnFloat = Button(this).apply {
            text = "悬浮"
            setOnClickListener {
                if (!FloatingBubbleService.start(this@MainActivity)) {
                    openBatterySettings()   // 没有悬浮窗权限时先引导；真正授权走 request_permission
                }
            }
        }
        bar.addView(reload)
        bar.addView(btnSettings)
        bar.addView(btnFloat)

        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = true
            visibility = View.GONE
        }

        webView = WebView(this).apply {
            layoutParams = LinearLayout.LayoutParams(MATCH, 0, 1f)
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                mediaPlaybackRequiresUserGesture = false
                loadWithOverviewMode = true
                useWideViewPort = true
                cacheMode = WebSettings.LOAD_DEFAULT
                mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            }
            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    val url = request?.url?.toString() ?: return false
                    // 只把 http(s) 留在 WebView 内，其余交给系统
                    return if (url.startsWith("http")) false else {
                        runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
                        true
                    }
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    CookieManager.getInstance().flush()
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onProgressChanged(view: WebView?, newProgress: Int) {
                    this@MainActivity.progress.progress = newProgress
                    this@MainActivity.progress.visibility =
                        if (newProgress in 1..99) View.VISIBLE else View.GONE
                }

                override fun onShowFileChooser(
                    view: WebView?,
                    callback: ValueCallback<Array<Uri>>?,
                    params: FileChooserParams?,
                ): Boolean {
                    fileCallback?.onReceiveValue(null)
                    fileCallback = callback
                    return runCatching {
                        fileChooser.launch(params?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                            type = "*/*"
                            addCategory(Intent.CATEGORY_OPENABLE)
                        })
                        true
                    }.getOrDefault(false)
                }
            }
            setDownloadListener { url, _, _, mime, _ ->
                runCatching {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply { setDataAndType(Uri.parse(url), mime) })
                }
            }
        }

        root.addView(bar)
        root.addView(progress)
        root.addView(webView)
        setContentView(root)

        askNotificationPermission()
        DshService.start(this)
        observeRuntime()
    }

    private fun observeRuntime() {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                DshRuntime.get(this@MainActivity).state.collect { st ->
                    status.text = "${st.phase}  ${if (st.port > 0) ":$st.port" else ""}\n" +
                        st.detail.lineSequence().firstOrNull().orEmpty()
                    if (st.phase == Phase.READY && st.url != null && st.url != loadedUrl) {
                        loadedUrl = st.url
                        progress.visibility = View.VISIBLE
                        webView.loadUrl(st.url)
                    }
                }
            }
        }
    }

    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }

    /** 电池优化白名单：不然锁屏几分钟内核就被冻结 */
    private fun openBatterySettings() {
        runCatching {
            startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    .setData(Uri.parse("package:$packageName"))
            )
        }.onFailure {
            runCatching { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
        }
    }

    override fun onPause() {
        super.onPause()
        // 关键：cookie 不 flush 的话，进程被杀 = 登录态丢失，只能重新抓 URL
        CookieManager.getInstance().flush()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (this::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
            return
        }
        @Suppress("DEPRECATION")
        super.onBackPressed()
    }

    override fun onDestroy() {
        if (this::webView.isInitialized) {
            webView.stopLoading()
            webView.destroy()
        }
        super.onDestroy()
    }

    companion object {
        private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        private const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT
    }
}