package cn.edu.nb3.myclass

import android.app.Activity
import android.view.View
import android.widget.Button
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * 课件演讲者备注的数据层（PPTX 才支持）。
 *
 * 备注来自 PPTX 的 notesSlide，由服务器按原幻灯片编号返回；动画展开后同一张
 * 幻灯片的多页共用同一段备注。查看与修改的界面在 [CoursewarePresenter]，本类只
 * 负责拉取、缓存和保存，并决定“演讲”入口是否出现：只有当前课件确实带有备注时
 * 才显示，普通 PDF、链接课件、提取失败的文件都不会多出一个空入口。
 *
 * 修改按“课件 ID + 教师账号”保存：同一账号在 Android 与 iPad 上看到同一份备注，
 * 共享课件不会把一位老师的讲稿串给另一位老师。
 */
class CoursewareNotes(
    private val activity: Activity,
    private val client: OkHttpClient,
    private val getContext: () -> Context?,
    private val token: () -> String?
) {
    /** page 是 PDF 物理页号，slide 是它对应的原始幻灯片编号。 */
    data class Context(val url: String, val page: Int, val slide: Int)

    private var button: Button? = null
    private var context: Context? = null
    /** 递增代号：切换课件、离开页面后丢弃迟到的网络结果。 */
    private var generation = 0
    private var deckId = ""
    private var queriedId = ""
    private var notes: Map<Int, String> = emptyMap()

    fun attach(view: Button) {
        button = view
        view.visibility = View.GONE
        // 重新进入 / 旋转重建时重试一次：上次可能只是网络抖动。
        refresh(force = true)
    }

    /** 由翻页、重建界面调用；同一课件重复调用不会重复请求。 */
    fun refresh(force: Boolean = false) {
        val next = getContext()
        context = next
        val id = next?.let { coursewareId(it.url) }
        if (id == null) {
            generation++
            queriedId = ""
            deckId = ""
            notes = emptyMap()
            renderButton()
            return
        }
        if (!force && id == queriedId) {
            renderButton()
            return
        }
        queriedId = id
        load(id)
    }

    fun hasNotes(): Boolean = deckId.isNotEmpty() && notes.isNotEmpty()

    /** 当前幻灯片备注（没有则为空串）。 */
    fun noteText(slide: Int): String = notes[slide].orEmpty()

    /**
     * 保存某一页备注；空文本表示清空（服务器会写入空覆盖，遮住 PPTX 自带的原文）。
     * 回调在主线程。
     */
    fun saveNote(slide: Int, text: String, onResult: (Result<String>) -> Unit) {
        val url = endpoint(deckId)
        val auth = token()?.takeIf { it.isNotBlank() }
        if (url == null || auth == null) {
            onResult(Result.failure(IllegalStateException("登录已过期，请重新登录后再修改备注")))
            return
        }
        Thread {
            val result = runCatching {
                val payload = JSONObject().put("slide", slide).put("text", text).toString()
                    .toRequestBody("application/json; charset=utf-8".toMediaTypeOrNull())
                val request = Request.Builder().url(url).header("Authorization", "Bearer $auth").put(payload).build()
                client.newBuilder().callTimeout(30, TimeUnit.SECONDS).build()
                    .newCall(request).execute().use { response ->
                        val json = runCatching { JSONObject(response.body?.string().orEmpty()) }.getOrDefault(JSONObject())
                        if (!response.isSuccessful) {
                            throw IllegalStateException(json.optString("error").ifBlank { "保存失败：HTTP ${response.code}" })
                        }
                        json.optString("text", text).trim()
                    }
            }
            activity.runOnUiThread {
                if (activity.isDestroyed) return@runOnUiThread
                result.onSuccess { saved ->
                    notes = if (saved.isEmpty()) notes - slide else notes + (slide to saved)
                    renderButton()
                }
                onResult(result)
            }
        }.start()
    }

    private fun coursewareId(url: String): String? {
        val path = coursewareFilePath(url)
        if (!path.endsWith(".pdf", ignoreCase = true)) return null
        val name = path.substringAfterLast('/').substringBeforeLast('.')
        return name.takeIf { Regex("^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$").matches(it) }
    }

    private fun endpoint(id: String): HttpUrl? {
        if (id.isEmpty()) return null
        val base = CoursewareApi.serverBaseUrl.trimEnd('/')
        return ("$base/api/courseware/$id/notes").toHttpUrlOrNull()
    }

    private fun load(id: String) {
        val url = endpoint(id) ?: return
        val auth = token()?.takeIf { it.isNotBlank() } ?: return
        val epoch = ++generation
        renderButton()
        Thread {
            val result = runCatching {
                val request = Request.Builder().url(url).header("Authorization", "Bearer $auth").get().build()
                client.newBuilder().callTimeout(20, TimeUnit.SECONDS).build()
                    .newCall(request).execute().use { response ->
                        // 404：不是本站课件 / 没有权限，安静地当作“没有备注”。
                        if (response.code == 404) null
                        else if (!response.isSuccessful) throw IllegalStateException("备注读取失败：HTTP ${response.code}")
                        else JSONObject(response.body?.string().orEmpty())
                    }
            }
            activity.runOnUiThread {
                if (epoch != generation || activity.isDestroyed) return@runOnUiThread
                val json = result.getOrNull()
                if (json != null && json.optBoolean("supported", false)) {
                    deckId = id
                    notes = parseNotes(json.optJSONArray("slides"))
                } else {
                    deckId = ""
                    notes = emptyMap()
                }
                renderButton()
            }
        }.start()
    }

    private fun parseNotes(array: JSONArray?): Map<Int, String> {
        if (array == null) return emptyMap()
        val parsed = LinkedHashMap<Int, String>()
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            val slide = item.optInt("slide", 0)
            val text = item.optString("text").trim()
            if (slide >= 1 && text.isNotEmpty()) parsed[slide] = text
        }
        return parsed
    }

    private fun renderButton() {
        val target = button ?: return
        target.visibility = if (hasNotes()) View.VISIBLE else View.GONE
    }

    /** 离开课件播放页：丢弃后续网络结果。 */
    fun detach() {
        generation++
        queriedId = ""
    }

    fun destroy() {
        detach()
        button = null
        deckId = ""
        notes = emptyMap()
    }
}
