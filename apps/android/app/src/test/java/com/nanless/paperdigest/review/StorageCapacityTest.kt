package com.nanless.paperdigest.review

import com.nanless.paperdigest.cloud.BackupCodec
import com.nanless.paperdigest.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.time.Instant
import java.util.UUID

/** Author regressions; native URI verifier is injected, never a real provider or user directory. */
class StorageCapacityTest {
    private class Fixture(private val remover: (File) -> Boolean = { it.delete() }) {
        val root = Files.createTempDirectory("storage-capacity-author-").toRealPath().toFile()
        val research = File(root, "Research").apply { mkdir() }; val exports = File(root, "Exports").apply { mkdir() }
        val cloud = File(root, "Cloud").apply { mkdir() }; val device = File(root, "Device").apply { mkdir() }
        var time = Instant.parse("2026-01-01T00:00:00Z"); var verifies = 0; var hook: (() -> Unit)? = null
        val destinations = HashMap<String, ByteArray>()
        val service = StorageCapacity(research, exports, cloud, device, { time.toString() }, { 987654L }, remover)
        val verifier: ExportDestinationVerifier = { uri, sha, bytes -> verifies++; val actual = destinations[uri] ?: error("Synthetic destination missing"); require(actual.size.toLong() == bytes && sha256(actual) == sha); hook?.invoke() }
        init {
            JsonFiles.write(File(research, "personal.json"), PersonalStore.initial())
            JsonFiles.write(File(research, "ModelUsage/opaque-original.bin"), "opaque original response".toByteArray())
            JsonFiles.write(File(research, "Offline/protected-scientific.dat"), "scientific original".toByteArray())
            JsonFiles.write(File(research, ".hidden-original"), byteArrayOf(0, 1, -1))
        }
        data class Export(val id: String, val bin: File, val metadata: File, val uri: String, val bytes: ByteArray)
        fun export(text: String = "Synthetic complete research snapshot"): Export {
            val id = UUID.randomUUID().toString(); val bytes = text.toByteArray(); val bin = File(exports, "$id.bin"); val meta = File(exports, "$id.json"); val uri = "content://synthetic-provider/document/$id"
            JsonFiles.write(bin, bytes); JsonFiles.write(meta, JSONObject().put("documentID", id).put("mime", "application/octet-stream").put("suggestedName", "synthetic.paperdigest").put("bytes", bytes.size).put("sha256", sha256(bytes)))
            destinations[uri] = bytes.copyOf(); return Export(id, bin, meta, uri, bytes)
        }
        fun researchBytes() = research.walkTopDown().filter { it.isFile && !it.relativeTo(research).invariantSeparatorsPath.startsWith("ExportHistory/") }.associate { it.relativeTo(research).invariantSeparatorsPath to it.readBytes() }
        fun unchanged(original: Map<String, ByteArray>) { original.forEach { (path, bytes) -> assertArrayEquals(bytes, File(research, path).readBytes()) } }
        fun newService() = StorageCapacity(research, exports, cloud, device, { time.toString() }, { 987654L }, remover)
        fun close() { root.deleteRecursively() }
    }

    @Test fun summaryCountsActualHiddenResearchExportsRetainedAndAvailableWithoutCreatingProofs() {
        val f = Fixture()
        try {
            val doc = f.export(); JsonFiles.write(File(f.cloud, "archived-${UUID.randomUUID()}/snapshot.paperdigest"), byteArrayOf(1, 2, 3, 4))
            val summary = f.service.summary(); val rows = summary.getJSONArray("rows").objects().associateBy { it.getString("id") }
            assertEquals(4L, rows.getValue("research").getLong("fileCount")); assertEquals(2L, rows.getValue("exports").getLong("fileCount")); assertEquals(doc.bin.length() + doc.metadata.length(), rows.getValue("exports").getLong("bytes"))
            assertEquals(987654L, summary.getLong("availableBytes")); assertEquals(1L, summary.getJSONObject("retainedCloud").getLong("fileCount")); assertEquals("cloudTransfers", summary.getJSONObject("retainedCloud").getString("subsetOf")); assertEquals(0, f.verifies)
            assertTrue(f.device.listFiles()!!.isEmpty()); assertFalse(File(f.research, "ExportHistory").exists())
            assertTrue(StorageCapacity(f.research, f.exports, f.cloud, f.device).summary().getLong("availableBytes") >= 0)
        } finally { f.close() }
    }
    @Test fun onlyCurrentlyVerifiedSavedTemporaryPairIsRemovedAndHistoryKeepsNoUri() = runBlocking {
        val f = Fixture()
        try {
            val doc = f.export(); val originals = f.researchBytes(); val unknown = File(f.exports, "unknown.bin").apply { writeText("must preserve") }
            val saved = f.service.markExportSaved(doc.id, doc.uri, f.verifier); assertTrue(saved.getBoolean("verified")); assertEquals(sha256(doc.bytes), JSONObject(doc.metadata.readText()).getString("savedSHA256"))
            val history = File(f.research, "ExportHistory").listFiles()!!.single(); assertFalse(history.readText().contains("content://")); assertTrue(File(f.device, "export-save-integrity.key").isFile)
            val expectedFreed = doc.bin.length() + doc.metadata.length(); val plan = f.service.cleanupPrepare(f.verifier); assertEquals(1, plan.getInt("documents")); assertEquals(1, plan.getInt("unknownEntries")); assertFalse(plan.toString().contains("content://"))
            val result = f.service.cleanupCommit(plan.getString("planID"), f.verifier)
            assertEquals("completed", result.getString("status")); assertEquals(2, result.getInt("removedFiles")); assertEquals(expectedFreed, result.getLong("removedBytes")); assertFalse(doc.bin.exists()); assertFalse(doc.metadata.exists()); assertEquals("must preserve", unknown.readText()); assertTrue(history.isFile); f.unchanged(originals)
            assertTrue(runCatching { f.service.cleanupCommit(plan.getString("planID"), f.verifier) }.isFailure)
        } finally { f.close() }
    }
    @Test fun fakeSavedAtOrRestoredPublicHistoryNeverAuthorizesCleanupOrReadsItsUri() = runBlocking {
        val f = Fixture()
        try {
            val doc = f.export(); val proofID = UUID.randomUUID().toString(); val metadata = JSONObject(doc.metadata.readText()).put("savedAt", f.time.toString()).put("savedSHA256", sha256(doc.bytes)).put("savedBytes", doc.bytes.size).put("savedProofID", proofID); JsonFiles.write(doc.metadata, metadata)
            JsonFiles.write(File(f.research, "ExportHistory/$proofID.json"), JSONObject().put("documentID", doc.id).put("uri", "content://forged/never-read"))
            val plan = f.service.cleanupPrepare(f.verifier); assertEquals(0, plan.getInt("documents")); assertEquals(0, f.verifies); assertFalse(File(f.device, "export-save-integrity.key").exists())
            f.service.cleanupCommit(plan.getString("planID"), f.verifier); assertArrayEquals(doc.bytes, doc.bin.readBytes()); assertTrue(doc.metadata.isFile)
        } finally { f.close() }
    }
    @Test fun missingDestinationAtCommitRejectsEveryDeletionAndPreservesOriginalPair() = runBlocking {
        val f = Fixture()
        try {
            val doc = f.export(); f.service.markExportSaved(doc.id, doc.uri, f.verifier); val metadata = doc.metadata.readBytes(); val plan = f.service.cleanupPrepare(f.verifier); f.destinations.remove(doc.uri)
            assertTrue(runCatching { f.service.cleanupCommit(plan.getString("planID"), f.verifier) }.isFailure); assertArrayEquals(doc.bytes, doc.bin.readBytes()); assertArrayEquals(metadata, doc.metadata.readBytes()); assertFalse(f.exports.listFiles()!!.any { it.name.startsWith(".cleanup-") })
        } finally { f.close() }
    }
    @Test fun changedLocalBinOrWholeManifestAfterConfirmationCannotBeDeleted() = runBlocking {
        for (manifest in listOf(false, true)) {
            val f = Fixture()
            try {
                val doc = f.export(); f.service.markExportSaved(doc.id, doc.uri, f.verifier); val plan = f.service.cleanupPrepare(f.verifier)
                val changed = if (manifest) doc.metadata else doc.bin; changed.appendText(" "); val bytes = changed.readBytes()
                assertTrue(runCatching { f.service.cleanupCommit(plan.getString("planID"), f.verifier) }.isFailure); assertArrayEquals(bytes, changed.readBytes()); assertTrue(doc.bin.isFile); assertTrue(doc.metadata.isFile)
            } finally { f.close() }
        }
    }
    @Test fun laterDestinationVerifierCannotChangeAnEarlierPlanMemberAndStillDeleteIt() = runBlocking {
        val f = Fixture()
        try {
            val a = f.export("Snapshot A"); val b = f.export("Snapshot B"); f.service.markExportSaved(a.id, a.uri, f.verifier); f.service.markExportSaved(b.id, b.uri, f.verifier)
            val plan = f.service.cleanupPrepare(f.verifier); val firstID = plan.getJSONArray("items").getJSONObject(0).getString("documentID"); val earlier = listOf(a, b).single { it.id == firstID }; var calls = 0
            f.hook = { calls++; if (calls == 2) earlier.bin.appendText(" changed during other proof") }
            assertTrue(runCatching { f.service.cleanupCommit(plan.getString("planID"), f.verifier) }.isFailure); assertTrue(a.bin.isFile); assertTrue(b.bin.isFile); assertTrue(a.metadata.isFile); assertTrue(b.metadata.isFile); assertFalse(f.exports.listFiles()!!.any { it.name.startsWith(".cleanup-") })
        } finally { f.close() }
    }
    @Test fun alteredNativeProofCannotAuthorizeAnotherDestinationRead() = runBlocking {
        val f = Fixture()
        try {
            val doc = f.export(); val saved = f.service.markExportSaved(doc.id, doc.uri, f.verifier); val proof = File(f.device, "ExportSaveProofs/${saved.getString("proofID")}.json")
            JsonFiles.write(proof, JSONObject(proof.readText()).put("uri", "content://forged/provider")); f.verifies = 0
            assertEquals(0, f.service.cleanupPrepare(f.verifier).getInt("documents")); assertEquals(0, f.verifies); assertTrue(doc.bin.isFile)
        } finally { f.close() }
    }
    @Test fun verifierFailureOrCancellationCannotPersistSavedFlagsProofOrHistory() = runBlocking {
        for (cancel in listOf(false, true)) {
            val f = Fixture()
            try {
                val doc = f.export(); val before = doc.metadata.readBytes(); val result = runCatching { f.service.markExportSaved(doc.id, doc.uri) { _, _, _ -> if (cancel) throw CancellationException("synthetic") else error("synthetic private provider bait") } }
                assertTrue(result.isFailure); if (cancel) assertTrue(result.exceptionOrNull() is CancellationException)
                assertFalse(result.exceptionOrNull()!!.message.orEmpty().contains("bait")); assertArrayEquals(before, doc.metadata.readBytes()); assertArrayEquals(doc.bytes, doc.bin.readBytes()); assertTrue(f.device.listFiles()!!.isEmpty()); assertFalse(File(f.research, "ExportHistory").exists())
            } finally { f.close() }
        }
    }
    @Test fun expiredForgedOrPriorProcessPlanCannotDeleteAnything() = runBlocking {
        val f = Fixture()
        try {
            val doc = f.export(); f.service.markExportSaved(doc.id, doc.uri, f.verifier); val plan = f.service.cleanupPrepare(f.verifier)
            assertTrue(runCatching { f.newService().cleanupCommit(plan.getString("planID"), f.verifier) }.isFailure)
            assertTrue(runCatching { f.service.cleanupCommit(UUID.randomUUID().toString(), f.verifier) }.isFailure)
            f.time = f.time.plusSeconds(601); assertTrue(runCatching { f.service.cleanupCommit(plan.getString("planID"), f.verifier) }.isFailure); assertTrue(doc.bin.isFile); assertTrue(doc.metadata.isFile)
            val restarted = f.newService(); val current = restarted.cleanupPrepare(f.verifier); assertEquals(1, current.getInt("documents")); assertEquals("completed", restarted.cleanupCommit(current.getString("planID"), f.verifier).getString("status"))
        } finally { f.close() }
    }
    @Test fun filesystemDeleteFaultReportsActualPartialAndRetainsRemainingOriginalMetadata() = runBlocking {
        val f = Fixture { file -> if (file.name.endsWith(".bin")) file.delete() else false }
        try {
            val doc = f.export(); val originals = f.researchBytes(); f.service.markExportSaved(doc.id, doc.uri, f.verifier); val metadata = doc.metadata.readBytes(); val plan = f.service.cleanupPrepare(f.verifier)
            val result = f.service.cleanupCommit(plan.getString("planID"), f.verifier)
            assertEquals("partial", result.getString("status")); assertEquals(1, result.getInt("removedFiles")); assertEquals(doc.bytes.size.toLong(), result.getLong("removedBytes")); assertEquals(1, result.getInt("retainedFiles")); assertFalse(doc.bin.exists()); assertArrayEquals(metadata, doc.metadata.readBytes()); assertArrayEquals(doc.bytes, f.destinations.getValue(doc.uri)); f.unchanged(originals)
        } finally { f.close() }
    }
    @Test fun unknownOrLinkedFilesAreNeverFollowedOrDeleted() = runBlocking {
        val f = Fixture()
        try {
            val outside = File(f.root, "outside-secret-not-read").apply { writeText("synthetic outside material") }; val link = File(f.exports, "${UUID.randomUUID()}.json"); Files.createSymbolicLink(link.toPath(), outside.toPath())
            val unknown = File(f.exports, "orphan.bin").apply { writeText("unknown original") }
            assertTrue(runCatching { f.service.summary() }.isFailure)
            val plan = f.service.cleanupPrepare(f.verifier); assertEquals(0, plan.getInt("documents")); assertEquals(0, f.verifies); f.service.cleanupCommit(plan.getString("planID"), f.verifier)
            assertTrue(Files.isSymbolicLink(link.toPath())); assertEquals("synthetic outside material", outside.readText()); assertEquals("unknown original", unknown.readText())
        } finally { f.close() }
    }
    @Test fun overlappingDirectoriesAndNonContentDestinationsAreRejectedBeforeProof() = runBlocking {
        val f = Fixture()
        try {
            assertTrue(runCatching { StorageCapacity(f.research, File(f.research, "Exports"), f.cloud, f.device) }.isFailure)
            val doc = f.export(); assertTrue(runCatching { f.service.markExportSaved(doc.id, "https://example.invalid/never-read", f.verifier) }.isFailure); assertEquals(0, f.verifies); assertFalse(File(f.research, "ExportHistory").exists())
        } finally { f.close() }
    }
    @Test fun boundedPlanDefersTheTwentyFirstDocumentWithoutPretendingItWasCleaned() = runBlocking {
        val f = Fixture()
        try {
            val documents = (1..21).map { f.export("Synthetic original $it") }
            for (doc in documents) f.service.markExportSaved(doc.id, doc.uri, f.verifier)
            val plan = f.service.cleanupPrepare(f.verifier); assertEquals(20, plan.getInt("documents")); assertEquals(1, plan.getInt("deferredDocuments"))
            val selected = plan.getJSONArray("items").objects().map { it.getString("documentID") }.toSet()
            val remaining = documents.single { it.id !in selected }; val before = remaining.metadata.readBytes()
            val result = f.service.cleanupCommit(plan.getString("planID"), f.verifier); assertEquals("completed", result.getString("status")); assertEquals(40, result.getInt("removedFiles"))
            assertArrayEquals(remaining.bytes, remaining.bin.readBytes()); assertArrayEquals(before, remaining.metadata.readBytes()); assertEquals(21, File(f.research, "ExportHistory").listFiles()!!.size)
            val next = f.service.cleanupPrepare(f.verifier); assertEquals(1, next.getInt("documents")); assertEquals(0, next.getInt("deferredDocuments"))
        } finally { f.close() }
    }
    @Test fun failureBeforeAnyUnlinkRestoresBothFilesAndKeepsTheirOriginalProofUsable() = runBlocking {
        var allow = false; val f = Fixture { file -> allow && file.delete() }
        try {
            val doc = f.export(); f.service.markExportSaved(doc.id, doc.uri, f.verifier); val metadata = doc.metadata.readBytes()
            val plan = f.service.cleanupPrepare(f.verifier); val failed = f.service.cleanupCommit(plan.getString("planID"), f.verifier)
            assertEquals("partial", failed.getString("status")); assertEquals(0, failed.getInt("removedFiles")); assertEquals(0L, failed.getLong("removedBytes")); assertArrayEquals(doc.bytes, doc.bin.readBytes()); assertArrayEquals(metadata, doc.metadata.readBytes())
            allow = true; val retry = f.service.cleanupPrepare(f.verifier); assertEquals(1, retry.getInt("documents")); assertEquals("completed", f.service.cleanupCommit(retry.getString("planID"), f.verifier).getString("status"))
        } finally { f.close() }
    }
}
