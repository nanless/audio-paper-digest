package com.nanless.paperdigest.data

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class StudyAnswerPositionTest {
    private fun session(id: String = "first") = JSONObject().put("id", id).put("paperID", "paper")
        .put("inputSHA256", "a".repeat(64)).put("responseSHA256", "b".repeat(64)).put("answer", "A saved public test answer")
        .put("source", JSONObject().put("paperID", "paper").put("kind", "pdf-selection").put("pdfSHA", "c".repeat(64)))
    private fun personal(reading: JSONObject) = JSONObject().put("readingState", JSONObject().put("paper", reading))

    @Test fun mergesOnlyOriginalRecordAndDoesNotMutateMaterials() {
        val original = session(); val originalBytes = original.toString()
        val reading = JSONObject().put("question", "preserved draft").put("guideScroll", 124)
        val first = mergedStudyAnswerScroll(reading, original, studyAnswerPositionIdentity(original)!!.binding, 987)
        val other = session("second")
        val both = mergedStudyAnswerScroll(first, other, studyAnswerPositionIdentity(other)!!.binding, 321)
        assertEquals(987, savedStudyAnswerScroll(personal(both), original))
        assertEquals(321, savedStudyAnswerScroll(personal(both), other))
        assertEquals("preserved draft", both.getString("question")); assertEquals(124, both.getInt("guideScroll"))
        assertFalse(reading.has("studyAnswerScroll")); assertEquals(originalBytes, original.toString())
    }

    @Test fun changedInputResponseAnswerOwnerOrSourceNeverBorrowsOldPosition() {
        val original = session(); val identity = studyAnswerPositionIdentity(original)!!
        val saved = personal(mergedStudyAnswerScroll(JSONObject(), original, identity.binding, 800))
        val variants = listOf(
            session().put("inputSHA256", "d".repeat(64)), session().put("responseSHA256", "e".repeat(64)),
            session().put("answer", "a different response under the same claimed response SHA"),
            session().put("paperID", "other"), session().apply { getJSONObject("source").put("kind", "pdf-range") }
        )
        variants.forEach { assertEquals(0, savedStudyAnswerScroll(saved, it)) }
        variants.filter { studyAnswerPositionIdentity(it) != null }.forEach {
            try { mergedStudyAnswerScroll(JSONObject(), it, identity.binding, 12); fail("stale response callback accepted") }
            catch (_: IllegalArgumentException) { }
        }
    }

    @Test fun missingInvalidOrNegativeSavedMetadataStartsAtZeroAndRejectsNegativeWrites() {
        val s = session(); val identity = studyAnswerPositionIdentity(s)!!
        assertEquals(0, savedStudyAnswerScroll(JSONObject(), s))
        for (bad in listOf<Any>(-1, "900", 4.5)) {
            val entry = JSONObject().put("binding", identity.binding).put("offset", bad)
            assertEquals(0, savedStudyAnswerScroll(personal(JSONObject().put("studyAnswerScroll", JSONObject().put("first", entry))), s))
        }
        try { mergedStudyAnswerScroll(JSONObject(), s, identity.binding, -1); fail("negative offset accepted") }
        catch (_: IllegalArgumentException) { }
        assertNull(studyAnswerPositionIdentity(session().put("id", "")))
        assertNull(studyAnswerPositionIdentity(session().apply { getJSONObject("source").put("paperID", "other") }))
    }
}
