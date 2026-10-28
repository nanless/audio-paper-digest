package com.nanless.paperdigest.zotero

import com.nanless.paperdigest.data.AppFailure
import com.nanless.paperdigest.data.HttpBytes
import com.nanless.paperdigest.data.HttpFile
import com.nanless.paperdigest.zotero.webdav.DavFiles
import com.nanless.paperdigest.zotero.webdav.ZoteroDavNetworkTransport
import kotlinx.coroutines.*
import okhttp3.*
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.ProtocolException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.nio.ByteBuffer
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.security.MessageDigest
import java.util.UUID
import java.util.IdentityHashMap
import java.util.concurrent.RejectedExecutionException
import javax.net.ssl.SSLException
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Fixed categories only: never retain the original throwable or its text. */
internal class ZoteroTransportObservation private constructor(
    val operation:Operation,val stage:Stage,val types:List<FailureType>,
    val callCancelled:Boolean?,val contextActive:Boolean,val destination:Destination,
):Exception("Zotero transport categories only",null,false,false) {
    enum class Operation { REQUEST, FILE_READBACK }
    enum class Destination { API, FILES, OTHER, UNKNOWN }
    enum class Stage { CREATE_CALL, ENQUEUE, CALLBACK_FAILURE, RESPONSE_READ }
    enum class FailureType { DNS, CONNECT, TIMEOUT, TLS_PEER, TLS_HANDSHAKE, TLS, PROTOCOL, SOCKET, INTERRUPTED_IO, IO, DISPATCHER, SECURITY, OTHER }
    companion object {
        /** The Root operation wrapper preserves only a new copy of our fixed categories. */
        fun operationFailure(message:String,error:Exception):AppFailure {
            val result=AppFailure("operation",message)
            val observation=error.suppressed.firstOrNull{it is ZoteroTransportObservation} as? ZoteroTransportObservation
            if(observation!=null)result.addSuppressed(ZoteroTransportObservation(
                observation.operation,observation.stage,observation.types.toList(),
                observation.callCancelled,observation.contextActive,observation.destination,
            ))
            return result
        }
        fun destination(request:Request):Destination=when(request.url.host){
            "api.zotero.org"->Destination.API
            "files.zotero.net"->Destination.FILES
            else->Destination.OTHER
        }
        fun capture(operation:Operation,stage:Stage,error:Exception,call:Call?,contextActive:Boolean,destination:Destination=Destination.UNKNOWN):ZoteroTransportObservation {
            val seen=IdentityHashMap<Throwable,Boolean>();val types=ArrayList<FailureType>();var next:Throwable?=error
            repeat(4){
                val value=next
                if(value!=null&&seen.put(value,true)==null){
                    types+=when(value){
                        is UnknownHostException->FailureType.DNS
                        is SocketTimeoutException->FailureType.TIMEOUT
                        is SSLPeerUnverifiedException->FailureType.TLS_PEER
                        is SSLHandshakeException->FailureType.TLS_HANDSHAKE
                        is SSLException->FailureType.TLS
                        is ConnectException->FailureType.CONNECT
                        is ProtocolException->FailureType.PROTOCOL
                        is SocketException->FailureType.SOCKET
                        is InterruptedIOException->FailureType.INTERRUPTED_IO
                        is IOException->FailureType.IO
                        is RejectedExecutionException->FailureType.DISPATCHER
                        is SecurityException->FailureType.SECURITY
                        else->FailureType.OTHER
                    }
                    next=runCatching{value.cause}.getOrNull()
                }else next=null
            }
            return ZoteroTransportObservation(operation,stage,types.toList(),runCatching{call?.isCanceled()}.getOrNull(),contextActive,destination)
        }
    }
    fun failure():AppFailure {
        val kind=types.firstOrNull{it!=FailureType.IO&&it!=FailureType.OTHER}?:types.first()
        val detail=when(kind){
            FailureType.DNS->"域名解析未完成"
            FailureType.CONNECT->"连接未能建立"
            FailureType.TIMEOUT->"请求等待超时"
            FailureType.TLS_PEER->"安全证书核验未通过"
            FailureType.TLS_HANDSHAKE,FailureType.TLS->"安全连接未能建立"
            FailureType.PROTOCOL->"服务响应格式未能读取"
            FailureType.SOCKET->"网络连接异常"
            FailureType.INTERRUPTED_IO->"传输被中断"
            FailureType.DISPATCHER->"请求暂时无法发出"
            FailureType.SECURITY->"请求受本机安全限制"
            FailureType.IO,FailureType.OTHER->"传输未完成"
        }
        val action=if(operation==Operation.REQUEST)"Zotero 连接未完成"else"Zotero 附件回读未完成"
        return AppFailure("transport","$action（$detail），原断点保留").also{it.addSuppressed(this)}
    }
}

/** Zotero owns callback lifetime, including ordinary API requests and Storage readbacks. */
internal class ZoteroDrainedTransport(private val calls:Call.Factory=ZoteroDavNetworkTransport.hardenedClient(),private val ownedFiles:ZoteroOwnedDownloadFiles=AndroidZoteroOwnedDownloadFiles):ZoteroTransport {
    override suspend fun request(request:Request,limit:Int):HttpBytes {
        require(limit>0)
        return exchange(request,ZoteroTransportObservation.Operation.REQUEST){response,check->
            val body=response.body?:throw AppFailure("transport","服务未返回内容")
            require(body.contentLength()<=limit){"服务响应超过大小限制"}
            val output=ByteArrayOutputStream()
            body.byteStream().use{input->val buffer=ByteArray(65536);while(true){check();val n=input.read(buffer);if(n<0)break;require(output.size().toLong()+n<=limit){"服务响应超过大小限制"};output.write(buffer,0,n)}}
            check();HttpBytes(response.code,headers(response),output.toByteArray())
        }
    }
    override suspend fun download(request:Request,target:File,limit:Long):HttpFile=downloadInto(request,target,limit,null)
    override suspend fun downloadOwned(request:Request,target:File,limit:Long,owned:(ZoteroOwnedFileReceipt)->Unit):HttpFile=downloadInto(request,target,limit,owned)
    private suspend fun downloadInto(request:Request,target:File,limit:Long,owned:((ZoteroOwnedFileReceipt)->Unit)?):HttpFile {
        require(limit>0);DavFiles.directory(target.parentFile)
        require(!Files.isSymbolicLink(target.toPath())){"下载目标不能是链接"}
        val temporary=File(target.parentFile,".zotero-readback-${UUID.randomUUID()}")
        var createdKey:Any?=null;var complete=false;var failure:Throwable?=null
        var privateSink:ZoteroOwnedDownloadSink?=null
        try{return exchange(request,ZoteroTransportObservation.Operation.FILE_READBACK){response,check->
            if(response.code !in 200..299)return@exchange HttpFile(response.code,headers(response),0,null)
            val body=response.body?:throw AppFailure("transport","服务未返回文件")
            require(body.contentLength()<=limit){"下载文件超过大小限制"}
            var count=0L;val digest=MessageDigest.getInstance("SHA-256")
            val output=if(owned==null)DavFiles.newChannel(temporary)else ownedFiles.create(target).also{privateSink=it;owned(it.receipt)}.channel
            output.use{channel->if(owned==null)createdKey=DavFiles.regular(temporary).fileKey();body.byteStream().use{input->val b=ByteArray(65536);while(true){check();val n=input.read(b);if(n<0)break;count+=n;require(count<=limit){"下载文件超过大小限制"};digest.update(b,0,n);val block=ByteBuffer.wrap(b,0,n);while(block.hasRemaining())channel.write(block)}};if(owned==null)channel.force(true)else requireNotNull(privateSink).force()}
            check();DavFiles.directory(target.parentFile);require(!Files.isSymbolicLink(target.toPath())){"下载目标不能是链接"}
            if(owned==null)Files.move(temporary.toPath(),target.toPath(),ATOMIC_MOVE,REPLACE_EXISTING)
            else requireNotNull(privateSink).receipt.requireCurrent()
            complete=true
            HttpFile(response.code,headers(response),count,digest.digest().joinToString(""){"%02x".format(it.toInt()and 255)})
        }}catch(e:Throwable){failure=e;throw e}finally{
            if(owned==null){if(createdKey!=null&&Files.exists(temporary.toPath(),NOFOLLOW_LINKS)&&!Files.isSymbolicLink(temporary.toPath())&&DavFiles.regular(temporary).fileKey()==createdKey)Files.delete(temporary.toPath())}
            else try{
                privateSink?.close()
                if(!complete)privateSink?.receipt?.deleteIfCurrent()
            }catch(cleanup:Throwable){val original=failure;if(original!=null)original.addSuppressed(cleanup)else throw cleanup}
        }
    }
    private fun headers(response:Response)=response.headers.names().associateWith{response.header(it).orEmpty()}
    private suspend fun <T> exchange(request:Request,operation:ZoteroTransportObservation.Operation,read:(Response,()->Unit)->T):T {
        val url=request.url
        require(url.scheme=="https"&&url.username.isEmpty()&&url.password.isEmpty()&&url.fragment==null){"服务地址必须是无凭据的 HTTPS"}
        val destination=ZoteroTransportObservation.destination(request)
        val context=currentCoroutineContext();context.ensureActive();val drained=CompletableDeferred<Unit>()
        try{return suspendCancellableCoroutine{continuation->
            var call:Call?=null;var stage=ZoteroTransportObservation.Stage.CREATE_CALL
            try{
                val created=calls.newCall(request);call=created;continuation.invokeOnCancellation{created.cancel()}
                stage=ZoteroTransportObservation.Stage.ENQUEUE
                created.enqueue(object:Callback{
                    override fun onFailure(call:Call,e:IOException){try{if(continuation.isActive)continuation.resumeWithException(ZoteroTransportObservation.capture(operation,ZoteroTransportObservation.Stage.CALLBACK_FAILURE,e,call,context.isActive,destination).failure())}finally{drained.complete(Unit)}}
                    override fun onResponse(call:Call,response:Response){try{
                        val result=response.use{read(it){context.ensureActive()}}
                        if(continuation.isActive)continuation.resume(result)
                    }catch(e:Exception){if(continuation.isActive)continuation.resumeWithException(if(e is CancellationException||e is AppFailure||e is IllegalArgumentException)e else ZoteroTransportObservation.capture(operation,ZoteroTransportObservation.Stage.RESPONSE_READ,e,call,context.isActive,destination).failure())}finally{drained.complete(Unit)}}
                })
            }catch(e:Exception){try{if(continuation.isActive)continuation.resumeWithException(if(e is CancellationException||e is AppFailure||e is IllegalArgumentException)e else ZoteroTransportObservation.capture(operation,stage,e,call,context.isActive,destination).failure())}finally{drained.complete(Unit)}}
        }}finally{withContext(NonCancellable){drained.await()}}
    }
}
