package com.nanless.paperdigest.model

import com.nanless.paperdigest.cloud.RequestContinuity
import com.nanless.paperdigest.data.*
import kotlinx.coroutines.*
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.time.LocalDate
import java.time.ZoneOffset
import java.util.concurrent.TimeUnit
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Real local HTTP only. These behavioral assertions also compile against the pre-capture service. */
class ResponseCaptureTest {
    private fun sign(value: JSONObject): String = Mac.getInstance("HmacSHA256").run {
        init(SecretKeySpec(ByteArray(32) { 7 }, "HmacSHA256"))
        doFinal(canonical(value).toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) }
    }
    private fun signWithOriginalTestKey(root: File, value: JSONObject): String = Mac.getInstance("HmacSHA256").run {
        init(SecretKeySpec(File(root, "ModelUsage/response-integrity.android.key").readBytes(), "HmacSHA256"))
        doFinal(canonical(value).toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) }
    }
    private class Fixture : AutoCloseable {
        val root = Files.createTempDirectory("response-capture-author-").toRealPath().toFile()
        val server = MockWebServer().apply { start() }
        val store = PersonalStore(root).apply { updateSettings(JSONObject().put("endpoint", server.url("/v1").toString()).put("model", "synthetic-model").put("protocol", "chat").put("dailyRequests", 5).put("timeoutMs", 10000)) }
        val service = StudyService(store, { "synthetic-capture-test-key" }, HostCapturePublication)
        fun prepare() = runBlocking { service.prepare("fixture:partial", "Synthetic question", "Synthetic original evidence", JSONObject().put("paperID", "fixture:partial").put("kind", "range").put("pages", JSONArray().put(1))) }.getString("id")
        fun bytes(size: Int = 400000) = JSONObject().put("model", "synthetic-model").put("usage", JSONObject().put("total_tokens", 5)).put("choices", JSONArray().put(JSONObject().put("finish_reason", "stop").put("message", JSONObject().put("content", "x".repeat(size))))).toString().toByteArray()
        fun bins(id: String) = File(root, "ModelUsage").listFiles()!!.filter { it.name.startsWith("$id-response-capture-") && it.name.endsWith(".bin") }
        fun metadata(bin: File) = JSONObject(File(bin.parentFile, bin.name.removeSuffix(".bin") + ".json").readText())
        fun count() = RequestContinuity.count(LocalDate.now(ZoneOffset.UTC).toString(), root, store.snapshot())
        suspend fun captureOnlyAfterActualHttpEof(): Pair<String, ByteArray> = coroutineScope {
            val raw = bytes(1000); server.enqueue(MockResponse().setBody(okio.Buffer().write(raw)).setBodyDelay(250, TimeUnit.MILLISECONDS))
            val id = prepare(); val pending = async(Dispatchers.IO) { runCatching { service.run(id) } }
            withTimeout(5000) { while (server.requestCount == 0) delay(5) }
            val blocked = File(root, "ModelUsage/$id-response.bin").apply { check(mkdir()) }
            val protected = File(blocked, "synthetic-protected").apply { writeText("original synthetic trap") }
            check(pending.await().isFailure)
            val capture = bins(id).single(); check(metadata(capture).getString("status") == "body-complete")
            check(capture.readBytes().contentEquals(raw)); check(protected.readText() == "original synthetic trap")
            check(protected.delete() && blocked.delete())
            id to raw
        }
        override fun close() { server.shutdown(); root.deleteRecursively() }
    }

    @Test fun disconnectedResponseRetainsReceivedBytesWithoutAdoptionOrAutomaticResend() = runBlocking {
        Fixture().use { f ->
            val raw = f.bytes(); f.server.enqueue(MockResponse().setBody(okio.Buffer().write(raw)).setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY))
            val id = f.prepare(); assertTrue(runCatching { f.service.run(id) }.isFailure)
            val bin = f.bins(id).singleOrNull()
            assertNotNull("Received partial bytes must survive the transport failure", bin)
            val captured = bin!!.readBytes(); assertTrue(captured.isNotEmpty() && captured.size < raw.size)
            assertArrayEquals(raw.copyOf(captured.size), captured)
            val metadata = f.metadata(bin); assertEquals("failed", metadata.getString("status")); assertEquals(captured.size.toLong(), metadata.getLong("byteCount")); assertEquals(sha256(captured), metadata.getString("sha256"))
            assertEquals(f.store.session(id)!!.getString("startedAt"), metadata.getString("startedAt")); assertTrue(metadata.getBoolean("requestIssued")); assertFalse(metadata.toString().contains("synthetic-capture-test-key"))
            assertFalse(File(f.root, "ModelUsage/$id-response.json").exists()); assertEquals("failed", f.store.session(id)!!.getString("status")); assertEquals("unknown", f.store.session(id)!!.getString("charge")); assertEquals(1, f.count())
            assertTrue(runCatching { f.service.run(id) }.isFailure); assertEquals(1, f.server.requestCount)
        }
    }

    @Test fun cancellationDrainsCaptureBeforeReturningAndKeepsIssuedBudget() = runBlocking {
        Fixture().use { f ->
            val raw = f.bytes(); f.server.enqueue(MockResponse().setBody(okio.Buffer().write(raw)).throttleBody(8192, 100, TimeUnit.MILLISECONDS))
            val id = f.prepare(); val job = launch(Dispatchers.IO) { runCatching { f.service.run(id) } }
            withTimeout(5000) { while (f.server.requestCount == 0) delay(10) }; delay(250)
            job.cancelAndJoin()
            val bin = f.bins(id).singleOrNull(); assertNotNull("Cancellation must keep already received original bytes", bin)
            val bytes = bin!!.readBytes(); assertTrue(bytes.isNotEmpty() && bytes.size < raw.size)
            val metadataFile = File(bin.parentFile, bin.name.removeSuffix(".bin") + ".json"); val metadataBytes = metadataFile.readBytes()
            val metadata = JSONObject(metadataBytes.toString(Charsets.UTF_8)); assertEquals("cancelled", metadata.getString("status")); assertEquals(sha256(bytes), metadata.getString("sha256"))
            delay(400)
            assertArrayEquals("No HTTP callback may mutate body after cancellation has returned", bytes, bin.readBytes())
            assertArrayEquals("No late terminal callback may replace the capture receipt", metadataBytes, metadataFile.readBytes())
            assertEquals("cancelled", f.store.session(id)!!.getString("status")); assertEquals(1, f.count()); assertEquals(1, f.server.requestCount)
        }
    }

    @Test fun knownBrokenFinalResponsePathRejectsBeforeAnyPaidDispatch() = runBlocking {
        Fixture().use { f ->
            var requests = 0
            val service = StudyService(f.store, { "synthetic-key" }, HostCapturePublication) { _, _, _, _ -> requests++; HttpBytes(200, emptyMap(), f.bytes(4)) }
            val id = service.prepare("fixture:partial", "Synthetic preflight question", "Synthetic evidence", JSONObject().put("paperID", "fixture:partial")).getString("id")
            val blocked = File(f.root, "ModelUsage/$id-response.bin").apply { mkdir() }; File(blocked, "protected").writeText("must preserve")
            assertTrue(runCatching { service.run(id) }.isFailure)
            assertEquals("An already unusable response destination must stop before HTTP", 0, requests)
            assertFalse(f.store.session(id)!!.getBoolean("requestIssued")); assertEquals(0, f.count()); assertEquals("must preserve", File(blocked, "protected").readText())
        }
    }

    @Test fun completeBodyRetainsOriginalResponseQualificationAndTheCaptureIsOnlySupplementary() = runBlocking {
        Fixture().use { f ->
            val raw = f.bytes(10); f.server.enqueue(MockResponse().setBody(okio.Buffer().write(raw)))
            val id = f.prepare(); val completed = f.service.run(id)
            assertEquals("completed", completed.getString("status")); assertArrayEquals(raw, File(f.root, "ModelUsage/$id-response.bin").readBytes())
            assertEquals("completed", f.service.verifySaved(completed).getString("status"))
            val bin = f.bins(id).singleOrNull(); assertNotNull(bin); assertArrayEquals(raw, bin!!.readBytes()); assertEquals("body-complete", f.metadata(bin).getString("status"))
            File(f.root, "ModelUsage/$id-response.json").delete()
            assertTrue("A capture must never substitute for the original full response receipt", runCatching { f.service.verifySaved(completed) }.isFailure)
        }
    }

    @Test fun bracketedIpv6LoopbackIsAllowedButOtherPrivateHttpEndpointsRemainRejected() {
        val base = JSONObject().put("endpoint", "http://[::1]:8080/v1").put("model", "synthetic-model").put("protocol", "chat")
        assertEquals("http://[::1]:8080/v1", StudyService.validatedConfig(base).getString("endpoint"))
        for (endpoint in listOf("http://[::2]:8080/v1", "http://[fd00::1]:8080/v1", "http://192.168.1.1/v1", "http://10.0.0.1/v1", "http://localhost:0/v1", "http://localhost:65536/v1", "https://example.invalid:0/v1", "https://example.invalid:65536/v1")) {
            assertThrows(IllegalArgumentException::class.java) { StudyService.validatedConfig(base.copy().put("endpoint", endpoint)) }
        }
        assertEquals("https://example.invalid:65535/v1", StudyService.validatedConfig(base.copy().put("endpoint", "https://example.invalid:65535/v1")).getString("endpoint"))
    }

    @Test fun defaultHttpCallerStillReceivesOrdinaryCompleteBytesWithoutCaptureFiles() = runBlocking {
        Fixture().use { f ->
            f.server.enqueue(MockResponse().setBody("synthetic ordinary response"))
            val result = SafeHttp(localModel = true).execute(Request.Builder().url(f.server.url("/ordinary")).build(), 1024)
            assertEquals("synthetic ordinary response", result.bytes.toString(Charsets.UTF_8)); assertEquals(200, result.code)
            assertTrue(File(f.root, "ModelUsage").listFiles().orEmpty().isEmpty())
        }
    }

    @Test fun cancellationCannotReturnWhileTheRealHttpTerminalWriterIsStillBlocked() = runBlocking {
        Fixture().use { f ->
            val entered = CountDownLatch(1); val release = CountDownLatch(1); val returned = AtomicBoolean(false)
            val capture = HttpResponseCapture.prepare(File(f.root, "ModelUsage"), UUID.randomUUID().toString(), "a".repeat(64), 1024 * 1024, { record ->
                if (record.optString("status") == "cancelled") { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
                sign(record)
            })
            capture.bindIssued("2026-01-01T00:00:00Z")
            f.server.enqueue(MockResponse().setBody(okio.Buffer().write(f.bytes())).throttleBody(8192, 100, TimeUnit.MILLISECONDS))
            val job = launch(Dispatchers.IO) { try { runCatching { SafeHttp(localModel = true).execute(Request.Builder().url(f.server.url("/capture")).build(), 1024 * 1024, capture) } } finally { returned.set(true) } }
            try {
                withTimeout(5000) { while (f.server.requestCount == 0) delay(10) }; delay(200)
                job.cancel()
                assertTrue("Actual HTTP callback must reach the terminal writer", entered.await(5, TimeUnit.SECONDS))
                assertFalse("Cancellation is not finished while the writer can still edit research files", returned.get())
                release.countDown(); job.join(); assertTrue(returned.get())
                val bytes = capture.bodyFile.readBytes(); val metadata = capture.manifestFile.readBytes()
                assertThrows(IllegalStateException::class.java) { capture.append("late writer".toByteArray()) }
                assertArrayEquals(bytes, capture.bodyFile.readBytes()); assertArrayEquals(metadata, capture.manifestFile.readBytes())
            } finally { release.countDown(); job.cancelAndJoin(); runCatching { capture.finish("cancelled") } }
        }
    }

    @Test fun partialReceiptBindsExactPrefixOriginalIdentityAndRealStartWithHmac() {
        Fixture().use { f ->
            val id = UUID.randomUUID().toString(); val hash = "b".repeat(64)
            val capture = HttpResponseCapture.prepare(File(f.root, "ModelUsage"), id, hash, 4096, ::sign)
            val before = JSONObject(capture.manifestFile.readText()); assertTrue(before.isNull("startedAt")); assertFalse(before.getBoolean("requestIssued")); assertEquals("prepared", before.getString("status"))
            capture.bindIssued("2026-01-01T00:00:00Z"); capture.responseStarted(200)
            capture.append("first original ".toByteArray()); capture.append("second原文".toByteArray()); capture.finish("failed")
            val bytes = capture.bodyFile.readBytes(); val record = JSONObject(capture.manifestFile.readText())
            assertEquals(id, record.getString("sessionID")); assertEquals(hash, record.getString("inputSHA256")); assertEquals("2026-01-01T00:00:00Z", record.getString("startedAt"))
            assertEquals(bytes.size.toLong(), record.getLong("byteCount")); assertEquals(sha256(bytes), record.getString("sha256")); assertEquals("failed", record.getString("status")); assertEquals(200, record.getInt("httpStatus"))
            val signature = record.getString("hmacSHA256"); record.remove("hmacSHA256"); assertEquals(signature, sign(record))
            assertNotEquals(signature, sign(record.copy().put("byteCount", bytes.size + 1)))
            assertFalse(record.has("headers")); assertFalse(record.has("url")); assertFalse(record.has("authorization"))
        }
    }

    @Test fun knownLackOfSpaceRejectsBeforeCreatingAnyCaptureOrCallingTheSigner() {
        Fixture().use { f ->
            var signs = 0
            assertThrows(IllegalArgumentException::class.java) {
                HttpResponseCapture.prepare(File(f.root, "ModelUsage"), UUID.randomUUID().toString(), "c".repeat(64), 4096, { signs++; sign(it) }, available = { 0 })
            }
            assertEquals(0, signs); assertEquals(0, f.server.requestCount); assertTrue(File(f.root, "ModelUsage").listFiles().orEmpty().isEmpty())
        }
    }

    @Test fun receiptWriteFailurePreservesForcedBinAndNeverOverwritesAnEarlierCaptureVersion() {
        Fixture().use { f ->
            val id = UUID.randomUUID().toString(); val data = "Synthetic received original prefix".toByteArray()
            val capture = HttpResponseCapture.prepare(File(f.root, "ModelUsage"), id, "d".repeat(64), 4096, { record ->
                if (record.getLong("byteCount") > 0) error("synthetic private provider bait")
                sign(record)
            })
            capture.bindIssued("2026-01-01T00:00:00Z"); capture.responseStarted(200)
            val append = runCatching { capture.append(data) }; assertTrue(append.isFailure); assertFalse(append.exceptionOrNull()!!.message.orEmpty().contains("bait"))
            assertTrue(runCatching { capture.finish("failed") }.isFailure)
            assertNotNull(capture.persistenceWarning); assertArrayEquals(data, capture.bodyFile.readBytes())
            val previousMetadata = capture.manifestFile.readBytes()
            val another = HttpResponseCapture.prepare(File(f.root, "ModelUsage"), id, "d".repeat(64), 4096, ::sign)
            another.finish("not-issued")
            assertNotEquals(capture.bodyFile.name, another.bodyFile.name)
            assertArrayEquals(data, capture.bodyFile.readBytes()); assertArrayEquals(previousMetadata, capture.manifestFile.readBytes())
            assertThrows(IllegalStateException::class.java) { capture.append(byteArrayOf(1)) }
        }
    }

    @Test fun actualBodyCompleteCaptureAfterRawWriteFailurePromotesWithoutKeyHttpOrBudgetChanges() = runBlocking {
        Fixture().use { f ->
            val (id, raw) = f.captureOnlyAfterActualHttpEof()
            val capture = f.bins(id).single(); val metadata = File(capture.parentFile, capture.name.removeSuffix(".bin") + ".json")
            val originals = listOf(capture, metadata, File(f.root, "ModelUsage/$id-input.json"), File(f.root, RequestContinuity.FILE), File(f.root, "ModelUsage/response-integrity.android.key")).associateWith { it.readBytes() }
            val restoredStore = PersonalStore(f.root); var keys = 0; var requests = 0
            val reopened = StudyService(restoredStore, { keys++; error("Recovery must not read a current API key") }, HostCapturePublication) { _, _, _, _ -> requests++; error("Recovery must not call HTTP") }
            val result = reopened.recoverSaved(id)
            assertEquals("completed", result.getString("status")); assertTrue(result.getBoolean("recovered")); assertArrayEquals(raw, File(f.root, "ModelUsage/$id-response.bin").readBytes())
            assertEquals("android-body-complete-capture-promotion-v1", JSONObject(File(f.root, "ModelUsage/$id-response.json").readText()).getJSONObject("capturePromotion").getString("contract"))
            assertEquals(0, keys); assertEquals(0, requests); assertEquals(1, f.server.requestCount); assertEquals(1, f.count())
            originals.forEach { (file, bytes) -> assertArrayEquals(bytes, file.readBytes()) }
            assertEquals("completed", reopened.verifySaved(result).getString("status")); assertTrue(reopened.recoverSaved(id).getBoolean("recovered")); assertEquals(0, keys); assertEquals(0, requests)
        }
    }

    @Test fun completeLookingJsonFromFailedOrCancelledHttpIsNeverPromoted() = runBlocking {
        for (cancel in listOf(false, true)) Fixture().use { f ->
            val raw = f.bytes(10) + " ".repeat(120000).toByteArray()
            val response = MockResponse().setBody(okio.Buffer().write(raw))
            if (cancel) response.throttleBody(4096, 50, TimeUnit.MILLISECONDS) else response.setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY)
            f.server.enqueue(response); val id = f.prepare()
            if (cancel) {
                val job = launch(Dispatchers.IO) { runCatching { f.service.run(id) } }
                withTimeout(5000) { while (f.server.requestCount == 0) delay(5) }; delay(150); job.cancelAndJoin()
            } else assertTrue(runCatching { f.service.run(id) }.isFailure)
            val bin = f.bins(id).single(); assertEquals("stop", StudyService.decodeResponse(bin.readBytes(), false).getJSONArray("choices").getJSONObject(0).getString("finish_reason"))
            assertEquals(if (cancel) "cancelled" else "failed", f.metadata(bin).getString("status"))
            val files = f.root.walkTopDown().filter { it.isFile }.associateWith { it.readBytes() }
            assertTrue(runCatching { f.service.recoverSaved(id) }.isFailure)
            assertFalse(File(f.root, "ModelUsage/$id-response.bin").exists()); assertFalse(File(f.root, "ModelUsage/$id-response.json").exists())
            files.forEach { (file, bytes) -> assertArrayEquals(bytes, file.readBytes()) }; assertEquals(1, f.server.requestCount); assertEquals(1, f.count())
        }
    }

    @Test fun promotionRejectsCorruptAmbiguousMisboundOrConflictingMaterialWithoutAnyOverwrite() = runBlocking {
        for (variant in listOf("bin", "signature", "start", "raw-conflict", "receipt-conflict", "ambiguous", "owner", "missing-key")) Fixture().use { f ->
            val (id, _) = f.captureOnlyAfterActualHttpEof(); val bin = f.bins(id).single(); val meta = File(bin.parentFile, bin.name.removeSuffix(".bin") + ".json")
            when (variant) {
                "bin" -> bin.appendText(" altered")
                "signature" -> JsonFiles.write(meta, JSONObject(meta.readText()).put("hmacSHA256", "0".repeat(64)))
                "start" -> { val record = JSONObject(meta.readText()).put("startedAt", "2020-01-01T00:00:00Z"); record.remove("hmacSHA256"); record.put("hmacSHA256", signWithOriginalTestKey(f.root, record)); JsonFiles.write(meta, record) }
                "raw-conflict" -> File(f.root, "ModelUsage/$id-response.bin").writeText("Conflicting original bytes")
                "receipt-conflict" -> JsonFiles.write(File(f.root, "ModelUsage/$id-response.json"), JSONObject().put("contract", "conflicting-original"))
                "ambiguous" -> {
                    val newID = UUID.randomUUID().toString(); val base = "$id-response-capture-$newID"
                    JsonFiles.write(File(bin.parentFile, "$base.bin"), bin.readBytes())
                    val record = JSONObject(meta.readText()).put("captureID", newID); record.remove("hmacSHA256"); record.put("hmacSHA256", signWithOriginalTestKey(f.root, record)); JsonFiles.write(File(bin.parentFile, "$base.json"), record)
                }
                "owner" -> f.store.appendSession(f.store.session(id)!!.put("paperID", "fixture:wrong-owner"))
                else -> assertTrue(File(f.root, "ModelUsage/response-integrity.android.key").delete())
            }
            val files = f.root.walkTopDown().filter { it.isFile }.associateWith { it.readBytes() }; val names = files.keys.map { it.relativeTo(f.root).path }.toSet()
            var keys = 0; var requests = 0
            val service = StudyService(f.store, { keys++; "must-not-read" }, HostCapturePublication) { _, _, _, _ -> requests++; error("must not dispatch") }
            assertTrue("Reject $variant rather than choosing or rewriting original material", runCatching { service.recoverSaved(id) }.isFailure)
            files.forEach { (file, bytes) -> assertArrayEquals(bytes, file.readBytes()) }; assertEquals(names, f.root.walkTopDown().filter { it.isFile }.map { it.relativeTo(f.root).path }.toSet())
            assertEquals(0, keys); assertEquals(0, requests); assertEquals(1, f.server.requestCount); assertEquals(1, f.count())
        }
    }

    @Test fun promotionMayFillOneMissingStandardFileButMustPreserveTheOtherExactly() = runBlocking {
        for (existingRaw in listOf(true, false)) Fixture().use { f ->
            val (id, raw) = f.captureOnlyAfterActualHttpEof(); val session = f.store.session(id)!!; val captured = f.metadata(f.bins(id).single())
            val existing = if (existingRaw) File(f.root, "ModelUsage/$id-response.bin").apply { writeBytes(raw) } else {
                val receipt = JSONObject().put("contract", "android-model-response-v1").put("sessionID", id).put("inputSHA256", session.getString("inputSHA256")).put("sha256", sha256(raw))
                    .put("httpStatus", 200).put("startedAt", session.getString("startedAt")).put("receivedAt", captured.getString("updatedAt"))
                receipt.put("hmacSHA256", signWithOriginalTestKey(f.root, receipt))
                File(f.root, "ModelUsage/$id-response.json").apply { JsonFiles.write(this, receipt) }
            }
            val bytes = existing.readBytes(); assertTrue(existing.setLastModified(1500000000000L)); val modified = existing.lastModified()
            val recovered = f.service.recoverSaved(id); assertEquals("completed", recovered.getString("status")); assertArrayEquals(bytes, existing.readBytes()); assertEquals(modified, existing.lastModified())
            assertEquals(1, f.server.requestCount); assertEquals(1, f.count())
        }
    }

    @Test fun invalidHeaderCredentialStopsBeforeIssuedBookkeepingWithoutSecretEcho() = runBlocking {
        Fixture().use { f ->
            var requests = 0
            var credential = "synthetic-header-bait\nsecond-line"
            val service = StudyService(f.store, { credential }, HostCapturePublication) { _, _, _, _ -> requests++; HttpBytes(200, emptyMap(), f.bytes(10)) }
            val id = service.prepare("fixture:partial", "Synthetic header question", "Synthetic evidence", JSONObject().put("paperID", "fixture:partial")).getString("id")
            val originalInput = File(f.root, "ModelUsage/$id-input.json").readBytes()
            val error = runCatching { service.run(id) }.exceptionOrNull(); assertNotNull(error)
            assertEquals(0, requests)
            assertFalse("An invalid local header must not be recorded as an issued request", f.store.session(id)!!.getBoolean("requestIssued"))
            assertEquals(0, f.count()); assertTrue(f.bins(id).isEmpty())
            assertTrue(error is AppFailure && error.category == "configuration")
            assertFalse(error!!.message.orEmpty().contains("synthetic-header-bait")); assertFalse(error.message.orEmpty().contains("second-line"))
            assertArrayEquals(originalInput, File(f.root, "ModelUsage/$id-input.json").readBytes())
            credential = "synthetic-valid-header-key"
            assertEquals("completed", service.run(id).getString("status")); assertEquals(1, requests); assertEquals(1, f.count())
            assertArrayEquals(originalInput, File(f.root, "ModelUsage/$id-input.json").readBytes())
        }
    }

    @Test fun interruptedAtomicPromotionBeforeOrAfterPublicationUsesOriginalCaptureOnRecovery() = runBlocking {
        for (afterPublication in listOf(false, true)) Fixture().use { f ->
            val (id, raw) = f.captureOnlyAfterActualHttpEof(); val bin = f.bins(id).single()
            val protected = listOf(bin, File(bin.parentFile, bin.name.removeSuffix(".bin") + ".json"), File(bin.parentFile, "$id-input.json"), File(f.root, RequestContinuity.FILE)).associateWith { it.readBytes() }
            var keys = 0; var http = 0
            val interrupted = CapturePublication { target, content ->
                if (afterPublication) HostCapturePublication.publishNew(target, content)
                throw java.io.IOException("Synthetic interruption at atomic publication boundary")
            }
            val first = StudyService(f.store, { keys++; error("No recovery key read") }, interrupted) { _, _, _, _ -> http++; error("No recovery HTTP") }
            assertTrue(runCatching { first.recoverSaved(id) }.isFailure)
            val standard = File(bin.parentFile, "$id-response.bin")
            if (afterPublication) assertArrayEquals(raw, standard.readBytes()) else assertFalse(standard.exists())
            assertNotEquals("completed", f.store.session(id)!!.getString("status"))
            val reopened = StudyService(f.store, { keys++; error("No recovery key read") }, HostCapturePublication) { _, _, _, _ -> http++; error("No recovery HTTP") }
            val recovered = reopened.recoverSaved(id); assertEquals("completed", recovered.getString("status")); assertArrayEquals(raw, standard.readBytes())
            assertTrue(reopened.recoverSaved(id).getBoolean("recovered")); protected.forEach { (file, bytes) -> assertArrayEquals(bytes, file.readBytes()) }
            assertEquals(0, keys); assertEquals(0, http); assertEquals(1, f.server.requestCount); assertEquals(1, f.count())
        }
    }

    @Test fun foreignTargetCreatedAfterStagingIsNeverReplacedByPromotion() = runBlocking {
        Fixture().use { f ->
            val (id, _) = f.captureOnlyAfterActualHttpEof(); val bin = f.bins(id).single(); val original = bin.readBytes()
            val foreign = byteArrayOf(9, 8, 7); var identity: Any? = null; var modified = 0L; var targetFile: File? = null; var keys = 0; var http = 0
            val collision = CapturePublication { target, content ->
                target.writeBytes(foreign); check(target.setLastModified(1500000000000L)); targetFile = target; modified = target.lastModified()
                identity = Files.readAttributes(target.toPath(), java.nio.file.attribute.BasicFileAttributes::class.java, java.nio.file.LinkOption.NOFOLLOW_LINKS).fileKey()
                HostCapturePublication.publishNew(target, content)
            }
            val service = StudyService(f.store, { keys++; error("No recovery key") }, collision) { _, _, _, _ -> http++; error("No recovery HTTP") }
            assertTrue(runCatching { service.recoverSaved(id) }.isFailure)
            val target = requireNotNull(targetFile); assertArrayEquals(foreign, target.readBytes()); assertEquals(modified, target.lastModified())
            assertEquals(identity, Files.readAttributes(target.toPath(), java.nio.file.attribute.BasicFileAttributes::class.java, java.nio.file.LinkOption.NOFOLLOW_LINKS).fileKey())
            assertArrayEquals(original, bin.readBytes()); assertNotEquals("completed", f.store.session(id)!!.getString("status")); assertEquals(0, keys); assertEquals(0, http); assertEquals(1, f.server.requestCount); assertEquals(1, f.count())
        }
    }

    @Test fun unsupportedPublicationKeepsOriginalCaptureForLaterSupportedRecovery() = runBlocking {
        Fixture().use { f ->
            val (id, raw) = f.captureOnlyAfterActualHttpEof(); val bin = f.bins(id).single(); val original = bin.readBytes()
            var keys = 0; var http = 0
            val unsupported = CapturePublication { _, _ -> throw java.io.IOException("Synthetic unsupported atomic publisher") }
            val first = StudyService(f.store, { keys++; error("No recovery key") }, unsupported) { _, _, _, _ -> http++; error("No recovery HTTP") }
            assertTrue(runCatching { first.recoverSaved(id) }.isFailure)
            assertFalse(File(bin.parentFile, "$id-response.bin").exists()); assertFalse(File(bin.parentFile, "$id-response.json").exists()); assertArrayEquals(original, bin.readBytes())
            val reopened = StudyService(f.store, { keys++; error("No recovery key") }, HostCapturePublication) { _, _, _, _ -> http++; error("No recovery HTTP") }
            assertEquals("completed", reopened.recoverSaved(id).getString("status")); assertArrayEquals(raw, File(bin.parentFile, "$id-response.bin").readBytes())
            assertEquals(0, keys); assertEquals(0, http); assertEquals(1, f.server.requestCount); assertEquals(1, f.count())
        }
    }

    @Test fun publicationRejectsHigherAncestorLinkWithoutChangingRealForeignTarget() {
        val root = Files.createTempDirectory("capture-ancestor-").toRealPath().toFile()
        val real = File(root, "real/nested").apply { check(mkdirs()) }
        val alias = File(root, "alias"); val foreign = File(real, "response.bin").apply { writeBytes(byteArrayOf(3, 2, 1)) }
        val before = Files.readAttributes(foreign.toPath(), java.nio.file.attribute.BasicFileAttributes::class.java, java.nio.file.LinkOption.NOFOLLOW_LINKS)
        try {
            Files.createSymbolicLink(alias.toPath(), real.parentFile.toPath())
            assertTrue(runCatching { HostCapturePublication.publishNew(File(alias, "nested/response.bin"), byteArrayOf(8)) }.isFailure)
            assertTrue(runCatching { HostCapturePublication.publishNew(File(alias, "nested/missing.bin"), byteArrayOf(8)) }.isFailure)
            assertArrayEquals(byteArrayOf(3, 2, 1), foreign.readBytes()); assertFalse(File(real, "missing.bin").exists())
            val after = Files.readAttributes(foreign.toPath(), java.nio.file.attribute.BasicFileAttributes::class.java, java.nio.file.LinkOption.NOFOLLOW_LINKS)
            assertEquals(before.fileKey(), after.fileKey()); assertEquals(before.lastModifiedTime(), after.lastModifiedTime()); assertEquals(setOf("response.bin"), real.list()!!.toSet())
        } finally { Files.deleteIfExists(alias.toPath()); root.deleteRecursively() }
    }
}
