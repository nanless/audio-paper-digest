package com.nanless.paperdigest.ui

import android.graphics.Bitmap
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.Configurator
import com.nanless.paperdigest.MainActivity
import com.nanless.paperdigest.PaperDigestApplication
import com.nanless.paperdigest.data.CatalogRepository
import com.nanless.paperdigest.data.PublishedAggregateStore
import com.nanless.paperdigest.data.AggregateDocumentView
import com.nanless.paperdigest.data.AggregateLinkTable
import com.nanless.paperdigest.data.AggregateLinkRouting
import com.nanless.paperdigest.data.AggregateBrowser
import com.nanless.paperdigest.data.AggregateBrowsePort
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.util.concurrent.atomic.AtomicLong

/** Optional actual, already-synced public QA measurement. No source mocks, model or credential operations.
 * Enable explicitly with -e publishedWorkbenchTiming true; ordinary device suites skip this dataset-dependent test. */
private typealias NativeClaim = suspend (()->Boolean)->Boolean
private typealias NativeCommit = suspend (()->Boolean,()->Boolean)->Boolean

class PublishedWorkbenchTimingInstrumentedTest {
 @get:Rule val compose=createAndroidComposeRule<MainActivity>()
 private val root get()=(compose.activity.application as PaperDigestApplication).controller
 private fun views(view:View):List<View> = listOf(view)+(if(view is ViewGroup)(0 until view.childCount).flatMap{views(view.getChildAt(it))}else emptyList())
 private fun waitNative(timeout:Long=60000,condition:()->Boolean){
  val start=SystemClock.elapsedRealtime()
  while(!condition()){if(SystemClock.elapsedRealtime()-start>=timeout)throw AssertionError("Native state did not become ready within $timeout ms");SystemClock.sleep(10)}
 }
 private fun capture(name:String){
  val bitmap=requireNotNull(InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot())
  try{File(compose.activity.getExternalFilesDir("qa"),"$name.png").outputStream().use{bitmap.compress(Bitmap.CompressFormat.PNG,100,it)}}finally{bitmap.recycle()}
 }
 @Test fun actualNativeSourceAndFirstPaintWithoutUiAutomatorIdleDelay(){
  assumeTrue(InstrumentationRegistry.getArguments().getString("publishedWorkbenchTiming")=="true")
  val instrumentation=InstrumentationRegistry.getInstrumentation()
  val device=androidx.test.uiautomator.UiDevice.getInstance(instrumentation)
  require(device.executeShellCommand("getprop ro.boot.qemu.avd_name").trim()=="PaperDigest_QA_API35")
  compose.waitUntil(60000){root.state.value.catalogSummary.optInt("recordCount")>1000&&root.state.value.aggregate.catalog!=null}
  val catalog=root.state.value.aggregate.catalog!!
  val daily=catalog.records.filter{it.kind=="daily"}.maxBy{it.displayDate.orEmpty()}
  val results=JSONObject().put("contract","published-workbench-native-timing-v1").put("manifestSHA256",catalog.snapshotSHA256)
   .put("records",root.state.value.catalogSummary.optInt("recordCount")).put("aggregatePages",catalog.records.size).put("pageID",daily.id)
  val phaseOnly=InstrumentationRegistry.getArguments().getString("publishedWorkbenchPhaseOnly")=="true"
  val samples=JSONArray();results.put("samples",samples)
  val oldIdle=Configurator.getInstance().waitForIdleTimeout
  val oldOffline=root.state.value.settings.optBoolean("offlineMode")
  val scope=CoroutineScope(SupervisorJob()+Dispatchers.IO)
  fun save(){File(compose.activity.getExternalFilesDir("qa"),"workbench-native-timing.json").writeText(results.toString(2))}
  val maintenance=root.javaClass.getDeclaredField("maintenance").apply{isAccessible=true}.get(root) as Mutex
  val browser=root.javaClass.declaredMethods.first{it.returnType==AggregateBrowser::class.java&&it.parameterTypes.isEmpty()}.apply{isAccessible=true}.invoke(root) as AggregateBrowser
  val portField=browser.javaClass.getDeclaredField("port").apply{isAccessible=true}
  val claimField=browser.javaClass.getDeclaredField("claimReading").apply{isAccessible=true}
  val commitField=browser.javaClass.getDeclaredField("commitReading").apply{isAccessible=true}
  val maintenanceField=root.javaClass.getDeclaredField("maintenance").apply{isAccessible=true}
  val originalPort=portField.get(browser) as AggregateBrowsePort
  @Suppress("UNCHECKED_CAST") val originalClaim=claimField.get(browser) as NativeClaim
  @Suppress("UNCHECKED_CAST") val originalCommit=commitField.get(browser) as NativeCommit
  val stages=java.util.concurrent.ConcurrentHashMap<String,Long>()
  val selectedJobs=java.util.concurrent.ConcurrentHashMap.newKeySet<Job>()
  data class LockSample(val started:Long,val cpu:Long,val thread:Thread)
  val held=java.util.concurrent.atomic.AtomicReference<LockSample?>(null)
  // Delegates the exact original mutex; it neither adds a second acquisition nor changes ownership.
  val observedMutex=object:Mutex by maintenance {
   override suspend fun lock(owner:Any?){
    val job=currentCoroutineContext()[Job];val start=SystemClock.elapsedRealtime()
    maintenance.lock(owner)
    if(job!=null&&job in selectedJobs){stages["maintenanceWaitMs"]=SystemClock.elapsedRealtime()-start;held.set(LockSample(SystemClock.elapsedRealtime(),android.os.Debug.threadCpuTimeNanos(),Thread.currentThread()))}
   }
   override fun unlock(owner:Any?){
    held.getAndSet(null)?.let{sample->stages["maintenanceLockedWallMs"]=SystemClock.elapsedRealtime()-sample.started;if(sample.thread===Thread.currentThread())stages["maintenanceLockedCpuMs"]=(android.os.Debug.threadCpuTimeNanos()-sample.cpu)/1_000_000}
    maintenance.unlock(owner)
   }
  }
  val observedPort=object:AggregateBrowsePort by originalPort {
   override suspend fun savedSelection(id:String):com.nanless.paperdigest.data.AggregateSavedSelection? {
    val job=requireNotNull(currentCoroutineContext()[Job]);selectedJobs.add(job)
    val start=SystemClock.elapsedRealtime()
    try{return originalPort.savedSelection(id)}finally{selectedJobs.remove(job);stages["nativeSelectionMs"]=SystemClock.elapsedRealtime()-start}
   }
  }
  val observedClaim:NativeClaim={live->val start=SystemClock.elapsedRealtime();try{originalClaim(live)}finally{stages["claimReadingMs"]=SystemClock.elapsedRealtime()-start}}
  val observedCommit:NativeCommit={live,commit->val start=SystemClock.elapsedRealtime();try{originalCommit(live,commit)}finally{stages["commitReadingMs"]=SystemClock.elapsedRealtime()-start}}
  maintenanceField.set(root,observedMutex);portField.set(browser,observedPort);claimField.set(browser,observedClaim);commitField.set(browser,observedCommit)
  Configurator.getInstance().waitForIdleTimeout=0
  try {
   if(!phaseOnly)for(offline in listOf(true,false)){
    runBlocking{root.execute("settings.save",obj("changes" to obj("offlineMode" to offline)))}
    repeat(2){round->
     val prior=root.state.value.aggregate.document?.linkNonce
     stages.clear()
     val lease=root.captureAggregateView();val began=SystemClock.elapsedRealtime()
     val operation=scope.launch{root.executeAggregateInView("aggregate.select",obj("id" to daily.id),lease)}
     val previewReady=AtomicLong(0);val previewPainted=AtomicLong(0);var previewPosted=false
     waitNative {
      if(root.state.value.aggregate.preview!=null){
       previewReady.compareAndSet(0,SystemClock.elapsedRealtime())
       compose.mainClock.advanceTimeByFrame()
       instrumentation.runOnMainSync {
        val previewWeb=views(compose.activity.window.decorView).filterIsInstance<WebView>().firstOrNull{web->web.isShown&&web.progress==100&&web.contentHeight>0&&(web.tag as? StreamedHtmlDocument)?.containsBodyText("font-family:inherit") == true}
        if(previewWeb!=null&&!previewPosted){previewPosted=true;previewWeb.postVisualStateCallback(began,object:WebView.VisualStateCallback(){override fun onComplete(requestId:Long){if(root.state.value.aggregate.preview!=null&&(previewWeb.tag as? StreamedHtmlDocument)?.containsBodyText("font-family:inherit")==true)previewPainted.set(SystemClock.elapsedRealtime())}})}
       }
      }
      root.state.value.aggregate.document?.let{it.descriptor.id==daily.id&&it.linkNonce!=prior}==true
     }
     val documentReady=SystemClock.elapsedRealtime();val nonce=root.state.value.aggregate.document!!.linkNonce!!
     var visible:WebView?=null
     compose.waitUntil(60000){
      compose.runOnUiThread {visible=views(compose.activity.window.decorView).filterIsInstance<WebView>().firstOrNull{web->
       web.isShown&&web.width>0&&web.height>0&&web.progress==100&&web.contentHeight>0&&
        (web.tag as? StreamedHtmlDocument)?.let{owner->val live=root.state.value.aggregate.document?.linkNonce;live!=null&&owner.containsBodyText(live)&&web.url==owner.url}==true
      }}
      visible!=null
     }
     val painted=AtomicLong(0)
     compose.runOnUiThread {requireNotNull(visible).postVisualStateCallback(began,object:WebView.VisualStateCallback(){override fun onComplete(requestId:Long){painted.set(SystemClock.elapsedRealtime())}})}
     compose.waitUntil(15000){painted.get()>0}
     runBlocking{operation.cancelAndJoin()}
     samples.put(JSONObject().put("offline",offline).put("round",round+1).put("firstDocumentMs",documentReady-began).put("visualFrameMs",painted.get()-began).put("previewReadyMs",if(previewReady.get()>0)previewReady.get()-began else JSONObject.NULL).put("previewVisualMs",if(previewPainted.get()>0)previewPainted.get()-began else JSONObject.NULL).put("stages",JSONObject(stages.toMap())))
     save();capture("workbench-native-${if(offline)"offline"else"online"}-${round+1}")
    }
   }
   // Read-only CPU diagnostic against the same Application-owned repository and maintenance mutex.
   runBlocking{root.execute("settings.save",obj("changes" to obj("offlineMode" to true)))}
   val library=root.javaClass.getDeclaredField("library").apply{isAccessible=true}.get(root) as CatalogRepository
   val reads=JSONArray();results.put("nativeCombinedReads",reads)
   repeat(if(phaseOnly)0 else 3){
    val sample=runBlocking{withContext(Dispatchers.IO){maintenance.withLock {
     val wall=SystemClock.elapsedRealtime();val cpu=android.os.Debug.threadCpuTimeNanos()
     val selected=library.aggregateSavedSelection(daily.id)
     require(selected?.document!=null)
     JSONObject().put("wallMs",SystemClock.elapsedRealtime()-wall).put("threadCpuMs",(android.os.Debug.threadCpuTimeNanos()-cpu)/1_000_000)
    }}}
    reads.put(sample);save()
   }
   val phases=runBlocking{withContext(Dispatchers.IO){maintenance.withLock {
    val stamp=library.aggregateStamp();val store=PublishedAggregateStore(File(root.personal.directory,"PublishedLibrary"))
    val row=JSONObject();var mark=SystemClock.elapsedRealtime()
    results.put("nativePhases",row)
    fun phase(name:String){val now=SystemClock.elapsedRealtime();row.put(name,now-mark);mark=now;save()}
    library.aggregateCatalog();phase("repositoryCatalogMs")
    root.javaClass.getDeclaredMethod("refresh").apply{isAccessible=true}.invoke(root);phase("rootRefreshMs")
    var selectedView:AggregateDocumentView?=null
    store.withSourceReadScope {
     val current=store.load(stamp.snapshotSHA256,stamp.validationEpoch)!!;phase("catalogMs")
     val descriptor=current.records.single{it.id==daily.id}
     val revisions=store.cachedRevisions(descriptor);phase("revisionsMs")
     val value=store.cachedDocument(descriptor,revisions.first().rawHTMLSHA256);phase("htmlMs")
     val images=store.latestImageRendering(descriptor,revisions.first().rawHTMLSHA256)?:store.importMacImageRendering(descriptor,revisions.first().rawHTMLSHA256);phase("cachedImagesMs")
     val view=AggregateDocumentView.verified(value,descriptor,true).copy(images=images);selectedView=view
     AggregateLinkTable.derive(view);phase("linksMs")
    }
    phase("scopeExitMs")
    val paper=root.state.value.papers.firstOrNull{it.id=="arxiv:2610.37906"}
    if(paper!=null){
     val view=requireNotNull(selectedView)
     val table=AggregateLinkTable.derive(view)
     val href=(0..2048).mapNotNull{table.href(it)}.firstOrNull{AggregateLinkRouting.samePage(it,paper.blogURL,view.descriptor.sourceURL)}?:error("The real current document has no link to this paper")
     mark=SystemClock.elapsedRealtime();library.aggregateLink(view,href);phase("actualPaperLinkMs")
     mark=SystemClock.elapsedRealtime();val cached=library.article(paper);phase("offlineCachedArticleMs")
     row.put("cachedArticleCompleteOffline",cached.completeOffline).put("cachedArticleStale",cached.isStale).put("articleResources",cached.resources.size).put("articleMissingResources",cached.resources.count{it.localPath==null||it.sha256==null})
    }
    row
   }}}
   results.put("nativePhases",phases)
   results.put("modelsCalled",false);save();println("ACTUAL_NATIVE_WORKBENCH_TIMING "+results.toString())
  }finally {
   runBlocking{scope.coroutineContext[Job]?.cancelAndJoin()}
   maintenanceField.set(root,maintenance);portField.set(browser,originalPort);claimField.set(browser,originalClaim);commitField.set(browser,originalCommit)
   runBlocking{root.execute("settings.save",obj("changes" to obj("offlineMode" to oldOffline)))}
   Configurator.getInstance().waitForIdleTimeout=oldIdle
  }
 }
}
