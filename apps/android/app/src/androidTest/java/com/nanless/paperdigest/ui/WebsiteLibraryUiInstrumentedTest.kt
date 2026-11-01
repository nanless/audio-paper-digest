package com.nanless.paperdigest.ui

import androidx.compose.ui.test.*
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.junit4.createComposeRule
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.pdf.PdfSelection
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.nio.file.Files

/** Synthetic native cached-file provider + real App UI; no website, model or credential requests. */
class WebsiteLibraryUiInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 private class Controller(val mode:String):AppController {
  val hash="a".repeat(64);val a=CatalogRepository.SITE+"qa-synthetic-a/";val b=CatalogRepository.SITE+"qa-synthetic-b/"
  fun node(id:String,name:String)=JSONObject().put("id",id).put("facet",id.substringBefore('.')).put("zh",name).put("en",if(id=="task.mix")"Beta Music"else"Alpha Method").put("aliases",JSONArray(if(id=="task.mix")listOf("BetaAlias")else emptyList<String>())).put("ancestorIds",JSONArray()).put("definition",("明确的合成定义。".repeat(90))+"最后范围说明")
  val snapshot=JSONObject().put("contract","paper-tag-catalog-snapshot-v2").put("registryVersion","paper-tag-catalog-v2").put("registrySha256",hash).put("concepts",JSONArray().put(node("method.alpha","甲方法")).put(node("task.mix","音乐混音")))
  val graph=WebsiteTaxonomy.parse(JSONObject().put("snapshot",snapshot).put("versions",JSONObject().put("contract","paper-tag-catalog-versions-v2").put("currentSha256",hash).put("snapshots",JSONArray().put(snapshot))))
  fun row(url:String,title:String,source:String,date:String,score:Int,id:String,name:String)=JSONObject().put("permalink",url).put("title",title).put("titleZh",title).put("sourceKind",source).put("date",date).put("score",score).put("citation",JSONObject().put("authors",JSONArray(listOf(if(id=="task.mix")"Beta作者"else"Alpha作者")))).put("tagContract","paper-tag-flat-tags-v2").put("tagCatalogSha256",hash).put("tagConcepts",JSONArray().put(JSONObject().put("id",id).put("facet",id.substringBefore('.')).put("label",name)))
  val paper=Paper("synthetic:provider","OnlyGuideAlpha","OnlyGuideAlpha",authors=listOf("Alpha作者"),date="2026-10-30",score=9.0,sourceKind="arxiv",blogURL=a,appearances=listOf(a,b),original=JSONObject().put("websiteTagRecords",JSONArray().put(row(a,"OnlyGuideAlpha","arxiv","2026-10-30",9,"method.alpha","甲方法")).put(row(b,"OnlyGuideBeta","conference","2026-10-29",5,"task.mix","音乐混音"))))
  val directory=Files.createTempDirectory("website-provider-cache-").toRealPath().toFile()
  val search=CachedGuideSearch(directory);val calls=java.util.concurrent.CopyOnWriteArrayList<String>()
  override val state=MutableStateFlow(UiState(papers=listOf(paper),websiteTaxonomy=graph,personal=JSONObject().put("favorites",JSONArray()).put("reading",JSONArray()).put("notes",if(mode=="note")JSONObject().put(paper.id,JSONObject().put("text","OnlyGuideAlpha private idea"))else JSONObject())))
  init {if(mode=="withheld")paper.original!!.getJSONArray("websiteTagRecords").getJSONObject(1).put("tagPublicationStatus","withheld");val article=Article(paper.id,"<p>Synthetic cache only</p>",if(mode in setOf("typed","untyped"))"OnlyGuideAlpha saved body"else"No body match",a,a,"c".repeat(64),"2026-01-01T00:00:00Z");JsonFiles.write(java.io.File(directory,sha256(a.toByteArray())+".json"),article.json())}
  override suspend fun execute(command:String,payload:JSONObject):JSONObject {calls+=command;return when(command){"library.search"->search.search(payload.getString("query"),listOf(paper)).also{if(mode=="untyped")it.remove("cachedTextIDs")};"paper.open"->{state.value=state.value.copy(viewedPaper=paper,selectedPaperId=paper.id);JSONObject().put("status","opened")};else->JSONObject()}}
  override suspend fun updateSecret(kind:SecretKind,value:String?){error("No credentials")};override suspend fun updatePdfSelection(selection:PdfSelection){}
 }
 private fun open(mode:String):Controller {val c=Controller(mode);compose.setContent{PaperDigestApp(c)};compose.onNodeWithText("论文库").performClick();compose.waitUntil(5000){compose.onAllNodesWithText("1 篇匹配").fetchSemanticsNodes().isNotEmpty()};compose.onNodeWithText("研究方向").performClick();compose.onNodeWithContentDescription("筛选网站方向：音乐混音").performClick();compose.onNodeWithText("查看 1 篇论文").performClick();return c}
 private fun query(){compose.onNodeWithText("论文、作者、编号或笔记").performTextInput("OnlyGuideAlpha");compose.waitUntil(7000){compose.onAllNodes(hasText("已检查 1 份",substring=true)).fetchSemanticsNodes().isNotEmpty()||compose.onAllNodes(hasText("缺少明确的正文命中类型",substring=true)).fetchSemanticsNodes().isNotEmpty()};compose.waitForIdle()}
 private fun scroll(text:String)=compose.onNodeWithTag("library-results").performScrollToNode(hasText(text))
 @Test fun actualCacheProviderLegacyIdsCannotTurnMetadataIntoPaperLevelHits(){val c=open("untyped");query();scroll("当前搜索或筛选没有匹配");compose.onNodeWithText("OnlyGuideBeta").assertDoesNotExist();assertFalse(c.calls.any{it.startsWith("model")})}
 @Test fun typedSavedBodyCanMatchPaperButCardAndGuideChooserDoNotMixPublishedGuideFields(){
  open("typed");query();scroll("OnlyGuideBeta");compose.onNodeWithText("OnlyGuideBeta").assertIsDisplayed();compose.onNodeWithText("5.0 分").assertExists();compose.onNodeWithText("9.0 分").assertDoesNotExist();compose.onNodeWithText("2026-10-29").assertExists();compose.onNodeWithText("Beta作者").assertExists();compose.onNodeWithText("甲方法").assertDoesNotExist();compose.onNodeWithText("正文、笔记或批注匹配").assertExists()
  compose.onNodeWithText("OnlyGuideBeta").performClick();compose.onNodeWithText("论文与已发布导读").assertExists();compose.onNodeWithText(CatalogRepository.SITE+"qa-synthetic-b/").assertExists();compose.onNodeWithText("阅读本机默认导读").assertExists()
 }
 @Test fun privateNoteIsExplicitPaperLevelButMinimumScoreStillUsesMatchedGuide(){
  open("note");query();scroll("OnlyGuideBeta");compose.onNodeWithText("正文、笔记或批注匹配").assertExists();scroll("筛选 1 · 最新");compose.onNodeWithText("筛选 1 · 最新").performClick();compose.onNode(hasText("最低评分",substring=true) and hasClickAction()).performClick();compose.onNodeWithText("8").performClick();compose.waitUntil(5000){compose.onAllNodesWithText("查看 0 篇结果").fetchSemanticsNodes().isNotEmpty()};compose.onNodeWithText("查看 0 篇结果").performClick();scroll("当前搜索或筛选没有匹配")
 }
 @Test fun unclassifiedOtherGuideDoesNotBorrowTheDefaultGuidesPath(){
  val c=Controller("withheld");compose.setContent{PaperDigestApp(c)};compose.onNodeWithText("论文库").performClick();compose.onNodeWithText("论文、作者、编号或笔记").performTextInput("OnlyGuideBeta");compose.waitUntil(7000){compose.onAllNodes(hasText("已检查 1 份",substring=true)).fetchSemanticsNodes().isNotEmpty()};compose.onNodeWithTag("library-results").performScrollToNode(hasText("OnlyGuideBeta") and !hasSetTextAction());compose.onNode(hasText("OnlyGuideBeta") and !hasSetTextAction()).assertIsDisplayed();compose.onNodeWithText("甲方法").assertDoesNotExist();compose.onNodeWithText("9.0 分").assertDoesNotExist()
 }
 @Test fun firstDirectoryCandidateIsFullyVisibleAndSelectableWhileImeIsOpen(){
  val c=Controller("none");compose.setContent{PaperDigestApp(c)};compose.onNodeWithText("论文库").performClick();compose.onNodeWithText("研究方向").performClick();compose.onNodeWithText("搜索目录、英文或别名").performClick().performTextInput("BetaAlias")
  val automation=androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().uiAutomation
  val oldFlags=automation.serviceInfo.flags;automation.serviceInfo=automation.serviceInfo.apply{flags=flags or android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS}
  try {
   compose.waitUntil(10000){automation.windows.any{it.type==android.view.accessibility.AccessibilityWindowInfo.TYPE_INPUT_METHOD}}
   compose.waitForIdle();val ime=android.graphics.Rect();automation.windows.first{it.type==android.view.accessibility.AccessibilityWindowInfo.TYPE_INPUT_METHOD}.getBoundsInScreen(ime)
   val candidate=compose.onNodeWithTag("website-node-task.mix").assertIsDisplayed();val bounds=candidate.fetchSemanticsNode().boundsInWindow
   val full=candidate.getUnclippedBoundsInRoot();val fullHeight=(full.bottom-full.top).value*androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().targetContext.resources.displayMetrics.density
   val footer=compose.onNodeWithTag("website-directory-footer").fetchSemanticsNode().boundsInWindow
   assertEquals("The actual candidate row must not be clipped into a sliver",fullHeight,bounds.height,2f)
   assertTrue("The complete first candidate must be above the fixed result action",bounds.bottom<=footer.top)
   assertTrue("First matching direction must be entirely above the IME without any scroll",bounds.top>=0&&bounds.bottom<=ime.top)
   compose.onNodeWithContentDescription("筛选网站方向：音乐混音").performClick().assertIsOn()
  }finally{automation.serviceInfo=automation.serviceInfo.apply{flags=oldFlags}}
 }
 @Test fun datePickerSelectAndClearAreRealUiActions(){
  open("none");compose.onNodeWithText("筛选 1 · 最新").performClick();compose.onNodeWithText("起始 · 不限").performScrollTo().performClick();compose.onNodeWithText("起始发布日期").assertExists();val dialog=compose.onAllNodes(isDialog()).onLast().fetchSemanticsNode().id;compose.onAllNodes(hasClickAction() and SemanticsMatcher.keyIsDefined(SemanticsProperties.Selected) and hasAnyAncestor(SemanticsMatcher("Active date dialog"){it.id==dialog})).onFirst().performClick();compose.onNodeWithText("确定").assertIsEnabled().performClick();compose.onNodeWithText("起始发布日期").assertDoesNotExist();compose.onNodeWithText("起始 · 不限").assertDoesNotExist();compose.onNode(hasText("起始 ·",substring=true) and hasClickAction()).performClick();compose.onNodeWithText("清除日期").performClick();compose.onNodeWithText("起始 · 不限").assertExists()
 }
 @Test fun resourceHubOpensFullDirectoryAndLeafDefinitionCanBeReadToTheEnd(){
  val c=Controller("none");compose.setContent{PaperDigestApp(c)};compose.onNodeWithContentDescription("网站全部成果").performClick();compose.onNodeWithText("研究方向").performClick();compose.onNodeWithTag("website-directory").assertExists();compose.onNodeWithText("搜索目录、英文或别名").performTextInput("BetaAlias");compose.onNodeWithContentDescription("展开网站方向：音乐混音").performClick();compose.onNodeWithText("定义与完整路径").performScrollTo().performClick();compose.onNodeWithText("task.mix").performScrollTo().assertIsDisplayed();compose.onNodeWithText("关闭").assertIsDisplayed()
 }
}
