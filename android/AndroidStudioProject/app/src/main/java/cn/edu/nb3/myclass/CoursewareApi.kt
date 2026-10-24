package cn.edu.nb3.myclass

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.ProtocolException
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Shared transport for imports, library uploads and cast uploads. No Activity or room state. */
object CoursewareApi {
    private const val TAG = "CoursewareApi"
    private const val STAGE_ATTEMPTS = 3
    private const val UPLOAD_ATTEMPTS = 2

    @Volatile var serverBaseUrl: String = BuildConfig.SERVER_BASE_URL
    class AuthenticationRequired(val token: String) : IOException("登录凭据被拒绝，文件已保留，请重新登录后重试")
    private class Rejected(message: String) : IOException(message)
    private class IncompleteRead(message: String) : IOException(message)
    val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.MINUTES)
        .readTimeout(30, TimeUnit.MINUTES)
        .callTimeout(35, TimeUnit.MINUTES)
        .retryOnConnectionFailure(false) // Never replay a non-idempotent publication implicitly.
        .build()

    fun upload(context: Context, uri: Uri, name: String, token: String, callClient: OkHttpClient = client, uploadId: String = "",
               progress: (Long, Long) -> Unit = { _, _ -> }): JSONObject {
        // Automatic retries must stay idempotent server-side, so every logical
        // upload carries one request id even when the caller did not supply one.
        val requestId = uploadId.ifBlank { "android-" + UUID.randomUUID().toString() }
        var staged: File? = null
        try {
            if (uri.scheme != "file" && contentLength(context, uri) <= 0L) {
                // Cloud providers such as DS file report no size (or 0) until the
                // file has been downloaded into their local cache. Using that as
                // Content-Length makes the first upload fail, so copy the stream
                // first: the local file has an exact length, and an empty/partial
                // first read can be retried before anything is published.
                staged = stage(context, uri, progress)
            }
            var attempt = 0
            while (true) {
                val source = staged?.let { Uri.fromFile(it) } ?: uri
                try {
                    return execute("/api/courseware", token, multipart(name, streamBody(context, source, progress)),
                        callClient, requestId)
                } catch (e: AuthenticationRequired) {
                    throw e
                } catch (e: Rejected) {
                    throw e
                } catch (e: IOException) {
                    attempt += 1
                    if (Thread.currentThread().isInterrupted) throw e
                    if (staged == null && uri.scheme != "file" && e.isLengthMismatch()) {
                        // Some providers report a length they cannot deliver on
                        // the first read; copy and verify before retrying.
                        Log.w(TAG, "课件首次读取不完整，改为本地暂存后重试", e)
                        staged = stage(context, uri, progress)
                    } else if (attempt >= UPLOAD_ATTEMPTS) {
                        throw e
                    }
                    Thread.sleep(700L * attempt)
                }
            }
        } finally {
            staged?.delete()
        }
    }

    private fun multipart(name: String, body: RequestBody): RequestBody = MultipartBody.Builder()
        .setType(MultipartBody.FORM)
        .addFormDataPart("displayNameBase64", Base64.encodeToString(name.toByteArray(Charsets.UTF_8), Base64.NO_WRAP))
        .addFormDataPart("file", name, body)
        .build()

    private fun streamBody(context: Context, uri: Uri, progress: (Long, Long) -> Unit): RequestBody {
        val size = contentLength(context, uri)
        return object : RequestBody() {
            override fun contentType() = "application/octet-stream".toMediaTypeOrNull()
            override fun contentLength() = size
            override fun isOneShot() = true
            override fun writeTo(sink: BufferedSink) {
                val input = if (uri.scheme == "file") File(requireNotNull(uri.path)).inputStream()
                    else context.contentResolver.openInputStream(uri) ?: throw IOException("无法读取文件")
                input.use { copyToSink(it, sink, size, progress) }
            }
        }
    }

    private fun copyToSink(input: InputStream, sink: BufferedSink, total: Long, progress: (Long, Long) -> Unit) {
        val buffer = ByteArray(64 * 1024)
        var sent = 0L
        var last = 0L
        while (true) {
            if (Thread.currentThread().isInterrupted) throw IOException("上传已暂停")
            val read = input.read(buffer)
            if (read < 0) break
            sink.write(buffer, 0, read)
            sent += read
            val now = android.os.SystemClock.elapsedRealtime()
            if (now - last >= 300 || (total > 0L && sent >= total)) {
                progress(sent, total)
                last = now
            }
        }
        // Abort before the multipart body is closed when a cloud provider only
        // delivered part of the document; the caller retries with a fresh stream.
        if (total > 0L && sent != total) throw IncompleteRead("文件读取不完整（$sent / $total 字节）")
    }

    private fun Throwable.isLengthMismatch(): Boolean = this is IncompleteRead ||
        (this is ProtocolException &&
            (message.orEmpty().contains("Content-Length", true) || message.orEmpty().contains("expected", true)))

    /** Usually from OpenableColumns; some providers only expose it through the file descriptor. */
    private fun contentLength(context: Context, uri: Uri, allowDescriptor: Boolean = true): Long {
        if (uri.scheme == "file") return File(requireNotNull(uri.path)).length()
        val declared = runCatching {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getLong(0) else -1L
            }
        }.getOrNull() ?: -1L
        if (declared > 0L || !allowDescriptor) return declared
        val stat = runCatching {
            context.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize }
        }.getOrNull() ?: -1L
        return if (stat > 0L) stat else -1L
    }

    /** Copy a cloud stream locally and verify that the provider delivered all bytes. */
    private fun stage(context: Context, uri: Uri, progress: (Long, Long) -> Unit): File {
        val directory = File(context.cacheDir, "courseware-upload").apply { mkdirs() }
        val target = File(directory, UUID.randomUUID().toString() + ".part")
        var failure: Exception? = null
        for (attempt in 1..STAGE_ATTEMPTS) {
            try {
                var copied = 0L
                var last = 0L
                context.contentResolver.openInputStream(uri)?.use { input ->
                    target.outputStream().use { output ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            if (Thread.currentThread().isInterrupted) throw IOException("上传已暂停")
                            val read = input.read(buffer)
                            if (read < 0) break
                            output.write(buffer, 0, read)
                            copied += read
                            val now = android.os.SystemClock.elapsedRealtime()
                            if (now - last >= 300) {
                                progress(copied, -1L)
                                last = now
                            }
                        }
                        output.fd.sync()
                    }
                } ?: throw IOException("无法读取文件")
                val declared = contentLength(context, uri, allowDescriptor = false)
                if (copied > 0L && (declared <= 0L || declared == copied)) {
                    return target
                }
                failure = IOException(
                    if (copied == 0L) "云端文件尚未下载完成"
                    else "文件读取不完整（$copied / $declared 字节）"
                )
            } catch (e: Exception) {
                failure = e
            }
            target.delete()
            if (attempt < STAGE_ATTEMPTS && !Thread.currentThread().isInterrupted) {
                Thread.sleep(700L * attempt)
            }
        }
        throw IOException("无法读取所选文件：${failure?.message ?: "未知错误"}", failure)
    }

    fun link(name: String, url: String, token: String, callClient: OkHttpClient = client, uploadId: String = ""): JSONObject = execute("/api/courseware/link", token,
        JSONObject().put("title", name).put("url", url).toString()
            .toRequestBody("application/json; charset=utf-8".toMediaTypeOrNull()), callClient, uploadId)

    fun linkExists(url: String, token: String, callClient: OkHttpClient): Boolean {
        val request = Request.Builder().url(serverBaseUrl.trimEnd('/') + "/api/courseware/link/exists?url=" + Uri.encode(url))
            .header("Authorization", "Bearer $token").get().build()
        callClient.newCall(request).execute().use { response ->
            if (response.code == 401) throw AuthenticationRequired(token)
            if (!response.isSuccessful) throw IOException("链接检查失败：HTTP ${response.code}")
            return JSONObject(response.body?.string().orEmpty()).getBoolean("exists")
        }
    }

    private fun execute(path: String, token: String, body: RequestBody, callClient: OkHttpClient, uploadId: String): JSONObject {
        val request = Request.Builder().url(serverBaseUrl.trimEnd('/') + path)
            .header("Authorization", "Bearer $token").apply { if (uploadId.isNotBlank()) header("X-Upload-Id", uploadId) }
            .post(body).build()
        callClient.newCall(request).execute().use { response ->
            if (response.code == 401) throw AuthenticationRequired(token)
            val json = runCatching { JSONObject(response.body?.string().orEmpty()) }.getOrDefault(JSONObject())
            if (!response.isSuccessful) throw Rejected(json.optString("error").ifBlank { "HTTP ${response.code}" })
            return json
        }
    }
}
