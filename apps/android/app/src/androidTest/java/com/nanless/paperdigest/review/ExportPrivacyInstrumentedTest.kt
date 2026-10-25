package com.nanless.paperdigest.review

import android.content.ContextWrapper
import androidx.test.platform.app.InstrumentationRegistry
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.model.StudyService
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID

/** Synthetic local private roots and provider responses only; no real account or HTTP. */
class ExportPrivacyInstrumentedTest {
    private class Fixture {
        private val target = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(target.cacheDir, "export-privacy-${UUID.randomUUID()}").canonicalFile.apply { check(mkdir()) }
        val context = object : ContextWrapper(target) { override fun getNoBackupFilesDir() = root }
        val store = PersonalStore(File(root, "Research"))
        val paper = Paper("local:privacy-fixture", "Synthetic original", sourceKind = "local")
        var calls = 0
        val study = StudyService(store, { "synthetic-not-real-key" }) { _, _, _, _ ->
            calls++
            HttpBytes(200, emptyMap(), JSONObject().put("choices", JSONArray().put(JSONObject().put("finish_reason", "stop").put("message", JSONObject().put("content", "Synthetic preserved answer")))).toString().toByteArray())
        }
        val exports = ExportService(context, store, study)
        init {
            store.updateSettings(JSONObject().put("endpoint", "https://synthetic.invalid/v1").put("model", "synthetic-model").put("protocol", "chat"))
            store.saveNote(paper.id, "PRIVATE-CURRENT-NOTE", 0)
            store.replaceAnnotations(paper.id, listOf(JSONObject().put("id", "private-mark").put("text", "PRIVATE-CURRENT-MARK").put("pdfSHA", "a".repeat(64)).put("page", 1)))
        }
        fun options(analysis: Boolean, note: Boolean) = JSONObject().put("includePDF", false).put("includeGuide", false).put("includeAnalysis", analysis).put("includeNote", note)
        suspend fun completed() {
            val p = study.prepare(paper.id, "Synthetic question", "PAST-SUBMITTED-SENTENCE", JSONObject().put("paperID", paper.id).put("kind", "published-guide"))
            study.run(p.getString("id"))
        }
        fun close() { root.deleteRecursively() }
    }

    @Test fun excludingCurrentNotesDoesNotSmuggleThemInsideAnalysisAttachment() = runBlocking {
        val f = Fixture()
        try {
            f.completed(); val before = File(f.store.directory, "personal.json").readBytes()
            val roles = f.exports.zoteroMaterials(f.paper, null, null, f.options(analysis = true, note = false)).materials
            assertFalse(roles.any { it.role == "note" })
            val analysis = JSONObject(roles.single { it.role == "analysis" }.file!!.readText())
            assertFalse("The current note was deselected", analysis.has("note")); assertFalse("Current annotations were deselected", analysis.has("annotations"))
            assertFalse(analysis.toString().contains("PRIVATE-CURRENT-NOTE")); assertFalse(analysis.toString().contains("PRIVATE-CURRENT-MARK"))
            val input = analysis.getJSONArray("sessions").getJSONObject(0).getJSONObject("originalMaterials").getJSONObject("input.json").getString("data")
            assertTrue(java.util.Base64.getDecoder().decode(input).toString(Charsets.UTF_8).contains("PAST-SUBMITTED-SENTENCE"))
            assertArrayEquals(before, File(f.store.directory, "personal.json").readBytes()); assertEquals(1, f.calls)
        } finally { f.close() }
    }

    @Test fun deselectedAnalysisDoesNotReadOrValidateUnrelatedPrivateModelMaterials() = runBlocking {
        val f = Fixture()
        try {
            // A missing historical response must not prevent the explicitly selected note-only archive.
            f.store.appendSession(JSONObject().put("id", UUID.randomUUID().toString()).put("paperID", f.paper.id).put("status", "completed").put("inputContract", "android-study-input-v1"))
            val before = File(f.store.directory, "personal.json").readBytes()
            val roles = f.exports.zoteroMaterials(f.paper, null, null, f.options(analysis = false, note = true)).materials
            assertFalse(roles.any { it.role == "analysis" }); assertTrue(roles.single { it.role == "note" }.noteHTML!!.contains("PRIVATE-CURRENT-NOTE"))
            assertEquals(0, f.calls); assertArrayEquals(before, File(f.store.directory, "personal.json").readBytes())
        } finally { f.close() }
    }
}
