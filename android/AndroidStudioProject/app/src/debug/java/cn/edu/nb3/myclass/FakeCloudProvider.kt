package cn.edu.nb3.myclass

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Mimics the first-access behaviour of cloud providers such as DS file:
 * - `known=true` reports the real OpenableColumns.SIZE, otherwise it reports 0;
 * - `emptyFirst=true` returns an empty stream on the first open and the real
 *   bytes afterwards, like a provider that is still downloading the file.
 */
class FakeCloudProvider : ContentProvider() {
    private val opens = ConcurrentHashMap<String, AtomicInteger>()

    override fun onCreate() = true

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?
    ): Cursor = MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)).apply {
        val size = if (uri.getQueryParameter("known") == "true") DATA.size.toLong() else 0L
        addRow(arrayOf("云端课件.pdf", size))
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val attempt = opens.computeIfAbsent(uri.toString()) { AtomicInteger() }.incrementAndGet()
        val bytes = if (uri.getQueryParameter("emptyFirst") == "true" && attempt == 1) ByteArray(0) else DATA
        val file = File(requireNotNull(context).cacheDir, "fake-cloud-${UUID.randomUUID()}.pdf")
        file.writeBytes(bytes)
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun getType(uri: Uri) = "application/pdf"
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0

    companion object {
        const val AUTHORITY = "cn.edu.nb3.myclass.fakecloud"
        val DATA = ("%PDF-1.4\n% FAKE-CLOUD-MARKER\n" + "0".repeat(48 * 1024) + "\n%%EOF\n").toByteArray()
        fun uri(known: Boolean, emptyFirst: Boolean): Uri = Uri.parse(
            "content://$AUTHORITY/file/cloud.pdf?known=$known&emptyFirst=$emptyFirst")
    }
}
