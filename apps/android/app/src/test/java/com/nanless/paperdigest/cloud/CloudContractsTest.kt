package com.nanless.paperdigest.cloud

import com.nanless.paperdigest.secret.SecretStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import okhttp3.Request
import okio.Buffer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.Base64
import java.util.UUID

class CloudContractsTest {
    private fun personal(endpoint: String = "https://fixture.invalid/v1") = JSONObject().put("schema", 1).put("notes", JSONObject()).put("favorites", JSONArray()).put("reading", JSONArray()).put("readingState", JSONObject()).put("annotations", JSONObject()).put("sessions", JSONArray()).put("jobs", JSONArray()).put("settings", JSONObject().put("endpoint", endpoint).put("model", "fixture-model").put("dailyRequests", 5))
    private fun temp(body: (File) -> Unit) { val dir = Files.createTempDirectory("android-cloud-test-").toFile(); try { body(dir) } finally { dir.deleteRecursively() } }
    private suspend fun tempAsync(body: suspend (File) -> Unit) { val dir = Files.createTempDirectory("android-cloud-test-").toFile(); try { body(dir) } finally { dir.deleteRecursively() } }
    private fun encoded(path: String = "personal.json", bytes: ByteArray = personal().toString().toByteArray(), sha: String = BackupCodec.hash(bytes), extra: List<JSONObject> = emptyList()): ByteArray = JSONObject().put("contract", "paperdigest-backup-v2").put("sourceDirectory", "/portable-fixture/PaperDigest").put("files", JSONArray(listOf(JSONObject().put("path", path).put("data", Base64.getEncoder().encodeToString(bytes)).put("sha256", sha)) + extra)).toString().toByteArray()
    private fun entry(path: String, bytes: ByteArray = byteArrayOf(0, -1, 1)) = JSONObject().put("path", path).put("data", Base64.getEncoder().encodeToString(bytes)).put("sha256", BackupCodec.hash(bytes))
    private fun expectReject(body: () -> Unit) { try { body(); fail("Expected safe rejection") } catch (e: Exception) { } }

    @Test fun portableBinaryHiddenFilesAndUnknownPersonalFieldsSurvive() = temp { dir ->
        val root = File(dir, "Research").apply { mkdir() }; val p = personal().put("unknownFuture", JSONObject().put("keep", true)); BackupCodec.atomicJSON(File(root, "personal.json"), p)
        File(root, ".hidden").writeBytes(ByteArray(256) { it.toByte() }); File(root, "Unknown").mkdir(); File(root, "Unknown/opaque.bin").writeBytes(byteArrayOf(0, 10, -1))
        val captured = BackupCodec.capture(root, File(dir, "backup.paperdigest")); val restored = BackupCodec.stage(captured.file.inputStream(), dir)
        assertEquals(3, captured.fileCount); assertEquals(captured.sha256, restored.encodedSHA256)
        assertArrayEquals(File(root, ".hidden").readBytes(), File(restored.directory, ".hidden").readBytes()); assertTrue(JSONObject(File(restored.directory, "personal.json").readText()).getJSONObject("unknownFuture").getBoolean("keep"))
        assertTrue(File(restored.directory, BackupCodec.ROOTS_FILE).isFile)
    }
    @Test fun hashesAndMalformedBase64FailBeforeInstall() = temp { dir ->
        expectReject { BackupCodec.stage(encoded(sha = "0".repeat(64)).inputStream(), dir) }
        val o = JSONObject(encoded().toString(Charsets.UTF_8)); o.getJSONArray("files").getJSONObject(0).put("data", "not base64")
        expectReject { BackupCodec.stage(o.toString().byteInputStream(), dir) }; assertFalse(dir.listFiles().orEmpty().any { it.name.startsWith(".paperdigest-restore-") })
    }
    @Test fun pathTraversalAliasesAndParentFilesReject() = temp { dir ->
        for (path in listOf("../outside", "/absolute", "a//b", "a/./b", "a\\b", "a/", "a\u0000b")) expectReject { BackupCodec.stage(encoded(extra = listOf(entry(path))).inputStream(), dir) }
        for (pair in listOf("A/x" to "a/y", "a" to "a/b", "personal.json" to "personal.json")) expectReject { BackupCodec.stage(encoded(extra = listOf(entry(pair.first), entry(pair.second))).inputStream(), dir) }
        assertFalse(File(dir.parentFile, "outside").exists())
    }
    @Test fun wrongPersonalSchemaAndArrayTypesReject() = temp { dir ->
        for (p in listOf(personal().put("schema", 2), personal().put("annotations", JSONObject().put("p", "bad")), personal().put("readingState", JSONObject().put("p", JSONArray())))) expectReject { BackupCodec.stage(encoded(bytes = p.toString().toByteArray()).inputStream(), dir) }
    }
    @Test fun escapedBase64SlashAndUnicodePersonalTextArePortable() = temp { dir ->
        val p = personal().put("notes", JSONObject().put("fixture:p", JSONObject().put("text", "合成🙂 e\u0301").put("revision", 1)))
        val bytes = encoded(bytes = p.toString().toByteArray(), extra = listOf(entry("opaque.bin", byteArrayOf(-1, -1, -1))))
        val escaped = bytes.toString(Charsets.UTF_8).replace("////", "\\/\\/\\/\\/")
        val stage = BackupCodec.stage(escaped.byteInputStream(), dir); assertArrayEquals(byteArrayOf(-1, -1, -1), File(stage.directory, "opaque.bin").readBytes())
    }
    @Test fun overlappingHistoricalRootsReject() = temp { dir ->
        val map = JSONObject().put("contract", "paperdigest-storage-aliases-v1").put("roots", JSONArray(listOf("/old", "/old/nested")))
        expectReject { BackupCodec.stage(encoded(extra = listOf(entry(BackupCodec.ROOTS_FILE, map.toString().toByteArray()))).inputStream(), dir) }
    }
    @Test fun restoreKeepsLocalRouteRequestsAndOriginalPersonalReceipt() = temp { dir ->
        val root = File(dir, "Research").apply { mkdir() }; val local = personal("https://local.invalid/v1").put("sessions", JSONArray().put(JSONObject().put("id", "local-request").put("startedAt", "2026-01-01T00:00:00Z").put("requestIssued", true))); BackupCodec.atomicJSON(File(root, "personal.json"), local)
        val incoming = personal("https://other.invalid/v1").put("sessions", JSONArray().put(JSONObject().put("id", "remote-request").put("startedAt", "2026-01-01T01:00:00Z").put("requestIssued", true))); val original = incoming.toString().toByteArray()
        val stage = BackupCodec.stage(encoded(bytes = original).inputStream(), dir); var reloads = 0
        val before = RestorePolicy.install(stage, root) { reloads++ }
        assertTrue(before.isDirectory); assertEquals(1, reloads); assertEquals("https://local.invalid/v1", JSONObject(File(root, "personal.json").readText()).getJSONObject("settings").getString("endpoint")); assertEquals(2, RequestContinuity.count("2026-01-01", root, JSONObject(File(root, "personal.json").readText())))
        val receipt = File(root, "RestorationReceipts").listFiles()!!.single(); assertArrayEquals(original, receipt.readBytes())
    }
    @Test fun initializationFailureRollsBackAndRetainsFailedVersion() = temp { dir ->
        val root = File(dir, "Research").apply { mkdir() }; val original = personal("https://local.invalid/v1").toString().toByteArray(); BackupCodec.atomicBytes(File(root, "personal.json"), original)
        val stage = BackupCodec.stage(encoded().inputStream(), dir); var called = 0
        expectReject { RestorePolicy.install(stage, root) { called++; if (called == 1) error("isolated initialization fault") } }
        assertEquals(2, called); assertArrayEquals(original, File(root, "personal.json").readBytes()); assertTrue(dir.listFiles()!!.any { it.name.startsWith("Research-FailedRestore-") })
    }
    @Test fun requestHistoryRejectsDateConflictsAndFalseDates() {
        expectReject { RequestContinuity.union(listOf(RequestContinuity.Issued("same", "2026-01-01T00:00:00Z")), listOf(RequestContinuity.Issued("same", "2026-01-01T00:00:01Z"))) }
        for (time in listOf("2026-02-29T00:00:00Z", "2026-13-01T00:00:00Z", "2026-01-01T00:00:60Z", "0000-01-01T00:00:00Z", "2026-01-01")) assertFalse(RequestContinuity.validTime(time))
        assertTrue(RequestContinuity.validTime("2024-02-29T00:00:00.123456789Z"))
    }
    @Test fun remoteManifestAcceptsMacUppercaseUUIDButNotWrongTimeOrChunks() {
        val ref = CloudReference("2026-01", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"); val m = CloudManifest(ref, 1767225600000, 3, BackupCodec.hash(byteArrayOf(1, 2, 3)), listOf(CloudChunk(0, 3, BackupCodec.hash(byteArrayOf(1, 2, 3)))))
        val mac = m.json(); mac.getJSONObject("reference").put("id", ref.id.uppercase()); assertEquals(m, CloudManifest.parse(mac.toString().toByteArray(), ref))
        expectReject { CloudManifest.parse(m.json().put("createdAt", 1767225600001).toString().toByteArray(), ref) }
        val bad = m.json(); bad.getJSONArray("chunks").getJSONObject(0).put("index", 1); expectReject { CloudManifest.parse(bad.toString().toByteArray(), ref) }
    }
    @Test fun reservedZoteroAndTraversalFoldersReject() {
        for (folder in listOf("zotero", "ZoTeRo", "../x", "a..b", "a/b", "_a", "")) assertFalse(CloudArchive.validFolder(folder))
        assertTrue(CloudArchive.validFolder("PaperDigest")); assertTrue(CloudArchive.validFolder("zotero-backup"))
    }

    private class FakeDAV : CloudTransport {
        val files = HashMap<String, ByteArray>(); val directories = hashSetOf("/dav/"); val requests = ArrayList<Pair<String, String>>()
        var losePutOnce = false; var reject: Int? = null; var extraListing = ""
        private fun listing(path: String, members: List<String>) = ("<d:multistatus xmlns:d=\"DAV:\">" + members.joinToString("") { "<d:response><d:href>$it</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>" } + extraListing + "</d:multistatus>").toByteArray()
        override suspend fun execute(request: Request, limit: Int): CloudHTTP {
            val path = request.url.encodedPath; requests += request.method to path; reject?.let { return CloudHTTP(it, mapOf("Retry-After" to "120"), ByteArray(0)) }
            return when (request.method) {
                "MKCOL" -> CloudHTTP(if (directories.add(path)) 201 else 405, emptyMap(), ByteArray(0))
                "PROPFIND" -> if (path !in directories) CloudHTTP(404, emptyMap(), ByteArray(0)) else CloudHTTP(207, emptyMap(), listing(path, listOf(path) + if (request.header("Depth") == "1") directories.filter { it != path && it.startsWith(path) && '/' !in it.removePrefix(path).removeSuffix("/") }.sorted() else emptyList()))
                "GET" -> files[path]?.let { CloudHTTP(200, emptyMap(), it.copyOf()) } ?: CloudHTTP(404, emptyMap(), ByteArray(0))
                "PUT" -> {
                    val buffer = Buffer(); request.body!!.writeTo(buffer); val bytes = buffer.readByteArray(); val old = files.putIfAbsent(path, bytes)
                    if (losePutOnce && path.contains("chunk-")) { losePutOnce = false; throw java.io.IOException("isolated lost reply") }
                    CloudHTTP(if (old == null) 201 else 412, emptyMap(), ByteArray(0))
                }
                else -> error("Unexpected method")
            }
        }
    }
    private fun archive(dav: FakeDAV, checkpoints: MutableList<CloudCheckpoint>, credentials: suspend () -> CloudCredentials = { CloudCredentials("fixture-user", "fixture-password") }, now: () -> Long = { 1767225600000L }, saver: suspend (CloudCheckpoint) -> Unit = { checkpoints += it }): CloudArchive = CloudArchive("PaperDigest", "00000000-0000-4000-8000-000000000002", credentials, saver, dav, now, {}, 0)
    @Test fun immutableManifestLastRoundTripAndIdempotentResume() = runTest {
        tempAsync { dir ->
            val file = File(dir, "snapshot").apply { writeBytes(encoded()) }; val dav = FakeDAV(); val checkpoints = arrayListOf<CloudCheckpoint>(); val service = archive(dav, checkpoints)
            val result = service.upload(file); assertTrue(checkpoints.last().manifestVerified); val manifestPut = dav.requests.indexOfFirst { it.first == "PUT" && it.second.endsWith("manifest.json") }; val chunkPut = dav.requests.indexOfFirst { it.first == "PUT" && it.second.endsWith("chunk-000000.bin") }; val chunkGet = dav.requests.indices.firstOrNull { i -> i > chunkPut && dav.requests[i].first == "GET" && dav.requests[i].second.endsWith("chunk-000000.bin") } ?: -1; assertTrue(chunkPut >= 0 && chunkGet > chunkPut && manifestPut > chunkGet)
            val putCount = dav.requests.count { it.first == "PUT" }; val resumed = service.upload(file, checkpoints.last()); assertEquals(result, resumed); assertEquals(putCount, dav.requests.count { it.first == "PUT" })
            val target = File(dir, "download"); assertEquals(result, service.download(result.reference, target)); assertArrayEquals(file.readBytes(), target.readBytes()); assertEquals(listOf(result), service.list("2026-01"))
        }
    }
    @Test fun lostPutReplyResumesSameUUIDWithoutOverwrite() = runTest {
        tempAsync { dir ->
            val file = File(dir, "snapshot").apply { writeBytes(encoded()) }; val dav = FakeDAV().apply { losePutOnce = true }; val checkpoints = arrayListOf<CloudCheckpoint>(); val service = archive(dav, checkpoints)
            try { service.upload(file); fail() } catch (e: CloudFailure) { assertEquals("transport", e.code) }
            val first = checkpoints.last(); assertFalse(first.manifestVerified); assertFalse(dav.files.keys.any { it.endsWith("manifest.json") }); val result = service.upload(file, first)
            assertEquals(first.manifest.reference, result.reference); assertEquals(1, dav.requests.count { it.first == "PUT" && it.second.endsWith("chunk-000000.bin") })
        }
    }
    @Test fun credentialFailureAndCancellationSendNoHTTPAndReleaseLock() = runTest {
        val dav = FakeDAV(); val cp = arrayListOf<CloudCheckpoint>(); var unavailable = true
        val service = archive(dav, cp, credentials = { if (unavailable) throw IllegalStateException("private fixture bait") else CloudCredentials("fixture", "fixture") })
        try { service.probe(); fail() } catch (e: CloudFailure) { assertEquals("credentialsUnavailable", e.code); assertFalse(e.message!!.contains("bait")) }; assertTrue(dav.requests.isEmpty())
        unavailable = false; service.probe(); assertEquals(1, dav.requests.size)
        val canceled = archive(dav, cp, credentials = { throw CancellationException("isolated") }); try { canceled.probe(); fail() } catch (_: CancellationException) { }; assertEquals(1, dav.requests.size)
    }
    @Test fun remoteAuthenticationAndThrottleRemainDistinct() = runTest {
        val dav = FakeDAV().apply { reject = 401 }; val cp = arrayListOf<CloudCheckpoint>(); val service = archive(dav, cp)
        try { service.probe(); fail() } catch (e: CloudFailure) { assertEquals("authentication", e.code) }
        dav.reject = 429; try { service.probe(); fail() } catch (e: CloudFailure) { assertEquals("throttled", e.code); assertEquals(1767225720000L, e.untilMillis) }
        val count = dav.requests.size; dav.reject = null; try { service.probe(); fail() } catch (e: CloudFailure) { assertEquals("throttled", e.code) }; assertEquals(count, dav.requests.size)
    }
    @Test fun checkpointWriteFailurePreventsAnyRemoteMutation() = runTest {
        tempAsync { dir -> val file = File(dir, "snapshot").apply { writeBytes(encoded()) }; val dav = FakeDAV(); val service = archive(dav, arrayListOf(), saver = { error("isolated disk full") }); try { service.upload(file); fail() } catch (e: CloudFailure) { assertEquals("checkpointStore", e.code) }; assertTrue(dav.requests.isEmpty()) }
    }
    @Test fun corruptedRemoteObjectNeverOverwritesOrPublishesManifest() = runTest {
        tempAsync { dir ->
            val file = File(dir, "snapshot").apply { writeBytes(encoded()) }; val dav = FakeDAV().apply { losePutOnce = true }; val checkpoints = arrayListOf<CloudCheckpoint>(); val service = archive(dav, checkpoints)
            try { service.upload(file) } catch (_: CloudFailure) { }
            val key = dav.files.keys.single(); dav.files[key] = byteArrayOf(42)
            try { service.upload(file, checkpoints.last()); fail() } catch (e: CloudFailure) { assertEquals("integrity", e.code) }
            assertArrayEquals(byteArrayOf(42), dav.files[key]); assertFalse(dav.files.keys.any { it.endsWith("manifest.json") })
        }
    }
    @Test fun davCollectionMustComeFromSuccessfulPropstat() = runTest {
        val dav = FakeDAV().apply { extraListing = "<d:response><d:href>/dav/bad/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat><d:propstat><d:prop><d:displayname>x</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>" }
        try { archive(dav, arrayListOf()).probe(); fail() } catch (e: CloudFailure) { assertEquals("incompleteListing", e.code) }
    }
    @Test fun actualEightMiBBoundaryUsesTwoChunksAndFullReadback() = runTest {
        tempAsync { dir ->
            val binary = ByteArray(6 * 1024 * 1024) { (it % 251).toByte() }
            val bytes = encoded(extra = listOf(entry("Opaque/binary.bin", binary)))
            assertTrue(bytes.size > CloudManifest.CHUNK && bytes.size < CloudManifest.CHUNK * 2)
            val file = File(dir, "snapshot").apply { writeBytes(bytes) }; val dav = FakeDAV(); val cp = arrayListOf<CloudCheckpoint>(); val service = archive(dav, cp)
            val manifest = service.upload(file); assertEquals(2, manifest.chunks.size); assertEquals(CloudManifest.CHUNK, manifest.chunks[0].bytes); assertEquals(bytes.size - CloudManifest.CHUNK, manifest.chunks[1].bytes)
            val target = File(dir, "download"); service.download(manifest.reference, target); assertArrayEquals(bytes, target.readBytes())
            val staged = BackupCodec.stage(target.inputStream(), dir); assertArrayEquals(binary, File(staged.directory, "Opaque/binary.bin").readBytes())
        }
    }
    @Test fun durableCooldownSurvivesNewArchiveInstance() = runTest {
        val dav = FakeDAV().apply { reject = 503 }; var traffic = JSONObject(); val time = 1767225600000L
        fun instance() = CloudArchive("PaperDigest", "00000000-0000-4000-8000-000000000002", { CloudCredentials("fixture", "fixture") }, {}, dav, { time }, {}, 0, { JSONObject(traffic.toString()) }, { traffic = JSONObject(it.toString()) })
        try { instance().probe(); fail() } catch (e: CloudFailure) { assertEquals("throttled", e.code) }
        dav.reject = null; val count = dav.requests.size
        try { instance().probe(); fail() } catch (e: CloudFailure) { assertEquals("throttled", e.code) }
        assertEquals(count, dav.requests.size); assertEquals(time + 120000, traffic.getLong("retryAfter"))
    }
    @Test fun damagedPendingCannotRetargetAndArchivePreservesEveryOriginalByte() = runTest {
        tempAsync { dir ->
            val root = File(dir, "Research").apply { mkdir() }; BackupCodec.atomicJSON(File(root, "personal.json"), personal()); val control = File(dir, "Control")
            val service = CloudService(root, control, MemorySecrets(), object : CloudWorkspace { override suspend fun capture(output: File) = BackupCodec.capture(root, output); override suspend fun restore(staged: BackupCodec.Staged) { error("not requested") } }, FakeDAV())
            service.save("fixture@example.invalid", "PaperDigest", false, 24)
            val id = service.targetID; val folder = File(control, id).apply { mkdir() }; val original = mapOf("pending.json" to byteArrayOf(0, 1), "snapshot.paperdigest" to byteArrayOf(2, 3, 4), "connection.json" to "original connection bytes".toByteArray())
            original.forEach { (name, bytes) -> File(folder, name).writeBytes(bytes) }; assertTrue(service.state().getJSONObject("pending").getBoolean("damaged"))
            try { service.save("different@example.invalid", "Other", false, 24); fail() } catch (_: IllegalArgumentException) { }; assertEquals(id, service.targetID)
            val result = service.archivePending(); val retained = File(control, result.getString("transferID")); original.forEach { (name, bytes) -> assertArrayEquals(bytes, File(retained, name).readBytes()) }
            assertEquals(4, retained.listFiles()!!.size); assertTrue(service.state().getBoolean("automaticPaused")); assertEquals(1, service.retainedList().length()); assertArrayEquals(original["snapshot.paperdigest"], service.retainedSnapshot(retained.name).readBytes())
            service.save("different@example.invalid", "Other", false, 24); assertNotEquals(id, service.targetID)
        }
    }
    private class MemorySecrets : SecretStore { val values = HashMap<String, String>(); override fun save(scope: String, secret: String) { values[scope] = secret }; override fun load(scope: String) = values[scope]; override fun remove(scope: String) { values.remove(scope) } }
    @Test fun stateNeverReadsSecretsAndLocalCredentialFailurePausesWithoutSnapshot() = runTest {
        tempAsync { dir ->
            val root = File(dir, "Research").apply { mkdir() }; BackupCodec.atomicJSON(File(root, "personal.json"), personal())
            var secretReads = 0; val secrets = object : SecretStore { override fun load(scope: String): String? { secretReads++; error("private bait") }; override fun save(scope: String, secret: String) {} ; override fun remove(scope: String) {} }
            val dav = FakeDAV(); val service = CloudService(root, File(dir, "Control"), secrets, object : CloudWorkspace { override suspend fun capture(output: File) = BackupCodec.capture(root, output); override suspend fun restore(staged: BackupCodec.Staged) { error("not requested") } }, dav)
            service.save("fixture@example.invalid", "PaperDigest", true, 24); service.state(); assertEquals(0, secretReads)
            try { service.check(); fail() } catch (e: CloudFailure) { assertEquals("credentialsUnavailable", e.code) }
            assertTrue(service.state().getBoolean("automaticPaused")); assertTrue(dav.requests.isEmpty()); assertFalse(File(dir, "Control").walkTopDown().any { it.name == "snapshot.paperdigest" })
        }
    }
    @Test fun queuedOriginalTargetCannotUploadAfterRetargetBeforeOperationLock() = runTest {
        tempAsync { dir ->
            val root = File(dir, "Research").apply { mkdir() }; BackupCodec.atomicJSON(File(root, "personal.json"), personal())
            var credentialReads = 0; var captures = 0
            val secrets = object : SecretStore { override fun load(scope: String): String? { credentialReads++; return "synthetic-application-password" }; override fun save(scope: String, secret: String) {}; override fun remove(scope: String) {} }
            val dav = FakeDAV(); val control = File(dir, "Control")
            val service = CloudService(root, control, secrets, object : CloudWorkspace { override suspend fun capture(output: File): BackupCodec.Captured { captures++; return BackupCodec.capture(root, output) }; override suspend fun restore(staged: BackupCodec.Staged) { error("not requested") } }, dav)
            service.save("target-a@example.invalid", "PaperDigest", true, 24)
            val originalWorkTarget = service.targetID
            // A real worker can suspend in setForeground/runTask after its
            // preliminary check. The work input still contains this A id.
            service.save("target-b@example.invalid", "PaperDigest", true, 24)
            val currentTarget = service.targetID; assertNotEquals(originalWorkTarget, currentTarget)
            for (automatic in listOf(false, true)) {
                try { service.upload(automatic = automatic, expectedDestinationID = originalWorkTarget); fail("Old work must not adopt a new cloud target") }
                catch (e: CloudFailure) { assertEquals("targetChanged", e.code) }
            }
            assertEquals(0, credentialReads); assertEquals(0, captures); assertTrue(dav.requests.isEmpty())
            assertFalse(service.state().getBoolean("busy")); assertFalse(service.state().getBoolean("automaticPaused")); assertTrue(service.state().isNull("pending"))
            assertFalse(control.walkTopDown().any { it.name in listOf("pending.json", "snapshot.paperdigest") })
            // Rejection releases the same actor; explicit current-target check
            // remains usable and does not inherit an authentication failure.
            service.check(); assertEquals(1, credentialReads); assertEquals(1, dav.requests.size); assertEquals(currentTarget, service.targetID)
        }
    }
}
