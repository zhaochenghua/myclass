package cn.edu.nb3.myclass.tv

import android.content.Context
import android.graphics.*
import android.graphics.pdf.PdfRenderer
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.*

/** PDF handles stay on one worker; downloaded files and decoded pixels are bounded. */
class ContentLoader(context: Context, private val http: OkHttpClient) {
    private val directory = File(context.cacheDir, "tv-content").apply { mkdirs() }
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val generation = AtomicInteger()
    private var renderer: PdfRenderer? = null
    private var document: ParcelFileDescriptor? = null
    private var currentUrl = ""
    private var download: okhttp3.Call? = null

    fun open(url: String, pdf: Boolean, page: Int, success: (Bitmap, Int) -> Unit, failure: (String) -> Unit) {
        val ticket = generation.incrementAndGet()
        download?.cancel()
        worker.execute {
            try {
                closeDocument()
                directory.listFiles()?.forEach { it.delete() }
                val file = File(directory, "content")
                val call = http.newCall(Request.Builder().url(url).build())
                download = call
                call.execute().use { response ->
                    check(response.isSuccessful) { "服务器返回 ${response.code}" }
                    val body = response.body ?: error("文件为空")
                    check(body.contentLength() <= MAX_BYTES) { "课件超过 128 MB" }
                    body.byteStream().use { input -> file.outputStream().use { output ->
                        val buffer = ByteArray(65536); var total = 0L
                        while (true) {
                            val count = input.read(buffer); if (count < 0) break
                            total += count
                            check(total <= MAX_BYTES) { "课件超过 128 MB" }
                            check(ticket == generation.get()) { "已取消" }
                            output.write(buffer, 0, count)
                        }
                    } }
                }
                if (ticket != generation.get()) return@execute
                currentUrl = url
                if (pdf) {
                    document = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
                    renderer = PdfRenderer(document!!)
                    deliver(ticket, renderPage(page), renderer!!.pageCount, success)
                } else {
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeFile(file.path, bounds)
                    check(bounds.outWidth > 0 && bounds.outHeight > 0) { "图片格式不受支持" }
                    var sample = 1
                    while (bounds.outWidth.toLong() * bounds.outHeight / sample / sample > 4000000) sample *= 2
                    val bitmap = BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
                        ?: error("无法读取图片")
                    deliver(ticket, bitmap, 1, success)
                }
            } catch (e: Exception) { main.post { if (ticket == generation.get()) failure(e.message ?: "加载失败") } }
        }
    }

    fun page(url: String, page: Int, success: (Bitmap, Int) -> Unit, failure: (String) -> Unit) {
        val ticket = generation.get()
        worker.execute {
            if (BuildConfig.DEBUG) Log.d("MyClassTV", "render page=$page sameUrl=${currentUrl == url} generation=${ticket == generation.get()} renderer=${renderer != null}")
            if (currentUrl != url || ticket != generation.get() || renderer == null) return@execute
            try { deliver(ticket, renderPage(page), renderer!!.pageCount, success) }
            catch (e: Exception) { main.post { if (ticket == generation.get()) failure(e.message ?: "翻页失败") } }
        }
    }

    private fun renderPage(number: Int): Bitmap {
        val pdf = renderer ?: error("课件尚未加载")
        return pdf.openPage((number - 1).coerceIn(0, pdf.pageCount - 1)).use { page ->
            val scale = min(1920f / page.width, 2560f / page.height)
            val bitmap = Bitmap.createBitmap(max(1, (page.width * scale).toInt()), max(1, (page.height * scale).toInt()), Bitmap.Config.ARGB_8888)
            bitmap.eraseColor(Color.WHITE)
            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            bitmap
        }
    }

    private fun deliver(ticket: Int, bitmap: Bitmap, count: Int, success: (Bitmap, Int) -> Unit) {
        main.post { if (ticket == generation.get()) success(bitmap, count) else bitmap.recycle() }
    }

    private fun closeDocument() { renderer?.close(); renderer = null; document?.close(); document = null; currentUrl = "" }

    fun cancel() { generation.incrementAndGet(); download?.cancel(); worker.execute { closeDocument() } }
    fun release() { cancel(); worker.shutdown() }
    companion object { private const val MAX_BYTES = 128L * 1024 * 1024 }
}
