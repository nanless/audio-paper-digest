package com.nanless.paperdigest.pdf

import androidx.test.platform.app.InstrumentationRegistry
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.PDPage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.IOException
import java.util.UUID

/** Only complete originals with deterministic structure may be skipped in an import batch. */
class PdfInvalidDocumentInstrumentedTest {
 private class Fixture {
  val context=InstrumentationRegistry.getInstrumentation().targetContext
  val base=File(context.cacheDir,"invalid-pdf-batch-"+UUID.randomUUID()).canonicalFile.also{it.mkdirs()}
  val root=File(base,"Research")
  val repo=PdfRepository(context,root)
  val source=File(base,"source.pdf")
  init{PDFBoxResourceLoader.init(context)}
  fun imports()=File(root,"Imports").listFiles().orEmpty().size
  fun close(){repo.clearSessionPasswords();base.deleteRecursively()}
 }
 private fun fixture(block:suspend(Fixture)->Unit):Unit=runBlocking{val f=Fixture();try{block(f)}finally{f.close()}}
 @Test fun fullyReadNonPdfHeaderIsTypedAndNeverCreatesManagedOriginal()=fixture{f->
  val original="This is an actual non-PDF input, not a parser error message.".toByteArray();f.source.writeBytes(original)
  val error=runCatching{f.repo.prepareFileImport(f.source)}.exceptionOrNull()
  assertTrue(error is PdfInvalidDocumentException);assertEquals(0,f.imports());assertArrayEquals(original,f.source.readBytes())
 }
 @Test fun completeEmptyFileHasTheSameDeterministicMissingHeaderClassification()=fixture{f->
  f.source.writeBytes(byteArrayOf());val error=runCatching{f.repo.prepareFileImport(f.source)}.exceptionOrNull()
  assertTrue(error is PdfInvalidDocumentException);assertEquals(0,f.imports());assertEquals(0,f.source.length())
 }
 @Test fun successfulParserWithZeroPhysicalPagesIsTypedAndOriginalUnchanged()=fixture{f->
  PDDocument().use{it.save(f.source)};val original=f.source.readBytes()
  PDDocument.load(f.source).use{assertEquals("Structural precondition: actual parser succeeds",0,it.numberOfPages)}
  assertTrue(runCatching{f.repo.prepareFileImport(f.source)}.exceptionOrNull() is PdfInvalidDocumentException)
  assertEquals(0,f.imports());assertArrayEquals(original,f.source.readBytes())
 }
 @Test fun malformedFileWithRealPdfHeaderStaysGeneralIoFailureAndStopsBatch()=fixture{f->
  val original="%PDF-1.7\nThis file has a real header but no parsable body or trailer.\n".toByteArray();f.source.writeBytes(original)
  val error=runCatching{f.repo.prepareFileImport(f.source)}.exceptionOrNull()
  assertTrue(error is IOException);assertFalse(error is PdfInvalidDocumentException)
  assertEquals(0,f.imports());assertArrayEquals(original,f.source.readBytes())
 }
 @Test fun validFileAcceptedByParserIsStillAcceptedWithItsOriginalBytes()=fixture{f->
  PDDocument().use{pdf->pdf.addPage(PDPage());pdf.save(f.source)};val original=f.source.readBytes()
  PDDocument.load(f.source).use{assertEquals(1,it.numberOfPages)}
  val session=f.repo.prepareFileImport(f.source);val result=f.repo.finishImport(session)
  try{f.repo.verifyImport(result);assertArrayEquals(original,File(result.document.localPath).readBytes());assertEquals(1,result.document.pageCount)}finally{f.repo.finalizeImport(result,false)}
  assertArrayEquals(original,f.source.readBytes())
 }
 @Test fun acceptedLongPreambleKeepsParserCompatibilityAndOriginalBytes()=fixture{f->
  PDDocument().use{pdf->pdf.addPage(PDPage());pdf.save(f.source)}
  val bytes=f.source.readBytes();val prefix=(" ".repeat(2048)+"\n").toByteArray();f.source.writeBytes(prefix+bytes);val original=f.source.readBytes()
  PDDocument.load(f.source).use{assertEquals("Actual PDFBox lenient-parser precondition",1,it.numberOfPages)}
  val session=f.repo.prepareFileImport(f.source);val result=f.repo.finishImport(session)
  try{f.repo.verifyImport(result);assertArrayEquals(original,File(result.document.localPath).readBytes())}finally{f.repo.finalizeImport(result,false)}
  assertArrayEquals(original,f.source.readBytes())
 }
 @Test fun wrongExpectedSourceShaIsNotReclassifiedAsSkippableBadPdf()=fixture{f->
  f.source.writeText("not a PDF");val original=f.source.readBytes()
  val error=runCatching{f.repo.prepareFileImport(f.source,expectedSHA="0".repeat(64))}.exceptionOrNull()
  assertNotNull(error);assertFalse(error is PdfInvalidDocumentException);assertEquals(0,f.imports());assertArrayEquals(original,f.source.readBytes())
 }
 @Test fun sourceGuardCancellationIsNotReclassifiedOrConsumed()=fixture{f->
  f.source.writeText("not a PDF");val original=f.source.readBytes();val sentinel=CancellationException("synthetic source retirement")
  val error=runCatching{f.repo.prepareFileImport(f.source,check={throw sentinel})}.exceptionOrNull()
  assertSame(sentinel,error);assertEquals(0,f.imports());assertArrayEquals(original,f.source.readBytes())
 }
 @Test fun unavailableSourceFileIsNotContinuableStructuralInvalidity()=fixture{f->
  assertFalse(f.source.exists());val error=runCatching{f.repo.prepareFileImport(f.source)}.exceptionOrNull()
  assertNotNull(error);assertFalse(error is PdfInvalidDocumentException);assertFalse(f.source.exists());assertEquals(0,f.imports())
 }
}
