package com.nanless.paperdigest.cloud

import com.nanless.paperdigest.secret.SecretStore
import kotlinx.coroutines.runBlocking
import okhttp3.Request
import okio.Buffer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption.ATOMIC_MOVE

/** Synthetic local data only. FakeDAV never opens sockets or reads actual credentials. */
class CloudFinalReceiptTest {
 private val now=1767225600000L
 private val oldID="synthetic-old-issued-request"
 private fun personal()=JSONObject().put("schema",1).put("notes",JSONObject().put("synthetic-paper",JSONObject().put("text","Synthetic retained note").put("revision",1))).put("favorites",JSONArray()).put("reading",JSONArray()).put("readingState",JSONObject()).put("annotations",JSONObject()).put("sessions",JSONArray().put(JSONObject().put("id",oldID).put("startedAt","2026-01-01T00:00:00Z").put("requestIssued",true).put("status","complete"))).put("jobs",JSONArray()).put("settings",JSONObject().put("endpoint","https://synthetic.invalid/v1").put("model","synthetic-model").put("dailyRequests",5))
 private fun root(parent:File):File=File(parent,"Research").apply {
  check(mkdir());BackupCodec.atomicJSON(File(this,"personal.json"),personal())
  BackupCodec.atomicJSON(File(this,RequestContinuity.FILE),RequestContinuity.json(listOf(RequestContinuity.Issued(oldID,"2026-01-01T00:00:00Z"))))
  File(this,"ModelUsage").mkdir();File(this,"ModelUsage/synthetic.response.json").writeText("{\"synthetic\":true,\"preserve\":\"original response\"}")
  File(this,"Proofs").mkdir();File(this,"Proofs/previous.json").writeText("{\"kind\":\"synthetic-old-proof\"}")
 }
 private fun facts(root:File)=root.walkTopDown().filter{it.isFile}.associate{it.relativeTo(root).invariantSeparatorsPath to BackupCodec.hash(it)}
 private suspend fun fixture(body:suspend(File,File)->Unit){val p=Files.createTempDirectory("cloud-final-receipt23-").toFile();try{body(p,root(p))}finally{p.deleteRecursively()}}
 private class SyntheticSecrets:SecretStore {override fun save(scope:String,secret:String)=Unit;override fun remove(scope:String)=Unit;override fun load(scope:String)="synthetic-not-a-real-secret"}
 private class FakeDAV:CloudTransport {
  val files=linkedMapOf<String,ByteArray>();val directories=hashSetOf("/dav/");val requests=arrayListOf<Pair<String,String>>()
  var afterManifestGet:(()->Unit)?=null
  var successfulManifestGets=0
  private fun listing(path:String)= ("<d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>$path</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>").toByteArray()
  override suspend fun execute(request:Request,limit:Int):CloudHTTP {
   val p=request.url.encodedPath;requests+=request.method to p
   return when(request.method){
    "MKCOL"->CloudHTTP(if(directories.add(p))201 else 405,emptyMap(),byteArrayOf())
    "PROPFIND"->if(p in directories)CloudHTTP(207,emptyMap(),listing(p))else CloudHTTP(404,emptyMap(),byteArrayOf())
    "PUT"->{val b=Buffer();request.body!!.writeTo(b);val old=files.putIfAbsent(p,b.readByteArray());CloudHTTP(if(old==null)201 else 412,emptyMap(),byteArrayOf())}
    "GET"->{val value=files[p];if(value==null)CloudHTTP(404,emptyMap(),byteArrayOf())else{if(p.endsWith("manifest.json")){successfulManifestGets++;afterManifestGet?.invoke()};CloudHTTP(200,emptyMap(),value.copyOf())}}
    else->error("Unexpected synthetic request method")
   }
  }
  fun puts()=requests.count{it.first=="PUT"}
  fun manifestFiles()=files.keys.filter{it.endsWith("manifest.json")}.size
 }
 private fun pendingFile(control:File,id:String)=File(control,"$id/pending.json")
 private fun snapshotFile(control:File,id:String)=File(control,"$id/snapshot.paperdigest")
 private fun cp(file:File)=CloudCheckpoint.parse(JSONObject(file.readText()).getJSONObject("checkpoint"))
 private fun service(root:File,control:File,dav:FakeDAV,capture:suspend(File)->BackupCodec.Captured)=CloudService(root,control,SyntheticSecrets(),object:CloudWorkspace{
  override suspend fun capture(output:File)=capture(output)
  override suspend fun restore(staged:BackupCodec.Staged){error("Restore must not be invoked")}
 },dav,{now},{},{})

 @Test fun finalManifestCheckpointFailureRejectsCompletionAndColdRetryUsesSameOriginal()=runBlocking {fixture{p,research->
  val before=facts(research);val file=BackupCodec.capture(research,File(p,"original.paperdigest")).file;val original=file.readBytes()
  val dav=FakeDAV();val durable=File(p,"checkpoint.json");var attemptedFinal=0
  val archive=CloudArchive("SyntheticBackup","00000000-0000-4000-8000-000000000023",{CloudCredentials("synthetic","synthetic")},{value->
   if(value.manifestVerified){attemptedFinal++;throw java.io.IOException("Synthetic final checkpoint persistence failure")}
   BackupCodec.atomicJSON(durable,value.json())
  },dav,{now},{},0)
  var returned=false;val failure=runCatching{archive.upload(file).also{returned=true}}.exceptionOrNull()
  assertFalse("Final save failure must not return complete",returned);assertTrue(failure is CloudFailure);assertEquals("checkpointStore",(failure as CloudFailure).code)
  assertEquals(1,attemptedFinal);assertEquals(1,dav.successfulManifestGets);assertEquals(1,dav.manifestFiles())
  val retained=CloudCheckpoint.parse(JSONObject(durable.readText()));assertFalse(retained.manifestVerified);assertEquals(retained.manifest.chunks.indices.toSet(),retained.verified)
  assertTrue(dav.requests.any{it.first=="GET"&&it.second.endsWith("chunk-000000.bin")});assertArrayEquals(original,file.readBytes());assertEquals(before,facts(research))
  val originalReference=retained.manifest.reference;val puts=dav.puts();val cold=CloudArchive("SyntheticBackup",retained.destinationID,{CloudCredentials("synthetic","synthetic")},{BackupCodec.atomicJSON(durable,it.json())},dav,{now},{},0)
  val recovered=cold.upload(file,retained);assertEquals(originalReference,recovered.reference);assertEquals(BackupCodec.hash(original),recovered.sha256);assertEquals(puts,dav.puts())
  assertTrue(CloudCheckpoint.parse(JSONObject(durable.readText())).manifestVerified);assertArrayEquals(original,file.readBytes());assertEquals(before,facts(research))
 }}

 @Test fun finalLastBackupAtomicSaveFailureKeepsPendingSnapshotAndOldProofThenColdResumes()=runBlocking {fixture{p,research->
  val control=File(p,"Control");val dav=FakeDAV();var captures=0
  val cloud=service(research,control,dav){captures++;BackupCodec.capture(research,it)}
  cloud.save("synthetic@example.invalid","SyntheticBackup",false,24)
  val previous=cloud.upload();assertEquals(1,captures);assertEquals(previous.getString("sha256"),cloud.state().getJSONObject("lastBackup").getString("sha256"))
  val priorProof=previous.toString();val priorProofFile=File(p,"previous-complete-proof.json").apply{writeText(priorProof)};val priorProofBytes=priorProofFile.readBytes()
  File(research,"new-normal-file.txt").writeText("Synthetic new snapshot content, not an old backup reuse")
  val protected=facts(research);val id=cloud.targetID;val profile=File(control,"profile.json");val held=File(p,"valid-profile-before-final-save.json")
  var injected=false;var profileBeforeFault:ByteArray?=null;var retainedSnapshot:ByteArray?=null;var failed=false
  dav.afterManifestGet={if(!injected){
   check(captures==2);val checkpoint=cp(pendingFile(control,id));check(!checkpoint.manifestVerified&&checkpoint.verified==checkpoint.manifest.chunks.indices.toSet())
   val bytes=profile.readBytes();check(JSONObject(bytes.toString(Charsets.UTF_8)).getJSONObject("lastBackup").getString("sha256")==previous.getString("sha256"))
   profileBeforeFault=bytes;retainedSnapshot=snapshotFile(control,id).readBytes()
   Files.move(profile.toPath(),held.toPath(),ATOMIC_MOVE);check(profile.mkdir());File(profile,"own-obstruction").writeText("Only this owned fault path prevents atomic file replacement")
   injected=true
  }}
  try{
   var returned=false;val failure=runCatching{cloud.upload().also{returned=true}}.exceptionOrNull()
   assertTrue("Must reach the deliberately injected final profile path failure",injected);assertFalse("Final local completion save failure cannot return success",returned);assertNotNull(failure)
   assertTrue("Actual error must come from final profile atomic writer",failure!!.stackTrace.any{it.methodName=="persistProfile"}&&failure.stackTrace.any{it.methodName=="atomicBytes"});failed=true
   val completeCheckpoint=cp(pendingFile(control,id));assertTrue(completeCheckpoint.manifestVerified);assertEquals(completeCheckpoint.manifest.chunks.indices.toSet(),completeCheckpoint.verified)
   assertEquals(2,dav.successfulManifestGets);assertEquals(2,dav.manifestFiles());assertArrayEquals(retainedSnapshot,snapshotFile(control,id).readBytes())
   assertEquals(previous.getString("sha256"),cloud.state().getJSONObject("lastBackup").getString("sha256"));assertFalse(cloud.state().getBoolean("busy"));assertEquals(protected,facts(research))
   assertArrayEquals(profileBeforeFault,held.readBytes());assertArrayEquals(priorProofBytes,priorProofFile.readBytes())
  }finally{
   dav.afterManifestGet=null
   if(injected){check(File(profile,"own-obstruction").delete());check(profile.delete());Files.move(held.toPath(),profile.toPath(),ATOMIC_MOVE);check(profile.readBytes().contentEquals(profileBeforeFault!!))}
  }
  assertTrue(failed);val oldPending=pendingFile(control,id).readBytes();val original=cp(pendingFile(control,id)).manifest
  val puts=dav.puts();var recaptures=0;val cold=service(research,control,dav){recaptures++;error("Existing pending must resume, never recapture")}
  assertEquals(previous.getString("sha256"),cold.state().getJSONObject("lastBackup").getString("sha256"));assertTrue(oldPending.isNotEmpty())
  val recovered=cold.upload();assertEquals(0,recaptures);assertEquals(2,captures);assertEquals(puts,dav.puts());assertEquals(original.sha256,recovered.getString("sha256"));assertEquals(original.reference.id,recovered.getJSONObject("reference").getString("id"))
  assertEquals(original.sha256,cold.state().getJSONObject("lastBackup").getString("sha256"));assertTrue(File(control,"profile.json").isFile);assertEquals(original.sha256,JSONObject(File(control,"profile.json").readText()).getJSONObject("lastBackup").getString("sha256"))
  assertFalse(pendingFile(control,id).exists());assertFalse(snapshotFile(control,id).exists());assertEquals(protected,facts(research));assertArrayEquals(priorProofBytes,priorProofFile.readBytes());assertEquals(1,RequestContinuity.count("2026-01-01",research,JSONObject(File(research,"personal.json").readText())))
 }}

 @Test fun normalCompletionPersistsExactProofBeforeRetiringOnlyOwnPending()=runBlocking {fixture{p,research->
  val dav=FakeDAV();val control=File(p,"Control");val before=facts(research);var captures=0;val cloud=service(research,control,dav){captures++;BackupCodec.capture(research,it)}
  cloud.save("synthetic@example.invalid","SyntheticBackup",false,24);val info=cloud.upload();val persisted=JSONObject(File(control,"profile.json").readText()).getJSONObject("lastBackup")
  assertEquals(1,captures);assertEquals(1,dav.successfulManifestGets);assertEquals(info.toString(),persisted.toString());assertEquals(before,facts(research));assertFalse(pendingFile(control,cloud.targetID).exists());assertFalse(snapshotFile(control,cloud.targetID).exists());assertEquals(1,RequestContinuity.count("2026-01-01",research,JSONObject(File(research,"personal.json").readText())))
 }}
}
