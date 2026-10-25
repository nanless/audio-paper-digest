package com.nanless.paperdigest.data
import com.nanless.paperdigest.cloud.BackupCodec
import org.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.Base64
import java.util.UUID
/** Deliberately assembled valid v2 bytes; never invokes BackupCodec.capture. */
class ConstructedCaptureProvenanceTest {
 @Test fun aPublicConstructedDtoCannotMintANormalCaptureReturnReceipt() {
  val p=Files.createTempDirectory("constructed-capture-provenance-").toRealPath().toFile()
  try {
   val op=UUID.randomUUID().toString();val doc=UUID.randomUUID().toString();val dir=File(p,op).apply{mkdir()};val temp=File(dir,"capture.tmp")
   val personal=JSONObject().put("schema",1).put("notes",JSONObject()).put("settings",JSONObject()).put("favorites",JSONArray()).put("reading",JSONArray()).put("readingState",JSONObject()).put("annotations",JSONObject()).put("sessions",JSONArray()).put("jobs",JSONArray()).toString().toByteArray()
   val raw=JSONObject().put("contract","paperdigest-backup-v2").put("sourceDirectory","/explicit-synthetic/PaperDigest").put("files",JSONArray().put(JSONObject().put("path","personal.json").put("sha256",BackupCodec.hash(personal)).put("data",Base64.getEncoder().encodeToString(personal)))).toString().toByteArray();temp.writeBytes(raw)
   val constructed=BackupCodec.Captured(temp,BackupCodec.hash(raw),raw.size.toLong(),1)
   val producer=ExportProducerReceipt(dir,op,doc,JSONObject().put("format","backup"))
   val outcome=runCatching{producer.recordVerifiedCapture(constructed,"application/octet-stream","synthetic.paperdigest")}
   assertTrue("A parseable arbitrary DTO must not grant normal-return provenance",outcome.isFailure)
   assertFalse(File(dir,"producer-complete.json").exists());assertArrayEquals(raw,temp.readBytes())
  }finally{p.deleteRecursively()}
 }
}
