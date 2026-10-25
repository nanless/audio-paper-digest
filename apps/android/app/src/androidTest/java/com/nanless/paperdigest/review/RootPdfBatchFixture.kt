package com.nanless.paperdigest.review

import android.content.ContentProvider
import android.content.ContentValues
import android.content.ContextWrapper
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.provider.ProviderTestRule
import com.nanless.paperdigest.RootController
import com.nanless.paperdigest.cloud.BackupCodec
import com.nanless.paperdigest.data.PersonalStore
import com.nanless.paperdigest.pdf.PdfRepository
import com.nanless.paperdigest.ui.PdfUnlockPrompt
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.PDPage
import com.tom_roush.pdfbox.pdmodel.PDPageContentStream
import com.tom_roush.pdfbox.pdmodel.font.PDType1Font
import com.tom_roush.pdfbox.pdmodel.encryption.AccessPermission
import com.tom_roush.pdfbox.pdmodel.encryption.StandardProtectionPolicy
import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.Assert.*
import java.io.File
import java.io.FileNotFoundException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

internal class RootPdfBatchFixture(provider: ProviderTestRule) {
    enum class Kind { NORMAL, ENCRYPTED, NON_PDF, PROVIDER_ERROR }
    val target = InstrumentationRegistry.getInstrumentation().targetContext
    val directory = File(target.cacheDir, "RootBatch-${UUID.randomUUID()}").canonicalFile.also { it.mkdirs() }
    val context = object : ContextWrapper(target) {
        override fun getNoBackupFilesDir() = directory
        override fun getContentResolver() = provider.resolver
    }
    val root: RootController
    private val own = mutableListOf<String>()
    val sources = mutableListOf<Pair<Uri, File>>()
    init {
        PDFBoxResourceLoader.init(target.applicationContext)
        PersonalStore(File(directory, "PaperDigest")).updateSettings(JSONObject().put("offlineMode", true))
        root = RootController(context, installBackground = false)
    }
    suspend fun loaded() = withTimeout(10000) { while (root.state.value.pendingExportsLoading) delay(5) }
    fun source(kind: Kind): Pair<Uri, File> {
        val id = UUID.randomUUID().toString()
        val file = File(directory, "synthetic-$id.pdf")
        if (kind == Kind.NON_PDF) file.writeText("Synthetic complete non-PDF original $id") else PDDocument().use { pdf ->
            pdf.addPage(PDPage())
            PDPageContentStream(pdf, pdf.getPage(0)).use { out ->
                out.beginText(); out.setFont(PDType1Font.HELVETICA, 12f); out.newLineAtOffset(40f, 700f)
                out.showText("Synthetic batch original $id"); out.endText()
            }
            if (kind == Kind.ENCRYPTED) pdf.protect(StandardProtectionPolicy("synthetic-owner", "synthetic-reader", AccessPermission()).apply { encryptionKeyLength = 128 })
            pdf.save(file)
        }
        files[id] = file; reads[id] = AtomicInteger(); if (kind == Kind.PROVIDER_ERROR) errors.add(id)
        own += id
        return (Uri.parse("content://$AUTHORITY/$id") to file).also { sources += it }
    }
    fun reads(uri: Uri): Int = reads.getValue(uri.lastPathSegment!!).get()
    suspend fun prompt(after: String? = null): PdfUnlockPrompt {
        withTimeout(10000) { while (root.state.value.pdfUnlockPrompt?.let { it.requestID != after && !it.checking } != true) delay(5) }
        return root.state.value.pdfUnlockPrompt!!
    }
    fun batchResult(): JSONObject {
        val jobs = root.personal.snapshot().getJSONArray("jobs")
        return (0 until jobs.length()).map { jobs.getJSONObject(it) }.first { it.optString("kind") == "pdf.import.batch" }.getJSONObject("result")
    }
    fun assertPrivateInputsAbsent() {
        val record = root.personal.snapshot().toString()
        sources.forEach { (uri, _) -> assertFalse("Picker URI must stay outside Research", record.contains(uri.toString())) }
        for (word in listOf("synthetic-reader", "synthetic-wrong", "synthetic-owner")) {
            assertFalse(record.contains(word)); assertFalse(root.state.value.toString().contains(word))
        }
        assertEquals(0, root.personal.snapshot().getJSONArray("sessions").length())
    }
    suspend fun close() {
        val scope = field<CoroutineScope>(root, "exportScope"); scope.cancel(); scope.coroutineContext[Job]?.join()
        field<PdfRepository>(root, "pdf").clearSessionPasswords()
        own.forEach { files.remove(it); reads.remove(it); errors.remove(it) }
        directory.deleteRecursively()
    }
    class Source : ContentProvider() {
        override fun onCreate() = true
        override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
            if (mode != "r") throw FileNotFoundException("Read-only synthetic original")
            val id = uri.lastPathSegment ?: throw FileNotFoundException("Missing synthetic source")
            reads[id]?.incrementAndGet()
            if (id in errors) throw FileNotFoundException("Explicit synthetic provider failure")
            return ParcelFileDescriptor.open(files[id] ?: throw FileNotFoundException("Unknown synthetic source"), ParcelFileDescriptor.MODE_READ_ONLY)
        }
        override fun getType(uri: Uri) = "application/pdf"
        override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, sort: String?): Cursor? = null
        override fun insert(uri: Uri, values: ContentValues?): Uri? = null
        override fun delete(uri: Uri, selection: String?, args: Array<out String>?) = 0
        override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?) = 0
    }
    companion object {
        const val AUTHORITY = "com.nanless.paperdigest.test.pdf-batch-source"
        private val files = ConcurrentHashMap<String, File>()
        private val reads = ConcurrentHashMap<String, AtomicInteger>()
        private val errors = ConcurrentHashMap.newKeySet<String>()
        @Suppress("UNCHECKED_CAST") fun <T> field(value: Any, name: String): T = value.javaClass.getDeclaredField(name).also { it.isAccessible = true }.get(value) as T
    }
}
