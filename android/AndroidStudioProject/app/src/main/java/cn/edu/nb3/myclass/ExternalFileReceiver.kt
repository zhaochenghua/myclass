package cn.edu.nb3.myclass

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.UUID

/** Durable import inbox. Locks protect metadata only, never copying or HTTP. */
object ExternalFileReceiver {
    data class Pending(val id: String, val displayName: String, val fingerprint: String = "",
                       val url: String = "", val owner: String = "", val ready: Boolean = true)
    enum class HandleResult { IGNORED, FILE, LINK, DUPLICATE }
    private val queue = mutableListOf<Pending>()
    private var restored = false
    private val extensions = setOf("pdf", "ppt", "pptx", "doc", "docx", "zip", "html", "htm",
        "mp4", "mov", "avi", "webm", "mkv", "3gp", "jpg", "jpeg", "png", "gif", "webp", "bmp")
    private fun prefs(context: Context) = context.getSharedPreferences("myclass_queue", Context.MODE_PRIVATE)
    private fun owner(context: Context) = context.getSharedPreferences("myclass_auth", Context.MODE_PRIVATE).getString("username", "").orEmpty()
    fun file(context: Context, item: Pending) = File(context.filesDir, "imports/${item.id}/payload")

    @Synchronized fun pendingCount() = queue.count { it.ready }
    @Synchronized fun containsLink(url: String, username: String) = queue.any { it.url == url && it.owner == username }
    @Synchronized fun enqueueLink(context: Context, url: String, name: String, username: String) {
        restoreQueue(context)
        if (containsLink(url, username)) return
        queue.add(Pending(UUID.randomUUID().toString(), name, url = url, owner = username))
        persist(context)
    }
    @Synchronized fun restoreQueue(context: Context) {
        if (restored) return
        val saved = prefs(context).getString("imports", null)
        if (saved != null) {
            val array = JSONArray(saved)
            for (i in 0 until array.length()) {
                val o = array.getJSONObject(i)
                queue.add(Pending(o.getString("id"), o.getString("name"), o.optString("hash"),
                    o.optString("url"), o.optString("owner"), o.optBoolean("ready", true)))
            }
        } else {
            // Upgrade the old cache-backed inbox once, retaining pending imports.
            for (key in listOf("queue", "link_queue")) {
                val array = JSONArray(prefs(context).getString(key, "[]"))
                for (i in 0 until array.length()) {
                    val o = array.getJSONObject(i)
                    val item = Pending(o.getString("id"), o.getString("displayName"),
                        o.optString("fingerprint"), o.optString("url"), owner(context))
                    if (item.url.isBlank()) {
                        val old = File(context.cacheDir, "shared/${item.id}/${item.displayName}")
                        if (!old.exists()) continue
                        val target = file(context, item)
                        target.parentFile?.mkdirs()
                        check(old.renameTo(target)) { "无法迁移待上传文件" }
                    }
                    queue.add(item)
                }
            }
            persist(context)
        }
        restored = true
    }

    @Synchronized private fun persist(context: Context) {
        val array = JSONArray()
        queue.forEach { p -> array.put(JSONObject().put("id", p.id).put("name", p.displayName)
            .put("hash", p.fingerprint).put("url", p.url).put("owner", p.owner).put("ready", p.ready)) }
        // The worker may outlive the Activity or process; publish metadata before scheduling it.
        check(prefs(context).edit().putString("imports", array.toString()).commit())
    }

    @Synchronized fun next(context: Context, username: String): Pending? {
        val index = queue.indexOfFirst { it.ready && (it.owner.isBlank() || it.owner == username) }
        if (index < 0) return null
        val item = queue[index]
        if (item.owner.isNotBlank()) return item
        return item.copy(owner = username).also { queue[index] = it; persist(context) }
    }
    @Synchronized fun complete(context: Context, item: Pending) {
        queue.removeAll { it.id == item.id }
        persist(context)
        file(context, item).parentFile?.deleteRecursively()
    }

    fun handleIncomingIntent(activity: Activity, intent: Intent?): HandleResult = try {
        receive(activity.applicationContext, intent, confirmLinkName = true)
    } catch (e: Exception) {
        activity.runOnUiThread { Toast.makeText(activity, "导入失败：${e.message}", Toast.LENGTH_LONG).show() }
        HandleResult.IGNORED
    }

    fun receive(context: Context, intent: Intent?, confirmLinkName: Boolean = false): HandleResult {
        if (intent == null) return HandleResult.IGNORED
        restoreQueue(context)
        val shared = intent.getStringExtra(Intent.EXTRA_TEXT)
        val url = shared?.let { Regex("https?://[^\\s]+").find(it)?.value }
        if (url != null) {
            synchronized(this) {
                if (queue.any { it.url == url && it.owner == owner(context) }) return HandleResult.DUPLICATE
                queue.add(Pending(UUID.randomUUID().toString(), Uri.parse(url).host ?: "链接", url = url,
                    owner = owner(context), ready = !confirmLinkName))
                persist(context)
            }
            return HandleResult.LINK
        }
        @Suppress("DEPRECATION")
        val uri = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
            ?: intent.clipData?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.uri
            ?: intent.data ?: return HandleResult.IGNORED
        val rawName = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        } ?: uri.lastPathSegment ?: "courseware"
        val name = rawName.substringAfterLast('/').substringAfterLast('\\').replace(Regex("[\\r\\n]"), "_")
        val ext = name.substringAfterLast('.', "").lowercase()
        if (ext !in extensions) throw IOException("不支持该格式，请选择文档、网页、图片、视频或 ZIP")
        val item = Pending(UUID.randomUUID().toString(), name, owner = owner(context))
        val target = file(context, item)
        target.parentFile?.mkdirs()
        val digest = MessageDigest.getInstance("SHA-256")
        try {
            context.contentResolver.openInputStream(uri)?.use { input ->
                target.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        digest.update(buffer, 0, count)
                        output.write(buffer, 0, count)
                    }
                    output.fd.sync()
                }
            } ?: throw IOException("无法打开文件")
            val hash = digest.digest().joinToString("") { "%02x".format(it) }
            synchronized(this) {
                if (queue.any { it.fingerprint == hash && it.owner == item.owner }) {
                    target.parentFile?.deleteRecursively()
                    return HandleResult.DUPLICATE
                }
                queue.add(item.copy(fingerprint = hash))
                persist(context)
            }
        } catch (e: Exception) {
            target.parentFile?.deleteRecursively()
            throw e
        }
        return HandleResult.FILE
    }

    @Synchronized fun setLatestLinkName(name: String, context: Context) {
        val index = queue.indexOfLast { it.url.isNotBlank() && !it.ready }
        if (index >= 0) { queue[index] = queue[index].copy(displayName = name, ready = true); persist(context) }
    }
    @Synchronized fun cancelDraftLink(context: Context) {
        val index = queue.indexOfLast { it.url.isNotBlank() && !it.ready }
        if (index >= 0) { queue.removeAt(index); persist(context) }
    }
}
