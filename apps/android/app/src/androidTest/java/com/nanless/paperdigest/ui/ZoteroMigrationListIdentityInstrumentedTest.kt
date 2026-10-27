package com.nanless.paperdigest.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import com.nanless.paperdigest.pdf.PdfSelection
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.Collections
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** Normal regression for production ZoteroSettings/Entry/Dialog identity.
 * Run on a dedicated offline emulator, never a user device: this fixture uses
 * only synthetic state and an inert controller, but the standard target
 * Application may initialize its default Root/Vault/workers outside this claim.
 * No fixture Root, grant, provider, account, saved credential or network access.
 */
class ZoteroMigrationListIdentityInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 private val parentID="visual-only-parent72"
 private val childID="visual-only-child72"
 private val previewID="visual-only-preview72"
 private val jobID="visual-only-confirm-job72"
 private val parent=JSONObject().put("id",parentID).put("paperID","仅视觉测试 · 原 Storage 记录").put("attachmentBackend","storage").put("libraryType","users").put("libraryID","12345").put("status","failed").put("createdAt","2026-01-01T00:00:00Z").put("error","仅视觉测试：模拟附件配额不足")
 private class Pending(val result:CompletableDeferred<JSONObject> = CompletableDeferred())
 private inner class Controller:AppController {
  override val state=MutableStateFlow(UiState(settings=JSONObject().put("appearance","light"),cloud=JSONObject().put("account","仅视觉测试 · demo@example.invalid"),zotero=JSONObject().put("libraryType","users").put("libraryID","12345").put("attachmentBackend","storage").put("journals",JSONArray().put(JSONObject(parent.toString()))),pendingExportsLoading=false))
  val calls=Collections.synchronizedList(mutableListOf<String>())
  val pending=AtomicReference<Pending?>()
  val confirmFinally=AtomicBoolean(false)
  override suspend fun execute(command:String,payload:JSONObject):JSONObject {
   calls.add(command)
   return when(command){
    "zotero.migration.preview"->{
     require(payload.getString("journalID")==parentID&&payload.getString("davBaseURL")=="https://dav.jianguoyun.com/dav/")
     JSONObject().put("previewID",previewID).put("targetRoot","https://dav.jianguoyun.com/dav/zotero/").put("roles",JSONArray().put(JSONObject().put("role","source-metadata").put("bytes",128).put("sha256","0".repeat(64))))
    }
    "zotero.migration.confirm"->{
     require(payload.getString("previewID")==previewID)
     val p=Pending();check(pending.compareAndSet(null,p))
     state.value=state.value.copy(jobs=listOf(JSONObject().put("id",jobID).put("kind",command).put("status","running")))
     try{p.result.await()}finally{
      pending.compareAndSet(p,null);confirmFinally.set(true)
      state.value=state.value.copy(jobs=emptyList(),zotero=JSONObject(state.value.zotero.toString()).put("busy",false))
     }
    }
    "jobs.cancel"->{
     require(payload.getString("id")==jobID)
     check(checkNotNull(pending.get()).result.completeExceptionally(CancellationException("仅视觉测试：正常取消原确认")))
     JSONObject()
    }
    "zotero.migration.discard"->{require(payload.getString("previewID")==previewID);JSONObject()}
    else->error("PARENT_LIST_FIXTURE_REJECTS_UNKNOWN_COMMAND")
   }
  }
  override suspend fun updateSecret(kind:SecretKind,value:String?)=error("PARENT_LIST_FIXTURE_REJECTS_SECRET")
  override suspend fun updatePdfSelection(selection:PdfSelection)=error("PARENT_LIST_FIXTURE_REJECTS_PDF")
  fun prependChild(){
   check(pending.get()!=null)
   val child=JSONObject().put("id",childID).put("paperID","仅视觉测试 · 新 WebDAV 继续记录").put("migrationParentID",parentID).put("attachmentBackend","webdav").put("libraryType","users").put("libraryID","12345").put("status","running").put("createdAt","2026-01-02T00:00:00Z")
   val z=JSONObject(state.value.zotero.toString()).put("attachmentBackend","webdav").put("davBaseURL","https://dav.jianguoyun.com/dav/").put("davUsername","仅视觉测试 · demo@example.invalid").put("davCredentialSource","saved-cloud").put("borrowedCredentialState","granted").put("busy",true).put("journals",JSONArray().put(child).put(JSONObject(parent.toString())))
   state.value=state.value.copy(zotero=z)
  }
 }
 private fun dialogText(text:String,substring:Boolean=false)=compose.onNode(hasText(text,substring=substring) and hasAnyAncestor(isDialog()))
 private fun dialogButton(text:String)=compose.onNode(hasText(text) and hasClickAction() and hasAnyAncestor(isDialog()))
 private fun awaitDialogMatch(matcher:SemanticsMatcher,displayed:Boolean=true,enabled:Boolean=false){
  compose.waitUntil(15000){
   compose.onAllNodes(matcher and hasAnyAncestor(isDialog())).fetchSemanticsNodes().size==1 && runCatching{
    val node=compose.onNode(matcher and hasAnyAncestor(isDialog()))
    if(displayed)node.assertIsDisplayed()
    if(enabled)node.assertIsEnabled()
   }.isSuccess
  }
 }
 private fun clickDialog(text:String){
  awaitDialogMatch(hasText(text) and hasClickAction(),enabled=true)
  dialogButton(text).assertIsDisplayed().assertIsEnabled().performClick();compose.waitForIdle()
  if(text in setOf("关闭","暂不继续"))compose.waitUntil(15000){compose.onAllNodes(isDialog()).fetchSemanticsNodes().isEmpty()}
 }
 private fun scrollDialog(text:String){dialogText(text).performScrollTo().assertIsDisplayed()}
 @Test fun parentDialogAndCancelSurviveWebdavChildPrepend(){
  val c=Controller();val observedOrder=AtomicReference<List<String>>(emptyList())
  compose.setContent{
   val state by c.state.collectAsState()
   MaterialTheme(colorScheme=paperColorScheme(false),typography=paperTypography,shapes=paperShapes){
    Surface(Modifier.fillMaxSize()){
     Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).verticalScroll(rememberScrollState()).padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
      Text("仅视觉测试：列表插入，不连接账号或远端")
      val renderedState=state
      ZoteroSettings(renderedState,c,{_,_->error("PARENT_LIST_FIXTURE_REJECTS_BACKGROUND_ACTION")},{error("PARENT_LIST_FIXTURE_REJECTS_API_SECRET")},{error("PARENT_LIST_FIXTURE_REJECTS_DAV_SECRET")})
      SideEffect{observedOrder.set(renderedState.zotero.rows("journals").map{it.getString("id")})}
     }
    }
   }
  }
  try{
   compose.onNode(hasText("改用已连接的坚果云继续存档") and hasClickAction()).performScrollTo().assertIsDisplayed().performClick()
   awaitDialogMatch(hasText("用坚果云继续这次存档"))
   dialogText("用坚果云继续这次存档").assertIsDisplayed()
   clickDialog("核对原材料与目标")
   awaitDialogMatch(hasText("确认并继续存档") and hasClickAction(),enabled=true)
   scrollDialog("查看来源与校验信息");clickDialog("查看来源与校验信息")
   scrollDialog("原存档：$parentID")
   clickDialog("确认并继续存档")
   compose.waitUntil(15000){c.pending.get()!=null}
   awaitDialogMatch(hasText("取消并保留断点") and hasClickAction(),displayed=false,enabled=true)
   scrollDialog("取消并保留断点")
   dialogButton("取消并保留断点").assertIsEnabled()
   compose.runOnIdle{c.prependChild()}
   compose.waitUntil(15000){observedOrder.get()==listOf(childID,parentID)}
   compose.waitForIdle()
   // Assert directly after the actual list recomposition; do not wait for a
   // disappearing dialog to recover and hide the identity regression.
   compose.onAllNodes(isDialog()).assertCountEquals(1)
   dialogText("用坚果云继续这次存档").assertIsDisplayed()
   scrollDialog("原存档：$parentID")
   assertNotNull("Original confirmation coroutine must remain active",c.pending.get())
   assertFalse("List insertion must not cancel original confirmation",c.confirmFinally.get())
   scrollDialog("取消并保留断点");clickDialog("取消并保留断点")
   compose.waitUntil(15000){c.pending.get()==null&&c.confirmFinally.get()}
   awaitDialogMatch(hasText("已取消；已有材料与断点保留"),displayed=false)
   scrollDialog("已取消；已有材料与断点保留")
   awaitDialogMatch(hasText("暂不继续") and hasClickAction(),enabled=true)
   dialogButton("暂不继续").assertIsEnabled()
   clickDialog("暂不继续")
   compose.onAllNodes(isDialog()).assertCountEquals(0)
   assertEquals(1,c.calls.count{it=="zotero.migration.preview"});assertEquals(1,c.calls.count{it=="zotero.migration.confirm"});assertEquals(1,c.calls.count{it=="jobs.cancel"});assertEquals(1,c.calls.count{it=="zotero.migration.discard"})
   assertTrue(c.calls.all{it in setOf("zotero.migration.preview","zotero.migration.confirm","jobs.cancel","zotero.migration.discard")})
  }finally{
   c.pending.get()?.result?.cancel(CancellationException("Parent-list fixture teardown"))
  }
 }
}
