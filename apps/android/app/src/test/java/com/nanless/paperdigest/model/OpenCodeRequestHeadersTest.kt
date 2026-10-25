package com.nanless.paperdigest.model

import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.cloud.RequestContinuity
import kotlinx.coroutines.runBlocking
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files

class OpenCodeRequestHeadersTest {
    private val id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    private fun request() = Request.Builder().url("https://request.invalid/v1").header("Authorization", "Bearer synthetic-key").build()
    private fun config(endpoint: String, muse: Boolean = false) = JSONObject().put("endpoint", endpoint).put("model", if (muse) "muse-spark-synthetic" else "synthetic-model")
        .put("protocol", if (muse) "responses" else "chat").put("httpProxy", "http://127.0.0.1:7897").put("dailyRequests", 20)
    private fun store(endpoint: String, muse: Boolean = false): PersonalStore = PersonalStore(Files.createTempDirectory("opencode-header-").toRealPath().toFile()).also { it.updateSettings(config(endpoint, muse)) }
    private fun source() = JSONObject().put("paperID", "local:synthetic").put("kind", "range").put("extractor", "android-pdfbox-physical-pages-v1").put("pages", JSONArray(listOf(1))).put("pdfSHA", "a".repeat(64))
    private fun answer(responses: Boolean = false): ByteArray = (if (responses) JSONObject().put("status", "completed").put("output_text", "原材料[p.1]内的回答").put("model", "actual-synthetic").put("usage", JSONObject().put("input_tokens", 4).put("output_tokens", 2))
        else JSONObject().put("model", "actual-synthetic").put("usage", JSONObject().put("prompt_tokens", 4).put("completion_tokens", 2)).put("choices", JSONArray().put(JSONObject().put("finish_reason", "stop").put("message", JSONObject().put("content", "原材料[p.1]内的回答"))))).toString().toByteArray()
    private fun materialBytes(root: File): Map<String, ByteArray> = root.walkTopDown().filter { it.isFile }.associate { it.relativeTo(root).path to it.readBytes() }
    private fun sameBytes(before: Map<String, ByteArray>, root: File) { val after = materialBytes(root); assertEquals(before.keys, after.keys); before.forEach { (name, bytes) -> assertArrayEquals(name, bytes, after.getValue(name)) } }

    @Test fun originalEndpointMatrixAddsMetadataOnlyToUnambiguousHttpsGoRoutes() {
        val vectors = listOf(
            "https://opencode.ai/zen/go" to true,
            "https://opencode.ai/zen/go/" to true,
            "https://opencode.ai/zen/go/v1/responses" to true,
            "https://OPENCODE.AI/ZEN/GO/v1" to true,
            "https://opencode.ai:443/zen/go/v1" to true,
            "https://opencode.ai:444/zen/go/v1" to false,
            "http://opencode.ai/zen/go/v1" to false,
            "https://opencode.ai/zen/v1" to false,
            "https://opencode.ai/zen/gopher" to false,
            "https://opencode.ai/zen/goevil/v1" to false,
            "https://opencode.ai.evil.invalid/zen/go/v1" to false,
            "https://evil.invalid/zen/go/v1" to false,
            "https://opencode.ai./zen/go/v1" to false,
            "https://user@opencode.ai/zen/go/v1" to false,
            "https://user:pass@opencode.ai/zen/go/v1" to false,
            "https://opencode.ai/zen/go/v1?x=1" to false,
            "https://opencode.ai/zen/go/v1#x" to false,
            "https://opencode.ai/zen/go/v1?" to false,
            "https://opencode.ai/zen/go/v1#" to false,
            "https://opencode.ai/zen/go/../v1" to false,
            "https://opencode.ai/zen/./go/v1" to false,
            "https://opencode.ai/zen/go/%2e%2e/v1" to false,
            "https://opencode.ai/zen/go/%2E/v1" to false,
            "https://opencode.ai/zen/go%2fv1" to false,
            "https://opencode.ai/zen/go/%2Fv1" to false,
            "https://opencode.ai/zen/go/%5cv1" to false,
            "https://opencode.ai/zen/go/\\v1" to false,
            "https://opencode.ai\\@evil.invalid/zen/go/v1" to false,
            "https://opencode.ai/zen/go/%zz" to false,
            "https://opencode.ai/zen/go/%C3%28" to false,
            "https://opencode.ai/zen/go/%E2%82%AC" to true,
            "https://opencode.ai/zen/go//v1" to true,
            "https://opencode.ai/zen//go/v1" to false,
            "https://opencode.ai/zen/go///" to true,
            "https://opencode.ai/zen/go2" to false,
            " https://opencode.ai/zen/go/v1" to false,
            "https://opencode.ai/zen/%67o/v1" to false,
            "https://opencode.ai/zen/go/v1/%252e%252e" to true,
            "https://opencode.ai:0443/zen/go/v1" to true
        )
        for ((endpoint, accepted) in vectors) {
            val original = request(); val actual = OpenCodeRequestHeaders.apply(endpoint, id, original)
            assertEquals(endpoint, accepted, OpenCodeRequestHeaders.isGoEndpoint(endpoint))
            assertEquals(endpoint, if (accepted) "audio-paper-digest/1.0" else null, actual.header("User-Agent"))
            assertEquals(endpoint, if (accepted) "audio-paper-digest-$id" else null, actual.header("x-opencode-session"))
            assertEquals("Bearer synthetic-key", actual.header("Authorization")); assertEquals(original.url, actual.url); assertSame(original.body, actual.body)
            if (!accepted) assertSame(original, actual)
        }
    }
    @Test fun callerMetadataIsPreservedCaseInsensitivelyIncludingMultipleValues() {
        val original = request().newBuilder().addHeader("uSeR-aGeNt", "caller-agent").addHeader("X-OPENCODE-SESSION", "caller-session").addHeader("x-opencode-session", "caller-second").build()
        val actual = OpenCodeRequestHeaders.apply("https://opencode.ai/zen/go/v1", id, original)
        assertEquals(original.headers, actual.headers); assertEquals(listOf("caller-session", "caller-second"), actual.headers("x-opencode-session"))
        val onlyUA = request().newBuilder().header("User-agent", "").build(); val withSID = OpenCodeRequestHeaders.apply("https://opencode.ai/zen/go/v1", id, onlyUA)
        assertEquals("", withSID.header("User-Agent")); assertEquals("audio-paper-digest-$id", withSID.header("x-opencode-session"))
    }
    @Test fun nonGoRoutesDoNotEvenConsumeSessionIdentityAndGoRequiresCanonicalUuid() {
        val original = request(); assertSame(original, OpenCodeRequestHeaders.apply("https://other.invalid/v1", "not-a-session", original))
        for (bad in listOf("", "not-a-session", "1-1-1-1-1", id.uppercase())) assertThrows(IllegalArgumentException::class.java) { OpenCodeRequestHeaders.apply("https://opencode.ai/zen/go/v1", bad, original) }
    }
    @Test fun actualStudyRunCapturesHeadersFromItsSealedSessionWithoutChangingInput() = runBlocking {
        val store = store("https://opencode.ai/zen/go/v1", true); var calls = 0; var keys = 0; var expectedID = ""
        val raw = answer(true)
        val service = StudyService(store, { keys++; "synthetic-key" }) { request, _, proxy, _ ->
            calls++; assertEquals("audio-paper-digest/1.0", request.header("User-Agent")); assertEquals("audio-paper-digest-$expectedID", request.header("x-opencode-session"))
            assertEquals("Bearer synthetic-key", request.header("Authorization")); assertEquals("http://127.0.0.1:7897", proxy)
            assertEquals("https://opencode.ai/zen/go/v1/responses", request.url.toString()); HttpBytes(200, emptyMap(), raw)
        }
        val prepared = service.prepare("local:synthetic", "问题", "[p.1] 实际假材料", source()); expectedID = prepared.getString("id")
        val input = File(store.directory, "ModelUsage/$expectedID-input.json"); val before = input.readBytes()
        assertEquals(prepared.getString("inputSHA256"), sha256(before))
        val done = service.run(expectedID); assertEquals("completed", done.getString("status")); assertEquals(1, calls); assertEquals(1, keys)
        assertArrayEquals(before, input.readBytes()); assertArrayEquals(raw, File(store.directory, "ModelUsage/$expectedID-response.bin").readBytes())
        assertEquals(1, RequestContinuity.read(store.directory).size)
    }
    @Test fun actualDistinctStudyIdsHaveDistinctStableSessionHeadersAndCompletedRunDoesNotReissue() = runBlocking {
        val store = store("https://OPENCODE.AI/ZEN/GO/v1"); var calls = 0; var keys = 0; val observed = mutableListOf<String>()
        val service = StudyService(store, { keys++; "synthetic-key" }) { request, _, _, _ -> calls++; observed += request.header("x-opencode-session") ?: "missing"; HttpBytes(200, emptyMap(), answer()) }
        val first = service.prepare("local:synthetic", "问题一", "材料", source()).getString("id"); service.run(first)
        val second = service.prepare("local:synthetic", "问题二", "材料", source()).getString("id"); service.run(second)
        assertNotEquals(first, second); assertEquals(listOf("audio-paper-digest-$first", "audio-paper-digest-$second"), observed)
        val materials = materialBytes(File(store.directory, "ModelUsage")); val ledger = File(store.directory, RequestContinuity.FILE).readBytes()
        service.run(first); assertEquals(2, calls); assertEquals(2, keys); assertEquals(2, RequestContinuity.read(store.directory).size)
        sameBytes(materials, File(store.directory, "ModelUsage")); assertArrayEquals(ledger, File(store.directory, RequestContinuity.FILE).readBytes())
    }
    @Test fun actualStudyRunDoesNotAttachGoMetadataToZenOrdinaryOrOtherHosts() = runBlocking {
        for (endpoint in listOf("https://opencode.ai/zen/v1", "https://opencode.ai/zen/goevil/v1", "https://opencode.ai.evil.invalid/zen/go/v1", "https://other.invalid/zen/go/v1")) {
            val store = store(endpoint); var calls = 0
            val service = StudyService(store, { "synthetic-key" }) { request, _, _, _ -> calls++; assertNull(request.header("x-opencode-session")); assertNull(request.header("User-Agent")); HttpBytes(200, emptyMap(), answer()) }
            service.run(service.prepare("local:synthetic", "问题", "材料", source()).getString("id")); assertEquals(1, calls)
        }
    }
    @Test fun failedIssuedHttp400RemainsOriginalAndNeverReentersTransportForSameId() = runBlocking {
        val store = store("https://opencode.ai/zen/go/v1"); var keys = 0; var calls = 0
        val rejected = "{\"error\":{\"message\":\"Missing x-opencode-session\"}}".toByteArray()
        val service = StudyService(store, { keys++; "synthetic-key" }) { _, _, _, _ -> calls++; HttpBytes(400, emptyMap(), rejected) }
        val id = service.prepare("local:synthetic", "问题", "材料", source()).getString("id")
        try { service.run(id); fail("HTTP400 accepted") } catch (_: AppFailure) { }
        val old = store.session(id)!!; assertEquals("failed", old.getString("status")); assertEquals(400, old.getInt("httpStatus")); assertTrue(old.getBoolean("requestIssued")); assertEquals("unknown", old.getString("charge")); assertFalse(old.optBoolean("costKnown"))
        assertArrayEquals(rejected, File(store.directory, "ModelUsage/$id-response.bin").readBytes())
        val materials = materialBytes(File(store.directory, "ModelUsage")); val ledger = File(store.directory, RequestContinuity.FILE).readBytes(); val personal = File(store.directory, "personal.json").readBytes()
        try { service.run(id); fail("old rejected response adopted") } catch (_: Exception) { }
        assertEquals(1, calls); assertEquals(1, keys); assertEquals(1, RequestContinuity.read(store.directory).size)
        sameBytes(materials, File(store.directory, "ModelUsage")); assertArrayEquals(ledger, File(store.directory, RequestContinuity.FILE).readBytes()); assertArrayEquals(personal, File(store.directory, "personal.json").readBytes())
    }
}
