package com.nanless.paperdigest

import android.content.ContextWrapper
import android.graphics.Paint
import android.graphics.pdf.PdfDocument
import androidx.test.platform.app.InstrumentationRegistry
import com.nanless.paperdigest.cloud.RequestContinuity
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.model.StudyService
import com.nanless.paperdigest.pdf.PdfDocumentRef
import com.nanless.paperdigest.pdf.PdfRepository
import com.nanless.paperdigest.secret.SecretStore
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.encryption.AccessPermission
import com.tom_roush.pdfbox.pdmodel.encryption.StandardProtectionPolicy
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicInteger

/**
 * Offline navigation contracts using clearly synthetic public text, not scientific evidence or
 * current-production/paid acceptance. prepare() seals real extracted input; run() is never called.
 * Only noBackupFilesDir is overridden. No application controller, real settings, or vault access.
 */
class StudySourceNavigationInstrumentedTest {
    private class ForbiddenSecretStore : SecretStore {
        val loads = AtomicInteger()
        val saves = AtomicInteger()
        val removes = AtomicInteger()
        override fun load(scope: String): String? { loads.incrementAndGet(); error("Synthetic navigation must not load secrets") }
        override fun save(scope: String, secret: String) { saves.incrementAndGet(); error("Synthetic navigation must not save secrets") }
        override fun remove(scope: String) { removes.incrementAndGet(); error("Synthetic navigation must not remove secrets") }
        fun assertUntouched() {
            assertEquals(0, loads.get()); assertEquals(0, saves.get()); assertEquals(0, removes.get())
        }
    }

    private class Fixture {
        private val target = InstrumentationRegistry.getInstrumentation().targetContext
        val directory: File = Files.createTempDirectory(target.cacheDir.toPath(), "synthetic-study-source-").toFile().canonicalFile
        private val context = object : ContextWrapper(target) {
            override fun getNoBackupFilesDir(): File = directory
        }
        val secrets = ForbiddenSecretStore()
        val root = RootController(context, installBackground = false, secretStore = secrets)
        private val research = root.personal.directory
        private val repository = PdfRepository(context, research)
        lateinit var a: PdfDocumentRef
        lateinit var b: PdfDocumentRef
        lateinit var session: JSONObject
        lateinit var input: File
        lateinit var originalInput: ByteArray
        lateinit var originalSession: String

        private var syntheticArchive = false
        private val archivedFiles = linkedMapOf<File, ByteArray>()
        private val originals = linkedMapOf<File, ByteArray>()
        val fixturePassword = "synthetic-navigation-only-password"
        lateinit var responseReceipt: File
        lateinit var originalReceipt: ByteArray

        suspend fun ready(encryptedA: Boolean = false) {
            awaitIdle()
            assertEquals(File(directory, "PaperDigest").canonicalFile, research.canonicalFile)
            root.personal.updateSettings(JSONObject().put("offlineMode", true)
                .put("endpoint", "https://example.invalid/v1").put("model", "test-model")
                .put("protocol", "chat").put("maxTokens", 512).put("httpProxy", ""))
            a = importSynthetic("A", encryptedA)
            b = importSynthetic("B")
            for (document in listOf(a, b)) originals[File(document.localPath)] = File(document.localPath).readBytes()
            assertNotEquals(a.sha256, b.sha256)
            val evidence = repository.evidence(a, 2, 2)
            assertEquals(listOf(2), evidence.pages)
            assertTrue(evidence.text.startsWith("[原文物理页 2]\n"))
            assertTrue(evidence.text.contains("SYNTHETIC PUBLIC NAVIGATION A physical page 2"))
            val source = JSONObject().put("paperID", a.id).put("kind", evidence.kind)
                .put("pdfSHA", a.sha256).put("pages", JSONArray(evidence.pages))
                .put("missingTextPages", JSONArray(evidence.missingTextPages))
                .put("allPagesHaveExtractableText", evidence.missingTextPages.isEmpty())
                .put("includesImages", false).put("extractor", "android-pdfbox-physical-pages-v1")
            val service = StudyService(root.personal, { error("prepare must not request a key") })
            session = service.prepare(a.id, "Synthetic navigation question, not scientific analysis", evidence.text, source)
            input = File(research, "ModelUsage/${session.getString("id")}-input.json")
            originalInput = input.readBytes()
            originalSession = canonical(session)
            assertNotNull(readSavedStudyInput(session, research))
            assertFalse(session.getBoolean("requestIssued"))
            assertNull(root.state.value.selectedPaperId)
            assertNoRequest()
        }

        /** Controlled archive bytes, not a provider response, paid result, or authenticated replay.
         * requestIssued is synthetic archived metadata ONLY; StudyService.run is never invoked.
         */
        fun savedSyntheticResponse() {
            val id = session.getString("id")
            val answer = "SYNTHETIC ARCHIVED NAVIGATION RESPONSE; no provider request was made."
            val body = JSONObject().put("model", "synthetic-archive-only")
                .put("choices", JSONArray().put(JSONObject().put("message", JSONObject()
                    .put("role", "assistant").put("content", answer)).put("finish_reason", "stop")))
                .toString().toByteArray(Charsets.UTF_8)
            val started = "2026-01-01T00:00:00Z"
            val ended = "2026-01-01T00:00:01Z"
            val receipt = JSONObject().put("contract", "android-model-response-v1").put("sessionID", id)
                .put("inputSHA256", session.getString("inputSHA256")).put("sha256", sha256(body))
                .put("httpStatus", 200).put("startedAt", started).put("receivedAt", ended)
            responseReceipt = File(research, "ModelUsage/$id-response.json")
            originalReceipt = receipt.toString().toByteArray(Charsets.UTF_8)
            val responseBody = File(research, "ModelUsage/$id-response.bin")
            responseBody.writeBytes(body); responseReceipt.writeBytes(originalReceipt)
            archivedFiles[responseBody] = body; archivedFiles[responseReceipt] = originalReceipt
            session.put("requestIssued", true).put("status", "completed").put("responseSHA256", sha256(body))
                .put("httpStatus", 200).put("startedAt", started).put("endedAt", ended)
                .put("answer", answer).put("text", answer).put("response", answer)
                .put("actualModel", "synthetic-archive-only").put("finishStatus", "stop")
                .put("charge", "synthetic-no-request").put("isSyntheticArchiveMetadata", true)
                .put("syntheticCaptureFacts", JSONObject().put("byteCount", body.size).put("httpStatus", 200)
                    .put("actualProviderCalls", 0).put("bodyComplete", true))
            root.personal.appendSession(session)
            syntheticArchive = true
            originalSession = canonical(session)
            assertNotNull(requireNotNull(readSavedStudyInput(session, research)).originalResponseBinding)
            assertOriginals()
        }

        fun clearFixturePdfPasswords() = repository.clearSessionPasswords()

        private suspend fun importSynthetic(label: String, encrypted: Boolean = false): PdfDocumentRef {
            val source = File(directory, "synthetic-public-$label.pdf")
            val pdf = PdfDocument()
            try {
                repeat(3) { index ->
                    val page = pdf.startPage(PdfDocument.PageInfo.Builder(500, 300, index + 1).create())
                    page.canvas.drawText("SYNTHETIC PUBLIC NAVIGATION $label physical page ${index + 1}",
                        16f, 60f, Paint().apply { textSize = 12f })
                    pdf.finishPage(page)
                }
                source.outputStream().use { pdf.writeTo(it) }
            } finally { pdf.close() }
            val importedSource = if (encrypted) {
                File(directory, "synthetic-public-$label-encrypted.pdf").also { encryptedFile ->
                    PDDocument.load(source).use { document ->
                        document.protect(StandardProtectionPolicy("synthetic-navigation-owner", fixturePassword,
                            AccessPermission()).apply { encryptionKeyLength = 128 })
                        document.save(encryptedFile)
                    }
                }
            } else source
            val document = repository.importFile(importedSource, password = if (encrypted) fixturePassword else null)
            assertEquals(3, document.pageCount)
            assertEquals(sha256(importedSource.readBytes()), document.sha256)
            // Same local-paper registration as RootController.importPdfOriginal, without a provider.
            root.personal.rememberPaper(Paper(document.id, document.displayName.removeSuffix(".pdf"),
                sourceKind = "local", identityStatus = "local-original", localPDFPath = document.localPath,
                pdfSHA256 = document.sha256))
            return document
        }

        suspend fun openB() {
            root.execute("paper.open", JSONObject().put("paperID", b.id))
            assertTrue(root.execute("pdf.open", JSONObject()).getBoolean("opened"))
            root.execute("pdf.page", JSONObject().put("paperID", b.id).put("pdfSHA", b.sha256).put("page", 3))
            assertEquals(b.sha256, root.state.value.pdfDocument!!.sha256)
        }

        suspend fun openSource(page: Int = 2): JSONObject = root.execute("pdf.studySource.open",
            JSONObject().put("sessionID", session.getString("id")).put("page", page))

        fun assertOriginals(expectedReceipt: ByteArray? = null) {
            assertEquals(originalSession, canonical(root.personal.session(session.getString("id"))!!))
            assertArrayEquals(originalInput, input.readBytes())
            for ((file, bytes) in originals) assertArrayEquals(bytes, file.readBytes())
            for ((file, bytes) in archivedFiles) assertArrayEquals(
                if (file == responseReceipt && expectedReceipt != null) expectedReceipt else bytes, file.readBytes())
            assertNoRequest()
        }

        fun assertNoRequest() {
            secrets.assertUntouched()
            val sessions = root.personal.snapshot().getJSONArray("sessions")
            for (index in 0 until sessions.length()) {
                val record = sessions.getJSONObject(index)
                if (syntheticArchive && record.getString("id") == session.getString("id")) {
                    assertTrue(record.getBoolean("isSyntheticArchiveMetadata"))
                    assertTrue(record.getBoolean("requestIssued"))
                    assertEquals(0, record.getJSONObject("syntheticCaptureFacts").getInt("actualProviderCalls"))
                } else assertFalse(record.optBoolean("requestIssued"))
            }
            assertFalse(File(research, RequestContinuity.FILE).exists())
            if (!syntheticArchive) assertFalse(File(research, "ModelUsage/${session.optString("id")}-response.bin").exists())
        }

        suspend fun awaitIdle() {
            withTimeout(10_000) {
                while (root.state.value.pendingExportsLoading || root.state.value.loading || root.state.value.busy) delay(5)
            }
        }

        suspend fun finish() {
            awaitIdle()
            val jobs = root.personal.snapshot().getJSONArray("jobs")
            for (index in 0 until jobs.length()) {
                assertFalse(jobs.getJSONObject(index).optString("status") in setOf("queued", "running"))
            }
            secrets.assertUntouched()
            // Keep this private cache fixture for forensics; no reflection, blanket delete or close API.
        }
    }

    @Test fun sealedPhysicalPageReplacesOtherOwnerAndPreservesOriginalStudyWithoutIssuingRequest() = runBlocking {
        val f = Fixture()
        try {
            f.ready(); f.openB()
            val result = f.openSource()
            assertTrue(result.getBoolean("opened"))
            assertEquals(f.a.id, result.getString("paperID"))
            assertEquals(f.session.getString("id"), result.getString("sessionID"))
            val state = f.root.state.value
            assertEquals(f.a.id, state.selectedPaperId)
            assertEquals(f.a.id, state.viewedPaper!!.id)
            assertEquals(f.a.sha256, state.pdfDocument!!.sha256)
            assertEquals(2, state.pdfPage); assertTrue(state.pdfMode)
            val receipt = state.pdfReceipt
            assertEquals(f.a.id, receipt.getString("paperID"))
            assertEquals(f.a.sha256, receipt.getString("sha256"))
            assertEquals(f.session.getString("id"), receipt.getString("sessionID"))
            assertEquals(f.session.getString("inputSHA256"), receipt.getString("inputSHA256"))
            assertTrue(receipt.getString("sourceNavigationID").isNotBlank())
            assertEquals("study-input-bound-original", receipt.getString("currentness"))
            val firstNavigation = receipt.getString("sourceNavigationID")
            f.openSource()
            assertNotEquals(firstNavigation, f.root.state.value.pdfReceipt.getString("sourceNavigationID"))
            f.assertOriginals()
        } finally { f.finish() }
    }

    @Test fun sealedSourceCanOpenWithNoSelectedOwner() = runBlocking {
        val f = Fixture()
        try {
            f.ready(); assertNull(f.root.state.value.selectedPaperId)
            assertTrue(f.openSource().getBoolean("opened"))
            assertEquals(f.a.id, f.root.state.value.selectedPaperId)
            assertEquals(f.a.sha256, f.root.state.value.pdfDocument!!.sha256)
            assertEquals(2, f.root.state.value.pdfPage); assertTrue(f.root.state.value.pdfMode)
            f.assertOriginals()
        } finally { f.finish() }
    }

    @Test fun summaryTamperingAndPageOutsideSealedInputCannotAdoptAnotherPdf() = runBlocking {
        val f = Fixture()
        try {
            f.ready(); f.openB()
            val before = navigationIdentity(f.root)
            for (key in listOf("pages", "pdfSHA")) {
                val tampered = JSONObject(f.originalSession)
                tampered.getJSONObject("source").put(key, if (key == "pages") JSONArray(listOf(2, 3)) else f.b.sha256)
                try {
                    f.root.personal.appendSession(tampered)
                    assertTrue(runCatching { f.openSource() }.isFailure)
                    assertEquals(before, navigationIdentity(f.root))
                    assertArrayEquals(f.originalInput, f.input.readBytes())
                } finally { f.root.personal.appendSession(JSONObject(f.originalSession)) }
            }
            // Page 3 exists physically, but was never in this study's actual input [2].
            assertTrue(runCatching { f.openSource(3) }.isFailure)
            assertEquals(before, navigationIdentity(f.root)); f.assertOriginals()
        } finally { f.finish() }
    }

    @Test fun missingOriginalAndChangedOrMissingInputLeaveOtherOwnerPageAndReceiptIntact() = runBlocking {
        val f = Fixture()
        try {
            f.ready(); f.openB()
            val before = navigationIdentity(f.root)
            val original = File(f.a.localPath).canonicalFile
            val parked = File(original.parentFile, "${original.name}.synthetic-parked")
            require(original.parentFile == File(f.root.personal.directory, "Imports").canonicalFile)
            require(!parked.exists() && parked.canonicalFile.parentFile == original.parentFile)
            Files.move(original.toPath(), parked.toPath())
            try {
                assertTrue(runCatching { f.openSource() }.isFailure)
                assertEquals(before, navigationIdentity(f.root))
            } finally { Files.move(parked.toPath(), original.toPath()) }
            try {
                f.input.writeBytes(f.originalInput + " ".toByteArray())
                assertTrue(runCatching { f.openSource() }.isFailure)
                assertEquals(before, navigationIdentity(f.root))
            } finally { f.input.writeBytes(f.originalInput) }
            val parkedInput = File(f.input.parentFile, "${f.input.name}.synthetic-parked")
            require(f.input.canonicalFile.parentFile == File(f.root.personal.directory, "ModelUsage").canonicalFile)
            require(!parkedInput.exists() && parkedInput.canonicalFile.parentFile == f.input.canonicalFile.parentFile)
            Files.move(f.input.toPath(), parkedInput.toPath())
            try {
                assertTrue(runCatching { f.openSource() }.isFailure)
                assertEquals(before, navigationIdentity(f.root))
            } finally { Files.move(parkedInput.toPath(), f.input.toPath()) }
            f.assertOriginals()
        } finally { f.finish() }
    }

    @Test fun studyScrollUsesOriginalRecordBindingNotCurrentlySelectedOwner() = runBlocking {
        val f = Fixture()
        try {
            f.ready(); f.openB()
            val before = navigationIdentity(f.root)
            val identity = requireNotNull(studyAnswerPositionIdentity(f.session))
            val payload = JSONObject().put("sessionID", identity.sessionID).put("binding", identity.binding).put("scroll", 123)
            assertTrue(f.root.execute("personal.studyScroll", payload).getBoolean("saved"))
            assertEquals(123, savedStudyAnswerScroll(f.root.personal.snapshot(), f.session))
            assertFalse(f.root.personal.snapshot().getJSONObject("readingState").getJSONObject(f.b.id).has("studyAnswerScroll"))
            val reading = canonical(f.root.personal.snapshot().getJSONObject("readingState"))
            for (bad in listOf(JSONObject(payload.toString()).put("binding", "stale-synthetic-binding"),
                JSONObject(payload.toString()).put("scroll", -1))) {
                assertTrue(runCatching { f.root.execute("personal.studyScroll", bad) }.isFailure)
                assertEquals(reading, canonical(f.root.personal.snapshot().getJSONObject("readingState")))
            }
            assertEquals(before, navigationIdentity(f.root)); f.assertOriginals()
        } finally { f.finish() }
    }

    @Test(timeout = 20_000) fun declaredSavedSyntheticResponseOpensItsOriginalPageWithoutRequestsOrArchiveChanges() = runBlocking {
        withTimeout(18_000) {
            val f = Fixture()
            try {
                f.ready(); f.savedSyntheticResponse(); f.openB()
                assertTrue(f.openSource().getBoolean("opened"))
                val state = f.root.state.value
                assertEquals(f.a.id, state.selectedPaperId); assertEquals(f.a.id, state.viewedPaper!!.id)
                assertEquals(f.a.sha256, state.pdfDocument!!.sha256)
                assertEquals(f.a.localPath, state.pdfDocument!!.localPath)
                assertEquals(2, state.pdfPage); assertTrue(state.pdfMode)
                assertEquals(f.session.getString("id"), state.pdfReceipt.getString("sessionID"))
                assertEquals(f.session.getString("inputSHA256"), state.pdfReceipt.getString("inputSHA256"))
                f.assertOriginals()
            } finally { f.finish() }
        }
    }

    @Test(timeout = 20_000) fun missingOrMisboundSavedResponseReceiptCannotAdoptAnotherPdf() = runBlocking {
        withTimeout(18_000) {
            val f = Fixture()
            try {
                f.ready(); f.savedSyntheticResponse(); f.openB()
                val before = navigationIdentity(f.root)
                // Only this explicitly synthetic fixture's archived receipt is changed.
                val parked = File(f.responseReceipt.parentFile, "${f.responseReceipt.name}.synthetic-parked")
                require(f.responseReceipt.canonicalFile.parentFile == File(f.root.personal.directory, "ModelUsage").canonicalFile)
                require(!parked.exists() && parked.canonicalFile.parentFile == f.responseReceipt.canonicalFile.parentFile)
                Files.move(f.responseReceipt.toPath(), parked.toPath())
                try {
                    assertTrue(runCatching { f.openSource() }.isFailure)
                    assertEquals(before, navigationIdentity(f.root))
                } finally { Files.move(parked.toPath(), f.responseReceipt.toPath()) }
                f.assertOriginals()
                for (key in listOf("sessionID", "inputSHA256")) {
                    val bad = JSONObject(f.originalReceipt.toString(Charsets.UTF_8)).put(key,
                        if (key == "sessionID") "00000000-0000-0000-0000-000000000000" else "0".repeat(64))
                        .toString().toByteArray(Charsets.UTF_8)
                    try {
                        f.responseReceipt.writeBytes(bad)
                        assertTrue(runCatching { f.openSource() }.isFailure)
                        assertEquals(before, navigationIdentity(f.root)); f.assertOriginals(bad)
                    } finally { f.responseReceipt.writeBytes(f.originalReceipt) }
                }
                f.assertOriginals()
            } finally { f.finish() }
        }
    }

    @Test(timeout = 20_000) fun receiptByteMutationDuringActualNativePasswordWaitIsRejectedAtFinalSourceCas() = runBlocking {
        withTimeout(18_000) {
            val f = Fixture()
            try {
                f.ready(encryptedA = true); f.savedSyntheticResponse(); f.openB()
                val before = navigationIdentity(f.root)
                // Public repository API, scoped to this fixture's directory; no vault/global reset.
                f.clearFixturePdfPasswords()
                val opening = async { runCatching { f.openSource() } }
                try {
                    val prompt = withTimeout(5_000) {
                        while (f.root.state.value.pdfUnlockPrompt == null) {
                            assertFalse("Source open must reach a real native password wait", opening.isCompleted)
                            delay(5)
                        }
                        requireNotNull(f.root.state.value.pdfUnlockPrompt)
                    }
                    assertEquals("study-source", prompt.purpose)
                    assertFalse(prompt.checking)
                    assertEquals(before, navigationIdentity(f.root)); f.assertOriginals()
                    // Valid JSON with identical fields/body: only exact receipt bytes differ.
                    val changedReceipt = f.originalReceipt + "\n".toByteArray(Charsets.UTF_8)
                    f.responseReceipt.writeBytes(changedReceipt)
                    f.assertOriginals(changedReceipt)
                    val password = f.fixturePassword.toCharArray()
                    f.root.unlockPdf(prompt.requestID, password) // Same controller API as native unlock UI.
                    assertTrue(password.all { it == '\u0000' })
                    val failure = withTimeout(5_000) { opening.await() }.exceptionOrNull()
                    assertNotNull("Final source CAS must reject a byte-only receipt change", failure)
                    assertTrue("Rejection must come from final sealed-binding comparison, not password parsing",
                        failure!!.message.orEmpty().contains("原封存输入、已保存响应材料字节或身份已变化"))
                    assertNull(f.root.state.value.pdfUnlockPrompt)
                    assertEquals(before, navigationIdentity(f.root)); f.assertOriginals(changedReceipt)
                } finally {
                    f.root.state.value.pdfUnlockPrompt?.let { f.root.cancelPdfUnlock(it.requestID) }
                    opening.cancel()
                    f.responseReceipt.writeBytes(f.originalReceipt)
                }
                f.assertOriginals()
            } finally { f.finish() }
        }
    }

    private fun navigationIdentity(root: RootController): String {
        val state = root.state.value
        return canonical(JSONObject().put("owner", state.selectedPaperId).put("viewed", state.viewedPaper?.id)
            .put("sha", state.pdfDocument?.sha256).put("path", state.pdfDocument?.localPath)
            .put("page", state.pdfPage).put("mode", state.pdfMode).put("receipt", state.pdfReceipt))
    }
}
