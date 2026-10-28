package com.nanless.paperdigest.data

import com.nanless.paperdigest.cloud.BackupCodec
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.util.Base64
import java.util.UUID

/** Synthetic legacy archives only: no device, account, real key or network access. */
class LocalIntegrityExportBoundaryTest {
    private val secretPaths = listOf("ModelUsage/response-integrity.key", "ModelUsage/response-integrity.android.key")
    private fun personal() = JSONObject().put("schema", 1).put("notes", JSONObject()).put("settings", JSONObject())
        .put("favorites", JSONArray()).put("reading", JSONArray()).put("readingState", JSONObject())
        .put("annotations", JSONObject()).put("sessions", JSONArray()).put("jobs", JSONArray())
    private fun archive(secret: String? = null, contractLast: Boolean = false): ByteArray {
        val contents = linkedMapOf("personal.json" to personal().toString().toByteArray(),
            "ModelUsage/ordinary.key" to "portable non-integrity fixture".toByteArray())
        secret?.let { contents[it] = "SYNTHETIC-ONLY-NOT-A-DEVICE-SECRET".toByteArray() }
        val files = JSONArray(contents.map { (path, bytes) -> JSONObject().put("path", path)
            .put("sha256", BackupCodec.hash(bytes)).put("data", Base64.getEncoder().encodeToString(bytes)) })
        // Explicit order and escaped root key exercise recognition without depending on JSONObject order.
        return if (contractLast) ("{\"files\":$files,\"sourceDirectory\":\"/synthetic/Research\",\"contr\\u0061ct\":\"paperdigest-backup-v2\"}").toByteArray()
        else JSONObject().put("contract", "paperdigest-backup-v2").put("sourceDirectory", "/synthetic/Research").put("files", files).toString().toByteArray()
    }
    private fun temp(body: (File) -> Unit) {
        val root = Files.createTempDirectory("local-integrity-export-").toRealPath().toFile()
        try { body(root) } finally { root.deleteRecursively() }
    }
    private fun snapshot(root: File) = root.walkTopDown().filter { it.isFile }
        .associate { it.relativeTo(root).invariantSeparatorsPath to it.readBytes().toList() }
    private fun receipt(directory: File, row: PendingExportStore.PendingExport, raw: ByteArray, count: Int) {
        File(directory, "capture.tmp").writeBytes(raw)
        File(directory, "producer-complete.json").writeText(JSONObject().put("contract", "paperdigest-export-producer-v1")
            .put("producer", "normal-backup-codec-capture-returned").put("operationID", row.operationID)
            .put("documentID", row.documentID).put("sourceIdentity", row.sourceIdentity)
            .put("mime", "application/octet-stream").put("suggestedName", "legacy.paperdigest")
            .put("bytes", raw.size).put("sha256", BackupCodec.hash(raw)).put("fileCount", count).toString())
    }
    private fun producer(directory: File, row: PendingExportStore.PendingExport, raw: ByteArray, count: Int): ExportProducerReceipt {
        receipt(directory, row, raw, count)
        return ExportProducerReceipt(directory, row.operationID, row.documentID, row.sourceIdentity)
    }
    private fun oldReady(root: File, raw: ByteArray, choosing: Boolean = false): Pair<PendingExportStore, PendingExportStore.PendingExport> {
        val exports = File(root, "Exports"); val controls = File(root, "Pending")
        val store = PendingExportStore(exports, controls, { "2026-01-01T00:00:00Z" })
        val row = store.begin(UUID.randomUUID().toString(), "backup", JSONObject().put("format", "backup"))
        val manifest = JSONObject().put("documentID", row.documentID).put("mime", "application/octet-stream")
            .put("suggestedName", "legacy.paperdigest").put("bytes", raw.size).put("sha256", BackupCodec.hash(raw)).toString().toByteArray()
        File(exports, "${row.documentID}.bin").writeBytes(raw)
        File(exports, "${row.documentID}.json").writeBytes(manifest)
        val directory = File(controls, row.operationID)
        File(directory, "manifest.original.json").writeBytes(manifest)
        val operation = File(directory, "operation.json")
        val value = JSONObject(operation.readText()).put("preparation", "ready").put("phase", "ready")
            .put("manifestSHA256", BackupCodec.hash(manifest))
        if (choosing) value.put("delivery", "choosing").put("attemptID", UUID.randomUUID().toString())
        operation.writeText(value.toString())
        return store to row
    }

    @Test fun legacyProducerSecretsCannotBeReusedAndRetainedNeverGetsOutputAuthority() {
        for (path in secretPaths) temp { root ->
            val store = PendingExportStore(File(root, "Exports"), File(root, "Pending"))
            val row = store.begin(UUID.randomUUID().toString(), "backup", JSONObject().put("format", "backup"))
            val directory = File(root, "Pending/${row.operationID}")
            val p = producer(directory, row, archive(path), 3)
            store.reconcile(); store.retainPreparation(row.operationID, store.preparationRevision(row.operationID))
            val research = File(root, "Research").apply { mkdir() }; val device = File(root, "Device").apply { mkdir() }
            val service = RetainedExportService(store, File(root, "Pending"), research, device, {})
            val before = snapshot(root); val output = ByteArrayOutputStream(); var opens = 0
            assertTrue(runCatching { p.verifiedCapture() }.isFailure)
            runBlocking {
                assertTrue(runCatching {
                    val delivery = service.beginDelivery(service.prepareSnapshot(row.operationID))
                    service.save(delivery, "content://synthetic.documents/file", { opens++; output }) { _, _, _ -> }
                }.isFailure)
            }
            assertEquals(0, opens); assertEquals(0, output.size()); assertEquals(before, snapshot(root))
        }
    }
    @Test fun oldPendingSecretArchivesFailBeforeChooserAndWritingClaimsWithoutAnyStateChange() {
        for (path in secretPaths) for (choosing in listOf(false, true)) temp { root ->
            val (store, row) = oldReady(root, archive(path, contractLast = true), choosing)
            val before = snapshot(root); val output = ByteArrayOutputStream(); var opens = 0
            assertEquals("unavailable", store.get(row.operationID).preparation)
            assertTrue(runCatching { store.deliverySource(row.operationID) }.isFailure)
            assertEquals("unavailable", store.reconcile().single().preparation)
            assertEquals(before, snapshot(root))
            assertTrue(runCatching {
                val attempt = if (choosing) JSONObject(File(root, "Pending/${row.operationID}/operation.json").readText()).getString("attemptID")
                    else store.beginDelivery(row.operationID).attemptID!!
                val artifact = store.startWriting(row.operationID, attempt)
                opens++; artifact.file.inputStream().use { it.copyTo(output) }
            }.isFailure)
            assertEquals(0, opens); assertEquals(0, output.size()); assertEquals(before, snapshot(root))
        }
    }
    @Test fun normalLegacyArchivePassesProducerPendingAndPreservesExactBytesAndIDs() = temp { root ->
        val raw = archive(contractLast = true); val (store, row) = oldReady(root, raw)
        val directory = File(root, "Pending/${row.operationID}")
        val p = producer(directory, row, raw, 2)
        assertArrayEquals(raw, p.verifiedCapture().file.readBytes())
        val choice = store.beginDelivery(row.operationID)
        val artifact = store.startWriting(row.operationID, choice.attemptID!!)
        assertEquals(row.documentID, artifact.documentID); assertArrayEquals(raw, artifact.file.readBytes())
        assertArrayEquals(raw, File(directory, "capture.tmp").readBytes())
        assertEquals(BackupCodec.hash(raw), artifact.sha256)
    }
    @Test fun genericKeyTextAndNestedBackupContractAreNotFullBackupInventory() = temp { root ->
        for ((index, text) in listOf("%PDF-1.7 ModelUsage/response-integrity.key",
            "<html>paperdigest-backup-v2 ModelUsage/response-integrity.android.key</html>",
            "{\"contract\":\"research\",\"nested\":{\"contract\":\"paperdigest-backup-v2\"},\"text\":\"ModelUsage/response-integrity.key\"}").withIndex()) {
            val file = File(root, "generic-$index").apply { writeText(text) }
            ExportProducerReceipt.validatePortableBackup(file, root)
            assertEquals(text, file.readText())
        }
    }
    @Test fun rawRetainedArchiveWithoutProducerReceiptStillCannotBeSaved() = temp { root ->
        val store = PendingExportStore(File(root, "Exports"), File(root, "Pending"))
        val row = store.begin(UUID.randomUUID().toString(), "backup", JSONObject().put("format", "backup"))
        store.preparationFile(row.operationID).writeBytes(archive(secretPaths.first()))
        store.reconcile(); store.retainPreparation(row.operationID, store.preparationRevision(row.operationID))
        val service = RetainedExportService(store, File(root, "Pending"), File(root, "Research"), File(root, "Device"), {})
        val before = snapshot(root)
        assertTrue(runCatching { service.prepareSnapshot(row.operationID) }.isFailure)
        assertEquals(before, snapshot(root))
    }
    @Test fun onlyReservedIntegritySlotsRejectDescendantFilesIncludingCaseAliases() = temp { root ->
        for (path in secretPaths.flatMap { listOf(it, it.uppercase(java.util.Locale.ROOT)) }) {
            assertTrue(runCatching { BackupCodec.stage(archive("$path/child").inputStream(), root) }.isFailure)
        }
        val ordinary = BackupCodec.stage(archive("ModelUsage/other.key/child").inputStream(), root)
        try {
            assertTrue(ordinary.entries.any { it.path == "ModelUsage/other.key/child" })
            BackupCodec.requirePortableInventory(ordinary.entries)
        } finally { ordinary.directory.deleteRecursively() }
    }
    @Test fun onlyTwoLogicalLocalSecretPathsIncludingCaseAliasesAreForbidden() {
        for (path in secretPaths) {
            assertTrue(BackupCodec.isLocalOnlyIntegrityPath(path.uppercase(java.util.Locale.ROOT)))
            assertTrue(runCatching { BackupCodec.requirePortableInventory(listOf(BackupCodec.Entry(path.uppercase(java.util.Locale.ROOT), "a".repeat(64), 4))) }.exceptionOrNull() is BackupCodec.NonPortableArchiveException)
        }
        for (path in listOf("ModelUsage/ordinary.key", "nested/response-integrity.key", ".hidden", "ModelUsage/response-integrity.key.notes"))
            assertFalse(BackupCodec.isLocalOnlyIntegrityPath(path))
    }
    @Test fun legacyDecoderRemainsReadableButOutboundRejectsActualSecretInventory() = temp { root ->
        val file = File(root, "legacy.paperdigest").apply { writeBytes(archive(secretPaths.first(), true)) }
        val stage = BackupCodec.stage(file.inputStream(), root)
        try { assertTrue(stage.entries.any { it.path == secretPaths.first() }) } finally { stage.directory.deleteRecursively() }
        val before = snapshot(root)
        assertTrue(runCatching { ExportProducerReceipt.validatePortableBackup(file, root) }.isFailure)
        assertEquals(before, snapshot(root))
    }
}
