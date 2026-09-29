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

    /** 已下载待安装的更新包：去开启安装权限后返回时复用它，不再重新下载 */
    private var pendingInstallApk: File? = null

    /** 正在等用户去「允许安装未知应用」设置页授权（返回时只处理一次） */
    private var awaitingInstallPermission = false

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
                        val cached = cachedApkFor(remoteVersion)
                        activity.runOnUiThread {
                            if (cached != null) {
                                // 同一个版本之前已经下载过（例如去开启安装权限后返回）：直接给「立即安装」
                                showInstallDialog(cached)
                            } else {
                                showUpdateAvailableDialog(remoteVersion, apkUrl)
                            }
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
                startDownload(apkUrl, remoteVersion)
            }
            .show()
    }

    private fun startDownload(apkUrl: String, remoteVersion: String) {
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
                downloadApkBlocking(apkUrl, remoteVersion) { percent ->
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

    /** 更新包按版本命名缓存：同一版本只下载一次，权限设置返回后可直接复用 */
    private fun apkFileFor(version: String): File {
        val updateDir = File(activity.cacheDir, "apk_updates").apply { mkdirs() }
        val safeName = version.replace(Regex("[^A-Za-z0-9._-]"), "_")
        return File(updateDir, "myclass_$safeName.apk")
    }

    /** 已经下载完成的同版本安装包，没有则返回 null */
    private fun cachedApkFor(version: String): File? =
        apkFileFor(version).takeIf { it.exists() && it.length() > 0L }

    private fun downloadApkBlocking(
        apkUrl: String,
        version: String,
        onProgress: (Int) -> Unit
    ): File {
        val apkFile = apkFileFor(version)
        // 已经下载好同一版本（例如去开启安装权限后返回）：直接用，不重新下载
        cachedApkFor(version)?.let { return it }
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
        // 下载成功后清掉其它版本的旧包，避免缓存越积越多
        apkFile.parentFile?.listFiles()?.forEach { other ->
            if (other.name.startsWith("myclass_") && other != apkFile) other.delete()
        }
        return apkFile
    }

    /** 下载完成后不直接安装，先给出「立即安装」按钮 */
    private fun showInstallDialog(apkFile: File) {
        pendingInstallApk = apkFile
        AlertDialog.Builder(activity)
            .setTitle("新版本已下载完成")
            .setMessage(
                "点「立即安装」开始安装。\n\n" +
                    "若系统提示需要允许安装未知应用，开启后返回本应用再点一次「立即安装」即可，" +
                    "安装包已经下载好，不会再重新下载。"
            )
            .setCancelable(false)
            .setNegativeButton("稍后", null)
            .setPositiveButton("立即安装") { _, _ ->
                installApk(apkFile)
            }
            .show()
    }

    /**
     * 从「允许安装未知应用」设置页返回时调用：
     * 权限已开启就直接复用刚才那个安装包，无需重新下载。
     */
    fun onResumeFromSettings() {
        if (!awaitingInstallPermission) return
        awaitingInstallPermission = false
        val apkFile = pendingInstallApk ?: return
        val granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
            activity.packageManager.canRequestPackageInstalls()
        if (!granted) return
        if (!apkFile.exists() || apkFile.length() == 0L) {
            pendingInstallApk = null
            return
        }
        activity.runOnUiThread { showInstallDialog(apkFile) }
    }

    private fun installApk(apkFile: File) {
        // Android 8+ 需要检查是否有安装未知来源应用的权限
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !activity.packageManager.canRequestPackageInstalls()
        ) {
            // 记住这个安装包：去设置授权后返回直接复用，不再重新下载
            pendingInstallApk = apkFile
            AlertDialog.Builder(activity)
                .setTitle("需要安装权限")
                .setMessage(
                    "请允许本应用「安装未知应用」，开启后返回本应用会自动再次给出「立即安装」。\n\n" +
                        "安装包已经下载好，无需重新下载。"
                )
                .setNegativeButton("取消", null)
                .setPositiveButton("去设置") { _, _ ->
                    awaitingInstallPermission = true
                    val intent = Intent(
                        android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:${activity.packageName}")
                    )
                    runCatching { activity.startActivity(intent) }
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
        // 本应用自己也能“打开”APK（清单里声明了 VIEW + */*），不指定目标时系统会弹
        // “打开方式”（MyClass / 软件包安装程序）。这里直接挑系统安装器，
        // 挑不到再退回“非本应用”的第一个候选，最后才用隐式 Intent。
        val candidates = runCatching {
            activity.packageManager.queryIntentActivities(intent, 0)
        }.getOrDefault(emptyList())
        val installer = candidates.firstOrNull {
            it.activityInfo.packageName.contains("packageinstaller", ignoreCase = true)
        } ?: candidates.firstOrNull { it.activityInfo.packageName != activity.packageName }
        installer?.let {
            intent.setClassName(it.activityInfo.packageName, it.activityInfo.name)
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
