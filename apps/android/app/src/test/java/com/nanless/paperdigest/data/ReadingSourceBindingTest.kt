package com.nanless.paperdigest.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ReadingSourceBindingTest {
    private val paper = Paper("arxiv:2601.00001", "Scientific title", sourceKind = "arxiv", blogURL = "https://example.invalid/guide/", sourceURL = "https://arxiv.org/abs/2601.00001v2", pdfURL = "https://arxiv.org/pdf/2601.00001v2", sourceVersion = "2601.00001v2")
    private fun article(p: Paper = paper) = Article(p.id, "<h1>Actual guide</h1>", "Actual guide", p.sourceURL!!, p.blogURL, "a".repeat(64), "2026-01-01T00:00:00Z", sourceVersion = p.sourceVersion, pdfURL = p.pdfURL)
    private fun receipt() = JSONObject().put("paperID", paper.id).put("sha256", "b".repeat(64)).put("sourceURL", paper.pdfURL).put("version", paper.sourceVersion)

    @Test fun samePaperOldGuideCannotSupplyNewVersionCitationOrMaterials() {
        val old = article(paper.copy(sourceVersion = "2601.00001v1", sourceURL = "https://arxiv.org/abs/2601.00001v1", pdfURL = "https://arxiv.org/pdf/2601.00001v1"))
        assertTrue(runCatching { ReadingSourceBinding.requireArticle(paper, old) }.isFailure)
        assertTrue(runCatching { ExportService.citationPaper(paper, old) }.isFailure)
    }
    @Test fun eachSourceComponentIsBoundEvenWhenThePaperIdMatches() {
        val original = article()
        for (changed in listOf(original.copy(paperID = "another"), original.copy(blogURL = "https://example.invalid/other"), original.copy(sourceURL = "https://example.invalid/other"), original.copy(pdfURL = null), original.copy(sourceVersion = null))) {
            assertTrue(runCatching { ReadingSourceBinding.requireArticle(paper, changed) }.isFailure)
        }
        ReadingSourceBinding.requireArticle(paper, original.copy(isStale = true, notices = listOf("当前性未核对")))
    }
    @Test fun declaredCitationCannotOverrideTheActualArticleSourceTuple() {
        for (bad in listOf(JSONObject().put("absUrl", "https://arxiv.org/abs/2601.00001v1"), JSONObject().put("sourceUrl", "https://arxiv.org/abs/2601.00001v1"), JSONObject().put("pdfUrl", "https://arxiv.org/pdf/2601.00001v1"), JSONObject().put("arxivId", "2601.00001v1"), JSONObject().put("arxivId", "2601.99999v2"))) {
            assertTrue(runCatching { ExportService.citationPaper(paper, article().copy(citation = bad)) }.isFailure)
        }
        val original = JSONObject().put("absUrl", paper.sourceURL).put("pdfUrl", paper.pdfURL).put("arxivId", paper.sourceVersion)
        assertEquals(paper.sourceURL, ExportService.citationPaper(paper, article().copy(citation = original)).sourceURL)
    }
    @Test fun currentnessProjectionsDoNotGrantANewMaterialIdentity() {
        val original = article(); val r = receipt()
        fun token(a: Article, p: JSONObject) = ReadingSourceBinding.token(paper, a, p, "workspace", 1, null)
        val expected = token(original, r)
        assertEquals(expected, token(original.copy(isStale = true, notices = listOf("不同提示"), fetchedAt = "another", catalogEpoch = "another"), r.copy().put("isStale", true).put("validatedAt", "another").put("notices", JSONArray().put("another"))))
        assertNotEquals(expected, ReadingSourceBinding.token(paper, original, r, "workspace", 2, null))
        assertNotEquals(expected, ReadingSourceBinding.token(paper, original, r, "another-workspace", 1, null))
        assertNotEquals(expected, ReadingSourceBinding.token(paper, original, r, "workspace", 1, "offline-original"))
        assertNotEquals(expected, token(original.copy(revisionSHA256 = "c".repeat(64)), r))
        assertNotEquals(expected, token(original, r.copy().put("sha256", "d".repeat(64))))
    }
    @Test fun actualDisplayAndScientificImageChangesRetireTheOldPreviewIdentity() {
        val original = article().copy(resources = listOf(ArticleResource("https://example.invalid/figure.png", localPath = "/private/figure", sha256 = "c".repeat(64))), inlineImages = mapOf("https://example.invalid/figure.png" to "data:image/png;base64,AAAA"))
        fun id(a: Article) = ReadingSourceBinding.token(paper, a, receipt(), "workspace", 1, null)
        val before = id(original)
        assertNotEquals(before, id(original.copy(html = "<h1>Changed actual display under old original revision</h1>")))
        assertNotEquals(before, id(original.copy(resources = original.resources.map { it.copy(sha256 = "d".repeat(64)) })))
        assertNotEquals(before, id(original.copy(resources = original.resources.map { it.copy(localPath = null, missingReason = "missing") })))
        assertNotEquals(before, id(original.copy(inlineImages = mapOf("https://example.invalid/figure.png" to "data:image/png;base64,BBBB"))))
        assertEquals(before, id(original.copy(resources = original.resources.map { it.copy(localPath = "/relocated/same-original") })))
    }
    @Test fun privateRoleIdentityTracksOnlyTheExplicitlySelectedMaterials() {
        val original = JSONObject().put("notes", JSONObject().put(paper.id, JSONObject().put("text", "original").put("revision", 1)))
            .put("annotations", JSONObject().put(paper.id, JSONArray().put(JSONObject().put("id", "mark").put("text", "original"))))
            .put("sessions", JSONArray().put(JSONObject().put("id", "one").put("paperID", paper.id).put("answer", "original")).put(JSONObject().put("id", "two").put("paperID", "other").put("answer", "unrelated")))
        val options = JSONObject().put("includeNote", true).put("includeAnalysis", true)
        fun id(p: JSONObject, o: JSONObject = options) = ReadingSourceBinding.selectedRoleIdentity(p, paper.id, o)
        val expected = id(original)
        assertNotEquals(expected, id(original.copy().also { it.getJSONObject("notes").getJSONObject(paper.id).put("revision", 2) }))
        assertNotEquals(expected, id(original.copy().also { it.getJSONArray("sessions").getJSONObject(0).put("answer", "new answer") }))
        assertEquals(expected, id(original.copy().also { it.getJSONArray("sessions").getJSONObject(1).put("answer", "unrelated changed") }))
        assertEquals(id(original, JSONObject().put("includeNote", false).put("includeAnalysis", false)), id(JSONObject().put("notes", "invalid-unselected").put("annotations", "invalid-unselected").put("sessions", "invalid-unselected"), JSONObject().put("includeNote", false).put("includeAnalysis", false)))
        val reordered = JSONObject().put("sessions", original.get("sessions")).put("annotations", original.get("annotations")).put("notes", original.get("notes"))
        assertEquals(expected, id(reordered))
    }
    @Test fun pdfRequiresTheActualBytesAndMatchingSourceReceipt() {
        val original = receipt(); val hash = original.getString("sha256")
        ReadingSourceBinding.requirePDF(paper, original, hash)
        for (changed in listOf(original.copy().put("version", "2601.00001v1"), original.copy().put("sourceURL", "https://example.invalid/other"), original.copy().put("paperID", "another"), original.copy().put("sha256", "c".repeat(64)))) {
            assertTrue(runCatching { ReadingSourceBinding.requirePDF(paper, changed, hash) }.isFailure)
        }
        assertTrue(runCatching { ReadingSourceBinding.requirePDF(paper.copy(pdfSHA256 = "e".repeat(64)), original, hash) }.isFailure)
    }
}
