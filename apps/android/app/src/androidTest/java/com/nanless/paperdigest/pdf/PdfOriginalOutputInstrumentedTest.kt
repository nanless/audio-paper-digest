package com.nanless.paperdigest.pdf

import androidx.test.platform.app.InstrumentationRegistry
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.PDPage
import com.tom_roush.pdfbox.pdmodel.PDPageContentStream
import com.tom_roush.pdfbox.pdmodel.common.PDRectangle
import com.tom_roush.pdfbox.pdmodel.font.PDType1Font
import com.tom_roush.pdfbox.pdmodel.encryption.AccessPermission
import com.tom_roush.pdfbox.pdmodel.encryption.StandardProtectionPolicy
import com.tom_roush.pdfbox.text.PDFTextStripper
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID
import java.util.concurrent.CancellationException

/** Only synthetic private test PDFs. Does not open a chooser, print UI or physical print job. */
class PdfOriginalOutputInstrumentedTest {
 private val context get()=InstrumentationRegistry.getInstrumentation().targetContext
 private fun source(file:File,encrypted:Boolean=false,printable:Boolean=true){
  PDDocument().use{pdf->
   for(index in 0..2){
    val page=PDPage(PDRectangle(300f+index,400f+index));pdf.addPage(page);page.cropBox=PDRectangle(10f,20f,250f,350f);page.rotation=index*90
    PDPageContentStream(pdf,page).use{it.beginText();it.setFont(PDType1Font.HELVETICA,12f);it.newLineAtOffset(20f,40f);it.showText("Original page "+(index+1));it.endText()}
   }
   val inherited=pdf.getPage(0).resources;pdf.pages.cosObject.setItem(com.tom_roush.pdfbox.cos.COSName.RESOURCES,inherited);for(page in pdf.pages)page.cosObject.removeItem(com.tom_roush.pdfbox.cos.COSName.RESOURCES)
   if(encrypted){val permission=AccessPermission().apply{setCanPrint(printable)};pdf.protect(StandardProtectionPolicy("owner-secret","user-secret",permission).apply{encryptionKeyLength=128})}
   pdf.save(file)
  }
 }
 private fun fixture(block:suspend (PdfRepository,PdfDocumentRef,File)->Unit)=runBlocking {
  PDFBoxResourceLoader.init(context);val root=File(context.noBackupFilesDir.canonicalFile,"PdfOutputQA-"+UUID.randomUUID());check(root.mkdir())
  try{val input=File(root,"source.pdf");source(input);val repo=PdfRepository(context,File(root,"Research"));val ref=repo.importFile(input);block(repo,ref,root)}finally{root.deleteRecursively()}
 }
 @Test fun allPagesAreExactlyTheOriginalBytesAndDoNotRewriteResearch()=fixture{repo,ref,root->
  val original=File(ref.localPath).readBytes();val snapshot=PdfOriginalSnapshot.prepare(context,repo,ref,"fixture-owner"){}
  try{val out=PdfOriginalWriter.write(snapshot,listOf(PdfOutputRange(0,Int.MAX_VALUE)),root);try{assertTrue(out.exactOriginalBytes);assertArrayEquals(original,out.file.readBytes());assertArrayEquals(original,File(ref.localPath).readBytes());assertEquals(listOf(PdfOutputRange(0,2)),out.originalRanges)}finally{out.file.delete()}}finally{snapshot.discard()}
 }
 @Test fun selectedPagesKeepVectorTextResourcesCropAndRotationAndReportOriginalIndices()=fixture{repo,ref,root->
  val snapshot=PdfOriginalSnapshot.prepare(context,repo,ref,"fixture-owner"){}
  try{val out=PdfOriginalWriter.write(snapshot,listOf(PdfOutputRange(2,2),PdfOutputRange(0,0)),root);try{
   assertFalse(out.exactOriginalBytes);assertEquals(listOf(PdfOutputRange(0,0),PdfOutputRange(2,2)),out.originalRanges)
   PDDocument.load(out.file).use{pdf->assertEquals(2,pdf.numberOfPages);val text=PDFTextStripper().getText(pdf);assertTrue(text.contains("Original page 1"));assertTrue(text.contains("Original page 3"));assertFalse(text.contains("Original page 2"));assertEquals(180,pdf.getPage(1).rotation);assertEquals(10f,pdf.getPage(1).cropBox.lowerLeftX,0f);assertEquals(20f,pdf.getPage(1).cropBox.lowerLeftY,0f);assertNotNull(pdf.getPage(1).resources);assertTrue(pdf.getPage(1).resources.fontNames.iterator().hasNext())}
  }finally{out.file.delete()}}finally{snapshot.discard()}
 }
 @Test fun switchedOwnerAndChangedOriginalCannotBePrintedAsTheCurrentDocument()=fixture{repo,ref,root->
  var valid=true;val snapshot=PdfOriginalSnapshot.prepare(context,repo,ref,"fixture-owner"){check(valid)}
  try{valid=false;assertTrue(runCatching{PdfOriginalWriter.write(snapshot,listOf(PdfOutputRange(0,0)),root)}.isFailure);valid=true;val file=File(ref.localPath);val old=file.readBytes();file.appendBytes(byteArrayOf(32));assertTrue(runCatching{PdfOriginalWriter.write(snapshot,listOf(PdfOutputRange(0,0)),root)}.isFailure);assertArrayEquals(old+byteArrayOf(32),file.readBytes())}finally{snapshot.discard()}
 }
 @Test fun cancelledWriteRemovesOnlyItsStagingAndPreservesTheOriginal()=fixture{repo,ref,root->
  val original=File(ref.localPath).readBytes();val snapshot=PdfOriginalSnapshot.prepare(context,repo,ref,"fixture-owner"){}
  try{var checks=0;val error=runCatching{PdfOriginalWriter.write(snapshot,listOf(PdfOutputRange(0,1)),root){if(++checks>8)throw CancellationException("fixture cancel")}}.exceptionOrNull();assertTrue(error is CancellationException);assertTrue(root.listFiles()!!.none{it.name.startsWith(".print-")});assertArrayEquals(original,File(ref.localPath).readBytes())}finally{snapshot.discard()}
 }
 @Test fun wrongPasswordCannotBecomeSuccessfulOutputAndCorrectPasswordDoesNotRewriteEncryption()=runBlocking{
  PDFBoxResourceLoader.init(context);val root=File(context.noBackupFilesDir.canonicalFile,"PdfOutputQA-"+UUID.randomUUID());check(root.mkdir())
  try{val input=File(root,"encrypted.pdf");source(input,true);val repo=PdfRepository(context,File(root,"Research"));val ref=repo.importFile(input,password="user-secret");val original=File(ref.localPath).readBytes();val snapshot=PdfOriginalSnapshot.prepare(context,repo,ref,"fixture-owner"){}
   try{assertTrue(runCatching{PdfOriginalWriter.write(snapshot,listOf(PdfOutputRange(0,0)),root,"wrong-password")}.isFailure);val out=PdfOriginalWriter.write(snapshot,listOf(PdfOutputRange(0,Int.MAX_VALUE)),root,"user-secret");try{assertFalse(out.exactOriginalBytes);PDDocument.load(out.file).use{assertEquals(3,it.numberOfPages);assertFalse(it.isEncrypted)}}finally{out.file.delete()};assertArrayEquals(original,File(ref.localPath).readBytes())}finally{snapshot.discard()}
  }finally{root.deleteRecursively()}
 }
 @Test fun userPrintRestrictionIsRespectedWithoutChangingTheOriginal()=runBlocking{
  PDFBoxResourceLoader.init(context);val root=File(context.noBackupFilesDir.canonicalFile,"PdfOutputQA-"+UUID.randomUUID());check(root.mkdir())
  try{val input=File(root,"restricted.pdf");source(input,true,false);val repo=PdfRepository(context,File(root,"Research"));val ref=repo.importFile(input,password="user-secret");val original=File(ref.localPath).readBytes();val snapshot=PdfOriginalSnapshot.prepare(context,repo,ref,"fixture-owner"){}
   try{assertTrue(runCatching{PdfOriginalWriter.write(snapshot,listOf(PdfOutputRange(0,0)),root,"user-secret")}.isFailure);assertTrue(root.listFiles()!!.none{it.name.startsWith(".print-")});assertArrayEquals(original,File(ref.localPath).readBytes())}finally{snapshot.discard()}
  }finally{root.deleteRecursively()}
 }

}
