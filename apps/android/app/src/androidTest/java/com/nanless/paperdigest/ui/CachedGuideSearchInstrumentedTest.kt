package com.nanless.paperdigest.ui

import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import com.nanless.paperdigest.data.Paper
import com.nanless.paperdigest.pdf.PdfSelection
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/** UI protocol tests, not a claim of actual cached-file scanning or remote full-text search. */
class CachedGuideSearchInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 private class Controller(val handler:suspend(String)->JSONObject):AppController{
  override val state=MutableStateFlow(UiState(papers=listOf(Paper("meta","needle metadata","元数据命中"),Paper("cached","Other cached article","缓存正文命中"),Paper("other","Other unrelated","其他论文"))))
  val queries=CopyOnWriteArrayList<String>()
  override suspend fun execute(command:String,payload:JSONObject):JSONObject{check(command=="library.search");val query=payload.getString("query");queries+=query;return handler(query)}
  override suspend fun updateSecret(kind:SecretKind,value:String?){error("No credentials")}
  override suspend fun updatePdfSelection(selection:PdfSelection){error("No PDF")}
 }
 private fun result(query:String,ids:List<String> = emptyList(),scanned:Int=2,unavailable:Int=0)=JSONObject().put("query",query).put("scope","cached-published-guides").put("paperIDs",JSONArray(ids)).put("scannedArticles",scanned).put("unavailableArticles",unavailable)
 private fun mount(controller:Controller){compose.setContent{val state by controller.state.collectAsState();LibraryPane(state,controller,{_,_->error("Search must not dispatch writes")},{error("No imports")})}}
 private fun show(text:String){compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText(text));compose.onNodeWithText(text).assertExists()}
 private fun query(value:String){compose.onNode(hasSetTextAction()).performTextReplacement(value);compose.waitForIdle()}
 @Test fun cachedHitsSupplementMetadataAndExistingFiltersStillApply(){
  val controller=Controller{result(it,listOf("cached"))};controller.state.value=controller.state.value.copy(personal=JSONObject().put("favorites",JSONArray(listOf("meta"))))
  mount(controller);assertEquals(0,controller.queries.size);query("needle")
  compose.waitUntil(5000){compose.onAllNodes(hasText("已检查 2 份",substring=true)).fetchSemanticsNodes().isNotEmpty()}
  show("元数据命中");show("缓存正文命中");compose.onNodeWithText("其他论文").assertDoesNotExist()
  compose.onNodeWithText("收藏",useUnmergedTree=true).performClick();compose.onNodeWithText("元数据命中").assertExists();compose.onNodeWithText("缓存正文命中").assertDoesNotExist()
  query("");compose.onNodeWithText("全部",useUnmergedTree=true).performClick();show("其他论文");assertEquals(listOf("needle"),controller.queries.toList())
 }
 private fun oldQueryDoesNotPublish(oldFailure:Boolean){
  val old=CompletableDeferred<JSONObject>();val current=CompletableDeferred<JSONObject>()
  val controller=Controller{q->withContext(NonCancellable){if(q=="old")old.await() else current.await()}}
  mount(controller);query("old");compose.waitUntil(5000){controller.queries.contains("old")};query("new");compose.waitUntil(5000){controller.queries.contains("new")}
  current.complete(result("new",listOf("cached")));compose.waitUntil(5000){compose.onAllNodes(hasText("已检查 2 份",substring=true)).fetchSemanticsNodes().isNotEmpty()}
  if(oldFailure)old.completeExceptionally(IllegalStateException("旧缓存错误不应出现")) else old.complete(result("old",listOf("other")));compose.waitForIdle();show("缓存正文命中");compose.onNodeWithText("其他论文").assertDoesNotExist();compose.onNode(hasText("旧缓存错误不应出现",substring=true)).assertDoesNotExist()
 }
 @Test fun uncooperativeOldSuccessCannotPublishOverNewQuery(){oldQueryDoesNotPublish(false)}
 @Test fun uncooperativeOldFailureCannotPublishOverNewQuery(){oldQueryDoesNotPublish(true)}
 @Test fun failureCanRetryAndPartialUnreadableCacheRemainsExplicit(){
  var attempts=0;val controller=Controller{if(attempts++==0)error("合成缓存读取失败") else result(it,listOf("cached"),2,1)}
  mount(controller);query("needle");compose.waitUntil(5000){compose.onAllNodesWithText("重试本机导读检索").fetchSemanticsNodes().isNotEmpty()}
  compose.onNodeWithText("元数据命中").assertExists();compose.onNode(hasText("合成缓存读取失败",substring=true)).assertExists();compose.onNodeWithText("重试本机导读检索").performClick()
  compose.waitUntil(5000){compose.onAllNodes(hasText("另有 1 份缓存",substring=true)).fetchSemanticsNodes().isNotEmpty()};show("缓存正文命中");assertEquals(2,controller.queries.size)
 }
 @Test fun noCacheInvalidEchoAndOversizeQueryNeverPretendFullTextWasChecked(){
  val controller=Controller{if(it=="empty")result(it,scanned=0) else result("wrong query",listOf("cached"))};mount(controller)
  query("empty");compose.waitUntil(5000){compose.onAllNodes(hasText("尚无可检索的已保存导读",substring=true)).fetchSemanticsNodes().isNotEmpty()}
  query("needle");compose.waitUntil(5000){compose.onAllNodes(hasText("回执与本次查询不一致",substring=true)).fetchSemanticsNodes().isNotEmpty()};compose.onNodeWithText("元数据命中").assertExists();compose.onNodeWithText("缓存正文命中").assertDoesNotExist()
  query("x".repeat(257));compose.waitUntil(5000){compose.onAllNodes(hasText("最多 256 个字符",substring=true)).fetchSemanticsNodes().isNotEmpty()};assertEquals(listOf("empty","needle"),controller.queries.toList())
 }
}
