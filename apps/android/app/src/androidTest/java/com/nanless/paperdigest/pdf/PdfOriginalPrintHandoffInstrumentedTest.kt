package com.nanless.paperdigest.pdf

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
import java.io.IOException
import java.util.UUID

/** The exact production submission path, synthetic null/throw from system boundary; no PrintJob forged or submitted. */
class PdfOriginalPrintHandoffInstrumentedTest {
 private class Owner:LifecycleOwner{val registry=LifecycleRegistry(this);override val lifecycle:Lifecycle get()=registry}
 private fun fixture(block:(PdfOriginalSnapshot,ByteArray,Owner)->Unit)=runBlocking {
  val instrument=InstrumentationRegistry.getInstrumentation();val context=instrument.targetContext
  val root=File(context.noBackupFilesDir.canonicalFile,"PdfHandoffQA-"+UUID.randomUUID());check(root.mkdir());var snapshot:PdfOriginalSnapshot?=null
  try{
   val file=File(root,"fixture.pdf");PDDocument().use{it.addPage(PDPage());it.save(file)};val repo=PdfRepository(context,File(root,"Research"));val ref=repo.importFile(file)
   val prepared=PdfOriginalSnapshot.prepare(context,repo,ref,"fixture-owner"){};snapshot=prepared;val original=File(ref.localPath).readBytes()
   instrument.runOnMainSync{val owner=Owner();owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_CREATE);block(prepared,original,owner);assertEquals("Failed system submission must unregister its exact Activity lifecycle observer",0,owner.registry.observerCount);owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_DESTROY)}
  }finally{snapshot?.discard();root.deleteRecursively()}
 }
 @Test fun nullSystemJobCannotReportOpenedPreviewAndReleasesOnlyItsOwnOutput()=fixture{snapshot,original,owner->
  var attempted=0;var returnedNormally=false
  val error=runCatching{PdfOriginalPrintAdapter.submitToSystem(snapshot,owner=owner){adapter->assertNotNull(adapter);attempted++;null};returnedNormally=true}.exceptionOrNull()
  assertEquals(1,attempted);assertFalse(returnedNormally);assertTrue(error is IllegalStateException);assertTrue(error!!.message!!.contains("系统未能打开打印预览"));assertFalse(snapshot.file.exists());assertArrayEquals(original,File(snapshot.document.localPath).readBytes())
 }
 @Test fun thrownSystemFailureKeepsItsActualErrorAndReleasesOnlyItsOwnOutput()=fixture{snapshot,original,owner->
  val expected=IOException("synthetic print service failure");var attempted=0;var returnedNormally=false
  val error=runCatching{PdfOriginalPrintAdapter.submitToSystem(snapshot,owner=owner){attempted++;throw expected};returnedNormally=true}.exceptionOrNull()
  assertEquals(1,attempted);assertFalse(returnedNormally);assertSame(expected,error);assertFalse(snapshot.file.exists());assertArrayEquals(original,File(snapshot.document.localPath).readBytes())
 }
}
