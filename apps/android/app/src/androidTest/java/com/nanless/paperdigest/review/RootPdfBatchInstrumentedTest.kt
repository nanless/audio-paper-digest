package com.nanless.paperdigest.review

import androidx.test.rule.provider.ProviderTestRule
import com.nanless.paperdigest.cloud.BackupCodec
import com.nanless.paperdigest.review.RootPdfBatchFixture.Kind
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext

/** Actual Root/native provider/opaque sessions. All originals are private synthetic PDFs; no accounts/network. */
class RootPdfBatchInstrumentedTest {
    @get:Rule val provider = ProviderTestRule.Builder(RootPdfBatchFixture.Source::class.java, RootPdfBatchFixture.AUTHORITY).build()

    @Test fun wholePickerListSurvivesAwaiterCancellationAndCallerListMutation() = runBlocking {
        val f = RootPdfBatchFixture(provider)
        try {
            f.loaded(); val first = f.source(Kind.NORMAL); val locked = f.source(Kind.ENCRYPTED); val last = f.source(Kind.NORMAL)
            val before = f.sources.associate { it.first to BackupCodec.hash(it.second) }
            val selection = mutableListOf(first.first, locked.first, last.first)
            val owner = f.root.importPdfs(selection); selection.clear()
            val waiter = async { owner.await() }; val request = f.prompt(); waiter.cancelAndJoin()
            assertTrue(owner.isActive); assertTrue(f.root.state.value.busy); assertFalse(f.root.state.value.error.orEmpty().contains("已取消")); assertEquals(request.requestID, f.root.state.value.pdfUnlockPrompt?.requestID)
            assertEquals(1, f.root.personal.personalPapers().size); assertEquals(0, f.reads(last.first))
            f.root.unlockPdf(request.requestID, "synthetic-reader".toCharArray())
            val result = withTimeout(15000) { owner.await() }
            assertEquals("completed", result.getString("status")); assertEquals(3, result.getInt("completed")); assertEquals(0, result.getInt("notDispatched"))
            assertEquals(3, f.root.personal.personalPapers().size)
            f.sources.forEach { (uri, file) -> assertEquals(1, f.reads(uri)); assertEquals(before.getValue(uri), BackupCodec.hash(file)) }
            f.assertPrivateInputsAbsent()
        } finally { f.close() }
    }
    @Test fun explicitPasswordStopKeepsFirstOriginalAndNeverOpensRemainingPickerUri() = runBlocking {
        val f = RootPdfBatchFixture(provider)
        try {
            f.loaded(); val first = f.source(Kind.NORMAL); val locked = f.source(Kind.ENCRYPTED); val last = f.source(Kind.NORMAL)
            val hash = BackupCodec.hash(first.second); val owner = f.root.importPdfs(listOf(first.first, locked.first, last.first))
            f.root.cancelPdfUnlock(f.prompt().requestID)
            assertTrue(runCatching { owner.await() }.exceptionOrNull() is CancellationException)
            val result = f.batchResult(); assertEquals(1, result.getInt("completed")); assertEquals(1, result.getInt("cancelled")); assertEquals(1, result.getInt("notDispatched"))
            assertEquals(0, f.reads(last.first)); assertEquals(1, f.root.personal.personalPapers().size); assertEquals(hash, f.root.state.value.pdfDocument?.sha256)
            assertEquals(hash, BackupCodec.hash(first.second)); assertFalse(f.root.state.value.busy); f.assertPrivateInputsAbsent()
        } finally { f.close() }
    }
    @Test fun sourceSwitchDrainsWholeBatchAndDoesNotDispatchItsRemainder() = runBlocking {
        val f = RootPdfBatchFixture(provider)
        try {
            f.loaded(); val first = f.source(Kind.NORMAL); val locked = f.source(Kind.ENCRYPTED); val last = f.source(Kind.NORMAL)
            val owner = f.root.importPdfs(listOf(first.first, locked.first, last.first)); val prompt = f.prompt()
            val accepted = f.root.state.value.selectedPaperId!!
            f.root.execute("paper.open", JSONObject().put("paperID", accepted))
            assertTrue(runCatching { owner.await() }.exceptionOrNull() is CancellationException); assertEquals(0, f.reads(last.first))
            val late = "synthetic-reader".toCharArray(); assertTrue(runCatching { f.root.unlockPdf(prompt.requestID, late) }.isFailure); assertTrue(late.all { it == '\u0000' })
            assertEquals(accepted, f.root.state.value.selectedPaperId); assertEquals(1, f.root.personal.personalPapers().size); f.assertPrivateInputsAbsent()
        } finally { f.close() }
    }
    @Test fun newSelectionStopsOldBatchThenStartsOnlyTheNewOwnedList() = runBlocking {
        val f = RootPdfBatchFixture(provider)
        try {
            f.loaded(); val first = f.source(Kind.NORMAL); val locked = f.source(Kind.ENCRYPTED); val oldLast = f.source(Kind.NORMAL); val replacement = f.source(Kind.NORMAL)
            val old = f.root.importPdfs(listOf(first.first, locked.first, oldLast.first)); f.prompt()
            val current = f.root.importPdfs(listOf(replacement.first))
            assertTrue(runCatching { old.await() }.exceptionOrNull() is CancellationException)
            val result = withTimeout(15000) { current.await() }; assertEquals(1, result.getInt("completed")); assertEquals(0, f.reads(oldLast.first))
            assertEquals(BackupCodec.hash(replacement.second), f.root.state.value.pdfDocument?.sha256); assertEquals(2, f.root.personal.personalPapers().size); f.assertPrivateInputsAbsent()
        } finally { f.close() }
    }
    @Test fun olderQueuedSelectionCannotCancelTheNewerAlreadyWaitingBatch() = runBlocking {
        val f = RootPdfBatchFixture(provider)
        class HoldFirst : CoroutineDispatcher() {
            val count = AtomicInteger(); val first = AtomicReference<Runnable?>()
            override fun dispatch(context: CoroutineContext, block: Runnable) {
                if (count.getAndIncrement() == 0) check(first.compareAndSet(null, block)) else Dispatchers.IO.dispatch(context, block)
            }
            fun release() { Dispatchers.IO.dispatch(EmptyCoroutineContext, first.getAndSet(null) ?: error("Missing held old admission")) }
        }
        val originalScope = RootPdfBatchFixture.field<CoroutineScope>(f.root, "exportScope")
        val queue = HoldFirst(); val controlled = CoroutineScope(SupervisorJob() + queue)
        val scopeField = f.root.javaClass.getDeclaredField("exportScope").also { it.isAccessible = true }
        try {
            f.loaded(); scopeField.set(f.root, controlled)
            val oldOriginal = f.source(Kind.NORMAL); val newOriginal = f.source(Kind.ENCRYPTED)
            val old = f.root.importPdfs(listOf(oldOriginal.first)); assertNotNull(queue.first.get())
            val newest = f.root.importPdfs(listOf(newOriginal.first)); val request = f.prompt()
            queue.release(); assertTrue(runCatching { withTimeout(10000) { old.await() } }.isFailure)
            assertTrue(newest.isActive); assertNull(f.root.state.value.error); assertEquals(request.requestID, f.root.state.value.pdfUnlockPrompt?.requestID)
            assertEquals(0, f.reads(oldOriginal.first)); assertEquals(1, f.reads(newOriginal.first))
            f.root.unlockPdf(request.requestID, "synthetic-reader".toCharArray())
            assertEquals(1, withTimeout(15000) { newest.await() }.getInt("completed")); f.assertPrivateInputsAbsent()
        } finally {
            controlled.cancel()
            queue.first.getAndSet(null)?.let { Dispatchers.IO.dispatch(EmptyCoroutineContext, it) }
            controlled.coroutineContext[Job]?.join()
            scopeField.set(f.root, originalScope); f.close()
        }
    }
    @Test fun wrongPasswordRetriesSameCopiedOriginalAndOldRequestCannotAuthorizeNextItem() = runBlocking {
        val f = RootPdfBatchFixture(provider)
        try {
            f.loaded(); val locked = f.source(Kind.ENCRYPTED); val last = f.source(Kind.NORMAL)
            val owner = f.root.importPdfs(listOf(locked.first, last.first)); val first = f.prompt()
            f.root.unlockPdf(first.requestID, "synthetic-wrong".toCharArray()); val retry = f.prompt(first.requestID)
            assertEquals(1, f.reads(locked.first)); assertEquals(0, f.reads(last.first))
            val late = "synthetic-reader".toCharArray(); assertTrue(runCatching { f.root.unlockPdf(first.requestID, late) }.isFailure); assertTrue(late.all { it == '\u0000' })
            f.root.unlockPdf(retry.requestID, "synthetic-reader".toCharArray()); val result = withTimeout(15000) { owner.await() }
            assertEquals(2, result.getInt("completed")); assertEquals(1, f.reads(locked.first)); assertEquals(1, f.reads(last.first)); f.assertPrivateInputsAbsent()
        } finally { f.close() }
    }
    @Test fun definiteNonPdfStructureFailsOnlyThatItemButProviderFailureStopsTheRemainder() = runBlocking {
        val f = RootPdfBatchFixture(provider)
        try {
            f.loaded(); val bad = f.source(Kind.NON_PDF); val good = f.source(Kind.NORMAL)
            val result = withTimeout(15000) { f.root.importPdfs(listOf(bad.first, good.first)).await() }
            assertEquals("failed", result.getString("status")); assertEquals(1, result.getInt("failed")); assertEquals(1, result.getInt("completed")); assertEquals(0, result.getInt("notDispatched"))
            val blocked = f.source(Kind.PROVIDER_ERROR); val unstarted = f.source(Kind.NORMAL)
            assertTrue(runCatching { withTimeout(15000) { f.root.importPdfs(listOf(blocked.first, unstarted.first)).await() } }.isFailure)
            val last = f.batchResult(); assertEquals(1, last.getInt("failed")); assertEquals(1, last.getInt("notDispatched")); assertEquals(0, f.reads(unstarted.first)); f.assertPrivateInputsAbsent()
        } finally { f.close() }
    }
    @Test fun cancellationInsideActualCommitKeepsAcceptedFactAndDoesNotRelabelItUnimported() = runBlocking {
        val f = RootPdfBatchFixture(provider)
        try {
            f.loaded(); val original = f.source(Kind.NORMAL); val hash = BackupCodec.hash(original.second)
            val cancelObserved = CompletableDeferred<Unit>()
            val observer = launch(Dispatchers.Unconfined, start = CoroutineStart.UNDISPATCHED) {
                f.root.state.first { it.selectedPaperId == "local:$hash" && it.pdfDocument?.sha256 == hash }
                val acquisition = RootPdfBatchFixture.field<AtomicReference<Deferred<JSONObject>?>>(f.root, "pdfAcquisition").get()
                assertNotNull(acquisition); acquisition!!.cancel(CancellationException("Synthetic exact-commit cancellation")); cancelObserved.complete(Unit)
            }
            val owner = f.root.importPdfs(listOf(original.first))
            withTimeout(10000) { cancelObserved.await() }; assertTrue(runCatching { owner.await() }.exceptionOrNull() is CancellationException); observer.join()
            val result = f.batchResult(); assertEquals("completed", result.getString("status")); assertEquals(1, result.getInt("completed")); assertEquals(0, result.getInt("cancelled")); assertEquals(0, result.getInt("notDispatched"))
            assertEquals(1, f.root.personal.personalPapers().size); assertEquals(hash, BackupCodec.hash(original.second)); assertEquals(hash, f.root.state.value.pdfDocument?.sha256); f.assertPrivateInputsAbsent()
        } finally { f.close() }
    }
}
