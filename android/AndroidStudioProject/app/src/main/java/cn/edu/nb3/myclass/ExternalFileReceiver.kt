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

object ExternalFileReceiver {

    private val SUPPORTED_EXTENSIONS = setOf("pdf", "ppt", "pptx", "doc", "docx", "zip")

    @Volatile
    private var queue = mutableListOf<PendingFile>()

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

    fun handleIncomingIntent(activity: Activity, intent: Intent?): Boolean {
        return runCatching {
            handleIncomingIntentInternal(activity, intent)
        }.getOrElse { e ->
            activity.runOnUiThread {
                Toast.makeText(activity, "文件导入失败: ${e.message}", Toast.LENGTH_SHORT).show()
            }
            false
        }
    }

    private fun handleIncomingIntentInternal(activity: Activity, intent: Intent?): Boolean {
        val uri = extractUri(intent) ?: return false
        val (displayName, extension) = resolveFileInfo(activity, uri)

        if (extension !in SUPPORTED_EXTENSIONS) {
            activity.runOnUiThread {
                Toast.makeText(activity, "不支持的文件格式，仅支持 PDF/PPT/DOC/ZIP", Toast.LENGTH_SHORT).show()
            }
            return false
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
            return false
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
                return false
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
        return true
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
    }

    fun restoreQueue(activity: Activity) {
        synchronized(this) {
            if (queue.isNotEmpty()) return
            val prefs = activity.getSharedPreferences("myclass_queue", Context.MODE_PRIVATE)
            val json = prefs.getString("queue", null) ?: return
            val arr = runCatching { JSONArray(json) }.getOrNull() ?: return
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
}
