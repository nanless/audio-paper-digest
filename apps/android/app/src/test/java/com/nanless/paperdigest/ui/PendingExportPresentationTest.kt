package com.nanless.paperdigest.ui

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PendingExportPresentationTest {
    private fun row(id: String, time: Any? = null) = JSONObject().put("operationID", id).apply { if (time != null) put("createdAt", time) }
    @Test fun nullMissingOrWrongTypeAreNotStringifiedAsMessages() {
        assertNull(pendingExportMessage(JSONObject()))
        assertNull(pendingExportMessage(JSONObject().put("message", JSONObject.NULL)))
        assertNull(pendingExportMessage(JSONObject().put("message", 0)))
        assertNull(pendingExportMessage(JSONObject().put("message", JSONObject())))
        assertNull(pendingExportMessage(JSONObject().put("message", " \n\t")))
        assertEquals(" 原件保留 ", pendingExportMessage(JSONObject().put("message", " 原件保留 ")))
        assertEquals("null", pendingExportMessage(JSONObject().put("message", "null"))) // A genuine string stays verbatim.
    }
    @Test fun actualInstantsRatherThanLexicalDateSpellingDetermineNewness() {
        val a = row("older", "2026-10-25T10:00:00Z")
        val b = row("newer", "2026-10-25T11:00:00Z")
        val c = row("offset-older", "2026-10-25T18:30:00+08:00")
        assertEquals(listOf("newer", "offset-older", "older"), pendingExportsNewest(listOf(a, b, c)).map { it.getString("operationID") })
    }
    @Test fun missingMalformedOrWrongTypeTimeNeverDropsRecordsAndRemainsStableAfterKnownTimes() {
        val rows = listOf(row("missing"), row("bad", "not-a-date"), row("number", 42), row("known", "2026-10-25T10:00:00Z"))
        assertEquals(listOf("known", "missing", "bad", "number"), pendingExportsNewest(rows).map { it.getString("operationID") })
    }
    @Test fun equalInstantsKeepOriginalOrderAndEveryOriginalObjectAndLeaseArePreserved() {
        val a = row("A", "2026-10-25T10:00:00Z").put("attemptID", "original-attempt-A").put("documentID", "original-document-A")
        val b = row("B", "2026-10-25T18:00:00+08:00").put("attemptID", "original-attempt-B")
        val source = listOf(a, b); val before = source.map { it.toString() }; val ordered = pendingExportsNewest(source)
        assertSame(a, ordered[0]); assertSame(b, ordered[1]); assertEquals(before, source.map { it.toString() })
        assertEquals("original-attempt-A", ordered[0].getString("attemptID"))
    }
    @Test fun oldOperationDoesNotJumpAheadWhenItsLaterReadbackUpdatesStatus() {
        val old = row("old", "2026-10-25T10:00:00Z").put("updatedAt", "2026-10-26T10:00:00Z").put("preparation", "ready")
        val current = row("current", "2026-10-25T10:20:00Z").put("preparation", "ready")
        assertSame(current, pendingExportsNewest(listOf(old, current)).first())
        assertEquals("2026-10-25T10:00:00Z", old.getString("createdAt"))
    }
}
