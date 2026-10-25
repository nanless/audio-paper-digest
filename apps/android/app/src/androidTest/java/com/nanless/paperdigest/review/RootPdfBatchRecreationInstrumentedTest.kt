package com.nanless.paperdigest.review

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.provider.ProviderTestRule
import com.nanless.paperdigest.MainActivity
import com.nanless.paperdigest.PaperDigestApplication
import com.nanless.paperdigest.cloud.BackupCodec
import com.nanless.paperdigest.review.RootPdfBatchFixture.Kind
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Real MainActivity/recomposer recreation with an isolated actual Root, never the installed QA profile. */
class RootPdfBatchRecreationInstrumentedTest {
    @get:Rule val provider = ProviderTestRule.Builder(RootPdfBatchFixture.Source::class.java, RootPdfBatchFixture.AUTHORITY).build()
    @get:Rule val compose = createEmptyComposeRule()
    @Test fun realMainRecreationRetainsRemainingOriginalsButNotTheTypedPassword() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as PaperDigestApplication
        val f = RootPdfBatchFixture(provider)
        val controllerField = PaperDigestApplication::class.java.getDeclaredField("controller").also { it.isAccessible = true }
        val originalController = app.controller
        var scenario: ActivityScenario<MainActivity>? = null
        try {
            f.loaded(); val first = f.source(Kind.NORMAL); val locked = f.source(Kind.ENCRYPTED); val last = f.source(Kind.NORMAL)
            val originals = f.sources.associate { it.first to BackupCodec.hash(it.second) }
            // Test-only Application pointer replacement; no production constructor/JSON hook or user-store mutation.
            instrumentation.runOnMainSync { controllerField.set(app, f.root) }
            scenario = ActivityScenario.launch(MainActivity::class.java)
            val owner = f.root.importPdfs(listOf(first.first, locked.first, last.first))
            val request = f.prompt()
            val password = hasText("本次原文密码") and hasSetTextAction()
            compose.onNode(password).performTextInput("synthetic-not-submitted")
            scenario.recreate(); compose.waitForIdle()
            assertSame(f.root, app.controller); assertTrue(owner.isActive)
            assertEquals(request.requestID, f.root.state.value.pdfUnlockPrompt?.requestID)
            val afterRecreate = compose.onNode(password).fetchSemanticsNode().config[SemanticsProperties.EditableText].text
            assertEquals("", afterRecreate); assertEquals(1, f.reads(first.first)); assertEquals(1, f.reads(locked.first)); assertEquals(0, f.reads(last.first))
            compose.onNode(password).performTextInput("synthetic-reader")
            compose.onNodeWithText("核对并打开原件").assertIsEnabled().performClick()
            val result = withTimeout(20000) { owner.await() }
            assertEquals(3, result.getInt("completed")); assertEquals(0, result.getInt("notDispatched")); assertNull(f.root.state.value.pdfUnlockPrompt)
            f.sources.forEach { (uri, file) -> assertEquals(1, f.reads(uri)); assertEquals(originals.getValue(uri), BackupCodec.hash(file)) }
            f.assertPrivateInputsAbsent()
        } finally {
            try { scenario?.close() }
            finally {
                try { instrumentation.runOnMainSync { controllerField.set(app, originalController) } }
                finally { f.close() }
            }
        }
    }
}
