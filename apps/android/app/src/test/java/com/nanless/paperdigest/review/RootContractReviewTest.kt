package com.nanless.paperdigest.review

import com.nanless.paperdigest.data.Article
import com.nanless.paperdigest.data.HttpBytes
import com.nanless.paperdigest.data.PersonalStore
import com.nanless.paperdigest.data.canonical
import com.nanless.paperdigest.model.StudyService
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

/** Non-author contract probes. All material is synthetic; no Android user state or real network. */
class RootContractReviewTest {
    private fun article() = JSONObject().put("paperID", "fixture:paper").put("html", "").put("markdown", "# Original synthetic Markdown\n\nA preserved equation: \$x\$.")
        .put("plainText", "Original synthetic Markdown").put("sourceURL", "https://example.invalid/source").put("blogURL", "https://nanless.github.io/audio-paper-digest-blog/fixture/")
        .put("revisionSHA256", "a".repeat(64)).put("fetchedAt", "2026-01-01T00:00:00Z").put("completeOffline", true).put("citation", JSONObject())
        .put("notices", JSONArray(listOf("original warning"))).put("resources", JSONArray()).put("citationFiles", JSONObject().put("ris", "original citation bytes"))
    @Test fun oldMacMarkdownAndCitationDataSurviveTypedRoundTrip() {
        val original = article(); val roundTrip = Article.fromJson(original).json()
        assertEquals(original.getString("markdown"), roundTrip.getString("markdown"))
        assertEquals(canonical(original.getJSONObject("citationFiles")), canonical(roundTrip.getJSONObject("citationFiles")))
    }
    @Test fun legacyMacHTMLIsNotGrantedANewMathParserContract() {
        val original = article().put("html", "<p>synthetic legacy HTML</p>"); original.remove("markdown")
        val roundTrip = Article.fromJson(original).json()
        assertFalse("Legacy bytes have no witness for a newly asserted parser contract", roundTrip.optString("mathMLContract") == "published-html-mathml-v1")
        assertEquals("original warning", roundTrip.getJSONArray("notices").getString(0))
    }
    private fun source() = JSONObject().put("paperID", "fixture:paper").put("kind", "published-guide").put("extractor", "published-html-mathml-v1").put("revision", "a".repeat(64))
    private fun settings(endpoint: String) = JSONObject().put("endpoint", endpoint).put("model", "synthetic-model").put("protocol", "chat").put("maxTokens", 512).put("dailyRequests", 5)
    private fun response() = JSONObject().put("model", "actual-synthetic-model").put("usage", JSONObject().put("prompt_tokens", 2).put("completion_tokens", 3).put("total_tokens", 5))
        .put("choices", JSONArray().put(JSONObject().put("finish_reason", "stop").put("message", JSONObject().put("content", "Synthetic answer only."))))
    @Test fun preparedInputCannotUseAnotherCurrentRoutesCredential() = runBlocking {
        val root = Files.createTempDirectory("route-contract-review-").toRealPath().toFile()
        try {
            val store = PersonalStore(root); store.updateSettings(settings("https://route-a.example.invalid/v1")); var keys = 0; var requests = 0
            val service = StudyService(store, { keys++; "synthetic-route-b-secret" }) { _, _, _, _ -> requests++; HttpBytes(200, emptyMap(), response().toString().toByteArray()) }
            val prepared = service.prepare("fixture:paper", "Synthetic question", "Synthetic source.", source())
            store.updateSettings(settings("https://route-b.example.invalid/v1"))
            runCatching { service.run(prepared.getString("id")) }
            assertEquals("A retired endpoint must not receive the current endpoint's credential", 0, requests)
            assertEquals("Reject incompatible sealed route before reading current secret", 0, keys)
            assertFalse(store.session(prepared.getString("id"))!!.getBoolean("requestIssued"))
        } finally { root.deleteRecursively() }
    }
    @Test fun knownBrokenResponseIntegrityStorageStopsBeforePaidDispatch() = runBlocking {
        val root = Files.createTempDirectory("integrity-preflight-review-").toRealPath().toFile()
        try {
            val store = PersonalStore(root); store.updateSettings(settings("https://route.example.invalid/v1")); var requests = 0
            val service = StudyService(store, { "synthetic-fixture-secret" }) { _, _, _, _ -> requests++; HttpBytes(200, emptyMap(), response().toString().toByteArray()) }
            val prepared = service.prepare("fixture:paper", "Synthetic question", "Synthetic source.", source())
            java.io.File(root, "ModelUsage/response-integrity.android.key").writeBytes(byteArrayOf(1, 2))
            runCatching { service.run(prepared.getString("id")) }
            assertEquals("A known broken response seal must not waste a paid request", 0, requests)
            assertFalse(store.session(prepared.getString("id"))!!.getBoolean("requestIssued"))
        } finally { root.deleteRecursively() }
    }
    @Test fun preparedMuseInputCannotAdoptAnotherCurrentConnectProxy() = runBlocking {
        val root = Files.createTempDirectory("proxy-contract-review-").toRealPath().toFile()
        try {
            val config = settings("https://route.example.invalid/v1").put("model", "muse-spark-synthetic-fixture").put("protocol", "responses").put("httpProxy", "http://127.0.0.1:41001")
            val store = PersonalStore(root); store.updateSettings(config); var keys = 0; var requests = 0
            val service = StudyService(store, { keys++; "synthetic-proxy-fixture-secret" }) { _, _, _, _ -> requests++; HttpBytes(200, emptyMap(), JSONObject().put("status", "completed").put("output_text", "Synthetic response only.").toString().toByteArray()) }
            val prepared = service.prepare("fixture:paper", "Synthetic proxy-bound question", "Synthetic source.", source())
            val file = java.io.File(root, "ModelUsage/${prepared.getString("id")}-input.json"); val original = file.readBytes()
            store.updateSettings(JSONObject().put("httpProxy", "http://127.0.0.1:41002"))
            val failure = runCatching { service.run(prepared.getString("id")) }.exceptionOrNull()
            assertNotNull("Old prepared route must reject before it adopts a different proxy", failure)
            assertEquals("CONNECT route mismatch must stop before reading the current API key", 0, keys)
            assertEquals("CONNECT route mismatch must issue no HTTP", 0, requests)
            assertFalse(store.session(prepared.getString("id"))!!.getBoolean("requestIssued")); assertArrayEquals(original, file.readBytes())
            val sealed = JSONObject(original.toString(Charsets.UTF_8)); assertEquals("http://127.0.0.1:41001", sealed.getJSONObject("config").getString("httpProxy"))
            val current = service.prepare("fixture:paper", "Synthetic proxy-bound question", "Synthetic source.", source())
            assertNotEquals(prepared.getString("fingerprint"), current.getString("fingerprint"))
        } finally { root.deleteRecursively() }
    }
    @Test fun savedRawResponseCannotAuthenticateAlteredUsageOrActualModel() = runBlocking {
        val root = Files.createTempDirectory("usage-contract-review-").toRealPath().toFile()
        try {
            val store = PersonalStore(root); store.updateSettings(settings("https://route.example.invalid/v1")); var requests = 0
            val service = StudyService(store, { "synthetic-fixture-secret" }) { _, _, _, _ -> requests++; HttpBytes(200, emptyMap(), response().toString().toByteArray()) }
            val prepared = service.prepare("fixture:paper", "Synthetic question", "Synthetic source.", source()); val saved = service.run(prepared.getString("id"))
            val variants = listOf(JSONObject(saved.toString()).put("usage", JSONObject().put("total_tokens", 999999)), JSONObject(saved.toString()).put("actualModel", "forged-model"))
            for (tampered in variants) {
                val result = runCatching { service.verifySaved(tampered) }.getOrNull()
                if (result != null) {
                    assertEquals("A successful verification must return actual raw provider usage", canonical(saved.getJSONObject("usage")), canonical(result.getJSONObject("usage")))
                    assertEquals("actual-synthetic-model", result.getString("actualModel"))
                }
            }
            assertEquals(1, requests)
        } finally { root.deleteRecursively() }
    }
}
