package cn.edu.nb3.myclass

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.lang.ref.WeakReference
import java.util.concurrent.Executors

/** User-initiated imports continue while the teacher leaves the Activity. */
class ImportUploadService : Service() {
    private val executor = Executors.newSingleThreadExecutor()
    private val client = CoursewareApi.client.newBuilder().dispatcher(okhttp3.Dispatcher()).build()
    @Volatile private var stopped = false
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "课件上传", NotificationManager.IMPORTANCE_LOW))
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(4201, notification("正在准备上传"))
        executor.execute {
            try {
                ExternalFileReceiver.restoreQueue(this)
                @Suppress("DEPRECATION")
                val incoming = intent?.getParcelableExtra<Intent>("incoming")
                if (incoming != null) {
                    report("正在保存分享文件…")
                    when (ExternalFileReceiver.receive(this, incoming)) {
                        ExternalFileReceiver.HandleResult.IGNORED -> report("未找到可导入的文件", finished = true)
                        ExternalFileReceiver.HandleResult.DUPLICATE -> report("文件已在待上传队列中", finished = true)
                        else -> report("文件已保存，无需连接课堂即可上传")
                    }
                }
                val prefs = getSharedPreferences("myclass_auth", MODE_PRIVATE)
                if (prefs.getString("token", null) == null) report("文件已保存，请登录后继续上传", finished = true)
                while (!stopped) {
                    val token = prefs.getString("token", null) ?: break
                    val username = prefs.getString("username", null) ?: break
                    val item = ExternalFileReceiver.next(this, username) ?: break
                    report("正在上传：${item.displayName}")
                    if (item.url.isNotBlank()) CoursewareApi.link(item.displayName, item.url, token, client, item.id)
                    else CoursewareApi.upload(this, Uri.fromFile(ExternalFileReceiver.file(this, item)), item.displayName, token, client, item.id) { sent, total ->
                        val message = if (total > 0 && sent >= total) "${item.displayName}：已传输，服务器处理中"
                            else "${item.displayName}：${if (total > 0) "${sent * 100 / total}%" else "${sent / 1024} KB"}"
                        report(message)
                    }
                    ExternalFileReceiver.complete(this, item)
                    report("${item.displayName} 上传完成", finished = true)
                }
            } catch (e: Exception) {
                report("上传已暂停：${e.message}。文件已保留，可在课件管理中重试。", finished = true,
                    rejectedToken = (e as? CoursewareApi.AuthenticationRequired)?.token)
            } finally {
                Handler(Looper.getMainLooper()).post { if (stopSelfResult(startId)) stopForeground(STOP_FOREGROUND_REMOVE) }
            }
        }
        return START_NOT_STICKY
    }
    private fun notification(message: String) = NotificationCompat.Builder(this, CHANNEL)
        .setSmallIcon(R.drawable.ic_stat_screen_share).setContentTitle("课件上传")
        .setContentText(message).setOngoing(true)
        .setContentIntent(PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)).build()
    private fun report(message: String, finished: Boolean = false, rejectedToken: String? = null) {
        lastStatus = message
        getSystemService(NotificationManager::class.java).notify(4201, notification(message))
        Handler(Looper.getMainLooper()).post { observer?.get()?.onImportStatus(message, finished, rejectedToken) }
    }
    override fun onTimeout(startId: Int, fgsType: Int) {
        stopped = true
        client.dispatcher.cancelAll()
        lastStatus = "上传已暂停，文件已保留，请重试"
        stopSelf()
    }
    override fun onDestroy() {
        stopped = true
        client.dispatcher.cancelAll()
        executor.shutdownNow()
        super.onDestroy()
    }
    companion object {
        private const val CHANNEL = "courseware-imports"
        @Volatile var lastStatus = ""
            private set
        private var observer: WeakReference<MainActivity>? = null
        fun observe(activity: MainActivity) { observer = WeakReference(activity) }
        fun detach(activity: MainActivity) { if (observer?.get() === activity) observer = null }
        fun start(context: Context) {
            if (ExternalFileReceiver.pendingCount() == 0) return
            if (context.getSharedPreferences("myclass_auth", Context.MODE_PRIVATE).getString("token", null) == null) return
            ContextCompat.startForegroundService(context, Intent(context, ImportUploadService::class.java))
        }
        fun receive(context: Context, incoming: Intent) {
            // Start while the share Activity is foreground, before copying a large URI.
            // The service owns both import and upload, including the URI permission grant.
            val service = Intent(context, ImportUploadService::class.java).putExtra("incoming", incoming)
            @Suppress("DEPRECATION")
            val uri = incoming.getParcelableExtra<Uri>(Intent.EXTRA_STREAM) ?: incoming.data
            service.clipData = incoming.clipData ?: uri?.let { android.content.ClipData.newRawUri("import", it) }
            service.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            ContextCompat.startForegroundService(context, service)
        }
    }
}
