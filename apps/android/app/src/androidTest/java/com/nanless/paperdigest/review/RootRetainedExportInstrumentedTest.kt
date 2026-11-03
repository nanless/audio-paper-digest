package com.nanless.paperdigest.review

import android.content.ContentProvider
import android.content.ContentValues
import android.content.ContextWrapper
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.provider.ProviderTestRule
import com.nanless.paperdigest.RootController
import com.nanless.paperdigest.cloud.BackupCodec
import com.nanless.paperdigest.data.*
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileNotFoundException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Actual Root + backend + provider in private synthetic data, no production workspace or external services. */
@RunWith(AndroidJUnit4::class)
class RootRetainedExportInstrumentedTest {
    @get:Rule val provider = ProviderTestRule.Builder(Destination::class.java, AUTHORITY).build()
    private class External(val file: File) {
        val writes = AtomicInteger(0)
        @Volatile var rejectRead = false
        @Volatile var blockOpen = false
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
    }
    class Destination : ContentProvider() {
        override fun onCreate() = true
        override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
            val current = outputs[uri.lastPathSegment] ?: throw FileNotFoundException("Unregistered synthetic output")
            if (mode.contains('w')) {
                current.writes.incrementAndGet()
                if (current.blockOpen) { current.entered.countDown(); check(current.release.await(15, TimeUnit.SECONDS)) }
            } else if (current.rejectRead) throw FileNotFoundException("Synthetic readback refused")
            return ParcelFileDescriptor.open(current.file, ParcelFileDescriptor.parseMode(mode))
        }
        override fun getType(uri: Uri) = "application/octet-stream"
        override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, order: String?): Cursor? = null
        override fun insert(uri: Uri, values: ContentValues?): Uri? = null
        override fun delete(uri: Uri, selection: String?, args: Array<out String>?) = 0
        override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?) = 0
    }
    private inner class Fixture {
        val target = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(target.cacheDir, "RootRetained-${UUID.randomUUID()}").canonicalFile.apply { mkdirs() }
        val research = File(directory, "PaperDigest")
        val controls = File(directory, "PaperDigestTransfers/PendingExports")
        val exportRoot = File(directory, "PaperDigestTransfers/Exports")
        val pending = PendingExportStore(exportRoot, controls)
        val externalID = UUID.randomUUID().toString()
        val uri = Uri.parse("content://$AUTHORITY/$externalID")
        val destination = External(File(directory, "synthetic-destination.paperdigest")).also { outputs[externalID] = it }
        val context = object : ContextWrapper(target) {
            override fun getNoBackupFilesDir() = directory
            override fun getContentResolver() = provider.resolver
        }
        val row: PendingExportStore.PendingExport
        val capture: BackupCodec.Captured
        val personalBefore: ByteArray
        val conflictBefore = byteArrayOf(7, 8, 9, 0)
        val controllers = mutableListOf<RootController>()
        init {
            PersonalStore(research).updateSettings(JSONObject().put("offlineMode", true))
            personalBefore = File(research, "personal.json").readBytes()
            row = pending.begin(UUID.randomUUID().toString(), "backup", JSONObject().put("format", "backup").put("workspaceEpoch", "synthetic-original"))
            capture = BackupCodec.capture(research, pending.preparationFile(row.operationID))
            ExportProducerReceipt(File(controls, row.operationID), row.operationID, row.documentID, row.sourceIdentity)
                .recordVerifiedCapture(capture, "application/octet-stream", "synthetic-original.paperdigest")
            // An actual create-only conflict prevents normal cold registration; no source or success state is fabricated.
            File(exportRoot, "${row.documentID}.bin").writeBytes(conflictBefore)
            pending.reconcile()
        }
        suspend fun root(): RootController = RootController(context, installBackground = false).also {
            controllers += it
            withTimeout(10000) { while (it.state.value.pendingExportsLoading) delay(5) }
            assertNull(it.state.value.pendingExportsError)
        }
        fun view(root: RootController) = root.state.value.pendingExports.single { it.getString("operationID") == row.operationID }
        suspend fun retain(root: RootController) {
            val confirm = root.execute("export.retained.stop", JSONObject().put("operationID", row.operationID))
            root.execute("export.retained.confirm", JSONObject().put("confirmationID", confirm.getString("confirmationID")))
            assertEquals("retained", view(root).getString("preparation")); assertFalse(view(root).optBoolean("ready"))
        }
        suspend fun delivery(root: RootController) = root.execute("export.retained.prepare", JSONObject().put("operationID", row.operationID))
        suspend fun stop(root: RootController) { val scope = field<CoroutineScope>(root, "exportScope"); scope.cancel(); scope.coroutineContext[Job]?.join() }
        fun originalsUnchanged() {
            assertArrayEquals(personalBefore, File(research, "personal.json").readBytes())
            assertArrayEquals(conflictBefore, File(exportRoot, "${row.documentID}.bin").readBytes())
            assertEquals(capture.sha256, BackupCodec.hash(capture.file))
        }
        suspend fun close() { destination.release.countDown(); for (root in controllers) stop(root); outputs.remove(externalID); directory.deleteRecursively() }
    }
    @Test fun originalConflictCanBeRetainedAndExactSnapshotSavedWithIndependentProofWithoutResearchRewrite() = runBlocking {
        val f = Fixture(); try {
            val root = f.root(); f.retain(root); val chooser = f.delivery(root)
            assertEquals(f.row.documentID, chooser.getString("documentID")); assertEquals(f.capture.sha256, chooser.getString("sha256"))
            assertEquals("retained", chooser.getString("exportRoute"))
            val result = root.execute("export.retained.save", JSONObject().put("operationID", f.row.operationID).put("attemptID", chooser.getString("attemptID")).put("uri", f.uri.toString()))
            assertTrue(result.getBoolean("saved")); assertTrue(result.getBoolean("verified")); assertFalse(result.getBoolean("cleanupEligible"))
            assertArrayEquals(f.capture.file.readBytes(), f.destination.file.readBytes())
            assertTrue(File(f.research, "ExportHistory/retained-${chooser.getString("attemptID")}.json").isFile)
            assertTrue(root.state.value.jobs.filter { it.optBoolean("localRetainedExport") }.all { it.optString("status") == "completed" })
            assertEquals(0, root.personal.snapshot().getJSONArray("sessions").length()); f.originalsUnchanged()
        } finally { f.close() }
    }
    @Test fun oldConfirmationEpochAndOrdinaryCallbackCannotRetainOrSaveAnotherOperation() = runBlocking {
        val f = Fixture(); try {
            val root = f.root(); val confirm = root.execute("export.retained.stop", JSONObject().put("operationID", f.row.operationID))
            field<WorkspaceDispatch>(root, "dispatch").rotate()
            assertTrue(runCatching { root.execute("export.retained.confirm", JSONObject().put("confirmationID", confirm.getString("confirmationID"))) }.isFailure)
            f.retain(root)
            assertTrue(runCatching { root.execute("export.save", JSONObject().put("operationID", f.row.operationID).put("attemptID", UUID.randomUUID().toString()).put("uri", f.uri.toString())) }.isFailure)
            assertEquals(0, f.destination.writes.get()); f.originalsUnchanged()
        } finally { f.close() }
    }
    @Test fun coldOldLeaseIsRejectedAndExplicitNewInspectionUsesSameOriginalBytes() = runBlocking {
        val f = Fixture(); try {
            val first = f.root(); f.retain(first); val old = f.delivery(first); f.stop(first)
            val second = f.root()
            assertTrue(runCatching { second.execute("export.retained.save", JSONObject().put("operationID", f.row.operationID).put("attemptID", old.getString("attemptID")).put("uri", f.uri.toString())) }.isFailure)
            assertEquals(0, f.destination.writes.get())
            val fresh = f.delivery(second); assertNotEquals(old.getString("attemptID"), fresh.getString("attemptID"))
            assertEquals(old.getString("documentID"), fresh.getString("documentID")); assertEquals(old.getString("sha256"), fresh.getString("sha256")); f.originalsUnchanged()
        } finally { f.close() }
    }
    @Test fun nativeReadbackFailureDoesNotBecomeVerifiedOrOrdinaryCleanupPermission() = runBlocking {
        val f = Fixture(); try {
            val root = f.root(); f.retain(root); val chooser = f.delivery(root); f.destination.rejectRead = true
            assertTrue(runCatching { root.execute("export.retained.save", JSONObject().put("operationID", f.row.operationID).put("attemptID", chooser.getString("attemptID")).put("uri", f.uri.toString())) }.isFailure)
            val actual = f.view(root).getJSONObject("retainedDelivery")
            assertFalse(actual.getBoolean("readbackProven")); assertFalse(actual.getBoolean("cleanupEligible"))
            assertArrayEquals(f.capture.file.readBytes(), f.destination.file.readBytes()); f.originalsUnchanged()
        } finally { f.close() }
    }
    @Test fun screenAwaitCancellationLeavesWriterActiveAndExplicitCancellationWaitsForProviderDrain() = runBlocking {
        val f = Fixture(); try {
            val root = f.root(); f.retain(root); val chooser = f.delivery(root); f.destination.blockOpen = true
            val caller = async { root.execute("export.retained.save", JSONObject().put("operationID", f.row.operationID).put("attemptID", chooser.getString("attemptID")).put("uri", f.uri.toString())) }
            withContext(Dispatchers.IO) { assertTrue(f.destination.entered.await(10, TimeUnit.SECONDS)) }
            caller.cancelAndJoin(); assertTrue(root.state.value.notice.orEmpty().contains("仍在后台"))
            val original = root.state.value.jobs.single { it.optString("kind") == "export.retained.save" }
            val stop = async { root.execute("jobs.cancel", JSONObject().put("id", original.getString("id"))) }
            withTimeout(5000) { while (field<ConcurrentHashMap<String, Job>>(root, "active")[original.getString("id")]?.isCancelled != true) delay(5) }
            assertTrue(stop.isActive)
            assertEquals("running", root.state.value.jobs.single { it.optString("id") == original.getString("id") }.getString("status"))
            f.destination.release.countDown(); withTimeout(10000) { stop.await() }
            assertEquals("cancelled", root.state.value.jobs.single { it.optString("id") == original.getString("id") }.getString("status"))
            f.originalsUnchanged()
        } finally { f.close() }
    }
    @Test fun missingProofAfterSuccessIsUnconfirmedInActualRootColdProjection() = runBlocking {
        val f = Fixture(); try {
            val first = f.root(); f.retain(first); val chooser = f.delivery(first)
            first.execute("export.retained.save", JSONObject().put("operationID", f.row.operationID).put("attemptID", chooser.getString("attemptID")).put("uri", f.uri.toString()))
            f.stop(first)
            assertTrue(File(f.directory, "PaperDigestDevice/RetainedCaptureExportProofs/${chooser.getString("attemptID")}.json").delete())
            val second = f.root(); val current = f.view(second).getJSONObject("retainedDelivery")
            assertEquals("unconfirmed", current.getString("state")); assertFalse(current.getBoolean("readbackProven"))
            val history = f.view(second).getJSONArray("retainedHistory").getJSONObject(0)
            assertEquals("unconfirmed", history.getString("state")); assertFalse(history.getBoolean("readbackProven")); f.originalsUnchanged()
        } finally { f.close() }
    }
    @Test fun stopThenDiscardConfirmationPublishesActualCancelledChooserState() = runBlocking {
        val f = Fixture(); try {
            // Allow normal original registration first, then invalidate only the private test output.
            assertTrue(File(f.exportRoot, "${f.row.documentID}.bin").delete())
            val root = f.root()
            assertEquals("ready", f.view(root).getString("preparation"))
            root.execute("export.delivery.prepare", JSONObject().put("operationID", f.row.operationID))
            File(f.exportRoot, "${f.row.documentID}.bin").appendBytes(byteArrayOf(42))
            root.execute("export.reconcile", JSONObject().put("operationID", f.row.operationID))
            assertEquals("unavailable", f.view(root).getString("preparation"))
            assertEquals("choosing", f.view(root).getString("delivery"))
            val confirmation = root.execute("export.retained.stop", JSONObject().put("operationID", f.row.operationID))
            root.execute("export.retained.confirm.discard", JSONObject().put("confirmationID", confirmation.getString("confirmationID")))
            val actual = f.pending.get(f.row.operationID)
            assertEquals("cancelled", actual.delivery)
            assertEquals("Published UI must match actual chooser retirement even when retain confirmation is cancelled", actual.delivery, f.view(root).getString("delivery"))
            assertEquals("unavailable", f.view(root).getString("preparation"))
            assertNull(root.state.value.retainedExportConfirmation)
            assertEquals(0, f.destination.writes.get())
            assertArrayEquals(f.personalBefore, File(f.research, "personal.json").readBytes())
            assertEquals(f.capture.sha256, BackupCodec.hash(f.capture.file))
        } finally { f.close() }
    }
    @Test fun restoringWorkspaceRetiresOldBackendChooserAndAllowsExplicitSameOriginalPreparation() = runBlocking {
        val f = Fixture(); try {
            val root = f.root(); f.retain(root); val old = f.delivery(root)
            f.destination.file.writeBytes(f.capture.file.readBytes())
            val prepared = root.execute("app.restore.prepare", JSONObject().put("uri", f.uri.toString()))
            root.execute("app.restore.commit", JSONObject().put("restoreID", prepared.getString("restoreID")))
            assertTrue(runCatching {
                root.execute("export.retained.delivery.validate", JSONObject().put("operationID", f.row.operationID).put("attemptID", old.getString("attemptID")))
            }.isFailure)
            val next = f.delivery(root)
            assertNotEquals(old.getString("attemptID"), next.getString("attemptID"))
            assertEquals(old.getString("documentID"), next.getString("documentID"))
            assertEquals(f.capture.sha256, next.getString("sha256"))
            assertEquals(f.capture.sha256, BackupCodec.hash(f.capture.file))
            assertArrayEquals(f.conflictBefore, File(f.exportRoot, "${f.row.documentID}.bin").readBytes())
            assertEquals(0, root.personal.snapshot().getJSONArray("sessions").length())
        } finally { f.close() }
    }
    @Test fun noteWaitingBeforeWorkspaceReplacementCannotWriteAtTheSameRevisionAfterward() = runBlocking {
        val f = Fixture()
        try {
            val root = f.root()
            val paperID = "synthetic-note-owner"
            val payload = JSONObject().put("paperID", paperID).put("text", "旧界面尚待保存").put("baseRevision", 1)
            root.personal.saveNote(paperID, "恢复前正文", 0)
            val maintenance = field<Mutex>(root, "maintenance")
            val dispatch = field<WorkspaceDispatch>(root, "dispatch")
            maintenance.lock()
            val waiting = async(start = CoroutineStart.UNDISPATCHED) {
                runCatching { root.execute("personal.note", payload) }.exceptionOrNull()
            }
            try {
                assertFalse(waiting.isCompleted)
                // Recreate the critical section of replacement with the same note revision.
                val restored = root.personal.snapshot()
                restored.getJSONObject("notes").getJSONObject(paperID).put("text", "已恢复的正文")
                dispatch.rotate()
                root.personal.replaceValidated(restored)
            } finally {
                maintenance.unlock()
            }
            val error = withTimeout(10_000) { waiting.await() }
            assertNotNull(error)
            assertTrue(error!!.message.orEmpty().contains("恢复前"))
            val actual = root.personal.snapshot().getJSONObject("notes").getJSONObject(paperID)
            assertEquals("已恢复的正文", actual.getString("text"))
            assertEquals(1, actual.getInt("revision"))
        } finally { f.close() }
    }

    @Test fun anotherPreparedBackupCannotReplaceNewEditsAfterTheFirstRestore() = runBlocking {
        val f = Fixture()
        try {
            val root = f.root()
            f.destination.file.writeBytes(f.capture.file.readBytes())
            val prepare = JSONObject().put("uri", f.uri.toString())
            val first = root.execute("app.restore.prepare", prepare).getString("restoreID")
            val stale = root.execute("app.restore.prepare", prepare).getString("restoreID")
            assertNotEquals(first, stale)
            assertTrue(root.execute("app.restore.commit", JSONObject().put("restoreID", first)).getBoolean("restored"))
            root.execute("personal.note", JSONObject().put("paperID", "synthetic-new-edit")
                .put("text", "第一次恢复后新增的笔记").put("baseRevision", 0))
            val before = File(f.research, "personal.json").readBytes()
            val error = runCatching {
                root.execute("app.restore.commit", JSONObject().put("restoreID", stale))
            }.exceptionOrNull()
            assertNotNull(error)
            assertTrue(error!!.message.orEmpty().contains("恢复前"))
            assertArrayEquals(before, File(f.research, "personal.json").readBytes())
            assertTrue(root.execute("restore.discard", JSONObject().put("restoreID", stale)).getBoolean("cancelled"))
            assertEquals(f.capture.sha256, BackupCodec.hash(f.destination.file))
        } finally { f.close() }
    }

    @Test fun activeRestoreRejectsAnOldEditWhileTheRealInstallWaitsToPublishItsEpoch() = runBlocking {
        val f = Fixture()
        try {
            val root = f.root()
            val paper = "synthetic-held-install"
            root.personal.saveNote(paper, "快照正文", 0)
            BackupCodec.capture(f.research, f.destination.file)
            val handle = root.execute("app.restore.prepare", JSONObject().put("uri", f.uri.toString()))
                .getString("restoreID")
            val before = root.personal.snapshot()
            before.getJSONObject("notes").getJSONObject(paper).put("text", "恢复前正文")
            root.personal.replaceValidated(before)
            val dispatch = field<WorkspaceDispatch>(root, "dispatch")
            val oldEpoch = dispatch.epoch
            val install = async(Dispatchers.IO, start = CoroutineStart.LAZY) {
                root.execute("app.restore.commit", JSONObject().put("restoreID", handle))
            }
            synchronized(dispatch) {
                install.start()
                // The real installer can rename/reload its candidate tree, but its final
                // synchronized epoch rotation waits here until this test releases the monitor.
                val deadline = android.os.SystemClock.elapsedRealtime() + 10_000L
                while (root.personal.note(paper).getString("text") != "快照正文") {
                    check(android.os.SystemClock.elapsedRealtime() < deadline) { "没有到达实际恢复安装边界" }
                    Thread.sleep(5)
                }
                assertEquals(oldEpoch, dispatch.epoch)
                assertFalse(install.isCompleted)
                val error = runBlocking {
                    withTimeout(2_000) {
                        runCatching {
                            root.execute("personal.note", JSONObject().put("paperID", paper)
                                .put("baseRevision", 1).put("text", "安装中旧界面提交"))
                        }.exceptionOrNull()
                    }
                }
                assertNotNull(error)
                assertTrue(error!!.message.orEmpty().contains("正在恢复"))
            }
            assertTrue(withTimeout(10_000) { install.await() }.getBoolean("restored"))
            assertNotEquals(oldEpoch, dispatch.epoch)
            assertEquals("快照正文", root.personal.note(paper).getString("text"))
            assertEquals(1, root.personal.note(paper).getInt("revision"))
        } finally { f.close() }
    }

    @Test fun aFailedInstallKeepsTheOriginalPreparationUsableAfterRestoringItsExactBytes() = runBlocking {
        val f = Fixture()
        try {
            val root = f.root()
            f.destination.file.writeBytes(f.capture.file.readBytes())
            val handle = root.execute("app.restore.prepare", JSONObject().put("uri", f.uri.toString()))
                .getString("restoreID")
            val dispatch = field<WorkspaceDispatch>(root, "dispatch")
            val oldEpoch = dispatch.epoch
            val handles = field<ConcurrentHashMap<String, Any>>(root, "restores")
            val stage = field<BackupCodec.Staged>(handles.getValue(handle), "staged")
            val candidate = File(stage.directory, "personal.json")
            val original = candidate.readBytes()
            val before = File(f.research, "personal.json").readBytes()
            candidate.appendText("\n")
            val confirmation = JSONObject().put("restoreID", handle)
            assertTrue(runCatching { root.execute("app.restore.commit", confirmation) }.isFailure)
            assertEquals(oldEpoch, dispatch.epoch)
            assertArrayEquals(before, File(f.research, "personal.json").readBytes())
            assertTrue(candidate.isFile)
            candidate.writeBytes(original)
            assertTrue(root.execute("app.restore.commit", confirmation).getBoolean("restored"))
            assertNotEquals(oldEpoch, dispatch.epoch)
            assertEquals(f.capture.sha256, BackupCodec.hash(f.destination.file))
        } finally { f.close() }
    }

    @Test fun aDisposedAnswerCannotSaveIntoTheRestoredCopyOfTheSameStudy() = runBlocking {
        val f = Fixture()
        try {
            val root = f.root()
            val session = JSONObject().put("id", "synthetic-restored-answer")
                .put("paperID", "synthetic-position-owner").put("answer", "同一份已保存的回答")
            root.personal.appendSession(session)
            val identity = requireNotNull(studyAnswerPositionIdentity(session))
            val originalPosition = JSONObject().put("sessionID", identity.sessionID)
                .put("binding", identity.binding).put("scroll", 27)
            assertTrue(root.execute("personal.studyScroll", originalPosition).getBoolean("saved"))
            val renderedEpoch = requireNotNull(root.state.value.workspaceEpoch)
            BackupCodec.capture(f.research, f.destination.file)
            val handle = root.execute("app.restore.prepare", JSONObject().put("uri", f.uri.toString()))
                .getString("restoreID")
            root.execute("app.restore.commit", JSONObject().put("restoreID", handle))
            val restoredEpoch = requireNotNull(root.state.value.workspaceEpoch)
            assertNotEquals(renderedEpoch, restoredEpoch)

            val latePosition = originalPosition.copy().put("scroll", 90)
            val before = File(f.research, "personal.json").readBytes()
            val rejected = root.executeInWorkspace("personal.studyScroll", latePosition, renderedEpoch)
            assertEquals("not-adopted", rejected.getString("status"))
            assertArrayEquals(before, File(f.research, "personal.json").readBytes())
            assertEquals(27, savedStudyAnswerScroll(root.personal.snapshot(), session))
            assertTrue(root.executeInWorkspace("personal.studyScroll", latePosition, restoredEpoch).getBoolean("saved"))
            assertEquals(90, savedStudyAnswerScroll(root.personal.snapshot(), session))
        } finally { f.close() }
    }

    private fun <T> field(value: Any, name: String): T {
        @Suppress("UNCHECKED_CAST") return value.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(value) as T
    }
    companion object {
        private const val AUTHORITY = "com.nanless.paperdigest.synthetic.retained.export"
        private val outputs = ConcurrentHashMap<String, External>()
    }
}
