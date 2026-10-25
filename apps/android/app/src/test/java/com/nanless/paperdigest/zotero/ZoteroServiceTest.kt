package com.nanless.paperdigest.zotero

import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.secret.SecretStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import okhttp3.Request
import okio.Buffer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest

class ZoteroServiceTest {
 private class Secrets:SecretStore {var value:String?="fake-test-key-never-persist";var reads=0;var failure:Exception?=null;override fun save(scope:String,secret:String){value=secret};override fun load(scope:String):String?{reads++;failure?.let{throw it};return value};override fun remove(scope:String){value=null}}
 private class Server:ZoteroTransport {
  val items=mutableMapOf<String,JSONObject>();val files=mutableMapOf<String,ByteArray>();val requests=mutableListOf<Request>();var writes=0;var uploads=0;var failUpload=false;var corruptDownload=false;var reject=0;var backoff=false;var permission=true;var group:JSONObject?=null;var metadataBackoff=false;var file429=false;var cancelDownload=false
  override suspend fun request(request:Request,limit:Int):HttpBytes {
   requests+=request;val p=request.url.encodedPath
   fun response(code:Int,body:String="",headers:Map<String,String> = emptyMap())=HttpBytes(code,headers,body.toByteArray())
   if(reject>0)return response(reject,"",mapOf("Retry-After" to "30"))
   if(p=="/keys/current")return response(200,JSONObject().put("userID",123).put("access",JSONObject().put("user",JSONObject().put("library",true).put("write",permission).put("files",true).put("notes",true)).put("groups",JSONObject().put("all",JSONObject().put("library",true).put("write",true)))).toString(),if(backoff)mapOf("Backoff" to "10")else emptyMap())
   if(p=="/groups/456")return response(200,JSONObject().put("id",456).put("data",group?:JSONObject()).toString())
   if(request.url.host=="files.example.org") {
    assertNull("Upload domain must never receive API key",request.header("Zotero-API-Key"));uploads++
    if(failUpload)return response(503)
    val buffer=Buffer();request.body!!.writeTo(buffer);val all=buffer.readByteArray();val key=request.url.pathSegments.last();files[key]=all.copyOfRange(3,all.size-3);return response(201)
   }
   if(request.method=="POST"&&p.endsWith("/items")) {
    writes++;val buffer=Buffer();request.body!!.writeTo(buffer);val a=JSONArray(buffer.readUtf8());for(i in 0 until a.length()){val item=a.getJSONObject(i);items[item.getString("key")]=JSONObject(item.toString()).put("version",1)}
    return response(200,"{\"successful\":{},\"unchanged\":{},\"failed\":{}}")
   }
   val key=if(p.endsWith("/file"))request.url.pathSegments[3] else request.url.pathSegments.last()
   if(request.method=="GET")return items[key]?.let{response(200,JSONObject().put("data",it).toString(),if(metadataBackoff&&it.optString("md5").isNotBlank())mapOf("Backoff" to "60")else emptyMap())}?:response(404)
   if(request.method=="POST"&&p.endsWith("/file")) {
    val b=Buffer();request.body!!.writeTo(b);val form=b.readUtf8()
    if(form.startsWith("upload=")){val bytes=files[key]?:error("no upload");items[key]!!.put("md5",md5(bytes)).put("mtime",1000);return response(204)}
    return response(200,JSONObject().put("url","https://files.example.org/$key").put("prefix","PRE").put("suffix","END").put("contentType","application/octet-stream").put("uploadKey","fake-upload").toString())
   }
   error("Unhandled ${request.method} $p")
  }
  override suspend fun download(request:Request,target:File,limit:Long):HttpFile {
   requests+=request
   if(cancelDownload)throw CancellationException("test-cancel")
   if(file429)return HttpFile(429,mapOf("Retry-After" to "60"),0,null)
   if(request.url.host=="api.zotero.org")return HttpFile(302,mapOf("Location" to "https://files.example.org/${request.url.pathSegments[3]}"),0,null)
   assertNull(request.header("Zotero-API-Key"));val bytes=files[request.url.pathSegments.last()]!!;target.writeBytes(bytes)
   return HttpFile(200,emptyMap(),bytes.size.toLong(),if(corruptDownload)"0".repeat(64)else sha256(bytes))
  }
 }
 private data class Fixture(val root:File,val secret:Secrets,val server:Server,val service:ZoteroService,val provider:ZoteroMaterialProvider,val bibliography:JSONObject)
 private fun fixture(note:Boolean=false):Fixture {
  val root=Files.createTempDirectory("pd-zotero-test").toFile().canonicalFile;val research=File(root,"Research").also{it.mkdirs()};val secret=Secrets();val server=Server()
  val material=File(root,"original.pdf").also{it.writeBytes("%PDF-actual-test-bytes".toByteArray())}
  val bibliography=JSONObject().put("itemType","preprint").put("title","Real frozen test title")
  val provider=ZoteroMaterialProvider { ZoteroMaterials("arxiv:2601.00001","a".repeat(64),bibliography.copy(),listOf(ZoteroMaterial("pdf","Original","application/pdf",material,sha256=sha256(material.readBytes())))+if(note)listOf(ZoteroMaterial("note","Notes","text/html",noteHTML="<div>note &amp; math</div>",sha256=sha256("<div>note &amp; math</div>".toByteArray())))else emptyList()) }
  return Fixture(root,secret,server,ZoteroService(research,secret,provider,server),provider,bibliography)
 }
 private suspend fun Fixture.configure() { service.execute("save",JSONObject().put("libraryType","users").put("libraryID","123")) }
 private suspend fun Fixture.prepare():String=service.execute("prepare").getString("preparedID")
 @Test fun sourceAvailabilityNoticeIsPreservedInPreparedAndNewDurableJournal()=runBlocking{
  val f=fixture();val warning="旧网站原发布记录未绑定；不能声称已保存全部未知元数据。"
  val provider=ZoteroMaterialProvider{options->f.provider.prepare(options).copy(notices=listOf(warning))}
  val service=ZoteroService(File(f.root,"Research"),f.secret,provider,f.server)
  service.execute("save",JSONObject().put("libraryType","users").put("libraryID","123"));val prepared=service.execute("prepare")
  assertEquals(warning,prepared.getJSONArray("notices").getString(0))
  val journal=JSONObject(File(f.root,"Research/ZoteroArchives/${prepared.getString("preparedID")}/journal.json").readText())
  assertEquals(warning,journal.getJSONArray("notices").getString(0));assertEquals(0,f.secret.reads);assertTrue(f.server.requests.isEmpty())
 }
 @Test fun newlyObservedNoticeDoesNotResignOrRewriteAnExactPriorJournal()=runBlocking{
  val f=fixture();f.configure();val original=f.prepare();val file=File(f.root,"Research/ZoteroArchives/$original/journal.json");val bytes=file.readBytes()
  val provider=ZoteroMaterialProvider{options->f.provider.prepare(options).copy(notices=listOf("当前来源完整性另有缺口，未重写旧材料"))}
  val reopened=ZoteroService(File(f.root,"Research"),f.secret,provider,f.server);val result=reopened.execute("prepare")
  assertEquals(original,result.getString("preparedID"));assertTrue(result.getBoolean("reused"));assertEquals("当前来源完整性另有缺口，未重写旧材料",result.getJSONArray("notices").getString(0));assertArrayEquals(bytes,file.readBytes());assertTrue(f.server.requests.isEmpty());assertEquals(0,f.secret.reads)
 }
 @Test fun eachPrepareEchoesItsActualOptionsAndRequestWithoutRewritingAnExactPriorJournal()=runBlocking{
  val f=fixture();f.configure();val firstRequest=java.util.UUID.randomUUID().toString();val first=f.service.execute("prepare",JSONObject().put("preparationRequestID",firstRequest))
  assertEquals(firstRequest,first.getString("preparationRequestID"));assertEquals(true,first.getJSONObject("options").opt("includeNote"))
  val journal=File(f.root,"Research/ZoteroArchives/${first.getString("preparedID")}/journal.json");val original=journal.readBytes();val secondRequest=java.util.UUID.randomUUID().toString()
  val second=f.service.execute("prepare",JSONObject().put("includeNote",false).put("preparationRequestID",secondRequest))
  assertEquals(first.getString("preparedID"),second.getString("preparedID"));assertTrue(second.getBoolean("reused"));assertEquals(secondRequest,second.getString("preparationRequestID"));assertEquals(false,second.getJSONObject("options").opt("includeNote"));assertArrayEquals(original,journal.readBytes());assertEquals(0,f.secret.reads);assertTrue(f.server.requests.isEmpty())
 }
 @Test fun invalidPreparationRequestIdentityNeverPreparesMaterialsOrReadsCredential()=runBlocking{
  val f=fixture();f.configure();var materialReads=0;val service=ZoteroService(File(f.root,"Research"),f.secret,ZoteroMaterialProvider{options->materialReads++;f.provider.prepare(options)},f.server)
  assertFails{service.execute("prepare",JSONObject().put("preparationRequestID","not-a-request-uuid"))};assertEquals(0,materialReads);assertEquals(0,f.secret.reads);assertTrue(f.server.requests.isEmpty());assertTrue(File(f.root,"Research/ZoteroArchives").listFiles().orEmpty().isEmpty())
 }
 @Test fun stateNeverReadsSecretOrNetwork()=runBlocking{val f=fixture();f.service.state();assertEquals(0,f.secret.reads);assertTrue(f.server.requests.isEmpty())}
 @Test fun fullArchiveReadbackAndRepeatDoNotDuplicate()=runBlocking{val f=fixture(true);f.configure();val id=f.prepare();val r=f.service.execute("archive",JSONObject().put("preparedID",id));assertEquals("completed",r.getString("status"));assertEquals(3,r.getInt("roleCount"));assertEquals(3,f.server.items.size);assertEquals(1,f.server.uploads);val writes=f.server.writes;f.service.execute("resume",JSONObject().put("journalID",id));assertEquals(writes,f.server.writes);assertEquals(1,f.server.uploads)}
 @Test fun failedUploadResumesOriginalKeys()=runBlocking{val f=fixture();f.configure();val id=f.prepare();f.server.failUpload=true;assertFails{f.service.execute("archive",JSONObject().put("preparedID",id))};val keys=f.server.items.keys.toSet();f.server.failUpload=false;f.service.execute("resume",JSONObject().put("journalID",id));assertEquals(keys,f.server.items.keys)}
 @Test fun mismatchFileNeverCompletes()=runBlocking{val f=fixture();f.configure();val id=f.prepare();f.server.corruptDownload=true;assertFails{f.service.execute("archive",JSONObject().put("preparedID",id))};assertEquals("failed",f.service.state().getJSONArray("journals").getJSONObject(0).getString("status"))}
 @Test fun modifiedRemoteItemIsNeverOverwritten()=runBlocking{val f=fixture();f.configure();val id=f.prepare();f.service.execute("archive",JSONObject().put("preparedID",id));f.server.items.values.first{it.optString("itemType")=="preprint"}.put("title","User edited");val writes=f.server.writes;assertFails{f.service.execute("resume",JSONObject().put("journalID",id))};assertEquals(writes,f.server.writes)}
 @Test fun changedAccountCannotReuseJournal()=runBlocking{val f=fixture();f.configure();val id=f.prepare();f.service.execute("save",JSONObject().put("libraryType","users").put("libraryID","999"));val n=f.server.requests.size;assertFails{f.service.execute("resume",JSONObject().put("journalID",id))};assertEquals(n,f.server.requests.size)}
 @Test fun damagedOriginalBlocksBeforeCredentialOrNetwork()=runBlocking{val f=fixture();f.configure();val id=f.prepare();File(f.root,"Research/ZoteroArchives/$id/material-0").appendText("tamper");assertFails{f.service.execute("resume",JSONObject().put("journalID",id))};assertEquals(0,f.secret.reads);assertTrue(f.server.requests.isEmpty())}
 @Test fun permissionDeniedBeforeWrites()=runBlocking{val f=fixture();f.configure();val id=f.prepare();f.server.permission=false;assertFails{f.service.execute("archive",JSONObject().put("preparedID",id))};assertEquals(0,f.server.writes)}
 @Test fun backoff200IsPersistedAndStopsFollowingRequest()=runBlocking{val f=fixture();f.configure();f.server.backoff=true;f.service.execute("check");assertFails{f.service.execute("check")};assertEquals(1,f.server.requests.size);assertTrue(File(f.root,"PaperDigestZotero/connection.json").readText().contains("backoffUntil"))}
 @Test fun credentialsErrorNeverLeaksRawSecret()=runBlocking{val f=fixture();f.configure();f.secret.failure=IllegalStateException("SENSITIVE-DECOY");val e=assertFails{f.service.execute("check")};assertFalse(e.message.orEmpty().contains("SENSITIVE-DECOY"));assertTrue(f.server.requests.isEmpty())}
 @Test fun keyNeverAppearsInResearchBytes()=runBlocking{val f=fixture();f.configure();val id=f.prepare();f.service.execute("archive",JSONObject().put("preparedID",id));File(f.root,"Research").walkTopDown().filter{it.isFile}.forEach{assertFalse(it.readText().contains(f.secret.value!!))}}
 @Test fun cancelledCredentialReadRemainsCancellationAndActorRecovers()=runBlocking{val f=fixture();f.configure();f.secret.failure=CancellationException("DO-NOT-LEAK");val e=assertFails{f.service.execute("check")};assertTrue(e is CancellationException);assertTrue(f.server.requests.isEmpty());assertFalse(f.service.state().getBoolean("busy"));f.secret.failure=null;f.service.execute("check");assertEquals(1,f.server.requests.size)}
 @Test fun originalTargetCanBeSelectedAgainForSameJournal()=runBlocking{val f=fixture();f.configure();val id=f.prepare();f.service.execute("save",JSONObject().put("libraryType","users").put("libraryID","999"));f.configure();f.service.execute("resume",JSONObject().put("journalID",id));assertEquals("completed",f.service.state().getJSONArray("journals").getJSONObject(0).getString("status"))}
 @Test fun groupFilesDisabledEvenForOwnerBlocksBeforeAnyWrite()=runBlocking{val f=fixture();f.service.execute("save",JSONObject().put("libraryType","groups").put("libraryID","456"));f.server.group=JSONObject().put("owner",123).put("libraryEditing","members").put("fileEditing","none");assertFails{f.service.execute("check")};assertEquals(0,f.server.writes);assertEquals(0,f.server.uploads);assertEquals("unknown",f.service.state().getString("credentialState"))}
 @Test fun groupAdminCanWriteFilesWhenAdminsAllowed()=runBlocking{val f=fixture();f.service.execute("save",JSONObject().put("libraryType","groups").put("libraryID","456"));f.server.group=JSONObject().put("owner",999).put("admins",JSONArray().put(123)).put("libraryEditing","admins").put("fileEditing","admins");f.service.execute("check");assertTrue(f.service.state().getJSONObject("permissions").getBoolean("files"));assertEquals(0,f.server.writes)}
 @Test fun groupOrdinaryMemberCannotUseAdminOnlyFilePermission()=runBlocking{val f=fixture();f.service.execute("save",JSONObject().put("libraryType","groups").put("libraryID","456"));f.server.group=JSONObject().put("owner",999).put("members",JSONArray().put(123)).put("libraryEditing","members").put("fileEditing","admins");assertFails{f.service.execute("check")};assertEquals(0,f.server.writes);assertEquals(0,f.server.uploads)}
 @Test fun groupOutsiderCannotWriteDespiteBroadKey()=runBlocking{val f=fixture();f.service.execute("save",JSONObject().put("libraryType","groups").put("libraryID","456"));f.server.group=JSONObject().put("owner",999).put("libraryEditing","members").put("fileEditing","members");assertFails{f.service.execute("check")};assertEquals(0,f.server.writes)}
 @Test fun exactPrepareAfterRestartReusesDurableJournalWithoutNetwork()=runBlocking{val f=fixture();f.configure();val id=f.prepare();f.service.execute("archive",JSONObject().put("preparedID",id));val n=f.server.requests.size;val reads=f.secret.reads;val reopened=ZoteroService(File(f.root,"Research"),f.secret,f.provider,f.server);val r=reopened.execute("prepare");assertEquals(id,r.getString("preparedID"));assertTrue(r.getBoolean("reused"));assertEquals(n,f.server.requests.size);assertEquals(reads,f.secret.reads);reopened.execute("archive",JSONObject().put("preparedID",id));assertEquals(2,f.server.items.size)}
 @Test fun changedMaterialReusesVerifiedParentButAddsOnlyNewChild()=runBlocking{val f=fixture();f.configure();val first=f.prepare();f.service.execute("archive",JSONObject().put("preparedID",first));val parent=f.server.items.values.single{it.getString("itemType")=="preprint"}.getString("key");File(f.root,"original.pdf").appendText("new original bytes");val second=f.prepare();assertNotEquals(first,second);f.service.execute("archive",JSONObject().put("preparedID",second));assertEquals(1,f.server.items.values.count{it.getString("itemType")=="preprint"});assertEquals(3,f.server.items.size);assertTrue(f.server.items.values.filter{it.getString("itemType")=="attachment"}.all{it.getString("parentItem")==parent})}
 @Test fun changedBibliographicFactsNeverReuseOldParent()=runBlocking{val f=fixture();f.configure();val first=f.prepare();f.service.execute("archive",JSONObject().put("preparedID",first));f.bibliography.put("title","Actually revised original title");val second=f.prepare();f.service.execute("archive",JSONObject().put("preparedID",second));assertEquals(2,f.server.items.values.count{it.getString("itemType")=="preprint"})}
 @Test fun reusedParentUserEditStopsNewArchiveWithoutOverwrite()=runBlocking{val f=fixture();f.configure();val first=f.prepare();f.service.execute("archive",JSONObject().put("preparedID",first));f.server.items.values.single{it.getString("itemType")=="preprint"}.put("title","User edit");File(f.root,"original.pdf").appendText("new bytes");val second=f.prepare();val writes=f.server.writes;assertFails{f.service.execute("archive",JSONObject().put("preparedID",second))};assertEquals(writes,f.server.writes)}
 @Test fun deletedVerifiedItemIsNotRecreated()=runBlocking{val f=fixture();f.configure();val id=f.prepare();f.service.execute("archive",JSONObject().put("preparedID",id));val child=f.server.items.values.single{it.getString("itemType")=="attachment"}.getString("key");f.server.items.remove(child);val writes=f.server.writes;assertFails{f.service.execute("resume",JSONObject().put("journalID",id))};assertEquals(writes,f.server.writes);assertFalse(f.server.items.containsKey(child))}
 @Test fun missingRequiredRoleTagBlocksButUserExtraTagIsPreserved()=runBlocking{val f=fixture();f.configure();val id=f.prepare();f.service.execute("archive",JSONObject().put("preparedID",id));val child=f.server.items.values.single{it.getString("itemType")=="attachment"};child.getJSONArray("tags").put(JSONObject().put("tag","user-extra"));f.service.execute("resume",JSONObject().put("journalID",id));val writes=f.server.writes;child.put("tags",JSONArray().put(JSONObject().put("tag","user-extra")));assertFails{f.service.execute("resume",JSONObject().put("journalID",id))};assertEquals(writes,f.server.writes);assertEquals("user-extra",child.getJSONArray("tags").getJSONObject(0).getString("tag"))}
 @Test fun successfulMetadataBackoffPreventsImmediateFileApiRequest()=runBlocking{val f=fixture();f.configure();val id=f.prepare();f.server.metadataBackoff=true;val e=assertFails{f.service.execute("archive",JSONObject().put("preparedID",id))};assertTrue(e.message.orEmpty().contains("冷却"));assertFalse(f.server.requests.any{it.method=="GET"&&it.url.encodedPath.endsWith("/file")});assertTrue(JSONObject(File(f.root,"PaperDigestZotero/connection.json").readText()).getLong("backoffUntil")>System.currentTimeMillis())}
 @Test fun file429PersistsCooldownAcrossServiceRestart()=runBlocking{val f=fixture();f.configure();val id=f.prepare();f.server.file429=true;val e=assertFails{f.service.execute("archive",JSONObject().put("preparedID",id))};assertTrue(e is AppFailure&&e.category=="backoff");val count=f.server.requests.size;val reopened=ZoteroService(File(f.root,"Research"),f.secret,f.provider,f.server);assertFails{reopened.execute("resume",JSONObject().put("journalID",id))};assertEquals(count,f.server.requests.size)}
 @Test fun fileCancellationRemainsCancellationWithoutAuthenticationOrCooldown()=runBlocking{val f=fixture();f.configure();val id=f.prepare();f.server.cancelDownload=true;val e=assertFails{f.service.execute("archive",JSONObject().put("preparedID",id))};assertTrue(e is CancellationException);assertEquals("cancelled",f.service.state().getJSONArray("journals").getJSONObject(0).getString("status"));assertFalse(JSONObject(File(f.root,"PaperDigestZotero/connection.json").readText()).has("backoffUntil"));assertFalse(f.service.state().getBoolean("busy"))}
 @Test fun collectionChangeCannotSilentlyResumeIntoOldTarget()=runBlocking{val f=fixture();f.service.execute("save",JSONObject().put("libraryType","users").put("libraryID","123").put("collection","ABCDEFGH"));val id=f.prepare();f.configure();assertFails{f.service.execute("archive",JSONObject().put("preparedID",id))};assertTrue(f.server.requests.isEmpty());f.service.execute("save",JSONObject().put("libraryType","users").put("libraryID","123").put("collection","ABCDEFGH"));f.service.execute("resume",JSONObject().put("journalID",id));assertEquals("completed",f.service.state().getJSONArray("journals").getJSONObject(0).getString("status"))}
 @Test fun invalidExternalAddressesRejected(){listOf("http://example.org/f","https://u:p@example.org/f","file:///tmp/f","https://example.org/f#x").forEach{assertThrows(IllegalArgumentException::class.java){ZoteroService.safeExternal(it)}}}
 private suspend fun assertFails(block:suspend()->Unit):Exception {try{block()}catch(e:Exception){return e};throw AssertionError("Expected failure")}
 companion object{private fun md5(b:ByteArray)=MessageDigest.getInstance("MD5").digest(b).joinToString(""){"%02x".format(it.toInt()and 255)}}
}
