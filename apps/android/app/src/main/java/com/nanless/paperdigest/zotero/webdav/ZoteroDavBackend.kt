package com.nanless.paperdigest.zotero.webdav

import com.nanless.paperdigest.secret.SecretStore
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.Credentials
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** File-attachment backend only. Native ZoteroService still creates the new parent/attachment and inline notes. */
class ZoteroDavBackend internal constructor(root:File,private val secrets:SecretStore,delegate:DavWireTransport,available:()->Long,private val clock:()->Long,directorySync:(File)->Unit) {
    internal constructor(root:File,secrets:SecretStore,delegate:DavWireTransport,available:()->Long={root.usableSpace},clock:()->Long=System::currentTimeMillis):this(root,secrets,delegate,available,clock,DavFiles::syncDirectory)
    private val codec=ZoteroDavCodec(root,available,directorySync)
    private val backoff=DavBackoff(codec.files,clock)
    private val guardedSecrets=object:SecretStore {
        override fun load(scope:String):String? {davRequire(scope=="zotero.primary"||scope.startsWith("zotero.webdav."),"identity");backoff.before(scope=="zotero.primary");return secrets.load(scope)}
        override fun save(scope:String,secret:String){throw ZoteroDavFailure("permission")}
        override fun remove(scope:String){throw ZoteroDavFailure("permission")}
    }
    private val transport=object:DavWireTransport {
        override suspend fun exchange(request:Request,limit:Long,reply:DavReplyFile?,check:()->Unit):DavWireReply {
            val api=request.url.host=="api.zotero.org";backoff.before(api)
            return delegate.exchange(request,limit,reply,check).also{backoff.record(api,it.code,it.headers)}
        }
    }
    private val api=ZoteroDavApiPort(guardedSecrets,this.transport)
    private val mutex=Mutex()
    private val preparedLeases=java.util.IdentityHashMap<ZoteroDavPrepared,ZoteroDavLease>()
    suspend fun prepare(material:ZoteroDavAttachment,lease:ZoteroDavLease):ZoteroDavPrepared=withContext(Dispatchers.IO){
        val context=currentCoroutineContext();val check={context.ensureActive();lease.requireCurrent()}
        try{val result=codec.prepare(material,lease.target,check);check();synchronized(preparedLeases){preparedLeases[result]=lease};result}catch(e:Exception){throw safe(e)}
    }
    suspend fun archive(prepared:ZoteroDavPrepared,lease:ZoteroDavLease):JSONObject=mutex.withLock{
        davRequire(synchronized(preparedLeases){preparedLeases[prepared]===lease},"stale")
        try{run(prepared,lease)}finally{synchronized(preparedLeases){preparedLeases.remove(prepared)}}
    }
    /** Only an explicit same-target resume can get a fresh credential attempt; no key mutation calls this. */
    suspend fun resume(id:String,lease:ZoteroDavLease):JSONObject=mutex.withLock{
        val context=currentCoroutineContext();val check={context.ensureActive();lease.requireCurrent()}
        val prepared=try{withContext(Dispatchers.IO){codec.reopen(id,lease.target,check)}}catch(e:Exception){throw safe(e)}
        run(prepared,lease)
    }
    private suspend fun run(prepared:ZoteroDavPrepared,lease:ZoteroDavLease):JSONObject=withContext(Dispatchers.IO){
        val context=currentCoroutineContext();val check={context.ensureActive();lease.requireCurrent();prepared.journal.checkDirectory()}
        val j=prepared.journal
        var attempt:String?=null
        try{
            val plan=codec.verify(prepared,lease.target,check)
            // Authenticate the actual API user+library+permissions before issuing any new attempt or DAV write.
            api.authenticate(lease,check);check()
            val id=UUID.randomUUID().toString();attempt=id
            j.update{state->state.getJSONArray("attempts").put(JSONObject().put("id",id).put("apiRevision",lease.apiRevision).put("davRevision",lease.davRevision).put("epoch",lease.epoch).put("startedAt",java.time.Instant.ofEpochMilli(clock()).toString()).put("status","running"));state.put("status","running")}
            val first=api.read(lease,plan,check);val state=j.read();val base=if(state.has("baseVersion"))strictLong(state.opt("baseVersion"))?:throw ZoteroDavFailure("journalChanged") else null
            if(base==null){davRequire(first.md5==null&&first.mtime==null,"conflict");j.update{it.put("baseVersion",first.version)}}
            else if(first.md5==null)davRequire(first.version==base,"conflict")
            else davRequire(j.read().optString("phase") in setOf("api-patch-planned","api-verified","completed")&&matches(first,plan)&&first.version>base,"conflict")
            ensureBlob(j,plan,lease,"zip",check);ensureBlob(j,plan,lease,"prop",check)
            check();val before=api.read(lease,plan,check);val originalVersion=j.read().getLong("baseVersion")
            if(!matches(before,plan)){
                davRequire(before.md5==null&&before.mtime==null&&before.version==originalVersion,"conflict")
                j.update{it.put("phase","api-patch-planned")};check()
                api.patch(lease,plan,originalVersion,check)
            }else davRequire(j.read().optString("phase") in setOf("api-patch-planned","api-verified","completed")&&before.version>originalVersion,"conflict")
            val finalAPI=api.read(lease,plan,check)
            davRequire(matches(finalAPI,plan)&&finalAPI.version>originalVersion,"conflict")
            j.update{it.put("phase","api-verified").put("verifiedApiVersion",finalAPI.version)}
            // API metadata is not enough: actual DAV objects must still match after that write.
            readBlob(j,plan,lease,"zip",check).also{davRequire(it,"conflict")}
            readBlob(j,plan,lease,"prop",check).also{davRequire(it,"conflict")}
            val last=api.read(lease,plan,check);davRequire(last==finalAPI&&matches(last,plan),"conflict")
            codec.verify(prepared,lease.target,check);check()
            j.update{it.put("phase","completed").put("status","verified");lastAttempt(it,id).put("status","verified").put("endedAt",java.time.Instant.ofEpochMilli(clock()).toString()).put("apiVersion",last.version)}
            JSONObject().put("journalID",j.id).put("status","verified").put("apiMetadataVerified",true).put("davBytesVerified",true).put("officialClientsOpened",false)
        }catch(e:Exception){
            val status=if(e is CancellationException)"cancelled" else "failed"
            withContext(NonCancellable){runCatching{j.update{it.put("status",status);attempt?.let{id->lastAttempt(it,id).put("status",status).put("endedAt",java.time.Instant.ofEpochMilli(clock()).toString()).put("errorCode",if(e is ZoteroDavFailure)e.code else status)}}}}
            throw safe(e)
        }
    }
    private fun matches(item:ZoteroDavApiPort.Item,plan:JSONObject):Boolean {val f=plan.getJSONObject("file");return item.md5==f.getString("md5")&&item.mtime==f.getLong("mtime")}
    private fun lastAttempt(j:JSONObject,id:String):JSONObject {val a=j.getJSONArray("attempts");davRequire(a.length()>0&&a.getJSONObject(a.length()-1).getString("id")==id,"journalChanged");return a.getJSONObject(a.length()-1)}
    private suspend fun ensureBlob(j:DavJournal,plan:JSONObject,lease:ZoteroDavLease,kind:String,check:()->Unit){
        if(readBlob(j,plan,lease,kind,check))return
        davRequire(!j.read().optBoolean("${kind}Verified"),"conflict") // Do not revive a file the user deleted after verification.
        j.update{it.put("phase","$kind-put-planned")};check()
        val key=plan.getJSONObject("attachment").getString("key");val fact=plan.getJSONObject(kind)
        val file=codec.files.named(j.dir,if(kind=="zip")"attachment.zip" else "attachment.prop")
        val auth=davAuthorization(lease,check)
        val request=Request.Builder().url(lease.target.davURL(key,kind)).header("Authorization",auth).header("If-None-Match","*").header("User-Agent","audio-paper-digest/1.0")
            .put(DavFileBody(file,fact.getLong("bytes"),fact.getString("sha256"),if(kind=="zip")"application/zip" else "text/xml",check)).build()
        val response=transport.exchange(request,4096,check=check);check()
        davRequire(response.code in setOf(200,201,204,412),httpCode(response.code))
        davRequire(readBlob(j,plan,lease,kind,check),"conflict")
    }
    private suspend fun readBlob(j:DavJournal,plan:JSONObject,lease:ZoteroDavLease,kind:String,check:()->Unit):Boolean{
        check();val key=plan.getJSONObject("attachment").getString("key");val fact=plan.getJSONObject(kind)
        val auth=davAuthorization(lease,check);val request=Request.Builder().url(lease.target.davURL(key,kind)).header("Authorization",auth).header("User-Agent","audio-paper-digest/1.0").get().build()
        val reply=if(kind=="zip")DavReplyFile(j,codec.files.named(j.dir,"readback-${UUID.randomUUID()}.zip")) else null
        try{
            val response=transport.exchange(request,if(kind=="zip")ZoteroDavCodec.MAX_ZIP else 4096,reply,check);check()
            if(response.code==404)return false
            davRequire(response.code==200,httpCode(response.code))
            davRequire(response.bytes==fact.getLong("bytes")&&response.sha256==fact.getString("sha256"),"conflict")
            if(kind=="zip")ZoteroDavCodec.verifyZip(reply!!.file,plan.getJSONObject("attachment").getString("filename"),plan.getJSONObject("file"),check)
            else {val p=ZoteroDavCodec.parseProperties(response.body);davRequire(p.first==plan.getJSONObject("file").getLong("mtime")&&p.second==plan.getJSONObject("file").getString("md5"),"conflict")}
            j.update{it.put("${kind}Verified",true)};return true
        }finally{reply?.cleanup()}
    }
    private fun davAuthorization(lease:ZoteroDavLease,check:()->Unit):String{
        check();lease.requireCurrent();val secret=try{guardedSecrets.load(lease.target.secretScope)}catch(e:Exception){if(e is CancellationException||e is ZoteroDavFailure)throw e;throw ZoteroDavFailure("authentication")}
        check();lease.requireCurrent();davRequire(!secret.isNullOrBlank()&&secret.toByteArray().size<=8192&&Charsets.UTF_8.newEncoder().canEncode(secret)&&!secret.any{it.code<32||it.code==127},"authentication")
        return try{Credentials.basic(lease.target.username,secret?:throw ZoteroDavFailure("authentication"),Charsets.UTF_8)}catch(_:Exception){throw ZoteroDavFailure("authentication")}
    }
    companion object {
        fun network(root:File,secrets:SecretStore):ZoteroDavBackend=ZoteroDavBackend(root,secrets,ZoteroDavNetworkTransport())
        private fun safe(e:Exception):Exception=if(e is CancellationException||e is ZoteroDavFailure)e else ZoteroDavFailure("storage")
    }
}
