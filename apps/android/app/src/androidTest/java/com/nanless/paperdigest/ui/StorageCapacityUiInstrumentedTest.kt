package com.nanless.paperdigest.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import com.nanless.paperdigest.pdf.PdfSelection
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Tests public UI contracts with synthetic receipts only; never deletes or writes real files. */
class StorageCapacityUiInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 private class Controller:AppController {
  override val state=MutableStateFlow(UiState())
  val calls=mutableListOf<Pair<String,JSONObject>>()
  var failMeasure=false;var failCommit=false;var gate:CompletableDeferred<Unit>?=null
  override suspend fun execute(command:String,payload:JSONObject):JSONObject {
   calls+=command to JSONObject(payload.toString())
   return when(command){
    "storage.capacity"->{if(failMeasure)error("真实容量读取失败，未填零");JSONObject().put("scope","research-and-transfer-materials").put("measuredAt","2026-10-25T00:00:00Z").put("rows",JSONArray().put(JSONObject().put("id","research").put("label","研究资料").put("fileCount",7).put("bytes",1024).put("exists",true))).put("availableBytes",2*1024*1024).put("retainedCloud",JSONObject().put("subsetOf","cloudTransfers").put("fileCount",0).put("bytes",0))}
    "storage.cleanup.prepare"->{gate?.await();JSONObject().put("planID","original-native-plan").put("documents",1).put("files",2).put("bytes",1050).put("retainedDocuments",3).put("unknownEntries",2).put("deferredDocuments",0).put("expiresAt","2026-10-25T00:10:00Z").put("items",JSONArray().put(JSONObject().put("documentID","original-export").put("name","原始研究.html").put("bytes",1024)))}
    "storage.cleanup.commit"->{if(failCommit)error("目的文件变化，未获清理完成回执");JSONObject().put("status","partial").put("removedFiles",1).put("removedBytes",1024).put("byteMeasure","logical-file-length").put("retainedFiles",1).put("retainedStagingFiles",0)}
    else->error("Unexpected operation")
   }
  }
  override suspend fun updateSecret(kind:SecretKind,value:String?){error("No secret access")}
  override suspend fun updatePdfSelection(selection:PdfSelection){error("No PDF access")}
 }
 private fun show(controller:Controller){compose.setContent{val state by controller.state.collectAsState();MaterialTheme{Column(Modifier.verticalScroll(rememberScrollState())){StorageCapacityControls(state,controller)}}}}
 @Test fun capacityIsExplicitAndFailureKeepsLastMeasurementInsteadOfShowingZero(){
  val controller=Controller();show(controller);assertTrue(controller.calls.isEmpty())
  compose.onNodeWithText("重新统计容量").performScrollTo().performClick();compose.waitForIdle();compose.onNodeWithText("实际可用空间：2.00 MiB").assertExists()
  controller.failMeasure=true;compose.onNodeWithText("重新统计容量").performScrollTo().performClick();compose.waitForIdle()
  compose.onNodeWithText("真实容量读取失败，未填零").assertExists();compose.onNodeWithText("实际可用空间：2.00 MiB").assertExists();assertEquals(2,controller.calls.size)
 }
 @Test fun nativePlanMustBeConfirmedAndPartialResultKeepsItsExactMeaning(){
  val controller=Controller();show(controller)
  compose.onNodeWithText("核对可清理的临时副本…").performScrollTo().performClick();compose.waitForIdle()
  compose.onNodeWithText("清理这些已核验的临时副本？").assertIsDisplayed();assertTrue(controller.calls.none{it.first=="storage.cleanup.commit"})
  compose.onNodeWithText("取消，保留副本").performClick();compose.waitForIdle();assertTrue(controller.calls.none{it.first=="storage.cleanup.commit"})
  compose.onNodeWithText("核对可清理的临时副本…").performScrollTo().performClick();compose.waitForIdle();compose.onNodeWithText("仅清理这些临时副本").performClick();compose.waitForIdle()
  val commit=controller.calls.single{it.first=="storage.cleanup.commit"};assertEquals("original-native-plan",commit.second.getString("planID"));assertEquals(1,controller.calls.count{it.first=="storage.capacity"})
  compose.onNode(hasText("部分完成",substring=true)).assertExists();compose.onNodeWithText("清理这些已核验的临时副本？").assertDoesNotExist()
 }
 @Test fun rapidPrepareIsOneRequestAndCommitFailureDoesNotAnnounceSuccess(){
  val controller=Controller();controller.gate=CompletableDeferred();show(controller)
  val node=compose.onNodeWithText("核对可清理的临时副本…").performScrollTo();val action=node.fetchSemanticsNode().config[SemanticsActions.OnClick].action!!
  compose.runOnIdle{action();action()};compose.waitUntil(3000){controller.calls.isNotEmpty()};assertEquals(1,controller.calls.count{it.first=="storage.cleanup.prepare"})
  compose.onNodeWithText("正在完整回读已导出文件…").assertIsNotEnabled();controller.gate!!.complete(Unit);compose.waitForIdle()
  controller.failCommit=true;compose.onNodeWithText("仅清理这些临时副本").performClick();compose.waitForIdle()
  compose.onNodeWithText("目的文件变化，未获清理完成回执").assertExists();compose.onAllNodes(hasText("已清理",substring=true)).assertCountEquals(0);assertEquals(1,controller.calls.count{it.first=="storage.cleanup.commit"})
 }
}
