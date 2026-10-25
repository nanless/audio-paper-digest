package com.nanless.paperdigest

import com.nanless.paperdigest.cloud.BackupCodec
import com.nanless.paperdigest.data.*
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.util.UUID

/** Actual backend and control records in temporary synthetic data; no Android/SAF authorization. */
class RetainedExportAccessTest {
    private class Fixture {
        val root = Files.createTempDirectory("retained-root-access-").toRealPath().toFile()
        val research = File(root, "Research").apply { mkdir() }
        val controls = File(root, "Pending")
        val device = File(root, "Device")
        val pending = PendingExportStore(File(root, "Exports"), controls)
        var epoch = "native-original-epoch"
        val row: PendingExportStore.PendingExport
        val capture: BackupCodec.Captured
        val beforePersonal: ByteArray
        init {
            beforePersonal = JSONObject().put("schema", 1).put("settings", JSONObject()).put("notes", JSONObject())
                .put("favorites", JSONArray()).put("reading", JSONArray()).put("readingState", JSONObject())
                .put("annotations", JSONObject()).put("sessions", JSONArray()).put("jobs", JSONArray()).toString().toByteArray()
            File(research, "personal.json").writeBytes(beforePersonal)
            row = pending.begin(UUID.randomUUID().toString(), "backup", JSONObject().put("format", "backup").put("workspaceEpoch", epoch))
            capture = BackupCodec.capture(research, pending.preparationFile(row.operationID))
            ExportProducerReceipt(File(controls, row.operationID), row.operationID, row.documentID, row.sourceIdentity)
                .recordVerifiedCapture(capture, "application/octet-stream", "synthetic-original.paperdigest")
            pending.reconcile()
        }
        val service by lazy { RetainedExportService(pending, controls, research, device, { require(java.net.URI(it).authority == "synthetic.documents") }) }
        fun access() = RetainedExportAccess({ pending }, { service }, controls) { epoch }
        fun retained(access: RetainedExportAccess) {
            access.retain(access.confirmation(row.operationID).getString("confirmationID"))
        }
        fun close() { assertArrayEquals(beforePersonal, File(research, "personal.json").readBytes()); root.deleteRecursively() }
    }
    @Test fun confirmIsSingleUseAndDoesNotRewriteOriginalPaidHistoryOrCapture() {
        val f = Fixture(); try {
            val access = f.access(); val confirm = access.confirmation(f.row.operationID)
            val original = f.pending.get(f.row.operationID)
            val retained = access.retain(confirm.getString("confirmationID"))
            assertEquals("retained", retained.preparation); assertEquals(original.jobID, retained.jobID)
            assertEquals(original.documentID, retained.documentID); assertEquals(canonical(original.sourceIdentity), canonical(retained.sourceIdentity))
            assertEquals(f.capture.sha256, BackupCodec.hash(f.capture.file))
            assertTrue(runCatching { access.retain(confirm.getString("confirmationID")) }.isFailure)
        } finally { f.close() }
    }
    @Test fun oldEpochConfirmationAndOldChooserCannotActOnNewWorkspace() {
        val f = Fixture(); try {
            val access = f.access(); val confirm = access.confirmation(f.row.operationID)
            f.epoch = "native-new-epoch"
            assertTrue(runCatching { access.retain(confirm.getString("confirmationID")) }.isFailure)
            assertEquals("interrupted", f.pending.get(f.row.operationID).preparation)
            f.retained(access); val chooser = access.prepare(f.row.operationID) {}
            f.epoch = "native-third-epoch"
            assertTrue(runCatching { access.lease(f.row.operationID, chooser.getString("attemptID")) }.isFailure)
            assertTrue(runCatching { access.cancelChooser(f.row.operationID, chooser.getString("attemptID")) }.isFailure)
        } finally { f.close() }
    }
    @Test fun revisionChangeRejectsPriorNativeConfirmationWithoutRetargeting() {
        val f = Fixture(); try {
            val access = f.access(); val confirm = access.confirmation(f.row.operationID)
            f.pending.phase(f.row.operationID, "verifying")
            assertTrue(runCatching { access.retain(confirm.getString("confirmationID")) }.isFailure)
            assertNotEquals("retained", f.pending.get(f.row.operationID).preparation)
            assertEquals(f.capture.sha256, BackupCodec.hash(f.capture.file))
        } finally { f.close() }
    }
    @Test fun coldPresentationIdsCannotRecoverTypedLeaseAndExplicitInspectionKeepsOriginalDocument() {
        val f = Fixture(); try {
            val first = f.access(); f.retained(first); val chooser = first.prepare(f.row.operationID) {}
            assertEquals(f.row.documentID, chooser.getString("documentID")); assertEquals(f.capture.sha256, chooser.getString("sha256"))
            assertEquals("retained", chooser.getString("exportRoute")); assertFalse(chooser.has("path"))
            val cold = f.access()
            assertTrue(runCatching { cold.lease(f.row.operationID, chooser.getString("attemptID")) }.isFailure)
            first.cancelChooser(f.row.operationID, chooser.getString("attemptID"))
            val again = cold.prepare(f.row.operationID) {}
            assertEquals(f.row.documentID, again.getString("documentID")); assertEquals(f.capture.sha256, again.getString("sha256"))
            assertNotEquals(chooser.getString("attemptID"), again.getString("attemptID"))
        } finally { f.close() }
    }
    @Test fun writerClaimIsOnceAndOnlyActualNativeDeliveryCanCreateIndependentProof() = runBlocking {
        val f = Fixture(); try {
            val access = f.access(); f.retained(access); val chooser = access.prepare(f.row.operationID) {}
            val attempt = chooser.getString("attemptID"); val id = UUID.randomUUID().toString()
            val lease = access.claimWriter(f.row.operationID, attempt, id)
            assertTrue(runCatching { access.claimWriter(f.row.operationID, attempt, UUID.randomUUID().toString()) }.isFailure)
            assertTrue(runCatching { access.cancelChooser(f.row.operationID, attempt) }.isFailure)
            val output = ByteArrayOutputStream()
            val result = f.service.save(lease.delivery, "content://synthetic.documents/original", { output }) { _, sha, bytes ->
                assertEquals(bytes, output.size().toLong()); assertEquals(sha, BackupCodec.hash(output.toByteArray()))
            }
            assertTrue(result.getBoolean("readbackProven")); assertFalse(result.getBoolean("cleanupEligible"))
            assertArrayEquals(f.capture.file.readBytes(), output.toByteArray())
            access.release(attempt); assertTrue(runCatching { access.lease(f.row.operationID, attempt) }.isFailure)
        } finally { f.close() }
    }
    @Test fun laterControlJobIsNotInsertedIntoOriginalPersonalAndColdRunningIsInterrupted() {
        val f = Fixture(); try {
            val access = f.access(); f.retained(access); val id = UUID.randomUUID().toString()
            val job = JSONObject().put("id", id).put("kind", "export.retained.prepare").put("paperID", "")
                .put("status", "running").put("createdAt", now()).put("startedAt", now())
            access.writeJob(f.row.operationID, job)
            assertEquals("running", access.readJobs(f.pending.get(f.row.operationID), setOf(id)).single().getString("status"))
            val cold = f.access().readJobs(f.pending.get(f.row.operationID), emptySet()).single()
            assertEquals("interrupted", cold.getString("status")); assertTrue(cold.getBoolean("localRetainedExport"))
            assertEquals(0, JSONObject(String(f.beforePersonal)).getJSONArray("jobs").length())
            assertEquals(f.capture.sha256, BackupCodec.hash(f.capture.file))
        } finally { f.close() }
    }
    @Test fun retiringRootPermissionsAlsoEndsBackendChooserSoExplicitPreparationCanResume() {
        val f = Fixture(); try {
            val access = f.access(); f.retained(access); val old = access.prepare(f.row.operationID) {}
            access.retireAll()
            assertTrue(runCatching { access.lease(f.row.operationID, old.getString("attemptID")) }.isFailure)
            val next = access.prepare(f.row.operationID) {}
            assertNotEquals(old.getString("attemptID"), next.getString("attemptID"))
            assertEquals(old.getString("documentID"), next.getString("documentID"))
            assertEquals(f.capture.sha256, next.getString("sha256"))
        } finally { f.close() }
    }

}
