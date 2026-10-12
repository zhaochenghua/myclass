package cn.edu.nb3.myclass

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.graphics.Rect
import android.util.LruCache
import android.view.ScaleGestureDetector
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
    private val pdfPage: Int? = null, private val video: Boolean = false,
    private val allowZoom: Boolean = false) : AppCompatImageView(context) {
    private var loading = false
    private var loaded = false
    @Volatile private var call: Call? = null
    @Volatile private var generation = 0
    private val key = "$url@$targetPixels:page=$pdfPage:video=$video"
    private var observedTree: ViewTreeObserver? = null
    private val scrollListener = ViewTreeObserver.OnScrollChangedListener { loadIfVisible() }
    private val layoutListener = ViewTreeObserver.OnGlobalLayoutListener { loadIfVisible() }
    private val zoomMatrix = Matrix()
    private var previewBitmap: Bitmap? = null
    private var previewBaseScale = 1f
    private var previewScale = 1f
    private var previewTranslateX = 0f
    private var previewTranslateY = 0f
    private var lastTouchX = 0f
    private var lastTouchY = 0f
    private var panActive = false
    private val scaleDetector = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(detector: ScaleGestureDetector): Boolean {
            if (!allowZoom || previewBitmap == null) return false
            val oldScale = previewScale
            val nextScale = (oldScale * detector.scaleFactor).coerceIn(1f, 4f)
            val factor = nextScale / oldScale
            // 保持双指焦点下的图片内容不动，手指向外移动时图片同步向外放大。
            previewTranslateX = detector.focusX - (detector.focusX - previewTranslateX) * factor
            previewTranslateY = detector.focusY - (detector.focusY - previewTranslateY) * factor
            previewScale = nextScale
            clampPreviewTranslation()
            applyPreviewMatrix()
            return true
        }
    })
    init {
        scaleType = if (allowZoom) ScaleType.MATRIX else ScaleType.CENTER_CROP
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
        bitmaps.get(key)?.let { showBitmap(it); loaded = true; return }
        loading = true
        val version = generation
        val app = context.applicationContext
        executor.execute {
            if (version != generation) return@execute
            val bitmap = runCatching {
                if (video) return@runCatching renderVideo(app, version)
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
                    if (bitmap != null) showBitmap(bitmap)
                    else contentDescription = "$contentDescription（预览不可用）"
                }
            }
        }
    }
    private fun showBitmap(bitmap: Bitmap) {
        if (!allowZoom) {
            setImageBitmap(bitmap)
            return
        }
        previewBitmap = bitmap
        setImageBitmap(bitmap)
        post { resetPreviewMatrix() }
    }

    private fun resetPreviewMatrix() {
        val bitmap = previewBitmap ?: return
        if (width <= 0 || height <= 0) return
        previewBaseScale = minOf(width.toFloat() / bitmap.width, height.toFloat() / bitmap.height)
        previewScale = 1f
        previewTranslateX = 0f
        previewTranslateY = 0f
        applyPreviewMatrix()
    }

    private fun clampPreviewTranslation() {
        val bitmap = previewBitmap ?: return
        val scale = previewBaseScale * previewScale
        val drawWidth = bitmap.width * scale
        val drawHeight = bitmap.height * scale
        val maxX = ((drawWidth - width) / 2f).coerceAtLeast(0f)
        val maxY = ((drawHeight - height) / 2f).coerceAtLeast(0f)
        previewTranslateX = previewTranslateX.coerceIn(-maxX, maxX)
        previewTranslateY = previewTranslateY.coerceIn(-maxY, maxY)
    }

    private fun applyPreviewMatrix() {
        val bitmap = previewBitmap ?: return
        if (width <= 0 || height <= 0) return
        val scale = previewBaseScale * previewScale
        val drawWidth = bitmap.width * scale
        val drawHeight = bitmap.height * scale
        val left = (width - drawWidth) / 2f
        val top = (height - drawHeight) / 2f
        zoomMatrix.setScale(scale, scale)
        zoomMatrix.postTranslate(left + previewTranslateX, top + previewTranslateY)
        imageMatrix = zoomMatrix
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (allowZoom && previewBitmap != null) resetPreviewMatrix()
    }

    override fun onTouchEvent(event: android.view.MotionEvent): Boolean {
        if (allowZoom) {
            scaleDetector.onTouchEvent(event)
            when (event.actionMasked) {
                android.view.MotionEvent.ACTION_DOWN -> {
                    lastTouchX = event.x
                    lastTouchY = event.y
                    panActive = true
                }
                android.view.MotionEvent.ACTION_POINTER_DOWN -> {
                    panActive = false
                }
                android.view.MotionEvent.ACTION_MOVE -> {
                    if (event.pointerCount == 1 && panActive && previewScale > 1f) {
                        previewTranslateX += event.x - lastTouchX
                        previewTranslateY += event.y - lastTouchY
                        clampPreviewTranslation()
                        applyPreviewMatrix()
                    }
                    if (event.pointerCount == 1) {
                        lastTouchX = event.x
                        lastTouchY = event.y
                    }
                }
                android.view.MotionEvent.ACTION_POINTER_UP -> {
                    val remaining = if (event.actionIndex == 0) 1 else 0
                    if (event.pointerCount > remaining) {
                        lastTouchX = event.getX(remaining)
                        lastTouchY = event.getY(remaining)
                    }
                    panActive = true
                }
                android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> {
                    panActive = false
                }
            }
            return true
        }
        return super.onTouchEvent(event)
    }
    private fun renderVideo(app: Context, version: Int): Bitmap? {
        // Seek through HTTP ranges instead of downloading an entire video for its cover.
        val deadline = android.os.SystemClock.elapsedRealtime() + 25_000L
        val source = object : android.media.MediaDataSource() {
            private var length = -1L
            private val blocks = object : LinkedHashMap<Long, ByteArray>(4, 0.75f, true) {
                override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Long, ByteArray>?) = size > 4
            }
            private fun block(start: Long): ByteArray = blocks[start] ?: run {
                if (version != generation || android.os.SystemClock.elapsedRealtime() >= deadline)
                    throw java.io.IOException("Preview cancelled or timed out")
                val request = http(app).newCall(Request.Builder().url(url)
                    .header("Range", "bytes=$start-${start + 262143}")
                    .header("Accept-Encoding", "identity").build())
                call = request
                request.timeout().timeout((deadline - android.os.SystemClock.elapsedRealtime()).coerceAtLeast(1), TimeUnit.MILLISECONDS)
                if (version != generation) request.cancel()
                request.execute().use { response ->
                    if (response.code != 206) throw java.io.IOException("Video preview requires byte ranges")
                    val range = response.header("Content-Range").orEmpty()
                    if (!range.startsWith("bytes $start-")) throw java.io.IOException("Invalid video range")
                    length = range.substringAfterLast('/').toLongOrNull()
                        ?.takeIf { it > 0 } ?: throw java.io.IOException("Invalid video length")
                    val body = response.body ?: throw java.io.IOException("Empty video range")
                    val bytes = body.byteStream().use { it.readBytesBounded(262144) }
                    if (bytes.isEmpty()) throw java.io.IOException("Empty video range")
                    blocks[start] = bytes
                    bytes
                }
            }
            override fun getSize(): Long { if (length < 0) block(0); return length }
            override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
                if (size == 0) return 0
                if (position < 0 || position >= getSize()) return -1
                val start = position / 262144 * 262144
                val bytes = block(start)
                val index = (position - start).toInt()
                val count = minOf(size, bytes.size - index)
                if (count <= 0) throw java.io.IOException("Incomplete video range")
                bytes.copyInto(buffer, offset, index, index + count)
                return count
            }
            override fun close() { blocks.clear() }
        }
        return source.use {
            val retriever = android.media.MediaMetadataRetriever()
            try {
                retriever.setDataSource(source)
                if (android.os.Build.VERSION.SDK_INT >= 27) {
                    retriever.getScaledFrameAtTime(0, android.media.MediaMetadataRetriever.OPTION_CLOSEST_SYNC,
                        targetPixels, targetPixels)
                } else {
                    retriever.getFrameAtTime(0, android.media.MediaMetadataRetriever.OPTION_CLOSEST_SYNC)?.let { frame ->
                        val scale = minOf(1f, targetPixels.toFloat() / maxOf(frame.width, frame.height))
                        val scaled = Bitmap.createScaledBitmap(frame, (frame.width * scale).toInt().coerceAtLeast(1),
                            (frame.height * scale).toInt().coerceAtLeast(1), true)
                        if (scaled !== frame) frame.recycle()
                        scaled
                    }
                }
            } finally { retriever.release() }
        }
    }
    private fun java.io.InputStream.readBytesBounded(limit: Int): ByteArray {
        val output = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
            val count = read(buffer)
            if (count < 0) break
            if (output.size() + count > limit) throw java.io.IOException("Video range too large")
            output.write(buffer, 0, count)
        }
        return output.toByteArray()
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
