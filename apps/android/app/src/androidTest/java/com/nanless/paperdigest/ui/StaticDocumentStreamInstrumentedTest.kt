package com.nanless.paperdigest.ui

import android.graphics.Rect
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Actual product StaticDocument, no network/model/account/production store access. */
class StaticDocumentStreamInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 private val instrument get()=InstrumentationRegistry.getInstrumentation()
 private fun web(marker:String):WebView? {
  var result:WebView?=null
  instrument.runOnMainSync{
   fun matching(root:View):WebView? {
    if(root is WebView&&(root.tag as? StreamedHtmlDocument)?.containsBodyText(marker)==true)return root
    if(root is ViewGroup)for(i in 0 until root.childCount)matching(root.getChildAt(i))?.let{return it}
    return null
   }
   for(activity in ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)){
    result=matching(activity.window.decorView)
    if(result!=null)break
   }
  }
  return result
 }
 private fun nativeReady(view:WebView):Boolean {
  var ready=false
  instrument.runOnMainSync{ready=view.progress==100&&view.contentHeight>0&&view.url?.startsWith("https://reader.invalid/document/")==true}
  return ready
 }
 private fun rawEval(view:WebView,script:String,inspectAfterNativeLoad:Boolean):String? {
  val result=AtomicReference<String?>();val done=CountDownLatch(1);var previous=false
  try{
   instrument.runOnMainSync{
    previous=view.settings.javaScriptEnabled
    assertFalse("product static page loaded with JavaScript disabled",previous)
    assertTrue(view.tag is StreamedHtmlDocument)
    assertTrue("fixture evaluation restricted to its local intercepted document",view.url?.startsWith("https://reader.invalid/document/")==true)
    if(inspectAfterNativeLoad){assertEquals(100,view.progress);assertTrue(view.contentHeight>0);view.settings.javaScriptEnabled=true}
    view.evaluateJavascript(script){result.set(it);done.countDown()}
   }
   assertTrue("actual WebView JS inspection callback",done.await(5,TimeUnit.SECONDS))
  }finally{
   var geometry=JSONObject()
   instrument.runOnMainSync{
    view.settings.javaScriptEnabled=previous
    geometry=JSONObject().put("url",view.url).put("progress",view.progress).put("contentHeight",view.contentHeight).put("inspectAfterNativeLoad",inspectAfterNativeLoad).put("javaScriptBefore",previous).put("javaScriptAfter",view.settings.javaScriptEnabled).put("rawResult",result.get()?.take(1800)?:JSONObject.NULL)
   }
   println("PD_STATIC_STREAM_READONLY_PROBE "+geometry.toString())
  }
  return result.get()
 }
 private fun eval(view:WebView,script:String):JSONObject {
  val disabledResult=rawEval(view,script,false)
  if(disabledResult!=null&&disabledResult!="null")return JSONObject(disabledResult)
  // Privileged test inspection ONLY, after the original JS-disabled page has fully loaded.
  // It changes no production source/CSP and restores the exact original false setting in finally.
  // The original assertion that untrustedBodyScriptRan is false remains mandatory below.
  return JSONObject(rawEval(view,script,true)?:error("No callback value during read-only native DOM inspection"))
 }
 private fun ready(marker:String):WebView {
  var found:WebView?=null
  compose.waitUntil(20_000){
   val candidate=web(marker)
   if(candidate!=null&&nativeReady(candidate)){
    val parsed=runCatching{eval(candidate,"({ready:document.readyState,marker:(document.getElementById('identity')?document.getElementById('identity').textContent:null)})")}.getOrNull()
    if(parsed?.optString("ready")=="complete"&&parsed.optString("marker")==marker){found=candidate;true}else false
   }else false
  }
  return found!!
 }
 private fun body(marker:String)= "<h1 id='identity'>$marker</h1><a id='jump' href='#target'>内部原章</a><figure><img id='picture' src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC' alt='原图'><figcaption>原图注</figcaption></figure><math><mi>𝛼</mi></math><table><tr><td>原表</td></tr></table><div style='height:2200px'></div><h2 id='target'>原章节</h2><script>window.untrustedBodyScriptRan=true</script>"
 @Test fun actualStreamLoadsOfflineScienceKeepsHeaderAndUsesInternalFragments(){
  val original=body("原始静态科学文档")
  compose.setContent{MaterialTheme{Column(Modifier.fillMaxSize()){Text("原生论文操作栏",Modifier.height(56.dp));Box(Modifier.weight(1f)){StaticDocument(original)}}}}
  val view=ready("原始静态科学文档");compose.onNodeWithText("原生论文操作栏").assertIsDisplayed()
  compose.waitUntil(5000){eval(view,"({loaded:document.getElementById('picture').complete&&document.getElementById('picture').naturalWidth===1})").optBoolean("loaded")}
  val actual=eval(view,"({images:document.querySelectorAll('img').length,math:document.querySelectorAll('math').length,tables:document.querySelectorAll('table').length,caption:document.querySelector('figcaption').textContent,scriptRan:window.untrustedBodyScriptRan===true})")
  assertEquals(1,actual.getInt("images"));assertEquals(1,actual.getInt("math"));assertEquals(1,actual.getInt("tables"));assertEquals("原图注",actual.getString("caption"));assertFalse(actual.getBoolean("scriptRan"))
  instrument.runOnMainSync{assertFalse(view.settings.javaScriptEnabled);assertFalse(view.settings.allowFileAccess);assertFalse(view.settings.allowContentAccess);assertTrue(view.settings.blockNetworkLoads);assertTrue(view.clipToOutline);val rect=Rect();assertTrue(view.getGlobalVisibleRect(rect));assertTrue("actual viewport has nonzero top below native header",rect.top>0);assertSame(original,(view.tag as StreamedHtmlDocument).bodyForInspection)}
  eval(view,"document.getElementById('jump').click();({clicked:true})")
  compose.waitUntil(5000){eval(view,"({moved:window.scrollY>200,url:location.href})").let{it.optBoolean("moved")&&it.optString("url").endsWith("#target")}}
  assertEquals("原始静态科学文档",eval(view,"({text:document.getElementById('identity').textContent})").getString("text"))
 }
 @Test fun retiredPageCompletionCannotRestoreOrOverwriteTheNewDocument(){
  var html by mutableStateOf(body("原文A"));var initial by mutableIntStateOf(300)
  compose.setContent{MaterialTheme{StaticDocument(html,18,initial)}}
  val view=ready("原文A");var oldUrl="";instrument.runOnMainSync{oldUrl=(view.tag as StreamedHtmlDocument).url}
  compose.runOnIdle{html=body("原文B");initial=0}
  val current=ready("原文B");compose.waitForIdle();assertSame(view,current)
  instrument.runOnMainSync{assertNotEquals(oldUrl,(current.tag as StreamedHtmlDocument).url);current.scrollTo(0,400)}
  var beforeNative=0
  compose.waitUntil(5000){instrument.runOnMainSync{beforeNative=current.scrollY};beforeNative>=390}
  val before=eval(current,"({cssY:window.scrollY,dpr:window.devicePixelRatio,identity:document.getElementById('identity').textContent})")
  println("PD_STATIC_STREAM_POSITION_BEFORE "+before.put("nativeY",beforeNative).toString())
  instrument.runOnMainSync{current.webViewClient.onPageFinished(current,oldUrl)}
  compose.waitForIdle();val actual=eval(current,"({cssY:window.scrollY,dpr:window.devicePixelRatio,identity:document.getElementById('identity').textContent})")
  var afterNative=0;instrument.runOnMainSync{afterNative=current.scrollY;assertFalse(current.settings.javaScriptEnabled)}
  println("PD_STATIC_STREAM_POSITION_AFTER "+actual.put("nativeY",afterNative).toString())
  assertEquals("原文B",actual.getString("identity"));assertTrue("old completion cannot reset new reading position in the same native pixel units",afterNative>=390)
 }

 /** System accessibility must expose new native WebView content after the old view is released.
  * Uses only UiAutomation's real tree; no JavaScript, direct provider getter, custom semantics,
  * accessibility notifications, focus requests, extra frame or system-settings changes in this test.
  * Default target Application initialization is outside the component fixture's isolation claim. */
 @Test fun nativeAccessibilityLinksRemainReadableAfterLeavingAndRecreatingDocument(){
  val visible=mutableStateOf(true);val generation=mutableIntStateOf(0)
  val labels=listOf("原生可读链接一","原生可读链接二","原生可读链接三")
  fun markup(revision:Int)="<h1>原生无障碍本地文档 $revision</h1>"+labels.joinToString(""){"<p><a href='#end'>$it $revision</a></p>"}+"<div style='height:1600px'></div><h2 id='end'>当前文档末尾 $revision</h2>"
  val automation=instrument.uiAutomation
  // UiAutomation is the observer used by this component test; never enable a system service.
  compose.waitUntil(5000){var enabled=false;instrument.runOnMainSync{enabled=instrument.targetContext.getSystemService(android.view.accessibility.AccessibilityManager::class.java)?.isEnabled==true};enabled}
  fun physical(marker:String):WebView?=web(marker)?.takeIf{w->var current=false;instrument.runOnMainSync{val owner=w.tag as? StreamedHtmlDocument;current=w.isAttachedToWindow&&w.isShown&&w.hasWindowFocus()&&w.width>0&&w.height>0&&w.progress==100&&w.contentHeight>0&&owner!=null&&owner.mayNavigateWithin(w.url)&&!w.settings.javaScriptEnabled&&w.settings.blockNetworkLoads};current}
  fun nativeLinks(diagnostic:JSONObject?=null):Map<String,Int>{
   val root=automation.rootInActiveWindow?:return emptyMap()
   val result=linkedMapOf<String,Int>();val childCounts=org.json.JSONArray();var visited=0
   try{
    if(root.packageName?.toString()!=instrument.targetContext.packageName)return emptyMap()
    val window=root.windowId;diagnostic?.put("windowID",window)?.put("ownPackage",true)
    fun visit(node:android.view.accessibility.AccessibilityNodeInfo,inWeb:Boolean){
     check(++visited<=512){"bounded own accessibility tree exceeded"}
     if(node.windowId!=window||node.packageName?.toString()!=instrument.targetContext.packageName)return
     if(node.className?.toString()=="android.webkit.WebView")childCounts.put(node.childCount)
     val webContent=inWeb||node.className?.toString()=="android.webkit.WebView"
     if(webContent&&node.isVisibleToUser&&node.isClickable){
      val text=node.text?.toString().orEmpty();val description=node.contentDescription?.toString().orEmpty()
      for(label in labels.flatMap{listOf("$it 0","$it 1")})if(text==label||description==label)result[label]=(result[label]?:0)+1
     }
     for(i in 0 until node.childCount){val child=node.getChild(i)?:continue;try{visit(child,webContent)}finally{@Suppress("DEPRECATION") child.recycle()}}
    }
    visit(root,false);diagnostic?.put("visited",visited)?.put("webChildCounts",childCounts)?.put("fixedLabelCounts",JSONObject().apply{result.forEach{(label,count)->put(label,count)}})
   }finally{@Suppress("DEPRECATION") root.recycle()}
   return result
  }
  fun awaitNative(revision:Int):WebView {
   var current:WebView?=null
   compose.waitUntil(15000){
    val candidate=physical("原生无障碍本地文档 $revision")
    if(candidate==null)false else{val actual=nativeLinks();val complete=labels.all{actual["$it $revision"]==1}&&labels.none{actual.containsKey("$it ${1-revision}")};if(complete)current=candidate;complete}
   }
   return requireNotNull(current)
  }
  try{
   compose.setContent{MaterialTheme{if(visible.value)key(generation.intValue){StaticDocument(markup(generation.intValue))}else Text("已离开原生无障碍文档")}}
   val first=awaitNative(0)
   compose.runOnIdle{visible.value=false};compose.onNodeWithText("已离开原生无障碍文档").assertIsDisplayed()
   compose.waitUntil(5000){web("原生无障碍本地文档 0")==null}
   compose.runOnIdle{generation.intValue=1;visible.value=true}
   val second=awaitNative(1);assertNotSame("reopen must create a fresh real WebView",first,second)
   instrument.runOnMainSync{assertFalse(second.settings.javaScriptEnabled);assertTrue(second.settings.blockNetworkLoads)}
  }catch(failure:Throwable){
   val diagnostic=JSONObject().put("generation",generation.intValue).put("originalFailureClass",failure.javaClass.simpleName)
   runCatching{diagnostic.put("sameCurrentPhysicalReady",physical("原生无障碍本地文档 ${generation.intValue}")!=null)}.exceptionOrNull()?.let{failure.addSuppressed(it)}
   for(fresh in listOf(false,true))try{val snapshot=JSONObject();if(fresh)check(automation.clearCache());nativeLinks(snapshot);diagnostic.put(if(fresh)"freshAfterPublicClearCache" else "originalCache",snapshot)}catch(observation:Throwable){failure.addSuppressed(observation);diagnostic.put(if(fresh)"freshErrorClass" else "originalCacheErrorClass",observation.javaClass.simpleName)}
   println("PD_NATIVE_AX_REOPEN_DIAGNOSTIC "+diagnostic.toString())
   throw failure
  }finally{compose.runOnIdle{visible.value=false};compose.waitForIdle()}
 }

}
