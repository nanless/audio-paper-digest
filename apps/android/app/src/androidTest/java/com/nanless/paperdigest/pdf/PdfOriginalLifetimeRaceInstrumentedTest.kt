package com.nanless.paperdigest.pdf

import android.content.ContextWrapper
import android.net.Uri
import androidx.test.platform.app.InstrumentationRegistry
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.PDPage
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Public ContextWrapper barrier; no production test hooks, actual Binder data or real user files. */
class PdfOriginalLifetimeRaceInstrumentedTest {
 @Test fun pinDuringExpiredRevocationMustNotAcquireADeletedPrintCopy()=runBlocking {
  val context=InstrumentationRegistry.getInstrumentation().targetContext
  val root=File(context.noBackupFilesDir.canonicalFile,"PdfLifetimeQA-"+UUID.randomUUID());check(root.mkdir())
  var first:PdfOriginalSnapshot?=null;var second:PdfOriginalSnapshot?=null
  val entered=CountDownLatch(1);val release=CountDownLatch(1);var pinThread:Thread?=null
  try {
   val file=File(root,"fixture.pdf");PDDocument().use{it.addPage(PDPage());it.save(file)}
   val repo=PdfRepository(context,File(root,"Research"));val ref=repo.importFile(file);val original=file.readBytes()
   val snapshot=PdfOriginalSnapshot.prepare(context,repo,ref,"fixture-owner"){};first=snapshot
   assertTrue(snapshot.file.parentFile!!.setLastModified(System.currentTimeMillis()-25L*60*60*1000))
   val wrapped=object:ContextWrapper(context){override fun revokeUriPermission(uri:Uri,modeFlags:Int){if(uri.pathSegments.getOrNull(1)==snapshot.file.parentFile!!.name){entered.countDown();check(release.await(10,TimeUnit.SECONDS))};super.revokeUriPermission(uri,modeFlags)}}
   val preparing=async(Dispatchers.IO){PdfOriginalSnapshot.prepare(wrapped,repo,ref,"fixture-owner"){} }
   assertTrue("Prune must have passed its expiry decision before the attempted pin",entered.await(10,TimeUnit.SECONDS))
   val pinSucceeded=AtomicBoolean();val attempted=CountDownLatch(1);val finished=CountDownLatch(1)
   pinThread=Thread{attempted.countDown();try{snapshot.pin();pinSucceeded.set(true)}catch(_:IllegalStateException){}catch(_:IllegalArgumentException){}finally{finished.countDown()}}.apply{start()}
   assertTrue(attempted.await(10,TimeUnit.SECONDS));finished.await(250,TimeUnit.MILLISECONDS);release.countDown()
   second=preparing.await();pinThread.join(10000);assertFalse(pinThread.isAlive)
   assertFalse("A pin must be rejected once expiry has reserved this copy; otherwise cleanup deletes an in-flight print",pinSucceeded.get())
   assertFalse(snapshot.file.exists());assertArrayEquals(original,file.readBytes());assertTrue(File(ref.localPath).isFile)
  }finally{release.countDown();pinThread?.join(10000);second?.discard();first?.discard();root.deleteRecursively()}
 }
}
