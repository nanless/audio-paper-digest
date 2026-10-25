package com.nanless.paperdigest.zotero

import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.secret.SecretStore
import kotlinx.coroutines.CancellationException
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
}
class NetworkZoteroTransport(private val http:SafeHttp=SafeHttp()):ZoteroTransport {
    override suspend fun request(request:Request,limit:Int)=http.execute(request,limit)
    override suspend fun download(request:Request,target:File,limit:Long)=http.download(request,target,limit)
}

/** Web API credentials stay outside research backups. Original materials and journals are fully backed up. */
class ZoteroService(
    private val researchRoot:File, private val secrets:SecretStore, private val provider:ZoteroMaterialProvider,
    private val transport:ZoteroTransport=NetworkZoteroTransport(),
    private val clock:()->Long=System::currentTimeMillis,
    private val sleep:suspend(Long)->Unit={delay(it)},
) {
    private val mutex=Mutex()
    private val profile=File(researchRoot.parentFile,"PaperDigestZotero/connection.json")
    private val records=File(researchRoot,"ZoteroArchives").also{it.mkdirs()}
    private var permissions:JSONObject?=null
    private var busy=false
    private var prepared:JSONObject?=null
    fun credentialsChanged(){permissions=null}
    private fun connection():JSONObject=if(profile.isFile)JSONObject(JsonFiles.read(profile).toString(Charsets.UTF_8)) else JSONObject().put("destinationID",UUID.randomUUID().toString()).also{JsonFiles.write(profile,it)}
    fun state():JSONObject {
        val c=connection()
        return JSONObject().put("libraryType",c.optString("libraryType","users")).put("libraryID",c.optString("libraryID")).put("collection",c.optString("collection"))
            .put("prepared",prepared ?: JSONObject.NULL).put("credentialState",if(permissions==null)"unknown" else "confirmed").put("busy",busy).put("permissions",permissions ?: JSONObject.NULL)
            .put("journals",JSONArray(records.listFiles()?.filter{it.isDirectory}?.mapNotNull{dir->runCatching{readJournal(dir.name).apply{remove("bibliography");remove("roles")}}.getOrNull()}?.sortedByDescending{it.optString("createdAt")}?:emptyList<JSONObject>()))
    }
    suspend fun execute(command:String,payload:JSONObject=JSONObject()):JSONObject {
        if(command in listOf("state","zotero.state"))return state()
        return mutex.withLock {
            busy=true
            try { when(command.removePrefix("zotero.")) {
                "save"->{val c=connection();val type=payload.optString("libraryType","users");val id=payload.optString("libraryID");val collection=payload.optString("collection")
                    require(type in listOf("users","groups")&&id.matches(Regex("[1-9][0-9]{0,15}"))) {"请输入真实 Zotero 文库 ID"};require(collection.isEmpty()||validKey(collection)){"分类 key 应为 8 位 Zotero key"}
                    if(c.optString("libraryType")!=type||c.optString("libraryID")!=id){
                        val known=c.optJSONObject("destinations")?:JSONObject()
                        if(c.optString("libraryID").isNotEmpty())known.put("${c.optString("libraryType")}:${c.optString("libraryID")}",c.getString("destinationID"))
                        val target="$type:$id";val destination=known.optString(target).takeIf{it.isNotBlank()}?:UUID.randomUUID().toString()
                        known.put(target,destination);c.put("destinations",known).put("destinationID",destination)
                    }
                    c.put("libraryType",type).put("libraryID",id).put("collection",collection);JsonFiles.write(profile,c);permissions=null;prepared=null;state()}
                "check"->{check();state()}
                "collections"->{val c=validatedConnection();check();val all=mutableListOf<JSONObject>();var start=0
                    while(true){val result=api("GET","/${c.getString("libraryType")}/${c.getString("libraryID")}/collections?format=json&limit=100&start=$start");val rows=JSONArray(result.bytes.toString(Charsets.UTF_8));for(i in 0 until rows.length())all+=rows.getJSONObject(i);if(rows.length()<100)break;start+=100;require(start<=10000){"分类数量超过安全读取上限"}}
                    JSONObject().put("collections",JSONArray(all))}
                "prepare"->prepare(payload)
                "archive","resume"->archive(payload.optString("journalID",payload.optString("preparedID")))
                else->throw IllegalArgumentException("未知 Zotero 操作")
            } } finally{busy=false}
        }
    }
    private fun validatedConnection():JSONObject=connection().also{require(it.optString("libraryType") in listOf("users","groups")&&it.optString("libraryID").matches(Regex("[1-9][0-9]{0,15}"))){"请先保存文库类型和 ID"}}
    private suspend fun check(){
        permissions=null
        val r=api("GET","/keys/current");val value=JSONObject(r.bytes.toString(Charsets.UTF_8));val c=validatedConnection();val access=value.getJSONObject("access")
        if(c.getString("libraryType")=="users")require(value.getLong("userID").toString()==c.getString("libraryID")&&access.optJSONObject("user")?.optBoolean("library")==true&&access.optJSONObject("user")?.optBoolean("write")==true&&access.optJSONObject("user")?.optBoolean("files")==true&&access.optJSONObject("user")?.optBoolean("notes")==true){"此 key 缺少所选个人文库的资料、笔记、写入或文件权限"}
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
        permissions=JSONObject().put("verifiedAt",now()).put("library",true).put("write",true).put("files",true)
    }
    private suspend fun prepare(options:JSONObject):JSONObject {
        val c=validatedConnection();val input=options.copy()
        val requestID=input.nullableString("preparationRequestID")
        require(requestID==null||runCatching{UUID.fromString(requestID).toString()==requestID}.getOrDefault(false)){"存档准备请求身份无效"}
        val actualOptions=JSONObject().apply{listOf("includePDF","includeGuide","includeAnalysis","includeNote").forEach{key->put(key,input.optBoolean(key,true))}}
        fun preview(journal:JSONObject)=preparedResult(journal).put("options",actualOptions.copy()).put("preparationRequestID",requestID?:JSONObject.NULL)
        val source=provider.prepare(input);require(source.materials.map{it.role}.distinct().size==source.materials.size)
        require(source.materials.isNotEmpty()&&source.identity.matches(Regex("[a-f0-9]{64}")))
        source.materials.forEach { material ->
            require((material.file!=null)!=(material.noteHTML!=null))
            require(material.sha256.matches(Regex("[a-f0-9]{64}")))
            require(if(material.file!=null)material.file.isFile&&material.file.length()<=512L*1024*1024&&hash(material.file)==material.sha256 else sha256(material.noteHTML!!.toByteArray())==material.sha256){"当前材料与准备身份不符"}
        }
        val plan=planSHA(c,source.paperID,source.identity,source.bibliography,source.materials.map{m->JSONObject().put("role",m.role).put("title",m.title).put("contentType",m.contentType).put("sha256",m.sha256).put("note",m.noteHTML!=null)})
        val journals=records.listFiles()?.filter{it.isDirectory}?.mapNotNull{runCatching{readJournal(it.name)}.getOrNull()}?:emptyList()
        journals.firstOrNull{prior->runCatching{planSHA(prior,prior.getString("paperID"),prior.getString("identity"),prior.getJSONObject("bibliography"),prior.getJSONArray("roles").objects().map{r->JSONObject().put("role",r.getString("role")).put("title",r.getString("title")).put("contentType",r.getString("contentType")).put("sha256",r.getString("sha256")).put("note",r.getBoolean("note"))})==plan}.getOrDefault(false)}?.let{prior->
            val id=prior.getString("id");val roles=prior.getJSONArray("roles")
            for(i in 0 until roles.length()){val role=roles.getJSONObject(i);require(role.getString("file")=="material-$i");val file=File(records,"$id/${role.getString("file")}");require(file.isFile&&hash(file)==role.getString("sha256")){"原存档的材料已损坏，未改用新条目掩盖；请保留记录并恢复原备份"}}
            return preview(prior).put("notices",JSONArray((noticeStrings(prior)+source.notices).distinct())).put("reused",true).also{prepared=it}
        }
        val parentPrior=journals.firstOrNull{prior->prior.optBoolean("parentVerified")&&prior.optString("paperID")==source.paperID&&prior.optString("destinationID")==c.getString("destinationID")&&prior.optString("libraryType")==c.getString("libraryType")&&prior.optString("libraryID")==c.getString("libraryID")&&prior.optString("collection")==c.optString("collection")&&canonical(prior.optJSONObject("bibliography"))==canonical(source.bibliography)}
        val id=UUID.randomUUID().toString();val dir=File(records,id).also{it.mkdirs()};val roles=JSONArray()
        try {
            source.materials.forEachIndexed{i,m->
                require(m.role in setOf("source-metadata","pdf","guide","analysis","note","guide-preview-pdf")&&m.sha256.matches(Regex("[a-f0-9]{64}")))
                require((m.file!=null)!=(m.noteHTML!=null));val target=File(dir,"material-$i")
                if(m.file!=null){require(m.file.isFile&&m.file.length()<=512L*1024*1024);m.file.inputStream().use{input->target.outputStream().use{input.copyTo(it)}}}else JsonFiles.write(target,m.noteHTML!!.toByteArray())
                require(hash(target)==m.sha256){"存档准备期间原材料已变化"}
                val reusable=parentPrior?.getJSONArray("roles")?.objects()?.firstOrNull{old->old.optString("status")=="verified"&&old.optString("role")==m.role&&old.optString("sha256")==m.sha256&&old.optString("title")==m.title&&old.optString("contentType")==m.contentType&&old.optBoolean("note")== (m.noteHTML!=null)}
                roles.put(JSONObject().put("created",reusable!=null).put("role",m.role).put("title",m.title).put("contentType",m.contentType).put("sha256",m.sha256).put("file",target.name).put("bytes",target.length()).put("note",m.noteHTML!=null).put("key",reusable?.getString("key")?:newKey()).put("status",if(reusable!=null)"verified" else "prepared"))
            }
            val journal=JSONObject().put("contract","paperdigest-zotero-web-v1").put("id",id).put("createdAt",now()).put("status","prepared")
                .put("destinationID",c.getString("destinationID")).put("libraryType",c.getString("libraryType")).put("libraryID",c.getString("libraryID")).put("collection",c.optString("collection"))
                .put("options",actualOptions.copy()).put("notices",JSONArray(source.notices)).put("paperID",source.paperID).put("identity",source.identity).put("planSHA",plan).put("bibliography",source.bibliography.copy()).put("parentKey",parentPrior?.getString("parentKey")?:newKey()).put("parentVerified",parentPrior!=null).put("roles",roles)
            JsonFiles.write(File(dir,"journal.json"),journal)
            return preview(journal).also{prepared=it}
        }catch(e:Exception){dir.deleteRecursively();throw e}
    }
    private fun noticeStrings(j:JSONObject):List<String> = j.optJSONArray("notices")?.let{a->(0 until a.length()).mapNotNull{a.opt(it) as? String}}?:emptyList()
    private fun preparedResult(j:JSONObject)=JSONObject().put("notices",JSONArray(noticeStrings(j))).put("preparedID",j.getString("id")).put("journalID",j.getString("id")).put("paperID",j.getString("paperID")).put("roles",JSONArray(j.getJSONArray("roles").toString())).put("libraryType",j.getString("libraryType")).put("libraryID",j.getString("libraryID"))
    private fun planSHA(c:JSONObject,paperID:String,identity:String,bibliography:JSONObject,roles:List<JSONObject>)=sha256(canonical(JSONObject().put("contract","paperdigest-zotero-plan-v1").put("destinationID",c.getString("destinationID")).put("libraryType",c.getString("libraryType")).put("libraryID",c.getString("libraryID")).put("collection",c.optString("collection")).put("paperID",paperID).put("identity",identity).put("bibliography",bibliography).put("roles",JSONArray(roles))).toByteArray())
    private fun readJournal(id:String):JSONObject {require(UUID.fromString(id).toString()==id);return JSONObject(JsonFiles.read(File(records,"$id/journal.json")).toString(Charsets.UTF_8)).also{require(it.getString("contract")=="paperdigest-zotero-web-v1"&&it.getString("id")==id)}}
    private fun save(j:JSONObject){JsonFiles.write(File(records,"${j.getString("id")}/journal.json"),j)}
    private suspend fun archive(id:String):JSONObject {
        val j=readJournal(id);val c=validatedConnection()
        require(j.getString("destinationID")==c.getString("destinationID")&&j.getString("libraryType")==c.getString("libraryType")&&j.getString("libraryID")==c.getString("libraryID")&&j.optString("collection")==c.optString("collection")){"此断点属于其他 Zotero 连接；请恢复原连接后续传，不能跨账户重用"}
        val base="/${j.getString("libraryType")}/${j.getString("libraryID")}/items";val dir=File(records,id)
        val roles=j.getJSONArray("roles")
        for(i in 0 until roles.length()){val role=roles.getJSONObject(i);require(role.getString("file")=="material-$i");val f=File(dir,role.getString("file"));require(f.isFile&&f.length()==role.getLong("bytes")&&hash(f)==role.getString("sha256")){"断点原件已变化，已停止续传"}}
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
                if(!r.getBoolean("note"))upload(base,key,file,r,j)
                verifyRole(base,key,file,r,j.getString("parentKey"))
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
        if(existing.optString("md5").isNotEmpty()){require(existing.getString("md5")==md5){"远端附件已被修改，不会覆盖"};return}
        val auth=FormBody.Builder().add("md5",md5).add("filename",filename(r)).add("filesize",file.length().toString()).add("mtime",file.lastModified().coerceAtLeast(1).toString()).build()
        val result=JSONObject(api("POST","$base/$key/file",auth,mapOf("If-None-Match" to "*")).bytes.toString(Charsets.UTF_8))
        if(result.optInt("exists")==1)return
        val url=result.getString("url");safeExternal(url)
        val prefix=result.getString("prefix").toByteArray();val suffix=result.getString("suffix").toByteArray();val type=result.getString("contentType").toMediaType()
        val body=object:RequestBody(){override fun contentType()=type;override fun contentLength()=prefix.size.toLong()+file.length()+suffix.size;override fun writeTo(sink:BufferedSink){sink.write(prefix);file.inputStream().use{input->val buffer=ByteArray(64*1024);while(true){val n=input.read(buffer);if(n<0)break;sink.write(buffer,0,n)}};sink.write(suffix)}}
        val response=transport.request(Request.Builder().url(url).post(body).build(),64*1024);currentCoroutineContext().ensureActive();cooldown(response.code,response.headers);require(response.code in 200..299){"附件上传未完成，保留原断点"}
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
            while(true){val origin=request.url.host=="api.zotero.org";if(origin)beforeApi()
                val response=transport.download(request,target,512L*1024*1024);currentCoroutineContext().ensureActive()
                if(origin)acceptApi(response.code,response.headers,allowRedirect=true) else {cooldown(response.code,response.headers);if(response.code==429)throw AppFailure("backoff","附件服务要求等待，原断点保留")}
                if(response.code in 300..399){require(redirects++<5){"附件重定向过多"};val location=response.headers.entries.firstOrNull{it.key.equals("Location",true)}?.value?:error("缺少附件地址");val resolved=request.url.resolve(location)?.toString()?:error("无效附件地址");safeExternal(resolved);request=Request.Builder().url(resolved).get().build();continue};require(response.code==200&&response.bytes==file.length()&&response.sha256==r.getString("sha256")){"附件下载原 SHA 回读不一致"};break}
        }finally{target.delete()}
    }
    private fun filename(r:JSONObject)=when(r.getString("contentType")){"application/pdf"->"${r.getString("role")}.pdf";"text/html"->"${r.getString("role")}.html";else->"${r.getString("role")}.json"}
    private suspend fun beforeApi(){currentCoroutineContext().ensureActive();if(connection().optLong("backoffUntil")>clock())throw AppFailure("backoff","Zotero 要求等待冷却，请稍后沿原断点继续")}
    private fun cooldown(code:Int,headers:Map<String,String>){
        val wait=headers.entries.filter{it.key.equals("Backoff",true)||it.key.equals("Retry-After",true)}.mapNotNull{entry->entry.value.toLongOrNull()?:runCatching{((java.time.ZonedDateTime.parse(entry.value,java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli()-clock()+999)/1000).coerceAtLeast(0)}.getOrNull()}.maxOrNull()?:if(code==429)60L else null
        if(wait!=null&&wait>0){val c=connection();c.put("backoffUntil",maxOf(c.optLong("backoffUntil"),clock()+wait.coerceAtMost((Long.MAX_VALUE-clock())/1000)*1000));JsonFiles.write(profile,c)}
    }
    private fun acceptApi(code:Int,headers:Map<String,String>,allow404:Boolean=false,allowRedirect:Boolean=false){
        cooldown(code,headers)
        if(code !in 200..299&&!(allow404&&code==404)&&!(allowRedirect&&code in 300..399))throw AppFailure(when(code){401->"authentication";403->"permission";412->"conflict";413->"quota";429->"backoff";else->"zotero"},when(code){401->"Zotero API key 未被接受";403->"Zotero 权限不足，或群组不允许文件写入";412->"远端版本已变化，已保留断点且不会覆盖";413->"Zotero 文件配额不足";429->"Zotero 要求等待，请稍后续传";else->"Zotero 请求未完成（HTTP $code），原断点保留"})
    }
    private suspend fun api(method:String,path:String,body:RequestBody?=null,headers:Map<String,String> = emptyMap(),allow404:Boolean=false):HttpBytes {
        val response=transport.request(apiRequest(method,path,body,headers));currentCoroutineContext().ensureActive();acceptApi(response.code,response.headers,allow404);return response
    }
    private suspend fun apiRequest(method:String,path:String,body:RequestBody?,headers:Map<String,String>):Request {
        beforeApi();require(path.startsWith("/")&&!path.startsWith("//"));val secret=try{secrets.load("zotero.primary")}catch(e:Exception){if(e is CancellationException)throw e;throw AppFailure("credentialsUnavailable","无法读取本机 Zotero key，请在设置中重新保存")}
        currentCoroutineContext().ensureActive();require(!secret.isNullOrBlank()){ "请先保存 Zotero 专用 API key" }
        return Request.Builder().url("https://api.zotero.org$path").header("Zotero-API-Version","3").header("Zotero-API-Key",secret).apply{headers.forEach{(k,v)->header(k,v)}}.method(method,body).build()
    }
    companion object {
        fun validKey(key:String)=key.matches(Regex("[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}"))
        private fun newKey():String {val alphabet="23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";val random=java.security.SecureRandom();return (1..8).map{alphabet[random.nextInt(alphabet.length)]}.joinToString("")}
        fun safeExternal(url:String){val u=URI(url);require(u.scheme=="https"&&u.host!=null&&u.userInfo==null&&u.fragment==null){"附件地址不安全"}}
        private fun hash(file:File,algorithm:String="SHA-256"):String{val md=MessageDigest.getInstance(algorithm);file.inputStream().use{input->val b=ByteArray(65536);while(true){val n=input.read(b);if(n<0)break;md.update(b,0,n)}};return md.digest().joinToString(""){"%02x".format(it.toInt()and 255)}}
        private fun safeMessage(error:Exception)=if(error is AppFailure||error is IllegalArgumentException)error.message?:"存档未完成" else "存档未完成，原件和断点已保留"
    }
}
