package com.nanless.paperdigest.zotero

import com.nanless.paperdigest.data.AppFailure
import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

class ZoteroDrainedTransportTest {
    private fun transport(calls:Call.Factory,files:ZoteroOwnedDownloadFiles=ZoteroOwnedDownloadTestFiles)=ZoteroDrainedTransport(calls,files)
    private class FakeCall(val req:Request,val script:(FakeCall,Callback)->Unit):Call {
        val cancelled=AtomicBoolean(false);var executed=false
        override fun request()=req
        override fun enqueue(responseCallback:Callback){executed=true;thread(name="synthetic-zotero-drain"){script(this,responseCallback)}}
        override fun execute():Response=error("not used")
        override fun cancel(){cancelled.set(true)}
        override fun isExecuted()=executed
        override fun isCanceled()=cancelled.get()
        override fun timeout()=Timeout.NONE
        override fun clone():Call=FakeCall(req,script)
    }
    private fun request(url:String="https://api.zotero.org/keys/current")=Request.Builder().url(url).build()
    private fun response(request:Request,code:Int,body:ResponseBody)=Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(code).message("synthetic").body(body).build()
    private suspend fun refuses(body:suspend()->Unit):Exception{try{body()}catch(e:Exception){return e};throw AssertionError("expected refusal")}
    @Test fun ordinaryApiCancellationWaitsForActualCallbackBodyClose()=runBlocking{checkDrain(false)}
    @Test fun storageReadbackCancellationWaitsForActualCallbackOutputClose()=runBlocking{checkDrain(true)}
    private suspend fun checkDrain(download:Boolean)=coroutineScope{
        val root=Files.createTempDirectory("zotero-drained-").toFile().canonicalFile
        val entered=CountDownLatch(1);val release=CountDownLatch(1);val ended=CountDownLatch(1);val closed=AtomicBoolean(false)
        try{
            val transport=transport(Call.Factory{r->FakeCall(r){c,cb->try{
                val source=object:ForwardingSource(Buffer().writeUtf8("synthetic bytes")){
                    override fun read(sink:Buffer,byteCount:Long):Long{entered.countDown();assertTrue(release.await(5,TimeUnit.SECONDS));if(c.cancelled.get())throw IOException("cancelled");return super.read(sink,byteCount)}
                    override fun close(){closed.set(true);super.close()}
                }.buffer()
                val body=object:ResponseBody(){override fun contentType()=null;override fun contentLength()=-1L;override fun source()=source}
                cb.onResponse(c,response(r,200,body))
            }finally{ended.countDown()}}})
            val target=File(root,"readback.bin")
            val job=launch(Dispatchers.Default){if(download)transport.download(request(),target,100)else transport.request(request(),100)}
            assertTrue(withContext(Dispatchers.IO){entered.await(5,TimeUnit.SECONDS)});job.cancel();delay(40);assertFalse(job.isCompleted);release.countDown();job.join();assertTrue(ended.await(5,TimeUnit.SECONDS));assertTrue(closed.get());assertFalse(target.exists());assertTrue(root.listFiles()!!.isEmpty())
        }finally{release.countDown();root.deleteRecursively()}
    }
    @Test fun invalidUrlRejectedBeforeNativeCallCreation()=runBlocking{var calls=0;val transport=transport(Call.Factory{calls++;error("must not create call")});for(url in listOf("http://api.zotero.org/a","https://u:p@api.zotero.org/a","https://api.zotero.org/a#fragment"))refuses{transport.request(request(url),100)};assertEquals(0,calls)}
    @Test fun enqueueFailureDrainsAndNeverLeaksVendorText()=runBlocking{val transport=transport(Call.Factory{throw IOException("SYNTHETIC-SECRET")});val error=withTimeout(2000){refuses{transport.request(request(),100)}};assertTrue(error is AppFailure);assertFalse(error.message.orEmpty().contains("SYNTHETIC-SECRET"))}
    @Test fun completeRequestReturnsFullBytesAndClosesBody()=runBlocking{val closed=AtomicBoolean(false);val transport=transport(Call.Factory{r->FakeCall(r){c,cb->val source=object:ForwardingSource(Buffer().writeUtf8("complete synthetic response")){override fun close(){closed.set(true);super.close()}}.buffer();val body=object:ResponseBody(){override fun contentType()=null;override fun contentLength()=-1L;override fun source()=source};cb.onResponse(c,response(r,200,body))}});val actual=transport.request(request(),100);assertEquals("complete synthetic response",actual.bytes.toString(Charsets.UTF_8));assertTrue(closed.get())}
    @Test fun sizeOverflowNeverReturnsPartialRequest()=runBlocking{val transport=transport(Call.Factory{r->FakeCall(r){c,cb->cb.onResponse(c,response(r,200,ByteArray(1000).toResponseBody()))}});refuses{transport.request(request(),10)};Unit}
    @Test fun successfulReadbackIsHashedAndFileClosedBeforeReturn()=runBlocking{val dir=Files.createTempDirectory("zotero-readback-").toFile().canonicalFile;try{val raw="complete synthetic file".toByteArray();val transport=transport(Call.Factory{r->FakeCall(r){c,cb->cb.onResponse(c,response(r,200,raw.toResponseBody()))}});val target=File(dir,"readback.bin");val actual=transport.download(request(),target,100);assertArrayEquals(raw,target.readBytes());assertEquals(com.nanless.paperdigest.data.sha256(raw),actual.sha256);assertEquals(raw.size.toLong(),actual.bytes);assertEquals(listOf(target),dir.listFiles()!!.toList())}finally{dir.deleteRecursively()}}
    @Test fun readbackErrorCannotReplaceExistingTarget()=runBlocking{val dir=Files.createTempDirectory("zotero-readback-error-").toFile().canonicalFile;try{val target=File(dir,"readback.bin").apply{writeText("original")};val transport=transport(Call.Factory{r->FakeCall(r){c,cb->cb.onResponse(c,response(r,404,"error".toResponseBody()))}});assertEquals(404,transport.download(request(),target,100).code);assertEquals("original",target.readText());assertEquals(1,dir.listFiles()!!.size)}finally{dir.deleteRecursively()}}

    @Test fun ownedReadbackReceiptSurvivesCancellationAfterFullFileBeforeCoroutineReturn()=runBlocking{
        val dir=Files.createTempDirectory("zotero-owned-cancel-").toFile().canonicalFile
        val closing=CountDownLatch(1);val release=CountDownLatch(1);var receipt:ZoteroOwnedFileReceipt?=null
        try{
            val raw="complete owned bytes".toByteArray();val target=File(dir,"owned.bin")
            val transport=transport(Call.Factory{r->FakeCall(r){c,cb->val body=object:ResponseBody(){val buffer=Buffer().write(raw);override fun contentType()=null;override fun contentLength()=raw.size.toLong();override fun source()=buffer;override fun close(){closing.countDown();assertTrue(release.await(5,TimeUnit.SECONDS));super.close()}};cb.onResponse(c,response(r,200,body))}})
            val job=launch(Dispatchers.Default){transport.downloadOwned(request(),target,100){owned->receipt=owned}}
            assertTrue(withContext(Dispatchers.IO){closing.await(5,TimeUnit.SECONDS)});assertArrayEquals(raw,target.readBytes());job.cancel();assertFalse(job.isCompleted);release.countDown();job.join()
            assertTrue(job.isCancelled);assertArrayEquals(raw,target.readBytes());requireNotNull(receipt).requireCurrent()
            assertTrue(target.delete());assertTrue(dir.listFiles()!!.isEmpty())
        }finally{release.countDown();dir.deleteRecursively()}
    }
    @Test fun ownedReadbackBodyFailureNeverPublishesOrLeaksTemporary()=runBlocking{
        val dir=Files.createTempDirectory("zotero-owned-failure-").toFile().canonicalFile
        try{var receipts=0
            val transport=transport(Call.Factory{r->FakeCall(r){c,cb->val source=object:ForwardingSource(Buffer().writeUtf8("partial")){override fun read(sink:Buffer,byteCount:Long):Long{throw IOException("controlled stream failure")}}.buffer();val body=object:ResponseBody(){override fun contentType()=null;override fun contentLength()=-1L;override fun source()=source};cb.onResponse(c,response(r,200,body))}})
            refuses{transport.downloadOwned(request(),File(dir,"owned.bin"),100){receipts++}};assertEquals(1,receipts);assertTrue(dir.listFiles()!!.isEmpty())
        }finally{dir.deleteRecursively()}
    }


    @Test fun ownedReadbackNeverReplacesExistingForeignFile()=runBlocking{
        val dir=Files.createTempDirectory("zotero-owned-existing-").toFile().canonicalFile
        try{val target=File(dir,"owned.bin").apply{writeText("foreign sentinel")};var receipts=0
            val transport=transport(Call.Factory{r->FakeCall(r){c,cb->cb.onResponse(c,response(r,200,"owned bytes".toResponseBody()))}})
            refuses{transport.downloadOwned(request(),target,100){receipts++}};assertEquals("foreign sentinel",target.readText());assertEquals(0,receipts);assertEquals(listOf(target),dir.listFiles()!!.toList())
        }finally{dir.deleteRecursively()}
    }
    @Test fun ownedReceiptThenForeignReplacementRejectsAndPreservesForeignBytes()=runBlocking{
        val dir=Files.createTempDirectory("zotero-owned-race-").toFile().canonicalFile
        try{val target=File(dir,"owned.bin");var receipts=0
            val transport=transport(Call.Factory{r->FakeCall(r){c,cb->cb.onResponse(c,response(r,200,"owned bytes".toResponseBody()))}})
            refuses{transport.downloadOwned(request(),target,100){receipts++;if(target.exists())assertTrue(target.delete());target.writeText("foreign after receipt")}};assertEquals(1,receipts);assertEquals("foreign after receipt",target.readText());assertEquals(listOf(target),dir.listFiles()!!.toList())
        }finally{dir.deleteRecursively()}
    }


    @Test fun descriptorReceiptCannotRegisterOrDeleteReplacementPathInode()=runBlocking{
        val dir=Files.createTempDirectory("zotero-owned-receipt-race-").toFile().canonicalFile
        try{val target=File(dir,"owned.bin");var replaced=false;var receipts=0
            val files=ZoteroOwnedDownloadFiles{file->val sink=ZoteroOwnedDownloadTestFiles.create(file);Files.move(file.toPath(),File(dir,"moved-owner").toPath());Files.write(file.toPath(),"foreign descriptor-gap sentinel".toByteArray(),java.nio.file.StandardOpenOption.CREATE_NEW);replaced=true;sink}
            val transport=transport(Call.Factory{r->FakeCall(r){c,cb->val source=object:ForwardingSource(Buffer().writeUtf8("partial")){override fun read(sink:Buffer,byteCount:Long):Long{throw IOException("controlled body failure after descriptor creation")}}.buffer();val body=object:ResponseBody(){override fun contentType()=null;override fun contentLength()=-1L;override fun source()=source};cb.onResponse(c,response(r,200,body))}},files)
            refuses{transport.downloadOwned(request(),target,100){receipts++}};assertTrue(replaced);assertEquals(1,receipts);assertTrue(target.exists());assertEquals("foreign descriptor-gap sentinel",target.readText());assertTrue(File(dir,"moved-owner").exists())
        }finally{dir.deleteRecursively()}
    }

}
