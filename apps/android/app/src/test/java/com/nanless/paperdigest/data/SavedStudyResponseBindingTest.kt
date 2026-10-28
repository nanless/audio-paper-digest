package com.nanless.paperdigest.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** Synthetic fixtures transcribed from StudyService.run and ModelService.run archive schemas.
 * No real credentials, local integrity keys, provider access or transport is involved.
 */
class SavedStudyResponseBindingTest {
    private val id = "f3285a09-2267-4bd3-a597-b705de0030d1"
    private val captureID = "a3285a09-2267-4bd3-a597-b705de0030d1"
    private data class Fixture(val root: File, val record: JSONObject, val input: ByteArray, val android: Boolean) {
        fun file(suffix: String) = File(root, "ModelUsage/${record.getString("id")}-$suffix")
        fun read() = readSavedStudyInput(record, root)
    }
    private fun fixture(android: Boolean): Fixture {
        val source = JSONObject().put("paperID", "fixture-paper").put("kind", "pdf-selection")
            .put("pdfSHA", "a".repeat(64)).put("pages", JSONArray(listOf(2)))
        val config = JSONObject().put("model", "synthetic-model").put("endpoint", "https://example.invalid/v1")
            .put("protocol", "chat").put("maxTokens", 8192)
        val evidence = "Synthetic original selection."
        val messages = JSONArray().put(JSONObject().put("role", "system").put("content", "Synthetic instructions"))
            .put(JSONObject().put("role", "user").put("content", "研究问题：\nWhy?\n\n来源身份：\n${if (android) canonical(source) else desktopStudyJSON(source)}\n\n实际证据：\n$evidence"))
        val identity = if (android) JSONObject().put("contract", "android-study-v1")
            .put("extractor", "published-html-mathml-v1").put("kind", "study").put("paperID", "fixture-paper")
            .put("question", "Why?").put("messages", messages).put("source", source).put("config", config)
        else JSONObject().put("contract", "desktop-study-v4").put("extractor", "pdfkit-physical-pages-v1")
            .put("kind", "study").put("paperID", "fixture-paper").put("question", "Why?")
            .put("messages", messages).put("source", source).put("model", config.get("model"))
            .put("endpoint", config.get("endpoint")).put("protocol", "chat").put("maxTokens", 8192)
            .put("evidence", evidence).put("responsesStream", false).put("reasoningEffort", "default")
        val fingerprint = sha256((if (android) canonical(identity) else desktopStudyJSON(identity)).toByteArray())
        val sealed = JSONObject().put("config", config).put("messages", messages).put("source", source).put("fingerprint", fingerprint)
        if (android) sealed.put("contract", "android-study-input-v1").put("identity", identity)
        val input = (if (android) canonical(sealed) else desktopStudyJSON(sealed)).toByteArray()
        val record = JSONObject().put("id", id).put("kind", "study").put("paperID", "fixture-paper")
            .put("question", "Why?").put("source", source).put("fingerprint", fingerprint).put("model", "synthetic-model")
            .put("inputSHA256", sha256(input)).put("startedAt", "2026-10-28T00:00:00Z")
            .put("status", "pending").put("requestIssued", true)
        val root = Files.createTempDirectory("synthetic-study-response-").toFile()
        File(root, "ModelUsage").mkdir()
        return Fixture(root, record, input, android).also { it.file("input.json").writeBytes(input) }
    }
    private fun saveResponse(f: Fixture) {
        if (f.android) {
            val body = "{\"choices\":[{\"message\":{\"content\":\"Synthetic answer\"}}]}".toByteArray()
            f.file("response.bin").writeBytes(body)
            f.record.put("responseSHA256", sha256(body)).put("httpStatus", 200).put("status", "completed")
                .put("answer", "Synthetic answer").put("text", "Synthetic answer").put("response", "Synthetic answer")
            val receipt = JSONObject().put("contract", "android-model-response-v1").put("sessionID", id)
                .put("inputSHA256", f.record.get("inputSHA256")).put("sha256", sha256(body)).put("httpStatus", 200)
                .put("startedAt", f.record.get("startedAt")).put("receivedAt", "2026-10-28T00:00:01Z")
                .put("hmacSHA256", "synthetic-opaque-not-authenticated")
            f.file("response.json").writeText(canonical(receipt))
        } else {
            // ModelService stores the worker's normalized text IN the recovery envelope;
            // it does not produce a UUID-response.bin file or a responseSHA256 field.
            f.record.put("status", "complete").put("text", "Synthetic answer").put("response", "Synthetic answer")
                .put("endedAt", "2026-10-28T00:00:01Z").put("protocol", "openai").put("finishStatus", "stop")
            f.file("response.json").writeText(canonical(JSONObject().put("contract", "desktop-model-response-recovery-v1")
                .put("session", f.record.copy()).put("mac", "synthetic-opaque-not-authenticated")))
        }
    }
    @Test fun actualAndroidAndMacSchemasBindExactOriginalReceiptWithoutSecretsOrMutation() {
        for (android in listOf(true, false)) {
            val f = fixture(android)
            try {
                saveResponse(f)
                val recordBefore = f.record.toString()
                val receiptBefore = f.file("response.json").readBytes()
                val bound = f.read()!!
                assertNotNull(bound.originalResponseBinding)
                assertNull(savedStudySource(f.record)!!.originalResponseBinding)
                assertNull(verifiedSavedStudyInput(f.record, f.input)!!.originalResponseBinding)
                assertEquals(bound, f.read())
                assertEquals(recordBefore, f.record.toString())
                assertArrayEquals(receiptBefore, f.file("response.json").readBytes())
                assertArrayEquals(f.input, f.file("input.json").readBytes())
                // Semantically identical receipt, different exact bytes => final-read CAS differs.
                f.file("response.json").appendText("\n")
                assertNotEquals(bound.originalResponseBinding, f.read()!!.originalResponseBinding)
            } finally { f.root.deleteRecursively() }
        }
    }
    @Test fun declaredResponseMissingReceiptWrongSessionWrongInputAndMutatedBodyFailClosed() {
        for (android in listOf(true, false)) for (mutation in listOf("delete", "session", "input", "body")) {
            val f = fixture(android)
            try {
                saveResponse(f)
                val receiptFile = f.file("response.json")
                when (mutation) {
                    "delete" -> assertTrue(receiptFile.delete())
                    "body" -> if (android) f.file("response.bin").appendText("changed") else {
                        val receipt = JSONObject(receiptFile.readText())
                        receipt.getJSONObject("session").put("text", "Changed").put("response", "Changed")
                        receiptFile.writeText(canonical(receipt))
                    }
                    else -> {
                        val receipt = JSONObject(receiptFile.readText())
                        val target = if (android) receipt else receipt.getJSONObject("session")
                        target.put(if (mutation == "session") { if (android) "sessionID" else "id" } else "inputSHA256",
                            if (mutation == "session") captureID else "b".repeat(64))
                        receiptFile.writeText(canonical(receipt))
                    }
                }
                val recordBefore = f.record.toString()
                assertNull("$android/$mutation", f.read())
                assertEquals(recordBefore, f.record.toString())
                assertNotNull(verifiedSavedStudyInput(f.record, f.input)) // Pure input verifier stays pure.
            } finally { f.root.deleteRecursively() }
        }
    }
    @Test fun missingRawBodyAndSymlinkReceiptOrBodyNeverFallBack() {
        for (target in listOf("response.bin", "response.json")) {
            val f = fixture(true)
            try {
                saveResponse(f)
                val file = f.file(target)
                val copy = File(f.root, "outside-original").also { it.writeBytes(file.readBytes()) }
                assertTrue(file.delete())
                assertNull(f.read())
                Files.createSymbolicLink(file.toPath(), copy.toPath())
                assertNull(f.read())
            } finally { f.root.deleteRecursively() }
        }
    }
    @Test fun preparedPendingAndFailedIssuedWithoutResponseRemainPureInputEquivalent() {
        for (android in listOf(true, false)) {
            val f = fixture(android)
            try {
                for (status in listOf("prepared", "pending", "failed", "interrupted")) {
                    f.record.put("status", status).put("requestIssued", status != "prepared")
                    assertEquals(verifiedSavedStudyInput(f.record, f.input), f.read())
                    assertNull(f.read()!!.originalResponseBinding)
                }
            } finally { f.root.deleteRecursively() }
        }
    }
    @Test fun actualEmptyCaptureIsNotAResponseButCapturedHttpFactsRequireFixedOriginals() {
        val f = fixture(true)
        try {
            val base = "response-capture-$captureID"
            f.file("$base.bin").writeBytes(byteArrayOf())
            val capture = JSONObject().put("contract", "android-http-response-capture-v1").put("sessionID", id)
                .put("inputSHA256", f.record.get("inputSHA256")).put("captureID", captureID)
                .put("startedAt", f.record.get("startedAt")).put("requestIssued", true).put("status", "failed")
                .put("httpStatus", JSONObject.NULL).put("byteCount", 0).put("sha256", sha256(byteArrayOf()))
                .put("updatedAt", "2026-10-28T00:00:01Z").put("hmacSHA256", "synthetic-only")
            f.file("$base.json").writeText(canonical(capture))
            assertEquals(verifiedSavedStudyInput(f.record, f.input), f.read())
            capture.put("httpStatus", 200)
            f.file("$base.json").writeText(canonical(capture))
            assertNull(f.read()) // HTTP response was observed; never silently degrade to input-only.
            saveResponse(f)
            assertNotNull(f.read()!!.originalResponseBinding)
        } finally { f.root.deleteRecursively() }
    }
}
