package com.nanless.paperdigest.data
import com.nanless.paperdigest.cloud.BackupCodec
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.UUID
import java.util.concurrent.CancellationException
class ExportArtifactCreateOnlyTest {
 private fun temp(body:(File)->Unit){val p=Files.createTempDirectory("create-only-copy-").toRealPath().toFile();try{body(p)}finally{p.deleteRecursively()}}
 @Test fun cancellationDuringCopyClearsOnlyItsPartialAndPreservesCaptureAndUnknownFiles()=temp{p->
  val source=File(p,"capture.tmp").apply{writeBytes(ByteArray(210005){(it%251).toByte()})};val original=source.readBytes()
  val dir=File(p,"Exports");val writer=ExportArtifactWriter(dir);val unknown=File(dir,"unknown.bin").apply{writeText("keep unrelated")};val id=UUID.randomUUID().toString();var during=false
  val error=runCatching{writer.register(source,"application/octet-stream","original.bin",id){val f=File(dir,"$id.bin");if(f.isFile&&f.length() in 1 until original.size.toLong()){during=true;throw CancellationException("controlled mid-copy")}}}.exceptionOrNull()
  assertTrue(during);assertTrue(error is CancellationException);assertFalse(File(dir,"$id.bin").exists());assertFalse(File(dir,"$id.json").exists());assertArrayEquals(original,source.readBytes());assertEquals("keep unrelated",unknown.readText())
 }
 @Test fun preexistingCrashPartialIsRejectedAndNeverAdoptedOrOverwritten()=temp{p->
  val source=File(p,"capture.tmp").apply{writeBytes(ByteArray(140001){(it%239).toByte()})};val original=source.readBytes();val dir=File(p,"Exports");val writer=ExportArtifactWriter(dir);val id=UUID.randomUUID().toString();val partial=File(dir,"$id.bin").apply{writeBytes(original.copyOf(100))};val before=partial.readBytes()
  repeat(2){assertTrue(runCatching{writer.register(source,"application/octet-stream","original.bin",id)}.isFailure);assertArrayEquals(before,partial.readBytes());assertFalse(File(dir,"$id.json").exists());assertArrayEquals(original,source.readBytes())}
 }
 @Test fun callbackReplacementTargetIsNeverDeletedByFailedCopyCleanup()=temp{p->
  val source=File(p,"capture.tmp").apply{writeBytes(ByteArray(140003){(it%241).toByte()})};val original=source.readBytes();val dir=File(p,"Exports");val writer=ExportArtifactWriter(dir);val id=UUID.randomUUID().toString();val target=File(dir,"$id.bin");var replaced=false
  val error=runCatching{writer.register(source,"application/octet-stream","original.bin",id){if(target.exists()&&!replaced){Files.move(target.toPath(),File(dir,"retained-own-partial").toPath());target.writeText("replacement must survive");replaced=true;throw CancellationException("controlled replacement")}}}.exceptionOrNull()
  assertTrue(replaced);assertTrue(error is CancellationException);assertEquals("replacement must survive",target.readText());assertFalse(File(dir,"$id.json").exists());assertArrayEquals(original,source.readBytes())
 }
}
