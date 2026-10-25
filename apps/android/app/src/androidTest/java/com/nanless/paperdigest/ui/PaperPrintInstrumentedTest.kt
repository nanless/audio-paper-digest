package com.nanless.paperdigest.ui

import android.content.Context
import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.webkit.WebView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.test.platform.app.InstrumentationRegistry
import com.nanless.paperdigest.data.HtmlDocumentSegments
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

/** Real private WebView load + exact production submit path; no PrintJob forged/submitted. */
class PaperPrintInstrumentedTest {
    private class Owner : LifecycleOwner { val registry=LifecycleRegistry(this);override val lifecycle:Lifecycle get()=registry }
    private class Delegate : PrintDocumentAdapter() {
        var finished=0
        override fun onLayout(oldAttributes:PrintAttributes?,newAttributes:PrintAttributes,cancellationSignal:CancellationSignal,callback:LayoutResultCallback,extras:Bundle?)=Unit
        override fun onWrite(pages:Array<out PageRange>,destination:ParcelFileDescriptor,cancellationSignal:CancellationSignal,callback:WriteResultCallback)=Unit
        override fun onFinish(){finished++}
    }
    private class HeldWeb(context:Context):WebView(context) { var loaded:String?=null;override fun loadUrl(url:String){loaded=url} }
    private val instrument get()=InstrumentationRegistry.getInstrumentation()
    private val context get()=instrument.targetContext
    private fun owner()=Owner().also{it.registry.handleLifecycleEvent(Lifecycle.Event.ON_CREATE)}
    private fun sourceBody()=context.assets.open("published/article.html").bufferedReader().use{it.readText()}
    @Test fun nullActualSubmitAfterRealPublicScientificPageLoadCannotReportOpenedAndCleansOnce()=runBlocking {
        val body=sourceBody();val document=HtmlDocumentSegments.create("MiCLA 原图公式表",body,listOf("合成打印验收提示，不是业务存档")).asStreamedDocument()
        lateinit var operation:PaperPrintOperation;lateinit var lifecycle:Owner;val delegate=Delegate();var calls=0
        instrument.runOnMainSync{lifecycle=owner();operation=PaperPrintOperation(context,lifecycle,"MiCLA",document,{},submit={_,_->calls++;null},delegateFactory={_,_->delegate})}
        val failure=withTimeout(30000){withContext(Dispatchers.Main){runCatching{operation.awaitPreview()}.exceptionOrNull()}}
        assertTrue(failure is IllegalStateException);assertTrue(failure!!.message!!.contains("系统未能打开打印预览"));assertEquals(1,calls)
        instrument.runOnMainSync{assertEquals(1,operation.cleanupCount);assertEquals(1,delegate.finished);assertEquals(1,operation.delegateFinishCount);assertEquals(0,lifecycle.registry.observerCount);operation.finish();assertEquals(1,operation.cleanupCount)}
        assertEquals(body,document.bodyForInspection)
    }
    @Test fun actualThrowSubmitKeepsOriginalErrorNoNormalReturnAndCleansOnce()=runBlocking {
        val expected=IOException("synthetic system print failure");lateinit var operation:PaperPrintOperation;lateinit var lifecycle:Owner;val delegate=Delegate();var calls=0
        instrument.runOnMainSync{lifecycle=owner();operation=PaperPrintOperation(context,lifecycle,"title",HtmlDocumentSegments.create("title","<p>合成正文</p>").asStreamedDocument(),{},submit={_,_->calls++;throw expected},delegateFactory={_,_->delegate})}
        val failure=withTimeout(30000){withContext(Dispatchers.Main){runCatching{operation.awaitPreview()}.exceptionOrNull()}}
        assertSame(expected,failure);assertEquals(1,calls)
        instrument.runOnMainSync{assertEquals(1,operation.cleanupCount);assertEquals(1,delegate.finished);assertFalse(operation.observerRegistered);assertEquals(0,lifecycle.registry.observerCount)}
    }
    @Test fun callerCancelBeforeLoadAndActivityDestroyAreBothSingleCleanupAndZeroSubmit()=runBlocking {
        for(destroy in listOf(false,true)){
            lateinit var operation:PaperPrintOperation;lateinit var lifecycle:Owner;var calls=0
            instrument.runOnMainSync{lifecycle=owner();operation=PaperPrintOperation(context,lifecycle,"title",HtmlDocumentSegments.create("title","<p>合成正文</p>").asStreamedDocument(),{},submit={_,_->calls++;null},webFactory={HeldWeb(it)})}
            val job=async(Dispatchers.Main){operation.awaitPreview()}
            withContext(Dispatchers.Main){yield();if(destroy)lifecycle.registry.handleLifecycleEvent(Lifecycle.Event.ON_DESTROY)else job.cancel()}
            runCatching{job.await()}
            withTimeout(5000){while(withContext(Dispatchers.Main){operation.cleanupCount}!=1)delay(10)}
            withContext(Dispatchers.Main){assertEquals(1,operation.cleanupCount);assertEquals(0,lifecycle.registry.observerCount);operation.finish();assertEquals(1,operation.cleanupCount)}
            assertTrue(job.isCancelled);assertEquals(0,calls)
        }
    }
    @Test fun oldUrlWrongViewAndChangedSourceCannotSubmitLateDocument()=runBlocking {
        lateinit var operation:PaperPrintOperation;lateinit var lifecycle:Owner;var current=true;var calls=0
        instrument.runOnMainSync{lifecycle=owner();operation=PaperPrintOperation(context,lifecycle,"title",HtmlDocumentSegments.create("title","<p>合成正文</p>").asStreamedDocument(),{require(current){"阅读材料已变化"}},submit={_,_->calls++;null},webFactory={HeldWeb(it)})}
        supervisorScope {
            val job=async(Dispatchers.Main){operation.awaitPreview()}
            withContext(Dispatchers.Main){
                yield();operation.pageFinished(operation.webView,operation.document.url+"/old");val other=HeldWeb(context);operation.pageFinished(other,operation.document.url);other.destroy();assertEquals(0,calls);assertFalse(job.isCompleted)
                current=false;operation.pageFinished(operation.webView,operation.document.url)
            }
            val error=runCatching{job.await()}.exceptionOrNull();assertTrue(error is IllegalArgumentException);assertEquals("阅读材料已变化",error!!.message)
        }
        assertEquals(0,calls);withContext(Dispatchers.Main){assertEquals(1,operation.cleanupCount);assertEquals(0,lifecycle.registry.observerCount)}
    }
    @Test fun cancellationDuringDelegateCreationCannotReachTheSystemSubmitBoundary()=runBlocking {
        lateinit var operation:PaperPrintOperation;lateinit var lifecycle:Owner;lateinit var awaiting:Deferred<String>;var calls=0;val delegate=Delegate()
        instrument.runOnMainSync{lifecycle=owner();operation=PaperPrintOperation(context,lifecycle,"title",HtmlDocumentSegments.create("title","<p>合成正文</p>").asStreamedDocument(),{},submit={_,_->calls++;null},webFactory={HeldWeb(it)},delegateFactory={_,_->awaiting.cancel();delegate})}
        supervisorScope {
            awaiting=async(Dispatchers.Main){operation.awaitPreview()}
            withContext(Dispatchers.Main){yield();operation.pageFinished(operation.webView,operation.document.url)}
            runCatching{awaiting.await()}
        }
        withContext(Dispatchers.Main){yield();assertEquals(1,operation.cleanupCount);assertEquals(1,delegate.finished);assertEquals(0,lifecycle.registry.observerCount)}
        assertEquals("cancelled during actual delegate creation must stop before PrintManager submission",0,calls)
    }

    @Test fun ownedRendererLossBeforeHandoffFailsAndReleasesTheExactView()=runBlocking {
        lateinit var operation:PaperPrintOperation;lateinit var lifecycle:Owner;var calls=0
        instrument.runOnMainSync{lifecycle=owner();operation=PaperPrintOperation(context,lifecycle,"title",HtmlDocumentSegments.create("title","<p>合成正文</p>").asStreamedDocument(),{},submit={_,_->calls++;null},webFactory={HeldWeb(it)})}
        supervisorScope {
            val job=async(Dispatchers.Main){operation.awaitPreview()}
            withContext(Dispatchers.Main){yield();val gone=object:android.webkit.RenderProcessGoneDetail(){override fun didCrash()=true;override fun rendererPriorityAtExit()=0};assertTrue(operation.webView.webViewClient.onRenderProcessGone(operation.webView,gone))}
            val error=runCatching{job.await()}.exceptionOrNull();assertTrue(error is IllegalStateException);assertTrue(error!!.message!!.contains("显示进程已结束"))
        }
        withContext(Dispatchers.Main){assertEquals(0,calls);assertEquals(1,operation.cleanupCount);assertEquals(0,lifecycle.registry.observerCount)}
    }

}
