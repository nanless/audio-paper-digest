package com.nanless.paperdigest.zotero.webdav

import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.IOException
import java.net.InetAddress
import java.net.Proxy
import java.nio.file.Files
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

class ZoteroDavTransportTest {
    private class CallImpl(val req:Request,val script:(CallImpl,Callback)->Unit):Call {
        val cancelled=AtomicBoolean(false);var executed=false
        override fun request()=req
        override fun enqueue(responseCallback:Callback){executed=true;thread(name="synthetic-dav-callback"){script(this,responseCallback)}}
        override fun execute():Response=error("not used")
        override fun cancel(){cancelled.set(true)}
        override fun isExecuted()=executed
        override fun isCanceled()=cancelled.get()
        override fun timeout()=Timeout.NONE
        override fun clone():Call=CallImpl(req,script)
    }
    private fun response(request:Request,code:Int,body:ResponseBody)=Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(code).message("synthetic").body(body).build()
    private suspend fun rejects(body:suspend()->Unit):ZoteroDavFailure {try{body()}catch(e:ZoteroDavFailure){return e};throw AssertionError("Expected refusal")}
    @Test fun defaultClientNoRedirectRetryProxyOrAuthenticationRetry(){val c=ZoteroDavNetworkTransport.hardenedClient();assertFalse(c.followRedirects);assertFalse(c.followSslRedirects);assertFalse(c.retryOnConnectionFailure);assertEquals(Proxy.NO_PROXY,c.proxy);assertEquals(Authenticator.NONE,c.authenticator);assertEquals(Authenticator.NONE,c.proxyAuthenticator)}
    @Test fun privateMixedAndReservedDnsFailWithoutNetwork(){for(addresses in listOf(listOf("127.0.0.1"),listOf("8.8.8.8","10.0.0.1"),listOf("169.254.1.1"),listOf("192.0.2.1"),listOf("::1"),listOf("fc00::1"))){val dns=object:Dns{override fun lookup(hostname:String)=addresses.map{InetAddress.getByName(it)}};try{ZoteroDavNetworkTransport.hardenedClient(dns).dns.lookup("dav.example.org");fail("private DNS accepted")}catch(_:ZoteroDavFailure){}};assertEquals(1,ZoteroDavNetworkTransport.hardenedClient(object:Dns{override fun lookup(hostname:String)=listOf(InetAddress.getByAddress(byteArrayOf(8,8,8,8)))}).dns.lookup("dav.example.org").size)}
    @Test fun wrongSchemeOrEmbeddedAuthRejectBeforeCallCreation()=runBlocking{var calls=0;val transport=ZoteroDavNetworkTransport(Call.Factory{r->calls++;CallImpl(r){_,_->}});for(url in listOf("http://dav.example.org/a","https://u:p@dav.example.org/a"))rejects{transport.exchange(Request.Builder().url(url).build(),100,check={})};assertEquals(0,calls)}
    @Test fun callbackExceptionDoesNotExposeRawVendorText()=runBlocking{val transport=ZoteroDavNetworkTransport(Call.Factory{r->CallImpl(r){c,cb->cb.onFailure(c,IOException("SYNTHETIC_PASSWORD_OR_VENDOR_BODY"))}});val e=rejects{transport.exchange(Request.Builder().url("https://dav.example.org/a").build(),100,check={})};assertFalse(e.message!!.contains("SYNTHETIC_PASSWORD_OR_VENDOR_BODY"))}
    @Test fun redirectBodyNotReadOrFollowed()=runBlocking{var calls=0;val read=AtomicBoolean(false);val transport=ZoteroDavNetworkTransport(Call.Factory{r->calls++;CallImpl(r){c,cb->val body=object:ResponseBody(){override fun contentType()="text/plain".toMediaType();override fun contentLength()=10L;override fun source():BufferedSource=object:Source{override fun read(sink:Buffer,byteCount:Long):Long{read.set(true);error("Redirect must never be read")};override fun timeout()=Timeout.NONE;override fun close(){}}.buffer()};cb.onResponse(c,response(r,302,body))}});val r=transport.exchange(Request.Builder().url("https://dav.example.org/a").build(),100,check={});assertEquals(302,r.code);assertEquals(1,calls);assertFalse(read.get())}
    @Test fun cancellationWaitsForRealBodyCallbackAndOwnedReadbackClose()=runBlocking{
        val root=Files.createTempDirectory("dav-drain-").toFile().canonicalFile;try{
            val files=DavFiles(File(root,"control"));val id=UUID.randomUUID().toString();val dir=files.create(id);val journal=DavJournal.create(files,id,dir,JSONObject().put("synthetic",true));val reply=DavReplyFile(journal,files.named(dir,"readback.zip"))
            val entered=CountDownLatch(1);val release=CountDownLatch(1);val ended=CountDownLatch(1);val closed=AtomicBoolean(false)
            val transport=ZoteroDavNetworkTransport(Call.Factory{r->CallImpl(r){c,cb->try{val bytes=Buffer().writeUtf8("synthetic bytes");val source=object:ForwardingSource(bytes){override fun read(sink:Buffer,byteCount:Long):Long{entered.countDown();assertTrue(release.await(5,TimeUnit.SECONDS));if(c.cancelled.get())throw IOException("cancelled");return super.read(sink,byteCount)};override fun close(){closed.set(true);super.close()}}.buffer();val body=object:ResponseBody(){override fun contentType()="application/zip".toMediaType();override fun contentLength()=-1L;override fun source()=source};cb.onResponse(c,response(r,200,body))}finally{ended.countDown()}}})
            val job=launch(Dispatchers.Default){val context=currentCoroutineContext();transport.exchange(Request.Builder().url("https://dav.example.org/a.zip").build(),100,reply){context.ensureActive()}}
            assertTrue(withContext(Dispatchers.IO){entered.await(5,TimeUnit.SECONDS)});job.cancel();delay(50);assertFalse("Cancellation must still await callback drain",job.isCompleted);release.countDown();job.join();assertTrue(ended.await(5,TimeUnit.SECONDS));assertTrue(closed.get());val length=reply.file.length();reply.cleanup();assertFalse(reply.file.exists());delay(30);assertFalse(reply.file.exists());assertEquals(0L,length)
        }finally{root.deleteRecursively()}
    }
    @Test fun foreignReadbackReplacementIsNeverDeleted(){val root=Files.createTempDirectory("dav-owned-").toFile().canonicalFile;try{val files=DavFiles(File(root,"control"));val id=UUID.randomUUID().toString();val dir=files.create(id);val j=DavJournal.create(files,id,dir,JSONObject());val target=files.named(dir,"readback.zip");val reply=DavReplyFile(j,target);reply.open().close();assertTrue(target.renameTo(File(dir,"retained-original.zip")));target.writeText("unknown replacement");reply.cleanup();assertEquals("unknown replacement",target.readText());assertTrue(File(dir,"retained-original.zip").exists())}finally{root.deleteRecursively()}}
    @Test fun responseSizeLimitClosesBodyAndDoesNotAcceptPartial()=runBlocking{val transport=ZoteroDavNetworkTransport(Call.Factory{r->CallImpl(r){c,cb->cb.onResponse(c,response(r,200,ByteArray(1024).toResponseBody()))}});assertEquals("limit",rejects{transport.exchange(Request.Builder().url("https://dav.example.org/a").build(),16,check={})}.code)}
    @Test fun synchronousEnqueueFailureDoesNotHangDrain()=runBlocking{val transport=ZoteroDavNetworkTransport(Call.Factory{throw IllegalStateException("SYNTHETIC_RAW_SECRET")});withTimeout(2000){assertEquals("transport",rejects{transport.exchange(Request.Builder().url("https://dav.example.org/a").build(),100,check={})}.code)}}
}
