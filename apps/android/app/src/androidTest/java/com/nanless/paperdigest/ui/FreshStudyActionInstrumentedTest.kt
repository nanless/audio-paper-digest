package com.nanless.paperdigest.ui

import android.content.res.Configuration
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import com.nanless.paperdigest.data.canonical
import com.nanless.paperdigest.data.sha256
import com.nanless.paperdigest.pdf.PdfSelection
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList

/** Synthetic component-only UI, with no actual Root, model, credentials, WorkManager or HTTP. */
class FreshStudyActionInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private class Fake : AppController {
        override val state = MutableStateFlow(UiState(selectedPaperId = "synthetic-owner", readingMaterialID = "synthetic-material", settings = obj("model" to "synthetic-model", "endpoint" to "https://synthetic.invalid/v1")))
        val calls = CopyOnWriteArrayList<Pair<String, JSONObject>>()
        var hold: CompletableDeferred<Unit>? = null
        var refuseCommit = false
        var longQuestion = false
        override suspend fun execute(command: String, payload: JSONObject): JSONObject {
            calls += command to JSONObject(payload.toString())
            return when (command) {
                "model.fresh.prepare", "model.fresh.check.prepare" -> {
                    hold?.await()
                    val check = command == "model.fresh.check.prepare"
                    val frozen = if (check) obj("evidenceKind" to "connection-check", "force" to true) else JSONObject(payload.toString()).also { it.remove("readingMaterialID"); it.put("force", true) }
                    obj("confirmationID" to UUID.randomUUID().toString(), "draftIdentity" to sha256(canonical(frozen).toByteArray()), "kind" to if (check) "connection-check" else "study",
                        "question" to if (check) "检查当前模型连接" else payload.getString("question"), "scope" to "原 PDF 物理页 5–7 的文字，不包含图像。", "model" to "synthetic-model", "notice" to "确认后将新建一次请求，可能产生费用；原记录保留。")
                }
                "model.fresh.commit" -> { check(!refuseCommit) { "synthetic retired context" }; obj("queued" to true) }
                "model.fresh.discard" -> obj("cancelled" to true)
                else -> error("Unexpected command")
            }
        }
        override suspend fun updateSecret(kind: SecretKind, value: String?) = error("No secrets in component tests")
        override suspend fun updatePdfSelection(selection: PdfSelection) = error("No PDF operations in component tests")
    }
    private fun draft() = obj("question" to "合成问题", "evidenceKind" to "range", "fromPage" to 5, "toPage" to 7, "chapter" to 0)
    @Test fun openingActionDoesNothingAndCancelNeverCommits() {
        val fake = Fake(); compose.setContent { MaterialTheme { val state by fake.state.collectAsState(); FreshStudyAction(state, fake, draft()) } }
        compose.waitForIdle(); assertTrue(fake.calls.isEmpty())
        compose.onNodeWithText("另建一次研究…").performClick(); compose.waitForIdle()
        compose.onNodeWithText("取消").performScrollTo().performClick(); compose.waitForIdle()
        assertEquals(1, fake.calls.count { it.first == "model.fresh.prepare" }); assertEquals(0, fake.calls.count { it.first == "model.fresh.commit" })
    }
    @Test fun explicitConfirmPassesOnlyOpaqueNativeIntentAndNeverSetsForceOnOrdinarySend() {
        val fake = Fake(); compose.setContent { MaterialTheme { val state by fake.state.collectAsState(); FreshStudyAction(state, fake, draft()) } }
        compose.onNodeWithText("另建一次研究…").performClick(); compose.waitForIdle()
        compose.onNodeWithText("确认新建并发送").performScrollTo().performClick(); compose.waitForIdle()
        val commit = fake.calls.single { it.first == "model.fresh.commit" }.second
        assertEquals(setOf("confirmationID", "draftIdentity"), commit.keys().asSequence().toSet())
        assertEquals(0, fake.calls.count { it.first in setOf("model.run", "model.check") })
        compose.onNodeWithText("已新建研究，请查看任务中的实际结果与用量。").assertExists()
    }
    @Test fun latePrepareReplyAfterDraftOwnerAbaDoesNotCreateAConfirmableDialog() {
        val fake = Fake(); fake.hold = CompletableDeferred()
        val revision = mutableLongStateOf(0)
        val current = mutableStateOf(fake.state.value)
        compose.setContent { MaterialTheme { FreshStudyAction(current.value, fake, draft(), draftRevision = revision.longValue) } }
        compose.onNodeWithText("另建一次研究…").performClick()
        compose.runOnIdle { current.value = current.value.copy(selectedPaperId = "other", readingMaterialID = "other"); revision.longValue++ }
        compose.runOnIdle { current.value = fake.state.value; revision.longValue++; fake.hold!!.complete(Unit) }
        compose.waitForIdle(); compose.onNodeWithText("确认新建并发送").assertDoesNotExist()
        assertEquals(0, fake.calls.count { it.first == "model.fresh.commit" })
    }
    @Test fun currentConnectionCheckUsesFreshConfirmationWithoutPaperPayloadOrSuccessClaim() {
        val fake = Fake()
        compose.setContent { MaterialTheme { val state by fake.state.collectAsState(); FreshStudyAction(state, fake, connectionCheck = true, label = "检查当前连接（计入用量）") } }
        compose.onNodeWithText("检查当前连接（计入用量）").performClick(); compose.waitForIdle()
        assertEquals(0, fake.calls.single { it.first == "model.fresh.check.prepare" }.second.length())
        compose.onNodeWithText("确认新建并发送").performScrollTo().performClick(); compose.waitForIdle()
        compose.onNodeWithText("本次连接检查已排队，请查看任务中的实际结果与用量。").assertExists()
        assertEquals(0, fake.calls.count { it.first == "model.check" })
    }
    @Test fun dialogLargeTextAndNarrowViewportKeepBothActionsReachableAndRejectStaleCommit() {
        val fake = Fake().apply { longQuestion = true; refuseCommit = true }
        compose.setContent {
            val current = LocalConfiguration.current
            val configuration = remember { Configuration(current).apply { screenHeightDp = 320; screenWidthDp = 240; fontScale = 2f } }
            val density = LocalDensity.current
            CompositionLocalProvider(LocalConfiguration provides configuration, LocalDensity provides Density(density.density, 2f)) {
                MaterialTheme { val state by fake.state.collectAsState(); FreshStudyAction(state, fake, draft().put("question", "本次合成问题与材料说明。".repeat(250))) }
            }
        }
        compose.onNodeWithText("另建一次研究…").performClick(); compose.waitForIdle()
        compose.onNodeWithText("取消").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("确认新建并发送").performScrollTo().assertIsDisplayed().performClick(); compose.waitForIdle()
        compose.onNodeWithText("本次确认已失效或未完成，请重新核对后再操作；原记录保留。").assertExists()
        compose.onNodeWithText("已新建研究，请查看任务中的实际结果与用量。").assertDoesNotExist()
    }
}
