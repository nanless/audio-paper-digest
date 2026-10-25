package com.nanless.paperdigest.review

import com.nanless.paperdigest.cloud.BackupCodec
import com.nanless.paperdigest.cloud.RequestContinuity
import com.nanless.paperdigest.data.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** Pre-fix review probes retained for the author repair; independent approval belongs to another reviewer. */
class PersonalStoreCapacityReviewTest {
    private fun exercise(replace: Boolean) {
        val root = Files.createTempDirectory("personal-capacity-review-").toRealPath().toFile()
        try {
            val store = PersonalStore(root); val noteText = "x".repeat(2_000_000)
            val baseline = store.snapshot(); val notes = baseline.getJSONObject("notes")
            repeat(16) { notes.put("fixture-note-$it", JSONObject().put("text", noteText).put("revision", 1)) }
            store.replaceValidated(baseline)
            val file = File(root, "personal.json"); assertTrue(file.length() < 32L * 1024 * 1024)
            val originalSHA = BackupCodec.hash(file); val originalBytes = file.length()
            val raw = File(root, "ModelUsage/opaque-original-response.bin"); JsonFiles.write(raw, "explicit synthetic opaque original response".toByteArray())
            val ledger = File(root, RequestContinuity.FILE); JsonFiles.write(ledger, RequestContinuity.json(listOf(RequestContinuity.Issued("synthetic-prior-request", "2026-01-01T00:00:00Z"))))
            val originalRaw = raw.readBytes(); val originalLedger = ledger.readBytes()
            val result = runCatching {
                if (replace) {
                    val candidate = store.snapshot(); candidate.getJSONObject("notes").put("new-note", JSONObject().put("text", noteText).put("revision", 1)); store.replaceValidated(candidate)
                } else store.saveNote("new-note", noteText, 0)
            }
            if (result.isSuccess) {
                // An old-source RED demonstrates actual unreopenability, not a
                // compiler error or a single note exceeding its own 2 MiB cap.
                val reopen = runCatching { PersonalStore(root) }
                fail("Normal legal notes wrote ${file.length()} bytes above 32 MiB; reopen failed=${reopen.isFailure}; must reject before committing")
            }
            assertEquals(originalBytes, file.length()); assertEquals(originalSHA, BackupCodec.hash(file)); assertEquals(0, store.note("new-note").getInt("revision")); assertEquals(noteText, store.note("fixture-note-0").getString("text"))
            assertArrayEquals(originalRaw, raw.readBytes()); assertArrayEquals(originalLedger, ledger.readBytes())
            val reopened = PersonalStore(root); assertEquals(0, reopened.note("new-note").getInt("revision")); assertEquals(noteText, reopened.note("fixture-note-15").getString("text")); assertArrayEquals(originalRaw, raw.readBytes()); assertArrayEquals(originalLedger, ledger.readBytes())
        } finally { root.deleteRecursively() }
    }
    @Test fun legalNoteMutationAboveReadableLimitRejectsWithoutDiskOrMemoryCommit() { exercise(replace = false) }
    @Test fun validReplacementAboveReadableLimitRejectsWithoutDiskOrMemoryCommit() { exercise(replace = true) }

    @Test fun ownLegalWriteNearLimitCannotCreateAnUnreopenableRunningRecord() {
        val root = Files.createTempDirectory("personal-startup-capacity-review-").toRealPath().toFile()
        try {
            val store = PersonalStore(root); val file = File(root, "personal.json"); val original = file.readBytes()
            val candidate = store.snapshot()
            candidate.getJSONArray("jobs").put(JSONObject().put("id", java.util.UUID.randomUUID().toString()).put("kind", "synthetic").put("status", "running"))
            candidate.put("syntheticPadding", "")
            val padding = "x".repeat((32L * 1024 * 1024 - candidate.toString().toByteArray(Charsets.UTF_8).size).toInt())
            candidate.put("syntheticPadding", padding)
            assertEquals(32L * 1024 * 1024, candidate.toString().toByteArray(Charsets.UTF_8).size.toLong())
            val written = runCatching { store.replaceValidated(candidate) }
            if (written.isSuccess) {
                // Either reject prospectively before committing, or reopen the
                // full original without trimming it to fit startup messages.
                val reopened = PersonalStore(root)
                assertEquals(padding, reopened.snapshot().getString("syntheticPadding"))
                assertNotEquals("running", reopened.snapshot().getJSONArray("jobs").getJSONObject(0).getString("status"))
            } else {
                assertTrue(written.exceptionOrNull() is AppFailure)
                assertArrayEquals(original, file.readBytes())
                assertFalse(store.snapshot().has("syntheticPadding"))
                assertFalse(PersonalStore(root).snapshot().has("syntheticPadding"))
            }
        } finally { root.deleteRecursively() }
    }

    @Test fun importedNearLimitOriginalCanBeReadWithoutStartupRewritingAndWarningClearsAfterReduction() {
        val root = Files.createTempDirectory("personal-imported-capacity-review-").toRealPath().toFile()
        try {
            val candidate = PersonalStore.initial()
            candidate.getJSONArray("jobs").put(JSONObject().put("id", java.util.UUID.randomUUID().toString()).put("kind", "synthetic").put("status", "running"))
            candidate.getJSONArray("sessions").put(JSONObject().put("id", java.util.UUID.randomUUID().toString()).put("status", "pending").put("answer", "Original response stays intact").put("requestIssued", true))
            candidate.put("syntheticPadding", "")
            val padding = "x".repeat((32L * 1024 * 1024 - candidate.toString().toByteArray(Charsets.UTF_8).size).toInt())
            candidate.put("syntheticPadding", padding)
            val file = File(root, "personal.json"); JsonFiles.write(file, candidate)
            assertEquals(32L * 1024 * 1024, file.length()); val originalSHA = BackupCodec.hash(file)
            val raw = File(root, "ModelUsage/opaque-original-response.bin"); JsonFiles.write(raw, "synthetic unchanged response".toByteArray())
            val ledger = File(root, RequestContinuity.FILE); JsonFiles.write(ledger, RequestContinuity.json(listOf(RequestContinuity.Issued("synthetic-request", "2026-01-01T00:00:00Z"))))
            val rawBytes = raw.readBytes(); val ledgerBytes = ledger.readBytes()
            val store = PersonalStore(root)
            assertNotNull(store.startupPersistenceWarning)
            assertEquals(originalSHA, BackupCodec.hash(file))
            val projected = store.snapshot()
            assertEquals(padding, projected.getString("syntheticPadding"))
            assertEquals("interrupted", projected.getJSONArray("jobs").getJSONObject(0).getString("status"))
            assertEquals("interrupted", projected.getJSONArray("sessions").getJSONObject(0).getString("status"))
            assertEquals("Original response stays intact", projected.getJSONArray("sessions").getJSONObject(0).getString("answer"))
            store.replaceValidated(projected.put("syntheticPadding", "User explicitly shortened synthetic data"))
            assertNull(store.startupPersistenceWarning)
            val reopened = PersonalStore(root)
            assertEquals("User explicitly shortened synthetic data", reopened.snapshot().getString("syntheticPadding"))
            assertEquals("Original response stays intact", reopened.snapshot().getJSONArray("sessions").getJSONObject(0).getString("answer"))
            assertNull(reopened.startupPersistenceWarning)
            assertArrayEquals(rawBytes, raw.readBytes()); assertArrayEquals(ledgerBytes, ledger.readBytes())
        } finally { root.deleteRecursively() }
    }

    @Test fun exactUtf8StartupReservationAcceptsTheTrueBoundaryWithoutDroppingUnknownFields() {
        val root = Files.createTempDirectory("personal-exact-startup-capacity-").toRealPath().toFile()
        try {
            val store = PersonalStore(root); val candidate = store.snapshot()
            candidate.getJSONArray("jobs").put(JSONObject().put("id", "synthetic-job").put("status", "queued").put("message", "旧🙂"))
            candidate.getJSONArray("sessions").put(JSONObject().put("id", "synthetic-session").put("status", "pending").put("charge", "uncertain").put("error", "原é").put("answer", "Original answer"))
            candidate.put("syntheticPadding", "")
            val projected = candidate.copy()
            projected.getJSONArray("jobs").getJSONObject(0).put("status", "interrupted").put("message", "上次运行中断；请核对保存结果。付费分析不会自动重发。")
            projected.getJSONArray("sessions").getJSONObject(0).put("status", "interrupted").put("charge", "unknown").put("error", "请求可能已经产生费用，不会自动重发")
            val projectedBytes = projected.toString().toByteArray(Charsets.UTF_8).size
            val padding = "x".repeat((32L * 1024 * 1024 - projectedBytes).toInt())
            store.replaceValidated(candidate.put("syntheticPadding", padding))
            val reopened = PersonalStore(root)
            assertEquals(32L * 1024 * 1024, File(root, "personal.json").length())
            assertEquals(padding, reopened.snapshot().getString("syntheticPadding"))
            assertEquals("Original answer", reopened.snapshot().getJSONArray("sessions").getJSONObject(0).getString("answer"))
            assertNull(reopened.startupPersistenceWarning)
        } finally { root.deleteRecursively() }
    }

    @Test fun startupWithoutRetiringRecordsPreservesExactExistingJsonBytes() {
        val root = Files.createTempDirectory("personal-read-only-startup-").toRealPath().toFile()
        try {
            val value = PersonalStore.initial().put("unknownOriginal", JSONObject().put("fact", "original"))
            val file = File(root, "personal.json"); val bytes = (value.toString(2) + "\n").toByteArray(Charsets.UTF_8)
            JsonFiles.write(file, bytes)
            val store = PersonalStore(root)
            assertEquals("original", store.snapshot().getJSONObject("unknownOriginal").getString("fact"))
            assertNull(store.startupPersistenceWarning)
            assertArrayEquals(bytes, file.readBytes())
            PersonalStore(root)
            assertArrayEquals(bytes, file.readBytes())
        } finally { root.deleteRecursively() }
    }
}
