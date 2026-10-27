package com.nanless.paperdigest.zotero.webdav

import com.nanless.paperdigest.data.SafeHttp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okio.BufferedSink
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.net.InetAddress
import java.net.Proxy
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.StandardOpenOption.READ
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal data class DavWireReply(val code:Int,val headers:Map<String,String>,val body:ByteArray=byteArrayOf(),val bytes:Long=0,val sha256:String?=null)
internal interface DavWireTransport {suspend fun exchange(request:Request,limit:Long,reply:DavReplyFile?=null,check:()->Unit):DavWireReply}

/** Only this operation may remove a readback it actually created, after its callback drained. */
internal class DavReplyFile(private val journal:DavJournal,val file:File) {
    private val owned=AtomicReference<Any?>()
    fun open():FileChannel {journal.checkDirectory();davRequire(owned.get()==null,"storage");val channel=DavFiles.newChannel(file);try{owned.set(DavFiles.regular(file).fileKey());return channel}catch(e:Exception){channel.close();throw e}}
    fun cleanup(){journal.checkDirectory();val key=owned.get()?:return;if(file.exists()&&!java.nio.file.Files.isSymbolicLink(file.toPath())){val a=DavFiles.regular(file);if(a.fileKey()==key)davRequire(file.delete(),"storage")}}
}

internal class DavFileBody(private val file:File,private val bytes:Long,private val sha:String,private val type:String,private val check:()->Unit):RequestBody(){
    override fun contentType()=type.toMediaType()
    override fun contentLength()=bytes
    override fun isOneShot()=true
    override fun writeTo(sink:BufferedSink){
        try {
        check();val before=DavFiles.regular(file);davRequire(before.size()==bytes,"sourceChanged");val digest=MessageDigest.getInstance("SHA-256");var count=0L
        FileChannel.open(file.toPath(),READ,NOFOLLOW_LINKS).use{input->val b=ByteBuffer.allocate(65536);while(true){check();b.clear();val n=input.read(b);if(n<0)break;davRequire(n>0,"storage");count+=n;davRequire(count<=bytes,"sourceChanged");digest.update(b.array(),0,n);sink.write(b.array(),0,n)}}
        check();DavFiles.same(file,before);davRequire(count==bytes&&davHex(digest.digest())==sha,"sourceChanged")
        }catch(_:Exception){throw IOException("附件传输未完成，原断点保留")}
    }
}

/** No production escape for local HTTP/private DNS, redirects, retries or inherited proxy. */
internal class ZoteroDavNetworkTransport internal constructor(private val calls:Call.Factory=hardenedClient()):DavWireTransport {
    override suspend fun exchange(request:Request,limit:Long,reply:DavReplyFile?,check:()->Unit):DavWireReply {
        check();davRequire(request.url.scheme=="https"&&request.url.username.isEmpty()&&request.url.password.isEmpty()&&request.url.fragment==null&&limit in 1..ZoteroDavCodec.MAX_ZIP,"target")
        val drained=CompletableDeferred<Unit>()
        try {
            return suspendCancellableCoroutine { continuation ->
                try{
                    val call=calls.newCall(request);continuation.invokeOnCancellation{call.cancel()}
                    call.enqueue(object:Callback{
                        override fun onFailure(call:Call,e:IOException){try{if(continuation.isActive)continuation.resumeWithException(ZoteroDavFailure("transport"))}finally{drained.complete(Unit)}}
                        override fun onResponse(call:Call,response:Response){
                            try{
                                val result=response.use{r->
                                    check();val headers=r.headers.names().associateWith{r.header(it).orEmpty()}
                                    // Never read a redirect/auth/error payload, and never follow it.
                                    if(r.code!=200||request.method!="GET")return@use DavWireReply(r.code,headers)
                                    val body=r.body?:throw ZoteroDavFailure("transport");davRequire(body.contentLength()<=limit,"limit")
                                    val digest=MessageDigest.getInstance("SHA-256");var count=0L
                                    val memory=if(reply==null)ByteArrayOutputStream() else null
                                    val channel=reply?.open()
                                    try{body.byteStream().use{input->val b=ByteArray(65536);while(true){check();val n=input.read(b);if(n<0)break;davRequire(n>0,"transport");count+=n;davRequire(count<=limit,"limit");digest.update(b,0,n);if(channel!=null){val buffer=ByteBuffer.wrap(b,0,n);while(buffer.hasRemaining())channel.write(buffer)}else memory!!.write(b,0,n)}};channel?.force(true)}finally{channel?.close()}
                                    check();DavWireReply(r.code,headers,memory?.toByteArray()?:byteArrayOf(),count,davHex(digest.digest()))
                                }
                                if(continuation.isActive)continuation.resume(result)
                            }catch(e:Exception){if(continuation.isActive)continuation.resumeWithException(if(e is CancellationException||e is ZoteroDavFailure)e else ZoteroDavFailure("transport"))}
                            finally{drained.complete(Unit)}
                        }
                    })
                }catch(e:Exception){drained.complete(Unit);if(continuation.isActive)continuation.resumeWithException(if(e is CancellationException||e is ZoteroDavFailure)e else ZoteroDavFailure("transport"))}
            }
        }finally{withContext(NonCancellable){drained.await()}}
    }
    companion object {
        internal fun hardenedClient(dns:Dns=Dns.SYSTEM):OkHttpClient=OkHttpClient.Builder().proxy(Proxy.NO_PROXY).followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
            .authenticator(Authenticator.NONE).proxyAuthenticator(Authenticator.NONE)
            .dns(object:Dns{override fun lookup(hostname:String):List<InetAddress>{val found=dns.lookup(hostname);davRequire(found.isNotEmpty()&&found.all(SafeHttp::isPublic),"target");return found}})
            .connectTimeout(30,TimeUnit.SECONDS).readTimeout(180,TimeUnit.SECONDS).callTimeout(180,TimeUnit.SECONDS).build()
    }
}

/** Shared server pacing survives restart; it is checked before either credential plane is read. */
internal class DavBackoff(private val files:DavFiles,private val clock:()->Long) {
    private val file=File(files.root,"backoff.json")
    private var apiUntil=0L;private var davUntil=0L
    private var expected:String?=null
    init{if(file.exists()){val bytes=DavFiles.read(file,4096);val j=org.json.JSONObject(strictText(bytes));apiUntil=strictLong(j.opt("apiUntil"),false)?:throw ZoteroDavFailure("storage");davUntil=strictLong(j.opt("davUntil"),false)?:throw ZoteroDavFailure("storage");expected=davHash(bytes)}}
    @Synchronized fun before(api:Boolean){files.check();if(expected!=null)davRequire(file.exists()&&davHash(DavFiles.read(file,4096))==expected,"journalChanged");else davRequire(!file.exists(),"journalChanged");davRequire((if(api)apiUntil else davUntil)<=clock(),"backoff")}
    @Synchronized fun record(api:Boolean,code:Int,headers:Map<String,String>){
        val now=clock();val waits=headers.entries.filter{it.key.equals("Retry-After",true)||it.key.equals("Backoff",true)}.mapNotNull{e->e.value.toLongOrNull()?.takeIf{it>=0}?:runCatching{((java.time.ZonedDateTime.parse(e.value,java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli()-now+999)/1000).coerceAtLeast(0)}.getOrNull()}
        val seconds=waits.maxOrNull()?:if(code==429)60L else return
        if(seconds<=0)return
        files.check();if(expected!=null)davRequire(davHash(DavFiles.read(file,4096))==expected,"journalChanged")else davRequire(!file.exists(),"journalChanged")
        val until=now+seconds.coerceAtMost((9_007_199_254_740_991L-now).coerceAtLeast(0)/1000)*1000
        if(api)apiUntil=maxOf(apiUntil,until) else davUntil=maxOf(davUntil,until)
        val bytes=org.json.JSONObject().put("apiUntil",apiUntil).put("davUntil",davUntil).toString().toByteArray()
        files.writeAtomic(file,bytes);expected=davHash(bytes);files.check()
    }
}
