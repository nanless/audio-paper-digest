package com.nanless.paperdigest.ui

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import com.nanless.paperdigest.pdf.PdfSelection
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** UI-only fake credentials; no real SecretVault or HTTP. */
class CredentialSetupInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 private class Controller:AppController {
  override val state=MutableStateFlow(UiState())
  var saves=0;var checks=0;var fails=true;var waiting=false;var cancelled=false
  override suspend fun execute(command:String,payload:JSONObject):JSONObject {
   require(command in setOf("cloud.check","zotero.check"));checks++
   if(waiting)try{awaitCancellation()}finally{cancelled=true}
   if(fails)throw IllegalStateException("合成网络检查未完成")
   return JSONObject()
  }
  override suspend fun updateSecret(kind:SecretKind,value:String?){saves++}
  override suspend fun updatePdfSelection(selection:PdfSelection){}
 }
 private fun verify(kind:SecretKind){
  val controller=Controller();val visible=mutableStateOf(true)
  compose.setContent{androidx.compose.material3.MaterialTheme{if(visible.value)SecretDialog(kind,controller,{visible.value=false})}}
  compose.onNodeWithText("新的密钥").performTextInput("synthetic-ui-test-only")
  compose.onNodeWithText("保存并检查连接").performClick()
  compose.onNodeWithText("凭据已安全保存，连接检查未通过：合成网络检查未完成").assertIsDisplayed()
  compose.onNodeWithText("新的密钥").assertDoesNotExist()
  assertEquals(1,controller.saves);assertEquals(1,controller.checks)
  controller.fails=false
  compose.onNodeWithText("仅重试连接检查").performClick();compose.waitForIdle()
  assertFalse(visible.value);assertEquals(1,controller.saves);assertEquals(2,controller.checks)
 }
 @Test fun cloudPasswordSavedThenRetryDoesNotSaveAgain()=verify(SecretKind.CLOUD)
 @Test fun zoteroKeySavedThenRetryDoesNotSaveAgain()=verify(SecretKind.ZOTERO)
 @Test fun attachmentPasswordSavedThenRetryDoesNotSaveAgain()=verify(SecretKind.ZOTERO_DAV)
 @Test fun leavingDialogCancelsCheckWithoutResavingCredential(){
  val controller=Controller().apply{waiting=true};val visible=mutableStateOf(true)
  compose.setContent{androidx.compose.material3.MaterialTheme{if(visible.value)SecretDialog(SecretKind.CLOUD,controller,{visible.value=false})}}
  compose.onNodeWithText("新的密钥").performTextInput("synthetic-ui-test-only")
  compose.onNodeWithText("保存并检查连接").performClick()
  compose.waitUntil{controller.checks==1}
  compose.runOnIdle{visible.value=false}
  compose.waitUntil{controller.cancelled}
  assertEquals(1,controller.saves);assertEquals(1,controller.checks)
 }
}
