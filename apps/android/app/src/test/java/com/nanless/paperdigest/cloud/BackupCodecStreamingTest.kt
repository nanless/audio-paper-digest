package com.nanless.paperdigest.cloud

import kotlinx.coroutines.CancellationException
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File
import java.io.RandomAccessFile
import java.nio.file.Files
import java.util.Base64

/** Author regressions: exact v2 wire oracle, bounded streaming, cancellation and original-file protection. */
class BackupCodecStreamingTest {
    private fun personal() = JSONObject().put("schema", 1).put("notes", JSONObject()).put("settings", JSONObject()).put("favorites", JSONArray()).put("reading", JSONArray()).put("readingState", JSONObject()).put("annotations", JSONObject()).put("sessions", JSONArray()).put("jobs", JSONArray())
    private fun fixture(body: (File, File) -> Unit) {
        val parent = Files.createTempDirectory("codec-streaming-author-").toRealPath().toFile()
        val root = File(parent, "Research").apply { mkdir() }; File(root, "personal.json").writeText(personal().toString())
        try { body(parent, root) } finally { parent.deleteRecursively() }
    }
    private fun bytes(root: File) = root.walkTopDown().filter { it.isFile }.associate { it.relativeTo(root).invariantSeparatorsPath to it.readBytes() }
    private fun unchanged(root: File, originals: Map<String, ByteArray>) { originals.forEach { (path, raw) -> assertArrayEquals(raw, File(root, path).readBytes()) } }
    private fun oracle(root: File): ByteArray {
        val entries = bytes(root)
        return entries.keys.sorted().joinToString(",", "{\"contract\":\"paperdigest-backup-v2\",\"files\":[", "],\"sourceDirectory\":" + JSONObject.quote(root.absolutePath) + "}") { path ->
            val raw = entries.getValue(path)
            "{\"data\":\"${Base64.getEncoder().encodeToString(raw)}\",\"path\":${JSONObject.quote(path)},\"sha256\":\"${BackupCodec.hash(raw)}\"}"
        }.toByteArray(Charsets.UTF_8)
    }

    @Test fun encodedWireBytesRemainExactAtEveryBase64BlockBoundary() = fixture { parent, root ->
        for (size in listOf(0, 1, 2, 3, 6143, 6144, 6145, 65535, 65536, 65537)) File(root, "binary-$size").writeBytes(ByteArray(size) { (it % 251).toByte() })
        val originals = bytes(root); val expected = oracle(root); val file = File(parent, "snapshot.paperdigest")
        val captured = BackupCodec.capture(root, file)
        assertArrayEquals(expected, file.readBytes()); assertEquals(BackupCodec.hash(expected), captured.sha256)
        val restored = BackupCodec.stage(file.inputStream(), parent)
        unchanged(root, originals); unchanged(restored.directory, originals); assertEquals(captured.encodedBytes, restored.encodedBytes)
    }

    @Test fun cancellationDuringEncodingCannotPublishSnapshotOrChangeAnySourceFile() = fixture { parent, root ->
        File(root, "large.bin").writeBytes(ByteArray(2 * 1024 * 1024) { (it % 251).toByte() })
        val originals = bytes(root); val output = File(parent, "snapshot.paperdigest"); var observed = false
        val error = runCatching { BackupCodec.capture(root, output) {
            if (parent.listFiles().orEmpty().any { it.name.startsWith(".snapshot.paperdigest-") && it.length() > 128 * 1024 }) { observed = true; throw CancellationException("synthetic cancellation") }
        } }.exceptionOrNull()
        assertTrue(observed); assertTrue(error is CancellationException); assertFalse(output.exists()); unchanged(root, originals)
        assertFalse(parent.listFiles().orEmpty().any { it.name.startsWith(".snapshot.paperdigest-") || it.name.startsWith(".paperdigest-restore-") })
    }

    @Test fun cancellationDuringDecodeClosesInputAndRemovesOnlyItsPrivateStage() = fixture { parent, root ->
        File(root, "large.bin").writeBytes(ByteArray(2 * 1024 * 1024) { (it % 251).toByte() })
        val originals = bytes(root); val packet = File(parent, "snapshot.paperdigest"); BackupCodec.capture(root, packet); val packetBytes = packet.readBytes()
        var read = 0L; var closed = false
        val input = object : ByteArrayInputStream(packetBytes) {
            override fun read(b: ByteArray, off: Int, len: Int): Int = super.read(b, off, len).also { if (it > 0) read += it }
            override fun close() { closed = true; super.close() }
        }
        val error = runCatching { BackupCodec.stage(input, parent) { if (read > 128 * 1024) throw CancellationException("synthetic decode cancellation") } }.exceptionOrNull()
        assertTrue(error is CancellationException); assertTrue(closed); assertArrayEquals(packetBytes, packet.readBytes()); unchanged(root, originals)
        assertFalse(parent.listFiles().orEmpty().any { it.name.startsWith(".paperdigest-restore-") })
        var earlyClosed = false
        val early = object : ByteArrayInputStream(packetBytes) { override fun close() { earlyClosed = true; super.close() } }
        assertTrue(runCatching { BackupCodec.stage(early, parent) { throw CancellationException("already cancelled") } }.exceptionOrNull() is CancellationException)
        assertTrue(earlyClosed)
    }

    @Test fun sourceChangeAfterItsFirstStreamedChunkStillFailsFullSelfValidation() = fixture { parent, root ->
        val original = File(root, "large.bin").apply { writeBytes(ByteArray(2 * 1024 * 1024) { (it % 251).toByte() }) }
        val output = File(parent, "snapshot.paperdigest"); var changed = false
        val error = runCatching { BackupCodec.capture(root, output) {
            if (!changed && parent.listFiles().orEmpty().any { it.name.startsWith(".snapshot.paperdigest-") && it.length() > 128 * 1024 }) {
                RandomAccessFile(original, "rw").use { it.seek(0); it.write(127) }; changed = true
            }
        } }.exceptionOrNull()
        assertTrue(changed); assertNotNull(error); assertFalse(output.exists()); assertEquals(127, original.inputStream().use { it.read() })
        assertFalse(parent.listFiles().orEmpty().any { it.name.startsWith(".snapshot.paperdigest-") || it.name.startsWith(".paperdigest-restore-") })
    }
}
