package com.nanless.paperdigest.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files

class SavedStudyInputTest {
    private val id = "f3285a09-2267-4bd3-a597-b705de0030d1"
    private fun fixture(): Pair<JSONObject, JSONObject> {
        val source = JSONObject().put("paperID", "original-owner").put("kind", "pdf-range")
            .put("pdfSHA", "a".repeat(64)).put("pages", JSONArray(listOf(2, 3)))
            .put("extractor", "android-pdfbox-physical-pages-v1").put("missingTextPages", JSONArray())
        val config = JSONObject().put("model", "original-model").put("endpoint", "https://example.invalid/v1")
            .put("protocol", "chat").put("maxTokens", 8192)
        val messages = JSONArray().put(JSONObject().put("role", "system").put("content", "Original instructions"))
            .put(JSONObject().put("role", "user").put("content", "研究问题：\nWhy?\n\n来源身份：\n${canonical(source)}\n\n实际证据：\n[原文物理页 2]\nOriginal two\n\n[原文物理页 3]\nOriginal three"))
        val identity = JSONObject().put("contract", "android-study-v1").put("extractor", source.get("extractor"))
            .put("kind", "study").put("paperID", "original-owner").put("question", "Why?")
            .put("messages", messages).put("source", source).put("config", config)
        val fingerprint = sha256(canonical(identity).toByteArray())
        val sealed = JSONObject().put("contract", "android-study-input-v1").put("config", config)
            .put("messages", messages).put("source", source).put("fingerprint", fingerprint).put("identity", identity)
        val summary = JSONObject().put("id", id).put("kind", "study").put("paperID", "original-owner")
            .put("question", "Why?").put("model", "original-model").put("source", source.copy())
            .put("fingerprint", fingerprint)
        return summary to sealed
    }
    private fun bind(summary: JSONObject, sealed: JSONObject): ByteArray = sealed.toString().toByteArray().also {
        summary.put("inputSHA256", sha256(it))
    }
    @Test fun verifiesExactBytesWithoutHmacResponseFeesOrMutation() {
        val (summary, sealed) = fixture(); val bytes = bind(summary, sealed)
        val before = summary.toString()
        val source = verifiedSavedStudyInput(summary, bytes)!!
        assertEquals(listOf(2, 3), source.pages); assertEquals("a".repeat(64), source.pdfSHA)
        assertEquals(sha256(bytes), source.inputSHA); assertEquals(before, summary.toString())
        assertEquals(source, verifiedSavedStudyInput(summary.copy().put("answer", "page 99").put("charge", "unknown"), bytes))
        sealed.getJSONObject("source").getJSONArray("pages").put(0, 99)
        assertEquals(listOf(2, 3), source.pages)
    }
    @Test fun summaryShaAloneAndChangedOriginalBytesNeverAuthorizeNavigation() {
        val (summary, sealed) = fixture(); val bytes = bind(summary, sealed)
        assertNull(verifiedSavedStudyInput(summary, bytes + byteArrayOf(32)))
        assertNull(verifiedSavedStudyInput(summary, byteArrayOf()))
        assertNull(verifiedSavedStudyInput(summary, "{}".toByteArray()))
        assertNotNull(savedStudySource(summary)) // projection is deliberately not a capability
    }
    @Test fun eachOfThreeSourcesMustAgreeEvenWithRehashedOuterBytes() {
        for (which in 0..2) {
            val (summary, sealed) = fixture()
            // Detach shared fixture JSON before modifying just one source.
            val input = JSONObject(sealed.toString())
            val changed = when (which) { 0 -> summary.getJSONObject("source"); 1 -> input.getJSONObject("source"); else -> input.getJSONObject("identity").getJSONObject("source") }
            changed.put("pdfSHA", "c".repeat(64))
            assertNull(verifiedSavedStudyInput(summary, bind(summary, input)))
        }
    }
    @Test fun ownerQuestionModelMessagesConfigExtractorAndFingerprintContradictionsFailClosed() {
        val mutations: List<(JSONObject) -> Unit> = listOf(
            { it.getJSONObject("identity").put("paperID", "other") },
            { it.getJSONObject("identity").put("question", "Other?") },
            { it.getJSONObject("identity").put("extractor", "other") },
            { it.getJSONObject("config").put("model", "other") },
            { it.getJSONObject("config").put("maxTokens", 1234) },
            { it.getJSONArray("messages").getJSONObject(0).put("content", "changed") },
            { it.getJSONArray("messages").getJSONObject(1).put("content", "changed") },
            { it.put("fingerprint", "b".repeat(64)) }
        )
        for (mutate in mutations) {
            val (summary, original) = fixture(); val sealed = JSONObject(original.toString()); mutate(sealed)
            assertNull(verifiedSavedStudyInput(summary, bind(summary, sealed)))
        }
        for (key in listOf("paperID", "question", "model", "fingerprint")) {
            val (summary, sealed) = fixture(); val bytes = bind(summary, sealed)
            assertNull(verifiedSavedStudyInput(summary.put(key, "contradiction"), bytes))
        }
    }
    @Test fun internallyRehashedMessagesStillNeedExactHeaderAndPageConsistency() {
        for (replacement in listOf("Other?", "[原文物理页 9]", "[原文物理页 3]")) {
            val (summary, original) = fixture(); val sealed = JSONObject(original.toString())
            val messages = sealed.getJSONArray("messages")
            val user = messages.getJSONObject(1)
            user.put("content", if (replacement == "Other?") user.getString("content").replace("Why?", replacement)
                else user.getString("content").replace("[原文物理页 2]", replacement))
            val identity = sealed.getJSONObject("identity").put("messages", messages)
            val fingerprint = sha256(canonical(identity).toByteArray())
            sealed.put("fingerprint", fingerprint); summary.put("fingerprint", fingerprint)
            assertNull(verifiedSavedStudyInput(summary, bind(summary, sealed)))
        }
    }
    @Test fun contradictoryOwnerPagesAndHeaderFailEvenWhenIdentityAndOuterHashAreRecomputed() {
        val changes: List<(JSONObject) -> Unit> = listOf(
            { it.put("paperID", "another-owner") },
            { it.put("pages", JSONArray(listOf(2, 2))) },
            { it.put("pages", JSONArray(listOf(2, 9))) },
            { it.put("pages", JSONArray(listOf("2", 3))) },
            { it.put("missingTextPages", JSONArray(listOf(99))) },
            { it.put("missingTextPages", "not-an-array") },
            { it.put("allPagesHaveExtractableText", false) }
        )
        for (change in changes) {
            val (summary, original) = fixture(); val sealed = JSONObject(original.toString())
            val source = sealed.getJSONObject("source"); change(source)
            summary.put("source", source.copy())
            val identity = sealed.getJSONObject("identity").put("source", source)
            val fingerprint = sha256(canonical(identity).toByteArray())
            sealed.put("fingerprint", fingerprint); summary.put("fingerprint", fingerprint)
            assertNull(verifiedSavedStudyInput(summary, bind(summary, sealed)))
        }
    }
    @Test fun rejectsMalformedPathIDsBeforeAnyRead() {
        for (bad in listOf("../escape", "$id/../escape", "1-1-1-1-1", "$id-input.json", "", "$id/")) {
            val (summary, sealed) = fixture(); val bytes = bind(summary, sealed)
            summary.put("id", bad)
            assertNull(verifiedSavedStudyInput(summary, bytes))
            assertNull(readSavedStudyInput(summary, File("/nonexistent-private-root")))
        }
    }
    @Test fun controlledReaderRejectsSymlinkAndReadsOnlyFixedOriginalInput() {
        val root = Files.createTempDirectory("saved-study-input").toFile()
        val usage = File(root, "ModelUsage").also { it.mkdir() }
        val file = File(usage, "$id-input.json")
        val (summary, sealed) = fixture(); val bytes = bind(summary, sealed)
        try {
            file.writeBytes(bytes); assertNotNull(readSavedStudyInput(summary, root))
            val other = File(root, "other.json").also { it.writeBytes(bytes) }
            assertTrue(file.delete()); Files.createSymbolicLink(file.toPath(), other.toPath())
            assertNull(readSavedStudyInput(summary, root))
        } finally { root.deleteRecursively() }
    }
    @Test fun legitimateMacV3AndV4OriginalFormatsReadWithoutAndroidIdentityOrDeviceHmac() {
        for (version in listOf(3, 4)) {
            val (summary, androidInput) = fixture()
            val source = androidInput.getJSONObject("source").copy().also { it.remove("extractor") }.put("kind", "range")
            val config = androidInput.getJSONObject("config")
            val evidence = "\n[p.2]\nOriginal two\n\n[p.3]\nOriginal three\n"
            val messages = JSONArray().put(JSONObject().put("role", "system").put("content", "Mac original instructions"))
                .put(JSONObject().put("role", "user").put("content", "研究问题：\nWhy?\n\n来源身份：\n${desktopStudyJSON(source)}\n\n实际证据：\n$evidence"))
            val identity = JSONObject().put("contract", "desktop-study-v$version").put("extractor", "pdfkit-physical-pages-v1")
                .put("kind", "study").put("paperID", "original-owner").put("question", "Why?").put("evidence", evidence)
                .put("messages", messages).put("source", source).put("model", config.get("model"))
                .put("endpoint", config.get("endpoint")).put("protocol", "chat").put("maxTokens", 8192)
            if (version == 4) identity.put("responsesStream", false).put("reasoningEffort", "default")
            val fingerprint = sha256(desktopStudyJSON(identity).toByteArray())
            val sealed = JSONObject().put("config", config).put("messages", messages).put("source", source).put("fingerprint", fingerprint)
            summary.put("id", id.uppercase()).put("source", source).put("fingerprint", fingerprint)
            val bytes = desktopStudyJSON(sealed).toByteArray().also { summary.put("inputSHA256", sha256(it)) }
            assertNotNull(verifiedSavedStudyInput(summary, bytes))
            assertEquals("\"https:\\/\\/example.invalid\\/v1\"", desktopStudyJSON("https://example.invalid/v1"))
            assertFalse(sealed.has("identity")); assertFalse(sealed.has("contract"))
        }
    }
}
