package com.nanless.paperdigest.zotero.webdav

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.UUID

/** Native configuration only; no URL, identity or secret can be supplied by a journal/UI operation. */
class ZoteroDavTarget private constructor(
    val destinationID:String,val accountID:String,val userID:String,val root:String,
    internal val username:String,
) {
    internal fun binding():JSONObject=JSONObject().put("backend","webdav").put("destinationID",destinationID).put("accountID",accountID).put("userID",userID).put("root",root)
    internal fun matches(binding:JSONObject):Boolean=runCatching{binding.length()==5&&binding.opt("backend")=="webdav"&&binding.opt("destinationID")==destinationID&&binding.opt("accountID")==accountID&&binding.opt("userID")==userID&&binding.opt("root")==root}.getOrDefault(false)
    internal val secretScope:String get()="zotero.webdav.$destinationID"
    internal fun davURL(key:String,extension:String):String {davRequire(validKey(key)&&extension in setOf("zip","prop"),"identity");return "$root$key.$extension"}
    internal fun apiURL(key:String):String {davRequire(validKey(key),"identity");return "https://api.zotero.org/users/$userID/items/$key"}
    companion object {
        /** IDs are generated/loaded by the native config owner, never accepted from a restore/archive payload. */
        fun native(libraryType:String,userID:String,baseURL:String,username:String,destinationID:String,accountID:String):ZoteroDavTarget {
            davRequire(libraryType=="users","personalOnly")
            davRequire(userID.matches(Regex("[1-9][0-9]{0,15}"))&&validUUID(destinationID)&&validUUID(accountID),"identity")
            davRequire(Charsets.UTF_8.newEncoder().canEncode(username)&&username.isNotBlank()&&username.toByteArray(Charsets.UTF_8).size<=1024&&!username.any{it==':'||it.code<32||it.code==127},"account")
            return ZoteroDavTarget(destinationID,accountID,userID,canonicalRoot(baseURL),username)
        }
        internal fun canonicalRoot(value:String):String {
            davRequire(Charsets.UTF_8.newEncoder().canEncode(value)&&value.length<=4096&&!value.any{it=='\\'||it.code<33||it.code==127},"target")
            val u=try{URI(value)}catch(_:Exception){throw ZoteroDavFailure("target")}
            val host=u.host?.lowercase()?:throw ZoteroDavFailure("target")
            davRequire(u.scheme.equals("https",true)&&u.rawUserInfo==null&&u.rawQuery==null&&u.rawFragment==null&&(u.port==-1||u.port in 1..65535),"target")
            // DNS names only. The transport also rejects private/reserved resolved addresses.
            davRequire(host.matches(Regex("[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?"))&&host.contains('.')&&!host.split('.').any{it.isEmpty()}&&!host.matches(Regex("[0-9.]+"))&&!listOf(".localhost",".local",".internal",".lan",".invalid",".test").any{host.endsWith(it)},"target")
            val path=u.rawPath.orEmpty();davRequire(path.isEmpty()||path.startsWith('/')&&!path.contains("//"),"target")
            val segments=path.removePrefix("/").removeSuffix("/").takeIf{it.isNotEmpty()}?.split('/')?.map(::decodeSegment)?:emptyList()
            davRequire(segments.lastOrNull()?.equals("zotero",true)!=true,"baseAlreadyZotero")
            val port=if(u.port==-1||u.port==443)"" else ":${u.port}"
            return "https://$host$port/"+(if(segments.isEmpty())"" else segments.joinToString("/",transform=::encodeSegment)+"/")+"zotero/"
        }
        private fun decodeSegment(raw:String):String {
            val output=ByteArrayOutputStream();var i=0
            while(i<raw.length){if(raw[i]=='%'){davRequire(i+2<raw.length,"target");val n=raw.substring(i+1,i+3).toIntOrNull(16)?:throw ZoteroDavFailure("target");output.write(n);i+=3}else{val cp=raw.codePointAt(i);output.write(String(Character.toChars(cp)).toByteArray(Charsets.UTF_8));i+=Character.charCount(cp)}}
            val decoded=try{Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(output.toByteArray())).toString()}catch(_:Exception){throw ZoteroDavFailure("target")}
            davRequire(decoded.isNotEmpty()&&decoded !in setOf(".","..")&&!decoded.any{it=='/'||it=='\\'||it=='%'||it.code<32||it.code==127},"target");return decoded
        }
        private fun encodeSegment(s:String):String=buildString{for(b in s.toByteArray(Charsets.UTF_8)){val n=b.toInt()and 255;if(n in 65..90||n in 97..122||n in 48..57||n in listOf(45,46,95,126))append(n.toChar())else append("%%%02X".format(n))}}
    }
}

/** One explicit run/resume lease. Config/key mutation retires it; only the Root can issue the next lease. */
class ZoteroDavLease private constructor(val target:ZoteroDavTarget,val apiRevision:String,val davRevision:String,val epoch:Long,private val current:()->Boolean,internal val borrowedAuthorization:ZoteroDavAuthorization?) {
    fun requireCurrent(){davRequire(current(),"stale");borrowedAuthorization?.requireCurrent(target)}
    companion object {
        fun native(target:ZoteroDavTarget,apiRevision:String,davRevision:String,epoch:Long,current:()->Boolean):ZoteroDavLease {
            davRequire(validUUID(apiRevision)&&validUUID(davRevision)&&epoch>=0,"identity");return ZoteroDavLease(target,apiRevision,davRevision,epoch,current,null)
        }
        fun nativeBorrowed(target:ZoteroDavTarget,apiRevision:String,davRevision:String,epoch:Long,authorization:ZoteroDavAuthorization,current:()->Boolean):ZoteroDavLease {
            davRequire(validUUID(apiRevision)&&validUUID(davRevision)&&epoch>=0,"identity");authorization.requireCurrent(target);return ZoteroDavLease(target,apiRevision,davRevision,epoch,current,authorization)
        }
    }
}

class ZoteroDavFailure internal constructor(val code:String):Exception(when(code){
    "personalOnly"->"WebDAV 附件仅支持个人文库，群组仍使用 Zotero Storage"
    "baseAlreadyZotero"->"请填写 Zotero 附件目录的上一级地址，不要重复填写 zotero"
    "stale"->"连接或凭据已变化，原断点保留；请明确选择原目标后续传"
    "conflict"->"远端材料或版本已变化，不会覆盖；原断点保留"
    "authentication"->"附件连接未被认证，原材料和断点保留"
    "backoff"->"服务要求稍后再试，原断点保留"
    "permission"->"当前连接缺少所选个人文库的读写权限"
    "cancelled"->"本次附件操作已取消，原断点保留"
    "capacity"->"当前可用空间不足或无法确认，请保留原件并释放空间后重试"
    "storage"->"材料暂时无法保存或读取，原记录保留"
    "target","account"->"附件连接地址或账号格式不正确，请检查所填连接"
    "redirect"->"附件服务返回了不同地址，为保护凭据已停止连接"
    "transport"->"附件连接未完成，原材料和断点保留"
    "apiMetadata"->"条目的实际回读不一致，未把上传当作完成"
    "contentType"->"此类附件尚不能安全存档，请保留原文件"
    else->"材料或断点未通过核验，未更换或覆盖原件"
})
internal fun davRequire(ok:Boolean,code:String){if(!ok)throw ZoteroDavFailure(code)}
internal fun validUUID(s:String)=runCatching{UUID.fromString(s).toString()==s}.getOrDefault(false)
internal fun validKey(s:String)=s.matches(Regex("[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}"))
