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
import com.nanless.paperdigest.PaperDigestApplication
import androidx.work.WorkManager
import androidx.work.WorkQuery
import androidx.work.WorkInfo
import com.nanless.paperdigest.cloud.BackupCodec
import com.nanless.paperdigest.cloud.RequestContinuity
import com.nanless.paperdigest.pdf.PdfRepository
import com.nanless.paperdigest.secret.SecretStore
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.PDPage
import com.tom_roush.pdfbox.pdmodel.PDPageContentStream
import com.tom_roush.pdfbox.pdmodel.font.PDType1Font
import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.io.FileNotFoundException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Actual isolated Root, cache-only synthetic PDFs and an injected in-memory store. No commit dispatch/real keys/HTTP. */
class RootFreshStudyInstrumentedTest {
    @get:Rule val provider = ProviderTestRule.Builder(Source::class.java, AUTHORITY).build()
    private class MemoryStore : SecretStore {
        val saves = AtomicInteger(); val loads = AtomicInteger(); val removes = AtomicInteger()
        var failure = false; var entered: ((Int) -> Unit)? = null
        override fun save(scope: String, secret: String) { val n = saves.incrementAndGet(); entered?.invoke(n); check(!failure) { "synthetic rejected save" } }
        override fun load(scope: String): String? { loads.incrementAndGet(); error("A confirmation must not read a key") }
        override fun remove(scope: String) { removes.incrementAndGet() }
    }
    private inner class Fixture {
        val target = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(target.cacheDir, "RootFresh-${UUID.randomUUID()}").canonicalFile.also { it.mkdirs() }
        val context = object : ContextWrapper(target) { override fun getNoBackupFilesDir() = directory; override fun getContentResolver() = provider.resolver }
        val store = MemoryStore()
        val root = RootController(context, installBackground = false, secretStore = store)
        val originals = mutableListOf<File>()
        private val app = target.applicationContext as PaperDigestApplication
        private var originalController: RootController? = null
        private val controllerField = PaperDigestApplication::class.java.getDeclaredField("controller").also { it.isAccessible = true }
        suspend fun ready() { withTimeout(10000) { while (root.state.value.pendingExportsLoading) delay(5) }; root.personal.updateSettings(JSONObject().put("endpoint", "https://synthetic.invalid/v1").put("model", "synthetic-model").put("protocol", "chat").put("offlineMode", true));
            val foreign = WorkManager.getInstance(target).getWorkInfos(WorkQuery.Builder.fromStates(listOf(WorkInfo.State.ENQUEUED, WorkInfo.State.RUNNING, WorkInfo.State.BLOCKED)).build()).get(10, TimeUnit.SECONDS)
            require(foreign.isEmpty()) { "This fixture requires an isolated QA target without pending foreign work; no user work is cancelled" }
            InstrumentationRegistry.getInstrumentation().runOnMainSync { originalController = app.controller; controllerField.set(app, root) } }
        suspend fun checkPreview() = root.execute("model.fresh.check.prepare", JSONObject())
        suspend fun rejectCommit(preview: JSONObject) { assertTrue(runCatching { root.execute("model.fresh.commit", JSONObject().put("confirmationID", preview.getString("confirmationID")).put("draftIdentity", preview.getString("draftIdentity"))) }.isFailure); noRequest() }
        fun noRequest() { assertEquals(0, store.loads.get()); assertEquals(0, root.personal.snapshot().getJSONArray("sessions").length()); assertFalse(File(root.personal.directory, RequestContinuity.FILE).exists()); assertTrue(File(root.personal.directory, "ModelUsage").listFiles().orEmpty().isEmpty()) }
        suspend fun paper(): String {
            PDFBoxResourceLoader.init(target)
            val id = UUID.randomUUID().toString(); val file = File(directory, "$id.pdf")
            PDDocument().use { document -> repeat(3) { page -> val p = PDPage(); document.addPage(p); PDPageContentStream(document, p).use { out -> out.beginText(); out.setFont(PDType1Font.HELVETICA, 12f); out.newLineAtOffset(40f, 700f); out.showText("Synthetic physical page ${page + 1}"); out.endText() } }; document.save(file) }
            originals += file; files[id] = file
            root.execute("pdf.import", JSONObject().put("uri", "content://$AUTHORITY/$id"))
            return root.state.value.selectedPaperId!!
        }
        suspend fun close() = withContext(NonCancellable) {
            // Guard failures must also remain harmless: only this fake Root is visible to a possible owned worker.
            // Its SecretStore.load always throws before HTTP. Never cancel foreign WorkManager records.
            try {
                val jobs = root.personal.snapshot().getJSONArray("sessions")
                val ids = (0 until jobs.length()).map { UUID.fromString(jobs.getJSONObject(it).getString("id")) }
                val manager = WorkManager.getInstance(target)
                ids.forEach { manager.cancelWorkById(it).result.get(10, TimeUnit.SECONDS) }
                withTimeout(10000) { while (ids.any { manager.getWorkInfoById(it).get(10, TimeUnit.SECONDS)?.state?.isFinished == false }) delay(5) }
                field<Map<String, Job>>(root, "active").values.toList().forEach { it.cancelAndJoin() }
                val scope = field<CoroutineScope>(root, "exportScope"); scope.cancel(); scope.coroutineContext[Job]?.join()
                field<PdfRepository>(root, "pdf").clearSessionPasswords()
            } finally {
                try { originalController?.let { original -> InstrumentationRegistry.getInstrumentation().runOnMainSync { controllerField.set(app, original) } } }
                finally { originals.forEach { file -> files.entries.removeIf { it.value == file } }; directory.deleteRecursively() }
            }
        }
    }
    @Test fun actualRootPrepareCancelAndOldDiscardNeverCreateAStudyOrRetireANewerIntent() = runBlocking {
        val f = Fixture(); try { f.ready(); val old = f.checkPreview(); val latest = f.checkPreview(); f.noRequest()
            assertFalse(f.root.execute("model.fresh.discard", JSONObject().put("confirmationID", old.getString("confirmationID"))).getBoolean("cancelled"))
            assertTrue(f.root.execute("model.fresh.discard", JSONObject().put("confirmationID", latest.getString("confirmationID"))).getBoolean("cancelled")); f.rejectCommit(latest)
        } finally { f.close() }
    }
    @Test fun normalModelSaveClearAndFailedSaveAllRetireExistingConfirmationWithoutLoadingAKey() = runBlocking {
        for (kind in listOf("save", "clear", "failure")) { val f = Fixture(); try { f.ready(); val preview = f.checkPreview(); f.store.failure = kind == "failure"
            val value = if (kind == "clear") null else "synthetic-unused-model-value"
            if (kind == "failure") assertTrue(runCatching { f.root.updateSecret(com.nanless.paperdigest.ui.SecretKind.MODEL, value) }.isFailure) else f.root.updateSecret(com.nanless.paperdigest.ui.SecretKind.MODEL, value)
            f.rejectCommit(preview)
        } finally { f.close() } }
    }
    @Test fun pendingSecondMutationStillRejectsPrepareAfterFirstSaveHasFinished() = runBlocking {
        val f = Fixture(); val firstEntered = CountDownLatch(1); val secondEntered = CountDownLatch(1); val releaseFirst = CountDownLatch(1); val releaseSecond = CountDownLatch(1)
        var one: Deferred<Unit>? = null; var two: Deferred<Unit>? = null
        try { f.ready(); f.store.entered = { index -> if (index == 1) { firstEntered.countDown(); check(releaseFirst.await(10, TimeUnit.SECONDS)) } else { secondEntered.countDown(); check(releaseSecond.await(10, TimeUnit.SECONDS)) } }
            one = async(Dispatchers.IO) { f.root.updateSecret(com.nanless.paperdigest.ui.SecretKind.MODEL, "synthetic-one") }
            assertTrue(withContext(Dispatchers.IO) { firstEntered.await(10, TimeUnit.SECONDS) })
            two = async(Dispatchers.IO, start = CoroutineStart.UNDISPATCHED) { f.root.updateSecret(com.nanless.paperdigest.ui.SecretKind.MODEL, "synthetic-two") }
            releaseFirst.countDown(); one!!.await(); assertTrue(withContext(Dispatchers.IO) { secondEntered.await(10, TimeUnit.SECONDS) })
            assertTrue(runCatching { withTimeout(1000) { f.checkPreview() } }.exceptionOrNull() is IllegalArgumentException)
            releaseSecond.countDown(); two!!.await(); val preview = f.checkPreview(); f.root.execute("model.fresh.discard", JSONObject().put("confirmationID", preview.getString("confirmationID"))); f.noRequest()
        } finally {
            releaseFirst.countDown(); releaseSecond.countDown()
            withContext(NonCancellable) { one?.join(); two?.join(); f.close() }
        }
    }
    @Test fun sameOwnerReopenAndDifferentPhysicalPageRejectOldStudyConfirmation() = runBlocking {
        val f = Fixture(); try { f.ready(); val owner = f.paper(); val doc = f.root.state.value.pdfDocument!!
            fun draft() = JSONObject().put("readingMaterialID", f.root.state.value.readingMaterialID).put("question", "synthetic question").put("evidenceKind", "page").put("fromPage", 1).put("toPage", 1).put("chapter", 0)
            val page = f.root.execute("model.fresh.prepare", draft())
            f.root.execute("pdf.page", JSONObject().put("paperID", owner).put("pdfSHA", doc.sha256).put("page", 2)); f.rejectCommit(page)
            val reopened = f.root.execute("model.fresh.prepare", draft()); f.root.execute("paper.open", JSONObject().put("paperID", owner)); f.rejectCommit(reopened)
        } finally { f.close() }
    }
    @Test fun explicitRangePreviewUsesFrozenDraftAndConnectionCheckCarriesNoPaperMaterial() = runBlocking {
        val f = Fixture(); try { f.ready(); val owner = f.paper(); val doc = f.root.state.value.pdfDocument!!
            f.root.execute("pdf.page", JSONObject().put("paperID", owner).put("pdfSHA", doc.sha256).put("page", 3))
            val originalSHA = BackupCodec.hash(f.originals.single())
            val draft = JSONObject().put("readingMaterialID", f.root.state.value.readingMaterialID).put("question", "synthetic range question").put("evidenceKind", "range").put("fromPage", 1).put("toPage", 2).put("chapter", 0)
            val preview = f.root.execute("model.fresh.prepare", draft); assertTrue(preview.getString("scope").contains("1–2")); assertFalse(preview.getString("scope").contains("3–3"))
            val check = f.checkPreview(); assertEquals("connection-check", check.getString("kind")); assertTrue(check.getString("scope").contains("不包含论文")); f.noRequest()
            f.root.execute("model.fresh.discard", JSONObject().put("confirmationID", check.getString("confirmationID"))); assertEquals(originalSHA, BackupCodec.hash(f.originals.single()))
        } finally { f.close() }
    }
    class Source : ContentProvider() {
        override fun onCreate() = true
        override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor { require(mode == "r"); return ParcelFileDescriptor.open(files[uri.lastPathSegment] ?: throw FileNotFoundException("Unknown synthetic source"), ParcelFileDescriptor.MODE_READ_ONLY) }
        override fun getType(uri: Uri) = "application/pdf"
        override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, sort: String?): Cursor? = null
        override fun insert(uri: Uri, values: ContentValues?): Uri? = null
        override fun delete(uri: Uri, selection: String?, args: Array<out String>?) = 0
        override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?) = 0
    }
    companion object {
        private const val AUTHORITY = "com.nanless.paperdigest.freshsynthetic"
        private val files = ConcurrentHashMap<String, File>()
        @Suppress("UNCHECKED_CAST") private fun <T> field(root: Any, name: String): T = root.javaClass.getDeclaredField(name).also { it.isAccessible = true }.get(root) as T
    }
}
