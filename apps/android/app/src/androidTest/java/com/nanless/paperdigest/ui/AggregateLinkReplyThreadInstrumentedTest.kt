package com.nanless.paperdigest.ui

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.graphics.Rect
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.uiautomator.UiDevice
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

/** 普通可复跑的原生回调线程回归；固定本地 HTML/受控回调，不调用服务或研究资料。
 * 只读 DOM 核对唯一链接与完整可见点击坐标，恢复禁用脚本后真实触摸；不授予无障碍内容树资格。
 * 标准 target Application 的默认初始化不在这个组件夹具的隔离声明内。
 */
class AggregateLinkReplyThreadInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 private val ins=InstrumentationRegistry.getInstrumentation()
 private val nonce=UUID.randomUUID().toString()
 private val label="受控页内链接"
 private val live=AtomicBoolean(true)
 private val shown=mutableStateOf(true)
 private val requested=CountDownLatch(1)
 private val reply=AtomicReference<((JSONObject)->Unit)?>(null)
 private var worker:Thread?=null
 private val workerFailure=AtomicReference<Throwable?>(null)
 private val background=AtomicBoolean(false)
 private fun render(){
  val body="<p><a href='https://reader.invalid/aggregate-link/$nonce/0'>$label</a></p>"+(1..45).joinToString(""){"<p>受控本地正文 $it，不代表科学材料。</p>"}+"<h2 id='destination'>受控末尾</h2>"
  compose.setContent{if(shown.value)StaticDocument(body,aggregateLink={n,i,callback->require(n==nonce&&i==0);check(reply.compareAndSet(null,callback));requested.countDown()},aggregateNonce=nonce,aggregateCurrent={n,i->live.get()&&n==nonce&&i==0})else Text("已离开受控页面")}
 }
 private fun physical():WebView {
  var views:List<WebView> = emptyList()
  ins.runOnMainSync{
   val activity=ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).filter{it.packageName==ins.targetContext.packageName&&it.window.decorView.isAttachedToWindow&&it.window.decorView.isShown}.single()
   val found=mutableListOf<WebView>();fun scan(v:View){if(v is WebView&&v.isAttachedToWindow&&v.isShown)found+=v;if(v is ViewGroup)for(i in 0 until v.childCount)scan(v.getChildAt(i))}
   scan(activity.window.decorView);views=found
  }
  return views.single()
 }
 private fun ready():WebView {
  var found:WebView?=null
  compose.waitUntil(15000){runCatching{val w=physical();var good=false;ins.runOnMainSync{val owner=w.tag as? StreamedHtmlDocument;good=w.hasWindowFocus()&&w.isAttachedToWindow&&w.isShown&&w.width>0&&w.height>0&&owner!=null&&owner.mayNavigateWithin(w.url)&&owner.containsBodyText("/aggregate-link/$nonce/0")&&w.progress==100&&w.contentHeight>0&&!w.settings.javaScriptEnabled&&w.settings.blockNetworkLoads};if(good)found=w;good}.getOrDefault(false)}
  compose.waitForIdle();return requireNotNull(found)
 }
 private fun clickRealLink(){
  val w=ready();var owner:StreamedHtmlDocument?=null
  ins.runOnMainSync{owner=w.tag as StreamedHtmlDocument}
  val href="https://reader.invalid/aggregate-link/$nonce/0"
  fun inspect():JSONObject {
   val done=CountDownLatch(1);val raw=AtomicReference<String?>(null);val observationFailure=AtomicReference<Throwable?>(null)
   val script="""(()=>{const a=[...document.querySelectorAll('a[href]')].filter(e=>e.getAttribute('href')===${JSONObject.quote(href)});if(a.length!==1)return {count:a.length};const e=a[0],r=e.getBoundingClientRect(),s=getComputedStyle(e),hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);return {count:1,label:e.textContent.trim()===${JSONObject.quote(label)},visible:s.display!=='none'&&s.visibility==='visible'&&Number(s.opacity)>0&&s.pointerEvents!=='none',left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,vw:innerWidth,vh:innerHeight,hit:hit===e||e.contains(hit)}})()"""
   ins.runOnMainSync{
    check(w.tag===owner&&owner!!.mayNavigateWithin(w.url)&&w.hasWindowFocus()&&live.get()&&!w.settings.javaScriptEnabled&&w.settings.blockNetworkLoads)
    try{w.settings.javaScriptEnabled=true;w.evaluateJavascript(script){value->try{w.settings.javaScriptEnabled=false;check(w.tag===owner&&owner!!.mayNavigateWithin(w.url)&&w.hasWindowFocus()&&live.get()&&!w.settings.javaScriptEnabled&&w.settings.blockNetworkLoads);raw.set(value)}catch(t:Throwable){observationFailure.set(t)}finally{done.countDown()}}}
    catch(t:Throwable){try{w.settings.javaScriptEnabled=false}catch(cleanup:Throwable){t.addSuppressed(cleanup)};observationFailure.set(t);done.countDown()}
   }
   if(!done.await(3,TimeUnit.SECONDS)){ins.runOnMainSync{w.settings.javaScriptEnabled=false};error("Readonly link observation timed out after restoring disabled scripts")}
   observationFailure.get()?.let{throw it};return JSONObject(requireNotNull(raw.get()))
  }
  compose.waitForIdle();ins.waitForIdleSync()
  val q=inspect();check(q.getInt("count")==1&&q.getBoolean("label")&&q.getBoolean("visible")&&q.getBoolean("hit")&&q.getDouble("width")>0&&q.getDouble("height")>0&&q.getDouble("left")>=1&&q.getDouble("top")>=1&&q.getDouble("right")<=q.getDouble("vw")-1&&q.getDouble("bottom")<=q.getDouble("vh")-1)
  check(physical()===w);val bounds=Rect()
  ins.runOnMainSync{check(w.tag===owner&&owner!!.mayNavigateWithin(w.url)&&w.hasWindowFocus()&&w.isEnabled&&live.get()&&!w.settings.javaScriptEnabled&&w.settings.blockNetworkLoads&&w.getGlobalVisibleRect(bounds)&&bounds.width()==w.width&&bounds.height()==w.height)}
  val x=bounds.left+((q.getDouble("left")+q.getDouble("right"))/2*bounds.width()/q.getDouble("vw")).toInt();val y=bounds.top+((q.getDouble("top")+q.getDouble("bottom"))/2*bounds.height()/q.getDouble("vh")).toInt();check(bounds.contains(x,y))
  check(UiDevice.getInstance(ins).click(x,y));assertTrue(requested.await(5,TimeUnit.SECONDS))
 }
 private fun backgroundReply(result:JSONObject,returned:CountDownLatch?=null){
  worker=thread(name="controlled-native-link-reply"){
   try{background.set(Looper.myLooper()!=Looper.getMainLooper());requireNotNull(reply.get()).invoke(result)}
   catch(error:Throwable){workerFailure.set(error)}finally{returned?.countDown()}
  }
 }
 private fun joinWorker(){worker?.join(5000);assertTrue("The actual producer must terminate before another test",worker?.isAlive!=true)}
 private fun cleanup(primary:Throwable?,monitor:Instrumentation.ActivityMonitor?=null){
  live.set(false);var failure=primary
  fun record(error:Throwable){val first=failure;if(first==null)failure=error else if(first!==error)first.addSuppressed(error)}
  try{compose.runOnUiThread{shown.value=false};compose.waitForIdle()}catch(error:Throwable){record(error)}
  try{joinWorker()}catch(error:Throwable){record(error)}
  if(monitor!=null)try{ins.removeMonitor(monitor)}catch(error:Throwable){record(error)}
  if(primary==null)failure?.let{throw it}
 }
 @Test fun backgroundAnchorReplyCommitsOnViewThread() {
  var primary:Throwable?=null
  try{
   render();clickRealLink();val w=physical();var owner:StreamedHtmlDocument?=null;ins.runOnMainSync{owner=w.tag as StreamedHtmlDocument}
   backgroundReply(JSONObject().put("status","link-ready").put("kind","anchor").put("fragment","destination"));joinWorker()
   assertTrue(background.get());assertNull("Platform work must not run on the background reply thread",workerFailure.get())
   compose.waitUntil(15000){var moved=false;ins.runOnMainSync{moved=w.tag===owner&&w.url==owner!!.url+"#destination"&&w.scrollY>0&&!w.settings.javaScriptEnabled&&w.settings.blockNetworkLoads};moved}
  }catch(error:Throwable){primary=error;throw error}finally{cleanup(primary)}
 }
 @Test fun replyQueuedBeforeRetirementRechecksCurrentOnUiCommit() {
  val intents=AtomicInteger()
  val monitor=object:Instrumentation.ActivityMonitor(){override fun onStartActivity(intent:Intent):Instrumentation.ActivityResult? {if(intent.action!=Intent.ACTION_VIEW)return null;intents.incrementAndGet();return Instrumentation.ActivityResult(Activity.RESULT_CANCELED,null)}}
  var primary:Throwable?=null;var registered=false
  try{
   ins.addMonitor(monitor);registered=true
   render();clickRealLink();val returned=CountDownLatch(1)
   // Main cannot consume the queued platform action until the exact current predicate is retired.
   compose.runOnUiThread{
    backgroundReply(JSONObject().put("status","link-ready").put("kind","external").put("url","https://example.invalid/controlled-retired-link"),returned)
    check(returned.await(5,TimeUnit.SECONDS));live.set(false);shown.value=false
   }
   joinWorker();assertTrue(background.get());assertNull(workerFailure.get());compose.waitForIdle();ins.waitForIdleSync()
   assertEquals("A retired result must not open an external activity",0,intents.get())
  }catch(error:Throwable){primary=error;throw error}finally{cleanup(primary,if(registered)monitor else null)}
 }
}
