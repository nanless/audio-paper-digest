package com.nanless.paperdigest.ui

import android.view.View
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebView
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import com.nanless.paperdigest.data.Article
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Actual reading/KaTeX clients; simulated OS callback, not a claim of real OOM injection. */
class ReaderRecoveryInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 private val instrument get()=InstrumentationRegistry.getInstrumentation()
 private fun document(marker:String):WebView? {
  var result:WebView?=null
  instrument.runOnMainSync{
   fun find(view:View):WebView? {
    if(view is WebView&&(view.tag as? StreamedHtmlDocument)?.containsBodyText(marker)==true)return view
    if(view is ViewGroup)for(i in 0 until view.childCount)find(view.getChildAt(i))?.let{return it}
    return null
   }
   for(activity in ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)){result=find(activity.window.decorView);if(result!=null)break}
  };return result
 }
 private fun ready(marker:String):WebView {
  var found:WebView?=null
  compose.waitUntil(15_000){val web=document(marker);var ready=false;if(web!=null)instrument.runOnMainSync{ready=web.progress==100&&web.contentHeight>0};if(ready)found=web;ready}
  return requireNotNull(found)
 }
 private fun gone()=object:RenderProcessGoneDetail(){override fun didCrash()=true;override fun rendererPriorityAtExit()=0}
 private fun capture(name:String,view:WebView?=null){
  compose.waitForIdle()
  if(view!=null){
   val painted=java.util.concurrent.CountDownLatch(1)
   instrument.runOnMainSync{view.postVisualStateCallback(1,object:WebView.VisualStateCallback(){override fun onComplete(requestId:Long){view.postDelayed({painted.countDown()},64)}})}
   assertTrue("Actual WebView visual state must be ready",painted.await(5,java.util.concurrent.TimeUnit.SECONDS))
   // Privileged read-only inspection after the original JS-disabled document loaded.
   val inspected=java.util.concurrent.CountDownLatch(1);var result:String?=null
   instrument.runOnMainSync{assertFalse(view.settings.javaScriptEnabled);view.settings.javaScriptEnabled=true;view.evaluateJavascript("JSON.stringify({font:getComputedStyle(document.body).fontSize,heading:document.querySelector('h1')?getComputedStyle(document.querySelector('h1')).fontSize:null,paragraph:document.querySelector('p')?getComputedStyle(document.querySelector('p')).fontSize:null,lineHeight:getComputedStyle(document.body).lineHeight,padding:getComputedStyle(document.body).padding,head:document.head.innerHTML,table:document.querySelector('table')?{width:document.querySelector('table').clientWidth,scroll:document.querySelector('table').scrollWidth,whiteSpace:getComputedStyle(document.querySelector('th')||document.querySelector('td')).whiteSpace}:null})"){result=it;view.settings.javaScriptEnabled=false;inspected.countDown()}}
   assertTrue(inspected.await(5,java.util.concurrent.TimeUnit.SECONDS))
   java.io.File(instrument.targetContext.getExternalFilesDir("qa"),"reader-review/$name.json").also{it.parentFile!!.mkdirs();it.writeText(result?:"null")}
   if(name.startsWith("phone-font")){
    val actual=org.json.JSONObject(org.json.JSONArray("[${requireNotNull(result)}]").getString(0));val table=actual.getJSONObject("table")
    assertEquals("Original column headings must not be collapsed into vertical fragments","nowrap",table.getString("whiteSpace"))
    assertTrue("Wide scientific table must scroll independently",table.getInt("scroll")>table.getInt("width"))
    assertEquals("Phone body padding", "0px 10px",actual.getString("padding"))
    assertEquals("Compact body remains adjustable with the system font scale",if(name.contains("-100-"))"14px" else "28px",actual.getString("font"))
    assertEquals("Paragraph must inherit the compact body size",actual.getString("font"),actual.getString("paragraph"))
    val heading=actual.getString("heading").removeSuffix("px").toFloat()
    assertTrue("Title must not dominate the phone viewport",heading<=(if(name.contains("-100-"))18.01f else 36.01f))
   }
  }
  val bitmap=requireNotNull(instrument.uiAutomation.takeScreenshot()){"系统未返回实际屏幕"}
  val file=java.io.File(instrument.targetContext.getExternalFilesDir("qa"),"reader-review/$name.png");file.parentFile!!.mkdirs()
  try{file.outputStream().use{assertTrue(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it))}}finally{bitmap.recycle()}
  println("PD_READER_ACTUAL_SCREEN "+file.absolutePath)
 }

 @Test fun visibleRendererLossKeepsAppAndRequiresExplicitRetry(){
  val marker="原正文与科学表格";val body="<h1>$marker</h1><table><tr><td>原数值 1.25</td></tr></table><p>原文仍保留</p>"
  compose.setContent{MaterialTheme{Column{Text("原生操作栏仍在");Box(Modifier.weight(1f)){StaticDocument(body)}}}}
  val first=ready(marker);var oldURL="";lateinit var oldClient:android.webkit.WebViewClient
  instrument.runOnMainSync{oldURL=first.url!!;oldClient=first.webViewClient;assertTrue(oldClient.onRenderProcessGone(first,gone()))}
  compose.onNodeWithText("重新显示正文").assertIsDisplayed();compose.onNodeWithText("原生操作栏仍在").assertIsDisplayed()
  capture("renderer-exited-explicit-retry")
  compose.waitForIdle();assertNull(document(marker));instrument.runOnMainSync{assertNull(first.parent)}
  // A recomposition cannot silently restart a failed renderer.
  compose.waitForIdle();assertNull(document(marker))
  compose.onNodeWithText("重新显示正文").performClick();val second=ready(marker);assertNotSame(first,second)
  instrument.runOnMainSync{
   assertSame(body,(second.tag as StreamedHtmlDocument).bodyForInspection)
   assertFalse(second.settings.javaScriptEnabled);assertTrue(second.settings.blockNetworkLoads)
   oldClient.onPageFinished(first,oldURL)
  }
  assertSame(second,document(marker))
  capture("renderer-recovered-original-body",second)
 }

 @Test fun verifiedReadableBodyArrivesBeforeFormulaFailureAndArticleIsUnchanged()=runBlocking {
  val article=Article("test:reader","<h2>原章节</h2><p>原科学文字</p><math><semantics><mi>x</mi><annotation encoding='application/x-tex'>\\DefinitelyUnsupportedCommand{x}</annotation></semantics></math>","原科学文字","https://example.invalid/source","https://example.invalid/guide","a".repeat(64),"2026-11-03")
  val before=article.json().toString();var readable:String?=null
  val failure=runCatching{ResearchRenderer.renderArticleForDisplay(instrument.targetContext,article){readable=it}}.exceptionOrNull()
  assertNotNull(failure);assertTrue(requireNotNull(readable).contains("原科学文字"));assertTrue(readable!!.contains("DefinitelyUnsupportedCommand"));assertEquals(before,article.json().toString())
  compose.setContent{MaterialTheme{ArticleDocument(article,18,0,{})}}
  ready("原科学文字");compose.waitUntil(15_000){compose.onAllNodesWithText("部分公式未完成排版，已保留原式和正文。").fetchSemanticsNodes().isNotEmpty()}
  assertNotNull(document("原科学文字"))
 }

 private class HeldWeb(context:android.content.Context):WebView(context){
  var destroys=0
  override fun loadDataWithBaseURL(baseUrl:String?,data:String,mimeType:String?,encoding:String?,historyUrl:String?){}
  override fun destroy(){destroys++;super.destroy()}
 }
 @Test fun actualGuideExportEmbedsVerifiedStreamAndNeverLeaksReaderURL()=runBlocking {
  val base=instrument.targetContext
  val root=java.nio.file.Files.createTempDirectory(base.cacheDir.toPath(),"reader-export-").toFile().canonicalFile
  val context=object:android.content.ContextWrapper(base){override fun getNoBackupFilesDir()=root}
  val original=java.util.Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC")
  val path="https://reader.invalid/article-images/test-only/0";var opened=0;var closed=0
  val imageAccess=object:com.nanless.paperdigest.data.DocumentImageAccess{
   override val bodyHTML="<h2>原标题</h2><figure><img src='$path' alt='原图'><figcaption>原图注</figcaption></figure><table><tr><td>1.25</td></tr></table>"
   override val cspImageSource="https://reader.invalid/article-images/test-only/"
   override fun open(url:String,isMainFrame:Boolean,method:String):Pair<String,java.io.InputStream>?{
    if(url!=path||isMainFrame||method!="GET")return null
    opened++;return "image/png" to object:java.io.ByteArrayInputStream(original){override fun close(){closed++;super.close()}}
   }
  }
  val paper=com.nanless.paperdigest.data.Paper("test:export","原标题",blogURL="https://example.invalid/guide",sourceURL="https://example.invalid/source")
  val article=Article(paper.id,"<p>原始未替换正文</p>","原文字",paper.sourceURL!!,paper.blogURL,"a".repeat(64),"2026-11-03",displayImages=imageAccess)
  val before=article.json().toString()
  try{
   val store=com.nanless.paperdigest.data.PersonalStore(java.io.File(root,"store"))
   val service=com.nanless.paperdigest.data.ExportService(context,store,com.nanless.paperdigest.model.StudyService(store,{null}))
   val artifact=service.prepare("guide-html",paper,article,null)
   val html=artifact.file.readText();assertFalse(html.contains("reader.invalid"));assertTrue(html.contains("data:image/png;base64,"))
   val doc=org.jsoup.Jsoup.parse(html);val image=doc.selectFirst("img")!!
   assertArrayEquals(original,java.util.Base64.getDecoder().decode(image.attr("src").substringAfter(',')))
   assertEquals("原图注",doc.select("figcaption").text());assertEquals("1.25",doc.select("td").text())
   assertEquals(1,opened);assertEquals(1,closed);assertEquals(before,article.json().toString())
  }finally{root.deleteRecursively()}
 }
 @Test fun phoneReadingScaleKeepsWideTableAndSameDocument(){
  var scale by mutableFloatStateOf(1f)
  val marker="手机阅读字号与宽表"
  val body="<h1>$marker</h1><p>正文使用紧凑手机排版，同时保留系统与用户字号设置。</p><p><a href='https://example.invalid/'>https://example.invalid/"+"long-segment-".repeat(10)+"</a></p><table id='wide'><tr>"+(1..10).joinToString(""){"<th>原始列标题 $it</th>"}+"</tr><tr>"+(1..10).joinToString(""){"<td>原始数值 $it.25</td>"}+"</tr></table><p>完整表格可独立横向滚动，正文与原数值不改写。</p>"
  compose.setContent{val physical=LocalDensity.current;CompositionLocalProvider(LocalDensity provides Density(physical.density,scale)){MaterialTheme{StaticDocument(body)}}}
  val view=ready(marker);lateinit var owner:Any
  instrument.runOnMainSync{assertEquals(100,view.settings.textZoom);owner=view.tag}
  capture("phone-font-input-100-wide-table",view)
  compose.runOnIdle{scale=2f};compose.waitForIdle()
  instrument.runOnMainSync{assertSame(owner,view.tag);assertEquals(200,view.settings.textZoom);assertFalse(view.settings.javaScriptEnabled)}
  capture("phone-font-input-200-wide-table",view)
  println("PD_READER_FONT_SCOPE actual WebView pixels with LocalDensity fontScale inputs 1.0/2.0; no global Android font setting changed; source document unchanged")
 }
 @Test fun readingMenuShrinksAndRestoresWithoutReplacingDocument(){
  var font by mutableIntStateOf(18)
  val marker="阅读中直接调整文字"
  compose.setContent{MaterialTheme{Column{ReaderTextSizeMenu(font){font=it};Box(Modifier.weight(1f)){StaticDocument("<h1>$marker</h1><p>同一原文继续阅读，不重新下载正文。</p>",font)}}}}
  val view=ready(marker);lateinit var owner:Any
  instrument.runOnMainSync{owner=view.tag;assertEquals(100,view.settings.textZoom)}
  compose.onNodeWithText("缩小文字").performClick();compose.waitForIdle()
  instrument.runOnMainSync{assertSame(owner,view.tag);assertEquals(88,view.settings.textZoom)}
  compose.onNodeWithText("缩小文字").performClick();compose.waitForIdle()
  compose.onNodeWithText("缩小文字").assertIsNotEnabled()
  instrument.runOnMainSync{assertSame(owner,view.tag);assertEquals(77,view.settings.textZoom)}
  compose.onNodeWithText("放大文字").performClick();compose.waitForIdle()
  instrument.runOnMainSync{assertSame(owner,view.tag);assertEquals(88,view.settings.textZoom)}
  compose.onNodeWithText("恢复默认文字大小").performClick();compose.waitForIdle()
  instrument.runOnMainSync{assertSame(owner,view.tag);assertEquals(100,view.settings.textZoom);assertFalse(view.settings.javaScriptEnabled)}
 }
 @Test fun isolatedFormulaRendererLossReleasesOnceAndCompletesFailure()=runBlocking {
  val created=CompletableDeferred<HeldWeb>();lateinit var client:android.webkit.WebViewClient;lateinit var parent:android.widget.FrameLayout
  supervisorScope{
   val work=async{ResearchRenderer.renderFormulae(instrument.targetContext,listOf(ResearchRenderer.Formula("t","x",false))){context->HeldWeb(context).also{parent=android.widget.FrameLayout(context);parent.addView(it);created.complete(it)}}}
   val held=withTimeout(10_000){created.await()}
   withContext(Dispatchers.Main){client=held.webViewClient;assertTrue(client.onRenderProcessGone(held,gone()))}
   assertTrue(runCatching{work.await()}.exceptionOrNull() is IllegalStateException)
   withContext(Dispatchers.Main){assertEquals(0,parent.childCount);assertEquals(1,held.destroys);assertTrue(client.onRenderProcessGone(held,gone()));assertEquals(1,held.destroys)}
  }
 }
}
