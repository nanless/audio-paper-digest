package com.nanless.paperdigest.data

import androidx.test.platform.app.InstrumentationRegistry
import com.nanless.paperdigest.cloud.BackupCodec
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.UUID
import java.util.concurrent.CancellationException

/** Synthetic own temporary files only; default Android NIO/fileKey/CREATE_NEW publication and capture codec. */
class ExportProducerPlatformInstrumentedTest {
 private fun fixture(body:(File,File,String,String,ExportProducerReceipt)->Unit) {
  val p=Files.createTempDirectory(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir.toPath(),"producer-platform-").toRealPath().toFile()
  try {
   val research=File(p,"Research").apply{mkdir()}
   File(research,"personal.json").writeText(JSONObject().put("schema",1).put("notes",JSONObject()).put("settings",JSONObject()).put("favorites",JSONArray()).put("reading",JSONArray()).put("readingState",JSONObject()).put("annotations",JSONObject()).put("sessions",JSONArray()).put("jobs",JSONArray()).toString())
   File(research,"opaque-original").writeBytes(ByteArray(130001){(it%251).toByte()})
   val op=UUID.randomUUID().toString();val doc=UUID.randomUUID().toString();val directory=File(p,op).apply{mkdir()};val producer=ExportProducerReceipt(directory,op,doc,JSONObject().put("format","backup"))
   body(p,research,op,doc,producer)
  }finally{p.deleteRecursively()}
 }
 @Test fun realAndroidCompletionProofSurvivesImmediateCancellationThenRegistersSameOriginal()=fixture{p,research,op,doc,producer->
  val capture=BackupCodec.capture(research,File(p,"$op/capture.tmp"));val originalPersonal=File(research,"personal.json").readBytes()
  assertTrue(runCatching{producer.recordVerifiedCapture(capture,"application/octet-stream","synthetic.paperdigest"){throw CancellationException()}}.exceptionOrNull() is CancellationException)
  val cold=ExportProducerReceipt(File(p,op),op,doc,JSONObject().put("format","backup"));assertTrue(cold.hasCompletionMaterials());val complete=cold.verifiedCapture()
  val writer=ExportArtifactWriter(File(p,"Exports"));val ready=writer.completed(complete.file,complete.mime,complete.name,doc,complete.sha256,complete.bytes)
  assertEquals(doc,ready.id);assertEquals(capture.sha256,ready.sha256);assertArrayEquals(capture.file.readBytes(),ready.file.readBytes());assertArrayEquals(originalPersonal,File(research,"personal.json").readBytes())
 }
 @Test fun realAndroidMutationAfterQualificationPublishesNoDifferentReadyArtifact()=fixture{p,research,op,doc,producer->
  val capture=BackupCodec.capture(research,File(p,"$op/capture.tmp"));val complete=producer.recordVerifiedCapture(capture,"application/octet-stream","synthetic.paperdigest");val proof=File(p,"$op/producer-complete.json").readBytes();var changed=false
  val directory=File(p,"Exports");val writer=ExportArtifactWriter(directory)
  assertTrue(runCatching{writer.completed(complete.file,complete.mime,complete.name,doc,complete.sha256,complete.bytes){if(!changed){changed=true;complete.file.appendText("synthetic-change")}}}.isFailure)
  assertFalse(File(directory,"$doc.bin").exists());assertFalse(File(directory,"$doc.json").exists());assertTrue(complete.file.isFile);assertArrayEquals(proof,File(p,"$op/producer-complete.json").readBytes())
 }
 @Test fun realAndroidDataClassCopyIsNotTheNormalCaptureReturnInstance()=fixture{p,research,op,doc,producer->
  val actual=BackupCodec.capture(research,File(p,"$op/capture.tmp"));val copied=actual.copy();assertEquals(actual,copied);assertFalse(actual===copied)
  assertTrue(runCatching{producer.recordVerifiedCapture(copied,"application/octet-stream","synthetic.paperdigest")}.isFailure)
  assertFalse(producer.hasCompletionMaterials());assertFalse(File(p,"$op/producer-complete.json").exists())
  assertEquals(actual.sha256,producer.recordVerifiedCapture(actual,"application/octet-stream","synthetic.paperdigest").sha256)
 }

 @Test fun realAndroidCancellationDuringCopyClearsOnlyItsPartialAndPreservesCaptureAndUnknownFiles()=fixture{p,_,_,_,_->
  val source=File(p,"capture.tmp").apply{writeBytes(ByteArray(210005){(it%251).toByte()})};val original=source.readBytes()
  val dir=File(p,"Exports");val writer=ExportArtifactWriter(dir);val unknown=File(dir,"unknown.bin").apply{writeText("keep unrelated")};val id=UUID.randomUUID().toString();var during=false
  val error=runCatching{writer.register(source,"application/octet-stream","original.bin",id){val f=File(dir,"$id.bin");if(f.isFile&&f.length() in 1 until original.size.toLong()){during=true;throw CancellationException("controlled mid-copy")}}}.exceptionOrNull()
  assertTrue(during);assertTrue(error is CancellationException);assertFalse(File(dir,"$id.bin").exists());assertFalse(File(dir,"$id.json").exists());assertArrayEquals(original,source.readBytes());assertEquals("keep unrelated",unknown.readText())
 }
 @Test fun realAndroidPreexistingCrashPartialIsRejectedAndNeverAdoptedOrOverwritten()=fixture{p,_,_,_,_->
  val source=File(p,"capture.tmp").apply{writeBytes(ByteArray(140001){(it%239).toByte()})};val original=source.readBytes();val dir=File(p,"Exports");val writer=ExportArtifactWriter(dir);val id=UUID.randomUUID().toString();val partial=File(dir,"$id.bin").apply{writeBytes(original.copyOf(100))};val before=partial.readBytes()
  repeat(2){assertTrue(runCatching{writer.register(source,"application/octet-stream","original.bin",id)}.isFailure);assertArrayEquals(before,partial.readBytes());assertFalse(File(dir,"$id.json").exists());assertArrayEquals(original,source.readBytes())}
 }
 @Test fun realAndroidCallbackReplacementTargetIsNeverDeletedByFailedCopyCleanup()=fixture{p,_,_,_,_->
  val source=File(p,"capture.tmp").apply{writeBytes(ByteArray(140003){(it%241).toByte()})};val original=source.readBytes();val dir=File(p,"Exports");val writer=ExportArtifactWriter(dir);val id=UUID.randomUUID().toString();val target=File(dir,"$id.bin");var replaced=false
  val error=runCatching{writer.register(source,"application/octet-stream","original.bin",id){if(target.exists()&&!replaced){Files.move(target.toPath(),File(dir,"retained-own-partial").toPath());target.writeText("replacement must survive");replaced=true;throw CancellationException("controlled replacement")}}}.exceptionOrNull()
  assertTrue(replaced);assertTrue(error is CancellationException);assertEquals("replacement must survive",target.readText());assertFalse(File(dir,"$id.json").exists());assertArrayEquals(original,source.readBytes())
 }

}
