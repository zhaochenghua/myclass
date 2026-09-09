package cn.edu.nb3.myclass

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import kotlin.math.max

/**
 * 课件 PDF 的本地渲染引擎：负责下载缓存、按页渲染成位图、以及资源回收。
 *
 * 课件在服务器上统一以 PDF 存储（PPT / Word 等已转 PDF），手机端把"一页"当作
 * "一张图片"渲染出来后，就可以整体复用图片投屏的 ZoomableImageView，
 * 从而直接获得缩放 / 平移 / 画笔 / 视口同步能力。
 *
 * 所有方法都必须在**后台线程**调用：下载是同步 IO，PdfRenderer 的渲染也较重。
 */
class CoursewarePdfRenderer(
    private val context: Context,
    private val client: OkHttpClient
) {

    private val cacheDir: File
        get() = File(context.cacheDir, COURSEWARE_PDF_CACHE).apply { mkdirs() }

    /** 指定课件是否已缓存（用于提示"秒开"还是"需要下载"） */
    fun isCached(cacheKey: String): Boolean {
        val file = File(cacheDir, "$cacheKey.pdf")
        return file.exists() && file.length() > 0L
    }

    /**
     * 打开课件：命中缓存直接使用，否则先下载再打开。
     * @param url 课件的绝对地址（调用方需先把站内相对地址补全）
     * @param cacheKey 缓存文件名（通常取课件 id），同一课件重复打开不会重复下载
     * @param onProgress 下载进度 0~100，总长度未知时不回调
     */
    fun openBlocking(
        url: String,
        cacheKey: String,
        onProgress: ((percent: Int) -> Unit)? = null
    ): OpenedPdf {
        val file = File(cacheDir, "$cacheKey.pdf")
        if (!isCached(cacheKey)) {
            downloadBlocking(url, file, onProgress)
        }
        return OpenedPdf(file)
    }

    private fun downloadBlocking(url: String, target: File, onProgress: ((Int) -> Unit)?) {
        val part = File(target.parentFile, "${target.name}.part")
        try {
            val request = Request.Builder().url(url).build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw IOException("课件下载失败：HTTP ${response.code}")
                }
                val body = response.body ?: throw IOException("课件下载失败：空响应")
                val total = body.contentLength()
                var downloaded = 0L
                var lastReported = -1
                part.outputStream().use { output ->
                    body.byteStream().use { input ->
                        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                        while (true) {
                            val read = input.read(buffer)
                            if (read <= 0) break
                            output.write(buffer, 0, read)
                            downloaded += read
                            if (total > 0) {
                                val percent = (downloaded * 100 / total).toInt().coerceIn(0, 100)
                                if (percent != lastReported) {
                                    lastReported = percent
                                    onProgress?.invoke(percent)
                                }
                            }
                        }
                    }
                }
            }
            if (part.length() == 0L) throw IOException("课件下载失败：文件为空")
            if (!part.renameTo(target)) throw IOException("课件保存失败")
        } catch (error: Throwable) {
            runCatching { part.delete() }
            throw error
        }
    }

    /** 清空指定课件或全部缓存，供退出 / 空间回收使用 */
    fun evict(cacheKey: String? = null) {
        runCatching {
            if (cacheKey.isNullOrBlank()) {
                cacheDir.deleteRecursively()
            } else {
                File(cacheDir, "$cacheKey.pdf").delete()
                File(cacheDir, "$cacheKey.pdf.part").delete()
            }
        }
    }

    /** 一份已打开的 PDF 句柄，用完必须 [close] */
    class OpenedPdf internal constructor(private val file: File) {

        private val descriptor: ParcelFileDescriptor =
            ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
        private var renderer: PdfRenderer? = PdfRenderer(descriptor)

        val pageCount: Int
            get() = renderer?.pageCount ?: 0

        /**
         * 渲染指定页（0 基）为位图。
         * @param maxEdgePx 长边像素上限，兼顾清晰度与内存（2048 约 12~16MB/张）
         */
        fun renderPage(pageIndex: Int, maxEdgePx: Int = DEFAULT_MAX_EDGE): Bitmap {
            val target = renderer ?: throw IllegalStateException("课件已关闭")
            if (pageIndex < 0 || pageIndex >= target.pageCount) {
                throw IndexOutOfBoundsException("页码越界：$pageIndex / ${target.pageCount}")
            }
            target.openPage(pageIndex).use { page ->
                val longestEdge = max(page.width, page.height).coerceAtLeast(1)
                val scale = (maxEdgePx.toFloat() / longestEdge.toFloat()).coerceIn(0.25f, 4f)
                val width = max(1, (page.width * scale).toInt())
                val height = max(1, (page.height * scale).toInt())
                val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                // PDF 页面背景是透明的，补白底避免控件上出现黑色背景
                bitmap.eraseColor(Color.WHITE)
                page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                return bitmap
            }
        }

        fun close() {
            runCatching { renderer?.close() }
            renderer = null
            runCatching { descriptor.close() }
        }
    }

    companion object {
        private const val COURSEWARE_PDF_CACHE = "courseware-pdf"
        const val DEFAULT_MAX_EDGE = 2048
    }
}
