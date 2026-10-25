package com.nanless.paperdigest.review

import com.nanless.paperdigest.cloud.RequestContinuity
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.model.StudyService
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** Non-author probes: actual local HTTP protocol faults, original producer signatures, no real credentials. */
class ModelCaptureProtocolReviewTest {
    private class Fixture : AutoCloseable {
        val server = MockWebServer().also { it.start() }
        val root = Files.createTempDirectory("capture-protocol-review-").toRealPath().toFile()
        val store = PersonalStore(root)
        var keys = 0
        val service = StudyService(store, { keys++; "synthetic-only" })
        val body = JSONObject().put("model", "synthetic-provider").put("choices", JSONArray().put(JSONObject().put("finish_reason", "stop").put("message", JSONObject().put("content", "A complete JSON answer is not proof of completed HTTP.")))).toString()
        init { store.updateSettings(JSONObject().put("endpoint", server.url("/v1").toString().trimEnd('/')).put("model", "synthetic-requested").put("protocol", "chat").put("timeoutMs", 5000)) }
        suspend fun prepare() = service.prepare("local:protocol-fixture", "Synthetic question", "Synthetic evidence", JSONObject().put("paperID", "local:protocol-fixture")).getString("id")
        fun capture(id: String): File = File(root, "ModelUsage").listFiles()!!.single { it.name.startsWith("$id-response-capture-") && it.name.endsWith(".json") }
        fun bytes() = root.walkTopDown().filter { it.isFile }.associate { it.relativeTo(root).path to it.readBytes() }
        fun unchanged(before: Map<String, ByteArray>) { assertEquals(before.keys, bytes().keys); before.forEach { (path, raw) -> assertArrayEquals(path, raw, File(root, path).readBytes()) } }
        override fun close() { server.shutdown(); root.deleteRecursively() }
    }
    @Test fun validJsonFromPrematureHttpEofRemainsPartialAndCannotBePromoted() = runBlocking {
        Fixture().use { f ->
            f.server.enqueue(MockResponse().setBody(f.body).setHeader("Content-Length", f.body.toByteArray().size + 100).setSocketPolicy(SocketPolicy.DISCONNECT_AT_END))
            val id = f.prepare(); assertTrue(runCatching { f.service.run(id) }.isFailure)
            val manifest = f.capture(id); val record = JSONObject(manifest.readText()); val raw = File(manifest.path.removeSuffix(".json") + ".bin").readBytes()
            assertEquals(f.body, raw.toString(Charsets.UTF_8)); assertEquals("failed", record.getString("status")); assertEquals(raw.size.toLong(), record.getLong("byteCount")); assertEquals(sha256(raw), record.getString("sha256"))
            val before = f.bytes(); f.keys = 0
            assertTrue(runCatching { f.service.recoverSaved(id) }.isFailure)
            assertEquals(0, f.keys); assertEquals(1, f.server.requestCount); assertEquals(1, RequestContinuity.read(f.root).size); assertEquals("failed", f.store.session(id)!!.getString("status")); f.unchanged(before)
        }
    }
    @Test fun fullyReceivedErrorHttpCannotPromoteAnAnswerLookingBody() = runBlocking {
        Fixture().use { f ->
            f.server.enqueue(MockResponse().setResponseCode(500).setBody(f.body))
            val id = f.prepare(); assertTrue(runCatching { f.service.run(id) }.isFailure)
            assertEquals("body-complete", JSONObject(f.capture(id).readText()).getString("status"))
            assertTrue(File(f.root, "ModelUsage/$id-response.bin").delete()); assertTrue(File(f.root, "ModelUsage/$id-response.json").delete())
            val before = f.bytes(); f.keys = 0
            assertTrue(runCatching { f.service.recoverSaved(id) }.isFailure)
            assertEquals(0, f.keys); assertEquals(1, f.server.requestCount); assertEquals(1, RequestContinuity.read(f.root).size); f.unchanged(before)
        }
    }
    @Test fun knownDanglingFinalResponseLinkDoesNotIssueHttpOrSpendBudget() = runBlocking {
        Fixture().use { f ->
            val id = f.prepare(); val target = File(f.root, "ModelUsage/$id-response.bin")
            Files.createSymbolicLink(target.toPath(), File(f.root, "missing-original").toPath())
            assertTrue(runCatching { f.service.run(id) }.isFailure)
            assertEquals(0, f.server.requestCount); assertFalse(f.store.session(id)!!.getBoolean("requestIssued")); assertFalse(File(f.root, RequestContinuity.FILE).exists()); assertTrue(Files.isSymbolicLink(target.toPath()))
        }
    }
    @Test fun invalidExplicitPortsAreConfigurationFaultsBeforeInputOrIssuedRecords() = runBlocking {
        for (port in listOf(0, 65536)) Fixture().use { f ->
            f.store.updateSettings(JSONObject().put("endpoint", "http://localhost:$port/v1"))
            val before = f.bytes()
            assertTrue("Invalid explicit port $port must be rejected while preparing, before a paid-issued record can be created", runCatching { f.prepare() }.isFailure)
            assertEquals(0, f.keys); assertEquals(0, f.server.requestCount); assertFalse(File(f.root, RequestContinuity.FILE).exists()); f.unchanged(before)
        }
    }
}
