package cn.edu.nb3.myclass

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
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
import java.util.concurrent.TimeUnit

/** Shared transport for imports, library uploads and cast uploads. No Activity or room state. */
object CoursewareApi {
    @Volatile var serverBaseUrl: String = BuildConfig.SERVER_BASE_URL
    class AuthenticationRequired(val token: String) : IOException("登录凭据被拒绝，文件已保留，请重新登录后重试")
    val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.MINUTES)
        .readTimeout(30, TimeUnit.MINUTES)
        .callTimeout(35, TimeUnit.MINUTES)
        .retryOnConnectionFailure(false) // Never replay a non-idempotent publication implicitly.
        .build()

    fun upload(context: Context, uri: Uri, name: String, token: String, callClient: OkHttpClient = client, uploadId: String = "",
               progress: (Long, Long) -> Unit = { _, _ -> }): JSONObject {
        val size = if (uri.scheme == "file") File(requireNotNull(uri.path)).length() else
            context.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use {
                if (it.moveToFirst() && !it.isNull(0)) it.getLong(0) else -1L
            } ?: -1L
        val body = object : RequestBody() {
            override fun contentType() = "application/octet-stream".toMediaTypeOrNull()
            override fun contentLength() = size
            override fun isOneShot() = true
            override fun writeTo(sink: BufferedSink) {
                val input = if (uri.scheme == "file") File(requireNotNull(uri.path)).inputStream()
                    else context.contentResolver.openInputStream(uri) ?: throw IOException("无法读取文件")
                input.use {
                    val buffer = ByteArray(64 * 1024)
                    var sent = 0L
                    var last = 0L
                    while (true) {
                        if (Thread.currentThread().isInterrupted) throw IOException("上传已暂停")
                        val read = it.read(buffer)
                        if (read < 0) break
                        sink.write(buffer, 0, read)
                        sent += read
                        val now = android.os.SystemClock.elapsedRealtime()
                        if (now - last >= 300 || sent == size) {
                            progress(sent, size)
                            last = now
                        }
                    }
                }
            }
        }
        return execute("/api/courseware", token, MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("displayNameBase64", Base64.encodeToString(name.toByteArray(Charsets.UTF_8), Base64.NO_WRAP))
            .addFormDataPart("file", name, body).build(), callClient, uploadId)
    }

    fun link(name: String, url: String, token: String, callClient: OkHttpClient = client, uploadId: String = ""): JSONObject = execute("/api/courseware/link", token,
        JSONObject().put("title", name).put("url", url).toString()
            .toRequestBody("application/json; charset=utf-8".toMediaTypeOrNull()), callClient, uploadId)

    private fun execute(path: String, token: String, body: RequestBody, callClient: OkHttpClient, uploadId: String): JSONObject {
        val request = Request.Builder().url(serverBaseUrl.trimEnd('/') + path)
            .header("Authorization", "Bearer $token").apply { if (uploadId.isNotBlank()) header("X-Upload-Id", uploadId) }
            .post(body).build()
        callClient.newCall(request).execute().use { response ->
            if (response.code == 401) throw AuthenticationRequired(token)
            val json = runCatching { JSONObject(response.body?.string().orEmpty()) }.getOrDefault(JSONObject())
            if (!response.isSuccessful) throw IOException(json.optString("error").ifBlank { "HTTP ${response.code}" })
            return json
        }
    }
}
