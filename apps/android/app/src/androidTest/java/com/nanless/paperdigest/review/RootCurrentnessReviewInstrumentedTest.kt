package com.nanless.paperdigest.review

import android.content.ContextWrapper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nanless.paperdigest.RootController
import com.nanless.paperdigest.cloud.BackupCodec
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.pdf.PdfRepository
import com.nanless.paperdigest.ui.UiState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.Base64
import java.util.UUID

/** Non-author local currentness probes; public assets in fresh isolated app-private roots only. */
@RunWith(AndroidJUnit4::class)
class RootCurrentnessReviewInstrumentedTest {
    private class Fixture(val initialPaper: Paper) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val target = instrumentation.targetContext
        val directory = File(target.cacheDir, "RootCurrentnessReview-${UUID.randomUUID()}").canonicalFile.apply { check(mkdir()) }
        val context = object : ContextWrapper(target) { override fun getNoBackupFilesDir() = directory }
        val research = File(directory, "PaperDigest")
        fun writeCatalog(paper: Paper, epoch: String) {
            JsonFiles.write(File(research, "PublishedLibrary/current.json"), JSONObject().put("format", "mac-published-library-v1").put("papers", JSONArray().put(paper.json())).put("retiredPapers", JSONArray())
                .put("validationEpoch", epoch).put("summary", JSONObject().put("paperCount", 1).put("syncedAt", "2026-01-01T00:00:00Z")))
        }
        init { PersonalStore(research).updateSettings(JSONObject().put("offlineMode", true)); writeCatalog(initialPaper, "epoch-old") }
        val controller = RootController(context, installBackground = false)
        val flow = field<MutableStateFlow<UiState>>(controller, "_state")
        val library = field<CatalogRepository>(controller, "library")
        suspend fun reload(paper: Paper, epoch: String) { writeCatalog(paper, epoch); library.reload(); controller.execute("app.bootstrap", JSONObject()) }
        fun close() { directory.deleteRecursively() }
    }

    @Test fun catalogChangeMarksViewedOldMaterialsStaleWithoutReplacingOriginalBytes() = runBlocking {
        val oldPaper = Paper("review:currentness", "Synthetic old catalog title", sourceKind = "review-fixture", blogURL = "https://example.invalid/guide", sourceURL = "https://example.invalid/source", pdfURL = "https://example.invalid/original-v1.pdf", sourceVersion = "fixture-v1")
        val f = Fixture(oldPaper)
        try {
            val sample = JSONObject(f.target.assets.open("published/sample.json").bufferedReader().use { it.readText() }); val pdfMetadata = sample.getJSONObject("pdf")
            val sourceFile = File(f.directory, "qa-public-source.pdf")
            f.target.assets.open("published/" + pdfMetadata.getString("src")).use { input -> sourceFile.outputStream().use { input.copyTo(it) } }
            assertEquals(pdfMetadata.getString("sha256"), BackupCodec.hash(sourceFile))
            val document = PdfRepository(f.context, f.research).importFile(sourceFile, "Public QA original")
            val html = "<h2>Synthetic original revision</h2><p>Never replace this original during a catalog refresh.</p>"
            val old = Article(oldPaper.id, html, "Synthetic original revision.", oldPaper.sourceURL!!, oldPaper.blogURL, sha256(html.toByteArray()), "2026-01-01T00:00:00Z", sourceVersion = oldPaper.sourceVersion, completeOffline = true, catalogEpoch = "epoch-old", pdfURL = oldPaper.pdfURL)
            val cache = File(f.research, "PublishedLibrary/articles/${sha256(oldPaper.blogURL.toByteArray())}.json"); JsonFiles.write(cache, old.json()); val cacheBytes = cache.readBytes()
            val receipt = JSONObject().put("paperID", oldPaper.id).put("sha256", document.sha256).put("version", oldPaper.sourceVersion).put("sourceURL", oldPaper.pdfURL).put("isStale", false).put("currentness", "verified-at-save").put("notices", JSONArray())
            f.flow.value = f.flow.value.copy(selectedPaperId = oldPaper.id, viewedPaper = oldPaper, article = old, pdfMode = true, pdfDocument = document, pdfReceipt = receipt)
            f.controller.execute("app.bootstrap", JSONObject())
            val originalReadingID = f.flow.value.readingMaterialID
            assertTrue(originalReadingID.isNotEmpty())
            val latest = oldPaper.copy(title = "Synthetic latest catalog title", sourceVersion = "fixture-v2", pdfURL = "https://example.invalid/original-v2.pdf")
            f.reload(latest, "epoch-new")
            val state = f.flow.value
            assertEquals(old.html, state.article!!.html); assertEquals(old.revisionSHA256, state.article!!.revisionSHA256); assertEquals("fixture-v1", state.article!!.sourceVersion); assertTrue(state.article!!.isStale); assertTrue(state.article!!.notices.any { it.contains("尚未重新核对") })
            assertEquals(document, state.pdfDocument); assertEquals(document.sha256, state.pdfReceipt.getString("sha256")); assertEquals("fixture-v1", state.pdfReceipt.getString("version")); assertEquals(oldPaper.pdfURL, state.pdfReceipt.getString("sourceURL")); assertTrue(state.pdfReceipt.getBoolean("isStale")); assertEquals("catalog-source-changed", state.pdfReceipt.getString("currentness"))
            // The catalog advances, while the actual reading workspace keeps the opened source.
            assertEquals("fixture-v1", state.viewedPaper!!.sourceVersion); assertEquals(oldPaper.pdfURL, state.viewedPaper!!.pdfURL); assertEquals(oldPaper.title, state.viewedPaper!!.title)
            assertEquals("fixture-v2", state.papers.single { it.id == oldPaper.id }.sourceVersion)
            assertEquals(latest.pdfURL, state.papers.single { it.id == oldPaper.id }.pdfURL)
            assertEquals(originalReadingID, state.readingMaterialID)
            assertArrayEquals(cacheBytes, cache.readBytes()); assertEquals(document.sha256, BackupCodec.hash(File(document.localPath))); assertEquals(oldPaper.id, state.selectedPaperId)
        } finally { f.close() }
    }

    @Test fun explicitVerifiedOfflineSnapshotKeepsItsIdentityAndOriginalCurrentnessAfterCatalogChanges() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val fixture = JSONObject(instrumentation.context.assets.open("offline-swift-vectors.json").bufferedReader().use { it.readText() })
        val packet = fixture.getJSONArray("packets").objects().single { it.optBoolean("hasPDF") && it.optBoolean("hasImages") }
        val bytes = packet.getJSONArray("files").objects().associate { it.getString("path") to Base64.getDecoder().decode(it.getString("data")) }
        val originalPaper = Paper.fromJson(OfflineFoundationJSON.parse(bytes.getValue("paper.json")))
        val latest = originalPaper.copy(title = "Synthetic current website catalog", sourceVersion = "fixture-v2", pdfURL = "https://example.invalid/newer-v2.pdf")
        val f = Fixture(latest)
        try {
            val packageRoot = File(f.research, "Offline/${packet.getString("id")}")
            packet.getJSONArray("files").objects().forEach { entry -> val raw = bytes.getValue(entry.getString("path")); assertEquals(entry.getString("sha256"), BackupCodec.hash(raw)); BackupCodec.atomicBytes(File(packageRoot, entry.getString("path")), raw) }
            f.controller.execute("storage.openPackage", JSONObject().put("id", packet.getString("id")))
            f.controller.execute("pdf.open", JSONObject())
            val before = f.flow.value; val revision = before.article!!.revisionSHA256; val receipt = before.pdfReceipt.copy(); val document = before.pdfDocument!!
            assertEquals(1, document.pageCount); assertEquals("offline-snapshot", receipt.getString("currentness")); assertEquals(originalPaper.sourceVersion, before.viewedPaper!!.sourceVersion)
            f.reload(latest.copy(sourceVersion = "fixture-v3", pdfURL = "https://example.invalid/newer-v3.pdf"), "epoch-latest")
            val after = f.flow.value
            assertEquals(originalPaper.sourceVersion, after.viewedPaper!!.sourceVersion); assertEquals(originalPaper.title, after.viewedPaper!!.title); assertEquals("fixture-v3", after.papers.single { it.id == originalPaper.id }.sourceVersion)
            assertEquals(revision, after.article!!.revisionSHA256); assertFalse(after.article!!.isStale); assertFalse(after.article!!.notices.any { it.contains("目录已重新同步") }); assertTrue(after.article!!.notices.any { it.contains("离线原始快照") })
            assertEquals(document, after.pdfDocument); assertEquals(canonical(receipt), canonical(after.pdfReceipt)); assertEquals("offline-snapshot", after.pdfReceipt.getString("currentness")); assertTrue(after.pdfReceipt.getBoolean("isStale"))
            packet.getJSONArray("files").objects().forEach { entry -> assertEquals(entry.getString("sha256"), BackupCodec.hash(File(packageRoot, entry.getString("path")))) }
        } finally { f.close() }
    }

    companion object { @Suppress("UNCHECKED_CAST") private fun <T> field(value: Any, name: String): T = value.javaClass.getDeclaredField(name).also { it.isAccessible = true }.get(value) as T }
}
