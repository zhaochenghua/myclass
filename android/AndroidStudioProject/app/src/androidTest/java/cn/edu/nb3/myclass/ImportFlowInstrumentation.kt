package cn.edu.nb3.myclass

import android.app.Activity
import android.app.Instrumentation
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Bundle
import androidx.core.content.FileProvider
import okhttp3.Request
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** Runs only against server/testSupport.js; no classroom or real account required. */
class ImportFlowInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    override fun onStart() {
        val results = Bundle()
        try {
            check(BuildConfig.SERVER_BASE_URL == "http://10.0.2.2:3107/myclass") { "Use isolated emulator server on port 3107" }
            val app = targetContext
            val prefs = app.getSharedPreferences("myclass_auth", Context.MODE_PRIVATE)
            val oldUser = prefs.getString("username", null)
            check(oldUser == null || oldUser.endsWith("_test")) { "Do not replace a real account" }
            val token = CoursewareApi.client.newCall(Request.Builder()
                .url("${BuildConfig.SERVER_BASE_URL}/api/auth/login")
                .post("""{"username":"alice_test","password":"test1234"}""".toRequestBody("application/json".toMediaTypeOrNull())).build())
                .execute().use { check(it.isSuccessful); JSONObject(it.body!!.string()).getString("token") }
            prefs.edit().putString("token", token).putString("username", "alice_test").commit()
            val activity = startActivitySync(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
            waitForIdleSync()
            val suffix = System.currentTimeMillis().toString()
            val directory = File(app.cacheDir, "shared/test-$suffix").apply { mkdirs() }
            val image = File(directory, "图片分享-$suffix.png")
            val bitmap = Bitmap.createBitmap(800, 600, Bitmap.Config.ARGB_8888)
            bitmap.eraseColor(Color.rgb(26, 125, 210))
            val canvas = android.graphics.Canvas(bitmap)
            val paint = android.graphics.Paint().apply { color = Color.WHITE; textSize = 80f }
            canvas.drawText("IMAGE $suffix", 30f, 300f, paint)
            image.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
            fun share(file: File, action: String) {
                val uri = FileProvider.getUriForFile(app, "${app.packageName}.fileprovider", file)
                val intent = Intent(app, MainActivity::class.java).apply {
                    this.action = action
                    if (action == Intent.ACTION_SEND) { type = "image/png"; putExtra(Intent.EXTRA_STREAM, uri) }
                    else setDataAndType(uri, "application/pdf")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                runOnMainSync { app.startActivity(intent) }
            }
            fun list() = CoursewareApi.client.newCall(Request.Builder().url("${BuildConfig.SERVER_BASE_URL}/api/courseware")
                .header("Authorization", "Bearer $token").build()).execute().use {
                    check(it.isSuccessful); JSONObject(it.body!!.string()).getJSONArray("items")
                }
            fun awaitUploaded(file: File): Long {
                val start = System.currentTimeMillis()
                while (System.currentTimeMillis() - start < 20000) {
                    val items = list()
                    if ((0 until items.length()).any { items.getJSONObject(it).optString("fileName") == file.name }) return System.currentTimeMillis() - start
                    Thread.sleep(100)
                }
                error("Upload timeout: ${file.name}; ${ImportUploadService.lastStatus}")
            }
            share(image, Intent.ACTION_SEND)
            val imageMs = awaitUploaded(image)
            check(prefs.getString("token", null) == token)
            // An ordinary resource's 401 cannot invalidate a valid account.
            runOnMainSync { activity.onAuthenticationExpired(token) }
            Thread.sleep(700)
            check(prefs.getString("token", null) == token) { "Valid login cleared" }
            val pdf = File(directory, "打开方式-$suffix.pdf")
            pdf.writeText("%PDF-1.4\n% $suffix\n%%EOF")
            share(pdf, Intent.ACTION_VIEW)
            // Leave the Activity as soon as import begins; service must finish without it.
            runOnMainSync { app.startActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            val pdfMs = awaitUploaded(pdf)
            check(prefs.getString("token", null) == token)
            val id = UUID.randomUUID().toString()
            val first = CoursewareApi.upload(app, android.net.Uri.fromFile(pdf), "retry-$suffix.pdf", token, uploadId = id)
            val retry = CoursewareApi.upload(app, android.net.Uri.fromFile(pdf), "retry-$suffix.pdf", token, uploadId = id)
            check(first.getString("id") == retry.getString("id")) { "Retry duplicated publication" }
            // A rejected request retains its durable inbox item and cannot leak into another account.
            val pending = File(directory, "待重试-$suffix.pdf").apply { writeText("%PDF-1.4\n% pending $suffix") }
            val incoming = Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM,
                FileProvider.getUriForFile(app, "${app.packageName}.fileprovider", pending)).setType("application/pdf")
            check(ExternalFileReceiver.handleIncomingIntent(activity, incoming) == ExternalFileReceiver.HandleResult.FILE)
            val task = ExternalFileReceiver.next(app, "alice_test") ?: error("Missing pending task")
            check(ExternalFileReceiver.next(app, "bob_test") == null) { "Cross-account import" }
            try {
                CoursewareApi.upload(app, android.net.Uri.fromFile(ExternalFileReceiver.file(app, task)), task.displayName, "invalid-test-token")
                error("Expected authentication rejection")
            } catch (_: CoursewareApi.AuthenticationRequired) { }
            check(ExternalFileReceiver.file(app, task).exists())
            check(ExternalFileReceiver.pendingCount() > 0)
            check(prefs.getString("token", null) == token)
            // Leave the durable pending item for the next cold app start to resume.
            results.putString("stream", "PASS: SEND image=${imageMs}ms, VIEW/background PDF=${pdfMs}ms; no classroom; valid session retained; idempotent retry; rejected upload retained; owner isolation; pending item prepared for cold-start recovery.\n")
            finish(Activity.RESULT_OK, results)
        } catch (error: Throwable) {
            results.putString("stream", "FAIL: ${android.util.Log.getStackTraceString(error)}")
            finish(Activity.RESULT_CANCELED, results)
        }
    }
}
