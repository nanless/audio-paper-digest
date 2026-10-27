package com.nanless.paperdigest.zotero
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.secret.SecretStore
import kotlinx.coroutines.*
import okhttp3.Request
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest

class ZoteroCredentialServiceTest {
    private class Keys:SecretStore {var value="synthetic-current";var reads=0;var onLoad:(()->Unit)?=null;override fun load(scope:String):String{reads++;onLoad?.invoke();return value};override fun save(scope:String,secret:String){value=secret};override fun remove(scope:String){value=""}}
    private class Server:ZoteroTransport {
        val entered=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>();var gated=false;var groupGate=false;var writes=0;var calls=0;var deny=false;var backoff=false
        override suspend fun request(request:Request,limit:Int):HttpBytes {
            calls++;if(request.method!="GET")writes++
            val p=request.url.encodedPath
            if((gated&&p=="/keys/current")||(groupGate&&p=="/groups/456")){entered.complete(Unit);release.await()}
            if(deny)return HttpBytes(401,emptyMap(),ByteArray(0))
            val value=if(p=="/groups/456")JSONObject().put("id",456).put("data",JSONObject().put("owner",123).put("libraryEditing","admins").put("fileEditing","admins")) else JSONObject().put("userID",123).put("access",JSONObject().put("user",JSONObject().put("library",true).put("write",true).put("files",true).put("notes",true)).put("groups",JSONObject().put("all",JSONObject().put("library",true).put("write",true))))
            return HttpBytes(200,if(backoff)mapOf("Backoff" to "10")else emptyMap(),value.toString().toByteArray())
        }
        override suspend fun download(request:Request,target:File,limit:Long):HttpFile=error("No file transfer allowed")
    }
    private data class F(val root:File,val keys:Keys,val server:Server,val service:ZoteroService)
    private suspend fun fixture(group:Boolean=false):F {
        val root=Files.createTempDirectory("zotero-lease-").toFile().canonicalFile;val keys=Keys();val server=Server();val material=File(root,"synthetic.json").apply{writeText("{}")};val sha=MessageDigest.getInstance("SHA-256").digest(material.readBytes()).joinToString(""){"%02x".format(it.toInt()and 255)}
        val service=ZoteroService(File(root,"Research"),keys,ZoteroMaterialProvider{ZoteroMaterials("synthetic-paper","a".repeat(64),JSONObject().put("itemType","preprint").put("title","Synthetic only"),listOf(ZoteroMaterial("source-metadata","Synthetic","application/json",material,sha256=sha)))},server)
        service.execute("save",JSONObject().put("libraryType",if(group)"groups" else "users").put("libraryID",if(group)"456" else "123"));return F(root,keys,server,service)
    }
    private suspend fun F.close(){server.release.complete(Unit);root.deleteRecursively()}
    @Test fun mutationBeginningRetiresConfirmedBeforeAnyStoreAwait()=runBlocking{val f=fixture();try{f.service.execute("check");assertEquals("confirmed",f.service.state().getString("credentialState"));val token=f.service.beginCredentialMutation();assertEquals("unknown",f.service.state().getString("credentialState"));val before=f.keys.reads;try{f.service.execute("check");fail("pending mutation checked")}catch(_:ZoteroCredentialSuperseded){};assertEquals(before,f.keys.reads);f.service.endCredentialMutation(token);assertEquals("unknown",f.service.state().getString("credentialState"));f.service.execute("check");assertEquals("confirmed",f.service.state().getString("credentialState"))}finally{f.close()}}
    @Test fun delayedGroupSecondAwaitCannotPublishOldPermission()=runBlocking{val f=fixture(true);try{f.server.groupGate=true;val old=async{f.service.execute("check")};f.server.entered.await();val token=f.service.beginCredentialMutation();f.keys.save("zotero.primary","synthetic-new");f.service.credentialsChanged();f.service.endCredentialMutation(token);f.server.release.complete(Unit);assertEquals("unknown",old.await().getString("credentialState"));assertEquals("unknown",f.service.state().getString("credentialState"));assertEquals(0,f.server.writes)}finally{f.close()}}
    @Test fun invalidationDuringSecretLoadStopsBeforeTransport()=runBlocking{val f=fixture();try{f.keys.onLoad={f.service.credentialsChanged()};val result=f.service.execute("check");assertEquals("unknown",result.getString("credentialState"));assertEquals(0,f.server.calls);assertFalse(f.service.state().getBoolean("busy"))}finally{f.close()}}
    @Test fun stateResultCannotMutateStoredPermission()=runBlocking{val f=fixture();try{val result=f.service.execute("check");result.getJSONObject("permissions").put("write",false);assertTrue(f.service.state().getJSONObject("permissions").getBoolean("write"))}finally{f.close()}}
    @Test fun twoPendingMutationsKeepServiceUnavailableUntilBothFinish()=runBlocking{val f=fixture();try{val first=f.service.beginCredentialMutation();val second=f.service.beginCredentialMutation();f.service.endCredentialMutation(first);val reads=f.keys.reads;try{f.service.execute("check");fail("second still pending")}catch(_:ZoteroCredentialSuperseded){};assertEquals(reads,f.keys.reads);f.service.endCredentialMutation(second);f.service.execute("check");assertEquals("confirmed",f.service.state().getString("credentialState"))}finally{f.close()}}
    @Test fun staleSuccessfulResponseStillPreservesServerCooldown()=runBlocking{val f=fixture();try{f.server.gated=true;f.server.backoff=true;val old=async{f.service.execute("check")};f.server.entered.await();f.service.credentialsChanged();f.server.release.complete(Unit);assertEquals("unknown",old.await().getString("credentialState"));val profile=File(f.root,"Research/ZoteroConnection/connection.json");val bytes=profile.readBytes();assertTrue(JSONObject(String(bytes)).getLong("backoffUntil")>System.currentTimeMillis());val calls=f.server.calls;try{f.service.execute("check");fail("backoff reset")}catch(e:AppFailure){assertEquals("backoff",e.category)};assertEquals(calls,f.server.calls);assertArrayEquals(bytes,profile.readBytes())}finally{f.close()}}
    @Test fun archiveStillAuthenticatesNewKeyAndPreservesOriginalFilesAndIDs()=runBlocking{val f=fixture();try{val id=f.service.execute("prepare").getString("preparedID");val op=File(f.root,"Research/ZoteroArchives/$id");val originals=op.listFiles()!!.filter{it.name!="journal.json"}.associate{it.name to it.readBytes()};f.server.gated=true;val old=async{f.service.execute("check")};f.server.entered.await();val token=f.service.beginCredentialMutation();f.keys.save("zotero.primary","synthetic-denied");f.service.credentialsChanged();f.service.endCredentialMutation(token);f.server.release.complete(Unit);assertEquals("unknown",old.await().getString("credentialState"));f.server.deny=true;try{f.service.execute("archive",JSONObject().put("preparedID",id));fail("bad key accepted")}catch(e:AppFailure){assertEquals("authentication",e.category)};assertEquals(0,f.server.writes);for((name,bytes)in originals)assertArrayEquals(bytes,File(op,name).readBytes());val journal=JSONObject(File(op,"journal.json").readText());assertEquals(id,journal.getString("id"));assertEquals("failed",journal.getString("status"))}finally{f.close()}}
}
