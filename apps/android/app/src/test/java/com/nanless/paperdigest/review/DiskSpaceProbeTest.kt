package com.nanless.paperdigest.review

import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.cloud.RequestContinuity
import kotlinx.coroutines.CancellationException
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.UUID

/** Author local probes; default platform API remains real rather than injected unlimited space. */
class DiskSpaceProbeTest {
    private class Fixture {
        val root = Files.createTempDirectory("disk-space-author-").toRealPath().toFile()
        val research = File(root, "Research").apply { mkdir() }
        val exports = File(root, "Exports").apply { mkdir() }
        val cloud = File(root, "Cloud").apply { mkdir() }
        val device = File(root, "Device").apply { mkdir() }
        val usage = File(research, "ModelUsage").apply { mkdir() }
        val original = File(usage, "original.bin").apply { writeBytes(byteArrayOf(0, -1, 34)) }
        var signed = 0
        val signer: (JSONObject) -> String = { signed++; "a".repeat(64) }
        fun capture(probe: (File) -> Long) = HttpResponseCapture.prepare(usage, UUID.randomUUID().toString(), "b".repeat(64), 4096, signer, available = probe)
        fun capacity(probe: (File) -> Long) = StorageCapacity(research, exports, cloud, device, available = probe)
        fun originalOnly() {
            assertArrayEquals(byteArrayOf(0, -1, 34), original.readBytes())
            assertEquals(listOf("original.bin"), usage.listFiles()!!.map { it.name })
            assertTrue(exports.listFiles()!!.isEmpty()); assertTrue(device.listFiles()!!.isEmpty())
            assertFalse(File(research, RequestContinuity.FILE).exists())
        }
        fun close() { root.deleteRecursively() }
    }
    private fun safeFailure(block: () -> Unit): Throwable {
        val error = runCatching(block).exceptionOrNull() ?: throw AssertionError("Expected a real local storage failure")
        assertFalse(error is CancellationException)
        assertFalse(error.toString().contains("SECRET-BAIT")); assertNull(error.cause)
        return error
    }
    @Test fun actualDefaultCaptureProbePreparesWithoutIssuingOrInventingSpace() {
        val f = Fixture()
        try {
            assertTrue(f.usage.usableSpace > 4096L * 3 + 1024 * 1024)
            val capture = HttpResponseCapture.prepare(f.usage, UUID.randomUUID().toString(), "b".repeat(64), 4096, f.signer)
            val manifest = JSONObject(capture.manifestFile.readText())
            assertEquals("prepared", manifest.getString("status")); assertFalse(manifest.getBoolean("requestIssued"))
            assertTrue(manifest.isNull("startedAt")); assertEquals(0L, capture.bodyFile.length())
            capture.finish("not-issued"); assertEquals("not-issued", JSONObject(capture.manifestFile.readText()).getString("status"))
            assertArrayEquals(byteArrayOf(0, -1, 34), f.original.readBytes())
        } finally { f.close() }
    }
    @Test fun actualDefaultCapacityProbeReturnsFiniteMeasuredSpaceWithoutWritingProofs() {
        val f = Fixture()
        try {
            val report = StorageCapacity(f.research, f.exports, f.cloud, f.device).summary()
            assertTrue(report.getLong("availableBytes") in 1 until Long.MAX_VALUE)
            val rows=report.getJSONArray("rows")
            assertEquals(5,rows.length())
            assertEquals(setOf("research","exports","pendingExports","cloudTransfers","deviceControl"),rows.objects().map{it.getString("id")}.toSet())
            val pending=rows.objects().single{it.getString("id")=="pendingExports"}
            assertEquals("待保存准备材料",pending.getString("label"));assertEquals(0L,pending.getLong("fileCount"));assertEquals(0L,pending.getLong("bytes"));assertFalse(pending.getBoolean("exists"))
            assertFalse(File(f.exports.parentFile,"PendingExports").exists())
            f.originalOnly()
        } finally { f.close() }
    }
    @Test fun captureZeroNegativeAndProviderErrorsFailBeforeCaptureOrSigning() {
        val probes: List<(File) -> Long> = listOf({ 0L }, { -1L }, { throw SecurityException("SECRET-BAIT-PERMISSION") }, { throw IOException("SECRET-BAIT-IO") })
        probes.forEach { probe ->
            val f = Fixture()
            try { safeFailure { f.capture(probe) }; assertEquals(0, f.signed); f.originalOnly() }
            finally { f.close() }
        }
    }
    @Test fun capacityZeroNegativeAndProviderErrorsNeverBecomeFakeSummaryOrInfiniteSpace() {
        val probes: List<(File) -> Long> = listOf({ 0L }, { -1L }, { throw SecurityException("SECRET-BAIT-PERMISSION") }, { throw IOException("SECRET-BAIT-IO") })
        probes.forEach { probe ->
            val f = Fixture()
            try { safeFailure { f.capacity(probe).summary() }; f.originalOnly() }
            finally { f.close() }
        }
    }
    @Test fun cancellationRemainsExactCancellationAndLeavesOriginalsUntouched() {
        val f = Fixture()
        try {
            val cancelled = CancellationException("Synthetic cancelled measurement")
            assertSame(cancelled, runCatching { f.capture { throw cancelled } }.exceptionOrNull())
            assertSame(cancelled, runCatching { f.capacity { throw cancelled }.summary() }.exceptionOrNull())
            assertEquals(0, f.signed); f.originalOnly()
        } finally { f.close() }
    }
    @Test fun captureKeepsExactRequiredSpaceThresholdWithoutAnUnlimitedFallback() {
        val f = Fixture()
        try {
            val minimum = 4096L * 3 + 1024 * 1024
            safeFailure { f.capture { minimum - 1 } }; assertEquals(0, f.signed); f.originalOnly()
            val capture = f.capture { minimum }; assertEquals(1, f.signed)
            capture.finish("not-issued"); assertEquals(2, f.signed)
            assertArrayEquals(byteArrayOf(0, -1, 34), f.original.readBytes())
        } finally { f.close() }
    }
}
