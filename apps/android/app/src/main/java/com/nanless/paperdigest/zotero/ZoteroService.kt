package com.nanless.paperdigest.zotero

import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.secret.SecretStore
import com.nanless.paperdigest.zotero.webdav.ZoteroDavBackend
import com.nanless.paperdigest.zotero.webdav.ZoteroDavTarget
import com.nanless.paperdigest.zotero.webdav.ZoteroDavLease
import com.nanless.paperdigest.zotero.webdav.ZoteroDavAuthorization
import com.nanless.paperdigest.zotero.webdav.ZoteroDavStorageAdoption
import com.nanless.paperdigest.zotero.webdav.ZoteroDavAttachment
import com.nanless.paperdigest.zotero.webdav.ZoteroDavCodec
import com.nanless.paperdigest.zotero.webdav.DavFiles
import com.nanless.paperdigest.zotero.webdav.DavBackoff
import kotlinx.coroutines.*
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.FormBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.security.MessageDigest
import java.util.UUID

interface ZoteroTransport {
    suspend fun request(request:Request,limit:Int=4*1024*1024):HttpBytes
    suspend fun download(request:Request,target:File,limit:Long):HttpFile
    /** Reports the native-created inode before publication, including cancellation before return. */
    suspend fun downloadOwned(request:Request,target:File,limit:Long,owned:(ZoteroOwnedFileReceipt)->Unit):HttpFile=error("此传输未提供临时文件所有权回执")
}
class NetworkZoteroTransport:ZoteroTransport by ZoteroDrainedTransport()

/** Web API credentials stay outside research backups. Original materials and journals are fully backed up. */
class ZoteroService(
    private val researchRoot:File, private val secrets:SecretStore, private val provider:ZoteroMaterialProvider,
    private val transport:ZoteroTransport=NetworkZoteroTransport(),
    private val clock:()->Long=System::currentTimeMillis,
    private val sleep:suspend(Long)->Unit={delay(it)},
    private val davFactory:(File,SecretStore)->ZoteroDavBackend={ root, keys -> ZoteroDavBackend.network(root,keys) },
    private val migrationFiles:ZoteroOwnedDownloadFiles=AndroidZoteroOwnedDownloadFiles,
) {
    private val mutex=Mutex()
    private val profile=File(researchRoot,"ZoteroConnection/connection.json")
    private val legacyProfile=File(researchRoot.parentFile,"PaperDigestZotero/connection.json")
    private val workerGate=Any()
    private data class MutationBinding(val target:String,val workspace:Any)
    @Volatile private var workspaceIdentity=Any()
    private val ownedMutations=java.util.IdentityHashMap<ZoteroCredentialMutation,MutationBinding>()
    @Volatile private var confirmedAPIFilePermission=false
    private val workers=java.util.IdentityHashMap<Job,Boolean>()
    @Volatile private var apiRevision=UUID.randomUUID().toString()
    @Volatile private var davRevision=UUID.randomUUID().toString()
    @Volatile private var credentialEpoch=0L
    private val records=File(researchRoot,"ZoteroArchives").also{it.mkdirs()}
    private val credentialLease=ZoteroCredentialLease()
    private data class CredentialOperation(val lease:ZoteroCredentialLease.Check,val target:String)
    private var credentialOperation:CredentialOperation?=null
    @Volatile private var busy=false
    @Volatile private var prepared:JSONObject?=null
    fun beginCredentialMutation():ZoteroCredentialMutation=synchronized(workerGate){beginCredentialMutationLocked(null)}
    private fun beginCredentialMutationLocked(preserve:MigrationPreview?):ZoteroCredentialMutation {
        retireMigrationAuthorities(preserve)
        val binding=MutationBinding(credentialTarget(connection()),workspaceIdentity);val token=credentialLease.beginMutation();ownedMutations[token]=binding;confirmedAPIFilePermission=false;apiRevision=UUID.randomUUID().toString();davRevision=UUID.randomUUID().toString();credentialEpoch++;prepared=null;return token
    }
    suspend fun cancelAndDrain(){
        val original=synchronized(workerGate){workers.keys.toList()}
        withContext(NonCancellable){original.forEach{it.cancel()};original.forEach{it.join()}}
    }
    fun webdavSecretScope():String=davTarget(validatedConnection()).secretScope
    fun workspaceRestored(){synchronized(workerGate){workspaceIdentity=Any();credentialsChanged();prepared=null}}

    suspend fun <T> withCredentialMutation(token:ZoteroCredentialMutation,write:suspend()->T):T=mutex.withLock {
        requireCredentialMutation(token)
        write()
    }
    fun requireCredentialMutation(token:ZoteroCredentialMutation){synchronized(workerGate){
        val binding=ownedMutations[token]?:throw ZoteroCredentialSuperseded()
        if(binding.workspace!==workspaceIdentity||binding.target!=credentialTarget(connection()))throw ZoteroCredentialSuperseded()
    }}
    fun endCredentialMutation(token:ZoteroCredentialMutation){synchronized(workerGate){check(ownedMutations.remove(token)!=null);credentialLease.endMutation(token)}}
    fun credentialsChanged(){synchronized(workerGate){retireMigrationAuthorities();credentialLease.changed();confirmedAPIFilePermission=false;apiRevision=UUID.randomUUID().toString();davRevision=UUID.randomUUID().toString();credentialEpoch++;prepared=null}}
    private fun credentialTarget(c:JSONObject)=listOf("destinationID","libraryType","libraryID","collection","attachmentBackend","davBaseURL","davUsername","davDestinationID","davAccountID").joinToString("\u0000"){c.optString(it)}
    private fun requireCredentialCurrent(){
        migrationOperationGuard?.invoke()
        credentialOperation?.let{operation->credentialLease.requireCurrent(operation.lease);if(operation.target!=credentialTarget(connection()))throw ZoteroCredentialSuperseded()}
    }
    /** Re-project captured Root views at publication time; never trust their old permission fields. */
    fun projectCredentialState(view:JSONObject):JSONObject {
        val result=view.copy()
        val target=listOf("libraryType","libraryID","collection","attachmentBackend","davBaseURL","davUsername","davDestinationID","davAccountID").joinToString("\u0000"){view.optString(it)}
        val verifiedAt=credentialLease.confirmedAtView(target)
        val permission=verifiedAt?.let{JSONObject().put("verifiedAt",it).put("library",true).put("write",true).put("files",confirmedAPIFilePermission).put("notes",true)}
        return projectBorrowedState(result.put("credentialState",if(permission==null)"unknown" else "confirmed").put("permissions",permission ?: JSONObject.NULL))
    }
    private fun projectBorrowedState(view:JSONObject):JSONObject {
        val current=connection();val borrowed=current.optString("davCredentialSource")=="saved-cloud"&&backend(current)=="webdav"
        val fields=listOf("libraryType","libraryID","collection","attachmentBackend","davBaseURL","davUsername","davDestinationID","davAccountID")
        val same=fields.all{view.optString(it)==current.optString(it)}
        val granted=if(!borrowed||!same)false else runCatching{
            val target=davTarget(current)
            val snapshot=synchronized(workerGate){Triple(credentialEpoch,migrationGeneration,migrationAuthorizations.values.toList())}
            snapshot.third.any{authorization->runCatching{
                authorization.requirePublished(target)
                synchronized(workerGate){snapshot.first==credentialEpoch&&snapshot.second==migrationGeneration&&migrationAuthorizations.values.any{it===authorization}&&credentialTarget(current)==credentialTarget(connection())}
            }.getOrDefault(false)}
        }.getOrDefault(false)
        return view.put("davCredentialSource",if(borrowed&&same)"saved-cloud"else"independent").put("borrowedCredentialState",if(borrowed&&same){if(granted)"granted"else"confirmation-required"}else"not-applicable")
    }
    private fun checkedDirectory(dir:File){
        var part:File?=dir.absoluteFile;while(part!=null){require(!Files.isSymbolicLink(part.toPath())){"连接目录不能含链接"};part=part.parentFile}
        if(!dir.exists())require(dir.mkdir()){"无法保存 Zotero 连接"}
        require(Files.isDirectory(dir.toPath(),NOFOLLOW_LINKS)){"连接目录无效"}
    }
    private fun readConfig(file:File):JSONObject {checkedDirectory(file.parentFile);require(!Files.isSymbolicLink(file.toPath())&&Files.isRegularFile(file.toPath(),NOFOLLOW_LINKS)&&file.length()<=1024*1024){"连接配置无效"};return JSONObject(JsonFiles.read(file).toString(Charsets.UTF_8))}
    /** Legacy connection files are not a credential source: rebuild only known, typed non-secret fields. */
    private fun legacyConnection():JSONObject {
        if(!Files.exists(legacyProfile.toPath(),NOFOLLOW_LINKS))return JSONObject().put("destinationID",UUID.randomUUID().toString())
        val old=readConfig(legacyProfile);val result=JSONObject()
        fun uuid(value:String)=runCatching{UUID.fromString(value).toString()==value}.getOrDefault(false)
        val destination=old.getString("destinationID");require(uuid(destination)){"原 Zotero 目标身份无效"};result.put("destinationID",destination)
        if(old.has("libraryType")){val type=old.getString("libraryType");require(type in setOf("users","groups"));result.put("libraryType",type)}
        if(old.has("libraryID")){val id=old.getString("libraryID");require(id.isEmpty()||id.matches(Regex("[1-9][0-9]{0,15}")));result.put("libraryID",id)}
        if(old.has("collection")){val collection=old.getString("collection");require(collection.isEmpty()||validKey(collection));result.put("collection",collection)}
        if(old.has("backoffUntil")){val wait=old.get("backoffUntil");require((wait is Int||wait is Long)&&(wait as Number).toLong()>=0);result.put("backoffUntil",wait)}
        old.optJSONObject("destinations")?.let{known->val copied=JSONObject();known.keys().forEach{key->val id=known.getString(key);require(key.matches(Regex("(users|groups):[1-9][0-9]{0,15}"))&&uuid(id));copied.put(key,id)};result.put("destinations",copied)}
        return result
    }
    @Synchronized private fun connection():JSONObject {
        checkedDirectory(profile.parentFile)
        if(Files.exists(profile.toPath(),NOFOLLOW_LINKS))return readConfig(profile)
        val c=legacyConnection()
        c.put("attachmentBackend","storage");JsonFiles.write(profile,c);return c
    }
    private fun backend(c:JSONObject)=c.optString("attachmentBackend","storage").also{require(it in setOf("storage","webdav")){"未知附件后端"}}
    private fun davTarget(c:JSONObject):ZoteroDavTarget {
        require(backend(c)=="webdav"){"请先明确保存 WebDAV 附件连接"}
        return ZoteroDavTarget.native(c.getString("libraryType"),c.getString("libraryID"),c.getString("davBaseURL"),c.getString("davUsername"),c.getString("davDestinationID"),c.getString("davAccountID"))
    }
    private fun targetBinding(c:JSONObject):JSONObject=if(backend(c)=="webdav")davTarget(c).binding() else JSONObject().put("backend","storage")
    private fun sameBackend(a:JSONObject,b:JSONObject)=backend(a)==backend(b)&&(backend(a)=="storage"||canonical(a.optJSONObject("davTarget"))==canonical(targetBinding(b)))
    private fun davRoot():File {checkedDirectory(researchRoot);return File(researchRoot,"ZoteroDavArchives")}
    private fun davLease(c:JSONObject):ZoteroDavLease {
        val operation=credentialOperation?:throw ZoteroCredentialSuperseded();val target=credentialTarget(c)
        return ZoteroDavLease.native(davTarget(c),apiRevision,davRevision,credentialEpoch){runCatching{credentialLease.requireCurrent(operation.lease);operation.target==target&&target==credentialTarget(connection())}.getOrDefault(false)}
    }
    private suspend fun saveConnection(payload:JSONObject):JSONObject {
        val token=beginCredentialMutation()
        try {cancelAndDrain();return withCredentialMutation(token) {
            val c=connection();val type=payload.optString("libraryType","users");val id=payload.optString("libraryID");val collection=payload.optString("collection");val selectedBackend=payload.optString("attachmentBackend","storage")
            require(type in setOf("users","groups")&&id.matches(Regex("[1-9][0-9]{0,15}"))){"请输入真实 Zotero 文库 ID"}
            require(selectedBackend in setOf("storage","webdav")){"请选择附件后端"};require(collection.isEmpty()||validKey(collection)){"分类 key 应为 8 位 Zotero key"}
            if(c.optString("libraryType")!=type||c.optString("libraryID")!=id){
                val known=c.optJSONObject("destinations")?:JSONObject()
                if(c.optString("libraryID").isNotEmpty())known.put("${c.optString("libraryType")}:${c.optString("libraryID")}",c.getString("destinationID"))
                val target="$type:$id";val destination=known.optString(target).takeIf{it.isNotBlank()}?:UUID.randomUUID().toString()
                known.put(target,destination);c.put("destinations",known).put("destinationID",destination)
            }
            c.put("libraryType",type).put("libraryID",id).put("collection",collection).put("attachmentBackend",selectedBackend);c.remove("davCredentialSource")
            if(selectedBackend=="webdav"){
                val base=payload.getString("davBaseURL");val username=payload.getString("davUsername")
                val provisional=ZoteroDavTarget.native(type,id,base,username,UUID.randomUUID().toString(),UUID.randomUUID().toString())
                val identity=canonical(JSONObject().put("user",id).put("root",provisional.root).put("username",username))
                val destinations=c.optJSONObject("davDestinations")?:JSONObject();val stored=destinations.optJSONObject(identity)?:JSONObject().put("destinationID",UUID.randomUUID().toString()).put("accountID",UUID.randomUUID().toString())
                destinations.put(identity,stored);c.put("davDestinations",destinations).put("davBaseURL",base).put("davUsername",username).put("davDestinationID",stored.getString("destinationID")).put("davAccountID",stored.getString("accountID"));davTarget(c)
            } else listOf("davBaseURL","davUsername","davDestinationID","davAccountID").forEach{c.remove(it)}
            require(!Files.isSymbolicLink(profile.toPath()));JsonFiles.write(profile,c);state()
        }} finally{endCredentialMutation(token)}
    }
    fun state():JSONObject {
        val c=connection()
        val result=JSONObject().put("macHistory", LegacyMacArchiveHistory.read(researchRoot)).put("libraryType",c.optString("libraryType","users")).put("libraryID",c.optString("libraryID")).put("collection",c.optString("collection"))
            .put("attachmentBackend",backend(c)).put("davBaseURL",c.optString("davBaseURL")).put("davUsername",c.optString("davUsername")).put("davDestinationID",c.optString("davDestinationID")).put("davAccountID",c.optString("davAccountID"))
            .put("prepared",prepared ?: JSONObject.NULL).put("busy",busy)
            .put("journals",JSONArray(records.listFiles()?.filter{it.isDirectory}?.mapNotNull{dir->runCatching{readJournal(dir.name).apply{remove("bibliography");remove("roles")}}.getOrNull()}?.sortedByDescending{it.optString("createdAt")}?:emptyList<JSONObject>()))
        val verifiedAt=credentialLease.confirmedAt(credentialTarget(c))
        val permission=verifiedAt?.let{JSONObject().put("verifiedAt",it).put("library",true).put("write",true).put("files",confirmedAPIFilePermission).put("notes",true)}
        return projectBorrowedState(result.put("credentialState",if(permission==null)"unknown" else "confirmed").put("permissions",permission ?: JSONObject.NULL))
    }
    suspend fun execute(command:String,payload:JSONObject=JSONObject()):JSONObject {
        if(command in listOf("state","zotero.state"))return state()
        if(command.removePrefix("zotero.")=="save")return saveConnection(payload)
        return coroutineScope {
            val worker=currentCoroutineContext()[Job]?:error("缺少原生操作")
            synchronized(workerGate){credentialLease.capture();workers[worker]=true}
            try {mutex.withLock {
            val network=command.removePrefix("zotero.") in setOf("check","collections","prepare","archive","resume")
            credentialOperation=if(network)CredentialOperation(credentialLease.capture(),credentialTarget(connection()))else null
            busy=true
            try { when(command.removePrefix("zotero.")) {
                "check"->{try{check()}catch(_:ZoteroCredentialSuperseded){ /* An obsolete read cannot confirm the new credential. */ };state()}
                "collections"->{val c=validatedConnection();check();val all=mutableListOf<JSONObject>();var start=0
                    while(true){val result=api("GET","/${c.getString("libraryType")}/${c.getString("libraryID")}/collections?format=json&limit=100&start=$start");val rows=JSONArray(result.bytes.toString(Charsets.UTF_8));for(i in 0 until rows.length())all+=rows.getJSONObject(i);if(rows.length()<100)break;start+=100;require(start<=10000){"分类数量超过安全读取上限"}}
                    JSONObject().put("collections",JSONArray(all))}
                "prepare"->prepare(payload)
                "archive","resume"->archive(payload.optString("journalID",payload.optString("preparedID")))
                else->throw IllegalArgumentException("未知 Zotero 操作")
            } } finally{credentialOperation=null;busy=false}
            }} finally{synchronized(workerGate){workers.remove(worker)}}
        }
    }
    private val migrationStore=ZoteroStorageMigrationStore(researchRoot,migrationFiles)
    private class MigrationPreview(val id:String,val parentID:String,val target:ZoteroDavTarget,val workspace:Any,val config:String,val epoch:Long,val generation:Long,val lease:ZoteroCredentialLease.Check){
        var authorization:ZoteroDavAuthorization?=null
        var parent:MigrationParent?=null
        var result:ZoteroStorageReadOnlyVerifier.Result?=null
        var confirming=false
        var childID:String?=null
        var confirmedEpoch:Long?=null
    }
    private val migrationPreviews=mutableMapOf<String,MigrationPreview>()
    private val migrationAuthorizations=mutableMapOf<String,ZoteroDavAuthorization>()
    private val borrowedWorkers=java.util.IdentityHashMap<Job,Boolean>()
    private var migrationGeneration=0L
    private var migrationOperationGuard:(()->Unit)?=null
    private fun retireMigrationAuthorities(preserve:MigrationPreview?=null){
        migrationPreviews.clear();migrationAuthorizations.clear()
        if(preserve==null)migrationGeneration++ else migrationPreviews[preserve.id]=preserve
    }
    /** Synchronous revocation precedes any Cloud/profile mutation; joining is deliberately separate. */
    fun revokeBorrowedStorageMigrations(){synchronized(workerGate){retireMigrationAuthorities()}}
    suspend fun cancelAndDrainBorrowed(){
        val original=synchronized(workerGate){borrowedWorkers.keys.toList()}
        withContext(NonCancellable){original.forEach{it.cancel()};original.forEach{it.join()}}
    }
    /** Local target registration only. Root issues its original unpublished consent grant before preview awaits. */
    fun beginStorageMigrationPreview(parentID:String,baseURL:String,username:String):String=synchronized(workerGate){
        require(UUID.fromString(parentID).toString()==parentID)
        val c=validatedConnection();require(c.getString("libraryType")=="users"){"附件迁移仅支持个人文库"}
        val candidate=ZoteroDavTarget.native("users",c.getString("libraryID"),baseURL,username,UUID.randomUUID().toString(),UUID.randomUUID().toString())
        // An interrupted local publication must retain its original child target IDs.
        val child=migrationStore.childForParent(parentID)?.let{migrationStore.openChild(it)}
        val identity=canonical(JSONObject().put("user",candidate.userID).put("root",candidate.root).put("username",username))
        val known=c.optJSONObject("davDestinations")?.optJSONObject(identity)
        val target=child?.target?:if(backend(c)=="webdav")davTarget(c)else known?.let{ZoteroDavTarget.native("users",candidate.userID,baseURL,username,it.getString("destinationID"),it.getString("accountID"))}?:candidate
        require(target.root==candidate.root&&target.username==username&&target.userID==candidate.userID){"请恢复该迁移记录的原附件连接"}
        val id=UUID.randomUUID().toString();migrationPreviews[id]=MigrationPreview(id,parentID,target,workspaceIdentity,credentialTarget(c),credentialEpoch,migrationGeneration,credentialLease.capture());id
    }
    fun migrationTarget(previewID:String):ZoteroDavTarget=synchronized(workerGate){
        val p=migrationPreviews[previewID]?:throw ZoteroCredentialSuperseded();requirePreviewCurrent(p);p.target
    }
    private fun requirePreviewCurrent(p:MigrationPreview){synchronized(workerGate){
        if(migrationPreviews[p.id]!==p||p.workspace!==workspaceIdentity||p.config!=credentialTarget(connection())||p.epoch!=credentialEpoch||p.generation!=migrationGeneration)throw ZoteroCredentialSuperseded()
        credentialLease.requireCurrent(p.lease);p.authorization?.requireCurrent(p.target)
    }}
    private fun parentMatchesConnection(parent:MigrationParent){
        val j=parent.header();val c=validatedConnection()
        require(listOf("destinationID","libraryType","libraryID","collection").all{j.optString(it)==c.optString(it)}){"原存档属于另一文库或分类，未迁移"}
    }
    private fun verifier(parent:MigrationParent):ZoteroStorageReadOnlyVerifier {
        val base="/users/${parent.header().getString("libraryID")}/items"
        return ZoteroStorageReadOnlyVerifier(researchRoot,migrationStore,{key,optional->
            val r=api("GET","$base/$key?format=json",allow404=optional)
            if(r.code==404)null else JSONObject(r.bytes.toString(Charsets.UTF_8))
        },{key,target,limit,check,owned->
            var request=apiRequest("GET","$base/$key/file",null,emptyMap());var redirects=0
            while(true){
                check();requireCredentialCurrent();val origin=request.url.host=="api.zotero.org";if(origin)beforeApi()
                val response=transport.downloadOwned(request,target,limit,owned);currentCoroutineContext().ensureActive();check()
                if(origin)acceptApi(response.code,response.headers,allowRedirect=true)else{cooldown(response.code,response.headers);requireCredentialCurrent();if(response.code==429)throw AppFailure("backoff","附件服务要求等待，原断点保留")}
                if(response.code in 300..399){require(redirects++<5){"附件重定向过多"};val location=response.headers.entries.firstOrNull{it.key.equals("Location",true)}?.value?:error("缺少附件地址");val resolved=request.url.resolve(location)?.toString()?:error("无效附件地址");safeExternal(resolved);request=Request.Builder().url(resolved).get().build();continue}
                require(response.code==200&&response.bytes==limit){"Storage 原附件未完整回读"};check();break
            }
        })
    }
    private fun migrationPreviewResult(p:MigrationPreview,parent:MigrationParent):JSONObject {
        val j=parent.header();val rows=j.getJSONArray("roles").objects();val observed=p.result?.observations.orEmpty()
        return JSONObject().put("roles",JSONArray(rows.map{r->val observation=observed.singleOrNull{it.key==r.getString("key")};JSONObject().put("role",r.getString("role")).put("bytes",r.getLong("bytes")).put("sha256",r.getString("sha256")).put("apiItemExists",observation?.exists==true).put("storageBytesVerified",observation?.storageBytesVerified==true)})).put("existingStorageVerifiedCount",p.result?.adoptions?.size?:0).put("fileCount",rows.count{!it.getBoolean("note")}).put("previewID",p.id).put("parentJournalID",parent.id).put("paperID",j.getString("paperID")).put("title",j.getJSONObject("bibliography").optString("title")).put("libraryType","users").put("libraryID",p.target.userID).put("collection",j.optString("collection")).put("root",p.target.root).put("username",p.target.username).put("roleCount",j.getJSONArray("roles").length()).put("storageFilesVerified",p.result?.adoptions?.size?:0).put("prepared",false).put("remoteWrites",false)
    }
    suspend fun previewStorageMigration(previewID:String,authorization:ZoteroDavAuthorization):JSONObject=coroutineScope {
        val p=synchronized(workerGate){(migrationPreviews[previewID]?:throw ZoteroCredentialSuperseded()).also{requirePreviewCurrent(it);require(it.authorization==null||it.authorization===authorization);authorization.requireCurrent(it.target);it.authorization=authorization}}
        val worker=currentCoroutineContext()[Job]?:error("缺少原生操作")
        synchronized(workerGate){requirePreviewCurrent(p);workers[worker]=true;borrowedWorkers[worker]=true}
        try{mutex.withLock{
            requirePreviewCurrent(p);credentialOperation=CredentialOperation(p.lease,p.config);busy=true
            val context=currentCoroutineContext();var parent:MigrationParent?=null
            val check:()->Unit={context.ensureActive();requirePreviewCurrent(p);parent?.let{migrationStore.requireParentQuick(it)}}
            migrationOperationGuard=check
            try{
                parent=migrationStore.captureParent(p.parentID);parentMatchesConnection(parent!!);check();check()
                val existing=migrationStore.childForParent(parent!!.id)?.let{migrationStore.openChild(it)}
                val result=verifier(parent!!).verify(parent!!,p.target,check,existing);check();migrationStore.requireParent(parent!!)
                p.parent=parent;p.result=result;migrationPreviewResult(p,parent!!)
            }finally{migrationOperationGuard=null;credentialOperation=null;busy=false}
        }}finally{synchronized(workerGate){workers.remove(worker);borrowedWorkers.remove(worker)}}
    }
    private fun preparedMigration(child:MigrationChild)=preparedResult(child.journal).put("migration",true).put("status","prepared").put("parentJournalID",child.origin.getString("parentJournalID"))
    suspend fun confirmStorageMigration(previewID:String,authorization:ZoteroDavAuthorization,publishLocal:suspend((()->JSONObject))->JSONObject):JSONObject {
        val p=synchronized(workerGate){migrationPreviews[previewID]?:throw ZoteroCredentialSuperseded()}
        val mutation=synchronized(workerGate){
            require(p.authorization===authorization){"请确认原预览使用的同一连接授权"};authorization.requireCurrent(p.target)
            p.childID?.let{id->
                if(p.workspace!==workspaceIdentity||p.confirmedEpoch!=credentialEpoch||p.generation!=migrationGeneration||migrationAuthorizations[id]!==authorization)throw ZoteroCredentialSuperseded()
                authorization.requirePublished(p.target)
                val child=migrationStore.openChild(id);require(p.target.matches(child.origin.getJSONObject("target")));return preparedMigration(child)
            }
            requirePreviewCurrent(p);require(p.parent!=null&&p.result!=null&&!p.confirming){"请先完成原存档预览，再确认迁移"};p.confirming=true
            val token=beginCredentialMutationLocked(p);token to credentialEpoch
        }
        val token=mutation.first;val epoch=mutation.second
        try{
            cancelAndDrain()
            return coroutineScope {
                val worker=currentCoroutineContext()[Job]?:error("缺少原生操作");synchronized(workerGate){workers[worker]=true;borrowedWorkers[worker]=true}
                try{mutex.withLock{
                    requireCredentialMutation(token);val context=currentCoroutineContext();val parent=requireNotNull(p.parent);var localPublished=false
                    val guard={
                        context.ensureActive();authorization.requireCurrent(p.target)
                        synchronized(workerGate){if(p.workspace!==workspaceIdentity||epoch!=credentialEpoch||p.generation!=migrationGeneration||migrationPreviews[p.id]!==p)throw ZoteroCredentialSuperseded()}
                        if(!localPublished){requireCredentialMutation(token)}else require(davTarget(validatedConnection()).matches(p.target.binding()))
                        migrationStore.requireParentQuick(parent)
                    }
                    migrationOperationGuard=guard;busy=true
                    try{
                        guard();parentMatchesConnection(parent);migrationStore.requireParent(parent)
                        val existing=migrationStore.childForParent(parent.id)?.let{migrationStore.openChild(it)}
                        val fresh=verifier(parent).verify(parent,p.target,guard,existing)
                        require(canonical(JSONArray(fresh.observations.map{it.json()}))==canonical(JSONArray(requireNotNull(p.result).observations.map{it.json()}))){"远端材料自预览后已变化，请重新核对"}
                        guard()
                        val response=publishLocal {
                            guard();migrationStore.requireParent(parent)
                            val child=migrationStore.create(parent,p.target,fresh.observations,guard)
                            sealMigrationChild(child,fresh.adoptions,guard)
                            synchronized(workerGate){
                                guard();val c=connection()
                                val identity=canonical(JSONObject().put("user",p.target.userID).put("root",p.target.root).put("username",p.target.username))
                                val destinations=c.optJSONObject("davDestinations")?:JSONObject();val known=destinations.optJSONObject(identity)
                                require(known==null||(known.optString("destinationID")==p.target.destinationID&&known.optString("accountID")==p.target.accountID)){"该附件连接已有另一原生身份，未覆盖原连接"}
                                destinations.put(identity,JSONObject().put("destinationID",p.target.destinationID).put("accountID",p.target.accountID));c.put("davDestinations",destinations).put("davCredentialSource","saved-cloud").put("attachmentBackend","webdav").put("davBaseURL",p.target.root.removeSuffix("zotero/")).put("davUsername",p.target.username).put("davDestinationID",p.target.destinationID).put("davAccountID",p.target.accountID)
                                require(!Files.isSymbolicLink(profile.toPath()));JsonFiles.write(profile,c);localPublished=true
                                p.childID=child.id;p.confirmedEpoch=epoch;guard()
                            }
                            preparedMigration(migrationStore.openChild(child.id))
                        }
                        guard();require(localPublished&&p.childID!=null){"未执行原生迁移发布"}
                        require(response.optString("journalID")==p.childID&&response.optString("status")=="prepared"&&response.optString("attachmentBackend")=="webdav"){"本地迁移发布回执不符"}
                        authorization.requirePublished(p.target)
                        synchronized(workerGate){guard();authorization.requirePublished(p.target);migrationAuthorizations[requireNotNull(p.childID)]=authorization}
                        migrationStore.requireParent(parent);response
                    }finally{migrationOperationGuard=null;busy=false}
                }}finally{synchronized(workerGate){workers.remove(worker);borrowedWorkers.remove(worker)}}
            }
        }catch(error:Throwable){
            synchronized(workerGate){p.childID?.let{if(migrationAuthorizations[it]===authorization)migrationAuthorizations.remove(it)};p.childID=null;p.confirmedEpoch=null}
            throw error
        }finally{synchronized(workerGate){p.confirming=false};endCredentialMutation(token)}
    }
    private fun migrationMaterial(j:JSONObject,index:Int):ZoteroDavAttachment {
        val r=j.getJSONArray("roles").getJSONObject(index)
        return ZoteroDavAttachment.native(r.getString("key"),j.getString("parentKey"),r.getString("role"),j.getString("paperID"),j.getString("identity"),r.getString("title"),r.getString("contentType"),File(records,"${j.getString("id")}/${r.getString("file")}"),r.getString("sha256"))
    }
    private fun sealMigrationChild(child:MigrationChild,adoptions:Map<String,ZoteroDavStorageAdoption>,check:()->Unit){
        val j=readJournal(child.id);val codec=ZoteroDavCodec(davRoot())
        j.getJSONArray("roles").objects().forEachIndexed{i,r->
            if(r.getBoolean("note"))return@forEachIndexed
            check();val material=migrationMaterial(j,i);val adoption=adoptions[r.getString("key")]
            if(r.has("davJournalID")){
                val sealed=codec.reopen(r.getString("davJournalID"),child.target,check);val plan=codec.verify(sealed,child.target,check)
                require(canonical(plan.getJSONObject("attachment"))==canonical(material.descriptor())){"原迁移封存与材料不符"}
                if(plan.has("storageAdoption"))requireNotNull(adoption).requirePlan(plan,child.target)else require(adoption==null)
            }else{
                val sealed=if(adoption==null)codec.prepare(material,child.target,check)else codec.prepareStorageMigration(material,child.target,adoption,check)
                check();r.put("davJournalID",sealed.id);save(j)
            }
        }
        check();migrationStore.requireChild(migrationStore.openChild(child.id))
    }
    private suspend fun archiveMigrationChild(id:String):JSONObject {
        val child=migrationStore.openChild(id);val parent=migrationStore.captureParent(child.origin.getString("parentJournalID"));parentMatchesConnection(parent)
        val c=validatedConnection();require(backend(c)=="webdav"&&davTarget(c).matches(child.target.binding())){"请恢复迁移子记录的原连接"}
        val authorization=synchronized(workerGate){migrationAuthorizations[id]}?:throw IllegalArgumentException("请先明确确认此迁移记录使用的坚果云连接")
        val worker=currentCoroutineContext()[Job]?:error("缺少原生操作");synchronized(workerGate){authorization.requireCurrent(child.target);borrowedWorkers[worker]=true}
        val context=currentCoroutineContext();val previous=migrationOperationGuard
        val guard={context.ensureActive();authorization.requirePublished(child.target);synchronized(workerGate){if(migrationAuthorizations[id]!==authorization)throw ZoteroCredentialSuperseded()};migrationStore.requireParentQuick(parent)}
        migrationOperationGuard=guard
        try{
            guard();val verified=verifier(parent).verify(parent,child.target,guard,child);guard();sealMigrationChild(child,verified.adoptions,guard)
            val j=readJournal(id);val base="/users/${j.getString("libraryID")}/items";val roles=j.getJSONArray("roles");j.put("status","running");save(j)
            try{
                check();val expectedParent=j.getJSONObject("bibliography").copy().put("key",j.getString("parentKey"))
                if(j.optString("collection").isNotBlank())expectedParent.put("collections",JSONArray().put(j.getString("collection")))
                verifyItem(base,expectedParent)
                for(i in 0 until roles.length()){
                    guard();val r=roles.getJSONObject(i);val file=File(records,"$id/${r.getString("file")}");val key=r.getString("key")
                    val item=JSONObject().put("key",key).put("version",0).put("parentItem",j.getString("parentKey")).put("tags",JSONArray().put(JSONObject().put("tag","PaperDigest:${r.getString("role")}:${r.getString("sha256")}")))
                    if(r.getBoolean("note"))item.put("itemType","note").put("note",file.readText())else item.put("itemType","attachment").put("linkMode","imported_file").put("title",r.getString("title")).put("contentType",r.getString("contentType")).put("filename",filename(r))
                    ensureItem(base,item,j,null,r)
                    if(r.getBoolean("note"))verifyRole(base,key,file,r,j.getString("parentKey"))else{
                        beforeApi();val lease=ZoteroDavLease.nativeBorrowed(child.target,apiRevision,davRevision,credentialEpoch,authorization){runCatching{guard();requireCredentialCurrent();true}.getOrDefault(false)}
                        val backend=davFactory(davRoot(),secrets);val adoption=verified.adoptions[key]
                        val proof=if(adoption==null)backend.resume(r.getString("davJournalID"),lease)else backend.resumeStorageMigration(r.getString("davJournalID"),lease,adoption)
                        require(proof.opt("apiMetadataVerified")==true&&proof.opt("davBytesVerified")==true);r.put("davVerification",proof)
                    }
                    guard();migrationStore.requireParent(parent);r.put("status","verified").put("verifiedAt",now());save(j)
                }
                verifyItem(base,expectedParent);guard();migrationStore.requireParent(parent);j.put("status","completed").put("completedAt",now()).remove("error");save(j)
                return JSONObject().put("journalID",id).put("status","completed").put("migration",true).put("roleCount",roles.length()+1).put("officialClientsOpened",false)
            }catch(e:Exception){j.put("status",if(e is CancellationException)"cancelled"else"failed").put("error",safeMessage(e));save(j);throw e}
        }finally{migrationOperationGuard=previous;synchronized(workerGate){borrowedWorkers.remove(worker)}}
    }

    private fun validatedConnection():JSONObject=connection().also{require(it.optString("libraryType") in listOf("users","groups")&&it.optString("libraryID").matches(Regex("[1-9][0-9]{0,15}"))){"请先保存文库类型和 ID"}}
    private suspend fun check(){
        credentialLease.clearConfirmation()
        val c=validatedConnection()
        val r=api("GET","/keys/current");requireCredentialCurrent();val value=JSONObject(r.bytes.toString(Charsets.UTF_8));val access=value.getJSONObject("access")
        if(c.getString("libraryType")=="users")require(value.getLong("userID").toString()==c.getString("libraryID")&&access.optJSONObject("user")?.optBoolean("library")==true&&access.optJSONObject("user")?.optBoolean("write")==true&&(backend(c)=="webdav"||access.optJSONObject("user")?.optBoolean("files")==true)&&access.optJSONObject("user")?.optBoolean("notes")==true){"此 key 缺少所选个人文库的资料、笔记、写入或文件权限"}
        else {
            val groups=access.optJSONObject("groups");val keyAccess=groups?.optJSONObject(c.getString("libraryID"))?:groups?.optJSONObject("all")
            require(keyAccess?.optBoolean("library")==true&&keyAccess.optBoolean("write")){"此 key 缺少所选群组读写权限"}
            val response=JSONObject(api("GET","/groups/${c.getString("libraryID")}").bytes.toString(Charsets.UTF_8))
            val group=response.optJSONObject("data")?:response
            require(response.optLong("id",group.optLong("id"))==c.getString("libraryID").toLong()){ "群组身份回读不一致" }
            val user=value.getLong("userID")
            fun includes(name:String):Boolean {val a=group.optJSONArray(name)?:return false;return (0 until a.length()).any{a.optLong(it,-1)==user}}
            val admin=group.optLong("owner",-1)==user||includes("admins")
            val member=includes("members")
            val editable=admin||(member&&group.optString("libraryEditing")=="members")
            val files=editable&&when(group.optString("fileEditing")){"members"->true;"admins"->admin;else->false}
            require(editable&&files){"此用户在所选群组没有完整资料与文件写入权限；不会开始创建条目"}
        }
        requireCredentialCurrent()
        val operation=credentialOperation?:throw ZoteroCredentialSuperseded()
        confirmedAPIFilePermission=access.optJSONObject("user")?.opt("files")==true||c.getString("libraryType")=="groups"
        credentialLease.confirm(operation.lease,operation.target,now())
    }
    private suspend fun prepare(options:JSONObject):JSONObject {
        val c=validatedConnection();val input=options.copy()
        val requestID=input.nullableString("preparationRequestID")
        require(requestID==null||runCatching{UUID.fromString(requestID).toString()==requestID}.getOrDefault(false)){"存档准备请求身份无效"}
        val actualOptions=JSONObject().apply{listOf("includePDF","includeGuide","includeAnalysis","includeNote").forEach{key->put(key,input.optBoolean(key,true))}}
        fun preview(journal:JSONObject)=preparedResult(journal).put("options",actualOptions.copy()).put("preparationRequestID",requestID?:JSONObject.NULL)
        requireCredentialCurrent()
        val source=provider.prepare(input);requireCredentialCurrent();require(source.materials.map{it.role}.distinct().size==source.materials.size)
        require(source.materials.isNotEmpty()&&source.identity.matches(Regex("[a-f0-9]{64}")))
        source.materials.forEach { material ->
            if(backend(c)=="webdav"&&material.file!=null)DavFiles.regular(material.file)
            require((material.file!=null)!=(material.noteHTML!=null))
            require(material.sha256.matches(Regex("[a-f0-9]{64}")))
            require(if(material.file!=null)material.file.isFile&&material.file.length()<=512L*1024*1024&&hash(material.file)==material.sha256 else sha256(material.noteHTML!!.toByteArray())==material.sha256){"当前材料与准备身份不符"}
        }
        val plan=planSHA(c,source.paperID,source.identity,source.bibliography,source.materials.map{m->JSONObject().put("role",m.role).put("title",m.title).put("contentType",m.contentType).put("sha256",m.sha256).put("note",m.noteHTML!=null)})
        val journals=records.listFiles()?.filter{it.isDirectory}?.mapNotNull{runCatching{readJournal(it.name)}.getOrNull()}?:emptyList()
        journals.firstOrNull{prior->runCatching{planSHA(prior,prior.getString("paperID"),prior.getString("identity"),prior.getJSONObject("bibliography"),prior.getJSONArray("roles").objects().map{r->JSONObject().put("role",r.getString("role")).put("title",r.getString("title")).put("contentType",r.getString("contentType")).put("sha256",r.getString("sha256")).put("note",r.getBoolean("note"))})==plan}.getOrDefault(false)}?.let{prior->
            val id=prior.getString("id");val roles=prior.getJSONArray("roles")
            for(i in 0 until roles.length()){val role=roles.getJSONObject(i);require(role.getString("file")=="material-$i");val file=File(records,"$id/${role.getString("file")}");require(file.isFile&&hash(file)==role.getString("sha256")){"原存档的材料已损坏，未改用新条目掩盖；请保留记录并恢复原备份"}}
            if(backend(c)=="webdav")ensureDavSealed(prior,c)
            return preview(prior).put("notices",JSONArray((noticeStrings(prior)+source.notices).distinct())).put("reused",true).let(::publishPrepared)
        }
        val parentPrior=journals.firstOrNull{prior->prior.optBoolean("parentVerified")&&sameBackend(prior,c)&&prior.optString("paperID")==source.paperID&&prior.optString("destinationID")==c.getString("destinationID")&&prior.optString("libraryType")==c.getString("libraryType")&&prior.optString("libraryID")==c.getString("libraryID")&&prior.optString("collection")==c.optString("collection")&&canonical(prior.optJSONObject("bibliography"))==canonical(source.bibliography)}
        val id=UUID.randomUUID().toString();val dir=File(records,id).also{it.mkdirs()};val roles=JSONArray()
        try {
            source.materials.forEachIndexed{i,m->
                require(m.role in setOf("source-metadata","pdf","guide","analysis","note","guide-preview-pdf")&&m.sha256.matches(Regex("[a-f0-9]{64}")))
                require((m.file!=null)!=(m.noteHTML!=null));val target=File(dir,"material-$i")
                if(m.file!=null){if(backend(c)=="webdav")DavFiles.regular(m.file);require(m.file.isFile&&m.file.length()<=512L*1024*1024);m.file.inputStream().use{input->target.outputStream().use{input.copyTo(it)}}}else JsonFiles.write(target,m.noteHTML!!.toByteArray())
                require(hash(target)==m.sha256){"存档准备期间原材料已变化"}
                val reusable=parentPrior?.takeIf{backend(c)=="storage"||it.optString("identity")==source.identity}?.getJSONArray("roles")?.objects()?.firstOrNull{old->old.optString("status")=="verified"&&old.optString("role")==m.role&&old.optString("sha256")==m.sha256&&old.optString("title")==m.title&&old.optString("contentType")==m.contentType&&old.optBoolean("note")== (m.noteHTML!=null)}
                roles.put(JSONObject().put("created",reusable!=null).put("role",m.role).put("title",m.title).put("contentType",m.contentType).put("sha256",m.sha256).put("file",target.name).put("bytes",target.length()).put("note",m.noteHTML!=null).put("key",reusable?.getString("key")?:newKey()).put("status",if(reusable!=null)"verified" else "prepared").apply{if(backend(c)=="webdav"&&reusable!=null)put("davJournalID",reusable.getString("davJournalID"))})
            }
            val journal=JSONObject().put("contract","paperdigest-zotero-web-v1").put("id",id).put("createdAt",now()).put("status","prepared")
                .put("destinationID",c.getString("destinationID")).put("libraryType",c.getString("libraryType")).put("libraryID",c.getString("libraryID")).put("collection",c.optString("collection"))
                .put("options",actualOptions.copy()).put("notices",JSONArray(source.notices)).put("paperID",source.paperID).put("identity",source.identity).put("planSHA",plan).put("bibliography",source.bibliography.copy()).put("parentKey",parentPrior?.getString("parentKey")?:newKey()).put("parentVerified",parentPrior!=null).put("roles",roles)
            journal.put("attachmentBackend",backend(c))
            if(backend(c)=="webdav"){
                journal.put("davTarget",targetBinding(c));JsonFiles.write(File(dir,"journal.json"),journal)
                ensureDavSealed(journal,c)
            }
            requireCredentialCurrent();JsonFiles.write(File(dir,"journal.json"),journal)
            return preview(journal).let(::publishPrepared)
        }catch(e:Exception){if(backend(c)=="storage")dir.deleteRecursively();throw e}
    }
    /** Reuses only native-sealed IDs; an interrupted local prepare can finish its missing seals without any HTTP. */
    private suspend fun ensureDavSealed(journal:JSONObject,c:JSONObject){
        val lease=davLease(c);val roles=journal.getJSONArray("roles");val dir=File(records,journal.getString("id"))
        for(i in 0 until roles.length()){
            val r=roles.getJSONObject(i);if(r.getBoolean("note"))continue
            requireCredentialCurrent()
            val material=ZoteroDavAttachment.native(r.getString("key"),journal.getString("parentKey"),r.getString("role"),journal.getString("paperID"),journal.getString("identity"),r.getString("title"),r.getString("contentType"),File(dir,r.getString("file")),r.getString("sha256"))
            if(r.has("davJournalID")){
                val codec=ZoteroDavCodec(davRoot());val sealed=codec.reopen(r.getString("davJournalID"),lease.target){requireCredentialCurrent()}
                require(canonical(codec.verify(sealed,lease.target){requireCredentialCurrent()}.getJSONObject("attachment"))==canonical(material.descriptor())){"原 WebDAV 封存身份已变化"}
            }else{
                val sealed=davFactory(davRoot(),secrets).prepare(material,lease)
                r.put("davJournalID",sealed.id);requireCredentialCurrent();save(journal)
            }
        }
    }
    private fun publishPrepared(value:JSONObject):JSONObject=synchronized(workerGate){requireCredentialCurrent();prepared=value;value}
    private fun noticeStrings(j:JSONObject):List<String> = j.optJSONArray("notices")?.let{a->(0 until a.length()).mapNotNull{a.opt(it) as? String}}?:emptyList()
    private fun preparedResult(j:JSONObject)=JSONObject().put("notices",JSONArray(noticeStrings(j))).put("preparedID",j.getString("id")).put("journalID",j.getString("id")).put("paperID",j.getString("paperID")).put("roles",JSONArray(j.getJSONArray("roles").toString())).put("libraryType",j.getString("libraryType")).put("libraryID",j.getString("libraryID")).put("attachmentBackend",backend(j))
    private fun planSHA(c:JSONObject,paperID:String,identity:String,bibliography:JSONObject,roles:List<JSONObject>)=sha256(canonical(JSONObject().apply{if(backend(c)=="webdav")put("davTarget",c.optJSONObject("davTarget")?:targetBinding(c)).put("attachmentBackend","webdav")}.put("contract","paperdigest-zotero-plan-v1").put("destinationID",c.getString("destinationID")).put("libraryType",c.getString("libraryType")).put("libraryID",c.getString("libraryID")).put("collection",c.optString("collection")).put("paperID",paperID).put("identity",identity).put("bibliography",bibliography).put("roles",JSONArray(roles))).toByteArray())
    private fun readJournal(id:String):JSONObject {require(UUID.fromString(id).toString()==id);return JSONObject(JsonFiles.read(File(records,"$id/journal.json")).toString(Charsets.UTF_8)).also{require(it.getString("contract")=="paperdigest-zotero-web-v1"&&it.getString("id")==id)}}
    private fun save(j:JSONObject){JsonFiles.write(File(records,"${j.getString("id")}/journal.json"),j)}
    private suspend fun archive(id:String):JSONObject {
        if(migrationStore.isChild(id))return archiveMigrationChild(id)
        require(!migrationStore.parentHasMigration(id)){"原 Storage 记录已有迁移子记录，请明确打开该迁移记录续传"}
        val j=readJournal(id);val c=validatedConnection()
        require(sameBackend(j,c)&&j.getString("destinationID")==c.getString("destinationID")&&j.getString("libraryType")==c.getString("libraryType")&&j.getString("libraryID")==c.getString("libraryID")&&j.optString("collection")==c.optString("collection")){"此断点属于其他 Zotero 连接；请恢复原连接后续传，不能跨账户重用"}
        val base="/${j.getString("libraryType")}/${j.getString("libraryID")}/items";val dir=File(records,id)
        val roles=j.getJSONArray("roles")
        for(i in 0 until roles.length()){val role=roles.getJSONObject(i);require(role.getString("file")=="material-$i");val f=File(dir,role.getString("file"));require(f.isFile&&f.length()==role.getLong("bytes")&&hash(f)==role.getString("sha256")){"断点原件已变化，已停止续传"}}
        if(backend(j)=="webdav"){
            val codec=ZoteroDavCodec(davRoot());val target=davTarget(c)
            for(i in 0 until roles.length()){
                val role=roles.getJSONObject(i);if(role.getBoolean("note"))continue
                val sealed=codec.reopen(role.getString("davJournalID"),target){requireCredentialCurrent()}
                val actual=codec.verify(sealed,target){requireCredentialCurrent()}.getJSONObject("attachment")
                val expected=ZoteroDavAttachment.native(role.getString("key"),j.getString("parentKey"),role.getString("role"),j.getString("paperID"),j.getString("identity"),role.getString("title"),role.getString("contentType"),File(dir,role.getString("file")),role.getString("sha256")).descriptor()
                require(canonical(actual)==canonical(expected)){"WebDAV 原封存材料与断点不符"}
            }
        }
        try {
            check();j.put("status","running");save(j)
            val parent=j.getJSONObject("bibliography").copy().put("key",j.getString("parentKey")).put("version",0)
            if(j.optString("collection").isNotBlank())parent.put("collections",JSONArray().put(j.getString("collection")))
            ensureItem(base,parent,j,"parentVerified")
            for(i in 0 until roles.length()){
                currentCoroutineContext().ensureActive();val r=roles.getJSONObject(i);val file=File(dir,r.getString("file"));val key=r.getString("key")
                val item=JSONObject().put("key",key).put("version",0).put("parentItem",j.getString("parentKey")).put("tags",JSONArray().put(JSONObject().put("tag","PaperDigest:${r.getString("role")}:${r.getString("sha256")}")))
                if(r.getBoolean("note"))item.put("itemType","note").put("note",file.readText()) else item.put("itemType","attachment").put("linkMode","imported_file").put("title",r.getString("title")).put("contentType",r.getString("contentType")).put("filename",filename(r))
                ensureItem(base,item,j,null,r)
                if(!r.getBoolean("note")&&backend(j)=="webdav"){
                    beforeApi() // Ordinary metadata pacing also owns the transition to the DAV API port.
                    val result=davFactory(davRoot(),secrets).resume(r.getString("davJournalID"),davLease(c))
                    require(result.opt("apiMetadataVerified")==true&&result.opt("davBytesVerified")==true){"WebDAV 回读尚未完整确认"}
                    r.put("davVerification",result)
                }else{
                    if(!r.getBoolean("note"))upload(base,key,file,r,j)
                    verifyRole(base,key,file,r,j.getString("parentKey"))
                }
                r.put("status","verified");r.put("verifiedAt",now());save(j)
            }
            // Parent is re-read after every role, never inferred from an accepted POST.
            verifyItem(base,parent)
            j.put("status","completed").put("completedAt",now()).remove("error");save(j)
            return JSONObject().put("journalID",id).put("status","completed").put("roleCount",roles.length()+1).put("message","所有所选材料已逐项回读核验")
        }catch(e:CancellationException){j.put("status","cancelled").put("error","已取消，可沿原断点继续");save(j);throw e}
        catch(e:Exception){j.put("status","failed").put("error",safeMessage(e));save(j);throw e}
    }
    private suspend fun ensureItem(base:String,item:JSONObject,j:JSONObject,flag:String?,role:JSONObject?=null){
        val key=item.getString("key");val existing=api("GET","$base/$key?format=json",allow404=true)
        if(existing.code==404){
            require(!(flag!=null&&j.optBoolean(flag))&&role?.optBoolean("created")!=true&&role?.optString("status")!="verified"){"远端曾核验的条目已被删除，未擅自重建或覆盖用户修改"}
            val r=api("POST",base,JSONArray().put(item).toString().toRequestBody("application/json".toMediaType()),mapOf("Zotero-Write-Token" to UUID.randomUUID().toString().replace("-","")))
            val body=JSONObject(r.bytes.toString(Charsets.UTF_8));require(body.optJSONObject("failed")?.length()==0){"Zotero 未接收全部条目，原断点已保留"}
        }
        val actual=verifyItem(base,item)
        if(role!=null){role.put("created",true).put("version",actual.getLong("version"));save(j)}
        if(flag!=null){j.put(flag,true);save(j)}
    }
    private suspend fun verifyItem(base:String,expected:JSONObject):JSONObject {
        val r=api("GET","$base/${expected.getString("key")}?format=json");val data=JSONObject(r.bytes.toString(Charsets.UTF_8)).getJSONObject("data")
        expected.keys().forEach{k->if(k !in setOf("version","tags","collections")){require(canonical(data.opt(k))==canonical(expected.opt(k))){"Zotero 条目已被编辑或回读不一致，已停止以保护远端修改"}}}
        expected.optJSONArray("tags")?.let { tags ->
            val actual=data.optJSONArray("tags")?.objects()?:emptyList()
            for(i in 0 until tags.length()){val required=tags.getJSONObject(i);require(actual.any{candidate->required.keys().asSequence().all{key->canonical(candidate.opt(key))==canonical(required.opt(key))}}){"远端标签回读不一致，未覆盖用户修改"}}
        }
        expected.optJSONArray("collections")?.let{a->for(i in 0 until a.length())require(data.optJSONArray("collections")?.strings()?.contains(a.getString(i))==true){"Zotero 分类回读不一致"}}
        return data
    }
    private suspend fun upload(base:String,key:String,file:File,r:JSONObject,j:JSONObject){
        val md5=hash(file,"MD5");val existing=JSONObject(api("GET","$base/$key?format=json").bytes.toString(Charsets.UTF_8)).getJSONObject("data")
        val remoteMD5=existing.opt("md5")
        if(existing.has("md5")&&remoteMD5!==JSONObject.NULL){require(remoteMD5 is String&&remoteMD5==md5){"远端附件已被修改，不会覆盖"};return}
        val auth=FormBody.Builder().add("md5",md5).add("filename",filename(r)).add("filesize",file.length().toString()).add("mtime",file.lastModified().coerceAtLeast(1).toString()).build()
        val result=JSONObject(api("POST","$base/$key/file",auth,mapOf("If-None-Match" to "*")).bytes.toString(Charsets.UTF_8))
        if(result.optInt("exists")==1)return
        val url=result.getString("url");safeExternal(url)
        val prefix=result.getString("prefix").toByteArray();val suffix=result.getString("suffix").toByteArray();val type=result.getString("contentType").toMediaType()
        val body=object:RequestBody(){override fun contentType()=type;override fun contentLength()=prefix.size.toLong()+file.length()+suffix.size;override fun writeTo(sink:BufferedSink){sink.write(prefix);file.inputStream().use{input->val buffer=ByteArray(64*1024);while(true){val n=input.read(buffer);if(n<0)break;sink.write(buffer,0,n)}};sink.write(suffix)}}
        requireCredentialCurrent()
        val response=transport.request(Request.Builder().url(url).post(body).build(),64*1024);currentCoroutineContext().ensureActive();cooldown(response.code,response.headers);requireCredentialCurrent();require(response.code in 200..299){"附件上传未完成，保留原断点"}
        r.put("uploadTransferred",true);save(j)
        api("POST","$base/$key/file",FormBody.Builder().add("upload",result.getString("uploadKey")).build(),mapOf("If-None-Match" to "*"))
    }
    private suspend fun verifyRole(base:String,key:String,file:File,r:JSONObject,parent:String){
        val data=JSONObject(api("GET","$base/$key?format=json").bytes.toString(Charsets.UTF_8)).getJSONObject("data")
        require(data.optString("parentItem")==parent){"附件父条目回读不一致"}
        if(r.getBoolean("note")){require(sha256(data.getString("note").toByteArray())==r.getString("sha256")){"笔记原文回读不一致"};return}
        require(data.optString("md5")==hash(file,"MD5")&&data.optLong("mtime")>0){"附件文件登记回读不一致"}
        val target=File(file.parentFile,".readback-${UUID.randomUUID()}")
        try {
            var request=apiRequest("GET","$base/$key/file",null,emptyMap());var redirects=0
            while(true){requireCredentialCurrent();val origin=request.url.host=="api.zotero.org";if(origin)beforeApi()
                val response=transport.download(request,target,512L*1024*1024);currentCoroutineContext().ensureActive()
                if(origin)acceptApi(response.code,response.headers,allowRedirect=true) else {cooldown(response.code,response.headers);requireCredentialCurrent();if(response.code==429)throw AppFailure("backoff","附件服务要求等待，原断点保留")}
                if(response.code in 300..399){require(redirects++<5){"附件重定向过多"};val location=response.headers.entries.firstOrNull{it.key.equals("Location",true)}?.value?:error("缺少附件地址");val resolved=request.url.resolve(location)?.toString()?:error("无效附件地址");safeExternal(resolved);request=Request.Builder().url(resolved).get().build();continue};require(response.code==200&&response.bytes==file.length()&&response.sha256==r.getString("sha256")){"附件下载原 SHA 回读不一致"};break}
        }finally{target.delete()}
    }
    private fun filename(r:JSONObject)=when(r.getString("contentType")){"application/pdf"->"${r.getString("role")}.pdf";"text/html"->"${r.getString("role")}.html";else->"${r.getString("role")}.json"}
    private suspend fun beforeApi(){
        currentCoroutineContext().ensureActive();requireCredentialCurrent()
        val c=connection()
        if(c.optLong("backoffUntil")>clock())throw AppFailure("backoff","Zotero 要求等待冷却，请稍后沿原断点继续")
        if(backend(c)=="webdav"){
            val root=davRoot();val pacing=File(root,"backoff.json")
            if(Files.exists(pacing.toPath(),NOFOLLOW_LINKS)){
                DavFiles.regular(pacing)
                DavBackoff(DavFiles(root),clock).before(true)
            }
        }
    }

    private fun cooldown(code:Int,headers:Map<String,String>){
        val wait=headers.entries.filter{it.key.equals("Backoff",true)||it.key.equals("Retry-After",true)}.mapNotNull{entry->entry.value.toLongOrNull()?:runCatching{((java.time.ZonedDateTime.parse(entry.value,java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli()-clock()+999)/1000).coerceAtLeast(0)}.getOrNull()}.maxOrNull()?:if(code==429)60L else null
        if(wait!=null&&wait>0){val c=connection();c.put("backoffUntil",maxOf(c.optLong("backoffUntil"),clock()+wait.coerceAtMost((Long.MAX_VALUE-clock())/1000)*1000));JsonFiles.write(profile,c)}
    }
    private fun acceptApi(code:Int,headers:Map<String,String>,allow404:Boolean=false,allowRedirect:Boolean=false){
        cooldown(code,headers)
        requireCredentialCurrent()
        if(code !in 200..299&&!(allow404&&code==404)&&!(allowRedirect&&code in 300..399))throw AppFailure(when(code){401->"authentication";403->"permission";412->"conflict";413->"quota";429->"backoff";else->"zotero"},when(code){401->"Zotero API key 未被接受";403->"Zotero 权限不足，或群组不允许文件写入";412->"远端版本已变化，已保留断点且不会覆盖";413->"Zotero 文件配额不足";429->"Zotero 要求等待，请稍后续传";else->"Zotero 请求未完成（HTTP $code），原断点保留"})
    }
    private suspend fun api(method:String,path:String,body:RequestBody?=null,headers:Map<String,String> = emptyMap(),allow404:Boolean=false):HttpBytes {
        val response=transport.request(apiRequest(method,path,body,headers));currentCoroutineContext().ensureActive();acceptApi(response.code,response.headers,allow404);return response
    }
    private suspend fun apiRequest(method:String,path:String,body:RequestBody?,headers:Map<String,String>):Request {
        beforeApi();require(path.startsWith("/")&&!path.startsWith("//"));val secret=try{secrets.load("zotero.primary")}catch(e:Exception){if(e is CancellationException)throw e;throw AppFailure("credentialsUnavailable","无法读取本机 Zotero key，请在设置中重新保存")}
        currentCoroutineContext().ensureActive();requireCredentialCurrent();require(!secret.isNullOrBlank()){ "请先保存 Zotero 专用 API key" }
        return try {
            Request.Builder().url("https://api.zotero.org$path").header("Zotero-API-Version","3").header("Zotero-API-Key",secret).apply{headers.forEach{(k,v)->header(k,v)}}.method(method,body).build()
        } catch (_:IllegalArgumentException) {
            // OkHttp may include a rejected custom header's value in its exception.
            // Never retain that message/cause for Root UI or durable archive journals.
            throw AppFailure("credentialsUnavailable","Zotero 请求头无效，请在设置中重新保存 API key")
        }
    }
    companion object {
        fun validKey(key:String)=key.matches(Regex("[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}"))
        private fun newKey():String {val alphabet="23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";val random=java.security.SecureRandom();return (1..8).map{alphabet[random.nextInt(alphabet.length)]}.joinToString("")}
        fun safeExternal(url:String){val u=URI(url);require(u.scheme=="https"&&u.host!=null&&u.userInfo==null&&u.fragment==null){"附件地址不安全"}}
        private fun hash(file:File,algorithm:String="SHA-256"):String{val md=MessageDigest.getInstance(algorithm);file.inputStream().use{input->val b=ByteArray(65536);while(true){val n=input.read(b);if(n<0)break;md.update(b,0,n)}};return md.digest().joinToString(""){"%02x".format(it.toInt()and 255)}}
        private fun safeMessage(error:Exception)=if(error is AppFailure||error is IllegalArgumentException)error.message?:"存档未完成" else "存档未完成，原件和断点已保留"
    }
}
