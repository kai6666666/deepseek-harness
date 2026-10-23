package ai.deepseek.harness

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * 前台服务：持住 proot 子进程，扛住 Android 的进程回收。
 *
 * - foregroundServiceType=specialUse（Android 14 不声明直接抛异常）
 * - START_STICKY：被系统杀掉后重建，重建时 DshRuntime 会自己重新拉起 dsh
 * - WAKE_LOCK 只在实际运行期间持有，READY 后释放
 */
class DshService : Service() {

    companion object {
        private const val TAG = "DshService"
        private const val CHANNEL_ID = "dsh-runtime"
        private const val NOTIFICATION_ID = 0x4453   // "DS"
        const val ACTION_STOP = "ai.deepseek.harness.STOP"

        fun start(context: Context) {
            val intent = Intent(context, DshService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, DshService::class.java))
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var collector: Job? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private lateinit var runtime: DshRuntime

    override fun onCreate() {
        super.onCreate()
        runtime = DshRuntime.get(this)
        createChannel()
        // 回环 MCP server 与内核同期起步；无障碍未授权时工具会回 isError 提示
        McpServer.get(this).startServer()
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            buildNotification("正在启动…", ""),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            } else {
                0
            },
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }

        runtime.start()
        observe()

        // 被系统杀掉后重建：START_STICKY 会让 dsh 重新拉起
        return START_STICKY
    }

    private fun observe() {
        collector?.cancel()
        collector = scope.launch {
            runtime.state.collect { st ->
                val title = when (st.phase) {
                    Phase.INSTALLING -> "正在安装运行环境"
                    Phase.STARTING -> "正在启动 dsh${if (st.port > 0) " :${st.port}" else ""}"
                    Phase.READY -> "dsh 已就绪 · 端口 ${st.port}"
                    Phase.RESTARTING -> "异常，第 ${st.restarts} 次重启"
                    Phase.FAILED -> "启动失败"
                    Phase.STOPPED -> "已停止"
                    Phase.IDLE -> "空闲"
                }
                val text = st.detail.lineSequence().firstOrNull().orEmpty().take(120)
                getSystemService(NotificationManager::class.java)
                    .notify(NOTIFICATION_ID, buildNotification(title, text))
                // 安装/启动阶段同样要压住 CPU：真机上屏幕一关，install 会被 Doze 冻住十几分钟
                applyWakeLock(st.phase != Phase.STOPPED && st.phase != Phase.FAILED && st.phase != Phase.IDLE)
            }
        }
    }

    private fun applyWakeLock(on: Boolean) {
        if (on) {
            if (wakeLock?.isHeld == true) return
            val pm = getSystemService(PowerManager::class.java)
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "deepseek-harness:dsh")
                .apply { setReferenceCounted(false); acquire(6 * 60 * 60 * 1000L) }
        } else {
            runCatching { if (wakeLock?.isHeld == true) wakeLock?.release() }
        }
    }

    private fun createChannel() {
        val ch = NotificationChannel(
            CHANNEL_ID,
            "DSH 运行时",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "DeepSeek Harness 内核运行状态"
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
    }

    private fun buildNotification(title: String, text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stop = PendingIntent.getService(
            this, 1,
            Intent(this, DshService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .addAction(0, "停止", stop)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // 用户划掉任务卡：不杀内核，保持后台常驻
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        collector?.cancel()
        scope.cancel()
        applyWakeLock(false)
        runtime.stop()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}