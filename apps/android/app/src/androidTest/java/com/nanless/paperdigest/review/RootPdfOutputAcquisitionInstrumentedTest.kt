package com.nanless.paperdigest.review

import android.content.ContextWrapper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nanless.paperdigest.RootController
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.pdf.*
import com.nanless.paperdigest.ui.UiState
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.PDPage
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.coroutines.CoroutineContext

/** Deterministic return-boundary cancellation on the real typed Root capability; no new product test hook. */
@RunWith(AndroidJUnit4::class)
class RootPdfOutputAcquisitionInstrumentedTest {
 private class HeldReturnDispatcher:CoroutineDispatcher() {
  val continuations=LinkedBlockingQueue<Runnable>()
  override fun dispatch(context:CoroutineContext,block:Runnable){continuations.put(block)}
 }
 @Test fun cancelledReturnDisposesCreatedUnhandedCopyAndPreservesActualOriginal()=runBlocking {
  val target=InstrumentationRegistry.getInstrumentation().targetContext
  val temporary=File(target.cacheDir,"RootPdfAcquisition-${UUID.randomUUID()}").canonicalFile.also{it.mkdirs()}
  val context=object:ContextWrapper(target){override fun getNoBackupFilesDir()=temporary}
  val research=File(temporary,"PaperDigest")
  PersonalStore(research).updateSettings(JSONObject().put("offlineMode",true))
  val controller=RootController(context,installBackground=false)
  val outbound=File(context.cacheDir,"PdfOutbound")
  val before=outbound.listFiles()?.map{it.name}?.toSet().orEmpty()
  val owned=mutableListOf<File>()
  try {
   withTimeout(10000){while(controller.state.value.pendingExportsLoading)delay(5)}
   PDFBoxResourceLoader.init(target.applicationContext)
   val source=File(temporary,"synthetic-original.pdf")
   PDDocument().use{it.addPage(PDPage());it.save(source)}
   val repository=PdfRepository(context,research);val document=repository.importFile(source)
   val paper=Paper(document.id,"Synthetic original",sourceKind="local",localPDFPath=document.localPath,pdfSHA256=document.sha256)
   controller.personal.rememberPaper(paper)
   val state=field<MutableStateFlow<UiState>>(controller,"_state")
   state.value=state.value.copy(selectedPaperId=paper.id,viewedPaper=paper,pdfMode=true,pdfDocument=document,pdfReceipt=JSONObject().put("paperID",paper.id).put("sha256",document.sha256))
   controller.execute("app.bootstrap",JSONObject())
   val token=controller.state.value.readingMaterialID;assertTrue(token.isNotBlank())
   val originalSHA=com.nanless.paperdigest.cloud.BackupCodec.hash(File(document.localPath))
   val queued=HeldReturnDispatcher()
   // It starts in this test thread, reaches Root IO, and then queues the return to this dispatcher.
   val caller=async(queued,start=CoroutineStart.UNDISPATCHED){controller.prepareOriginalPdfOutput(token)}
   val returnTask=withContext(Dispatchers.IO){queued.continuations.poll(15,TimeUnit.SECONDS)}
   assertNotNull("Actual typed Root operation did not reach its queued return boundary",returnTask)
   owned.addAll(outbound.listFiles().orEmpty().filter{it.name !in before})
   assertEquals(1,owned.size);assertTrue(File(owned.single(),"original.pdf").isFile)
   assertTrue("Caller has not received the capability",caller.isActive)
   caller.cancel()
   returnTask!!.run()
   withTimeout(10000){while(!caller.isCompleted){queued.continuations.poll(20,TimeUnit.MILLISECONDS)?.run();yield()}}
   assertTrue(caller.isCancelled)
   assertFalse("An unreceived unhanded output copy must be disposed at the real cancellation boundary",File(owned.single(),"original.pdf").exists())
   assertEquals(originalSHA,com.nanless.paperdigest.cloud.BackupCodec.hash(File(document.localPath)))
   assertEquals(0,controller.personal.snapshot().getJSONArray("sessions").length())
  } finally {
   val scope=field<CoroutineScope>(controller,"exportScope");scope.cancel();scope.coroutineContext[Job]?.join()
   owned.forEach{it.deleteRecursively()};temporary.deleteRecursively()
  }
 }
 companion object {@Suppress("UNCHECKED_CAST")private fun<T>field(value:Any,name:String):T=value.javaClass.getDeclaredField(name).also{it.isAccessible=true}.get(value) as T}
}
