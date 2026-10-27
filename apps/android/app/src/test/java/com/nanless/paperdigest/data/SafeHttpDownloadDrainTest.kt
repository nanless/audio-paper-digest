package com.nanless.paperdigest.data

import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.*
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/** Actual shared download body and exact original baseline; no provider, keys, Android or user directories. */
class SafeHttpDownloadDrainTest {
    private class FakeCall(val req:Request,val script:(FakeCall,Callback)->Unit):Call {
        val cancelled=AtomicBoolean(false);var executed=false
        override fun request()=req
        override fun enqueue(responseCallback:Callback){executed=true;thread(name="synthetic-original-pdf-callback"){script(this,responseCallback)}}
        override fun execute():Response=error("not used")
        override fun cancel(){cancelled.set(true)}
        override fun isExecuted()=executed
        override fun isCanceled()=cancelled.get()
        override fun timeout()=Timeout.NONE
        override fun clone():Call=FakeCall(req,script)
    }
    private fun request(url:String="https://arxiv.org/pdf/2601.12345v1")=Request.Builder().url(url).build()
    private fun response(request:Request,code:Int,body:ResponseBody)=Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(code).message("synthetic").body(body).build()
    private suspend fun refuses(body:suspend()->Unit):Exception{try{body()}catch(e:Exception){return e};throw AssertionError("expected refusal")}
    @Test fun originalProviderDownloadCanReleaseMaintenanceBeforeCallbackCloses()=runBlocking{drainScenario(true)}
    @Test fun providerCancelKeepsMaintenanceUntilActualCallbackOutputAndTemporaryCleanupDrain()=runBlocking{drainScenario(false)}
    private suspend fun drainScenario(unsafe:Boolean)=coroutineScope {
        val root=Files.createTempDirectory("actual-safe-http-drain-").toFile().canonicalFile
        val entered=CountDownLatch(1);val release=CountDownLatch(1);val ended=CountDownLatch(1);val closed=AtomicBoolean(false);val maintenance=Mutex()
        try{
            val calls=Call.Factory{r->FakeCall(r){c,cb->try{
                val source=object:ForwardingSource(Buffer().writeUtf8("synthetic original PDF bytes")){
                    override fun read(sink:Buffer,byteCount:Long):Long{entered.countDown();assertTrue(release.await(5,TimeUnit.SECONDS));if(c.cancelled.get())throw IOException("cancelled");return super.read(sink,byteCount)}
                    override fun close(){closed.set(true);super.close()}
                }.buffer()
                val body=object:ResponseBody(){override fun contentType()=null;override fun contentLength()=-1L;override fun source()=source}
                cb.onResponse(c,response(r,200,body))
            }finally{ended.countDown()}}}
            val target=File(root,"original.pdf")
            val job=launch(Dispatchers.Default){maintenance.withLock{if(unsafe)UndrainedSafeHttpBaseline(calls).download(request(),target,1000) else SafeHttp(calls).download(request(),target,1000)}}
            assertTrue(withContext(Dispatchers.IO){entered.await(5,TimeUnit.SECONDS)});job.cancel()
            val restore=async(Dispatchers.Default){maintenance.withLock{root.listFiles()!!.map{it.name}}}
            if(unsafe){withTimeout(2000){job.join();restore.await()};assertFalse("The original method really released before body close",closed.get());assertTrue(root.listFiles()!!.any{it.name.startsWith(".download-")})}
            else{delay(40);assertFalse(job.isCompleted);assertFalse(restore.isCompleted);assertFalse(closed.get())}
            release.countDown();job.join();assertTrue(withContext(Dispatchers.IO){ended.await(5,TimeUnit.SECONDS)});restore.await();assertTrue(closed.get());assertFalse(target.exists());assertTrue(root.listFiles()!!.isEmpty());delay(20);assertTrue(root.listFiles()!!.isEmpty())
        }finally{release.countDown();root.deleteRecursively()}
    }
    @Test fun queuedCallbackCancellationAlsoWaitsForItsUniqueFailureTerminal()=runBlocking{
        val directory=Files.createTempDirectory("safe-http-queued-").toFile().canonicalFile;val entered=CountDownLatch(1);val release=CountDownLatch(1)
        try{val http=SafeHttp(Call.Factory{r->FakeCall(r){c,cb->entered.countDown();check(release.await(5,TimeUnit.SECONDS));cb.onFailure(c,IOException("synthetic cancel"))}});val work=launch(Dispatchers.Default){http.download(request(),File(directory,"original.pdf"),100)};assertTrue(withContext(Dispatchers.IO){entered.await(5,TimeUnit.SECONDS)});work.cancel();delay(40);assertFalse(work.isCompleted);release.countDown();work.join();assertTrue(directory.listFiles()!!.isEmpty())}finally{release.countDown();directory.deleteRecursively()}
    }
    @Test fun successfulPdfReadbackPreservesFullHashAndSize()=runBlocking{val root=Files.createTempDirectory("safe-http-success-").toFile().canonicalFile;try{val bytes="synthetic original PDF".toByteArray();val http=SafeHttp(Call.Factory{r->FakeCall(r){c,cb->cb.onResponse(c,response(r,200,bytes.toResponseBody()))}});val target=File(root,"original.pdf");val result=http.download(request(),target,100);assertArrayEquals(bytes,target.readBytes());assertEquals(bytes.size.toLong(),result.bytes);assertEquals(sha256(bytes),result.sha256);assertEquals(listOf(target),root.listFiles()!!.toList())}finally{root.deleteRecursively()}}
    @Test fun redirectReturnedToSameCallerWithoutReadingOrWritingBody()=runBlocking{val root=Files.createTempDirectory("safe-http-redirect-").toFile().canonicalFile;try{val read=AtomicBoolean(false);val http=SafeHttp(Call.Factory{r->FakeCall(r){c,cb->val source=object:ForwardingSource(Buffer().writeUtf8("must not read")){override fun read(sink:Buffer,byteCount:Long):Long{read.set(true);error("redirect body read")}}.buffer();val body=object:ResponseBody(){override fun contentType()=null;override fun contentLength()=-1L;override fun source()=source};cb.onResponse(c,response(r,302,body).newBuilder().header("Location","https://export.arxiv.org/pdf/2601.12345v1").build())}});val result=http.download(request(),File(root,"original.pdf"),100);assertEquals(302,result.code);assertEquals("https://export.arxiv.org/pdf/2601.12345v1",result.headers["Location"]);assertFalse(read.get());assertTrue(root.listFiles()!!.isEmpty())}finally{root.deleteRecursively()}}
    @Test fun sizeFailurePreservesExistingFileAndRemovesOnlyItsTemporary()=runBlocking{val root=Files.createTempDirectory("safe-http-limit-").toFile().canonicalFile;try{val target=File(root,"original.pdf").apply{writeText("saved original")};val http=SafeHttp(Call.Factory{r->FakeCall(r){c,cb->cb.onResponse(c,response(r,200,ByteArray(1000).toResponseBody()))}});refuses{http.download(request(),target,10)};assertEquals("saved original",target.readText());assertEquals(listOf(target),root.listFiles()!!.toList())}finally{root.deleteRecursively()}}
    @Test fun wrongSchemeAndEmbeddedCredentialsStillRejectBeforeCallCreation()=runBlocking{var calls=0;val http=SafeHttp(Call.Factory{calls++;error("must not create call")});val root=Files.createTempDirectory("safe-http-invalid-").toFile().canonicalFile;try{for(url in listOf("http://arxiv.org/a","https://u:p@arxiv.org/a"))refuses{http.download(request(url),File(root,"original.pdf"),100)};assertEquals(0,calls);assertTrue(root.listFiles()!!.isEmpty())}finally{root.deleteRecursively()}}
    @Test fun synchronousDownloadCallCreationFailureCannotHangDrain()=runBlocking{val root=Files.createTempDirectory("safe-http-create-").toFile().canonicalFile;try{val http=SafeHttp(Call.Factory{throw IOException("synthetic creation failure")});withTimeout(2000){refuses{http.download(request(),File(root,"original.pdf"),100)}};assertTrue(root.listFiles()!!.isEmpty())}finally{root.deleteRecursively()}}
}
