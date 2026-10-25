package com.nanless.paperdigest.cloud
import com.nanless.paperdigest.secret.SecretStore
import kotlinx.coroutines.*
import org.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.UUID
class CloudRestoreCancellationTest {
 private fun personal()=JSONObject().put("schema",1).put("notes",JSONObject()).put("settings",JSONObject()).put("favorites",JSONArray()).put("reading",JSONArray()).put("readingState",JSONObject()).put("annotations",JSONObject()).put("sessions",JSONArray()).put("jobs",JSONArray())
 private fun fixture(body:suspend(File,File,CloudService,CloudReference,MutableList<String>)->Unit)=runBlocking{
  val p=Files.createTempDirectory("cloud-stage-cancel-").toRealPath().toFile();try {
   val root=File(p,"Research").apply{mkdir()};File(root,"personal.json").writeText(personal().toString());File(root,"opaque").writeBytes(ByteArray(250001){(it%251).toByte()});val snapshot=BackupCodec.capture(root,File(p,"original.paperdigest"));val raw=snapshot.file.readBytes();val ref=CloudReference("2026-01",UUID.randomUUID().toString());val manifest=CloudManifest(ref,1767225600000,raw.size.toLong(),BackupCodec.hash(raw),listOf(CloudChunk(0,raw.size,BackupCodec.hash(raw))));val requests=mutableListOf<String>()
   val transport=CloudTransport{request,_->requests+=request.method;CloudHTTP(200,emptyMap(),if(request.url.encodedPath.endsWith("manifest.json"))manifest.json().toString().toByteArray()else raw)}
   val secrets=object:SecretStore{override fun load(scope:String)="explicit-synthetic-fixture";override fun save(scope:String,secret:String){};override fun remove(scope:String){}}
   val service=CloudService(root,File(p,"Control"),secrets,object:CloudWorkspace{override suspend fun capture(output:File):BackupCodec.Captured=error("No new capture");override suspend fun restore(staged:BackupCodec.Staged){error("No implicit install")}},transport,now={1767225600000},sleep={})
   service.save("fixture@example.invalid","PaperDigest",false,24);body(p,root,service,ref,requests)
  }finally{p.deleteRecursively()}
 }
 @Test fun stagedDownloadHasRealChunkChecksAndCallerCancellationPreservesLiveAndCleansOnlyOwnStage()=fixture{p,root,service,ref,requests->val before=root.walkTopDown().filter{it.isFile}.associate{it.name to BackupCodec.hash(it)};var checks=0;assertTrue(runCatching{service.prepareRestore(ref){if(++checks==8)throw CancellationException("synthetic")}}.exceptionOrNull() is CancellationException);assertEquals(listOf("GET","GET"),requests);assertEquals(before,root.walkTopDown().filter{it.isFile}.associate{it.name to BackupCodec.hash(it)});assertFalse(p.listFiles()!!.any{it.name.startsWith(".paperdigest-restore-")});assertFalse(File(p,"Control").listFiles()!!.any{it.name.startsWith("download-")});assertFalse(service.state().getBoolean("busy"))}
 @Test fun preparedRestoreReturnsSameOriginalBytesAndNoImplicitInstall()=fixture{p,root,service,ref,requests->val result=service.prepareRestore(ref);try{assertEquals(ref,result.manifest.reference);assertEquals(2,result.staged.entries.size);assertEquals(result.manifest.sha256,result.staged.encodedSHA256);assertArrayEquals(File(root,"opaque").readBytes(),File(result.staged.directory,"opaque").readBytes());assertEquals(listOf("GET","GET"),requests)}finally{result.staged.directory.deleteRecursively()}}
}
