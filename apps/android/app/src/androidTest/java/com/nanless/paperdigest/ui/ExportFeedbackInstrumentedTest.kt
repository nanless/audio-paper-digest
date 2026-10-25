package com.nanless.paperdigest.ui

import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.LocalActivityResultRegistryOwner
import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.ActivityResultRegistryOwner
import androidx.activity.result.contract.ActivityResultContract
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.core.app.ActivityOptionsCompat
import com.nanless.paperdigest.data.Paper
import com.nanless.paperdigest.pdf.PdfSelection
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Exercises the actual rememberLauncher result callback with an official in-memory ActivityResultRegistry. */
class ExportFeedbackInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 private class Controller(private val receipt:JSONObject):AppController {
  override val state=MutableStateFlow(UiState(papers=listOf(Paper("export-fixture","Synthetic export feedback","合成导出反馈论文")),selectedPaperId="export-fixture",pendingExportsLoading=false))
  val prepared=JSONObject().put("operationID","00000000-0000-4000-8000-000000000001").put("documentID","original-prepared-document").put("jobID","00000000-0000-4000-8000-000000000002")
   .put("preparation","ready").put("ready",true).put("delivery","none").put("mime","application/json").put("suggestedName","synthetic-citation.json")
   .put("createdAt","2026-10-25T00:00:00Z").put("sourceIdentity",JSONObject().put("paperID","export-fixture"))
  val calls=mutableListOf<Pair<String,JSONObject>>()
  override suspend fun execute(command:String,payload:JSONObject):JSONObject {
   calls+=command to JSONObject(payload.toString())
   return when(command){
    "paper.open","personal.reading"->JSONObject().put("saved",true)
    "export.prepare"->{state.value=state.value.copy(pendingExports=listOf(JSONObject(prepared.toString())));JSONObject(prepared.toString())}
    "export.delivery.prepare"->{assertEquals(prepared.getString("operationID"),payload.getString("operationID"));JSONObject(prepared.toString()).put("attemptID","00000000-0000-4000-8000-000000000003").put("delivery","choosing")}
    "export.delivery.validate"->{assertEquals(prepared.getString("operationID"),payload.getString("operationID"));assertEquals("00000000-0000-4000-8000-000000000003",payload.getString("attemptID"));JSONObject().put("valid",true)}
    "export.save"->JSONObject(receipt.toString())
    else->error("Unexpected operation")
   }
  }
  override suspend fun updateSecret(kind:SecretKind,value:String?){error("No credentials")}
  override suspend fun updatePdfSelection(selection:PdfSelection){error("No PDF")}
 }
 private fun exercise(receipt:JSONObject,expected:String){
  val controller=Controller(receipt);var launches=0
  val registry=object:ActivityResultRegistry(){
   override fun<I,O> onLaunch(requestCode:Int,contract:ActivityResultContract<I,O>,input:I,options:ActivityOptionsCompat?){
    val intent=input as? Intent?:error("Expected actual document-save intent")
    assertEquals(Intent.ACTION_CREATE_DOCUMENT,intent.action);assertEquals("application/json",intent.type);assertEquals("synthetic-citation.json",intent.getStringExtra(Intent.EXTRA_TITLE));launches++
    dispatchResult(requestCode,Activity.RESULT_OK,Intent().setData(Uri.parse("content://synthetic-documents/selected-output")))
   }
  }
  val owner=object:ActivityResultRegistryOwner{override val activityResultRegistry=registry}
  compose.setContent{CompositionLocalProvider(LocalActivityResultRegistryOwner provides owner){PaperDigestApp(controller)}}
  compose.onNodeWithText("合成导出反馈论文").performClick();compose.waitForIdle()
  compose.onNodeWithContentDescription("导出").performClick();compose.onNodeWithText("引用 JSON").performClick();compose.waitForIdle()
  compose.waitUntil(5000){controller.calls.any{it.first=="export.prepare"}}
  compose.onNodeWithText("任务",useUnmergedTree=true).performClick()
  compose.onNodeWithText("继续保存原件").performScrollTo().performClick()
  compose.waitUntil(5000){controller.calls.any{it.first=="export.save"}}
  compose.onNode(hasText(expected,substring=true)).assertExists()
  val saved=controller.calls.single{it.first=="export.save"}.second
  assertFalse("UI cannot select a file by documentID",saved.has("documentID"));assertEquals(controller.prepared.getString("operationID"),saved.getString("operationID"));assertEquals("00000000-0000-4000-8000-000000000003",saved.getString("attemptID"));assertEquals("content://synthetic-documents/selected-output",saved.getString("uri"));assertEquals(1,launches)
  assertTrue(controller.calls.none{it.first.startsWith("model.")||it.first=="storage.cleanup.commit"})
 }
 @Test fun writeWithoutFullReadbackShowsNativeWarningAndDoesNotClaimCompleteOriginal(){
  val warning="合成提供者已接收写出，但回读未确认；临时副本保留，不授予清理资格。"
  exercise(JSONObject().put("saved",true).put("verified",false).put("message",warning),warning)
  compose.onAllNodesWithText("已保存完整原件").assertCountEquals(0)
 }
 @Test fun verifiedSaveShowsTheActualNativeReceiptMessage(){
  val message="合成原回执：所选文件已完整回读核对字节与 SHA。"
  exercise(JSONObject().put("saved",true).put("verified",true).put("message",message),message)
 }
}
