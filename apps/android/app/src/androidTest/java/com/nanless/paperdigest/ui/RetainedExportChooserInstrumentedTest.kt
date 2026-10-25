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
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.core.app.ActivityOptionsCompat
import com.nanless.paperdigest.pdf.PdfSelection
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.UUID

/** Actual retained route discriminator, keyed ActivityResult and SavedState; no real provider or snapshot service permission is faked. */
class RetainedExportChooserInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 private class Controller:AppController {
  private fun row(name:String)=JSONObject().put("operationID",UUID.randomUUID().toString()).put("jobID",UUID.randomUUID().toString())
   .put("documentID",UUID.randomUUID().toString()).put("preparation","retained").put("ready",false).put("exportRoute","retained").put("retainedDelivery",JSONObject().put("state","none")).put("delivery","none")
   .put("mime","application/json").put("suggestedName",name).put("createdAt","2026-10-25T00:00:00Z").put("sourceIdentity",JSONObject())
  val a=row("Synthetic original A.json");val b=row("Synthetic original B.json")
  override val state=MutableStateFlow(UiState(pendingExports=listOf(a,b),pendingExportsLoading=false))
  val calls=mutableListOf<Pair<String,JSONObject>>()
  private var active:Pair<String,String>?=null
  private fun change(id:String,change:(JSONObject)->Unit):JSONObject {
   val rows=state.value.pendingExports.map{JSONObject(it.toString()).also{r->if(r.getString("operationID")==id){change(r);r.put("retainedDelivery",JSONObject().put("state",r.optString("delivery")).put("attemptID",r.optString("attemptID")))}}}
   state.value=state.value.copy(pendingExports=rows)
   return rows.single{it.getString("operationID")==id}
  }
  override suspend fun execute(command:String,payload:JSONObject):JSONObject {
   calls+=command to JSONObject(payload.toString())
   val id=payload.optString("operationID")
   return when(command){
    "export.retained.prepare"->{check(active==null);val attempt=UUID.randomUUID().toString();active=id to attempt;change(id){it.put("attemptID",attempt).put("delivery","choosing")}}
    "export.retained.delivery.validate"->{check(active==(id to payload.getString("attemptID")));JSONObject().put("valid",true)}
    "export.retained.delivery.cancel"->{check(active==(id to payload.getString("attemptID")));active=null;change(id){it.put("delivery","cancelled")}.put("message","原件保留")}
    "export.retained.save"->{check(active==(id to payload.getString("attemptID")));active=null;change(id){it.put("delivery","verified")};JSONObject().put("saved",true).put("verified",true).put("message","Synthetic exact original verified")}
    else->error("No unrelated operation is authorized: $command")
   }
  }
  override suspend fun updateSecret(kind:SecretKind,value:String?){error("No credentials")}
  override suspend fun updatePdfSelection(selection:PdfSelection){error("No PDF")}
 }
 private class Registry:ActivityResultRegistry() {
  val launches=mutableListOf<Pair<Int,Intent>>()
  override fun<I,O>onLaunch(requestCode:Int,contract:ActivityResultContract<I,O>,input:I,options:ActivityOptionsCompat?){
   val intent=input as Intent;assertEquals(Intent.ACTION_CREATE_DOCUMENT,intent.action);launches+=requestCode to intent
  }
  fun deliver(index:Int,uri:String?)=dispatchResult(launches[index].first,if(uri==null)Activity.RESULT_CANCELED else Activity.RESULT_OK,uri?.let{Intent().setData(Uri.parse(it))})
 }
 private fun owner(registry:Registry)=object:ActivityResultRegistryOwner{override val activityResultRegistry=registry}
 private fun saveButton(operationID:String):SemanticsNodeInteraction {
  val tag="pending-export-$operationID"
  compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasTestTag(tag))
  return compose.onNode(hasText("核验原完整快照并另存") and hasAnyAncestor(hasTestTag(tag)))
 }
 @Test fun oldCallbackCannotSelectTheCurrentOperationOrAttempt() {
  val controller=Controller();val registry=Registry();val owner=owner(registry)
  compose.setContent{CompositionLocalProvider(LocalActivityResultRegistryOwner provides owner){PaperDigestApp(controller)}}
  compose.onNodeWithText("任务",useUnmergedTree=true).performClick()
  saveButton(controller.a.getString("operationID")).performClick()
  compose.waitUntil(5000){registry.launches.size==1}
  val first=controller.calls.single{it.first=="export.retained.prepare"}.second.getString("operationID")
  compose.onNodeWithText("结束本次位置选择，保留原快照").performScrollTo().performClick()
  compose.waitUntil(5000){controller.calls.any{it.first=="export.retained.delivery.cancel"}}
  saveButton(controller.b.getString("operationID")).performClick()
  compose.waitUntil(5000){registry.launches.size==2}
  compose.runOnIdle{registry.deliver(0,"content://synthetic-documents/late-A")}
  compose.waitForIdle();assertTrue(controller.calls.none{it.first=="export.retained.save"})
  compose.runOnIdle{registry.deliver(1,"content://synthetic-documents/current-B")}
  compose.waitUntil(5000){controller.calls.count{it.first=="export.retained.save"}==1}
  val saved=controller.calls.single{it.first=="export.retained.save"}.second
  assertNotEquals(first,saved.getString("operationID"));assertEquals(controller.b.getString("operationID"),saved.getString("operationID"))
  assertEquals("content://synthetic-documents/current-B",saved.getString("uri"));assertFalse(saved.has("documentID"))
 }
 @Test fun savedStateRestorationKeepsOriginalChooserAndDoesNotLaunchAgain() {
  val controller=Controller();val registry=Registry();val owner=owner(registry);val restoration=StateRestorationTester(compose)
  restoration.setContent{CompositionLocalProvider(LocalActivityResultRegistryOwner provides owner){PaperDigestApp(controller)}}
  compose.onNodeWithText("任务",useUnmergedTree=true).performClick()
  saveButton(controller.a.getString("operationID")).performClick()
  compose.waitUntil(5000){registry.launches.size==1}
  val original=controller.state.value.pendingExports.first().getString("attemptID")
  restoration.emulateSavedInstanceStateRestore();compose.waitForIdle()
  assertEquals(1,registry.launches.size)
  compose.runOnIdle{registry.deliver(0,"content://synthetic-documents/rotation-original")}
  compose.waitUntil(5000){controller.calls.any{it.first=="export.retained.save"}}
  assertEquals(original,controller.calls.single{it.first=="export.retained.save"}.second.getString("attemptID"))
  assertEquals(1,controller.calls.count{it.first=="export.retained.prepare"})
 }
 @Test fun nullResultCancelsOnlyThatChooserWithoutPromotingRetainedToOrdinaryReady() {
  val controller=Controller();val registry=Registry();val owner=owner(registry)
  compose.setContent{CompositionLocalProvider(LocalActivityResultRegistryOwner provides owner){PaperDigestApp(controller)}}
  compose.onNodeWithText("任务",useUnmergedTree=true).performClick()
  saveButton(controller.a.getString("operationID")).performClick()
  compose.waitUntil(5000){registry.launches.size==1}
  compose.runOnIdle{registry.deliver(0,null)}
  compose.waitUntil(5000){controller.calls.any{it.first=="export.retained.delivery.cancel"}}
  assertTrue(controller.calls.none{it.first=="export.retained.save"})
  val row=controller.state.value.pendingExports.first();assertEquals("retained",row.getString("preparation"));assertFalse(row.getBoolean("ready"));assertEquals("cancelled",row.getString("delivery"))
  assertEquals(controller.a.getString("documentID"),row.getString("documentID"))
 }
 @Test fun missingProofHistoryDoesNotRenderSuccessfulReadbackOrOrdinaryReadyAction() {
  val id=UUID.randomUUID().toString()
  val row=JSONObject().put("operationID",id).put("jobID",UUID.randomUUID().toString()).put("preparation","retained").put("ready",false)
   .put("createdAt","2026-10-25T00:00:00Z").put("sourceIdentity",JSONObject())
   .put("retainedDelivery",JSONObject().put("state","unconfirmed").put("readbackProven",false).put("message","原回读证明当前无法核验"))
   .put("retainedHistory",org.json.JSONArray().put(JSONObject().put("attemptID",UUID.randomUUID().toString()).put("state","unconfirmed").put("readbackProven",false)))
  val state=UiState(pendingExports=listOf(row),pendingExportsLoading=false)
  compose.setContent{androidx.compose.material3.MaterialTheme{TasksPane(state){_,_->error("No action should be dispatched")}}}
  compose.onNodeWithText("原回读证明当前无法核验").performScrollTo().assertIsDisplayed()
  compose.onNodeWithText("继续保存原件").assertDoesNotExist()
  assertFalse(retainedAttemptStatus(row.getJSONArray("retainedHistory").getJSONObject(0)).contains("已确认"))
 }
 @Test fun confirmationUsesOnlyCurrentRootIssuedNonceAndDoesNotSubmitRevisionOrSourcePath() {
  val nonce=UUID.randomUUID().toString();val calls=mutableListOf<Pair<String,JSONObject>>()
  val controller=object:AppController {
   override val state=MutableStateFlow(UiState(pendingExportsLoading=false,retainedExportConfirmation=JSONObject().put("confirmationID",nonce).put("message","合成原生保留确认")))
   override suspend fun execute(command:String,payload:JSONObject):JSONObject {
    calls+=command to JSONObject(payload.toString());check(command=="export.retained.confirm")
    state.value=state.value.copy(retainedExportConfirmation=null)
    return JSONObject().put("preparation","retained")
   }
   override suspend fun updateSecret(kind:SecretKind,value:String?){error("No credentials")}
   override suspend fun updatePdfSelection(selection:PdfSelection){error("No PDF")}
  }
  compose.setContent{PaperDigestApp(controller)}
  compose.onNodeWithText("确认保留材料并结束准备").assertIsEnabled().performClick()
  compose.waitUntil(5000){calls.size==1}
  assertEquals("export.retained.confirm",calls.single().first)
  val payload=calls.single().second;assertEquals(setOf("confirmationID"),payload.keys().asSequence().toSet());assertEquals(nonce,payload.getString("confirmationID"))
 }

}
