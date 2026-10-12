package cn.edu.nb3.myclass

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Rect
import android.util.LruCache
import android.view.ViewTreeObserver
import androidx.appcompat.widget.AppCompatImageView
import okhttp3.Cache
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Visible rows only; bounded downloads, sampled decoding, and shared HTTP/bitmap caches. */
class CoursewareThumbnail(context: Context, private val url: String, private val targetPixels: Int,
    private val pdfPage: Int? = null) : AppCompatImageView(context) {
    private var loading = false
    private var loaded = false
    @Volatile private var call: Call? = null
    @Volatile private var generation = 0
    private val key = "$url@$targetPixels:page=$pdfPage"
    private var observedTree: ViewTreeObserver? = null
    private val scrollListener = ViewTreeObserver.OnScrollChangedListener { loadIfVisible() }
    private val layoutListener = ViewTreeObserver.OnGlobalLayoutListener { loadIfVisible() }
    init {
        scaleType = ScaleType.FIT_CENTER
        setBackgroundColor(0xffeeeeee.toInt())
        setImageResource(android.R.drawable.ic_menu_gallery)
    }
    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        observedTree = viewTreeObserver.also {
            it.addOnScrollChangedListener(scrollListener)
            it.addOnGlobalLayoutListener(layoutListener)
        }
        post { loadIfVisible() }
    }
    // Hardware-accelerated scrolling can reuse a child's display list without
    // calling onDraw again. Observe viewport changes instead of draw calls.
    private fun loadIfVisible() {
        if (isAttachedToWindow && isShown && !loading && !loaded && getLocalVisibleRect(Rect())) load()
    }
    private fun load() {
        bitmaps.get(key)?.let { setImageBitmap(it); loaded = true; return }
        loading = true
        val version = generation
        val app = context.applicationContext
        executor.execute {
            if (version != generation) return@execute
            val bitmap = runCatching {
                val pdfFile = if (pdfPage != null) File(app.cacheDir, "courseware-thumbnail-pdfs").let { directory ->
                    directory.mkdirs()
                    val digest = java.security.MessageDigest.getInstance("SHA-256").digest(url.toByteArray())
                    File(directory, digest.joinToString("") { "%02x".format(it) } + ".pdf")
                } else null
                if (pdfFile != null && pdfFile.length() > 0) {
                    pdfFile.setLastModified(System.currentTimeMillis())
                    return@runCatching renderPdf(pdfFile)
                }
                val request = http(app).newCall(Request.Builder().url(url).build())
                call = request
                if (version != generation) { request.cancel(); return@runCatching null }
                request.execute().use { response ->
                    if (!response.isSuccessful) return@use null
                    val body = response.body ?: return@use null
                    val maxBytes = if (pdfPage != null) MAX_PDF_BYTES else MAX_BYTES
                    if (body.contentLength() > maxBytes) return@use null
                    val temporary = File.createTempFile("thumbnail-", ".image", app.cacheDir)
                    try {
                        body.byteStream().use { input -> temporary.outputStream().use { output ->
                            val buffer = ByteArray(32 * 1024)
                            var count = 0L
                            while (true) {
                                val read = input.read(buffer)
                                if (read < 0) break
                                count += read
                                if (count > maxBytes) throw java.io.IOException("File too large for preview")
                                output.write(buffer, 0, read)
                            }
                        } }
                        if (pdfFile != null) {
                            val rendered = renderPdf(temporary)
                            // Unique temporary files keep simultaneous preview downloads independent.
                            if (!pdfFile.exists()) temporary.renameTo(pdfFile)
                            var total = pdfFile.parentFile?.listFiles()?.sumOf { it.length() } ?: 0L
                            pdfFile.parentFile?.listFiles()?.sortedBy { it.lastModified() }?.forEach { cached ->
                                if (total > MAX_PDF_BYTES && cached != pdfFile) {
                                    val size = cached.length()
                                    if (cached.delete()) total -= size
                                }
                            }
                            return@use rendered
                        }
                        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                        BitmapFactory.decodeFile(temporary.path, options)
                        if (options.outWidth <= 0 || options.outHeight <= 0) return@use null
                        options.inJustDecodeBounds = false
                        options.inSampleSize = 1
                        while (maxOf(options.outWidth, options.outHeight) / options.inSampleSize > targetPixels * 2) options.inSampleSize *= 2
                        BitmapFactory.decodeFile(temporary.path, options)
                    } finally { temporary.delete() }
                }
            }.getOrNull()
            if (bitmap != null) bitmaps.put(key, bitmap)
            post {
                if (version == generation && isAttachedToWindow) {
                    loading = false
                    loaded = true
                    if (bitmap != null) setImageBitmap(bitmap)
                    else contentDescription = "$contentDescription（预览不可用）"
                }
            }
        }
    }
    private fun renderPdf(file: File): Bitmap {
        android.os.ParcelFileDescriptor.open(file, android.os.ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
            android.graphics.pdf.PdfRenderer(descriptor).use { renderer ->
                renderer.openPage(((pdfPage ?: 1) - 1).coerceIn(0, renderer.pageCount - 1)).use { page ->
                    val scale = targetPixels.toFloat() / maxOf(page.width, page.height).coerceAtLeast(1)
                    return Bitmap.createBitmap((page.width * scale).toInt().coerceAtLeast(1),
                        (page.height * scale).toInt().coerceAtLeast(1), Bitmap.Config.ARGB_8888).also { bitmap ->
                        bitmap.eraseColor(android.graphics.Color.WHITE)
                        page.render(bitmap, null, null, android.graphics.pdf.PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                    }
                }
            }
        }
    }
    override fun onDetachedFromWindow() {
        observedTree?.takeIf { it.isAlive }?.let {
            it.removeOnScrollChangedListener(scrollListener)
            it.removeOnGlobalLayoutListener(layoutListener)
        }
        observedTree = null
        generation++
        call?.cancel()
        loading = false
        super.onDetachedFromWindow()
    }
    companion object {
        private const val MAX_BYTES = 32L * 1024 * 1024
        private const val MAX_PDF_BYTES = 256L * 1024 * 1024
        private val executor = Executors.newFixedThreadPool(2)
        private val bitmaps = object : LruCache<String, Bitmap>(12 * 1024 * 1024) {
            override fun sizeOf(key: String, value: Bitmap) = value.byteCount
        }
        private var client: OkHttpClient? = null
        @Synchronized private fun http(context: Context): OkHttpClient = client ?: OkHttpClient.Builder()
            .cache(Cache(File(context.cacheDir, "courseware-thumbnails"), 48L * 1024 * 1024))
            .connectTimeout(8, TimeUnit.SECONDS).callTimeout(25, TimeUnit.SECONDS)
            .build().also { client = it }
    }
}
