package com.nanless.paperdigest.review

import com.nanless.paperdigest.cloud.RequestContinuity
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.model.StudyService
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.UUID

/** Non-author: genuine StudyService-produced raw/HMAC materials, synthetic transport only. */
class SavedResponseRecoveryReviewTest {
    private class Fixture(val finish: String = "stop") {
        val root = Files.createTempDirectory("saved-response-nonauthor-").toRealPath().toFile()
        val store = PersonalStore(root)
        var keys = 0; var requests = 0
        var entered: CompletableDeferred<Unit>? = null; var gate: CompletableDeferred<Unit>? = null
        var beforeResponse: (() -> Unit)? = null
        val source = JSONObject().put("paperID", "fixture:paper").put("kind", "published-guide").put("revision", "a".repeat(64))
        init { store.updateSettings(JSONObject().put("endpoint", "https://original.example.invalid/v1").put("model", "synthetic-requested-model").put("protocol", "chat").put("maxTokens", 512).put("dailyRequests", 20)) }
        val service = StudyService(store, { keys++; "synthetic-only-not-real-secret" }) { _, _, _, _ ->
            requests++; entered?.complete(Unit); gate?.await(); beforeResponse?.invoke()
            HttpBytes(200, emptyMap(), JSONObject().put("model", "synthetic-actual-model").put("usage", JSONObject().put("prompt_tokens", 11).put("completion_tokens", 13).put("total_tokens", 24))
                .put("choices", JSONArray().put(JSONObject().put("finish_reason", finish).put("message", JSONObject().put("content", "A genuine synthetic provider answer.")))).toString().toByteArray())
        }
        suspend fun prepare(force: Boolean = false) = service.prepare("fixture:paper", "Synthetic unchanged question", "Synthetic actual evidence.", source, force)
        suspend fun interrupted(force: Boolean = false): JSONObject {
            val p = prepare(force); val result = runCatching { service.run(p.getString("id")) }
            if (finish == "stop") assertTrue(result.isSuccess) else assertTrue(result.isFailure)
            val old = store.session(p.getString("id"))!!.put("status", "failed").put("charge", "unknown").put("error", "Synthetic final-session-save failure")
            listOf("answer", "text", "response", "responseSHA256", "httpStatus", "endedAt", "usage", "actualModel", "costKnown").forEach(old::remove)
            store.appendSession(old); keys = 0; requests = 0; return old
        }
        fun materials(id: String) = (listOf("ModelUsage/$id-input.json", "ModelUsage/$id-response.bin", "ModelUsage/$id-response.json", "ModelUsage/response-integrity.android.key", RequestContinuity.FILE)).associateWith { File(root, it).readBytes() }
        fun unchanged(before: Map<String, ByteArray>) { before.forEach { (path, bytes) -> assertArrayEquals("Protected original changed: $path", bytes, File(root, path).readBytes()) } }
        fun zeroRequests() { assertEquals("Recovery must not read an API key", 0, keys); assertEquals("Recovery must not issue HTTP", 0, requests) }
        fun beforeFile(old: JSONObject) = File(root, "ModelUsage/${old.getString("id")}-before-response-recovery-${sha256(canonical(old).toByteArray())}.json")
        fun close() { root.deleteRecursively() }
    }

    @Test fun recoverAfterRouteChangeAndOfflinePreservesOriginalMaterialsBudgetAndIdempotency() = runBlocking {
        val f = Fixture()
        try {
            val old = f.interrupted(); val id = old.getString("id"); val material = f.materials(id)
            f.store.updateSettings(JSONObject().put("endpoint", "https://different.example.invalid/v1").put("model", "different-current-model").put("offlineMode", true))
            val result = withTimeout(5000) { f.service.recoverSaved(id) }
            assertEquals(id, result.getString("id")); assertEquals("completed", result.getString("status")); assertEquals("A genuine synthetic provider answer.", result.getString("answer"))
            assertEquals("synthetic-requested-model", result.getString("model")); assertEquals("synthetic-actual-model", result.getString("actualModel")); assertEquals(24, result.getJSONObject("usage").getInt("total_tokens")); assertFalse(result.getBoolean("costKnown")); assertTrue(result.getBoolean("requestIssued"))
            assertEquals(result.getString("answer"), result.getString("text")); assertEquals(result.getString("answer"), result.getString("response")); assertEquals("usage-recorded", result.getString("charge"))
            assertEquals(canonical(JSONObject(material.getValue("ModelUsage/$id-response.bin").toString(Charsets.UTF_8)).getJSONObject("usage")), canonical(result.getJSONObject("usage")))
            val receipt = JSONObject(material.getValue("ModelUsage/$id-response.json").toString(Charsets.UTF_8))
            assertEquals(receipt.getString("receivedAt"), result.getString("endedAt")); assertEquals(old.getString("startedAt"), result.getString("startedAt")); assertEquals(200, result.getInt("httpStatus")); assertEquals(sha256(material.getValue("ModelUsage/$id-response.bin")), result.getString("responseSHA256"))
            assertEquals("https://different.example.invalid/v1", f.store.settings().getString("endpoint")); assertTrue(f.store.settings().getBoolean("offlineMode"))
            assertEquals(canonical(old), canonical(JSONObject(f.beforeFile(old).readText())))
            val beforeBytes = f.beforeFile(old).readBytes(); val files = File(f.root, "ModelUsage").listFiles()!!.map { it.name }.toSet()
            f.service.recoverSaved(id); f.service.run(id)
            f.zeroRequests(); f.unchanged(material); assertArrayEquals(beforeBytes, f.beforeFile(old).readBytes()); assertEquals(files, File(f.root, "ModelUsage").listFiles()!!.map { it.name }.toSet())
            assertEquals(1, RequestContinuity.read(f.root).size); assertEquals(1, f.store.snapshot().getJSONArray("sessions").length())
        } finally { f.close() }
    }

    @Test fun prepareRecoversTheUniqueIssuedResponseWithoutCreatingAnotherPaidSession() = runBlocking {
        val f = Fixture()
        try {
            val old = f.interrupted(); val material = f.materials(old.getString("id"))
            val result = withTimeout(5000) { f.prepare() }
            assertEquals(old.getString("id"), result.getString("id")); assertEquals("completed", result.getString("status")); assertTrue(result.getBoolean("reused"))
            assertEquals(1, f.store.snapshot().getJSONArray("sessions").length()); f.zeroRequests(); f.unchanged(material)
        } finally { f.close() }
    }

    @Test fun actualFinalSessionWriteFailureAfterAuthenticatedReceiptRecoversWithoutAnotherRequest() = runBlocking {
        val f = Fixture()
        try {
            val prepared = f.prepare(); val id = prepared.getString("id")
            val personal = File(f.root, "personal.json"); val shadow = File(f.root, "pending-personal-before-return.json")
            f.beforeResponse = { assertTrue(personal.renameTo(shadow)); assertTrue(personal.mkdir()); File(personal, "block-final-session-save").writeText("synthetic real filesystem fault") }
            try {
                assertTrue(runCatching { f.service.run(id) }.isFailure)
                assertEquals("pending", f.store.session(id)!!.getString("status")); assertTrue(File(f.root, "ModelUsage/$id-response.json").isFile); assertTrue(File(f.root, "ModelUsage/$id-response.bin").isFile)
            } finally { personal.deleteRecursively(); assertTrue(shadow.renameTo(personal)); f.beforeResponse = null }
            val material = f.materials(id); val pending = f.store.session(id)!!; assertTrue(pending.getBoolean("requestIssued")); assertFalse(pending.has("responseSHA256"))
            f.keys = 0; f.requests = 0
            val recovered = f.service.recoverSaved(id); assertEquals("completed", recovered.getString("status")); assertEquals(24, recovered.getJSONObject("usage").getInt("total_tokens"))
            assertEquals(canonical(pending), canonical(JSONObject(f.beforeFile(pending).readText()))); f.zeroRequests(); f.unchanged(material); assertEquals(1, RequestContinuity.read(f.root).size)
        } finally { f.close() }
    }

    @Test fun missingSavedResponseCannotSilentlyBecomeAnotherPreparedPaidRequest() = runBlocking {
        val f = Fixture()
        try {
            val old = f.interrupted(); val id = old.getString("id")
            File(f.root, "ModelUsage/$id-response.bin").delete()
            // The negative case has no reliable original body. A newly added
            // authenticated body-complete capture is deliberately absent too;
            // its separate positive recovery case must not become a paid retry.
            val captureBodies = File(f.root, "ModelUsage").listFiles()!!.filter { it.name.startsWith("$id-response-capture-") && it.name.endsWith(".bin") }
            assertTrue(captureBodies.isNotEmpty()); captureBodies.forEach { assertTrue(it.delete()) }
            val personal = File(f.root, "personal.json").readBytes(); val ledger = File(f.root, RequestContinuity.FILE).readBytes()
            assertTrue(runCatching { f.prepare() }.isFailure)
            f.zeroRequests(); assertArrayEquals(personal, File(f.root, "personal.json").readBytes()); assertArrayEquals(ledger, File(f.root, RequestContinuity.FILE).readBytes()); assertEquals(1, f.store.snapshot().getJSONArray("sessions").length())
        } finally { f.close() }
    }

    @Test fun alteredInputRawOrReceiptIsRejectedWithoutChangingAnyOtherOriginal() = runBlocking {
        for (variant in listOf("input", "raw", "receipt", "missing-key")) {
            val f = Fixture()
            try {
                val old = f.interrupted(); val id = old.getString("id")
                when (variant) {
                    "input" -> File(f.root, "ModelUsage/$id-input.json").appendText(" ")
                    "raw" -> File(f.root, "ModelUsage/$id-response.bin").appendText(" ")
                    "receipt" -> { val file = File(f.root, "ModelUsage/$id-response.json"); val r = JSONObject(file.readText()).put("hmacSHA256", "0".repeat(64)); JsonFiles.write(file, r) }
                    else -> assertTrue(File(f.root, "ModelUsage/response-integrity.android.key").delete())
                }
                val all = f.root.walkTopDown().filter { it.isFile }.associate { it.relativeTo(f.root).invariantSeparatorsPath to it.readBytes() }
                assertTrue("Corrupt $variant must not recover", runCatching { f.service.recoverSaved(id) }.isFailure)
                f.zeroRequests(); f.unchanged(all); assertEquals(all.keys, f.root.walkTopDown().filter { it.isFile }.map { it.relativeTo(f.root).invariantSeparatorsPath }.toSet())
                assertEquals("failed", f.store.session(id)!!.getString("status"))
            } finally { f.close() }
        }
    }

    @Test fun issuedTimeOwnerAndLedgerFactsCannotBeBorrowedFromAnotherRequest() = runBlocking {
        for (variant in listOf("start", "owner", "question", "not-issued", "ledger", "other-authentic-receipt")) {
            val f = Fixture()
            try {
                val old = f.interrupted(); val id = old.getString("id")
                when (variant) {
                    "start" -> f.store.appendSession(old.copy().put("startedAt", "2020-01-01T00:00:00Z"))
                    "owner" -> f.store.appendSession(old.copy().put("paperID", "fixture:another-paper"))
                    "question" -> f.store.appendSession(old.copy().put("question", "Different original question"))
                    "not-issued" -> f.store.appendSession(old.copy().put("requestIssued", false))
                    "ledger" -> JsonFiles.write(File(f.root, RequestContinuity.FILE), RequestContinuity.json(emptyList()))
                    else -> { val second = f.interrupted(force = true); File(f.root, "ModelUsage/${second.getString("id")}-response.json").copyTo(File(f.root, "ModelUsage/$id-response.json"), overwrite = true) }
                }
                val all = f.root.walkTopDown().filter { it.isFile }.associate { it.relativeTo(f.root).invariantSeparatorsPath to it.readBytes() }
                assertTrue("Wrong $variant must not recover", runCatching { f.service.recoverSaved(id) }.isFailure)
                f.zeroRequests(); f.unchanged(all); assertEquals(all.keys, f.root.walkTopDown().filter { it.isFile }.map { it.relativeTo(f.root).invariantSeparatorsPath }.toSet())
            } finally { f.close() }
        }
    }

    @Test fun authenticIncompleteResponseCannotBeRecoveredOrAutomaticallyRetried() = runBlocking {
        val f = Fixture("length")
        try {
            val old = f.interrupted(); val id = old.getString("id"); val material = f.materials(id); val personal = File(f.root, "personal.json").readBytes()
            assertTrue(runCatching { f.service.recoverSaved(id) }.isFailure); assertTrue(runCatching { f.prepare() }.isFailure)
            f.zeroRequests(); f.unchanged(material); assertArrayEquals(personal, File(f.root, "personal.json").readBytes()); assertEquals("failed", f.store.session(id)!!.getString("status"))
        } finally { f.close() }
    }

    @Test fun failedFinalSaveNeverClaimsCompletionAndTheSameBeforeSnapshotIsImmutableOnRetry() = runBlocking {
        val f = Fixture()
        try {
            val old = f.interrupted(); val id = old.getString("id"); val material = f.materials(id)
            val personal = File(f.root, "personal.json"); val shadow = File(f.root, "original-personal-for-fault.json"); assertTrue(personal.renameTo(shadow)); assertTrue(personal.mkdir()); File(personal, "block-replace").writeText("synthetic controlled disk target fault")
            try {
                assertTrue(runCatching { f.service.recoverSaved(id) }.isFailure)
                assertEquals(canonical(old), canonical(f.store.session(id))); f.zeroRequests(); f.unchanged(material)
                assertEquals(canonical(old), canonical(JSONObject(f.beforeFile(old).readText())))
            } finally { personal.deleteRecursively(); assertTrue(shadow.renameTo(personal)) }
            val before = f.beforeFile(old).readBytes()
            val recovered = f.service.recoverSaved(id); assertEquals("completed", recovered.getString("status")); assertArrayEquals(before, f.beforeFile(old).readBytes())
            f.zeroRequests(); f.unchanged(material)
        } finally { f.close() }
    }

    @Test fun multipleIssuedCandidatesRequireExplicitChoiceAndDoNotCreateAnotherRequest() = runBlocking {
        val f = Fixture()
        try {
            f.interrupted(); f.interrupted(force = true)
            val before = File(f.root, "personal.json").readBytes(); val ledger = File(f.root, RequestContinuity.FILE).readBytes()
            assertTrue(runCatching { f.prepare() }.isFailure); f.zeroRequests(); assertEquals(2, f.store.snapshot().getJSONArray("sessions").length()); assertArrayEquals(before, File(f.root, "personal.json").readBytes()); assertArrayEquals(ledger, File(f.root, RequestContinuity.FILE).readBytes())
        } finally { f.close() }
    }

    @Test fun inFlightRequestCannotBeReconciledConcurrentlyOrIssuedTwice() = runBlocking {
        val f = Fixture()
        var running: Deferred<JSONObject>? = null
        try {
            f.entered = CompletableDeferred(); f.gate = CompletableDeferred(); val prepared = f.prepare(); val id = prepared.getString("id")
            running = async { f.service.run(id) }
            withTimeout(5000) { f.entered!!.await() }
            val personal = File(f.root, "personal.json").readBytes(); val ledger = File(f.root, RequestContinuity.FILE).readBytes()
            assertTrue(runCatching { f.service.recoverSaved(id) }.isFailure); assertEquals(1, f.keys); assertEquals(1, f.requests)
            assertArrayEquals(personal, File(f.root, "personal.json").readBytes()); assertArrayEquals(ledger, File(f.root, RequestContinuity.FILE).readBytes())
            f.gate!!.complete(Unit); assertEquals("completed", withTimeout(5000) { running!!.await() }.getString("status")); assertEquals(1, f.requests)
        } finally { f.gate?.complete(Unit); running?.cancelAndJoin(); f.close() }
    }
}
