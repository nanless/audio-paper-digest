package com.nanless.paperdigest

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PdfImportBatchProgressTest {
    private fun actual(hash: String = "a".repeat(64)) = JSONObject().put("paperID", "local:$hash").put("sha256", hash).put("pageCount", 1)
    @Test fun unstartedSelectionsNeverBecomeCompletedAndSnapshotContainsNoUrisOrPasswords() {
        val p = PdfImportBatchProgress(3); p.begin(0, "native-child"); p.completed(0, actual())
        val result = p.snapshot("cancelled")
        assertEquals(1, result.getInt("completed")); assertEquals(2, result.getInt("notDispatched"))
        assertEquals("cancelled", p.finalStatus(true)); assertFalse(result.toString().contains("content://"))
        assertEquals("notDispatched", result.getJSONArray("items").getJSONObject(2).getString("status"))
    }
    @Test fun actualCommittedFactCannotBeChangedToCancelledOrToAnotherOriginal() {
        val p = PdfImportBatchProgress(1); p.begin(0, "child"); p.completed(0, actual()); p.completed(0, actual())
        assertTrue(runCatching { p.cancelled(0) }.isFailure)
        assertTrue(runCatching { p.completed(0, actual("b".repeat(64))) }.isFailure)
        assertEquals("completed", p.finalStatus(true)); assertEquals(1, p.snapshot("completed").getInt("completed"))
    }
    @Test fun aDefiniteInvalidItemAndLaterValidItemRemainDistinct() {
        val p = PdfImportBatchProgress(2); p.begin(0, "bad"); p.failed(0); p.begin(1, "good"); p.completed(1, actual())
        val r = p.snapshot(p.finalStatus(false)); assertEquals("failed", r.getString("status"))
        assertEquals(1, r.getInt("failed")); assertEquals(1, r.getInt("completed")); assertEquals(0, r.getInt("notDispatched"))
    }
    @Test fun runtimeFailureStopsTheRemainderAndCancellationCountsOnlyItsCurrentItem() {
        val failure = PdfImportBatchProgress(3); failure.begin(0, "first"); failure.failed(0)
        assertEquals("failed", failure.finalStatus(false)); assertEquals(2, failure.snapshot("failed").getInt("notDispatched"))
        val cancelled = PdfImportBatchProgress(3); cancelled.begin(0, "first"); cancelled.completed(0, actual()); cancelled.begin(1, "second"); cancelled.cancelled(1)
        val r = cancelled.snapshot(cancelled.finalStatus(true)); assertEquals(1, r.getInt("completed")); assertEquals(1, r.getInt("cancelled")); assertEquals(1, r.getInt("notDispatched"))
    }
    @Test fun returnedSnapshotsAndCallerJsonCannotRewriteAcceptedNativeFacts() {
        val p = PdfImportBatchProgress(1); val actual = actual(); p.begin(0, "child"); p.completed(0, actual)
        actual.put("paperID", "changed-caller"); val snapshot = p.snapshot("completed")
        snapshot.getJSONArray("items").getJSONObject(0).put("status", "cancelled")
        val fresh = p.snapshot("completed"); assertEquals("completed", fresh.getJSONArray("items").getJSONObject(0).getString("status"))
        assertEquals("local:" + "a".repeat(64), fresh.getJSONArray("items").getJSONObject(0).getString("paperID"))
    }
    @Test fun malformedCompletionCannotAcquireAValidOriginalFact() {
        val p = PdfImportBatchProgress(1); p.begin(0, "child")
        assertTrue(runCatching { p.completed(0, actual().put("paperID", "other")) }.isFailure)
        assertTrue(runCatching { p.completed(0, actual().put("pageCount", 0)) }.isFailure)
        assertEquals("running", p.status(0)); assertEquals(0, p.snapshot("running").getInt("completed"))
    }
}
