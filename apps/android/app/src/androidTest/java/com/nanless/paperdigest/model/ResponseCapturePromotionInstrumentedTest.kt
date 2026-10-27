package com.nanless.paperdigest.model

import android.os.Bundle
import androidx.test.platform.app.InstrumentationRegistry
import com.nanless.paperdigest.cloud.RequestContinuity
import com.nanless.paperdigest.data.PersonalStore
import com.nanless.paperdigest.data.sha256
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.attribute.BasicFileAttributes
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Normal AndroidJUnitRunner case for a dedicated offline test emulator, never a user's device.
 * Only this new synthetic store and a 127.0.0.1 server are used by the fixture. The normal target
 * Application can initialize its default Root/Vault/workers; that process scope is not certified here.
 * Real StudyService/SafeHttp create the signed capture. No reflection, fake receipt, model/provider,
 * production flag, transport replacement during issuance, or real credential access is used.
 */
class ResponseCapturePromotionInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    private fun checkpoint(phase: String, facts: JSONObject = JSONObject()) {
        instrumentation.sendStatus(0, Bundle().apply {
            putString("studyCapture75Checkpoint", phase)
            putString("studyCapture75Facts", facts.toString())
        })
    }

    @Test fun actualHttpEofCapturePromotesAfterRawWriteFailureWithoutNewDispatch(): Unit = runBlocking {
        val parent = instrumentation.targetContext.cacheDir.canonicalFile
        val root = Files.createTempDirectory(parent.toPath(), "study-capture-art75-").toRealPath().toFile()
        val rootKey = Files.readAttributes(root.toPath(), BasicFileAttributes::class.java, NOFOLLOW_LINKS).fileKey()
        require(rootKey != null)
        var phase = "new-fixture"
        var failure: Throwable? = null
        var issuedJob: Deferred<Result<JSONObject>>? = null
        try {
            val raw = JSONObject().put("model", "synthetic-art-model")
                .put("usage", JSONObject().put("total_tokens", 5))
                .put("choices", JSONArray().put(JSONObject().put("finish_reason", "stop")
                    .put("message", JSONObject().put("content", "Synthetic complete answer. ".repeat(40)))))
                .toString().toByteArray(Charsets.UTF_8)
            OneResponseServer(raw).use { server ->
                val store = PersonalStore(root).apply {
                    updateSettings(JSONObject().put("endpoint", "http://127.0.0.1:${server.port}/v1")
                        .put("model", "synthetic-art-model").put("protocol", "chat")
                        .put("dailyRequests", 5).put("timeoutMs", 15000))
                }
                val initialKeyReads = AtomicInteger()
                val service = StudyService(store, { initialKeyReads.incrementAndGet(); "synthetic-capture-art75-key" })
                val id = service.prepare("fixture:capture-art75", "Synthetic question", "Synthetic original evidence",
                    JSONObject().put("paperID", "fixture:capture-art75").put("kind", "range")
                        .put("pages", JSONArray().put(1))).getString("id")
                val usage = File(root, "ModelUsage")
                val standardRaw = File(usage, "$id-response.bin")
                val standardReceipt = File(usage, "$id-response.json")
                val pending = async(Dispatchers.IO) { runCatching { service.run(id) } }
                issuedJob = pending
                // A real HTTP request proves preflight completed; do not race a timed body delay.
                withContext(Dispatchers.IO) { check(server.requestArrived.await(10, TimeUnit.SECONDS)) { "Actual loopback request was not received" } }
                phase = "actual-request-before-owned-trap"
                assertTrue(standardRaw.mkdir())
                val sentinel = File(standardRaw, "synthetic-owned-trap").apply { writeText("Synthetic trap must remain unchanged") }
                server.releaseResponse.countDown()
                val issuedResult = withTimeout(20000) { pending.await() }
                server.awaitComplete()
                assertTrue("The owned directory trap must cause the standard raw write to fail", issuedResult.isFailure)
                assertEquals("Synthetic trap must remain unchanged", sentinel.readText())
                assertFalse(standardReceipt.exists())
                val capture = requireNotNull(usage.listFiles()).filter {
                    it.name.startsWith("$id-response-capture-") && it.name.endsWith(".bin")
                }.single()
                val manifest = File(usage, capture.name.removeSuffix(".bin") + ".json")
                val record = JSONObject(manifest.readText())
                assertEquals("body-complete", record.getString("status"))
                assertEquals("android-http-response-capture-v1", record.getString("contract"))
                assertEquals(id, record.getString("sessionID"))
                assertTrue(record.getBoolean("requestIssued"))
                assertEquals(200, record.getInt("httpStatus"))
                assertEquals(raw.size.toLong(), record.getLong("byteCount"))
                assertEquals(sha256(raw), record.getString("sha256"))
                assertArrayEquals(raw, capture.readBytes())
                assertEquals("failed", store.session(id)!!.getString("status"))
                val issuedDay = store.session(id)!!.getString("startedAt").substring(0, 10)
                assertEquals(1, initialKeyReads.get())
                assertEquals(1, server.requests.get())
                assertEquals(1, RequestContinuity.count(issuedDay, root, store.snapshot()))
                phase = "actual-eof-signed-capture-preserved"
                checkpoint(phase, JSONObject().put("requests", 1).put("issuedFloor", 1).put("bodyComplete", true))
                check(sentinel.delete() && standardRaw.delete()) { "Could not remove only the owned synthetic trap" }

                // All files below were generated by this fixture. The HMAC file is an internal
                // response-integrity fixture, not a user credential, and is never emitted.
                val originals = listOf(capture, manifest, File(usage, "$id-input.json"),
                    File(root, RequestContinuity.FILE), File(usage, "response-integrity.android.key"))
                    .associateWith { it.readBytes() }
                val reopenedStore = PersonalStore(root)
                val recoveryKeyReads = AtomicInteger()
                val recoveryHttpCalls = AtomicInteger()
                val reopened = StudyService(reopenedStore, {
                    recoveryKeyReads.incrementAndGet(); error("Recovery must not read a current API key")
                }) { _, _, _, _ ->
                    recoveryHttpCalls.incrementAndGet(); error("Recovery must not dispatch HTTP")
                }
                phase = "native-promotion"
                val recovered = reopened.recoverSaved(id)
                assertEquals("completed", recovered.getString("status"))
                assertTrue(recovered.getBoolean("recovered"))
                assertArrayEquals(raw, standardRaw.readBytes())
                assertEquals("android-body-complete-capture-promotion-v1",
                    JSONObject(standardReceipt.readText()).getJSONObject("capturePromotion").getString("contract"))
                assertEquals("completed", reopened.verifySaved(recovered).getString("status"))
                originals.forEach { (file, bytes) -> assertArrayEquals(bytes, file.readBytes()) }
                assertEquals(0, recoveryKeyReads.get())
                assertEquals(0, recoveryHttpCalls.get())
                assertEquals(1, server.requests.get())
                assertEquals(1, RequestContinuity.count(issuedDay, root, reopenedStore.snapshot()))
                val personal = File(root, "personal.json").readBytes()
                assertTrue(reopened.recoverSaved(id).getBoolean("recovered"))
                assertArrayEquals(personal, File(root, "personal.json").readBytes())
                originals.forEach { (file, bytes) -> assertArrayEquals(bytes, file.readBytes()) }
                assertEquals(0, recoveryKeyReads.get()); assertEquals(0, recoveryHttpCalls.get())
                phase = "promotion-and-repeat-verified"
                checkpoint(phase, JSONObject().put("requests", 1).put("recoveryKeyReads", 0)
                    .put("recoveryHttpCalls", 0).put("originalsUnchanged", true).put("issuedFloor", 1))
            }
        } catch (error: Throwable) {
            failure = error
            checkpoint("failed", JSONObject().put("phase", phase).put("errorClass", error.javaClass.simpleName))
            throw error
        } finally {
            try {
                // Even a preparation/assertion failure cannot delete files under a live writer.
                withContext(NonCancellable) { issuedJob?.cancelAndJoin() }
                check(!Files.isSymbolicLink(root.toPath()) &&
                    Files.readAttributes(root.toPath(), BasicFileAttributes::class.java, NOFOLLOW_LINKS).fileKey() == rootKey)
                // No FOLLOW_LINKS: remove only this newly created fixture tree, including its trap.
                Files.walk(root.toPath()).use { paths -> paths.sorted(Comparator.reverseOrder()).forEach { Files.delete(it) } }
            } catch (cleanup: Throwable) {
                if (failure != null) failure.addSuppressed(cleanup) else throw cleanup
            }
        }
    }

    /** One real, bounded loopback response. No request bodies/headers are retained or logged. */
    private class OneResponseServer(private val response: ByteArray) : AutoCloseable {
        private val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).apply { soTimeout = 15000 }
        val port: Int get() = server.localPort
        val requestArrived = CountDownLatch(1)
        val releaseResponse = CountDownLatch(1)
        val requests = AtomicInteger()
        private val complete = CountDownLatch(1)
        private val serverFailure = AtomicReference<Throwable?>()
        @Volatile private var accepted: Socket? = null
        private val worker = Thread({
            try {
                server.accept().use { socket ->
                    accepted = socket; socket.soTimeout = 15000
                    val input = socket.getInputStream()
                    check(line(input) == "POST /v1/chat/completions HTTP/1.1") { "Unexpected loopback request envelope" }
                    var contentLength: Int? = null
                    var lines = 0
                    while (true) {
                        val header = line(input); if (header.isEmpty()) break
                        check(++lines <= 64) { "Loopback request has too many headers" }
                        if (header.startsWith("Content-Length:", ignoreCase = true)) {
                            check(contentLength == null); contentLength = header.substringAfter(':').trim().toInt()
                        }
                        check(!header.startsWith("Transfer-Encoding:", ignoreCase = true)) { "Unexpected chunked synthetic request" }
                    }
                    val count = requireNotNull(contentLength); check(count in 1..65536)
                    val buffer = ByteArray(4096); var left = count
                    while (left > 0) { val n = input.read(buffer, 0, minOf(buffer.size, left)); check(n > 0); left -= n }
                    check(requests.incrementAndGet() == 1)
                    requestArrived.countDown()
                    check(releaseResponse.await(10, TimeUnit.SECONDS)) { "Owned raw-path trap was not ready" }
                    val output = socket.getOutputStream()
                    output.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${response.size}\r\nConnection: close\r\n\r\n").toByteArray(Charsets.US_ASCII))
                    output.write(response); output.flush()
                }
            } catch (error: Throwable) { serverFailure.set(error) }
            finally { accepted = null; complete.countDown() }
        }, "synthetic-study-capture-loopback").apply { isDaemon = true; start() }

        private fun line(input: InputStream): String {
            val bytes = ByteArrayOutputStream()
            while (true) {
                val b = input.read(); check(b >= 0) { "Unexpected loopback request EOF" }
                if (b == 10) break
                check(bytes.size() < 4096) { "Loopback request line exceeds its bound" }; bytes.write(b)
            }
            return bytes.toByteArray().toString(Charsets.US_ASCII).removeSuffix("\r")
        }
        fun awaitComplete() {
            check(complete.await(5, TimeUnit.SECONDS)) { "Loopback server did not drain" }
            serverFailure.get()?.let { throw it }
        }
        override fun close() {
            releaseResponse.countDown()
            try { accepted?.close() } finally { server.close() }
            worker.join(5000)
            check(!worker.isAlive) { "Loopback server worker did not exit" }
        }
    }
}
