package com.nanless.paperdigest.pdf

import androidx.test.platform.app.InstrumentationRegistry
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.PDPage
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.coroutines.CoroutineContext

/** Exact IO-result delivery is queued, never delay-guessed; no UI, source edit or production hook. */
class PdfOriginalReturnCancellationInstrumentedTest {
 private class HeldDispatcher:CoroutineDispatcher(){
  val queue=LinkedBlockingQueue<Runnable>()
  override fun dispatch(context:CoroutineContext,block:Runnable){queue.add(block)}
  fun take():Runnable=requireNotNull(queue.poll(15,TimeUnit.SECONDS)){"Actual caller dispatch boundary was not reached"}
 }
 @Test fun cancelAfterIoFinishedBeforeResultDeliveryDeletesOnlyItsUnhandedCopy()=runBlocking {
  val context=InstrumentationRegistry.getInstrumentation().targetContext
  val root=File(context.cacheDir,"PdfReturnQA-"+UUID.randomUUID()).canonicalFile.also{it.mkdirs()}
  val outbound=File(context.cacheDir,"PdfOutbound")
  val before=outbound.listFiles()?.map{it.name}?.toSet()?:emptySet()
  val dispatcher=HeldDispatcher();val scope=CoroutineScope(SupervisorJob()+dispatcher)
  try{
   val source=File(root,"synthetic.pdf");PDDocument().use{it.addPage(PDPage());it.save(source)}
   val repo=PdfRepository(context,File(root,"Research"));val document=repo.importFile(source);val original=File(document.localPath).readBytes()
   val waiting=scope.async{PdfOriginalSnapshot.prepare(context,repo,document,"synthetic-owner") {}}
   dispatcher.take().run() // Caller enters actual production prepare and suspends for IO.
   val completedIoResult=dispatcher.take() // IO has actually returned its resource; caller is not resumed.
   val created=outbound.listFiles().orEmpty().filter{it.name !in before}
   assertEquals("fixture must observe exactly its completed original copy before cancellation",1,created.size)
   assertArrayEquals(original,File(created.single(),"original.pdf").readBytes())
   waiting.cancel();completedIoResult.run()
   assertTrue(waiting.isCancelled);assertTrue(waiting.isCompleted)
   assertArrayEquals(original,File(document.localPath).readBytes())
   assertFalse("IO-return cancellation must reclaim the undelivered unhanded snapshot",created.single().exists())
  }finally{
   scope.cancel()
   // Only our newly observed, strictly UUID-named output folder; never prior caller data.
   outbound.listFiles().orEmpty().filter{it.name !in before&&runCatching{UUID.fromString(it.name).toString()==it.name}.getOrDefault(false)}.forEach{it.deleteRecursively()}
   root.deleteRecursively()
  }
 }
}
