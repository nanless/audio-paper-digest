package com.nanless.paperdigest.ui

import android.graphics.Bitmap
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.compose.ui.test.*
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.nanless.paperdigest.MainActivity
import com.nanless.paperdigest.PaperDigestApplication
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.jsoup.Jsoup
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File

/** Uses the actual launcher, singleton RootController and sealed public sample. No model or remote archive dispatch. */
class RealAppInstrumentedTest {
 @get:Rule val compose=createAndroidComposeRule<MainActivity>()
 private val controller get()=(compose.activity.application as PaperDigestApplication).controller
 private fun waitText(text:String,substring:Boolean=false){compose.waitUntil(30000){compose.onAllNodesWithText(text,substring=substring).fetchSemanticsNodes().isNotEmpty()};compose.waitForIdle()}
 private fun click(text:String){compose.onNodeWithText(text).performClick();compose.waitForIdle()}
 private fun scrollTo(label:String):SemanticsNodeInteraction {
  repeat(14){
   if(compose.onAllNodesWithText(label).fetchSemanticsNodes().isNotEmpty())return compose.onNodeWithText(label).performScrollTo()
   val vertical=SemanticsMatcher.keyIsDefined(SemanticsProperties.VerticalScrollAxisRange)
   compose.onAllNodes(vertical).onLast().performSemanticsAction(SemanticsActions.ScrollBy){it(0f,500f)}
   compose.waitForIdle()
  }
  throw AssertionError("Control is not reachable through actual vertical scrolling: $label")
 }
 private fun systemTapScrollableText(label:String){
  scrollTo(label).assertIsDisplayed().assertIsEnabled()
  val device=androidx.test.uiautomator.UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
  val control=requireNotNull(device.wait(androidx.test.uiautomator.Until.findObject(androidx.test.uiautomator.By.text(label)),5000)){"The real system accessibility tree must expose the visible control: $label"}
  assertTrue("The actual system control must be enabled",control.isEnabled);assertFalse("The actual system control must have a visible touch region",control.visibleBounds.isEmpty)
  control.click();compose.waitForIdle()
 }
 private fun selectReadingMode(mode:String){
  if(compose.onAllNodesWithContentDescription("选择阅读模式").fetchSemanticsNodes().isNotEmpty()){
   compose.onNodeWithContentDescription("选择阅读模式").assertIsDisplayed().performClick();waitText(mode);click(mode)
   compose.onNodeWithText("$mode ·",substring=true).assertIsDisplayed()
  }else{compose.onNodeWithText(mode).performScrollTo().assertIsDisplayed().performClick();compose.onNodeWithText(mode).assertIsSelected()}
  compose.waitForIdle()
 }
 private fun waitReadingControls(){compose.waitUntil(30000){compose.onAllNodesWithContentDescription("论文操作与导出").fetchSemanticsNodes().isNotEmpty()};compose.onNodeWithContentDescription("论文操作与导出").assertIsDisplayed()}
 private fun pdfTool(label:String){
  if(compose.onAllNodesWithContentDescription("原文工具").fetchSemanticsNodes().isNotEmpty()){
   compose.onNodeWithContentDescription("原文工具").assertIsDisplayed().assertIsEnabled().performClick();waitText(label)
  }
  click(label)
 }
 private fun gotoPDFPage(page:Int){
  compose.onNodeWithContentDescription("跳转页码").assertIsDisplayed().assertIsEnabled().performClick();waitText("跳转到原文物理页")
  compose.onNodeWithText("页码（1–13）").performTextReplacement(page.toString());click("跳转")
  compose.onNodeWithText("跳转到原文物理页").assertDoesNotExist()
 }
 private fun nextPDFPage(){
  if(compose.onAllNodesWithContentDescription("下一页").fetchSemanticsNodes().isNotEmpty())compose.onNodeWithContentDescription("下一页").assertIsEnabled().performClick()else click("下一页")
 }
 private fun capture(label:String){
  compose.waitForIdle();Thread.sleep(600)
  val instrument=InstrumentationRegistry.getInstrumentation()
  val qualifier=InstrumentationRegistry.getArguments().getString("screenLabel")?:"phone"
  val titleBounds=if(label=="guide-top")controller.state.value.let{state->val current=state.viewedPaper?.takeIf{it.id==state.selectedPaperId}?:state.papers.find{it.id==state.selectedPaperId};val title=requireNotNull(current).titleZh;if(compose.onAllNodesWithContentDescription("选择阅读模式").fetchSemanticsNodes().isNotEmpty())compose.onNode(hasText(title,substring=true) and hasContentDescription("选择阅读模式")).fetchSemanticsNode().boundsInRoot else compose.onNodeWithText(title).fetchSemanticsNode().boundsInRoot} else null
  val out=File(compose.activity.getExternalFilesDir("qa"),"api${android.os.Build.VERSION.SDK_INT}-$qualifier-$label.png")
  out.parentFile!!.mkdirs();val bitmap=requireNotNull(instrument.uiAutomation.takeScreenshot())
  try{out.outputStream().use{bitmap.compress(Bitmap.CompressFormat.PNG,100,it)};titleBounds?.let{bounds->
   val left=bounds.left.toInt().coerceIn(0,bitmap.width-1);val top=bounds.top.toInt().coerceIn(0,bitmap.height-1);val right=bounds.right.toInt().coerceIn(left+1,bitmap.width);val bottom=bounds.bottom.toInt().coerceIn(top+1,bitmap.height)
   val reference=bitmap.getPixel(left,top);var contrast=0
   for(y in top until bottom step 3)for(x in left until right step 3){val pixel=bitmap.getPixel(x,y);if(kotlin.math.abs(android.graphics.Color.red(pixel)-android.graphics.Color.red(reference))+kotlin.math.abs(android.graphics.Color.green(pixel)-android.graphics.Color.green(reference))+kotlin.math.abs(android.graphics.Color.blue(pixel)-android.graphics.Color.blue(reference))>72)contrast++}
   File(out.parentFile,"guide-title-pixels-${android.os.Build.VERSION.SDK_INT}-$qualifier.json").writeText(JSONObject().put("contrastSamples",contrast).put("sampleStep",3).put("left",left).put("top",top).put("right",right).put("bottom",bottom).toString(2))
   assertTrue("The actual system screenshot must visibly contain the Compose paper title, not only an accessible invisible control",contrast>20)
  }}finally{bitmap.recycle()}
  println("REAL_APP_SCREENSHOT ${out.absolutePath}")
 }
 private fun seekGuide(web:WebView,query:String){
  assertTrue("a scientific section needs a real visible anchor",query.isNotBlank())
  val matches=java.util.concurrent.atomic.AtomicInteger(-1)
  compose.runOnUiThread{web.setFindListener{_,count,done->if(done)matches.set(count)};web.findAllAsync(query)}
  compose.waitUntil(15000){matches.get()>=0};assertTrue("published scientific anchor must be in the actual WebView: $query",matches.get()>0)
  compose.runOnUiThread{web.findNext(true)};Thread.sleep(200);compose.runOnUiThread{web.clearMatches()};compose.waitForIdle()
 }
 private fun views(root:View):List<View> = listOf(root)+(if(root is ViewGroup)(0 until root.childCount).flatMap{views(root.getChildAt(it))}else emptyList())
 private fun visibleAnchor(element:org.jsoup.nodes.Element,following:Boolean=false):String {
  var cursor:org.jsoup.nodes.Element?=element
  while(cursor!=null&&cursor.tagName()!="body"){
   var sibling=if(following)cursor.nextElementSibling()else cursor.previousElementSibling()
   while(sibling!=null){
    val pieces=mutableListOf<String>()
    fun collect(node:org.jsoup.nodes.Node){if(node is org.jsoup.nodes.Element&&(node.tagName() in setOf("math","script","style","code","pre")||node.hasClass("katex")))return;if(node is org.jsoup.nodes.TextNode){val text=node.text().trim();if(text.length>=3)pieces+=text};node.childNodes().forEach(::collect)}
    collect(sibling);val text=if(following)pieces.firstOrNull()else pieces.lastOrNull();if(text!=null)return if(following)text.take(28)else text.takeLast(28)
    sibling=if(following)sibling.nextElementSibling()else sibling.previousElementSibling()
   }
   cursor=cursor.parent()
  }
  return ""
 }
 private fun readyGuide():WebView {
  var found:WebView?=null
  try{compose.waitUntil(40000){compose.runOnUiThread{found=views(compose.activity.window.decorView).filterIsInstance<WebView>().firstOrNull{it.width>0&&it.height>0&&it.progress==100&&it.contentHeight>0&&(it.tag as? StreamedHtmlDocument)?.let{document->document.containsBodyText("MiCLA")&&it.url==document.getUrl()}==true}};found!=null}}catch(failure:Throwable){
   val directory=compose.activity.getExternalFilesDir("qa")!!
   runCatching{capture("guide-readiness-failure")}
   runCatching{File(directory,"guide-failure-${android.os.Build.VERSION.SDK_INT}.semantics.txt").writeText(compose.onRoot(useUnmergedTree=true).printToString())}
   val data=org.json.JSONArray();runCatching{compose.runOnUiThread{views(compose.activity.window.decorView).filterIsInstance<WebView>().forEach{data.put(JSONObject().put("width",it.width).put("height",it.height).put("progress",it.progress).put("contentHeight",it.contentHeight).put("tagHasMiCLA",(it.tag as? StreamedHtmlDocument)?.let{document->document.containsBodyText("MiCLA")&&it.url==document.getUrl()}==true))}}};File(directory,"guide-failure-${android.os.Build.VERSION.SDK_INT}.views.json").writeText(data.toString())
   val stacks=Thread.getAllStackTraces().filter{(_,frames)->frames.any{it.className.startsWith("com.nanless.paperdigest.ui.ResearchRenderer")}}.entries.joinToString("\n\n"){(thread,frames)->thread.name+" "+thread.state+"\n"+frames.take(35).joinToString("\n")};File(directory,"guide-failure-${android.os.Build.VERSION.SDK_INT}.threads.txt").writeText(stacks)
   val article=controller.state.value.article;val configuration=compose.activity.resources.configuration
   File(directory,"guide-failure-${android.os.Build.VERSION.SDK_INT}.state.json").writeText(JSONObject().put("screenWidthDp",configuration.screenWidthDp).put("screenHeightDp",configuration.screenHeightDp).put("articleNotices",org.json.JSONArray(article?.notices?:emptyList<String>())).put("isStale",article?.isStale?:false).put("paperID",article?.paperID).put("pdfMode",controller.state.value.pdfMode).toString(2))
   throw failure
  }
  return found!!
 }
 @Test fun actualPublishedPaperReaderAndAllSettingsRemainReachable(){
  val device=androidx.test.uiautomator.UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
  val avd=device.executeShellCommand("getprop ro.boot.qemu.avd_name").trim().ifEmpty{device.executeShellCommand("getprop ro.kernel.qemu.avd_name").trim()}
  require(avd in setOf("PaperDigest_QA_API35","PaperDigest_QA_API28")){"Mutating public-sample UI acceptance must use the dedicated QA AVDs"}
  waitText("文献资料库")
  val arguments=InstrumentationRegistry.getArguments()
  val forcePublishedRefresh=arguments.getString("refreshPublicArticle")=="true"
  arguments.getString("qaHttpProxy")?.let{proxy->
   // Supplied only at runtime from the private QA network file, never shipped in an APK or logged.
   runBlocking{controller.execute("settings.save",JSONObject().put("httpProxy",proxy))}
  }
  assertTrue(controller.state.value.papers.size>=15)
  val originalSessions=controller.state.value.sessions.size
  capture("library")
  compose.onNodeWithText("搜索论文信息、笔记与本机已缓存导读").performTextInput("MiCLA");androidx.test.espresso.Espresso.closeSoftKeyboard();compose.waitForIdle()
  val paper=controller.state.value.papers.first{it.title.contains("MiCLA")}
  waitText(paper.titleZh);compose.onNodeWithText(paper.titleZh).performScrollTo().assertIsDisplayed().performClick();compose.waitForIdle()
  try{compose.waitUntil(40000){controller.state.value.selectedPaperId==paper.id&&controller.state.value.article!=null}}catch(failure:Throwable){
   capture("paper-open-missing");val directory=compose.activity.getExternalFilesDir("qa")!!;val state=controller.state.value
   File(directory,"paper-open-missing-${android.os.Build.VERSION.SDK_INT}.state.json").writeText(JSONObject().put("selectedPaperID",state.selectedPaperId).put("expectedPaperID",paper.id).put("articlePresent",state.article!=null).put("loading",state.loading).put("error",state.error).put("papers",state.papers.size).put("busy",state.busy).toString(2))
   File(directory,"paper-open-missing-${android.os.Build.VERSION.SDK_INT}.semantics.txt").writeText(compose.onRoot(useUnmergedTree=true).printToString())
   val stacks=Thread.getAllStackTraces().filter{(_,frames)->frames.any{it.className.startsWith("com.nanless.paperdigest.data.CatalogRepository")||it.className.startsWith("com.nanless.paperdigest.RootController")}}.entries.joinToString("\n\n"){(thread,frames)->thread.name+" "+thread.state+"\n"+frames.take(40).joinToString("\n")}
   File(directory,"paper-open-missing-${android.os.Build.VERSION.SDK_INT}.threads.txt").writeText(stacks);throw failure
  }
  if(forcePublishedRefresh){
   val previousFetch=controller.state.value.article!!.fetchedAt
   waitReadingControls();compose.onNodeWithContentDescription("论文操作与导出").performClick();waitText("刷新已发布导读");click("刷新已发布导读")
   compose.waitUntil(120000){controller.state.value.article?.let{it.paperID==paper.id&&it.fetchedAt!=previousFetch}==true}
   val live=controller.state.value.article!!
   assertTrue("An online run must use downloaded original scientific images, never seed replacements",live.completeOffline)
   assertEquals(setOf("stage2.svg","stage1.svg","jta_mixing_ratios.svg").map{"https://arxiv.org/html/2610.27491v1/$it"}.toSet(),live.resources.map{it.sourceURL}.toSet())
   assertEquals(3,live.resources.size)
   val figures=org.json.JSONArray()
   live.resources.forEach{resource->
    assertNull(resource.missingReason);val original=File(requireNotNull(resource.localPath));val bytes=original.readBytes()
    assertEquals(resource.sha256,com.nanless.paperdigest.data.sha256(bytes))
    figures.put(JSONObject().put("sourceURL",resource.sourceURL).put("sha256",resource.sha256).put("bytes",bytes.size))
   }
   File(compose.activity.getExternalFilesDir("qa"),"online-reader-api${android.os.Build.VERSION.SDK_INT}-${arguments.getString("screenLabel")?:"phone"}.json").writeText(JSONObject().put("qualification","Explicitly configured project proxy and actual UI refresh; not first-launch seed acceptance").put("paperID",paper.id).put("blogURL",live.blogURL).put("sourceVersion",live.sourceVersion).put("fetchedAt",live.fetchedAt).put("revisionSHA256",live.revisionSHA256).put("figures",figures).put("modelSessionsBefore",originalSessions).put("modelSessionsAfter",controller.state.value.sessions.size).toString(2))
  }
  val restoredMode=controller.state.value.personal.optJSONObject("readingState")?.optJSONObject(paper.id)?.optString("mode").orEmpty()
  File(compose.activity.getExternalFilesDir("qa"),"guide-tab-diagnostic-${android.os.Build.VERSION.SDK_INT}.json").writeText(JSONObject().put("restoredModeBeforeExplicitGuide",restoredMode).put("paperID",paper.id).toString())
  waitReadingControls();selectReadingMode("导读")
  val web=readyGuide()
  val geometry=org.json.JSONArray();compose.runOnUiThread{views(compose.activity.window.decorView).forEach{view->val rect=android.graphics.Rect();val visible=view.getGlobalVisibleRect(rect);val xy=IntArray(2);view.getLocationOnScreen(xy);geometry.put(JSONObject().put("class",view.javaClass.name).put("width",view.width).put("height",view.height).put("left",view.left).put("top",view.top).put("screenX",xy[0]).put("screenY",xy[1]).put("globalVisible",visible).put("globalRect",rect.toShortString()).put("clipBounds",view.clipBounds?.toShortString()).put("clipChildren",(view as? android.view.ViewGroup)?.clipChildren).put("clipToPadding",(view as? android.view.ViewGroup)?.clipToPadding))}}
  val guideQa=compose.activity.getExternalFilesDir("qa")!!;File(guideQa,"guide-layout-${android.os.Build.VERSION.SDK_INT}-${arguments.getString("screenLabel")}.json").writeText(geometry.toString(2));File(guideQa,"guide-layout-${android.os.Build.VERSION.SDK_INT}-${arguments.getString("screenLabel")}.semantics.txt").writeText(compose.onRoot(useUnmergedTree=true).printToString())

  compose.runOnUiThread{
   val html=Jsoup.parse((web.tag as StreamedHtmlDocument).getBodyForInspection())
   assertEquals(3,html.select("img").size);assertEquals(4,html.select("math").size);assertEquals(4,html.select("table").size)
   if(forcePublishedRefresh)assertEquals("Actual online figures must have real offline pixels",3,html.select("img").count{it.attr("src").startsWith("data:image/")})
   assertFalse(web.settings.javaScriptEnabled);assertTrue(web.settings.blockNetworkLoads)
  }
  capture("guide-top")
  val document=Jsoup.parse((web.tag as StreamedHtmlDocument).getBodyForInspection())
  val mathAnchors=document.select("math").map{visibleAnchor(it)}
  val imageAnchors=document.select("img").map{image->image.closest("figure")?.selectFirst("figcaption")?.text()?.take(28)?.takeIf{it.isNotBlank()}?:visibleAnchor(image,true)}
  val tableAnchors=document.select("table").map{visibleAnchor(it)}
  assertEquals(4,mathAnchors.size);assertEquals(3,imageAnchors.size);assertEquals(4,tableAnchors.size)
  for((index,anchor) in mathAnchors.withIndex()){seekGuide(web,anchor);capture("guide-formula-${index+1}")}
  for((index,anchor) in imageAnchors.withIndex()){seekGuide(web,anchor);capture("guide-figure-${index+1}")}
  for((index,anchor) in tableAnchors.withIndex()){seekGuide(web,anchor);capture("guide-table-${index+1}")}
  compose.runOnUiThread{web.scrollTo(0,0)}
  selectReadingMode("研究");waitText("向这篇论文提问");compose.onNodeWithText("发送").assertIsNotEnabled();capture("research")
  selectReadingMode("笔记");waitText("阅读笔记");capture("notes")
  selectReadingMode("导读")
  compose.onNodeWithContentDescription("打开 PDF").performClick()
  compose.waitUntil(40000){controller.state.value.pdfDocument?.pageCount==13&&controller.state.value.pdfMode}
  waitText("原文已载入",substring=true);capture("pdf")
  assertEquals(paper.id,controller.state.value.selectedPaperId)
  assertEquals(13,controller.state.value.pdfDocument!!.pageCount)
  val restoredPage=controller.state.value.pdfPage
  File(compose.activity.getExternalFilesDir("qa"),"restored-page-${android.os.Build.VERSION.SDK_INT}-${InstrumentationRegistry.getArguments().getString("screenLabel")?:"phone"}.json").writeText(JSONObject().put("restoredPage",restoredPage).put("paperID",paper.id).put("pdfSHA",controller.state.value.pdfDocument!!.sha256).toString())
  // An upgrade preserves the user's reading position. Navigate through the real control before expecting 1 -> 2.
  gotoPDFPage(1)
  compose.waitUntil(10000){controller.state.value.pdfPage==1}
  compose.waitUntil(10000){var hidden=false;compose.runOnUiThread{hidden=androidx.core.view.ViewCompat.getRootWindowInsets(compose.activity.window.decorView)?.isVisible(androidx.core.view.WindowInsetsCompat.Type.ime())==false};hidden}
  waitText("原文已载入 · 物理页 1 / 13")
  nextPDFPage()
  compose.waitUntil(10000){controller.state.value.pdfPage==2};capture("pdf-page2")
  val marksBefore=controller.state.value.personal.optJSONObject("annotations")?.optJSONArray(paper.id)?.length()?:0
  val legacy=File(compose.activity.noBackupFilesDir,"PaperDigest/PdfAnnotations/${controller.state.value.pdfDocument!!.sha256}.json")
  val legacyBefore=legacy.takeIf{it.exists()}?.readBytes()
  pdfTool("选取本页文字");waitText("选取物理页 2 的原文")
  val text=compose.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.SetSelection) and hasText("MiCLA",substring=true))
  val originalText=text.fetchSemanticsNode().config[SemanticsProperties.EditableText].text
  val start=originalText.indexOf("MiCLA");assertTrue(start>=0)
  text.performTextInputSelection(TextRange(start,start+5))
  compose.onNodeWithText("采用选区").assertIsEnabled().performClick()
  compose.waitUntil(10000){controller.state.value.pdfSelection?.text=="MiCLA"}
  pdfTool("保存标注");waitText("保存原文标注")
  compose.onNodeWithText("我的批注（可留空）").performTextInput("专用 QA 设备的真实公开原文批注")
  click("保存在本机")
  compose.waitUntil(10000){(controller.state.value.personal.optJSONObject("annotations")?.optJSONArray(paper.id)?.length()?:0)>marksBefore}
  val central=controller.state.value.personal.getJSONObject("annotations").getJSONArray(paper.id)
  for(i in marksBefore until central.length()){assertEquals(controller.state.value.pdfDocument!!.sha256,central.getJSONObject(i).getString("pdfSHA"));assertEquals("MiCLA",central.getJSONObject(i).getString("text"));assertTrue(central.getJSONObject(i).getString("rect").startsWith("{{"))}
  if(legacyBefore==null)assertFalse("product annotation must not create a second authority",legacy.exists())else assertArrayEquals(legacyBefore,legacy.readBytes())
  capture("pdf-central-annotation")
  selectReadingMode("导读");readyGuide();capture("reader-guide-with-pdf-open")
  compose.onNodeWithContentDescription("论文操作与导出").performClick();waitText("存档到 Zotero…");capture("export-menu")
  PhysicalUiTestActions.popupItem(device,"存档到 Zotero…",compose.activity.resources.displayMetrics.density);compose.waitForIdle();waitText("存档到 Zotero");compose.onNodeWithText("核验并准备材料").assertIsNotEnabled();capture("zotero-archive-dialog");click("关闭")
  compose.onNodeWithContentDescription("关闭 PDF").performClick();compose.waitUntil(10000){!controller.state.value.pdfMode}
  click("设置");waitText("按你的节奏阅读");capture("settings-reading")
  click("模型");waitText("本机模型连接");capture("settings-model")
  systemTapScrollableText("为已保存连接设置模型密钥…");try{waitText("模型 API 密钥")}catch(failure:Throwable){capture("model-secret-missing");val directory=compose.activity.getExternalFilesDir("qa")!!;File(directory,"model-secret-missing-${android.os.Build.VERSION.SDK_INT}.semantics.txt").writeText(compose.onRoot(useUnmergedTree=true).printToString());File(directory,"model-secret-missing-${android.os.Build.VERSION.SDK_INT}.state.json").writeText(JSONObject().put("busy",controller.state.value.busy).put("sessions",controller.state.value.sessions.size).toString());throw failure};compose.onNodeWithText("安全保存").assertIsNotEnabled();capture("model-secret-dialog");click("取消")
  click("资料");waitText("完整研究资料");capture("settings-storage")
  click("坚果云");waitText("坚果云资料");capture("settings-cloud")
  systemTapScrollableText("设置第三方应用密码…");waitText("坚果云第三方应用密码");capture("cloud-secret-dialog");click("取消")
  click("Zotero");waitText("Zotero 完整存档");capture("settings-zotero")
  systemTapScrollableText("为已保存目标设置专用 API key…");waitText("Zotero 专用 API key");capture("zotero-secret-dialog");click("取消")
  assertEquals("passive UI must not create model sessions",originalSessions,controller.state.value.sessions.size)
  assertFalse(controller.state.value.busy)
  val summary=JSONObject().put("paperID",paper.id).put("pageCount",13).put("modelSessionsBefore",originalSessions).put("modelSessionsAfter",controller.state.value.sessions.size).put("sdk",android.os.Build.VERSION.SDK_INT).put("screenWidthDp",compose.activity.resources.configuration.screenWidthDp).put("screenHeightDp",compose.activity.resources.configuration.screenHeightDp)
  File(compose.activity.getExternalFilesDir("qa"),"real-app-${android.os.Build.VERSION.SDK_INT}-${InstrumentationRegistry.getArguments().getString("screenLabel")?:"phone"}.json").writeText(summary.toString(2))
 }
}
