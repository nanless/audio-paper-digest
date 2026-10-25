package com.nanless.paperdigest.review

import android.content.Context
import android.content.ContextWrapper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import com.nanless.paperdigest.RootController
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.pdf.*
import com.nanless.paperdigest.ui.UiState
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.sync.Mutex
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

/** Independent tests use isolated private data, no credentials and no background-runtime installation. */
@RunWith(AndroidJUnit4::class)
class RootConcurrencyInstrumentedTest {
 private class Fixture {
  val target=InstrumentationRegistry.getInstrumentation().targetContext
  val directory=File(target.cacheDir,"RootConcurrency-${UUID.randomUUID()}").canonicalFile.also{it.mkdirs()}
  val context=object:ContextWrapper(target){override fun getNoBackupFilesDir()=directory}
  val research=File(directory,"PaperDigest")
  init {PersonalStore(research).updateSettings(JSONObject().put("offlineMode",true).put("endpoint","https://example.invalid/v1").put("model","isolated-test-model").put("protocol","chat").put("maxTokens",128).put("timeoutMs",1000).put("dailyRequests",1))}
  val controller=RootController(context,installBackground=false)
  val lock=field<Mutex>(controller,"maintenance")
  val flow=field<MutableStateFlow<UiState>>(controller,"_state")
  val generation=field<AtomicLong>(controller,"generation")
  val old="isolated-old-owner";val next="isolated-next-owner"
  init {
   controller.personal.rememberPaper(Paper(old,"Isolated old owner",sourceKind="review-fixture"))
   controller.personal.rememberPaper(Paper(next,"Isolated next owner",sourceKind="review-fixture"))
   generation.set(100)
   flow.value=flow.value.copy(selectedPaperId=old,article=article(old,"a"),error="not-entered")
  }
  private fun article(id:String,letter:String)=Article(id,"<p>Isolated fixture evidence</p>","Isolated fixture evidence. No production data.","https://example.invalid/source","https://example.invalid/guide",letter.repeat(64),"2026-10-25",sourceVersion="fixture-v1")
  fun switchOwner(){generation.incrementAndGet();flow.value=flow.value.copy(selectedPaperId=next,article=article(next,"b"),pdfPage=2)}
  fun changeGeneration(){generation.incrementAndGet();flow.value=flow.value.copy(article=article(old,"c"))}
  suspend fun pdf():Pair<PdfDocumentRef,PdfRepository>{
   val sample=JSONObject(target.assets.open("published/sample.json").bufferedReader().use{it.readText()})
   val metadata=sample.getJSONObject("pdf");val original=File(directory,"original-fixture.pdf")
   target.assets.open("published/"+metadata.getString("src")).use{input->original.outputStream().use{input.copyTo(it)}}
   assertEquals(metadata.getString("sha256"),sha256(original.readBytes()))
   val repo=PdfRepository(context,research);val document=repo.importFile(original,"Published MiCLA fixture")
   flow.value=flow.value.copy(pdfDocument=document,pdfPage=1,pdfMode=true,pdfReceipt=JSONObject().put("paperID",old).put("sha256",document.sha256).put("version","fixture-v1").put("sourceURL","https://example.invalid/fixture"))
   return document to repo
  }
  suspend fun close(){
   controller.personal.snapshot().getJSONArray("sessions").objects().forEach{s->runCatching{WorkManager.getInstance(target).cancelWorkById(UUID.fromString(s.getString("id"))).result.get(10,java.util.concurrent.TimeUnit.SECONDS)}}
   directory.deleteRecursively()
  }
 }
 private suspend fun Fixture.blocked(command:String,payload:JSONObject,change:()->Unit):Throwable=coroutineScope {
  val owner=Any();lock.lock(owner)
  val pending=async(start=CoroutineStart.UNDISPATCHED){runCatching{controller.execute(command,payload)}}
  try {
   // execute clears this sentinel before attempting the already-held real maintenance mutex.
   withTimeout(5000){while(flow.value.error!=null)delay(1)}
   assertTrue(pending.isActive);change()
  }finally{lock.unlock(owner)}
  withTimeout(15000){pending.await()}.exceptionOrNull()?:throw AssertionError("Old reading action was accepted after its source changed")
 }
 @Test fun queuedQuestionCannotAdoptAnotherPaperAfterMaintenanceWait()=runBlocking {
  val f=Fixture();try{val e=f.blocked("model.run",JSONObject().put("question","Question bound to old owner").put("evidenceKind","guide")){f.switchOwner()};assertTrue(e.message.orEmpty().contains("论文已经切换"));assertEquals(0,f.controller.personal.snapshot().getJSONArray("sessions").length());assertEquals(f.next,f.flow.value.selectedPaperId)}finally{f.close()}
 }
 @Test fun samePaperNewGenerationCannotReceiveOldQuestion()=runBlocking {
  val f=Fixture();try{val e=f.blocked("model.run",JSONObject().put("question","Old revision question").put("evidenceKind","guide")){f.changeGeneration()};assertTrue(e.message.orEmpty().contains("论文已经切换"));assertEquals(0,f.controller.personal.snapshot().getJSONArray("sessions").length())}finally{f.close()}
 }
 @Test fun delayedPageChangeCannotOverwriteNewPaperReadingState()=runBlocking {
  val f=Fixture();try{f.pdf();val e=f.blocked("pdf.page",JSONObject().put("page",3)){f.switchOwner()};assertTrue(e.message.orEmpty().contains("论文已经切换"));assertEquals(2,f.flow.value.pdfPage);assertFalse(f.controller.personal.snapshot().getJSONObject("readingState").has(f.next))}finally{f.close()}
 }
 @Test fun delayedPageChangeCannotReuseAnotherPdfSha()=runBlocking {
  val f=Fixture();try{val(d,_)=f.pdf();val e=f.blocked("pdf.page",JSONObject().put("page",3)){f.flow.value=f.flow.value.copy(pdfDocument=d.copy(sha256="f".repeat(64)),pdfPage=2)};assertTrue(e.message.orEmpty().contains("PDF 原件已经切换"));assertEquals(2,f.flow.value.pdfPage);assertFalse(f.controller.personal.snapshot().getJSONObject("readingState").has(f.old))}finally{f.close()}
 }
 @Test fun queuedSelectionQuestionMustNotAdoptNewSelectionInSamePdf()=runBlocking {
  val f=Fixture();try{val(d,repo)=f.pdf();val matches=repo.search(d,"MiCLA");assertTrue(matches.size>=2);val a=matches.first();val b=matches.last();val first=repo.select(d,a.page,a.start,a.end);val second=repo.select(d,b.page,b.start,b.end);assertNotEquals(first,second);f.controller.updatePdfSelection(first)
   val e=f.blocked("model.run",JSONObject().put("question","Question about first exact selection").put("evidenceKind","selection")){f.flow.value=f.flow.value.copy(pdfSelection=second)}
   assertTrue(e.message.orEmpty().contains("选区"));assertEquals(0,f.controller.personal.snapshot().getJSONArray("sessions").length());assertEquals(second,f.flow.value.pdfSelection)
  }finally{f.close()}
 }
 @Test fun queuedCurrentPageQuestionMustNotAdoptLaterPageInSamePdf()=runBlocking {
  val f=Fixture();try{f.pdf();val e=f.blocked("model.run",JSONObject().put("question","Question about clicked physical page one").put("evidenceKind","page")){f.flow.value=f.flow.value.copy(pdfPage=2)};assertTrue(e.message.orEmpty().contains("页"));assertEquals(0,f.controller.personal.snapshot().getJSONArray("sessions").length())}finally{f.close()}
 }
 companion object {@Suppress("UNCHECKED_CAST") private fun <T>field(value:Any,name:String):T=value.javaClass.getDeclaredField(name).also{it.isAccessible=true}.get(value) as T}
}
