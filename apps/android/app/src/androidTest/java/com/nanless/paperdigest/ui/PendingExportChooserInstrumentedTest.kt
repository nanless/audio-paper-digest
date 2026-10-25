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

/** Actual keyed ActivityResult registration and SavedState; service authorization is separately tested on Root. */
class PendingExportChooserInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 private class Controller:AppController {
  private fun row(name:String)=JSONObject().put("operationID",UUID.randomUUID().toString()).put("jobID",UUID.randomUUID().toString())
   .put("documentID",UUID.randomUUID().toString()).put("preparation","ready").put("ready",true).put("delivery","none")
   .put("mime","application/json").put("suggestedName",name).put("createdAt","2026-10-25T00:00:00Z").put("sourceIdentity",JSONObject())
  val a=row("Synthetic original A.json");val b=row("Synthetic original B.json")
  override val state=MutableStateFlow(UiState(pendingExports=listOf(a,b),pendingExportsLoading=false))
  val calls=mutableListOf<Pair<String,JSONObject>>()
  private var active:Pair<String,String>?=null
  private fun change(id:String,change:(JSONObject)->Unit):JSONObject {
   val rows=state.value.pendingExports.map{JSONObject(it.toString()).also{r->if(r.getString("operationID")==id)change(r)}}
   state.value=state.value.copy(pendingExports=rows)
   return rows.single{it.getString("operationID")==id}
  }
  override suspend fun execute(command:String,payload:JSONObject):JSONObject {
   calls+=command to JSONObject(payload.toString())
   val id=payload.optString("operationID")
   return when(command){
    "export.delivery.prepare"->{check(active==null);val attempt=UUID.randomUUID().toString();active=id to attempt;change(id){it.put("attemptID",attempt).put("delivery","choosing")}}
    "export.delivery.validate"->{check(active==(id to payload.getString("attemptID")));JSONObject().put("valid",true)}
    "export.delivery.cancel"->{check(active==(id to payload.getString("attemptID")));active=null;change(id){it.put("delivery","cancelled")}.put("message","原件保留")}
    "export.save"->{check(active==(id to payload.getString("attemptID")));active=null;change(id){it.put("delivery","verified")};JSONObject().put("saved",true).put("verified",true).put("message","Synthetic exact original verified")}
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
  return compose.onNode(hasText("继续保存原件") and hasAnyAncestor(hasTestTag(tag)))
 }
 @Test fun oldCallbackCannotSelectTheCurrentOperationOrAttempt() {
  val controller=Controller();val registry=Registry();val owner=owner(registry)
  compose.setContent{CompositionLocalProvider(LocalActivityResultRegistryOwner provides owner){PaperDigestApp(controller)}}
  compose.onNodeWithText("任务",useUnmergedTree=true).performClick()
  saveButton(controller.a.getString("operationID")).performClick()
  compose.waitUntil(5000){registry.launches.size==1}
  val first=controller.calls.single{it.first=="export.delivery.prepare"}.second.getString("operationID")
  compose.onNodeWithText("结束本次位置选择，保留原件").performScrollTo().performClick()
  compose.waitUntil(5000){controller.calls.any{it.first=="export.delivery.cancel"}}
  saveButton(controller.b.getString("operationID")).performClick()
  compose.waitUntil(5000){registry.launches.size==2}
  compose.runOnIdle{registry.deliver(0,"content://synthetic-documents/late-A")}
  compose.waitForIdle();assertTrue(controller.calls.none{it.first=="export.save"})
  compose.runOnIdle{registry.deliver(1,"content://synthetic-documents/current-B")}
  compose.waitUntil(5000){controller.calls.count{it.first=="export.save"}==1}
  val saved=controller.calls.single{it.first=="export.save"}.second
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
  compose.waitUntil(5000){controller.calls.any{it.first=="export.save"}}
  assertEquals(original,controller.calls.single{it.first=="export.save"}.second.getString("attemptID"))
  assertEquals(1,controller.calls.count{it.first=="export.delivery.prepare"})
 }
 @Test fun nullResultCancelsOnlyThatChooserAndRetainsOriginalReadyBytes() {
  val controller=Controller();val registry=Registry();val owner=owner(registry)
  compose.setContent{CompositionLocalProvider(LocalActivityResultRegistryOwner provides owner){PaperDigestApp(controller)}}
  compose.onNodeWithText("任务",useUnmergedTree=true).performClick()
  saveButton(controller.a.getString("operationID")).performClick()
  compose.waitUntil(5000){registry.launches.size==1}
  compose.runOnIdle{registry.deliver(0,null)}
  compose.waitUntil(5000){controller.calls.any{it.first=="export.delivery.cancel"}}
  assertTrue(controller.calls.none{it.first=="export.save"})
  val row=controller.state.value.pendingExports.first();assertEquals("ready",row.getString("preparation"));assertTrue(row.getBoolean("ready"));assertEquals("cancelled",row.getString("delivery"))
  assertEquals(controller.a.getString("documentID"),row.getString("documentID"))
 }
}
