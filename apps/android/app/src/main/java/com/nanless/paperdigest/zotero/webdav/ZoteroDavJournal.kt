package com.nanless.paperdigest.zotero.webdav

import com.nanless.paperdigest.data.JsonFiles
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.charset.CodingErrorAction
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.StandardOpenOption.*
import java.nio.file.attribute.BasicFileAttributes
import java.security.MessageDigest
import java.util.UUID

internal fun davHex(bytes:ByteArray)=bytes.joinToString(""){"%02x".format(it.toInt()and 255)}
internal fun davHash(bytes:ByteArray)=davHex(MessageDigest.getInstance("SHA-256").digest(bytes))
internal fun strictText(bytes:ByteArray):String=try{Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()}catch(_:Exception){throw ZoteroDavFailure("encoding")}
internal fun strictLong(value:Any?,positive:Boolean=true):Long? {val n=when(value){is Int->value.toLong();is Long->value;else->return null};return n.takeIf{it in (if(positive)1 else 0)..9_007_199_254_740_991}}
internal fun checkedUUID(s:String):String{davRequire(validUUID(s),"identity");return s}
internal fun shaField(s:String):String{davRequire(s.matches(Regex("[a-f0-9]{64}")),"identity");return s}
internal fun canonical(j:JSONObject):String=j.keys().asSequence().toList().sorted().joinToString(prefix="{",postfix="}"){k->JSONObject.quote(k)+":"+jsonValue(j.get(k))}
private fun jsonValue(v:Any?):String=when(v){null,JSONObject.NULL->"null";is JSONObject->canonical(v);is org.json.JSONArray->(0 until v.length()).joinToString(prefix="[",postfix="]"){jsonValue(v.get(it))};is String->JSONObject.quote(v);is Boolean->v.toString();is Number->{davRequire(v.toDouble().isFinite(),"journalChanged");v.toString()};else->throw ZoteroDavFailure("journalChanged")}

/** No whole-child canonicalization: only the native OS base may be resolved before construction. */
internal class DavFiles(root:File,private val directorySync:(File)->Unit=::syncDirectory) {
    val root:File=root.absoluteFile
    private val rootKey:Any
    init {ancestors(this.root);davRequire(this.root.toPath().normalize()==this.root.toPath(),"path");if(!this.root.exists())davRequire(this.root.mkdir(),"storage");directory(this.root);rootKey=attrs(this.root).fileKey()?:throw ZoteroDavFailure("storage");persistDirectory(this.root);persistDirectory(this.root.parentFile)}
    fun check(){directory(root);davRequire(attrs(root).fileKey()==rootKey,"path")}
    fun child(id:String):File{check();return File(root,checkedUUID(id)).also{directory(it)}}
    fun create(id:String):File{check();return File(root,checkedUUID(id)).also{davRequire(!it.exists()&&!Files.isSymbolicLink(it.toPath())&&it.mkdir(),"storage");directory(it);persistDirectory(it);persistDirectory(root)}}
    fun persistDirectory(dir:File){
        check();directory(dir);val key=attrs(dir).fileKey()?:throw ZoteroDavFailure("path")
        try{directorySync(dir)}catch(e:Exception){if(e is ZoteroDavFailure||e is kotlinx.coroutines.CancellationException)throw e;throw ZoteroDavFailure("storage")}
        directory(dir);davRequire(attrs(dir).fileKey()==key,"path");check()
    }
    fun createBytes(f:File,bytes:ByteArray){check();DavFiles.createBytes(f,bytes);persistDirectory(f.parentFile)}
    fun writeAtomic(f:File,bytes:ByteArray){check();JsonFiles.write(f,bytes);persistDirectory(f.parentFile)}
    fun named(dir:File,name:String):File{check();directory(dir);davRequire(dir.parentFile==root&&validUUID(dir.name)&&name.matches(Regex("[a-z0-9][a-z0-9.-]{0,90}"))&&!name.contains(".."),"path");return File(dir,name)}
    companion object {
        /** No fallback: an unsupported/failed directory fsync cannot grant durable intent. */
        fun syncDirectory(dir:File){directory(dir);val key=attrs(dir).fileKey()?:throw ZoteroDavFailure("path");FileChannel.open(dir.toPath(),READ,NOFOLLOW_LINKS).use{it.force(true)};directory(dir);davRequire(attrs(dir).fileKey()==key,"path")}
        fun attrs(f:File)=Files.readAttributes(f.toPath(),BasicFileAttributes::class.java,NOFOLLOW_LINKS)
        fun ancestors(f:File){var p:File?=f.absoluteFile;while(p!=null){davRequire(!Files.isSymbolicLink(p.toPath()),"path");p=p.parentFile}}
        fun directory(f:File){ancestors(f);davRequire(attrs(f).isDirectory,"path")}
        fun regular(f:File):BasicFileAttributes{ancestors(f);val a=attrs(f);davRequire(a.isRegularFile&&a.fileKey()!=null,"path");return a}
        fun same(f:File,before:BasicFileAttributes){val now=regular(f);davRequire(now.fileKey()==before.fileKey()&&now.size()==before.size()&&now.lastModifiedTime()==before.lastModifiedTime(),"sourceChanged")}
        fun newChannel(f:File)=FileChannel.open(f.toPath(),WRITE,CREATE_NEW,NOFOLLOW_LINKS)
        fun read(f:File,limit:Long):ByteArray{val a=regular(f);davRequire(a.size() in 0..limit&&a.size()<=Int.MAX_VALUE,"limit");val data=FileChannel.open(f.toPath(),READ,NOFOLLOW_LINKS).use{c->val b=ByteBuffer.allocate(a.size().toInt());while(b.hasRemaining()){davRequire(c.read(b)>0,"sourceChanged")};davRequire(c.read(ByteBuffer.allocate(1))<0,"sourceChanged");b.array()};same(f,a);return data}
        fun createBytes(f:File,bytes:ByteArray){newChannel(f).use{c->val b=ByteBuffer.wrap(bytes);while(b.hasRemaining())c.write(b);c.force(true)}}
        fun hash(f:File,check:()->Unit={}):String{val a=regular(f);val md=MessageDigest.getInstance("SHA-256");FileChannel.open(f.toPath(),READ,NOFOLLOW_LINKS).use{c->val b=ByteBuffer.allocate(65536);while(true){check();b.clear();val n=c.read(b);if(n<0)break;if(n>0)md.update(b.array(),0,n)}};same(f,a);return davHex(md.digest())}
    }
}

/** Native-owned identity, not a path or metadata supplied by an archive/restore UI payload. */
class ZoteroDavAttachment private constructor(
    val key:String,val parentKey:String,val role:String,val paperID:String,val sourceIdentity:String,
    val title:String,val contentType:String,val filename:String,val source:File,val sourceSHA256:String,
) {
    internal val roleTag:String get()="PaperDigest:$role:$sourceSHA256"
    internal fun descriptor():JSONObject=JSONObject().put("key",key).put("parentKey",parentKey).put("role",role).put("paperID",paperID).put("sourceIdentity",sourceIdentity).put("title",title).put("contentType",contentType).put("filename",filename).put("sourceSHA256",sourceSHA256)
    companion object {
        fun native(key:String,parentKey:String,role:String,paperID:String,sourceIdentity:String,title:String,contentType:String,source:File,sourceSHA256:String):ZoteroDavAttachment{
            davRequire(validKey(key)&&validKey(parentKey)&&key!=parentKey&&role in setOf("source-metadata","pdf","guide","analysis","note","guide-preview-pdf"),"identity")
            davRequire(paperID.isNotBlank()&&paperID.length<=2048&&!paperID.any{it.code<32}&&title.isNotBlank()&&title.length<=2048&&Charsets.UTF_8.newEncoder().canEncode(title)&&Charsets.UTF_8.newEncoder().canEncode(paperID),"identity")
            val extension=when(contentType){"application/pdf"->"pdf";"text/html"->"html";"application/json"->"json";else->throw ZoteroDavFailure("contentType")}
            shaField(sourceIdentity);shaField(sourceSHA256);DavFiles.regular(source)
            return ZoteroDavAttachment(key,parentKey,role,paperID,sourceIdentity,title,contentType,"$role.$extension",source,sourceSHA256)
        }
    }
}

internal class DavJournal(val files:DavFiles,val id:String,val dir:File,private var snapshot:ByteArray) {
    private val directoryKey=DavFiles.attrs(dir).fileKey()?:throw ZoteroDavFailure("path")
    fun checkDirectory(){files.check();DavFiles.directory(dir);davRequire(DavFiles.attrs(dir).fileKey()==directoryKey,"path")}
    val path get()=files.named(dir,"journal.json")
    fun read():JSONObject {checkDirectory();val current=DavFiles.read(path,256*1024);davRequire(current.contentEquals(snapshot),"journalChanged");return JSONObject(strictText(current)).also(::validate)}
    fun update(change:(JSONObject)->Unit){val old=read();val immutable=canonical(old.getJSONObject("plan"));change(old);validate(old);davRequire(canonical(old.getJSONObject("plan"))==immutable,"journalChanged");val data=old.toString().toByteArray();davRequire(data.size<=256*1024,"limit");files.check();davRequire(DavFiles.read(path,256*1024).contentEquals(snapshot),"journalChanged");files.writeAtomic(path,data);checkDirectory();snapshot=DavFiles.read(path,256*1024);davRequire(snapshot.contentEquals(data),"storage")}
    companion object {
        private fun validate(j:JSONObject){
            davRequire(j.opt("contract")=="paperdigest-zotero-webdav-v1"&&j.opt("id") is String&&validUUID(j.getString("id"))&&j.opt("planSHA256") is String,"journalChanged")
            shaField(j.getString("planSHA256"));davRequire(j.opt("phase") in setOf("prepared","zip-put-planned","prop-put-planned","api-patch-planned","api-verified","completed")&&j.opt("status") in setOf("prepared","running","verified","failed","cancelled"),"journalChanged")
            for(k in listOf("baseVersion","verifiedApiVersion"))if(j.has(k))davRequire(strictLong(j.opt(k))!=null,"journalChanged")
            for(k in listOf("zipVerified","propVerified"))if(j.has(k))davRequire(j.opt(k) is Boolean,"journalChanged")
            val a=j.optJSONArray("attempts")?:throw ZoteroDavFailure("journalChanged")
            for(i in 0 until a.length()){val t=a.getJSONObject(i);davRequire(listOf("id","apiRevision","davRevision").all{t.opt(it) is String&&validUUID(t.getString(it))}&&strictLong(t.opt("epoch"),false)!=null&&t.opt("status") in setOf("running","verified","failed","cancelled"),"journalChanged");for(k in listOf("startedAt","endedAt"))if(t.has(k))davRequire(t.opt(k) is String&&runCatching{java.time.Instant.parse(t.getString(k))}.isSuccess,"journalChanged")}
        }
        fun create(files:DavFiles,id:String,dir:File,plan:JSONObject):DavJournal{
            val body=JSONObject().put("contract","paperdigest-zotero-webdav-v1").put("id",checkedUUID(id)).put("createdAt",java.time.Instant.now().toString()).put("plan",plan).put("planSHA256",davHash(canonical(plan).toByteArray())).put("phase","prepared").put("status","prepared").put("attempts",org.json.JSONArray())
            val bytes=body.toString().toByteArray();val path=files.named(dir,"journal.json");files.createBytes(path,bytes);return DavJournal(files,id,dir,bytes)
        }
        fun reopen(files:DavFiles,id:String):DavJournal {val dir=files.child(id);val data=DavFiles.read(files.named(dir,"journal.json"),256*1024);val raw=JSONObject(strictText(data));validate(raw);davRequire(raw.getString("contract")=="paperdigest-zotero-webdav-v1"&&raw.getString("id")==id&&raw.getString("planSHA256")==davHash(canonical(raw.getJSONObject("plan")).toByteArray()),"journalChanged");return DavJournal(files,id,dir,data)}
    }
}
