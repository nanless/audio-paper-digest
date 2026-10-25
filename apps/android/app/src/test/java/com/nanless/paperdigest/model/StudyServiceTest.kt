package com.nanless.paperdigest.model

import com.nanless.paperdigest.data.*
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files

class StudyServiceTest {
    private fun config(protocol: String = "chat") = JSONObject().put("endpoint", "https://models.example/v1").put("model", "research-model").put("protocol", protocol).put("dailyRequests", 2)
    private fun store(): PersonalStore = PersonalStore(Files.createTempDirectory("paperdigest-study-").toRealPath().toFile()).also { it.updateSettings(config()) }
    private fun source() = JSONObject().put("paperID", "local:test").put("kind", "range").put("extractor", "android-pdfbox-physical-pages-v1").put("pages", JSONArray(listOf(1, 2))).put("pdfSHA", "a".repeat(64))
    private fun response(reason: String = "stop") = JSONObject().put("model", "actual-model").put("usage", JSONObject().put("prompt_tokens", 40).put("completion_tokens", 20))
        .put("choices", JSONArray().put(JSONObject().put("finish_reason", reason).put("message", JSONObject().put("content", "根据[p.1]，该结果有明确条件。"))))
    @Test fun completeResponseSealsActualInputAndRawOutputAndReusesExactFingerprint() = runBlocking {
        val store = store(); var calls = 0
        val bytes = response().toString().toByteArray()
        val service = StudyService(store, { "synthetic-fixture-key" }) { request, _, _, _ ->
            calls++; assertEquals("Bearer synthetic-fixture-key", request.header("Authorization")); HttpBytes(200, emptyMap(), bytes)
        }
        val prepared = service.prepare("local:test", "方法是什么", "[p.1] 实际论文材料", source())
        val done = service.run(prepared.getString("id"))
        assertEquals("completed", done.getString("status")); assertEquals(1, calls)
        assertEquals("actual-model", done.getString("actualModel")); assertFalse(done.getBoolean("costKnown"))
        assertArrayEquals(bytes, File(store.directory, "ModelUsage/${done.getString("id")}-response.bin").readBytes())
        val input = File(store.directory, "ModelUsage/${done.getString("id")}-input.json").readText()
        assertFalse(input.contains("synthetic-fixture-key")); assertTrue(input.contains("android-study-input-v1"))
        assertTrue(service.prepare("local:test", "方法是什么", "[p.1] 实际论文材料", source()).getBoolean("reused"))
        assertEquals(1, calls)
    }
    @Test fun truncationKeepsResponseCountsIssuedAndNeverAutomaticallyRetries() = runBlocking {
        val store = store(); var calls = 0
        val service = StudyService(store, { "fixture" }) { _, _, _, _ -> calls++; HttpBytes(200, emptyMap(), response("length").toString().toByteArray()) }
        val id = service.prepare("local:test", "解释", "[p.1] paper", source()).getString("id")
        try { service.run(id); fail("truncation accepted") } catch (_: IllegalArgumentException) { }
        val failed = store.session(id)!!
        assertEquals("failed", failed.getString("status")); assertTrue(failed.getBoolean("requestIssued"))
        assertTrue(File(store.directory, "ModelUsage/$id-response.bin").exists())
        try { service.run(id); fail("reissued") } catch (_: IllegalArgumentException) { }
        assertEquals(1, calls)
    }
    @Test fun credentialFailureDoesNotIssueOrConsumeBudget() = runBlocking {
        val store = store(); val service = StudyService(store, { null }) { _, _, _, _ -> error("network must not run") }
        val id = service.prepare("local:test", "问题", "material", source()).getString("id")
        try { service.run(id); fail("missing credential") } catch (e: AppFailure) { assertEquals("credentialsUnavailable", e.category) }
        assertFalse(store.session(id)!!.getBoolean("requestIssued")); assertFalse(File(store.directory, "RequestBudgetContinuity.json").exists())
    }
    @Test fun budgetIncludesFailedIssuedRequests() = runBlocking {
        val store = store(); store.updateSettings(JSONObject().put("dailyRequests", 1)); var calls = 0
        val service = StudyService(store, { "fixture" }) { _, _, _, _ -> calls++; HttpBytes(401, emptyMap(), "{}".toByteArray()) }
        val one = service.prepare("local:test", "问题一", "material", source()).getString("id")
        try { service.run(one) } catch (_: AppFailure) { }
        val two = service.prepare("local:test", "问题二", "material", source()).getString("id")
        try { service.run(two); fail("budget exceeded") } catch (_: IllegalArgumentException) { }
        assertEquals(1, calls); assertFalse(store.session(two)!!.getBoolean("requestIssued"))
    }
    @Test fun tamperedInputStopsBeforeNetwork() = runBlocking {
        val store = store(); val service = StudyService(store, { "fixture" }) { _, _, _, _ -> error("network must not run") }
        val id = service.prepare("local:test", "问题", "material", source()).getString("id")
        File(store.directory, "ModelUsage/$id-input.json").appendText(" ")
        try { service.run(id); fail("tamper accepted") } catch (_: IllegalArgumentException) { }
        assertFalse(store.session(id)!!.getBoolean("requestIssued"))
    }
    @Test fun protocolRoutingProxyRulesAndInputIdentityAreExplicit() {
        val muse = StudyService.validatedConfig(config("auto").put("model", "muse-spark-1.3-contributor"))
        assertEquals("responses", muse.getString("protocol")); assertEquals("https://models.example/v1/responses", StudyService.apiURL(muse))
        assertThrows(IllegalArgumentException::class.java) { StudyService.validatedConfig(config("chat").put("model", "muse-spark-1.3-contributor")) }
        assertThrows(IllegalArgumentException::class.java) { StudyService.validatedConfig(config().put("endpoint", "http://public.example/v1")) }
        val full = StudyService.validatedConfig(config().put("endpoint", "https://models.example/v1/chat/completions"))
        assertEquals("https://models.example/v1/chat/completions", StudyService.apiURL(full))
    }
    @Test fun sseRequiresOneCompletedNontruncatedResponse() {
        val completed = JSONObject().put("status", "completed").put("output_text", "完整")
        val event = JSONObject().put("type", "response.completed").put("response", completed)
        val bytes = "event: response.completed\ndata: $event\n\n".toByteArray()
        assertEquals("完整", StudyService.responseText(StudyService.decodeResponse(bytes, true), "responses"))
        assertThrows(AppFailure::class.java) { StudyService.decodeResponse("data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n".toByteArray(), true) }
        assertThrows(IllegalArgumentException::class.java) { StudyService.decodeResponse(bytes + bytes, true) }
        assertThrows(IllegalArgumentException::class.java) { StudyService.responseText(completed.put("status", "incomplete"), "responses") }
    }
}
