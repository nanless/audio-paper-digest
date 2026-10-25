package com.nanless.paperdigest.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
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
import java.time.YearMonth
import java.time.ZoneOffset
import java.util.concurrent.CopyOnWriteArrayList

/** Synthetic component tests. No actual Root, cloud request, password, restore or WorkManager. */
class CloudCardsInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 private fun cloud(context:String)=obj("selectionContext" to context,"account" to "synthetic-account","folder" to "PaperDigest","automatic" to false,"intervalHours" to 24)
 private inner class Fake:AppController {
  override val state=MutableStateFlow(UiState(cloud=cloud("context-A")))
  val requests=CopyOnWriteArrayList<JSONObject>();val actions=CopyOnWriteArrayList<Pair<String,JSONObject>>()
  var holdFirst:CompletableDeferred<Unit>?=null
  override suspend fun execute(command:String,payload:JSONObject):JSONObject {
   check(command=="cloud.list");val index=requests.size;requests+=JSONObject(payload.toString());val context=state.value.cloud.getString("selectionContext")
   if(index==0)holdFirst?.await()
   val row=obj("selectionID" to "synthetic-selection-$index","createdAt" to "2026-01-01T00:00:00Z","encodedBytes" to 1048576,"sha256" to "a".repeat(64),"manifestSHA256" to "b".repeat(64),"manifestBytes" to 260,"chunkCount" to 1)
   return obj("selectionContext" to context,"month" to payload.getString("month"),"snapshots" to JSONArray().put(row))
  }
  override suspend fun updateSecret(kind:SecretKind,value:String?)=error("No credential operations")
  override suspend fun updatePdfSelection(selection:PdfSelection)=error("No PDF operations")
 }
 private fun show(fake:Fake){compose.setContent{MaterialTheme{val state by fake.state.collectAsState();SettingsPane(state,fake,{command,payload->fake.actions+=command to JSONObject(payload.toString())},{error("No import")},requestedPane="坚果云",requestID=1)}};compose.waitForIdle()}
 private fun read(){compose.onNodeWithText("读取此月版本").performScrollTo().performClick();compose.waitForIdle()}
 @Test fun selectedCardSendsOnlyNativeHandleAndFullHashesRemainAvailable(){
  val fake=Fake();show(fake);assertTrue(fake.requests.isEmpty());read()
  compose.onNodeWithText(String.format(java.util.Locale.getDefault(),"%.1f %s",1.0,"MiB")).assertExists();compose.onNodeWithText("查看校验信息").performScrollTo().performClick()
  compose.onNodeWithText("快照 SHA-256："+"a".repeat(64)).assertExists();compose.onNodeWithText("清单 SHA-256："+"b".repeat(64)).assertExists()
  compose.onNodeWithText("校验并准备恢复…").performScrollTo().performClick()
  val call=fake.actions.single();assertEquals("cloud.restore.prepare",call.first);assertEquals(setOf("selectionID"),call.second.keys().asSequence().toSet());assertEquals("synthetic-selection-0",call.second.getString("selectionID"))
 }
 @Test fun targetABARetiresInFlightReplyWithoutPublishingCard(){
  val fake=Fake().apply{holdFirst=CompletableDeferred()};show(fake);read()
  compose.runOnIdle{fake.state.value=fake.state.value.copy(cloud=cloud("context-B"))};compose.waitForIdle()
  compose.runOnIdle{fake.state.value=fake.state.value.copy(cloud=cloud("context-A"))};compose.waitForIdle()
  compose.runOnIdle{fake.holdFirst!!.complete(Unit)};compose.waitForIdle()
  compose.onNodeWithText("校验并准备恢复…").assertDoesNotExist();assertTrue(fake.actions.isEmpty())
 }
 @Test fun monthABAWhileListWaitsCannotResurrectCard(){
  val fake=Fake().apply{holdFirst=CompletableDeferred()};show(fake);read();val original=YearMonth.now(ZoneOffset.UTC)
  compose.onNodeWithText("UTC 月份 YYYY-MM").performScrollTo().performTextReplacement(original.minusMonths(1).toString())
  compose.onNodeWithText("UTC 月份 YYYY-MM").performTextReplacement(original.toString());compose.runOnIdle{fake.holdFirst!!.complete(Unit)};compose.waitForIdle()
  compose.onNodeWithText("校验并准备恢复…").assertDoesNotExist();assertTrue(fake.actions.isEmpty())
 }
 @Test fun staleReplyDoesNotOverwriteNewerMonthList(){
  val fake=Fake().apply{holdFirst=CompletableDeferred()};show(fake);read()
  compose.onNodeWithText("UTC 月份 YYYY-MM").performScrollTo().performTextReplacement(YearMonth.now(ZoneOffset.UTC).minusMonths(1).toString());read()
  compose.runOnIdle{fake.holdFirst!!.complete(Unit)};compose.waitForIdle();compose.onNodeWithText("校验并准备恢复…").performScrollTo().performClick()
  assertEquals(2,fake.requests.size);assertEquals("synthetic-selection-1",fake.actions.single().second.getString("selectionID"))
 }
 @Test fun unsavedTargetEditAndDiscardStillRequireFreshList(){
  val fake=Fake();show(fake);read();compose.onNodeWithText("坚果云账号").performScrollTo().performTextReplacement("synthetic-other")
  compose.onNodeWithText("撤销未保存更改").performScrollTo().performClick();compose.waitForIdle()
  compose.onNodeWithText("校验并准备恢复…").assertDoesNotExist();assertEquals(1,fake.requests.size);assertTrue(fake.actions.isEmpty())
 }
}
