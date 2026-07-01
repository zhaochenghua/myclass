package cn.edu.nb3.myclass

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Parcelable
import android.provider.OpenableColumns
import android.util.Base64
import android.widget.Toast
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.TimeUnit

data class PendingFile(
    val id: String,
    val displayName: String,
    val sizeBytes: Long,
    val fingerprint: String,
    val queuedAtMillis: Long
)

data class PendingLink(
    val id: String,
    val displayName: String,
    val url: String,
    val queuedAtMillis: Long
)

object ExternalFileReceiver {

    private val SUPPORTED_EXTENSIONS = setOf("pdf", "ppt", "pptx", "doc", "docx", "zip", "mp4", "mov", "avi", "webm", "mkv", "3gp")
    private val VIDEO_EXTENSIONS = setOf("mp4", "mov", "avi", "webm", "mkv", "3gp")

    @Volatile
    private var queue = mutableListOf<PendingFile>()

    @Volatile
    private var linkQueue = mutableListOf<PendingLink>()

    @Volatile
    private var lastReceiveDuplicate = false

    private val uploadClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.MINUTES)
        .readTimeout(30, TimeUnit.MINUTES)
        .callTimeout(35, TimeUnit.MINUTES)
        .retryOnConnectionFailure(true)
        .build()

    @Synchronized
    fun pendingCount(): Int = queue.size

    @Synchronized
    fun wasLastReceiveDuplicate(): Boolean {
        val v = lastReceiveDuplicate
        lastReceiveDuplicate = false
        return v
    }

    @Synchronized
    fun isLatestPendingVideo(): Boolean {
        val last = queue.lastOrNull() ?: return false
        val ext = last.displayName.substringAfterLast('.', "").lowercase()
        return ext in VIDEO_EXTENSIONS
    }

    @Synchronized
    fun setLatestPendingName(newName: String, activity: Activity) {
        val last = queue.lastOrNull() ?: return
        val ext = last.displayName.substringAfterLast('.', "").lowercase()
        val newFullName = if (ext.isNotEmpty() && !newName.endsWith(".$ext")) {
            "$newName.$ext"
        } else {
            newName
        }
        // Update queue item
        val idx = queue.lastIndex
        queue[idx] = last.copy(displayName = newFullName)
        // Rename the cached file
        val dir = File(activity.cacheDir, "shared/${last.id}")
        val oldFile = File(dir, last.displayName)
        val newFile = File(dir, newFullName)
        oldFile.renameTo(newFile)
        persistQueue(activity)
    }

    enum class HandleResult {
        IGNORED, FILE, LINK, DUPLICATE
    }

    fun handleIncomingIntent(activity: Activity, intent: Intent?): HandleResult {
        return runCatching {
            handleIncomingIntentInternal(activity, intent)
        }.getOrElse { e ->
            activity.runOnUiThread {
                Toast.makeText(activity, "导入失败: ${e.message}", Toast.LENGTH_SHORT).show()
            }
            HandleResult.IGNORED
        }
    }

    @Synchronized
    fun isLatestPendingLink(): Boolean = linkQueue.isNotEmpty()

    @Synchronized
    fun setLatestLinkName(newName: String, activity: Activity) {
        val last = linkQueue.lastOrNull() ?: return
        val idx = linkQueue.lastIndex
        linkQueue[idx] = last.copy(displayName = newName)
        persistLinkQueue(activity)
    }

    @Synchronized
    fun processPendingLinks(activity: Activity): Int {
        if (linkQueue.isEmpty()) return 0

        val prefs = activity.getSharedPreferences("myclass_auth", Context.MODE_PRIVATE)
        val token = prefs.getString("token", null) ?: return 0

        var attempted = 0
        val baseUrl = BuildConfig.SERVER_BASE_URL.trimEnd('/')

        val iterator = linkQueue.iterator()
        while (iterator.hasNext()) {
            val pending = iterator.next()
            activity.runOnUiThread {
                Toast.makeText(activity, "正在添加链接课件: ${pending.displayName}", Toast.LENGTH_SHORT).show()
            }

            try {
                uploadLink(baseUrl, token, pending)
                iterator.remove()
                attempted++
                activity.runOnUiThread {
                    Toast.makeText(activity, "${pending.displayName} 添加完成", Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                activity.runOnUiThread {
                    Toast.makeText(activity, "添加失败: ${e.message}", Toast.LENGTH_SHORT).show()
                }
                break
            }
        }

        persistLinkQueue(activity)
        return attempted
    }

    private fun handleIncomingIntentInternal(activity: Activity, intent: Intent?): HandleResult {
        // 优先检测 text/plain（链接分享）
        val sharedText = extractSharedText(intent)
        if (sharedText != null) {
            val url = extractUrl(sharedText)
            if (url != null) {
                val id = UUID.randomUUID().toString()
                // 从 URL 生成默认名称
                val defaultName = url.removePrefix("https://").removePrefix("http://")
                    .substringBefore('/').substringBefore('?').ifBlank { "链接" }
                synchronized(this) {
                    lastReceiveDuplicate = false
                    val dup = linkQueue.find { it.url == url }
                    if (dup != null) {
                        lastReceiveDuplicate = true
                        return HandleResult.DUPLICATE
                    }
                    linkQueue.add(PendingLink(
                        id = id,
                        displayName = defaultName,
                        url = url,
                        queuedAtMillis = System.currentTimeMillis()
                    ))
                    persistLinkQueue(activity)
                }
                return HandleResult.LINK
            }
            // 纯文本不是 URL，忽略
            return HandleResult.IGNORED
        }

        val uri = extractUri(intent) ?: return HandleResult.IGNORED
        val (displayName, extension) = resolveFileInfo(activity, uri)

        if (extension !in SUPPORTED_EXTENSIONS) {
            activity.runOnUiThread {
                Toast.makeText(activity, "不支持的文件格式，仅支持 PDF/PPT/DOC/ZIP/视频", Toast.LENGTH_SHORT).show()
            }
            return HandleResult.IGNORED
        }

        val id = UUID.randomUUID().toString()
        val dir = File(activity.cacheDir, "shared/$id")
        dir.mkdirs()
        val targetFile = File(dir, displayName)

        // Copy to local cache with .tmp first, then rename
        val tmpFile = File(dir, "$displayName.tmp")
        try {
            copyUriToFile(activity, uri, tmpFile)
            tmpFile.renameTo(targetFile)
        } catch (e: Exception) {
            tmpFile.delete()
            dir.deleteRecursively()
            activity.runOnUiThread {
                Toast.makeText(activity, "文件导入失败: ${e.message}", Toast.LENGTH_SHORT).show()
            }
            return HandleResult.IGNORED
        }

        val sizeBytes = targetFile.length()
        val fingerprint = computeFingerprint(targetFile, sizeBytes)

        synchronized(this) {
            lastReceiveDuplicate = false
            val dup = queue.find { it.fingerprint == fingerprint }
            if (dup != null) {
                targetFile.delete()
                dir.deleteRecursively()
                lastReceiveDuplicate = true
                return HandleResult.DUPLICATE
            }

            val pending = PendingFile(
                id = id,
                displayName = displayName,
                sizeBytes = sizeBytes,
                fingerprint = fingerprint,
                queuedAtMillis = System.currentTimeMillis()
            )
            queue.add(pending)
            persistQueue(activity)
        }
        return HandleResult.FILE
    }

    @Synchronized
    fun processPendingQueue(activity: Activity): Int {
        if (queue.isEmpty()) return 0

        val prefs = activity.getSharedPreferences("myclass_auth", Context.MODE_PRIVATE)
        val token = prefs.getString("token", null) ?: return 0

        var attempted = 0
        val baseUrl = BuildConfig.SERVER_BASE_URL.trimEnd('/')

        val iterator = queue.iterator()
        while (iterator.hasNext()) {
            val pending = iterator.next()
            val dir = File(activity.cacheDir, "shared/${pending.id}")
            val file = File(dir, pending.displayName)
            if (!file.exists()) {
                iterator.remove()
                continue
            }

            activity.runOnUiThread {
                Toast.makeText(activity, "正在上传待上传课件: ${pending.displayName}", Toast.LENGTH_SHORT).show()
            }

            try {
                uploadFile(baseUrl, token, file, pending.displayName) { uploadedBytes ->
                    val total = pending.sizeBytes
                    if (total > 0) {
                        val pct = ((uploadedBytes * 100L) / total).coerceIn(0L, 100L)
                        activity.runOnUiThread {
                            val mt = activity as? MainActivity
                            if (mt != null) {
                                mt.updateStatus("${pending.displayName}\n待上传队列: ${pct}%")
                            }
                        }
                    }
                }
                file.delete()
                dir.deleteRecursively()
                iterator.remove()
                attempted++
                activity.runOnUiThread {
                    Toast.makeText(activity, "${pending.displayName} 上传完成", Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                activity.runOnUiThread {
                    Toast.makeText(activity, "上传失败: ${e.message}", Toast.LENGTH_SHORT).show()
                }
                break
            }
        }

        persistQueue(activity)
        return attempted
    }

    @Synchronized
    fun clearQueue(activity: Activity) {
        for (pending in queue) {
            val dir = File(activity.cacheDir, "shared/${pending.id}")
            dir.deleteRecursively()
        }
        queue.clear()
        persistQueue(activity)
        linkQueue.clear()
        persistLinkQueue(activity)
    }

    fun restoreQueue(activity: Activity) {
        synchronized(this) {
            if (queue.isNotEmpty()) return
            val prefs = activity.getSharedPreferences("myclass_queue", Context.MODE_PRIVATE)
            val json = prefs.getString("queue", null)
            if (json != null) {
                val arr = runCatching { JSONArray(json) }.getOrNull()
                if (arr != null) {
                    val restored = mutableListOf<PendingFile>()
                    for (i in 0 until arr.length()) {
                        val obj = arr.optJSONObject(i) ?: continue
                        val id = obj.optString("id")
                        val displayName = obj.optString("displayName")
                        val sizeBytes = obj.optLong("sizeBytes")
                        val fingerprint = obj.optString("fingerprint")
                        val queuedAtMillis = obj.optLong("queuedAtMillis")
                        if (id.isEmpty() || displayName.isEmpty()) continue
                        val f = File(activity.cacheDir, "shared/$id/$displayName")
                        if (!f.exists()) continue
                        restored.add(PendingFile(id, displayName, sizeBytes, fingerprint, queuedAtMillis))
                    }
                    queue = restored
                }
            }
            // 恢复链接队列
            if (linkQueue.isEmpty()) {
                val linkJson = prefs.getString("link_queue", null)
                if (linkJson != null) {
                    val arr = runCatching { JSONArray(linkJson) }.getOrNull()
                    if (arr != null) {
                        val restored = mutableListOf<PendingLink>()
                        for (i in 0 until arr.length()) {
                            val obj = arr.optJSONObject(i) ?: continue
                            val id = obj.optString("id")
                            val displayName = obj.optString("displayName")
                            val url = obj.optString("url")
                            val queuedAtMillis = obj.optLong("queuedAtMillis")
                            if (id.isEmpty() || url.isEmpty()) continue
                            restored.add(PendingLink(id, displayName, url, queuedAtMillis))
                        }
                        linkQueue = restored
                    }
                }
            }
        }
    }

    // --- private helpers ---

    private fun extractUri(intent: Intent?): Uri? {
        if (intent == null) return null
        intent.clipData?.let { clip ->
            if (clip.itemCount > 0) return clip.getItemAt(0).uri
        }
        @Suppress("DEPRECATION")
        intent.getParcelableExtra<Parcelable>(Intent.EXTRA_STREAM)?.let { return it as? Uri }
        return intent.data
    }

    private fun resolveFileInfo(activity: Activity, uri: Uri): Pair<String, String> {
        val name = queryDisplayName(activity, uri) ?: "unknown"
        val ext = name.substringAfterLast('.', "").lowercase()
        val displayName = if (ext.isNotEmpty()) {
            val base = name.removeSuffix(".$ext")
            base.ifBlank { "courseware" } + "." + ext
        } else {
            val guessed = guessExtension(activity, uri)
            "courseware." + guessed
        }
        val resolvedExt = displayName.substringAfterLast('.', "").lowercase()
        return Pair(displayName, resolvedExt)
    }

    private fun queryDisplayName(context: Context, uri: Uri): String? {
        var name: String? = null
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                name = c.getString(c.getColumnIndexOrThrow(OpenableColumns.DISPLAY_NAME))
            }
        }
        if (!name.isNullOrBlank()) return name
        return uri.lastPathSegment
    }

    private fun guessExtension(context: Context, uri: Uri): String {
        val type = context.contentResolver.getType(uri) ?: return "pdf"
        return when {
            type.contains("pdf") -> "pdf"
            type.contains("powerpoint") || type.contains("presentation") -> "pptx"
            type.contains("msword") || type.contains("word") -> "docx"
            type.contains("zip") || type.contains("x-zip") -> "zip"
            type.contains("video") || type.contains("mp4") || type.contains("quicktime") || type.contains("avi") || type.contains("webm") || type.contains("3gpp") -> "mp4"
            else -> "pdf"
        }
    }

    private fun copyUriToFile(context: Context, uri: Uri, dest: File) {
        context.contentResolver.openInputStream(uri)?.use { input ->
            FileOutputStream(dest).use { output ->
                val buf = ByteArray(8192)
                var read: Int
                while (input.read(buf).also { read = it } != -1) {
                    output.write(buf, 0, read)
                }
            }
        } ?: throw java.io.IOException("无法打开文件")
    }

    private fun computeFingerprint(file: File, sizeBytes: Long): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buf = ByteArray(65536) // 64KB
            val read = input.read(buf)
            if (read > 0) {
                digest.update(buf, 0, read)
            }
        }
        digest.update(sizeBytes.toString().toByteArray())
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun isNetworkReachable(context: Context): Boolean {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return true
        val net = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(net) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun uploadFile(baseUrl: String, token: String, file: File, displayName: String, onProgress: ((Long) -> Unit)? = null) {
        val fileBody = object : RequestBody() {
            override fun contentType() = "application/octet-stream".toMediaTypeOrNull()
            override fun contentLength() = file.length()
            override fun writeTo(sink: BufferedSink) {
                FileInputStream(file).use { input ->
                    val buf = ByteArray(8192)
                    var read: Int
                    var sent = 0L
                    while (input.read(buf).also { read = it } != -1) {
                        sink.write(buf, 0, read)
                        sent += read
                        onProgress?.invoke(sent)
                    }
                }
            }
        }

        val displayNameBase64 = Base64.encodeToString(
            displayName.toByteArray(Charsets.UTF_8), Base64.NO_WRAP
        )

        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("displayNameBase64", displayNameBase64)
            .addFormDataPart("file", displayName, fileBody)
            .build()

        val request = Request.Builder()
            .url("$baseUrl/api/courseware")
            .header("Authorization", "Bearer $token")
            .post(body)
            .build()

        uploadClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                val msg = runCatching {
                    JSONObject(response.body?.string().orEmpty()).optString("error")
                }.getOrNull() ?: "HTTP ${response.code}"
                throw java.io.IOException(msg)
            }
        }
    }

    private fun persistQueue(activity: Activity) {
        val arr = JSONArray()
        for (p in queue) {
            arr.put(JSONObject().apply {
                put("id", p.id)
                put("displayName", p.displayName)
                put("sizeBytes", p.sizeBytes)
                put("fingerprint", p.fingerprint)
                put("queuedAtMillis", p.queuedAtMillis)
            })
        }
        activity.getSharedPreferences("myclass_queue", Context.MODE_PRIVATE)
            .edit()
            .putString("queue", arr.toString())
            .apply()
    }

    private fun persistLinkQueue(activity: Activity) {
        val arr = JSONArray()
        for (p in linkQueue) {
            arr.put(JSONObject().apply {
                put("id", p.id)
                put("displayName", p.displayName)
                put("url", p.url)
                put("queuedAtMillis", p.queuedAtMillis)
            })
        }
        activity.getSharedPreferences("myclass_queue", Context.MODE_PRIVATE)
            .edit()
            .putString("link_queue", arr.toString())
            .apply()
    }

    private fun extractSharedText(intent: Intent?): String? {
        if (intent == null) return null
        if (intent.type != "text/plain") return null
        intent.getStringExtra(Intent.EXTRA_TEXT)?.let { return it }
        return null
    }

    private fun extractUrl(text: String): String? {
        val trimmed = text.trim()
        // 匹配 http:// 或 https:// 开头的 URL
        val urlRegex = Regex("""(https?://[^\s]+)""")
        val match = urlRegex.find(trimmed)
        return match?.value
    }

    private fun uploadLink(baseUrl: String, token: String, pending: PendingLink) {
        val json = JSONObject().apply {
            put("title", pending.displayName)
            put("url", pending.url)
        }

        val body = okhttp3.RequestBody.create(
            "application/json; charset=utf-8".toMediaTypeOrNull(),
            json.toString()
        )

        val request = Request.Builder()
            .url("$baseUrl/api/courseware/link")
            .header("Authorization", "Bearer $token")
            .post(body)
            .build()

        uploadClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                val msg = runCatching {
                    JSONObject(response.body?.string().orEmpty()).optString("error")
                }.getOrNull() ?: "HTTP ${response.code}"
                throw java.io.IOException(msg)
            }
        }
    }
}
