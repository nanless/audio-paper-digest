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
import java.nio.ByteBuffer
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.security.MessageDigest
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Zotero owns callback lifetime, including ordinary API requests and Storage readbacks. */
internal class ZoteroDrainedTransport(private val calls:Call.Factory=ZoteroDavNetworkTransport.hardenedClient()):ZoteroTransport {
    override suspend fun request(request:Request,limit:Int):HttpBytes {
        require(limit>0)
        return exchange(request){response,check->
            val body=response.body?:throw AppFailure("transport","服务未返回内容")
            require(body.contentLength()<=limit){"服务响应超过大小限制"}
            val output=ByteArrayOutputStream()
            body.byteStream().use{input->val buffer=ByteArray(65536);while(true){check();val n=input.read(buffer);if(n<0)break;require(output.size().toLong()+n<=limit){"服务响应超过大小限制"};output.write(buffer,0,n)}}
            check();HttpBytes(response.code,headers(response),output.toByteArray())
        }
    }
    override suspend fun download(request:Request,target:File,limit:Long):HttpFile {
        require(limit>0);DavFiles.directory(target.parentFile)
        require(!Files.isSymbolicLink(target.toPath())){"下载目标不能是链接"}
        val temporary=File(target.parentFile,".zotero-readback-${UUID.randomUUID()}")
        var createdKey:Any?=null
        try{return exchange(request){response,check->
            if(response.code !in 200..299)return@exchange HttpFile(response.code,headers(response),0,null)
            val body=response.body?:throw AppFailure("transport","服务未返回文件")
            require(body.contentLength()<=limit){"下载文件超过大小限制"}
            var count=0L;val digest=MessageDigest.getInstance("SHA-256")
            DavFiles.newChannel(temporary).use{output->createdKey=DavFiles.regular(temporary).fileKey();body.byteStream().use{input->val b=ByteArray(65536);while(true){check();val n=input.read(b);if(n<0)break;count+=n;require(count<=limit){"下载文件超过大小限制"};digest.update(b,0,n);val block=ByteBuffer.wrap(b,0,n);while(block.hasRemaining())output.write(block)}};output.force(true)}
            check();DavFiles.directory(target.parentFile);require(!Files.isSymbolicLink(target.toPath())){"下载目标不能是链接"}
            Files.move(temporary.toPath(),target.toPath(),ATOMIC_MOVE,REPLACE_EXISTING)
            HttpFile(response.code,headers(response),count,digest.digest().joinToString(""){"%02x".format(it.toInt()and 255)})
        }}finally{if(createdKey!=null&&Files.exists(temporary.toPath(),NOFOLLOW_LINKS)&&!Files.isSymbolicLink(temporary.toPath())&&DavFiles.regular(temporary).fileKey()==createdKey)Files.delete(temporary.toPath())}
    }
    private fun headers(response:Response)=response.headers.names().associateWith{response.header(it).orEmpty()}
    private suspend fun <T> exchange(request:Request,read:(Response,()->Unit)->T):T {
        val url=request.url
        require(url.scheme=="https"&&url.username.isEmpty()&&url.password.isEmpty()&&url.fragment==null){"服务地址必须是无凭据的 HTTPS"}
        val context=currentCoroutineContext();context.ensureActive();val drained=CompletableDeferred<Unit>()
        try{return suspendCancellableCoroutine{continuation->
            try{
                val call=calls.newCall(request);continuation.invokeOnCancellation{call.cancel()}
                call.enqueue(object:Callback{
                    override fun onFailure(call:Call,e:IOException){try{if(continuation.isActive)continuation.resumeWithException(AppFailure("transport","Zotero 连接未完成，原断点保留"))}finally{drained.complete(Unit)}}
                    override fun onResponse(call:Call,response:Response){try{
                        val result=response.use{read(it){context.ensureActive()}}
                        if(continuation.isActive)continuation.resume(result)
                    }catch(e:Exception){if(continuation.isActive)continuation.resumeWithException(if(e is CancellationException||e is AppFailure||e is IllegalArgumentException)e else AppFailure("transport","Zotero 回读未完成，原断点保留"))}finally{drained.complete(Unit)}}
                })
            }catch(e:Exception){try{if(continuation.isActive)continuation.resumeWithException(if(e is IllegalArgumentException)e else AppFailure("transport","Zotero 连接未完成，原断点保留"))}finally{drained.complete(Unit)}}
        }}finally{withContext(NonCancellable){drained.await()}}
    }
}
