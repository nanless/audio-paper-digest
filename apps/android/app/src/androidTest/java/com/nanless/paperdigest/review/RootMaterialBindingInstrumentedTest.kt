package com.nanless.paperdigest.review

import android.content.ContextWrapper
import androidx.test.platform.app.InstrumentationRegistry
import com.nanless.paperdigest.RootController
import com.nanless.paperdigest.data.*
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID

/** App-private synthetic sources only. No key, model, or remote Zotero writes. */
class RootMaterialBindingInstrumentedTest {
    private class Fixture {
        val target = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(target.cacheDir, "RootMaterialBinding-${UUID.randomUUID()}").canonicalFile.apply { check(mkdir()) }
        val context = object : ContextWrapper(target) { override fun getNoBackupFilesDir() = directory }
        val research = File(directory, "PaperDigest")
        val old = Paper("arxiv:2601.00001", "Synthetic original", sourceKind = "arxiv", identityStatus = "verified", blogURL = "https://example.invalid/guide/", sourceURL = "https://arxiv.org/abs/2601.00001v1", pdfURL = "https://arxiv.org/pdf/2601.00001v1", sourceVersion = "2601.00001v1", citation = JSONObject().put("title", "Synthetic original").put("absUrl", "https://arxiv.org/abs/2601.00001v1"))
        val latest = old.copy(title = "Synthetic new version", sourceVersion = "2601.00001v2", sourceURL = "https://arxiv.org/abs/2601.00001v2", pdfURL = "https://arxiv.org/pdf/2601.00001v2", citation = JSONObject().put("title", "Synthetic new version").put("absUrl", "https://arxiv.org/abs/2601.00001v2"))
        private val store = PersonalStore(research).apply { updateSettings(JSONObject().put("offlineMode", true)) }
        val cache = File(research, "PublishedLibrary/articles/${sha256(old.blogURL.toByteArray())}.json")
        init {
            writeCatalog(old, "original")
            val html = "<h1>Synthetic original guide</h1><p>Original v1 source.</p>"
            JsonFiles.write(cache, Article(old.id, html, "Original v1 source.", old.sourceURL!!, old.blogURL, sha256(html.toByteArray()), now(), sourceVersion = old.sourceVersion, completeOffline = true, citation = old.citation, catalogEpoch = "original", pdfURL = old.pdfURL, mathMLContract = "published-html-mathml-v1").json())
        }
        val controller = RootController(context, installBackground = false)
        private fun writeCatalog(paper: Paper, epoch: String) {
            JsonFiles.write(File(research, "PublishedLibrary/current.json"), JSONObject().put("format", "mac-published-library-v1").put("papers", JSONArray().put(paper.json())).put("retiredPapers", JSONArray()).put("validationEpoch", epoch).put("summary", JSONObject().put("paperCount", 1)))
        }
        suspend fun open() {
            controller.execute("paper.open", JSONObject().put("paperID", old.id))
            controller.execute("zotero.save", JSONObject().put("libraryType", "users").put("libraryID", "123456").put("collection", ""))
        }
        suspend fun updateCatalog() {
            writeCatalog(latest, "latest")
            val library = controller.javaClass.getDeclaredField("library").also { it.isAccessible = true }.get(controller) as CatalogRepository
            library.reload(); controller.execute("app.bootstrap", JSONObject())
        }
        fun prepare(token: String = controller.state.value.readingMaterialID) = JSONObject().put("includePDF", false).put("includeGuide", false).put("includeAnalysis", false).put("includeNote", false).put("preparationRequestID", UUID.randomUUID().toString()).put("readingMaterialID", token)
        fun close() { directory.deleteRecursively() }
    }

    @Test fun catalogRefreshKeepsTheActualReadingSourceAndExplicitReopenRetiresItsPreview() = runBlocking {
        val f = Fixture()
        try {
            f.open(); val originalCache = f.cache.readBytes()
            val originalToken = f.controller.state.value.readingMaterialID
            assertTrue(originalToken.isNotBlank())
            val prepared = f.controller.execute("zotero.prepare", f.prepare())
            val id = prepared.getString("preparedID")
            val archived = JSONObject(File(f.research, "ZoteroArchives/$id/material-0").readText())
            assertEquals("2601.00001v1", archived.getJSONObject("paper").getString("sourceVersion"))
            f.updateCatalog()
            val state = f.controller.state.value
            assertEquals("2601.00001v2", state.papers.single().sourceVersion)
            assertEquals("2601.00001v1", state.viewedPaper!!.sourceVersion)
            assertEquals("2601.00001v1", state.article!!.sourceVersion)
            assertEquals(originalToken, state.readingMaterialID)
            f.controller.execute("paper.open", JSONObject().put("paperID", f.old.id))
            assertNotEquals(originalToken, f.controller.state.value.readingMaterialID)
            val late = runCatching { f.controller.execute("zotero.prepare", f.prepare(originalToken)) }.exceptionOrNull()
            assertNotNull(late); assertTrue(late!!.message.orEmpty().contains("前台阅读材料已变化"))
            val oldConfirm = runCatching { f.controller.execute("zotero.archive", JSONObject().put("preparedID", id).put("readingMaterialID", originalToken)) }.exceptionOrNull()
            assertNotNull(oldConfirm); assertTrue(oldConfirm!!.message.orEmpty().contains("另一阅读材料"))
            val mixed = runCatching { f.controller.execute("zotero.prepare", f.prepare()) }.exceptionOrNull()
            assertNotNull(mixed); assertTrue(mixed!!.message.orEmpty().contains("原文版本或来源不同"))
            assertArrayEquals(originalCache, f.cache.readBytes())
            assertEquals("prepared", JSONObject(File(f.research, "ZoteroArchives/$id/journal.json").readText()).getString("status"))
        } finally { f.close() }
    }

    @Test fun privateRoleChangesRetireOnlyPreviewsThatActuallySelectedThoseRoles() = runBlocking {
        val f = Fixture()
        try {
            f.open()
            val selected = f.controller.execute("zotero.prepare", f.prepare().put("includeNote", true))
            assertTrue(selected.getBoolean("materialsCurrent"))
            assertTrue(f.controller.state.value.zotero.getJSONObject("prepared").getBoolean("materialsCurrent"))
            val id = selected.getString("preparedID"); val original = File(f.research, "ZoteroArchives/$id/journal.json").readBytes()
            val sourceToken = f.controller.state.value.readingMaterialID
            f.controller.personal.saveNote(f.old.id, "New private note after preparation", 0)
            f.controller.execute("app.bootstrap", JSONObject())
            assertEquals(sourceToken, f.controller.state.value.readingMaterialID)
            assertFalse(f.controller.state.value.zotero.getJSONObject("prepared").getBoolean("materialsCurrent"))
            val stale = runCatching { f.controller.execute("zotero.archive", JSONObject().put("preparedID", id).put("readingMaterialID", sourceToken)) }.exceptionOrNull()
            assertNotNull(stale); assertTrue(stale!!.message.orEmpty().contains("笔记、标注或研究已经变化"))
            assertArrayEquals(original, File(f.research, "ZoteroArchives/$id/journal.json").readBytes())
            f.controller.execute("zotero.prepare", f.prepare())
            f.controller.personal.saveNote(f.old.id, "Another unselected note", 1)
            f.controller.personal.appendSession(JSONObject().put("id", UUID.randomUUID().toString()).put("paperID", f.old.id).put("status", "completed").put("inputContract", "unselected-missing-originals"))
            f.controller.execute("app.bootstrap", JSONObject())
            assertTrue(f.controller.state.value.zotero.getJSONObject("prepared").getBoolean("materialsCurrent"))
        } finally { f.close() }
    }

    @Test fun confirmedPreviewCannotBeCombinedWithAnotherJournalId() = runBlocking {
        val f = Fixture()
        try {
            f.open(); val prepared = f.controller.execute("zotero.prepare", f.prepare()); val id = prepared.getString("preparedID")
            val journal = File(f.research, "ZoteroArchives/$id/journal.json"); val before = journal.readBytes()
            val error = runCatching { f.controller.execute("zotero.archive", JSONObject().put("preparedID", id).put("journalID", UUID.randomUUID().toString()).put("readingMaterialID", f.controller.state.value.readingMaterialID)) }.exceptionOrNull()
            assertNotNull(error); assertTrue(error!!.message.orEmpty().contains("不能指定另一原断点"))
            assertArrayEquals(before, journal.readBytes())
            assertTrue(f.controller.state.value.sessions.isEmpty())
        } finally { f.close() }
    }
}
