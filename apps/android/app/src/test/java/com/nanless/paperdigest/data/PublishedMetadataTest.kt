package com.nanless.paperdigest.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PublishedMetadataTest {
    private fun paper() = Paper("arxiv:2610.27491", "Original scientific title", "中文导读标题", listOf("Catalog Author"), "2026-10-24", sourceKind = "arxiv", identityStatus = "verified", blogURL = "https://nanless.github.io/audio-paper-digest-blog/posts/original/", sourceURL = "https://arxiv.org/abs/2610.27491v1", pdfURL = "https://arxiv.org/pdf/2610.27491v1.pdf", sourceVersion = "2610.27491v1")
    private fun sidecar() = JSONObject().put("contract", "researcher-sidecars-v1").put("arxivId", "2610.27491").put("id", "2610.27491v1").put("arxivVersionedId", "2610.27491v1").put("absUrl", "https://arxiv.org/abs/2610.27491v1").put("pdfUrl", "https://arxiv.org/pdf/2610.27491v1.pdf").put("originalTitle", "Original scientific title").put("authors", JSONArray().put(JSONObject().put("name", "Original Author").put("affiliations", JSONArray(listOf("Original institution")))))
    @Test fun unknownPublicationDateNeverUsesTheBlogDate() {
        val actual = ExportService.citationPaper(paper(), null)
        assertEquals("", actual.date); assertNotEquals(paper().date, actual.date)
    }
    @Test fun actualSidecarPreservesOriginalTitleAuthorsAndPublicationDate() {
        val p = paper(); val source = sidecar().put("date", "2026-10-20")
        val a = Article(p.id, "", "original text", p.sourceURL!!, p.blogURL, "a".repeat(64), "2026-10-24T00:00:00Z", sourceVersion = p.sourceVersion, citation = p.citation, pdfURL = p.pdfURL,
            original = JSONObject().put("citationSidecar", source))
        val actual = ExportService.citationPaper(p, a)
        assertEquals("Original scientific title", actual.title); assertEquals(listOf("Original Author"), actual.authors); assertEquals("2026-10-20", actual.date)
        assertTrue(actual.citation.getJSONArray("authors").getJSONObject(0).getJSONArray("affiliations").getString(0).contains("institution"))
    }
    @Test fun sidecarsNeedTheirRealContractOwnerVersionAndSource() {
        val p = paper()
        CatalogRepository.validatedSidecar(sidecar(), p, false)
        listOf(sidecar().put("contract", "unknown-v9"), sidecar().put("arxivId", "2610.00001"), sidecar().put("arxivVersionedId", "2610.27491v2"), sidecar().put("absUrl", "https://arxiv.org/abs/2610.27491v2")).forEach { wrong -> assertThrows(IllegalArgumentException::class.java) { CatalogRepository.validatedSidecar(wrong, p, true) } }
        val conference = p.copy(id = "conference:fixture:2026:1", sourceKind = "conference", sourceVersion = null)
        assertThrows(IllegalArgumentException::class.java) { CatalogRepository.validatedSidecar(sidecar(), conference, false) }
    }
    @Test fun actualFractionsAreNeverFlattenedIntoAdjacentDigits() {
        val body = org.jsoup.Jsoup.parseBodyFragment("<p>Ratio <math><mfrac><mn>1</mn><mn>2</mn></mfrac></math></p><span class='katex'><math><semantics><mi>x</mi><annotation encoding='application/x-tex'>x^2</annotation></semantics></math><span class='katex-html'>duplicate visual</span></span>").body()
        val actual = CatalogRepository.articlePlainText(body)
        assertTrue(actual.contains("<mfrac>")); assertTrue(actual.contains("[公式 TeX：x^2]")); assertFalse(actual.contains("duplicate visual"))
    }
}
