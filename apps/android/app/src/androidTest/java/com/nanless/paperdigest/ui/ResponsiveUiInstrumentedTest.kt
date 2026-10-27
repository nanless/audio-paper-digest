package com.nanless.paperdigest.ui

import android.graphics.Rect
import android.view.View
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.test.*
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.Lifecycle
import androidx.test.platform.app.InstrumentationRegistry
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.nanless.paperdigest.data.Article
import com.nanless.paperdigest.data.Paper
import com.nanless.paperdigest.pdf.PdfSelection
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Explicit synthetic UI fixture only; actual 8005 corpus/science/source gates remain separate Main tests. */
class ResponsiveUiInstrumentedTest {
 @get:Rule val compose=createAndroidComposeRule<ComponentActivity>()
 private class Controller:AppController {
  val target=Paper("fixture:responsive-target","Synthetic viewport target","短屏目标论文",sourceKind="fixture",task="测试任务",method="测试方法")
  override val state=MutableStateFlow(UiState(papers=listOf(target),personal=JSONObject().put("notes",JSONObject()).put("annotations",JSONObject()).put("readingState",JSONObject()),settings=JSONObject().put("font",18)))
  val calls=mutableListOf<Pair<String,JSONObject>>()
  override suspend fun execute(command:String,payload:JSONObject):JSONObject {
   calls+=command to JSONObject(payload.toString())
   return when(command){
    "library.search"->JSONObject().put("query",payload.getString("query")).put("scope","cached-published-guides").put("paperIDs",JSONArray()).put("scannedArticles",0).put("unavailableArticles",0)
    "paper.open"->{require(payload.getString("paperID")==target.id);state.value=state.value.copy(selectedPaperId=target.id,viewedPaper=target);JSONObject()}
    "personal.reading"->JSONObject().put("saved",true)
    else->error("Unexpected synthetic UI call: $command")
   }
  }
  override suspend fun updateSecret(kind:SecretKind,value:String?)=error("No credentials permitted")
  override suspend fun updatePdfSelection(selection:PdfSelection)=error("No native document fixture")
 }
 private fun content(width:Int=320,height:Int=480,scale:Float=2f,body:@Composable ()->Unit){
  // First launch after a host rotation may be relaunched. Do not attach an unsaved fixture to the old instance.
  val expected=when(InstrumentationRegistry.getArguments().getString("expectedOrientation")){"landscape"->android.content.res.Configuration.ORIENTATION_LANDSCAPE;"portrait"->android.content.res.Configuration.ORIENTATION_PORTRAIT;else->InstrumentationRegistry.getInstrumentation().targetContext.resources.configuration.orientation}
  var lastIdentity=0;var stableSince=0L
  compose.waitUntil(15000){
   var ready=false
   compose.activityRule.scenario.onActivity{activity->
    val decor=activity.window.decorView;val landscape=expected==android.content.res.Configuration.ORIENTATION_LANDSCAPE
    val correctBounds=activity.resources.configuration.orientation==expected&&decor.width>0&&decor.height>0&&((decor.width>decor.height)==landscape)
    val identity=System.identityHashCode(activity);val now=android.os.SystemClock.elapsedRealtime()
    if(!correctBounds||activity.lifecycle.currentState!=Lifecycle.State.RESUMED||identity!=lastIdentity){lastIdentity=identity;stableSince=now}
    ready=correctBounds&&activity.lifecycle.currentState==Lifecycle.State.RESUMED&&now-stableSince>=750
   };ready
  }
  compose.setContent{
  val density=LocalDensity.current
  CompositionLocalProvider(LocalDensity provides Density(density.density,scale)){
   MaterialTheme{Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)){Box(Modifier.width(width.dp).height(height.dp)){body()}}}
  }
 }}
 @Test fun resultCanBeScrolledIntoTheVisibleWindowAndOpenedWhileImeRemainsOpen(){
  val controller=Controller();lateinit var view:View
  content{val rootView=LocalView.current;SideEffect{view=rootView};val observed by controller.state.collectAsState();LibraryPane(observed,controller,{c,p->if(c=="paper.open")controller.calls+=c to p},{})}
  compose.onNodeWithText("搜索论文信息、笔记与本机已缓存导读").performClick().performTextInput("短屏目标")
  compose.waitUntil(10000){ViewCompat.getRootWindowInsets(view)?.isVisible(WindowInsetsCompat.Type.ime())==true}
  compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText(controller.target.titleZh))
  val target=compose.onNodeWithText(controller.target.titleZh).assertIsDisplayed();val bounds=target.fetchSemanticsNode().boundsInRoot
  val visible=Rect();val location=IntArray(2);compose.runOnIdle{view.getWindowVisibleDisplayFrame(visible);view.getLocationOnScreen(location)}
  val hitLeft=maxOf(bounds.left+location[0],visible.left.toFloat());val hitRight=minOf(bounds.right+location[0],visible.right.toFloat())
  val hitTop=maxOf(bounds.top+location[1],visible.top.toFloat());val hitBottom=minOf(bounds.bottom+location[1],visible.bottom.toFloat())
  assertTrue("The actual result must have a real visible hit area above the IME",hitRight-hitLeft>16f&&hitBottom-hitTop>16f)
  assertTrue("Scrolling results must not dismiss IME to conceal the viewport defect",ViewCompat.getRootWindowInsets(view)?.isVisible(WindowInsetsCompat.Type.ime())==true)
  androidx.test.uiautomator.UiDevice.getInstance(androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()).click(((hitLeft+hitRight)/2f).toInt(),((hitTop+hitBottom)/2f).toInt())
  compose.waitUntil(5000){controller.calls.any{it.first=="paper.open"}};compose.runOnIdle{assertEquals(listOf(controller.target.id),controller.calls.filter{it.first=="paper.open"}.map{it.second.getString("paperID")});assertTrue(controller.calls.none{it.first.startsWith("model.")})}
 }
 @Test fun filterAndScopePanelsKeepTheQueryAndDoNotRepeatSearchOrLoseFunctions(){
  val controller=Controller();content(scale=1f){val observed by controller.state.collectAsState();LibraryPane(observed,controller,{_,_->},{})}
  compose.onNodeWithText("搜索论文信息、笔记与本机已缓存导读").performTextInput("短屏目标")
  compose.waitUntil(10000){controller.calls.count{it.first=="library.search"}==1}
  compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("筛选与排序 · 最新"));compose.onNodeWithText("筛选与排序 · 最新").performClick()
  for(label in listOf("收藏","待读","离线","评分","来源","任务","方法","最低评分"))compose.onNodeWithText(label).performScrollTo().assertIsDisplayed()
  compose.onNodeWithText("待读").performScrollTo().performClick()
  compose.onNodeWithText("清除筛选（保留搜索和排序）").performScrollTo().performClick()
  compose.onNodeWithText("查看 1 篇结果").performScrollTo().performClick()
  compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("检索范围与状态"));compose.onNodeWithText("检索范围与状态").performClick()
  compose.onNodeWithText("尚无可检索的已保存导读；当前只匹配论文信息与笔记。").assertExists();compose.onNodeWithText("关闭").performClick()
  compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("短屏目标"));compose.onNodeWithText("短屏目标").assertExists()
  assertEquals(1,controller.calls.count{it.first=="library.search"})
 }
 @Test fun longSourceDetailsDoNotConsumeTheResearchViewportOrClearItsQuestion(){
  val controller=Controller();val id=controller.target.id;val first="合成来源完整提示一："+"原字段保持。".repeat(40);val last="合成来源完整提示二，不应被截断。"
  controller.state.value=controller.state.value.copy(selectedPaperId=id,viewedPaper=controller.target,article=Article(id,"<p>Synthetic only.</p>","Synthetic only.","","","a".repeat(64),"2026-01-01T00:00:00Z",completeOffline=true,isStale=true,notices=listOf(first,last)),personal=JSONObject().put("readingState",JSONObject().put(id,JSONObject().put("mode","analysis"))).put("notes",JSONObject()).put("annotations",JSONObject()))
  content{val observed by controller.state.collectAsState();ReaderPane(observed,controller,{c,p->controller.calls+=c to p})}
  compose.onNodeWithText("向这篇论文提问").performScrollTo().performTextInput("合成问题草稿，不调用模型")
  compose.onNodeWithContentDescription("来源尚待核对，查看完整信息与 3 项提示").performClick()
  compose.onNodeWithText(first).performScrollTo().assertIsDisplayed();compose.onNodeWithText(last).performScrollTo().assertIsDisplayed();compose.onNodeWithText("关闭").performClick()
  compose.onNodeWithText("合成问题草稿，不调用模型").performScrollTo().assertExists()
  assertTrue(controller.calls.none{it.first.startsWith("model.")||it.first.startsWith("zotero.")})
 }
}
