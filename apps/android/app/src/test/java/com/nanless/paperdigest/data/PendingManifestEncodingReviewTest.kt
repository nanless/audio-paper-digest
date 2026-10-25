package com.nanless.paperdigest.data
import com.nanless.paperdigest.cloud.BackupCodec
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.UUID
class PendingManifestEncodingReviewTest {
 @Test fun malformedCurrentManifestCannotAliasAValidOriginalUnknownField(){
  val root=Files.createTempDirectory("pending-manifest-independent-").toRealPath().toFile()
  try{
   val exports=File(root,"Exports");val controls=File(root,"Pending");val store=PendingExportStore(exports,controls,{"2026-01-01T00:00:00Z"})
   val p=store.begin(UUID.randomUUID().toString(),"backup",JSONObject().put("owner","synthetic"));val bytes="Original immutable backup".toByteArray();JsonFiles.write(File(exports,"${p.documentID}.bin"),bytes)
   val manifest=File(exports,"${p.documentID}.json");val original=JSONObject().put("documentID",p.documentID).put("mime","application/octet-stream").put("suggestedName","Original.paperdigest").put("bytes",bytes.size).put("sha256",BackupCodec.hash(bytes)).put("unknownOriginalField","\uFFFD")
   JsonFiles.write(manifest,original);store.markReady(p.operationID)
   val valid=manifest.readBytes();val needle=byteArrayOf(0xef.toByte(),0xbf.toByte(),0xbd.toByte());val at=(0..valid.size-3).first{valid[it]==needle[0]&&valid[it+1]==needle[1]&&valid[it+2]==needle[2]}
   val invalid=valid.copyOfRange(0,at)+byteArrayOf(0xff.toByte())+valid.copyOfRange(at+3,valid.size);JsonFiles.write(manifest,invalid)
   assertNotEquals(BackupCodec.hash(valid),BackupCodec.hash(invalid))
   val result=store.get(p.operationID)
   println("OBSERVED_INVALID_UTF8 "+JSONObject().put("preparation",result.preparation).put("ready",result.json().getBoolean("ready")).put("invalidBytesPreserved",manifest.readBytes().contentEquals(invalid)))
   assertFalse("Malformed UTF8 current manifest must not be admitted as equivalent unknown metadata",result.json().getBoolean("ready"))
  }finally{root.deleteRecursively()}
 }
}
