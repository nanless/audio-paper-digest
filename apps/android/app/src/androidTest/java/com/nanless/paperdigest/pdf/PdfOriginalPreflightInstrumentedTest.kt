package com.nanless.paperdigest.pdf

import androidx.test.platform.app.InstrumentationRegistry
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.PDPage
import com.tom_roush.pdfbox.pdmodel.encryption.AccessPermission
import com.tom_roush.pdfbox.pdmodel.encryption.StandardProtectionPolicy
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.async
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID

/** Public helper's actual password/permission preflight; synthetic PDFs, no actual system job. */
class PdfOriginalPreflightInstrumentedTest {
 private fun fixture(encrypted:Boolean,printable:Boolean=true,block:suspend(PdfOriginalSnapshot,ByteArray)->Unit)=runBlocking {
  val context=InstrumentationRegistry.getInstrumentation().targetContext
  val root=File(context.cacheDir,"PdfPreflight-"+UUID.randomUUID()).canonicalFile.also{it.mkdirs()}
  var snapshot:PdfOriginalSnapshot?=null
  try {
   val original=File(root,"synthetic.pdf")
   PDDocument().use{pdf->pdf.addPage(PDPage());if(encrypted)pdf.protect(StandardProtectionPolicy("synthetic-owner","synthetic-reader",AccessPermission().apply{setCanPrint(printable)}).apply{encryptionKeyLength=128});pdf.save(original)}
   val repo=PdfRepository(context,File(root,"Research"));val ref=repo.importFile(original,password=if(encrypted)"synthetic-reader"else null)
   repo.clearSessionPasswords() // This preflight fixture explicitly represents a cold/forgotten unlock.
   val bytes=File(ref.localPath).readBytes();val prepared=PdfOriginalSnapshot.prepare(context,repo,ref,"synthetic-owner"){};snapshot=prepared
   block(prepared,bytes);assertArrayEquals(bytes,File(ref.localPath).readBytes())
  }finally{snapshot?.discard();root.deleteRecursively()}
 }
 @Test fun encryptedOriginalRequiresThisUsePasswordWithoutRewritingOrPinning()=fixture(true){snapshot,original->
  assertEquals(PdfOriginalPrintReadiness.PASSWORD_REQUIRED,PdfOriginalPrintAdapter.inspect(snapshot))
  assertEquals(PdfOriginalPrintReadiness.PASSWORD_REQUIRED,PdfOriginalPrintAdapter.inspect(snapshot,"synthetic-wrong"))
  assertEquals(PdfOriginalPrintReadiness.READY,PdfOriginalPrintAdapter.inspect(snapshot,"synthetic-reader"))
  assertTrue(snapshot.file.isFile);assertArrayEquals(original,snapshot.file.readBytes())
  snapshot.pin();snapshot.discard()
 }
 @Test fun plainOriginalIsReadyAndRestrictedUserPermissionRemainsRefused() {
  fixture(false){snapshot,_->assertEquals(PdfOriginalPrintReadiness.READY,PdfOriginalPrintAdapter.inspect(snapshot))}
  fixture(true,false){snapshot,_->
   val failure=runCatching{PdfOriginalPrintAdapter.inspect(snapshot,"synthetic-reader")}.exceptionOrNull()
   assertTrue(failure is IllegalArgumentException);assertTrue(failure!!.message!!.contains("权限不允许打印"))
  }
 }
 private class ShareBoundaryActivity(context:android.content.Context,private val boundary:(android.content.Intent)->Unit):android.app.Activity(){
  init{attachBaseContext(context)}
  override fun startActivity(intent:android.content.Intent){boundary(intent)}
 }
 @Test fun cancellationAtChooserReturnCannotDiscardAlreadyHandedOffOriginal()=fixture(false){snapshot,original->
  lateinit var awaiting:kotlinx.coroutines.Deferred<String>;var calls=0
  kotlinx.coroutines.supervisorScope {
   val activity=kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main){ShareBoundaryActivity(InstrumentationRegistry.getInstrumentation().targetContext){intent->
    assertEquals(android.content.Intent.ACTION_CHOOSER,intent.action);calls++;awaiting.cancel()
   }}
   awaiting=async(kotlinx.coroutines.Dispatchers.Main){PdfOriginalShare.openChooser(activity,snapshot)}
   runCatching{awaiting.await()}
  }
  assertEquals(1,calls);assertTrue(snapshot.hasBeenHandedOff);assertFalse(snapshot.discardIfUnhanded())
  assertTrue(snapshot.file.isFile);assertArrayEquals(original,snapshot.file.readBytes())
 }
 @Test fun failedChooserRemainsUnhandedAndOnlyItsOwnCopyCanBeDiscarded()=fixture(false){snapshot,_->
  val expected=android.content.ActivityNotFoundException("synthetic chooser unavailable");var calls=0
  val activity=kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main){ShareBoundaryActivity(InstrumentationRegistry.getInstrumentation().targetContext){calls++;throw expected}}
  val failure=runCatching{PdfOriginalShare.openChooser(activity,snapshot)}.exceptionOrNull()
  assertSame(expected,failure);assertEquals(1,calls);assertFalse(snapshot.hasBeenHandedOff)
  assertTrue(snapshot.discardIfUnhanded());assertFalse(snapshot.file.exists())
 }

}
