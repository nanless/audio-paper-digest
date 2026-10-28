package com.nanless.paperdigest.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SavedStudySourceTest {
    private fun session(kind: String = "pdf-range") = JSONObject()
        .put("id", "saved-study").put("paperID", "original-owner").put("inputSHA256", "b".repeat(64))
        .put("source", JSONObject().put("paperID", "original-owner").put("kind", kind)
            .put("pdfSHA", "a".repeat(64)).put("pages", JSONArray(listOf(2, 5)))
            .put("sourceVersion", "v1").put("sourceURL", "https://example.invalid/original.pdf")
            .put("extractor", "android-pdfbox-physical-pages-v1"))

    @Test fun allConcretePdfKindsExposeOnlyOriginalPagesWithoutMutatingSavedRecord() {
        for (kind in listOf("pdf-selection", "pdf-range", "pdf-document", "pdf-chapter", "page", "range", "chapter", "full", "pdf-page", "pdf-full")) {
            val original = session(kind).put("answer", "PDF page 99, current SHA must not be used")
            val before = original.toString()
            val binding = savedStudySource(original)!!
            assertEquals("saved-study", binding.sessionID)
            assertEquals("original-owner", binding.owner)
            assertEquals("a".repeat(64), binding.pdfSHA)
            assertEquals("b".repeat(64), binding.inputSHA)
            assertEquals(listOf(2, 5), binding.pages)
            assertFalse(1 in binding.pages)
            assertFalse(3 in binding.pages)
            assertFalse(99 in binding.pages)
            assertEquals(canonical(original.getJSONObject("source")), binding.sourceJSON)
            assertEquals(before, original.toString())
            original.getJSONObject("source").getJSONArray("pages").put(0, 7)
            assertEquals(listOf(2, 5), binding.pages)
        }
    }

    @Test fun rejectsUnknownNonPdfAndMissingSourceKindsEvenWhenAnswerClaimsPdf() {
        for (kind in listOf("published-guide", "pdf", "pdf-unmapped", "unknown", "", "configuration-check")) {
            assertNull(savedStudySource(session(kind).put("answer", "pdf-range pages 2,5")))
        }
        assertNull(savedStudySource(session().also { it.remove("source") }))
        assertNull(savedStudySource(session().also { it.getJSONObject("source").remove("kind") }))
    }

    @Test fun rejectsMissingOrMismatchedOwnerAndIdentity() {
        for (key in listOf("id", "paperID", "inputSHA256")) {
            assertNull(savedStudySource(session().also { it.remove(key) }))
            assertNull(savedStudySource(session().put(key, "")))
        }
        assertNull(savedStudySource(session().put("paperID", "another-owner")))
        assertNull(savedStudySource(session().also { it.getJSONObject("source").remove("paperID") }))
        assertNull(savedStudySource(session().also { it.getJSONObject("source").put("paperID", 123) }))
    }

    @Test fun rejectsMalformedOrMissingShaWithoutFallback() {
        for (sha in listOf("", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), "../original.pdf")) {
            assertNull(savedStudySource(session().also { it.getJSONObject("source").put("pdfSHA", sha) }))
            assertNull(savedStudySource(session().put("inputSHA256", sha)))
        }
        assertNull(savedStudySource(session().also { it.getJSONObject("source").remove("pdfSHA") }
            .put("pdfSHA", "c".repeat(64))))
    }

    @Test fun refusesEmptyDuplicateNonIntegerZeroNegativeAndOverflowPages() {
        for (pages in listOf(emptyList<Any>(), listOf(2, 2), listOf(0), listOf(-1), listOf("2"),
            listOf(2.0), listOf(2.5), listOf(true), listOf(JSONObject.NULL), listOf(Int.MAX_VALUE.toLong() + 1))) {
            assertNull(savedStudySource(session().also { it.getJSONObject("source").put("pages", JSONArray(pages)) }))
        }
        assertNull(savedStudySource(session().also { it.getJSONObject("source").remove("pages") }))
        assertNull(positiveStudySourcePage("2"))
        assertNull(positiveStudySourcePage(2.0))
        assertEquals(2, positiveStudySourcePage(2L))
    }

    @Test fun sourceCasIncludesStableFieldsAndInputButNotMutableAnswerOrFeeHistory() {
        val original = session()
        val binding = savedStudySource(original)!!
        assertEquals(binding, savedStudySource(original.copy().put("answer", "new text").put("status", "completed")
            .put("fees", JSONArray().put(123))))
        for (key in listOf("sourceVersion", "sourceURL", "extractor", "kind", "pdfSHA")) {
            val changed = original.copy()
            changed.getJSONObject("source").put(key, if (key == "pdfSHA") "c".repeat(64) else "changed")
            assertNotEquals(binding, savedStudySource(changed))
        }
        assertNotEquals(binding, savedStudySource(original.copy().put("inputSHA256", "c".repeat(64))))
        assertNotEquals(binding, savedStudySource(original.copy().also {
            it.getJSONObject("source").put("pages", JSONArray(listOf(2, 4)))
        }))
        assertEquals(binding, savedStudySource(JSONObject(original.toString())))
    }
}
