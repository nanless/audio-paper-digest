package com.nanless.paperdigest.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PaperCatalogOwnershipTest {
    @Test fun refreshedCatalogSharesEqualPayloadButKeepsNewProvenanceAndChangedFields() {
        val old = Paper("arxiv:2601.00001", "Title", authors = listOf("作者"), tags = listOf("声学"),
            citation = JSONObject().put("authors", JSONArray().put("作者")).put("details", JSONObject().put("count", 1)),
            original = JSONObject().put("publishedSnapshotID", "old"), appearances = listOf("old-page"))
        val before = canonical(old.json())
        val fresh = Paper.fromOwnedCatalogJson(old.json()).copy(date = "2026-10-25", score = 9.0,
            original = JSONObject().put("publishedSnapshotID", "new"), appearances = listOf("new-page"))
        val shared = fresh.sharingCatalogValues(old)
        assertSame(old.citation, shared.citation); assertSame(old.authors, shared.authors); assertSame(old.tags, shared.tags)
        assertEquals(canonical(fresh.json()), canonical(shared.json()))
        assertEquals("new", shared.original!!.getString("publishedSnapshotID")); assertEquals(listOf("new-page"), shared.appearances)
        assertEquals(before, canonical(old.json()))
        // The caller can export and modify its copy without changing either owned snapshot.
        shared.json().getJSONObject("citation").getJSONObject("details").put("count", 7)
        assertEquals(before, canonical(old.json()))
    }
    @Test fun refreshedCatalogNeverReusesChangedOrDifferentlyTypedCitation() {
        val old = Paper("p", "Title", citation = JSONObject().put("future", JSONArray().put(1).put("x")))
        val variants = listOf(JSONObject().put("future", JSONArray().put("1").put("x")),
            JSONObject().put("future", JSONArray().put(1).put("y")), JSONObject().put("future", JSONArray().put(1)),
            JSONObject().put("future", JSONArray().put(1).put("x")).put("extra", JSONObject.NULL))
        for (citation in variants) {
            val fresh = old.copy(citation = citation)
            val shared = fresh.sharingCatalogValues(old)
            assertSame(citation, shared.citation); assertEquals(canonical(fresh.json()), canonical(shared.json()))
        }
        val another = old.copy(id = "another", citation = old.citation.copy())
        assertSame(another, another.sharingCatalogValues(old)); assertSame(another, another.sharingCatalogValues(null))
    }
    @Test fun compactCatalogPreservesEveryExportedFieldAndUnknownExtension() {
        val raw = Paper("arxiv:2601.00001", "原英文题目", "中文题目", listOf("作者一", "作者二"), "2026-01-01", 7.5, "task", "method", listOf("tag"), "arxiv", "verified", "https://example.invalid/guide/", "https://arxiv.org/abs/2601.00001v1", "https://arxiv.org/pdf/2601.00001v1", "2601.00001v1", JSONObject().put("authors", JSONArray().put("作者一")).put("doi", "unknown-original"), "a".repeat(64), listOf("page-a", "page-b")).json()
            .put("futureOriginal", JSONObject().put("nested", JSONArray().put(JSONObject.NULL).put("原未知字段")))
            .put("publishedSnapshotID", "b".repeat(64)).put("pdfSHA", "legacy-non-local-field")
        val before = canonical(raw)
        val full = Paper.fromJson(raw); val compact = Paper.fromOwnedCatalogJson(raw)
        assertEquals(canonical(full.json()), canonical(compact.json())); assertEquals(before, canonical(raw))
        assertEquals(setOf("futureOriginal", "publishedSnapshotID", "pdfSHA"), compact.original!!.keys().asSequence().toSet())
        val exported = compact.json(); exported.getJSONObject("futureOriginal").put("nested", "changed")
        assertEquals(canonical(full.json()), canonical(compact.json()))
    }
    @Test fun localAndInvalidOptionalValuesKeepTheOriginalTypedOutputRules() {
        for (kind in listOf("local", "conference", "arxiv")) {
            val raw = JSONObject().put("id", "fixture:$kind").put("title", "Title").put("sourceKind", kind).put("pdfSHA", "c".repeat(64)).put("score", "not-a-score").put("authors", JSONArray()).put("unknown", true)
            assertEquals(canonical(Paper.fromJson(raw).json()), canonical(Paper.fromOwnedCatalogJson(raw).json()))
        }
    }
}
