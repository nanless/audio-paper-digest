package com.nanless.paperdigest.zotero.webdav

import com.nanless.paperdigest.secret.SecretStore
import kotlinx.coroutines.*
import okhttp3.Request
import okio.Buffer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.file.Files
import java.util.UUID

class ZoteroDavBackendTest {
    private class Keys:SecretStore {
        val reads=mutableListOf<String>();var onLoad:(String)->Unit={}
        override fun save(scope:String,secret:String){error("No secret writes")};override fun remove(scope:String){error("No secret deletion")}
        override fun load(scope:String):String {onLoad(scope);reads+=scope;return when{scope=="zotero.primary"->"synthetic-api-key";scope.startsWith("zotero.webdav.")->"synthetic-dav-password";else->error("Wrong secret domain")}}
    }
    private class Server: DavWireTransport {
        val calls=mutableListOf<Request>();val blobs=mutableMapOf<String,ByteArray>();var item=JSONObject();var apiUser=123L;var canWrite=true;var patchCount=0;var zipPuts=0;var propPuts=0
        var stringMtime=false;var noPatchEffect=false;var versionStuck=false;var lostZip=false;var lostPatch=false;var conflictOnPatch=false;var raceZip=false;var corruptProp=false;var redirect=false;var wrongAPIProof=false;var backoff=false
        var afterZip:()->Unit={};var onGet:suspend()->Unit={}
        override suspend fun exchange(request:Request,limit:Long,reply:DavReplyFile?,check:()->Unit):DavWireReply {
            check();calls+=request
            if(request.url.host=="api.zotero.org"){
                assertNull("Basic auth must not reach Zotero",request.header("Authorization"));assertEquals("synthetic-api-key",request.header("Zotero-API-Key"))
                if(request.url.encodedPath=="/keys/current")return json(JSONObject().put("userID",apiUser).put("access",JSONObject().put("user",JSONObject().put("library",true).put("write",canWrite).put("files",false))))
                if(request.method=="PATCH"){
                    patchCount++;assertNull(request.header("Zotero-Write-Token"));assertEquals(item.getLong("version").toString(),request.header("If-Unmodified-Since-Version"))
                    if(conflictOnPatch){item.put("version",item.getLong("version")+1);return DavWireReply(412,emptyMap())}
                    val b=Buffer();request.body!!.writeTo(b);val patch=JSONObject(b.readUtf8());assertEquals(setOf("md5","mtime"),patch.keys().asSequence().toSet())
                    if(!noPatchEffect)item.put("md5",patch.getString("md5")).put("mtime",patch.getLong("mtime")).put("version",item.getLong("version")+if(versionStuck)0 else 3)
                    if(lostPatch){lostPatch=false;throw IOException("synthetic lost reply")};return DavWireReply(204,emptyMap())
                }
                val copy=JSONObject(item.toString());if(stringMtime&&!copy.isNull("mtime"))copy.put("mtime",copy.getLong("mtime").toString());if(wrongAPIProof&&patchCount>0)copy.put("filename","wrong.pdf")
                return json(JSONObject().put("key",item.getString("key")).put("version",item.getLong("version")).put("library",JSONObject().put("id",123).put("type","user")).put("data",copy))
            }
            assertEquals("dav.example.org",request.url.host);assertNull(request.header("Zotero-API-Key"));assertTrue(request.header("Authorization")!!.startsWith("Basic "))
            val path=request.url.encodedPath;assertTrue(path.startsWith("/dav/zotero/ABCD2345."))
            if(redirect)return DavWireReply(302,mapOf("Location" to "https://evil.example.org/collect"))
            if(backoff)return DavWireReply(429,mapOf("Retry-After" to "30"))
            if(request.method=="PUT"){
                assertEquals("*",request.header("If-None-Match"))
                if(raceZip&&path.endsWith(".zip")&&!blobs.containsKey(path)){raceZip=false;blobs[path]="other-owner-original".toByteArray()}
                if(blobs.containsKey(path))return DavWireReply(412,emptyMap())
                val b=Buffer();request.body!!.writeTo(b);blobs[path]=b.readByteArray()
                if(path.endsWith(".zip")){zipPuts++;afterZip();if(lostZip){lostZip=false;throw IOException("synthetic reply lost after write")}}else propPuts++
                return DavWireReply(201,emptyMap())
            }
            onGet();check();var bytes=blobs[path]?:return DavWireReply(404,emptyMap())
            if(corruptProp&&path.endsWith(".prop"))bytes=bytes+byteArrayOf(32)
            if(reply!=null)reply.open().use{c->val b=ByteBuffer.wrap(bytes);while(b.hasRemaining())c.write(b);c.force(true)}
            return DavWireReply(200,emptyMap(),if(reply==null)bytes.copyOf() else byteArrayOf(),bytes.size.toLong(),davHash(bytes))
        }
        private fun json(j:JSONObject):DavWireReply {val b=j.toString().toByteArray();return DavWireReply(200,emptyMap(),b,b.size.toLong(),davHash(b))}
    }
    private class Fixture {
        val directory=Files.createTempDirectory("dav-original-").toFile().canonicalFile
        val root=File(directory,"transfers");val source=File(directory,"source.pdf").apply{writeBytes("synthetic original PDF bytes without any real paper".toByteArray());setLastModified(1_800_000_000_000)}
        val original=source.readBytes();val keys=Keys();val server=Server();var current=true;var time=1_800_000_000_000L
        val target=target();val backend=ZoteroDavBackend(root,keys,server,clock={time})
        val material=ZoteroDavAttachment.native("ABCD2345","BCDE3456","pdf","paper-a","a".repeat(64),"Synthetic paper","application/pdf",source,davHash(original))
        fun target(user:String="123",rootURL:String="https://dav.example.org/dav/",account:String=UUID.randomUUID().toString(),destination:String=UUID.randomUUID().toString())=ZoteroDavTarget.native("users",user,rootURL,"synthetic-user",destination,account)
        fun lease(target:ZoteroDavTarget=this.target)=ZoteroDavLease.native(target,UUID.randomUUID().toString(),UUID.randomUUID().toString(),0){current}
        suspend fun prepare():Pair<ZoteroDavPrepared,ZoteroDavLease>{val lease=lease();val p=backend.prepare(material,lease);server.item=JSONObject().put("key","ABCD2345").put("version",1).put("parentItem","BCDE3456").put("itemType","attachment").put("linkMode","imported_file").put("title","Synthetic paper").put("contentType","application/pdf").put("filename","pdf.pdf").put("md5",JSONObject.NULL).put("mtime",JSONObject.NULL).put("tags",JSONArray().put(JSONObject().put("tag","PaperDigest:pdf:${davHash(original)}")));return p to lease}
        fun close(){assertArrayEquals(original,source.readBytes());directory.deleteRecursively()}
    }
    private suspend fun rejects(block:suspend()->Unit):ZoteroDavFailure {try{block()}catch(e:ZoteroDavFailure){return e};throw AssertionError("Expected refusal")}
    @Test fun noKeyOrHttpDuringPrepare()= runBlocking {val f=Fixture();try{val(p,_)=f.prepare();assertEquals("prepared",p.journal.read().getString("phase"));assertTrue(f.keys.reads.isEmpty());assertTrue(f.server.calls.isEmpty());assertFalse(p.preview().toString().contains("synthetic-user"))}finally{f.close()}}
    @Test fun twoPlanesCompleteOnlyAfterRealRawResponseValidation()= runBlocking {val f=Fixture();try{val(p,l)=f.prepare();val r=f.backend.archive(p,l);assertEquals(true,r.getBoolean("apiMetadataVerified"));assertEquals(true,r.getBoolean("davBytesVerified"));assertEquals(false,r.getBoolean("officialClientsOpened"));assertEquals(1,f.server.patchCount);assertEquals(1,f.server.zipPuts);assertEquals(1,f.server.propPuts);assertEquals("completed",p.journal.read().getString("phase"));val events=f.server.calls;val patch=events.indexOfFirst{it.method=="PATCH"};assertTrue(patch>events.indexOfFirst{it.method=="PUT"&&it.url.encodedPath.endsWith(".prop")});assertTrue(events.drop(patch+1).any{it.method=="GET"&&it.url.host=="api.zotero.org"});assertTrue(f.keys.reads.contains("zotero.webdav.${f.target.destinationID}"))}finally{f.close()}}
    @Test fun lostZipReplyColdResumeSameKeyNoDuplicatePut()= runBlocking {val f=Fixture();try{val(p,l)=f.prepare();f.server.lostZip=true;rejects{f.backend.archive(p,l)};assertEquals(1,f.server.zipPuts);val cold=ZoteroDavBackend(f.root,f.keys,f.server,clock={f.time});val r=cold.resume(p.id,f.lease());assertEquals("verified",r.getString("status"));assertEquals(1,f.server.zipPuts);assertEquals(1,f.server.patchCount);assertEquals(2,p.journal.let{DavJournal.reopen(it.files,it.id).read().getJSONArray("attempts").length()})}finally{f.close()}}
    @Test fun lostPatchReplyColdResumeNoSecondPatch()= runBlocking {val f=Fixture();try{val(p,l)=f.prepare();f.server.lostPatch=true;rejects{f.backend.archive(p,l)};assertEquals(1,f.server.patchCount);val cold=ZoteroDavBackend(f.root,f.keys,f.server,clock={f.time});assertEquals("verified",cold.resume(p.id,f.lease()).getString("status"));assertEquals(1,f.server.patchCount);assertEquals(1,f.server.zipPuts)}finally{f.close()}}
    @Test fun concurrentExistingZipNeverOverwritten()= runBlocking {val f=Fixture();try{val(p,l)=f.prepare();f.server.raceZip=true;assertEquals("conflict",rejects{f.backend.archive(p,l)}.code);assertArrayEquals("other-owner-original".toByteArray(),f.server.blobs["/dav/zotero/ABCD2345.zip"]);assertEquals(0,f.server.zipPuts);assertEquals(0,f.server.patchCount)}finally{f.close()}}
    @Test fun apiVersionConflictNotRebasedOrOverwritten()= runBlocking {val f=Fixture();try{val(p,l)=f.prepare();f.server.conflictOnPatch=true;assertEquals("conflict",rejects{f.backend.archive(p,l)}.code);assertTrue(f.server.item.isNull("md5"));assertEquals(1,p.journal.read().getLong("baseVersion"));assertNotEquals("completed",p.journal.read().getString("phase"));assertEquals(2,f.server.blobs.size)}finally{f.close()}}
    @Test fun api204WithoutMatchingReadbackDoesNotComplete()= runBlocking {val f=Fixture();try{val(p,l)=f.prepare();f.server.wrongAPIProof=true;rejects{f.backend.archive(p,l)};assertEquals("api-patch-planned",p.journal.read().getString("phase"));assertNotEquals("verified",p.journal.read().getString("status"))}finally{f.close()}}
    @Test fun corruptedPropertiesCannotTriggerApiWrite()= runBlocking {val f=Fixture();try{val(p,l)=f.prepare();f.server.corruptProp=true;assertEquals("conflict",rejects{f.backend.archive(p,l)}.code);assertEquals(0,f.server.patchCount)}finally{f.close()}}
    @Test fun wrongApiUserAndPermissionBeforeDavSecretOrWrites()= runBlocking {for(which in 0..1){val f=Fixture();try{val(p,l)=f.prepare();if(which==0)f.server.apiUser=456 else f.server.canWrite=false;assertEquals("permission",rejects{f.backend.archive(p,l)}.code);assertEquals(listOf("zotero.primary"),f.keys.reads);assertEquals(0,f.server.blobs.size);assertEquals(0,p.journal.read().getJSONArray("attempts").length())}finally{f.close()}}}
    @Test fun sameTargetExplicitFreshCredentialAttemptRetainsHistory()= runBlocking {val f=Fixture();try{val(p,l)=f.prepare();f.server.lostZip=true;rejects{f.backend.archive(p,l)};val originalPlan=p.journal.read().getString("planSHA256");val fresh=f.lease();assertEquals("verified",f.backend.resume(p.id,fresh).getString("status"));val j=DavJournal.reopen(p.journal.files,p.id).read();assertEquals(originalPlan,j.getString("planSHA256"));assertEquals(2,j.getJSONArray("attempts").length());assertEquals("failed",j.getJSONArray("attempts").getJSONObject(0).getString("status"));assertEquals(l.apiRevision,j.getJSONArray("attempts").getJSONObject(0).getString("apiRevision"));assertEquals(fresh.apiRevision,j.getJSONArray("attempts").getJSONObject(1).getString("apiRevision"))}finally{f.close()}}
    @Test fun changedTargetCannotResumeAndReadsNoCredential()= runBlocking {val f=Fixture();try{val(p,l)=f.prepare();val before=File(p.journal.dir,"journal.json").readBytes();val changed=f.target(rootURL="https://other.example.org/dav/");rejects{f.backend.resume(p.id,f.lease(changed))};assertTrue(f.keys.reads.isEmpty());assertTrue(f.server.calls.isEmpty());assertArrayEquals(before,File(p.journal.dir,"journal.json").readBytes())}finally{f.close()}}
    @Test fun sourceRoleAndStoredFilesMustStillMatchBeforeAnyCredential()= runBlocking {for(name in listOf("original.bin","attachment.zip","attachment.prop")){val f=Fixture();try{val(p,l)=f.prepare();File(p.journal.dir,name).appendBytes(byteArrayOf(0));rejects{f.backend.archive(p,l)};assertTrue(f.keys.reads.isEmpty());assertTrue(f.server.calls.isEmpty())}finally{f.close()}}}
    @Test fun credentialMutationDuringReadStopsBeforeHttp()= runBlocking {val f=Fixture();try{val(p,l)=f.prepare();f.keys.onLoad={f.current=false};assertEquals("stale",rejects{f.backend.archive(p,l)}.code);assertEquals(1,f.keys.reads.size);assertTrue(f.server.calls.isEmpty());assertTrue(f.server.blobs.isEmpty())}finally{f.close()}}
    @Test fun redirectNeverReceivesAnySecondRequestOrApiKey()= runBlocking {val f=Fixture();try{val(p,l)=f.prepare();f.server.redirect=true;assertEquals("redirect",rejects{f.backend.archive(p,l)}.code);assertEquals(1,f.server.calls.count{it.url.host!="api.zotero.org"});assertTrue(f.server.calls.none{it.url.host=="evil.example.org"})}finally{f.close()}}
    @Test fun persistedDavBackoffPreventsRepeatDavKeyRead()= runBlocking {val f=Fixture();try{val(p,l)=f.prepare();f.server.backoff=true;assertEquals("backoff",rejects{f.backend.archive(p,l)}.code);val reads=f.keys.reads.count{it.startsWith("zotero.webdav")};val cold=ZoteroDavBackend(f.root,f.keys,f.server,clock={f.time});assertEquals("backoff",rejects{cold.resume(p.id,f.lease())}.code);assertEquals(reads,f.keys.reads.count{it.startsWith("zotero.webdav")});f.time+=31_000;f.server.backoff=false;assertEquals("verified",cold.resume(p.id,f.lease()).getString("status"))}finally{f.close()}}
    @Test fun cancellationPreservesSameFilesAndNoApiPatch()=runBlocking {val f=Fixture();try{val(p,l)=f.prepare();val entered=CompletableDeferred<Unit>();f.server.onGet={entered.complete(Unit);awaitCancellation()};val job=launch{f.backend.archive(p,l)};entered.await();job.cancelAndJoin();assertTrue(job.isCancelled);assertEquals(0,f.server.patchCount);assertEquals("cancelled",p.journal.read().getString("status"));for(n in listOf("original.bin","attachment.zip","attachment.prop"))assertTrue(File(p.journal.dir,n).isFile);f.server.onGet={};assertEquals("verified",f.backend.resume(p.id,f.lease()).getString("status"))}finally{f.close()}}
    @Test fun deletedVerifiedRemoteZipIsNotResurrected()=runBlocking {val f=Fixture();try{val(p,l)=f.prepare();f.backend.archive(p,l);f.server.blobs.remove("/dav/zotero/ABCD2345.zip");assertEquals("conflict",rejects{f.backend.resume(p.id,f.lease())}.code);assertEquals(1,f.server.zipPuts);assertFalse(f.server.blobs.containsKey("/dav/zotero/ABCD2345.zip"))}finally{f.close()}}
    @Test fun journalFailureAfterRemoteWriteDoesNotRecaptureOrClaimZeroWrite()=runBlocking {val f=Fixture();try{val(p,l)=f.prepare();val journal=File(p.journal.dir,"journal.json");val retained=File(p.journal.dir,"prior-journal.json");f.server.afterZip={assertTrue(journal.renameTo(retained));assertTrue(journal.mkdir())};rejects{f.backend.archive(p,l)};assertEquals(1,f.server.zipPuts);assertTrue(journal.isDirectory);assertTrue(retained.isFile);assertTrue(journal.delete());assertTrue(retained.renameTo(journal));f.server.afterZip={};assertEquals("verified",ZoteroDavBackend(f.root,f.keys,f.server,clock={f.time}).resume(p.id,f.lease()).getString("status"));assertEquals(1,f.server.zipPuts)}finally{f.close()}}
    @Test fun api204WithoutMutationOrVersionIncreaseCannotVerify()=runBlocking {for(which in 0..1){val f=Fixture();try{val(p,l)=f.prepare();if(which==0)f.server.noPatchEffect=true else f.server.versionStuck=true;assertEquals("conflict",rejects{f.backend.archive(p,l)}.code);assertNotEquals("verified",p.journal.read().getString("status"))}finally{f.close()}}}
    @Test fun documentedDecimalStringMtimeNormalizesWithoutWeakeningVersion()=runBlocking {val f=Fixture();try{val(p,l)=f.prepare();f.server.stringMtime=true;assertEquals("verified",f.backend.archive(p,l).getString("status"))}finally{f.close()}}

    @Test fun invalidPresentBaseVersionNeverBecomesMissingOrRebased()=runBlocking {for(value in listOf<Any>(JSONObject.NULL,false,"1",-1,1.5)){val f=Fixture();try{val(p,_)=f.prepare();val file=File(p.journal.dir,"journal.json");val malformed=JSONObject(file.readText()).put("baseVersion",value).toString().toByteArray();file.writeBytes(malformed);rejects{ZoteroDavBackend(f.root,f.keys,f.server,clock={f.time}).resume(p.id,f.lease())};assertArrayEquals(malformed,file.readBytes());assertTrue(f.keys.reads.isEmpty());assertTrue(f.server.calls.isEmpty())}finally{f.close()}}}
    @Test fun wrongPreparedInstanceCannotUseAnotherBackendAuthorization()=runBlocking {val f=Fixture();try{val(p,l)=f.prepare();rejects{ZoteroDavBackend(f.root,f.keys,f.server,clock={f.time}).archive(p,l)};assertTrue(f.keys.reads.isEmpty());assertTrue(f.server.calls.isEmpty())}finally{f.close()}}
    @Test fun changedOriginalServerVersionBeforeFilesNeverStartsDavWrite()=runBlocking {val f=Fixture();try{val(p,l)=f.prepare();f.server.lostZip=true;rejects{f.backend.archive(p,l)};f.server.item.put("version",2);val before=f.server.calls.size;assertEquals("conflict",rejects{f.backend.resume(p.id,f.lease())}.code);assertEquals(1,f.server.zipPuts);assertTrue(f.server.calls.drop(before).all{it.url.host=="api.zotero.org"})}finally{f.close()}}

}
