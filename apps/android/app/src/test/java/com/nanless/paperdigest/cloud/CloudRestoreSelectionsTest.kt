package com.nanless.paperdigest.cloud

import com.nanless.paperdigest.secret.SecretStore
import kotlinx.coroutines.runBlocking
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.Base64

class CloudRestoreSelectionsTest {
 private class Vault:SecretStore { var reads=0; private val values=mutableMapOf<String,String>(); override fun save(scope:String,secret:String){values[scope]=secret};override fun load(scope:String):String?{reads++;return values[scope]};override fun remove(scope:String){values.remove(scope)} }
 private class DAV:CloudTransport {
  val documents=mutableMapOf<String,Pair<CloudManifest,ByteArray>>();val manifestOverrides=mutableMapOf<String,ByteArray>();var observed:((Request)->Unit)?=null;val requests=mutableListOf<Pair<String,String>>()
  override suspend fun execute(request:Request,limit:Int):CloudHTTP {
   val path=request.url.encodedPath;requests+=request.method to path;observed?.invoke(request)
   if(request.method=="PROPFIND"){
    val parent=path;val members=listOf(parent)+documents.keys.filter{it.startsWith(parent)}
    val xml="<d:multistatus xmlns:d=\"DAV:\">"+members.joinToString(""){"<d:response><d:href>$it</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"}+"</d:multistatus>"
    return CloudHTTP(207,emptyMap(),xml.toByteArray())
   }
   check(request.method=="GET"){"Probe must not write remote or use any actual HTTP transport"}
   for((base,pair) in documents){val bytes=when(path){base+"manifest.json"->manifestOverrides[base]?:pair.first.json().toString().toByteArray();base+"chunk-000000.bin"->pair.second;else->null};if(bytes!=null){check(bytes.size<=limit);return CloudHTTP(200,emptyMap(),bytes.copyOf())}}
   return CloudHTTP(404,emptyMap(),byteArrayOf())
  }
 }
 private fun snapshot(marker:String):Pair<CloudManifest,ByteArray>{
  val personal=JSONObject().put("schema",1).put("notes",JSONObject()).put("favorites",JSONArray()).put("reading",JSONArray()).put("readingState",JSONObject()).put("annotations",JSONObject()).put("sessions",JSONArray()).put("jobs",JSONArray()).put("settings",JSONObject()).put("syntheticVersion",marker).toString().toByteArray()
  val bytes=JSONObject().put("contract","paperdigest-backup-v2").put("sourceDirectory","/synthetic-card-only/PaperDigest").put("files",JSONArray().put(JSONObject().put("path","personal.json").put("data",Base64.getEncoder().encodeToString(personal)).put("sha256",BackupCodec.hash(personal)))).toString().toByteArray()
  val ref=CloudReference("2026-01","aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");val sha=BackupCodec.hash(bytes)
  return CloudManifest(ref,1767225600000L,bytes.size.toLong(),sha,listOf(CloudChunk(0,bytes.size,sha))) to bytes
 }
 private fun test(name:String,body:suspend (CloudService,DAV,File,Vault)->Unit)=runBlocking{
  val dir=Files.createTempDirectory("card-binding-synthetic-").toFile();try{
   val research=File(dir,"Research").apply{mkdir()};val dav=DAV();val vault=Vault();val cloud=CloudService(research,File(dir,"Cloud"),vault,object:CloudWorkspace{override suspend fun capture(output:File):BackupCodec.Captured=error("No capture permitted");override suspend fun restore(staged:BackupCodec.Staged)=error("No commit permitted")},dav,{1767225600000L},{},{})
   cloud.save("synthetic-account","TargetA",false,24);cloud.setPassword("synthetic-password");body(cloud,dav,dir,vault)
  }finally{dir.deleteRecursively()}
 }

 private fun path(pair:Pair<CloudManifest,ByteArray>,folder:String="TargetA")="/dav/$folder/2026-01/${pair.first.reference.id}/"
 private fun selected(reply:JSONObject)=reply.getJSONArray("snapshots").getJSONObject(0).getString("selectionID")
 private suspend fun rejected(code:String,body:suspend()->Unit){try{body();fail("Expected safe refusal")}catch(e:CloudFailure){assertEquals(code,e.code)}}
 @Test fun unchangedExactCardPreparesTheListedOriginal()=test("unchanged"){cloud,dav,_,_->
  val a=snapshot("A");dav.documents[path(a)]=a;val selections=CloudRestoreSelections(cloud){CloudSelectionContext(cloud.targetID,"epoch-A")}
  val reply=selections.list("2026-01");val card=reply.getJSONArray("snapshots").getJSONObject(0);val prepared=selections.prepare(selected(reply))
  try{assertEquals(a.first.sha256,prepared.staged.encodedSHA256);assertEquals(card.getLong("encodedBytes"),prepared.staged.encodedBytes);assertEquals(BackupCodec.hash(a.first.json().toString().toByteArray()),card.getString("manifestSHA256"));assertTrue(dav.requests.all{it.first in setOf("GET","PROPFIND")})}finally{prepared.staged.directory.deleteRecursively()}
 }
 @Test fun oldCardAfterNormalTargetSaveRejectsBeforeCredentialOrTransport()=test("target-change"){cloud,dav,_,vault->
  val a=snapshot("A");val b=snapshot("B");dav.documents[path(a)]=a;dav.documents[path(b,"TargetB")]=b
  val selections=CloudRestoreSelections(cloud){CloudSelectionContext(cloud.targetID,"epoch-A")};val id=selected(selections.list("2026-01"))
  cloud.save("synthetic-account","TargetB",false,24);cloud.setPassword("synthetic-password");val calls=dav.requests.size;val reads=vault.reads
  rejected("selectionExpired"){selections.prepare(id)};assertEquals(calls,dav.requests.size);assertEquals(reads,vault.reads)
 }
 @Test fun sameReferenceValidReplacementRejectsBeforeAnyChunkOrStage()=test("remote-swap"){cloud,dav,dir,_->
  val a=snapshot("A");val b=snapshot("B");dav.documents[path(a)]=a;val selections=CloudRestoreSelections(cloud){CloudSelectionContext(cloud.targetID,"epoch-A")}
  val id=selected(selections.list("2026-01"));dav.documents[path(a)]=b;val calls=dav.requests.size
  rejected("versionChanged"){selections.prepare(id)};assertEquals(listOf("GET" to (path(a)+"manifest.json")),dav.requests.drop(calls));assertFalse(File(dir,"Cloud").walkTopDown().any{it.name.startsWith("download-")});assertEquals(2,dir.listFiles()!!.count{it.isDirectory})
 }
 @Test fun evenSameParsedManifestWithDifferentRawBytesNeedsFreshList()=test("raw-change"){cloud,dav,_,_->
  val a=snapshot("A");dav.documents[path(a)]=a;val selections=CloudRestoreSelections(cloud){CloudSelectionContext(cloud.targetID,"epoch-A")};val id=selected(selections.list("2026-01"))
  val changed=(" "+a.first.json().toString()+"\n").toByteArray();assertEquals(a.first,CloudManifest.parse(changed,a.first.reference));dav.manifestOverrides[path(a)]=changed
  val before=dav.requests.size;rejected("versionChanged"){selections.prepare(id)};assertEquals(1,dav.requests.size-before)
 }
 @Test fun newerListRetiresOldHandleAndStaleFailureCannotRetireNewHandle()=test("generation"){cloud,dav,_,_->
  val a=snapshot("A");dav.documents[path(a)]=a;val selections=CloudRestoreSelections(cloud){CloudSelectionContext(cloud.targetID,"epoch-A")}
  val old=selected(selections.list("2026-01"));val fresh=selected(selections.list("2026-01"));val calls=dav.requests.size
  rejected("selectionExpired"){selections.prepare(old)};assertEquals(calls,dav.requests.size)
  val result=selections.prepare(fresh);try{assertEquals(a.first.sha256,result.staged.encodedSHA256)}finally{result.staged.directory.deleteRecursively()}
 }
 @Test fun workspaceEpochChangeAndColdControllerRetireHandles()=test("epoch"){cloud,dav,_,vault->
  val a=snapshot("A");dav.documents[path(a)]=a;var epoch="epoch-A";val selections=CloudRestoreSelections(cloud){CloudSelectionContext(cloud.targetID,epoch)}
  val id=selected(selections.list("2026-01"));val calls=dav.requests.size;val reads=vault.reads;epoch="epoch-B"
  rejected("selectionExpired"){selections.prepare(id)};val cold=CloudRestoreSelections(cloud){CloudSelectionContext(cloud.targetID,epoch)};rejected("selectionExpired"){cold.prepare(id)}
  assertEquals(calls,dav.requests.size);assertEquals(reads,vault.reads)
 }
 @Test fun normalTargetABARetiresOldHandleEvenAtSameFolderAgain()=test("target-aba"){cloud,dav,_,_->
  val a=snapshot("A");dav.documents[path(a)]=a;val selections=CloudRestoreSelections(cloud){CloudSelectionContext(cloud.targetID,"epoch-A")};val reply=selections.list("2026-01");val token=reply.getString("selectionContext")
  cloud.save("synthetic-account","TargetB",false,24);cloud.save("synthetic-account","TargetA",false,24);cloud.setPassword("synthetic-password");val before=dav.requests.size
  rejected("selectionExpired"){selections.prepare(selected(reply))};assertNotEquals(token,selections.contextToken());assertEquals(before,dav.requests.size)
 }
 @Test fun frontendMutationsCannotMintOrChangeNativeSnapshotAuthority()=test("frontend"){cloud,dav,_,_->
  val a=snapshot("A");dav.documents[path(a)]=a;val selections=CloudRestoreSelections(cloud){CloudSelectionContext(cloud.targetID,"epoch-A")};val reply=selections.list("2026-01")
  val card=reply.getJSONArray("snapshots").getJSONObject(0);card.put("sha256","b".repeat(64)).put("month","2026-02").put("id","bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
  rejected("selectionExpired"){selections.prepare("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")}
  val prepared=selections.prepare(card.getString("selectionID"));try{assertEquals(a.first.sha256,prepared.staged.encodedSHA256)}finally{prepared.staged.directory.deleteRecursively()}
  rejected("selectionExpired"){selections.prepare(card.getString("selectionID"))}
 }
 @Test fun contextChangeDuringListCannotPublishAHandle()=test("late-list"){cloud,dav,_,_->
  val a=snapshot("A");dav.documents[path(a)]=a;var epoch="epoch-A";val selections=CloudRestoreSelections(cloud){CloudSelectionContext(cloud.targetID,epoch)}
  dav.observed={if(it.url.encodedPath.endsWith("manifest.json"))epoch="epoch-B"}
  rejected("selectionExpired"){selections.list("2026-01")};assertFalse(dav.requests.any{it.second.endsWith(".bin")})
 }
 @Test fun contextChangeDuringDownloadCannotLeavePreparedStage()=test("late-download"){cloud,dav,dir,_->
  val a=snapshot("A");dav.documents[path(a)]=a;var epoch="epoch-A";val selections=CloudRestoreSelections(cloud){CloudSelectionContext(cloud.targetID,epoch)}
  val id=selected(selections.list("2026-01"));dav.observed={if(it.url.encodedPath.endsWith(".bin"))epoch="epoch-B"}
  rejected("selectionExpired"){selections.prepare(id)};assertEquals(2,dir.listFiles()!!.count{it.isDirectory});assertFalse(File(dir,"Cloud").walkTopDown().any{it.name.startsWith("download-")})
 }
 @Test fun serviceMutexAdmissionRejectsExpectedOldTargetWithoutCredentialRead()=test("service-guard"){cloud,dav,_,vault->
  val a=snapshot("A");dav.documents[path(a)]=a;val oldTarget=cloud.targetID;val identity=cloud.listBound("2026-01",oldTarget).single()
  cloud.save("synthetic-account","TargetB",false,24);cloud.setPassword("synthetic-password");val calls=dav.requests.size;val reads=vault.reads
  rejected("selectionExpired"){cloud.prepareRestoreBound(identity,oldTarget)};rejected("selectionExpired"){cloud.listBound("2026-01",oldTarget)};assertEquals(calls,dav.requests.size);assertEquals(reads,vault.reads)
 }
 @Test fun callerCancellationBeforeDownloadSendsNoRequestAndCannotReviveHandle()=test("cancel"){cloud,dav,_,vault->
  val a=snapshot("A");dav.documents[path(a)]=a;val selections=CloudRestoreSelections(cloud){CloudSelectionContext(cloud.targetID,"epoch-A")};val id=selected(selections.list("2026-01"));val calls=dav.requests.size;val reads=vault.reads
  try{selections.prepare(id){throw kotlinx.coroutines.CancellationException("synthetic cancel")};fail("Expected cancellation")}catch(_:kotlinx.coroutines.CancellationException){}
  assertEquals(calls,dav.requests.size);assertEquals(reads,vault.reads);assertFalse(cloud.state().getBoolean("busy"));rejected("selectionExpired"){selections.prepare(id)}
 }

}
