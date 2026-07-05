package cn.edu.nb3.myclass

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.FileProvider
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * App 自动升级管理器
 *
 * 流程：
 * 1. 请求 /api/config 获取服务端最新版本号
 * 2. 与本地 BuildConfig.VERSION_NAME 比较
 * 3. 若服务端版本更高，后台下载 APK（带进度对话框）
 * 4. 下载完成后弹窗引导用户安装
 */
class UpdateManager(private val activity: Activity) {

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()

    private var downloadDialog: AlertDialog? = null

    fun checkForUpdate() {
        Thread {
            runCatching {
                val request = Request.Builder()
                    .url("${BuildConfig.SERVER_BASE_URL.trimEnd('/')}/api/config")
                    .get()
                    .build()
                httpClient.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) {
                        throw IOException("获取配置失败：HTTP ${response.code}")
                    }
                    val body = response.body?.string() ?: throw IOException("空响应")
                    val config = JSONObject(body)
                    val remoteVersion = config.optString("apkVersion", "")
                    val apkUrl = config.optString("apkUrl", "")
                    if (remoteVersion.isBlank() || apkUrl.isBlank()) return@use
                    if (isNewerVersion(BuildConfig.VERSION_NAME, remoteVersion)) {
                        activity.runOnUiThread {
                            showUpdateAvailableDialog(remoteVersion, apkUrl)
                        }
                    }
                }
            }.onFailure { /* 静默失败，不影响正常使用 */ }
        }.start()
    }

    private fun showUpdateAvailableDialog(remoteVersion: String, apkUrl: String) {
        AlertDialog.Builder(activity)
            .setTitle("发现新版本")
            .setMessage("新版本 v$remoteVersion 已发布，是否立即更新？\n\n当前版本：v${BuildConfig.VERSION_NAME}")
            .setCancelable(false)
            .setNegativeButton("稍后", null)
            .setPositiveButton("立即更新") { _, _ ->
                startDownload(apkUrl)
            }
            .show()
    }

    private fun startDownload(apkUrl: String) {
        val progressText = TextView(activity).apply {
            text = "准备下载..."
            gravity = Gravity.CENTER
            val pad = dp(16)
            setPadding(pad, pad, pad, 0)
        }
        val progressBar = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progress = 0
            val pad = dp(16)
            setPadding(pad, dp(8), pad, dp(16))
        }
        val container = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            addView(progressText)
            addView(progressBar)
        }

        downloadDialog = AlertDialog.Builder(activity)
            .setTitle("正在下载更新")
            .setView(container)
            .setCancelable(false)
            .setNegativeButton("取消") { _, _ ->
                /* 取消会中断线程，但实际中断由 call.cancel 控制 */
            }
            .show()

        Thread {
            runCatching {
                downloadApkBlocking(apkUrl) { percent ->
                    activity.runOnUiThread {
                        if (downloadDialog?.isShowing == true) {
                            progressBar.progress = percent
                            progressText.text = "下载中... $percent%"
                        }
                    }
                }
            }.onSuccess { file ->
                activity.runOnUiThread {
                    downloadDialog?.dismiss()
                    downloadDialog = null
                    showInstallDialog(file)
                }
            }.onFailure { error ->
                activity.runOnUiThread {
                    downloadDialog?.dismiss()
                    downloadDialog = null
                    Toast.makeText(
                        activity,
                        error.message ?: "下载失败，请稍后重试",
                        Toast.LENGTH_LONG
                    ).show()
                }
            }
        }.start()
    }

    private fun downloadApkBlocking(apkUrl: String, onProgress: (Int) -> Unit): File {
        val updateDir = File(activity.cacheDir, "apk_updates").apply { mkdirs() }
        val apkFile = File(updateDir, "myclass_update.apk")
        if (apkFile.exists()) apkFile.delete()

        val request = Request.Builder().url(apkUrl).get().build()
        httpClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IOException("下载失败：HTTP ${response.code}")
            }
            val body = response.body ?: throw IOException("下载失败：空响应")
            val totalBytes = body.contentLength()
            var downloadedBytes = 0L
            val inputStream = body.byteStream()
            val buffer = ByteArray(8192)
            var lastPercent = -1
            FileOutputStream(apkFile).use { fos ->
                while (true) {
                    val read = inputStream.read(buffer)
                    if (read == -1) break
                    fos.write(buffer, 0, read)
                    downloadedBytes += read
                    if (totalBytes > 0) {
                        val percent = ((downloadedBytes * 100) / totalBytes).toInt().coerceIn(0, 100)
                        if (percent != lastPercent) {
                            lastPercent = percent
                            onProgress(percent)
                        }
                    }
                }
            }
        }
        return apkFile
    }

    private fun showInstallDialog(apkFile: File) {
        AlertDialog.Builder(activity)
            .setTitle("下载完成")
            .setMessage("新版本已下载完成，是否立即安装？")
            .setCancelable(false)
            .setNegativeButton("稍后", null)
            .setPositiveButton("立即安装") { _, _ ->
                installApk(apkFile)
            }
            .show()
    }

    private fun installApk(apkFile: File) {
        // Android 8+ 需要检查是否有安装未知来源应用的权限
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !activity.packageManager.canRequestPackageInstalls()
        ) {
            AlertDialog.Builder(activity)
                .setTitle("需要安装权限")
                .setMessage("安装更新需要允许来自此来源的应用，请在设置中开启后重试。")
                .setNegativeButton("取消", null)
                .setPositiveButton("去设置") { _, _ ->
                    val intent = Intent(
                        android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:${activity.packageName}")
                    )
                    activity.startActivity(intent)
                }
                .show()
            return
        }

        val uri = FileProvider.getUriForFile(
            activity,
            "${activity.packageName}.fileprovider",
            apkFile
        )
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        activity.startActivity(intent)
    }

    companion object {
        /**
         * 比较版本号，格式如 "1.4.3-20260702"
         * @return true 表示 remote 比 local 新
         */
        fun isNewerVersion(local: String, remote: String): Boolean {
            val localParts = local.split("-")
            val remoteParts = remote.split("-")

            // 比较语义版本部分（如 1.4.3）
            val localSem = localParts[0].split(".").map { it.toIntOrNull() ?: 0 }
            val remoteSem = remoteParts[0].split(".").map { it.toIntOrNull() ?: 0 }
            val maxLen = maxOf(localSem.size, remoteSem.size)
            for (i in 0 until maxLen) {
                val l = localSem.getOrElse(i) { 0 }
                val r = remoteSem.getOrElse(i) { 0 }
                if (r > l) return true
                if (r < l) return false
            }

            // 语义版本相同，比较日期部分（如 20260702）
            val localDate = localParts.getOrElse(1) { "0" }.toIntOrNull() ?: 0
            val remoteDate = remoteParts.getOrElse(1) { "0" }.toIntOrNull() ?: 0
            return remoteDate > localDate
        }

    }

    private fun dp(value: Int): Int {
        val density = activity.resources.displayMetrics.density
        return (value * density).toInt()
    }
}
