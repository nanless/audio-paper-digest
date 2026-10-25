package com.nanless.paperdigest.review

import android.content.ContentProvider
import android.content.ContentValues
import android.content.ContextWrapper
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.SdkSuppress
import androidx.test.rule.provider.ProviderTestRule
import androidx.test.platform.app.InstrumentationRegistry
import com.nanless.paperdigest.RootController
import com.nanless.paperdigest.cloud.BackupCodec
import com.nanless.paperdigest.data.*
import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.Rule
import org.junit.runner.RunWith
import java.io.File
import java.io.FileNotFoundException
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Real Root/builder/pending/provider chain in private temporary data. No real document provider or credentials. */
@RunWith(AndroidJUnit4::class)
class RootPendingExportInstrumentedTest {
 @get:Rule val providerRule=ProviderTestRule.Builder(Destination::class.java,AUTHORITY).build()
 private class Boundary(private val name:String) {
  val entered=CountDownLatch(1);val release=CountDownLatch(1)
  fun visit(value:String){if(value==name){entered.countDown();check(release.await(15,TimeUnit.SECONDS)){"Synthetic boundary was not released"}}}
  suspend fun await()=withContext(Dispatchers.IO){assertTrue("Actual persisted boundary was not reached",entered.await(10,TimeUnit.SECONDS))}
 }
 private class DestinationState(val file:File) { @Volatile var rejectRead=false;val writes=AtomicInteger(0) }
 /** Public zero-argument provider instantiated by the existing AndroidX rule, never a product component. */
 class Destination:ContentProvider() {
  override fun onCreate()=true
  override fun openFile(uri:Uri,mode:String):ParcelFileDescriptor {
   val id=uri.lastPathSegment?:throw FileNotFoundException("No synthetic destination")
   val entry=providerFiles[id]?:throw FileNotFoundException("Synthetic destination is not registered")
   if(mode.contains('w'))entry.writes.incrementAndGet() else if(entry.rejectRead)throw FileNotFoundException("Synthetic readback refused")
   return ParcelFileDescriptor.open(entry.file,ParcelFileDescriptor.parseMode(mode))
  }
  override fun getType(uri:Uri)="application/octet-stream"
  override fun query(uri:Uri,projection:Array<out String>?,selection:String?,selectionArgs:Array<out String>?,sortOrder:String?):Cursor?=null
  override fun insert(uri:Uri,values:ContentValues?):Uri?=null
  override fun delete(uri:Uri,selection:String?,selectionArgs:Array<out String>?)=0
  override fun update(uri:Uri,values:ContentValues?,selection:String?,selectionArgs:Array<out String>?)=0
 }
 private inner class Fixture(private val boundary:Boundary?=null,brokenControl:Boolean=false,private val fault:(String)->Unit={}) {
  val target=InstrumentationRegistry.getInstrumentation().targetContext
  val directory=File(target.cacheDir,"PendingRoot-${UUID.randomUUID()}").canonicalFile.also{it.mkdirs()}
  val selected=File(directory,"synthetic-external-destination.bin")
  private val destinationID=UUID.randomUUID().toString()
  val uri=Uri.parse("content://$AUTHORITY/$destinationID")
  val destination=DestinationState(selected).also{providerFiles[destinationID]=it}
  val resolver get()=providerRule.resolver
  val context=object:ContextWrapper(target){override fun getNoBackupFilesDir()=directory;override fun getContentResolver()=resolver}
  val begins=AtomicInteger(0)
  val controllers=mutableListOf<RootController>()
  init {
   PersonalStore(File(directory,"PaperDigest")).updateSettings(JSONObject().put("offlineMode",true))
   if(brokenControl){val root=File(directory,"PaperDigestTransfers").also{it.mkdirs()};File(root,"PendingExports").writeText("not a control directory")}
  }
  fun controller()=RootController(context,installBackground=false,exportStoreFactory={output,controls->
   PendingExportStore(output,controls,persistedBoundary={value->if(value=="begin.persisted")begins.incrementAndGet();boundary?.visit(value);fault(value)})
  }).also{controllers+=it}
  suspend fun loaded(root:RootController){withTimeout(10000){while(root.state.value.pendingExportsLoading)delay(5)}}
  suspend fun prepared(root:RootController)=root.execute("export.prepare",JSONObject().put("format","diagnostics"))
  fun pending(root:RootController,id:String)=root.state.value.pendingExports.single{it.getString("operationID")==id}
  suspend fun stop(root:RootController){val scope=field<CoroutineScope>(root,"exportScope");scope.cancel();scope.coroutineContext[Job]?.join()}
  suspend fun close(){boundary?.release?.countDown();for(root in controllers)stop(root);providerFiles.remove(destinationID);directory.deleteRecursively()}
 }
 @Test fun durableReadyReopensSameDocumentWithoutAnotherProducer()=runBlocking {
  val f=Fixture();try {
   val first=f.controller();f.loaded(first);val result=f.prepared(first)
   assertEquals("ready",result.getString("preparation"));assertTrue(result.getBoolean("ready"))
   val id=result.getString("operationID");val document=result.getString("documentID");val sha=result.getString("sha256")
   f.stop(first);val second=f.controller();f.loaded(second);val row=f.pending(second,id)
   assertEquals(document,row.getString("documentID"));assertEquals(sha,row.getString("sha256"));assertEquals(1,f.begins.get())
   assertEquals(0,second.personal.snapshot().getJSONArray("sessions").length())
   val chooser=second.execute("export.delivery.prepare",JSONObject().put("operationID",id))
   assertEquals(document,chooser.getString("documentID"));assertEquals("choosing",chooser.getString("delivery"))
  }finally{f.close()}
 }
 @Test fun cancellingScreenAwaitDoesNotCancelApplicationOwnedProducer()=runBlocking {
  val stop=Boundary("ready.persisted");val f=Fixture(stop)
  try {
   val root=f.controller();f.loaded(root)
   val caller=async { f.prepared(root) };stop.await()
   caller.cancelAndJoin()
   assertTrue(field<ConcurrentHashMapAlias>(root,"active").isNotEmpty())
   assertTrue(root.state.value.notice.orEmpty().contains("仍在后台"));assertFalse(root.state.value.error.orEmpty().contains("已取消"))
   stop.release.countDown()
   withTimeout(10000){while(root.state.value.jobs.none{it.optString("kind")=="export.prepare"&&it.optString("status")=="completed"})delay(5)}
   val prepared=root.state.value.pendingExports.single()
   assertTrue(prepared.getBoolean("ready"));assertEquals("ready",prepared.getString("preparation"))
   assertEquals(1,f.begins.get());assertEquals(0,root.personal.snapshot().getJSONArray("sessions").length())
  }finally{f.close()}
 }
 @Test fun explicitJobCancellationWaitsForRealProducerDrainAndKeepsRegisteredBytes()=runBlocking {
  val stop=Boundary("candidate.persisted");val f=Fixture(stop)
  try {
   val root=f.controller();f.loaded(root)
   val caller=async { runCatching{f.prepared(root)} };stop.await()
   val row=root.state.value.pendingExports.single();val job=row.getString("jobID")
   val cancellation=async {root.execute("jobs.cancel",JSONObject().put("id",job))}
   withTimeout(5000){while(field<ConcurrentHashMapAlias>(root,"active")[job]?.isCancelled!=true)delay(5)}
   assertTrue("join must still wait for the actual blocked writer",cancellation.isActive)
   assertEquals("running",root.personal.snapshot().getJSONArray("jobs").objects().single{it.getString("id")==job}.getString("status"))
   stop.release.countDown();withTimeout(10000){cancellation.await();caller.await()}
   assertTrue(field<ConcurrentHashMapAlias>(root,"active").isEmpty())
   assertEquals("cancelled",root.personal.snapshot().getJSONArray("jobs").objects().single{it.getString("id")==job}.getString("status"))
   assertTrue(File(f.directory,"PaperDigestTransfers/Exports/${row.getString("documentID")}.bin").isFile)
   assertFalse(f.pending(root,row.getString("operationID")).optBoolean("ready"))
  }finally{f.close()}
 }
 @Test fun damagedPendingControlDoesNotBreakBootstrapOrPretendEmptySuccess()=runBlocking {
  val f=Fixture(brokenControl=true);try {
   val root=f.controller();f.loaded(root)
   assertNotNull(root.state.value.pendingExportsError)
   assertFalse(root.state.value.pendingExportsLoading)
   assertTrue(root.execute("app.bootstrap",JSONObject()).getBoolean("ready"))
   assertNotNull(root.state.value.pendingExportsError)
  }finally{f.close()}
 }
 @Test fun coldOldChooserCannotWriteAndNewExplicitAttemptKeepsOriginalDocument()=runBlocking {
  val f=Fixture();try {
   val first=f.controller();f.loaded(first);val prepared=f.prepared(first);val id=prepared.getString("operationID")
   val old=first.execute("export.delivery.prepare",JSONObject().put("operationID",id))
   f.stop(first);val second=f.controller();f.loaded(second)
   val rejected=runCatching{second.execute("export.save",JSONObject().put("operationID",id).put("attemptID",old.getString("attemptID")).put("uri",f.uri.toString()))}
   assertTrue(rejected.isFailure);assertEquals(0,f.destination.writes.get());assertTrue(f.pending(second,id).getBoolean("ready"))
   val next=second.execute("export.delivery.prepare",JSONObject().put("operationID",id))
   assertNotEquals(old.getString("attemptID"),next.getString("attemptID"));assertEquals(old.getString("documentID"),next.getString("documentID"))
   assertTrue(runCatching{second.execute("export.delivery.cancel",JSONObject().put("operationID",id).put("attemptID",old.getString("attemptID")))}.isFailure)
   val saved=second.execute("export.save",JSONObject().put("operationID",id).put("attemptID",next.getString("attemptID")).put("uri",f.uri.toString()))
   assertTrue(saved.getBoolean("verified"));assertEquals(prepared.getString("sha256"),sha256(f.selected.readBytes()));assertEquals(1,f.destination.writes.get())
  }finally{f.close()}
 }
 @Test fun providerWriteWithoutReadbackNeverBecomesVerifiedOrLosesReadyOriginal()=runBlocking {
  val f=Fixture();try {
   val root=f.controller();f.loaded(root);val prepared=f.prepared(root);val id=prepared.getString("operationID")
   val attempt=root.execute("export.delivery.prepare",JSONObject().put("operationID",id));f.destination.rejectRead=true
   val receipt=root.execute("export.save",JSONObject().put("operationID",id).put("attemptID",attempt.getString("attemptID")).put("uri",f.uri.toString()))
   assertTrue(receipt.getBoolean("saved"));assertFalse(receipt.getBoolean("verified"));assertTrue(receipt.getString("message").contains("未完整确认"))
   assertEquals("written-unverified",f.pending(root,id).getString("delivery"));assertTrue(f.pending(root,id).getBoolean("ready"))
   assertEquals(prepared.getString("sha256"),sha256(f.selected.readBytes()))
   assertEquals("failed",root.state.value.jobs.single{it.optString("kind")=="export.save"}.getString("status"))
  }finally{f.close()}
 }
 @Test fun interruptedOrdinaryManifestCannotClaimUpstreamCompletion()=runBlocking {
  val f=Fixture(fault={if(it=="candidate.persisted")throw java.io.IOException("Synthetic failure before durable ready")})
  try {
   val root=f.controller();f.loaded(root)
   assertTrue(runCatching{f.prepared(root)}.isFailure)
   val original=root.state.value.pendingExports.single();val id=original.getString("operationID")
   val file=File(f.directory,"PaperDigestTransfers/Exports/${original.getString("documentID")}.bin")
   val before=sha256(file.readBytes());root.execute("export.reconcile",JSONObject().put("operationID",id))
   assertFalse(f.pending(root,id).optBoolean("ready"));assertEquals("interrupted",f.pending(root,id).getString("preparation"))
   assertEquals(before,sha256(file.readBytes()));assertEquals(1,f.begins.get())
  }finally{f.close()}
 }
 @Test fun normalBackupCompletionReceiptRecoversSameOriginalAndCapturedRunningFact()=runBlocking {
  val f=Fixture(fault={if(it=="candidate.persisted")throw java.io.IOException("Synthetic interruption after verified normal capture")})
  try {
   val root=f.controller();f.loaded(root)
   assertTrue(runCatching{root.execute("export.prepare",JSONObject().put("format","backup"))}.isFailure)
   val original=root.state.value.pendingExports.single();val op=original.getString("operationID")
   val temp=File(f.directory,"PaperDigestTransfers/PendingExports/$op/capture.tmp")
   val sha=sha256(temp.readBytes());assertTrue(File(temp.parentFile,"producer-complete.json").isFile)
   val reconciled=root.execute("export.reconcile",JSONObject().put("operationID",op));assertEquals(1,reconciled.getJSONArray("pendingExports").length())
   val ready=f.pending(root,op);assertTrue(ready.getBoolean("ready"));assertEquals(sha,ready.getString("sha256"));assertEquals(1,f.begins.get())
   val exported=File(f.directory,"PaperDigestTransfers/Exports/${ready.getString("documentID")}.bin")
   val staged=BackupCodec.stage(exported.inputStream(),f.directory)
   try {
    val captured=JSONObject(File(staged.directory,"personal.json").readText())
    val job=original.getString("jobID")
    assertEquals("running",captured.getJSONArray("jobs").objects().single{it.getString("id")==job}.getString("status"))
    assertEquals("completed",root.personal.snapshot().getJSONArray("jobs").objects().single{it.getString("id")==job}.getString("status"))
    assertEquals(0,captured.getJSONArray("sessions").length());assertEquals(sha,sha256(temp.readBytes()))
   }finally{staged.directory.deleteRecursively()}
  }finally{f.close()}
 }
 @Test fun missingOriginalPersonalIsNotTreatedAsCapacityOrReadOnlyRescue()=runBlocking {
  val f=Fixture();try {
   val root=f.controller();f.loaded(root);val original=File(f.directory,"PaperDigest/personal.json")
   val retained=File(original.parentFile,"synthetic-original-retained.json");val sha=BackupCodec.hash(original)
   assertTrue(original.renameTo(retained))
   assertTrue(runCatching{root.execute("export.prepare",JSONObject().put("format","backup"))}.isFailure)
   assertTrue(root.state.value.pendingExports.isEmpty());assertEquals(0,f.begins.get());assertEquals(sha,BackupCodec.hash(retained))
   assertTrue(root.state.value.jobs.none{it.optBoolean("localRescueExport")})
  }finally{f.close()}
 }
 @Test fun duplicateSaveCallbacksReserveOnlyOneWriterForOriginalAttempt()=runBlocking {
  val f=Fixture();try {
   val root=f.controller();f.loaded(root);val prepared=f.prepared(root);val op=prepared.getString("operationID")
   val attempt=root.execute("export.delivery.prepare",JSONObject().put("operationID",op)).getString("attemptID")
   val lock=field<kotlinx.coroutines.sync.Mutex>(root,"maintenance");val owner=Any();lock.lock(owner)
   val payload=JSONObject().put("operationID",op).put("attemptID",attempt).put("uri",f.uri.toString())
   val requests=try{listOf(
    async(Dispatchers.IO,start=CoroutineStart.UNDISPATCHED){runCatching{root.execute("export.save",payload)}},
    async(Dispatchers.IO,start=CoroutineStart.UNDISPATCHED){runCatching{root.execute("export.save",payload)}}
   )}finally{lock.unlock(owner)}
   val results=withTimeout(15000){requests.map{it.await()}}
   assertEquals(1,results.count{it.isSuccess});assertEquals(1,results.count{it.isFailure})
   assertEquals(1,f.destination.writes.get());assertEquals(1,root.state.value.jobs.count{it.optString("kind")=="export.save"})
   assertEquals(prepared.getString("sha256"),BackupCodec.hash(f.selected))
  }finally{f.close()}
 }
 @Test @SdkSuppress(minSdkVersion=35)
 fun exact32MiBLegalPersonalUsesReadOnlyRescueAndActualSaveProofWithoutChangingOriginalFiles()=runBlocking {
  val f=Fixture()
  try {
   // Stream the synthetic padding into a legal exact-size original; do not retain 32MiB fixture strings/byte arrays.
   val research=File(f.directory,"PaperDigest")
   val initial=PersonalStore.initial().also{it.getJSONObject("settings").put("offlineMode",true)}.toString()
   val prefix=(initial.dropLast(1)+",\"syntheticPadding\":\"").toByteArray(Charsets.UTF_8);val suffix="\"}".toByteArray()
   val personalFile=File(research,"personal.json")
   personalFile.outputStream().use{output->
    output.write(prefix);val buffer=ByteArray(64*1024){'x'.code.toByte()};var left=PersonalStore.MAX_BYTES-prefix.size-suffix.size
    while(left>0){val n=minOf(left,buffer.size.toLong()).toInt();output.write(buffer,0,n);left-=n};output.write(suffix)
   }
   assertEquals(32L*1024*1024,personalFile.length())
   val originalSHA=BackupCodec.hash(personalFile)
   val raw=File(research,"ModelUsage/synthetic-original-response.bin").also{it.parentFile!!.mkdirs();it.writeText("Synthetic original paid response; no API call")}
   val rawSHA=BackupCodec.hash(raw)
   val root=f.controller();f.loaded(root)
   val refused=runCatching{root.personal.upsertJob(JSONObject().put("id",UUID.randomUUID().toString()).put("kind","synthetic").put("status","running"))}.exceptionOrNull()
   assertTrue(refused is AppFailure);assertEquals("capacity",(refused as AppFailure).category)
   assertEquals(originalSHA,BackupCodec.hash(personalFile))
   val prepared=withTimeout(180000){root.execute("export.prepare",JSONObject().put("format","backup"))}
   assertTrue(prepared.getBoolean("ready"));val id=prepared.getString("operationID")
   assertTrue(prepared.getJSONObject("sourceIdentity").getBoolean("rescueExport"))
   val controllerJob=root.state.value.jobs.single{it.getString("id")==prepared.getString("jobID")}
   assertTrue(controllerJob.getBoolean("localRescueExport"));assertEquals("completed",controllerJob.getString("status"))
   assertEquals(0,root.personal.snapshot().getJSONArray("jobs").length())
   assertEquals(originalSHA,BackupCodec.hash(personalFile));assertEquals(rawSHA,BackupCodec.hash(raw))
   val originalBin=File(f.directory,"PaperDigestTransfers/Exports/${prepared.getString("documentID")}.bin")
   val encodedSHA=BackupCodec.hash(originalBin);assertEquals(prepared.getString("sha256"),encodedSHA)
   val staged=BackupCodec.stage(originalBin.inputStream(),f.directory)
   try { val original=staged.entries.single{it.path=="personal.json"};assertEquals(originalSHA,original.sha256);assertEquals(32L*1024*1024,original.bytes);assertEquals(originalSHA,BackupCodec.hash(File(staged.directory,"personal.json"))) }
   finally{staged.directory.deleteRecursively()}
   val beforeHistory=File(research,"ExportHistory").listFiles()?.map{it.name}?.toSet().orEmpty()
   val attempt=root.execute("export.delivery.prepare",JSONObject().put("operationID",id))
   val saved=withTimeout(180000){root.execute("export.save",JSONObject().put("operationID",id).put("attemptID",attempt.getString("attemptID")).put("uri",f.uri.toString()))}
   assertTrue(saved.getBoolean("verified"));assertEquals(encodedSHA,BackupCodec.hash(f.selected));assertEquals(encodedSHA,BackupCodec.hash(originalBin))
   assertEquals(originalSHA,BackupCodec.hash(personalFile));assertEquals(rawSHA,BackupCodec.hash(raw));assertEquals(32L*1024*1024,personalFile.length())
   assertEquals(0,root.personal.snapshot().getJSONArray("jobs").length());assertEquals(0,root.personal.snapshot().getJSONArray("sessions").length())
   val added=File(research,"ExportHistory").listFiles().orEmpty().filter{it.name !in beforeHistory}
   assertEquals(1,added.size);val history=JSONObject(added.single().readText())
   assertEquals(prepared.getString("documentID"),history.getString("documentID"));assertEquals(encodedSHA,history.getString("sha256"));assertEquals(f.selected.length(),history.getLong("bytes"))
   // The shared actual proof location/contract is checked by the normal capacity consumer below.
   val plan=root.execute("storage.cleanup.prepare",JSONObject())
   assertTrue(plan.getJSONArray("items").objects().any{it.getString("documentID")==prepared.getString("documentID")})
   assertTrue(root.state.value.jobs.filter{it.optString("kind") in setOf("export.prepare","export.save")}.all{it.optBoolean("localRescueExport")})
  }finally{f.close()}
 }
 companion object {
  const val AUTHORITY="synthetic.pending-export-documents"
  private val providerFiles=java.util.concurrent.ConcurrentHashMap<String,DestinationState>()
  @Suppress("UNCHECKED_CAST")private fun<T>field(root:Any,name:String):T=root.javaClass.getDeclaredField(name).also{it.isAccessible=true}.get(root) as T
 }
}
private typealias ConcurrentHashMapAlias=java.util.concurrent.ConcurrentHashMap<String,Job>
