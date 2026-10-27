package com.nanless.paperdigest.zotero.webdav

import com.nanless.paperdigest.secret.SecretStore
import kotlinx.coroutines.CancellationException
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import org.json.JSONObject

/** Final typed API port: proofs only come from validated actual transport responses, never caller JSON. */
internal class ZoteroDavApiPort(private val secrets:SecretStore,private val transport:DavWireTransport) {
    internal data class Item(val version:Long,val md5:String?,val mtime:Long?)
    suspend fun authenticate(lease:ZoteroDavLease,check:()->Unit){
        val data=request(lease,"GET","https://api.zotero.org/keys/current",null,null,check)
        val user=strictLong(data.opt("userID"))?.toString()
        val access=data.optJSONObject("access")?.optJSONObject("user")
        // WebDAV writes item metadata; Storage /file permission is not inferred as necessary.
        davRequire(user==lease.target.userID&&access?.opt("library")==true&&access.opt("write")==true,"permission")
    }
    suspend fun read(lease:ZoteroDavLease,plan:JSONObject,check:()->Unit):Item {
        val a=plan.getJSONObject("attachment");val data=request(lease,"GET",lease.target.apiURL(a.getString("key"))+"?format=json",null,null,check)
        val item=data.optJSONObject("data")?:throw ZoteroDavFailure("apiMetadata")
        val version=strictLong(item.opt("version"))?:throw ZoteroDavFailure("apiMetadata")
        davRequire(strictLong(data.opt("version"))==version,"apiMetadata")
        val library=data.optJSONObject("library")?:throw ZoteroDavFailure("apiMetadata")
        davRequire(library.opt("type")=="user"&&strictLong(library.opt("id"))?.toString()==lease.target.userID,"permission")
        data.opt("key")?.let{davRequire(it==a.getString("key"),"apiMetadata")}
        davRequire(item.opt("key")==a.getString("key")&&item.opt("parentItem")==a.getString("parentKey")&&item.opt("itemType")=="attachment"&&item.opt("linkMode")=="imported_file"&&item.opt("filename")==a.getString("filename")&&item.opt("contentType")==a.getString("contentType")&&item.opt("title")==a.getString("title"),"conflict")
        val roleTag="PaperDigest:${a.getString("role")}:${a.getString("sourceSHA256")}"
        val tags=item.optJSONArray("tags")?:throw ZoteroDavFailure("conflict")
        davRequire((0 until tags.length()).any{tags.optJSONObject(it)?.opt("tag")==roleTag},"conflict")
        val rawMD5=item.opt("md5");val md5=if(rawMD5==null||rawMD5==JSONObject.NULL||rawMD5=="")null else (rawMD5 as? String)?.takeIf{it.matches(Regex("[a-f0-9]{32}"))}?:throw ZoteroDavFailure("apiMetadata")
        val rawTime=item.opt("mtime");val mtime=if(rawTime==null||rawTime==JSONObject.NULL)null else (strictLong(rawTime)?:((rawTime as? String)?.takeIf{it.matches(Regex("[1-9][0-9]{0,12}"))}?.toLong()))?.takeIf{it<=9_999_999_999_999L}?:throw ZoteroDavFailure("apiMetadata")
        davRequire((md5==null)==(mtime==null),"apiMetadata");return Item(version,md5,mtime)
    }
    suspend fun patch(lease:ZoteroDavLease,plan:JSONObject,version:Long,check:()->Unit){
        val f=plan.getJSONObject("file");val body=JSONObject().put("md5",f.getString("md5")).put("mtime",f.getLong("mtime"))
        request(lease,"PATCH",lease.target.apiURL(plan.getJSONObject("attachment").getString("key")),body,version,check)
    }
    private suspend fun request(lease:ZoteroDavLease,method:String,url:String,body:JSONObject?,version:Long?,check:()->Unit):JSONObject{
        check();lease.requireCurrent()
        val key=try{secrets.load("zotero.primary")}catch(e:Exception){if(e is CancellationException||e is ZoteroDavFailure)throw e;throw ZoteroDavFailure("authentication")}
        check();lease.requireCurrent();davRequire(!key.isNullOrBlank()&&key.length<=8192&&!key.any{it.code<32||it.code==127},"authentication")
        val request=try{Request.Builder().url(url).header("Zotero-API-Version","3").header("Zotero-API-Key",key?:throw ZoteroDavFailure("authentication")).header("User-Agent","audio-paper-digest/1.0").header("Cache-Control","no-cache").apply{if(version!=null)header("If-Unmodified-Since-Version",version.toString())}.method(method,body?.toString()?.toRequestBody("application/json".toMediaType())).build()}catch(_:Exception){throw ZoteroDavFailure("authentication")}
        val r=transport.exchange(request,256*1024,check=check);check();lease.requireCurrent()
        davRequire(r.code==if(method=="PATCH")204 else 200,httpCode(r.code))
        if(method=="PATCH")return JSONObject() // Accepted is not verification; caller must do the actual GET.
        return try{JSONObject(strictText(r.body))}catch(e:Exception){if(e is ZoteroDavFailure)throw e;throw ZoteroDavFailure("apiMetadata")}
    }
}
internal fun httpCode(code:Int)=when(code){401->"authentication";403->"permission";412->"conflict";429->"backoff";in 300..399->"redirect";else->"transport"}
