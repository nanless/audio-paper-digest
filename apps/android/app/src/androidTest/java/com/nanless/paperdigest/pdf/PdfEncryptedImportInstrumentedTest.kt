package com.nanless.paperdigest.pdf

import androidx.test.platform.app.InstrumentationRegistry
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.PDPage
import com.tom_roush.pdfbox.pdmodel.PDPageContentStream
import com.tom_roush.pdfbox.pdmodel.font.PDType1Font
import com.tom_roush.pdfbox.pdmodel.encryption.AccessPermission
import com.tom_roush.pdfbox.pdmodel.encryption.StandardProtectionPolicy
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID

/** Real ciphertext, password checks, physical text/bitmap/coordinates and rollback; no network, secrets or system print job. */
class PdfEncryptedImportInstrumentedTest {
 private class Fixture {
  val context=InstrumentationRegistry.getInstrumentation().targetContext
  val base=File(context.cacheDir,"encrypted-native-"+UUID.randomUUID()).canonicalFile.also{it.mkdirs()}
  val source=File(base,"synthetic-encrypted.pdf")
  val root=File(base,"Research")
  val repo=PdfRepository(context,root)
  init {PDFBoxResourceLoader.init(context)}
  fun make(extract:Boolean=true,print:Boolean=true){
   PDDocument().use{pdf->val page=PDPage();pdf.addPage(page);PDPageContentStream(pdf,page).use{out->out.beginText();out.setFont(PDType1Font.HELVETICA,14f);out.newLineAtOffset(50f,700f);out.showText("Native encrypted original evidence");out.endText()};pdf.protect(StandardProtectionPolicy("synthetic-owner","synthetic-reader",AccessPermission().apply{setCanExtractContent(extract);setCanPrint(print)}).apply{encryptionKeyLength=128});pdf.save(source)}
  }
  fun close(){repo.clearSessionPasswords();base.deleteRecursively()}
 }
 private fun fixture(block:suspend(Fixture)->Unit)=runBlocking {val f=Fixture();try{block(f)}finally{f.close()}}
 @Test fun wrongPasswordKeepsOriginalSessionAndRightPasswordCachesOneUnlock()=fixture{f->
  f.make();val original=f.source.readBytes();val session=f.repo.prepareFileImport(f.source)
  assertTrue(session.passwordRequired)
  val wrong="wrong-synthetic".toCharArray();assertTrue(runCatching{f.repo.finishImport(session,wrong)}.exceptionOrNull() is PdfPasswordRequiredException);assertTrue(wrong.all{it=='\u0000'})
  assertEquals(0,File(f.root,"Imports").listFiles().orEmpty().size)
  val secret="synthetic-reader".toCharArray();val result=f.repo.finishImport(session,secret);assertTrue(secret.all{it=='\u0000'});f.repo.verifyImport(result);f.repo.acceptImport(result);f.repo.finalizeImport(result,true)
  assertArrayEquals(original,File(result.document.localPath).readBytes());assertTrue(f.repo.access(result.document).encrypted)
  assertTrue(f.repo.readPages(result.document).single().text.contains("Native encrypted original evidence"))
  val selected=f.repo.select(result.document,1,0,6);assertEquals(result.document.sha256,selected.documentSHA256);assertTrue(selected.bounds.isNotEmpty())
  val rendered=f.repo.renderPage(result.document,1);try{assertTrue(rendered.bitmap.width>0);assertTrue(rendered.bitmap.height>0);assertTrue(rendered.bitmap.width.toLong()*rendered.bitmap.height<=1010000)}finally{rendered.bitmap.recycle()}
  val snapshot=PdfOriginalSnapshot.prepare(f.context,f.repo,result.document,"synthetic-owner"){}
  try{assertEquals(PdfOriginalPrintReadiness.READY,PdfOriginalPrintAdapter.inspect(snapshot))}finally{snapshot.discard()}
  assertArrayEquals(original,f.source.readBytes())
 }
 @Test fun cancellationOfUnacceptedNewResultDeletesOnlyItsExactCopy()=fixture{f->
  f.make();val bytes=f.source.readBytes();val session=f.repo.prepareFileImport(f.source);val result=f.repo.finishImport(session,"synthetic-reader".toCharArray());val copy=File(result.document.localPath)
  assertTrue(copy.exists());f.repo.cancelImport(session);assertFalse(copy.exists());assertArrayEquals(bytes,f.source.readBytes());assertTrue(runCatching{f.repo.finishImport(session)}.isFailure)
 }
 @Test fun cancellingReuseDoesNotDeleteAlreadyAcceptedOriginal()=fixture{f->
  f.make();val ref=f.repo.importFile(f.source,password="synthetic-reader");val before=File(ref.localPath).readBytes();val session=f.repo.prepareFileImport(f.source);assertFalse(session.passwordRequired);val result=f.repo.finishImport(session)
  f.repo.finalizeImport(result,false);assertArrayEquals(before,File(ref.localPath).readBytes());assertTrue(f.repo.access(ref).encrypted)
 }
 @Test fun rollbackDoesNotDeleteDifferentBytesWrittenToSameInode()=fixture{f->
  f.make();val session=f.repo.prepareFileImport(f.source);val result=f.repo.finishImport(session,"synthetic-reader".toCharArray());val copy=File(result.document.localPath);val unknown="synthetic replacement bytes".toByteArray();copy.writeBytes(unknown)
  assertTrue(runCatching{f.repo.verifyImport(result)}.isFailure);f.repo.finalizeImport(result,false);assertTrue(copy.isFile);assertArrayEquals(unknown,copy.readBytes())
 }
 @Test fun permissionDeniedStillRendersButNeverExtractsOrPrints()=fixture{f->
  f.make(extract=false,print=false);val ref=f.repo.importFile(f.source,password="synthetic-reader");val access=f.repo.access(ref);assertFalse(access.canExtract);assertFalse(access.canPrint)
  assertTrue(runCatching{f.repo.readPages(ref)}.exceptionOrNull() is PdfTextPermissionException)
  assertTrue(runCatching{f.repo.outline(ref)}.exceptionOrNull() is PdfTextPermissionException)
  val image=f.repo.renderPage(ref,1);image.bitmap.recycle()
  val snapshot=PdfOriginalSnapshot.prepare(f.context,f.repo,ref,"synthetic-owner"){}
  try{assertTrue(runCatching{PdfOriginalPrintAdapter.inspect(snapshot)}.exceptionOrNull() is IllegalArgumentException);assertArrayEquals(File(ref.localPath).readBytes(),snapshot.file.readBytes())}finally{snapshot.discard()}
 }
 @Test fun forgettingMemoryRequiresTypedUnlockAgainAndKeepsCiphertext()=fixture{f->
  f.make();val ref=f.repo.importFile(f.source,password="synthetic-reader");val before=File(ref.localPath).readBytes();f.repo.clearSessionPasswords()
  assertTrue(runCatching{f.repo.access(ref)}.exceptionOrNull() is PdfPasswordRequiredException)
  val session=f.repo.prepareFileImport(File(ref.localPath));assertTrue(session.passwordRequired);f.repo.cancelImport(session);assertArrayEquals(before,File(ref.localPath).readBytes())
 }
 @Test fun forgedSessionAndForeignResultCannotAcquireOrDeleteOriginal()=fixture{f->
  f.make();val session=f.repo.prepareFileImport(f.source);val forged=PdfImportSession(session.id,session.displayName,session.sha256,session.passwordRequired)
  assertTrue(runCatching{f.repo.finishImport(forged,"synthetic-reader".toCharArray())}.isFailure)
  val other=PdfRepository(f.context,File(f.base,"OtherResearch"));assertTrue(runCatching{other.finishImport(session,"synthetic-reader".toCharArray())}.isFailure)
  val result=f.repo.finishImport(session,"synthetic-reader".toCharArray());val original=File(result.document.localPath).readBytes();assertTrue(runCatching{other.finalizeImport(result,false)}.isFailure);assertArrayEquals(original,File(result.document.localPath).readBytes());f.repo.finalizeImport(result,false)
 }
 @Test fun verificationDetectsOriginalReplacementBeforePersonalCommit()=fixture{f->
  f.make();val session=f.repo.prepareFileImport(f.source);val result=f.repo.finishImport(session,"synthetic-reader".toCharArray());val original=File(result.document.localPath);assertTrue(original.delete());original.writeText("new inode is not the accepted source")
  assertTrue(runCatching{f.repo.verifyImport(result)}.isFailure);f.repo.finalizeImport(result,false);assertTrue(original.exists());assertEquals("new inode is not the accepted source",original.readText())
 }
}
