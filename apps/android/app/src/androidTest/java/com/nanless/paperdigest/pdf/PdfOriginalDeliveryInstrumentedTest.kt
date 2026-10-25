package com.nanless.paperdigest.pdf

import android.content.Intent
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintDocumentInfo
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.test.platform.app.InstrumentationRegistry
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.PDPage
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Production request engine with real PFD/lifecycle/URI permission APIs. Framework callback objects are system-only; actual PrintManager preview remains a separate test. */
class PdfOriginalDeliveryInstrumentedTest {
 private val instrument get()=InstrumentationRegistry.getInstrumentation()
 private val context get()=instrument.targetContext
 private fun fixture(block:suspend(PdfOriginalSnapshot,File)->Unit)=runBlocking {
  val root=File(context.noBackupFilesDir.canonicalFile,"PdfDeliveryQA-"+UUID.randomUUID());check(root.mkdir())
  var snapshot:PdfOriginalSnapshot?=null
  try{val file=File(root,"synthetic.pdf");PDDocument().use{it.addPage(PDPage());it.addPage(PDPage());it.save(file)};val repo=PdfRepository(context,File(root,"Research"));val ref=repo.importFile(file);snapshot=PdfOriginalSnapshot.prepare(context,repo,ref,"fixture-owner"){};block(snapshot,root)}finally{snapshot?.discard();root.deleteRecursively()}
 }
 private fun await(latch:CountDownLatch){assertTrue("A real request must reach exactly one terminal callback",latch.await(20,TimeUnit.SECONDS))}
 @Test fun layoutAndWriteUseActualPageCountOriginalBytesAndSingleCallbacks()=fixture{snapshot,root->
  val layout=CountDownLatch(1);val layouts=AtomicInteger();var info:PrintDocumentInfo?=null;lateinit var adapter:PdfOriginalPrintAdapter
  instrument.runOnMainSync{adapter=PdfOriginalPrintAdapter(snapshot);adapter.requestLayout(null,PrintAttributes.Builder().build(),CancellationSignal()){result->when(result){is PdfLayoutOutcome.Ready->{layouts.incrementAndGet();info=result.info};else->layouts.addAndGet(100)};layout.countDown()}}
  await(layout);assertEquals(1,layouts.get());assertEquals(2,info!!.pageCount)
  val file=File(root,"out.pdf");val signal=CancellationSignal();val written=CountDownLatch(1);val calls=AtomicInteger();var ranges:List<PageRange> = emptyList()
  val fd=ParcelFileDescriptor.open(file,ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE or ParcelFileDescriptor.MODE_READ_WRITE)
  instrument.runOnMainSync{adapter.requestWrite(arrayOf(PageRange.ALL_PAGES),fd,signal){result->when(result){is PdfWriteOutcome.Written->{calls.incrementAndGet();ranges=result.ranges.toList()};PdfWriteOutcome.Cancelled->calls.addAndGet(1000);else->calls.addAndGet(100)};written.countDown()}}
  await(written);assertEquals(1,calls.get());assertEquals(listOf(PageRange(0,1)),ranges);assertArrayEquals(File(snapshot.document.localPath).readBytes(),file.readBytes());instrument.runOnMainSync{adapter.onFinish()}
 }
 @Test fun cancellationAndDestroyAreCancelledRatherThanFalseSuccess()=fixture{snapshot,root->
  class Owner:LifecycleOwner {val registry=LifecycleRegistry(this);override val lifecycle:Lifecycle get()=registry}
  lateinit var adapter:PdfOriginalPrintAdapter;lateinit var owner:Owner
  instrument.runOnMainSync{owner=Owner();owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_CREATE);adapter=PdfOriginalPrintAdapter(snapshot,owner=owner);owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_DESTROY)}
  val latch=CountDownLatch(1);val calls=AtomicInteger();val out=File(root,"cancelled.pdf");val fd=ParcelFileDescriptor.open(out,ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE or ParcelFileDescriptor.MODE_READ_WRITE)
  instrument.runOnMainSync{adapter.requestWrite(arrayOf(PageRange.ALL_PAGES),fd,CancellationSignal().apply{cancel()}){result->when(result){PdfWriteOutcome.Cancelled->calls.incrementAndGet();is PdfWriteOutcome.Written->calls.addAndGet(100);else->calls.addAndGet(1000)};latch.countDown()}}
  await(latch);assertEquals(1,calls.get());assertEquals(0L,out.length());assertTrue(File(snapshot.document.localPath).isFile)
 }
 @Test fun outputIOFailureIsFailedAndDoesNotRewriteOriginal()=fixture{snapshot,root->
  val original=File(snapshot.document.localPath).readBytes();val out=File(root,"read-only.pdf").apply{writeBytes(byteArrayOf(1,2,3))};val fd=ParcelFileDescriptor.open(out,ParcelFileDescriptor.MODE_READ_ONLY);val latch=CountDownLatch(1);val calls=AtomicInteger();lateinit var adapter:PdfOriginalPrintAdapter
  instrument.runOnMainSync{adapter=PdfOriginalPrintAdapter(snapshot);adapter.requestWrite(arrayOf(PageRange.ALL_PAGES),fd,CancellationSignal()){result->when(result){is PdfWriteOutcome.Failed->calls.incrementAndGet();PdfWriteOutcome.Cancelled->calls.addAndGet(1000);else->calls.addAndGet(100)};latch.countDown()}}
  await(latch);assertEquals(1,calls.get());assertArrayEquals(original,File(snapshot.document.localPath).readBytes());instrument.runOnMainSync{adapter.onFinish()}
 }
 @Test fun onePdfURIIsReadOnlyAndGrantDoesNotIncludeAnotherFile()=fixture{snapshot,root->
  val send=PdfOriginalShare.readIntent(context,snapshot);assertEquals(Intent.ACTION_SEND,send.action);assertEquals("application/pdf",send.type);assertEquals(Intent.FLAG_GRANT_READ_URI_PERMISSION,send.flags);assertEquals(1,send.clipData!!.itemCount)
  val uri=send.clipData!!.getItemAt(0).uri;assertEquals(context.packageName+".pdf-originals",uri.authority);assertEquals(3,uri.pathSegments.size)
  val actual=context.contentResolver.openInputStream(uri)!!.use{it.readBytes()};assertArrayEquals(File(snapshot.document.localPath).readBytes(),actual)
  for(mode in listOf("w","rw","rwt","wa"))assertTrue(runCatching{context.contentResolver.openFileDescriptor(uri,mode)?.close()}.exceptionOrNull() is SecurityException)
  assertTrue(runCatching{context.contentResolver.delete(uri,null,null)}.exceptionOrNull() is SecurityException)
  val other=uri.buildUpon().path("/originals/"+UUID.randomUUID()+"/original.pdf").build()
  context.grantUriPermission("com.android.shell",uri,Intent.FLAG_GRANT_READ_URI_PERMISSION)
  try{assertEquals(android.content.pm.PackageManager.PERMISSION_GRANTED,context.checkUriPermission(uri,-1,2000,Intent.FLAG_GRANT_READ_URI_PERMISSION));assertEquals(android.content.pm.PackageManager.PERMISSION_DENIED,context.checkUriPermission(uri,-1,2000,Intent.FLAG_GRANT_WRITE_URI_PERMISSION));assertEquals(android.content.pm.PackageManager.PERMISSION_DENIED,context.checkUriPermission(other,-1,2000,Intent.FLAG_GRANT_READ_URI_PERMISSION))}finally{context.revokeUriPermission(uri,Intent.FLAG_GRANT_READ_URI_PERMISSION)}
  assertTrue(root.isDirectory)
 }
 @Test fun expiredSingleShareCopyIsPrunedWithoutTouchingOriginalOrUnknownFiles()=fixture{snapshot,root->
  val folder=snapshot.file.parentFile!!;assertTrue(folder.setLastModified(System.currentTimeMillis()-25L*60*60*1000))
  val unknown=File(folder.parentFile,UUID.randomUUID().toString()).apply{check(mkdir())};val keep=File(unknown,"unknown.keep").apply{writeText("fixture retained")};assertTrue(unknown.setLastModified(System.currentTimeMillis()-25L*60*60*1000))
  try{val repo=PdfRepository(context,File(root,"Research"));val second=PdfOriginalSnapshot.prepare(context,repo,snapshot.document,"fixture-owner"){}
   try{assertFalse(folder.exists());assertEquals("fixture retained",keep.readText());assertTrue(File(snapshot.document.localPath).isFile)}finally{second.discard()}
  }finally{unknown.deleteRecursively()}
 }
 @Test fun inFlightPrintPinPreventsExpiryUntilFinishAndCannotBeClaimedTwice()=fixture{snapshot,root->
  snapshot.pin();assertTrue(snapshot.file.parentFile!!.setLastModified(System.currentTimeMillis()-25L*60*60*1000))
  assertTrue(runCatching{snapshot.pin()}.isFailure)
  val repo=PdfRepository(context,File(root,"Research"));val second=PdfOriginalSnapshot.prepare(context,repo,snapshot.document,"fixture-owner"){}
  try{assertTrue(snapshot.file.isFile);assertTrue(File(snapshot.document.localPath).isFile)}finally{second.discard()}
 }

}
