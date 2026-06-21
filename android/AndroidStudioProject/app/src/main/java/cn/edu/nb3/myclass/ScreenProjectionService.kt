package cn.edu.nb3.myclass

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

class ScreenProjectionService : Service() {
    override fun onCreate() {
        super.onCreate()
        ensureNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            buildNotification(),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            } else {
                0
            }
        )
        markForegroundStarted()
        return START_STICKY
    }

    override fun onDestroy() {
        markForegroundStopped()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }
        val manager = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            "屏幕共享",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "上课投屏平台屏幕共享"
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_screen_share)
            .setContentTitle("正在共享屏幕")
            .setContentText("上课投屏平台正在投屏手机屏幕")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()

    companion object {
        private const val CHANNEL_ID = "myclass_screen_projection"
        private const val NOTIFICATION_ID = 20260621
        private val callbackLock = Any()
        private val foregroundCallbacks = mutableListOf<() -> Unit>()
        @Volatile
        private var foregroundStarted = false

        fun start(context: Context, onForegroundStarted: (() -> Unit)? = null) {
            onForegroundStarted?.let { callback ->
                var runImmediately = false
                synchronized(callbackLock) {
                    if (foregroundStarted) {
                        runImmediately = true
                    } else {
                        foregroundCallbacks.add(callback)
                    }
                }
                if (runImmediately) {
                    Handler(Looper.getMainLooper()).post(callback)
                }
            }
            ContextCompat.startForegroundService(
                context,
                Intent(context, ScreenProjectionService::class.java)
            )
        }

        fun stop(context: Context) {
            markForegroundStopped()
            context.stopService(Intent(context, ScreenProjectionService::class.java))
        }

        private fun markForegroundStarted() {
            val callbacks = synchronized(callbackLock) {
                foregroundStarted = true
                foregroundCallbacks.toList().also {
                    foregroundCallbacks.clear()
                }
            }
            val handler = Handler(Looper.getMainLooper())
            callbacks.forEach { callback ->
                handler.post(callback)
            }
        }

        private fun markForegroundStopped() {
            synchronized(callbackLock) {
                foregroundStarted = false
                foregroundCallbacks.clear()
            }
        }
    }
}
