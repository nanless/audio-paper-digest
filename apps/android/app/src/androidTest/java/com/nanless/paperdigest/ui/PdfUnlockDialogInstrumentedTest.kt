package com.nanless.paperdigest.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Actual ephemeral secure field/UI state; controller is explicit synthetic fake, not PDF acceptance. */
class PdfUnlockDialogInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 private class Controller:AppController {
  override val state=MutableStateFlow(UiState(pdfUnlockPrompt=PdfUnlockPrompt("A","Synthetic locked.pdf","import")))
  val received=mutableListOf<Pair<String,CharArray>>()
  val submitted=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>()
  var commandCalls=0;var cancelCalls=0
  override suspend fun unlockPdf(requestID:String,password:CharArray) {
   received+=requestID to password;submitted.complete(Unit)
   state.value=state.value.copy(pdfUnlockPrompt=state.value.pdfUnlockPrompt?.copy(checking=true))
   release.await()
   require(state.value.pdfUnlockPrompt?.requestID==requestID)
   state.value=state.value.copy(pdfUnlockPrompt=null)
  }
  override suspend fun cancelPdfUnlock(requestID:String) {
   cancelCalls++;require(state.value.pdfUnlockPrompt?.requestID==requestID)
   state.value=state.value.copy(pdfUnlockPrompt=state.value.pdfUnlockPrompt?.copy(checking=true,stopping=true))
   release.await();state.value=state.value.copy(pdfUnlockPrompt=null)
  }
  override suspend fun execute(command:String,payload:JSONObject):JSONObject{commandCalls++;error("No secret command")}
  override suspend fun updateSecret(kind:SecretKind,value:String?){error("No credential storage")}
  override suspend fun updatePdfSelection(selection:com.nanless.paperdigest.pdf.PdfSelection){error("No PDF selection")}
 }
 @Composable private fun Host(controller:Controller,registry:SaveableStateRegistry,recreate:Int=0) {
  val state by controller.state.collectAsState()
  CompositionLocalProvider(LocalSaveableStateRegistry provides registry){MaterialTheme{
   state.pdfUnlockPrompt?.let{prompt->key(prompt.requestID,recreate){PdfUnlockDialog(prompt,controller)}}
  }}
 }
 @Test fun typedSubmissionErasesInputAndDoesNotUseAnyJsonOrSaveableChannel() {
  val controller=Controller();val registry=SaveableStateRegistry(null){true}
  compose.setContent{Host(controller,registry)}
  compose.onNode(hasSetTextAction()).performTextInput("synthetic-only-input")
  compose.runOnIdle{assertFalse(registry.performSave().toString().contains("synthetic-only-input"))}
  compose.onNodeWithText("核对并打开原件").performClick()
  compose.waitUntil(5000){controller.received.size==1}
  assertEquals("A",controller.received.single().first);assertEquals(0,controller.commandCalls)
  // Disabled editable fields intentionally have no SetText action. Match their retained value semantics.
  compose.onNode(SemanticsMatcher.keyIsDefined(androidx.compose.ui.semantics.SemanticsProperties.EditableText)).assertIsNotEnabled()
  compose.runOnIdle{controller.release.complete(Unit)}
  compose.waitUntil(5000){controller.state.value.pdfUnlockPrompt==null}
  compose.waitForIdle();assertTrue(controller.received.single().second.all{it=='\u0000'})
 }
 @Test fun recreatingTheDialogKeepsRequestButNeverRestoresThePassword() {
  val controller=Controller();val registry=SaveableStateRegistry(null){true};val recreation=mutableIntStateOf(0)
  compose.setContent{Host(controller,registry,recreation.intValue)}
  compose.onNode(hasSetTextAction()).performTextInput("synthetic-not-saved")
  compose.runOnIdle{recreation.intValue++}
  // Semantics synchronization must run on the instrumentation thread, outside runOnIdle.
  val restoredText=compose.onNode(hasSetTextAction()).fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.EditableText].text
  assertEquals("",restoredText)
  assertEquals("A",controller.state.value.pdfUnlockPrompt?.requestID)
  assertTrue(controller.received.isEmpty());assertEquals(0,controller.commandCalls)
 }
 @Test fun cancelDoesNotDismissBeforeTheOriginalNativeScopeReportsItsActualDrain() {
  val controller=Controller();val registry=SaveableStateRegistry(null){true};compose.setContent{Host(controller,registry)}
  compose.onNode(hasSetTextAction()).performTextInput("synthetic-not-submitted")
  compose.onNodeWithText("取消本次打开").performClick()
  compose.waitUntil(5000){controller.cancelCalls==1}
  compose.onNodeWithText("解锁本次 PDF 原件").assertExists();compose.onNodeWithText("正在等待原文操作关闭，尚未报告停止。").assertExists()
  assertNotNull(controller.state.value.pdfUnlockPrompt);assertTrue(controller.received.isEmpty());assertEquals(0,controller.commandCalls)
  compose.runOnIdle{controller.release.complete(Unit)};compose.waitUntil(5000){controller.state.value.pdfUnlockPrompt==null}
 }
}
