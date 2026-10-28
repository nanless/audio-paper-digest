package com.nanless.paperdigest.cloud

import com.nanless.paperdigest.secret.SecretStore
import com.nanless.paperdigest.data.HttpBytes
import com.nanless.paperdigest.data.PersonalStore
import com.nanless.paperdigest.model.HostCapturePublication
import com.nanless.paperdigest.model.StudyService
import kotlinx.coroutines.runBlocking
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.Base64

/** Synthetic, private temp trees only; no sockets, device files, real credentials or test secret swaps. */
class LocalIntegrityBackupPolicyTest {
    private val keyPaths = listOf("ModelUsage/response-integrity.key", "ModelUsage/response-integrity.android.key")
    private fun personal() = JSONObject().put("schema", 1)
        .put("notes", JSONObject().put("synthetic-paper", JSONObject().put("text", "Original synthetic note\n原笔记").put("revision", 3)))
        .put("settings", JSONObject()).put("favorites", JSONArray()).put("reading", JSONArray())
        .put("readingState", JSONObject()).put("annotations", JSONObject()).put("sessions", JSONArray()).put("jobs", JSONArray())
    private fun root(parent: File, name: String): File = File(parent, name).apply {
        check(mkdir()); File(this, "personal.json").writeText(personal().toString())
    }
    private fun put(root: File, path: String, raw: ByteArray) = File(root, path).apply { parentFile!!.mkdirs(); writeBytes(raw) }
    private fun inventory(root: File) = root.walkTopDown().filter { it.isFile }.associate { it.relativeTo(root).invariantSeparatorsPath to it.readBytes() }
    private fun unchanged(root: File, before: Map<String, ByteArray>) {
        assertEquals(before.keys, inventory(root).keys)
        before.forEach { (path, raw) -> assertArrayEquals(path, raw, File(root, path).readBytes()) }
    }
    private fun fixture(body: (File, File) -> Unit) {
        val parent = Files.createTempDirectory("local-integrity-policy-").toRealPath().toFile()
        try { body(parent, root(parent, "Incoming")) } finally { parent.deleteRecursively() }
    }
    private fun researchAssets(root: File) {
        listOf("foo.key", ".hidden", "ModelUsage/foo.key", "ModelUsage/.hidden",
            "nested/response-integrity.key", "nested/ModelUsage/response-integrity.android.key",
            "ModelUsage/response-integrity.android.key.backup",
            "ModelUsage/synthetic-input.json", "ModelUsage/synthetic-response.bin", "Notes/original.md")
            .forEachIndexed { i, path -> put(root, path, "Original synthetic research $i\r\n原始材料\u0000".toByteArray()) }
    }
    private fun addKeys(root: File) = keyPaths.forEachIndexed { i, path -> put(root, path, ByteArray(32) { (i + 41).toByte() }) }
    /** Original v2 writer oracle intentionally includes legacy keys, with their original file SHA. */
    private fun legacyArchive(root: File): ByteArray = inventory(root).toSortedMap().entries.joinToString(",",
        "{\"contract\":\"paperdigest-backup-v2\",\"files\":[", "],\"sourceDirectory\":" + JSONObject.quote(root.absolutePath) + "}") { (path, raw) ->
        "{\"data\":\"${Base64.getEncoder().encodeToString(raw)}\",\"path\":${JSONObject.quote(path)},\"sha256\":\"${BackupCodec.hash(raw)}\"}"
    }.toByteArray()

    @Test fun realCaptureEncodeDecodeAndInstallExcludeExactlyTwoKeysAndPreserveNormalAssets() = fixture { parent, incoming ->
        researchAssets(incoming); addKeys(incoming)
        val before = inventory(incoming)
        assertEquals(keyPaths.toSet(), before.keys.filter(BackupCodec::isLocalOnlyIntegrityPath).toSet())
        val output = File(parent, "normal.paperdigest")
        val capture = BackupCodec.capture(incoming, output)
        BackupCodec.requireNormalCapture(capture)
        val staged = BackupCodec.stage(output.inputStream(), parent)
        val portable = before.filterKeys { it !in keyPaths }
        assertEquals(portable.keys, staged.entries.map { it.path }.toSet())
        assertEquals(portable.size, capture.fileCount)
        assertEquals(BackupCodec.hash(output), staged.encodedSHA256)
        assertEquals(capture.sha256, staged.encodedSHA256); assertEquals(capture.encodedBytes, staged.encodedBytes)
        BackupCodec.requirePortableInventory(staged.entries)
        keyPaths.forEach { assertFalse(File(staged.directory, it).exists()) }
        portable.forEach { (path, raw) -> assertArrayEquals(path, raw, File(staged.directory, path).readBytes()) }
        val current = root(parent, "Fresh")
        RestorePolicy.install(staged, current, initialize = {})
        keyPaths.forEach { assertFalse(File(current, it).exists()) }
        portable.filterKeys { it != "personal.json" }.forEach { (path, raw) -> assertArrayEquals(path, raw, File(current, path).readBytes()) }
        assertEquals("Original synthetic note\n原笔记", JSONObject(File(current, "personal.json").readText()).getJSONObject("notes").getJSONObject("synthetic-paper").getString("text"))
        unchanged(incoming, before)
    }

    @Test fun legacyDecodeVerifiesWholeOriginalButInstallRetainsOnlyExistingDeviceKeys() = fixture { parent, incoming ->
        researchAssets(incoming); addKeys(incoming)
        val before = inventory(incoming); val original = legacyArchive(incoming)
        for (localKeyCount in 0..2) {
            val staged = BackupCodec.stage(original.inputStream(), parent)
            assertEquals(before.keys, staged.entries.map { it.path }.toSet())
            assertEquals(BackupCodec.hash(original), staged.encodedSHA256); assertEquals(original.size.toLong(), staged.encodedBytes)
            before.forEach { (path, raw) -> assertArrayEquals(raw, File(staged.directory, path).readBytes()) }
            assertTrue(runCatching { BackupCodec.requirePortableInventory(staged.entries) }.isFailure)
            val current = root(parent, "Current-$localKeyCount")
            val localKeys = keyPaths.take(localKeyCount).associateWith { ByteArray(32) { (localKeyCount + 90).toByte() } }
            localKeys.forEach { (path, raw) -> put(current, path, raw) }
            val currentBefore = inventory(current)
            val retained = RestorePolicy.install(staged, current, initialize = {})
            unchanged(retained, currentBefore)
            keyPaths.forEach { path ->
                if (path in localKeys) assertArrayEquals(localKeys.getValue(path), File(current, path).readBytes())
                else assertFalse("Missing device key must remain missing: $path", File(current, path).exists())
            }
            before.filterKeys { it !in keyPaths && it != "personal.json" }.forEach { (path, raw) -> assertArrayEquals(path, raw, File(current, path).readBytes()) }
            val receipt = File(current, "RestorationReceipts").listFiles()!!.single { it.name.endsWith("-original-personal.json") }
            assertArrayEquals(before.getValue("personal.json"), receipt.readBytes())
            assertArrayEquals(original, legacyArchive(incoming))
        }
        unchanged(incoming, before)
    }

    @Test fun legacyKeyShaIsStillRequiredAndTamperedStagedKeyCannotBypassPreflight() = fixture { parent, incoming ->
        addKeys(incoming)
        val original = legacyArchive(incoming)
        val forged = JSONObject(original.toString(Charsets.UTF_8))
        val files = forged.getJSONArray("files")
        val keyEntry = (0 until files.length()).map { files.getJSONObject(it) }.single { it.getString("path") == keyPaths.first() }
        keyEntry.put("data", Base64.getEncoder().encodeToString(ByteArray(32) { 99 }))
        assertTrue(runCatching { BackupCodec.stage(forged.toString().byteInputStream(), parent) }.isFailure)
        val staged = BackupCodec.stage(original.inputStream(), parent)
        File(staged.directory, keyPaths.first()).writeBytes(ByteArray(32) { 98 })
        val current = root(parent, "Current"); val before = inventory(current)
        assertTrue(runCatching { RestorePolicy.install(staged, current, initialize = { error("Must not initialize") }) }.isFailure)
        unchanged(current, before)
        assertTrue(staged.directory.exists())
    }

    @Test fun freshRestoreKeepsRealSavedResearchReadableWithoutGrantingDeviceHmacAuthority() = fixture { parent, incoming ->
        val store = PersonalStore(incoming)
        store.updateSettings(JSONObject().put("endpoint", "https://synthetic.example.invalid/v1").put("model", "synthetic-model").put("protocol", "chat").put("dailyRequests", 5))
        val response = JSONObject().put("model", "synthetic-model").put("usage", JSONObject().put("total_tokens", 5))
            .put("choices", JSONArray().put(JSONObject().put("finish_reason", "stop").put("message", JSONObject().put("content", "Original synthetic answer")))).toString().toByteArray()
        var syntheticRequests = 0
        val producer = StudyService(store, { "synthetic-only-api-secret" }, HostCapturePublication) { _, _, _, _ ->
            syntheticRequests++; HttpBytes(200, emptyMap(), response)
        }
        val session = runBlocking {
            val prepared = producer.prepare("fixture:paper", "Synthetic question", "Synthetic original evidence", JSONObject().put("paperID", "fixture:paper").put("kind", "range").put("pages", JSONArray().put(1)))
            producer.run(prepared.getString("id"))
            store.session(prepared.getString("id"))!!
        }
        assertEquals(1, syntheticRequests)
        producer.verifySaved(session) // Positive normal producer/HMAC baseline, with its own generated temp key.
        val before = inventory(incoming); val original = legacyArchive(incoming)
        val fresh = root(parent, "Fresh")
        RestorePolicy.install(BackupCodec.stage(original.inputStream(), parent), fresh, initialize = {})
        val restoredStore = PersonalStore(fresh)
        val restored = restoredStore.session(session.getString("id"))!!
        assertEquals("Original synthetic answer", restored.getString("answer"))
        before.filterKeys { it.startsWith("ModelUsage/") && it !in keyPaths }.forEach { (path, raw) -> assertArrayEquals(path, raw, File(fresh, path).readBytes()) }
        keyPaths.forEach { assertFalse(File(fresh, it).exists()) }
        var credentialReads = 0; var requests = 0
        val verifier = StudyService(restoredStore, { credentialReads++; error("No credentials during read-only verification") }, HostCapturePublication) { _, _, _, _ -> requests++; error("No network during read-only verification") }
        val installedBefore = inventory(fresh)
        assertTrue(runCatching { verifier.verifySaved(restored) }.isFailure)
        assertEquals(0, credentialReads); assertEquals(0, requests)
        unchanged(fresh, installedBefore); unchanged(incoming, before)
    }

    @Test fun oldPendingContainingEitherKeyRejectsBeforeCredentialsNetworkOrAnyPendingMutation() = runBlocking {
        fixture { parent, incoming ->
            researchAssets(incoming)
            // Exercise each exact forbidden name independently, as well as the joint archive.
            for ((index, forbidden) in listOf(keyPaths.take(1), keyPaths.takeLast(1), keyPaths).withIndex()) {
                keyPaths.forEach { File(incoming, it).delete() }
                forbidden.forEach { put(incoming, it, ByteArray(32) { 55 }) }
                val original = legacyArchive(incoming); val researchBefore = inventory(incoming)
                var networkCalls = 0; var credentialReads = 0; var captures = 0
                val secrets = object : SecretStore {
                    override fun save(scope: String, secret: String) = Unit
                    override fun remove(scope: String) = Unit
                    override fun load(scope: String): String? { credentialReads++; error("Forbidden credential read") }
                }
                val transport = object : CloudTransport {
                    override suspend fun execute(request: Request, limit: Int): CloudHTTP { networkCalls++; error("Forbidden network call") }
                }
                val workspace = object : CloudWorkspace {
                    override suspend fun capture(output: File): BackupCodec.Captured { captures++; error("Must not recapture old pending") }
                    override suspend fun restore(staged: BackupCodec.Staged) = error("Must not restore")
                }
                val control = File(parent, "Control-$index")
                val service = CloudService(incoming, control, secrets, workspace, transport)
                runBlocking { service.save("synthetic@example.invalid", "SyntheticBackup", false, 24) }
                val id = service.targetID; val folder = File(control, id).apply { check(mkdir()) }
                val snapshot = put(folder, "snapshot.paperdigest", original)
                val pending = JSONObject().put("contract", "paperdigest-android-cloud-pending-v1").put("destinationID", id)
                    .put("createdAt", "2026-01-01T00:00:00Z").put("encodedBytes", original.size).put("fileCount", inventory(incoming).size)
                    .put("sha256", BackupCodec.hash(original))
                val reference = CloudReference("2026-01", "00000000-0000-4000-8000-000000000001")
                if (index > 0) {
                    val manifest = CloudManifest(reference, 1767225600000L, original.size.toLong(), BackupCodec.hash(original), listOf(CloudChunk(0, original.size, BackupCodec.hash(original))))
                    val checkpoint = CloudCheckpoint(id, "SyntheticBackup", manifest, setOf(0))
                    pending.put("checkpoint", checkpoint.json())
                    assertEquals(reference, CloudCheckpoint.parse(pending.getJSONObject("checkpoint")).manifest.reference)
                }
                put(folder, "pending.json", pending.toString().toByteArray())
                val controlBefore = inventory(control)
                // Cold construction and repeated retries must not normalize, re-ID, resume or transmit.
                val cold = CloudService(incoming, control, secrets, workspace, transport)
                repeat(2) {
                    val failure = runBlocking { runCatching { cold.upload() }.exceptionOrNull() }
                    assertTrue(failure is IllegalArgumentException)
                    assertTrue(failure!!.message.orEmpty().contains("仅限本机"))
                    assertEquals(id, cold.targetID)
                    unchanged(control, controlBefore); unchanged(incoming, researchBefore)
                    assertArrayEquals(original, snapshot.readBytes())
                }
                assertEquals(0, networkCalls); assertEquals(0, credentialReads); assertEquals(0, captures)
            }
        }
    }
}
