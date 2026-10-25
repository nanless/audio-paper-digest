package com.nanless.paperdigest.review

import android.content.ContextWrapper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nanless.paperdigest.RootController
import com.nanless.paperdigest.cloud.BackupCodec
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.model.StudyService
import com.nanless.paperdigest.ui.SecretKind
import com.nanless.paperdigest.ui.UiState
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.sync.Mutex
import org.json.JSONArray
import org.json.JSONObject
import org.jsoup.Jsoup
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

/** Non-author real-controller probes. New private fixture roots only; no network or Vault operations. */
@RunWith(AndroidJUnit4::class)
class RootBindingReviewInstrumentedTest {
    private class Fixture {
        private val target = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(target.cacheDir, "RootBindingReview-${UUID.randomUUID()}").canonicalFile.apply { check(mkdir()) }
        val context = object : ContextWrapper(target) { override fun getNoBackupFilesDir() = directory }
        val research = File(directory, "PaperDigest")
        val expectedSummary = JSONObject().put("syncedAt", "2026-01-02T00:00:00Z").put("paperCount", 2).put("entryCount", 4).put("removedCount", 1).put("fixtureOnly", true)
        init {
            PersonalStore(research).updateSettings(JSONObject().put("offlineMode", true).put("endpoint", "https://example.invalid/v1").put("model", "review-synthetic-model").put("protocol", "chat").put("maxTokens", 128).put("dailyRequests", 1))
            JsonFiles.write(File(research, "PublishedLibrary/current.json"), JSONObject().put("format", "mac-published-library-v1").put("papers", JSONArray()).put("retiredPapers", JSONArray()).put("summary", expectedSummary).put("validationEpoch", "review-fixture"))
        }
        val controller = RootController(context, installBackground = false)
        val flow = field<MutableStateFlow<UiState>>(controller, "_state")
        val lock = field<Mutex>(controller, "maintenance")
        val a = Paper("review:owner-a", "Synthetic original owner A", sourceKind = "review-fixture")
        val b = Paper("review:owner-b", "Synthetic current owner B", sourceKind = "review-fixture")
        init {
            controller.personal.rememberPaper(a); controller.personal.rememberPaper(b)
            flow.value = flow.value.copy(selectedPaperId = b.id, article = Article(b.id, "<p>Do not export CURRENT-B-ARTICLE</p>", "CURRENT-B-ARTICLE", "https://example.invalid/b", "https://example.invalid/blog-b", "b".repeat(64), "2026-01-01T00:00:00Z"))
        }
        fun selectA() { flow.value = flow.value.copy(selectedPaperId = a.id) }
        fun close() { directory.deleteRecursively() }
    }

    @Test fun modelSecretChangeWaitsForMaintenanceBeforeThePreVaultTrap() = runBlocking {
        val f = Fixture(); val owner = Any()
        try {
            // Endpoint/config are valid, so the old implementation reaches clear().
            StudyService.validatedConfig(f.controller.personal.settings())
            // Nonempty directory makes clear() fail before any Keystore access.
            val trap = File(f.directory, "PaperDigestDevice/model-key-binding.json").apply { check(mkdirs()) }
            val sentinel = File(trap, "pre-vault-sentinel").apply { writeText("synthetic only") }
            f.lock.lock(owner)
            val pending = async(Dispatchers.IO, start = CoroutineStart.UNDISPATCHED) { runCatching { f.controller.updateSecret(SecretKind.MODEL, "synthetic-never-written") } }
            try {
                assertTrue("Model credential mutation must wait for the real shared maintenance mutex", pending.isActive)
                assertFalse(pending.isCompleted); assertEquals("synthetic only", sentinel.readText())
                assertTrue(File(f.directory, "PaperDigestSecrets").listFiles().orEmpty().isEmpty())
            } finally { pending.cancelAndJoin(); f.lock.unlock(owner) }
            assertTrue(sentinel.isFile)
        } finally { if (f.lock.holdsLock(owner)) f.lock.unlock(owner); f.close() }
    }

    @Test fun actualCachedCatalogSummaryReachesUiStateWithoutInventingFreshness() = runBlocking {
        val f = Fixture()
        try {
            f.controller.execute("app.bootstrap", JSONObject())
            assertEquals(canonical(f.expectedSummary), canonical(f.flow.value.catalogSummary))
            assertEquals("2026-01-02T00:00:00Z", f.flow.value.catalogSyncedAt)
            assertTrue(f.flow.value.catalogSummary.getBoolean("fixtureOnly"))
        } finally { f.close() }
    }

    @Test fun historicalResearchExportBindsOriginalOwnerAndNeverCurrentArticleOrPdf() = runBlocking {
        val f = Fixture()
        try {
            val id = UUID.randomUUID().toString()
            val session = JSONObject().put("id", id).put("paperID", f.a.id).put("status", "complete").put("question", "Original A question")
                .put("answer", "ORIGINAL-A-ANSWER").put("inputContract", "review-opaque-history-v1").put("usage", JSONObject().put("total_tokens", 77)).put("charge", "amount_unknown")
                .put("source", JSONObject().put("paperID", f.a.id).put("revision", "a".repeat(64)))
            f.controller.personal.appendSession(session)
            val originals = mapOf("input.json" to "opaque original A input".toByteArray(), "response.bin" to "opaque original A response".toByteArray(), "response.json" to "opaque original A recovery".toByteArray())
            originals.forEach { (name, bytes) -> JsonFiles.write(File(f.research, "ModelUsage/$id-$name"), bytes) }
            val prepared = f.controller.execute("export.prepare", JSONObject().put("format", "research-json").put("sessionID", id))
            val exported = JSONObject(File(f.directory, "PaperDigestTransfers/Exports/${prepared.getString("documentID")}.bin").readText())
            // Neither platform's original sealed input contains a complete Paper record.
            assertTrue(exported.isNull("paper")); assertTrue(exported.isNull("article"))
            assertEquals(f.a.id, exported.getJSONObject("historicalReference").getString("paperID"))
            assertEquals("not-sealed-with-original-input", exported.getJSONObject("historicalReference").getString("metadataStatus"))
            assertEquals("a".repeat(64), exported.getJSONObject("historicalReference").getJSONObject("source").getString("revision"))
            assertFalse(exported.has("note")); assertFalse(exported.has("annotations"))
            assertFalse(exported.toString().contains(f.b.title)); assertFalse(exported.toString().contains(f.a.title))
            assertFalse(exported.toString().contains("CURRENT-B-ARTICLE")); assertEquals(f.b.id, f.flow.value.selectedPaperId)
            val carried = exported.getJSONArray("sessions").getJSONObject(0)
            assertEquals("ORIGINAL-A-ANSWER", carried.getString("answer")); assertEquals(77, carried.getJSONObject("usage").getInt("total_tokens")); assertEquals("amount_unknown", carried.getString("charge"))
            originals.forEach { (name, bytes) ->
                val raw = carried.getJSONObject("originalMaterials").getJSONObject(name)
                assertEquals(BackupCodec.hash(bytes), raw.getString("sha256")); assertArrayEquals(bytes, java.util.Base64.getDecoder().decode(raw.getString("data")))
                assertArrayEquals(bytes, File(f.research, "ModelUsage/$id-$name").readBytes())
            }
            val beforeFiles = File(f.directory, "PaperDigestTransfers/Exports").listFiles()!!.map { it.name }.sorted()
            for (format in listOf("paper-pdf", "guide-html")) assertTrue(runCatching { f.controller.execute("export.prepare", JSONObject().put("format", format).put("sessionID", id)) }.isFailure)
            assertEquals(beforeFiles, File(f.directory, "PaperDigestTransfers/Exports").listFiles()!!.map { it.name }.sorted())
            assertEquals(canonical(session), canonical(f.controller.personal.session(id)))
        } finally { f.close() }
    }

    private fun mark(id: String, group: String, hash: String, comment: String) = JSONObject().put("id", id).put("groupID", group).put("pdfSHA", hash)
        .put("page", 2).put("rect", "{{10, 20}, {30, 8}}").put("text", "EXCERPT-FIXTURE").put("comment", comment).put("createdAt", "2026-01-01T01:02:03Z")
        .put("coordinateSystem", "pdf-user-space-unrotated-v1").put("extractor", "review-preserved-extractor").put("source", JSONObject().put("version", "fixture-v1"))

    @Test fun annotationGroupEditAndRemovalPreserveOtherPdfAndOtherGroups() = runBlocking {
        val f = Fixture()
        try {
            f.selectA(); val marks = listOf(mark("a-0", "shared-group", "a".repeat(64), "old"), mark("a-1", "shared-group", "a".repeat(64), "old"), mark("b-0", "shared-group", "b".repeat(64), "other-pdf"), mark("h-0", "different-group", "a".repeat(64), "other-group"))
            f.controller.personal.replaceAnnotations(f.a.id, marks)
            f.controller.execute("personal.annotationNote", JSONObject().put("paperID", f.a.id).put("id", "a-0").put("comment", "new"))
            val edited = f.controller.personal.annotations(f.a.id).associateBy { it.getString("id") }
            assertEquals("new", edited.getValue("a-0").getString("comment")); assertEquals("new", edited.getValue("a-1").getString("comment"))
            assertEquals(canonical(marks[2]), canonical(edited.getValue("b-0"))); assertEquals(canonical(marks[3]), canonical(edited.getValue("h-0")))
            val beforeRejected = canonical(JSONArray(f.controller.personal.annotations(f.a.id)))
            assertTrue(runCatching { f.controller.execute("personal.annotationNote", JSONObject().put("paperID", f.b.id).put("id", "a-0").put("comment", "wrong owner")) }.isFailure)
            assertEquals(beforeRejected, canonical(JSONArray(f.controller.personal.annotations(f.a.id))))
            f.controller.execute("pdf.removeAnnotation", JSONObject().put("paperID", f.a.id).put("id", "a-1"))
            val left = f.controller.personal.annotations(f.a.id)
            assertEquals(setOf("b-0", "h-0"), left.map { it.getString("id") }.toSet()); assertEquals(canonical(JSONArray(marks.drop(2))), canonical(JSONArray(left)))
        } finally { f.close() }
    }

    @Test fun independentZoteroNoteRolePreservesFullNoteAndEveryPortableMark() = runBlocking {
        val f = Fixture()
        try {
            val note = JSONObject().put("text", "Synthetic original note").put("revision", 7).put("updatedAt", "2026-01-01T03:04:05Z").put("unknownOriginal", "preserve")
            val marks = listOf(mark("a-0", "shared-group", "a".repeat(64), "same original comment"), mark("a-1", "shared-group", "a".repeat(64), "same original comment"))
            val personal = f.controller.personal.snapshot(); personal.getJSONObject("notes").put(f.a.id, note); f.controller.personal.replaceValidated(personal); f.controller.personal.replaceAnnotations(f.a.id, marks)
            val before = File(f.research, "personal.json").readBytes()
            val service = ExportService(f.context, f.controller.personal, StudyService(f.controller.personal, { error("No model credential may be read by a note export") }))
            val materials = service.zoteroMaterials(f.a, null, null, JSONObject().put("includePDF", false).put("includeGuide", false).put("includeAnalysis", false).put("includeNote", true))
            val role = materials.materials.single { it.role == "note" }; val html = role.noteHTML!!; assertEquals(sha256(html.toByteArray()), role.sha256)
            val pre = Jsoup.parseBodyFragment(html).select("pre"); assertEquals(2, pre.size)
            assertEquals(1, pre.first()!!.wholeText().split("EXCERPT-FIXTURE").size - 1)
            val originals = JSONObject(pre.last()!!.wholeText())
            assertEquals("paperdigest-notes-archive-v1", originals.getString("contract")); assertEquals(f.a.id, originals.getString("paperID"))
            assertEquals(canonical(note), canonical(originals.getJSONObject("note"))); assertEquals(canonical(JSONArray(marks)), canonical(originals.getJSONArray("annotations")))
            assertArrayEquals(before, File(f.research, "personal.json").readBytes())
        } finally { f.close() }
    }

    @Test fun blankGroupIdCannotEditOrDeleteAnotherIndependentMarkInSamePdf() = runBlocking {
        val f = Fixture()
        try {
            f.selectA()
            val first = mark("blank-first", "", "a".repeat(64), "first original")
            val other = mark("blank-other", "", "a".repeat(64), "other independent original")
            val named = mark("named-other", "nonempty-group", "a".repeat(64), "named original")
            val originals = listOf(first, other, named)
            f.controller.personal.replaceAnnotations(f.a.id, originals)
            f.controller.execute("personal.annotationNote", JSONObject().put("paperID", f.a.id).put("id", "blank-first").put("comment", "only first changed"))
            val edited = f.controller.personal.annotations(f.a.id).associateBy { it.getString("id") }
            val failures = mutableListOf<String>()
            if (edited.getValue("blank-first").getString("comment") != "only first changed") failures += "selected mark not edited"
            if (canonical(other) != canonical(edited["blank-other"])) failures += "blank group edited another independent mark"
            if (canonical(named) != canonical(edited["named-other"])) failures += "named group changed"
            // Run the deletion branch independently even if edit already failed.
            f.controller.personal.replaceAnnotations(f.a.id, originals)
            f.controller.execute("pdf.removeAnnotation", JSONObject().put("paperID", f.a.id).put("id", "blank-first"))
            val remaining = f.controller.personal.annotations(f.a.id)
            if (remaining.map { it.getString("id") }.toSet() != setOf("blank-other", "named-other")) failures += "blank group deleted another independent mark"
            if (remaining.firstOrNull { it.optString("id") == "blank-other" }?.let(::canonical) != canonical(other)) failures += "other original not preserved"
            assertTrue(failures.joinToString("; "), failures.isEmpty())
        } finally { f.close() }
    }

    companion object { @Suppress("UNCHECKED_CAST") private fun <T> field(value: Any, name: String): T = value.javaClass.getDeclaredField(name).also { it.isAccessible = true }.get(value) as T }
}
