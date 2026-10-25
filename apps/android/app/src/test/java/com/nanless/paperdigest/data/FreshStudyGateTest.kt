package com.nanless.paperdigest.data

import com.nanless.paperdigest.cloud.RequestContinuity
import com.nanless.paperdigest.model.StudyService
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

class FreshStudyGateTest {
    private fun stamp() = FreshStudyStamp("workspace", "credential", "paper", "material", "a".repeat(64), 5, "selection", "config", "question-and-range")
    @Test fun preparingAndDiscardingConfirmationDoesNotInvokeStudyOrWriteMaterial() {
        val directory = Files.createTempDirectory("fresh-confirm-").toRealPath().toFile()
        val store = PersonalStore(directory); var keys = 0; var calls = 0
        StudyService(store, { keys++; "synthetic-key" }) { _, _, _, _ -> calls++; error("must not call") }
        val before = directory.walkTopDown().filter { it.isFile }.associate { it.relativeTo(directory).path to it.readBytes() }
        val gate = FreshStudyGate<String>(); val intent = gate.prepare(stamp(), "frozen-draft"); assertTrue(gate.discard(intent.id))
        assertEquals(0, keys); assertEquals(0, calls); assertEquals(0, store.snapshot().getJSONArray("sessions").length())
        val after = directory.walkTopDown().filter { it.isFile }.associate { it.relativeTo(directory).path to it.readBytes() }
        assertEquals(before.keys, after.keys); before.forEach { (name, bytes) -> assertArrayEquals(bytes, after.getValue(name)) }
    }
    @Test fun confirmationCanBeConsumedExactlyOnceAndNeverByAnUnknownId() {
        val gate = FreshStudyGate<String>(); val prepared = gate.prepare(stamp(), "frozen")
        assertThrows(IllegalStateException::class.java) { gate.consume("unknown", stamp()) }
        assertEquals("frozen", gate.consume(prepared.id, stamp()).value)
        assertThrows(IllegalStateException::class.java) { gate.consume(prepared.id, stamp()) }
    }
    @Test fun oldDiscardOrFailedOldCommitCannotClearTheNewerIntent() {
        val gate = FreshStudyGate<String>(); val old = gate.prepare(stamp(), "old"); val latest = gate.prepare(stamp(), "latest")
        assertFalse(gate.discard(old.id)); assertThrows(IllegalStateException::class.java) { gate.consume(old.id, stamp()) }
        assertEquals("latest", gate.consume(latest.id, stamp()).value)
    }
    @Test fun everyOwnerSourcePdfSelectionPageQuestionConfigEpochAndCredentialChangeRejectsTheOldSnapshot() {
        val original = stamp()
        for (changed in listOf(original.copy(owner = "other"), original.copy(material = "other"), original.copy(pdfSHA = "b".repeat(64)),
            original.copy(selection = "other"), original.copy(page = 6), original.copy(draft = "other question or range"),
            original.copy(config = "new route or budget"), original.copy(workspace = "restored"), original.copy(credential = "changed"))) {
            val gate = FreshStudyGate<String>(); val intent = gate.prepare(original, "frozen")
            assertThrows(IllegalArgumentException::class.java) { gate.consume(intent.id, changed) }
        }
    }
    @Test fun copiedIntentDtoCannotReplaceThePrivateStoredValue() {
        val gate = FreshStudyGate<String>(); val intent = gate.prepare(stamp(), "native-frozen")
        val copy = FreshStudyGate.Intent(intent.id, stamp(), "forged")
        assertEquals("native-frozen", gate.consume(copy.id, copy.stamp).value)
    }
    @Test fun keyMutationStartsBeforeAwaitAndFailureStillInvalidatesOldCredentialRevision() {
        val revision = ModelCredentialRevision(); val before = revision.ready(); val change = revision.begin()
        assertThrows(IllegalArgumentException::class.java) { revision.ready() }
        revision.end(change) // Same completion path whether save succeeds or fails.
        assertNotEquals(before, revision.ready())
    }
    @Test fun twoConcurrentPendingMutationsRemainBusyWhicheverCompletesFirst() {
        for (reverse in listOf(false, true)) {
            val revision = ModelCredentialRevision(); val before = revision.ready()
            val oneTask = CompletableFuture.supplyAsync { revision.begin() }
            val twoTask = CompletableFuture.supplyAsync { revision.begin() }
            val one = oneTask.get(5, TimeUnit.SECONDS); val two = twoTask.get(5, TimeUnit.SECONDS)
            val first = if (reverse) two else one; val last = if (reverse) one else two
            revision.end(first)
            assertThrows(IllegalArgumentException::class.java) { revision.ready() }
            revision.end(last); assertNotEquals(before, revision.ready())
        }
    }
    @Test fun duplicateOrForeignCompletionCannotClearAnotherPendingMutation() {
        val revision = ModelCredentialRevision(); val one = revision.begin(); val two = revision.begin()
        revision.end(one); revision.end(one); revision.end(ModelCredentialRevision.Mutation())
        assertThrows(IllegalArgumentException::class.java) { revision.ready() }
        revision.end(two); assertTrue(revision.ready().isNotEmpty())
    }
    @Test fun invalidatingOnMutationOrRestoreRetiresTheOldIntentWithoutCreatingOne() {
        val gate = FreshStudyGate<String>(); val original = gate.prepare(stamp(), "old"); gate.invalidate()
        assertThrows(IllegalStateException::class.java) { gate.peek(original.id) }
    }
    private fun store() = PersonalStore(Files.createTempDirectory("fresh-study-").toRealPath().toFile()).also {
        it.updateSettings(JSONObject().put("endpoint", "https://synthetic.invalid/v1").put("model", "synthetic-model").put("protocol", "chat").put("dailyRequests", 20))
    }
    private fun source(check: Boolean) = JSONObject().put("paperID", if (check) "configuration-check" else "local:synthetic")
        .put("sourceVersion", "").put("sourceURL", "").put("kind", if (check) "connection-check" else "range")
        .put("extractor", if (check) "fixed-check-v1" else "android-pdfbox-physical-pages-v1").also { if (!check) it.put("pages", JSONArray(listOf(5))).put("pdfSHA", "a".repeat(64)) }
    private fun answer() = JSONObject().put("model", "actual-synthetic").put("choices", JSONArray().put(JSONObject().put("finish_reason", "stop").put("message", JSONObject().put("content", "synthetic answer")))).toString().toByteArray()
    @Test fun separateFreshStudyAndConnectionCheckCanCreateNewIdsWhileDefaultStillReusesCompleteResult() = runBlocking {
        for (check in listOf(false, true)) {
            val store = store(); var calls = 0; var keys = 0
            val service = StudyService(store, { keys++; "synthetic-key" }) { _, _, _, _ -> calls++; HttpBytes(200, emptyMap(), answer()) }
            val paper = if (check) "configuration-check" else "local:synthetic"; val question = if (check) "请只回复连接成功。" else "same question"
            val evidence = if (check) "这是一项最小连接检查，不包含论文或私人资料。" else "[p.5] same original material"
            val old = service.prepare(paper, question, evidence, source(check)).getString("id"); service.run(old)
            val oldFiles = File(store.directory, "ModelUsage").listFiles()!!.filter { it.name.startsWith(old) }.associate { it.name to it.readBytes() }
            assertEquals(old, service.prepare(paper, question, evidence, source(check)).getString("id")); assertEquals(1, calls)
            val gate = FreshStudyGate<Boolean>(); val intent = gate.prepare(stamp(), true); val force = gate.consume(intent.id, stamp()).value
            val fresh = service.prepare(paper, question, evidence, source(check), force).getString("id"); assertNotEquals(old, fresh); service.run(fresh)
            assertEquals(2, calls); assertEquals(2, keys); assertEquals(setOf(old, fresh), RequestContinuity.read(store.directory).map { it.id }.toSet())
            if (check) { val input = File(store.directory, "ModelUsage/$fresh-input.json").readText(); assertFalse(input.contains("local:synthetic")); assertEquals("connection-check", store.session(fresh)!!.getJSONObject("source").getString("kind")); assertEquals("configuration-check", store.session(fresh)!!.getString("paperID")) }
            oldFiles.forEach { (name, bytes) -> assertArrayEquals(bytes, File(store.directory, "ModelUsage/$name").readBytes()) }
            assertEquals("completed", store.session(old)!!.getString("status"))
        }
    }
    @Test fun explicitFreshAfterFailedHttp400PreservesTheOldFailureAndDoesNotAlterItsInputOrResponse() = runBlocking {
        val store = store(); var calls = 0; var keys = 0
        val service = StudyService(store, { keys++; "synthetic-key-$keys" }) { _, _, _, _ -> calls++; if (calls == 1) HttpBytes(400, emptyMap(), "{}".toByteArray()) else HttpBytes(200, emptyMap(), answer()) }
        val old = service.prepare("local:synthetic", "same question", "same material", source(false)).getString("id")
        try { service.run(old) } catch (_: Exception) { }
        val oldRecord = canonical(store.session(old)); val oldFiles = File(store.directory, "ModelUsage").listFiles()!!.filter { it.name.startsWith(old) }.associate { it.name to it.readBytes() }
        val gate = FreshStudyGate<Boolean>(); val intent = gate.prepare(stamp(), true)
        val fresh = service.prepare("local:synthetic", "same question", "same material", source(false), gate.consume(intent.id, stamp()).value).getString("id")
        assertNotEquals(old, fresh); service.run(fresh); assertEquals(2, calls); assertEquals(2, keys); assertEquals(oldRecord, canonical(store.session(old)))
        oldFiles.forEach { (name, bytes) -> assertArrayEquals(bytes, File(store.directory, "ModelUsage/$name").readBytes()) }
        assertEquals(setOf(old, fresh), RequestContinuity.read(store.directory).map { it.id }.toSet())
    }
    @Test fun credentialOrSourceChangeBeforeCommitCannotPrepareOrReadAKey() = runBlocking {
        val store = store(); var keys = 0; var calls = 0
        val service = StudyService(store, { keys++; "synthetic-key" }) { _, _, _, _ -> calls++; HttpBytes(200, emptyMap(), answer()) }
        val gate = FreshStudyGate<Boolean>(); val intent = gate.prepare(stamp(), true)
        assertTrue(runCatching {
            gate.consume(intent.id, stamp().copy(credential = "changed"))
            service.prepare("local:synthetic", "question", "material", source(false), true)
        }.isFailure)
        assertEquals(0, keys); assertEquals(0, calls); assertEquals(0, store.snapshot().getJSONArray("sessions").length())
        assertFalse(File(store.directory, RequestContinuity.FILE).exists())
    }
}
