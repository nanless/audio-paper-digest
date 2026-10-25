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
}
