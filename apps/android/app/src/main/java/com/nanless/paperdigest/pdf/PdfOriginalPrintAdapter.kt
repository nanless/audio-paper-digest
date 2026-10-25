package com.nanless.paperdigest.pdf

import android.app.Activity
import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintDocumentInfo
import android.print.PrintManager
import android.print.PrintJob
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import com.tom_roush.pdfbox.io.MemoryUsageSetting
import com.tom_roush.pdfbox.pdmodel.PDDocument
import kotlinx.coroutines.*
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/** Every system request gets exactly one terminal callback; the original PDF is never rewritten. */
class PdfOriginalPrintAdapter(
    private val snapshot:PdfOriginalSnapshot,password:String="",private val owner:LifecycleOwner?=null
):PrintDocumentAdapter(),DefaultLifecycleObserver {
    private var documentPassword=password
    private val scope=CoroutineScope(SupervisorJob()+Dispatchers.Main.immediate)
    @Volatile private var finished=false
    init {require(owner?.lifecycle?.currentState!=androidx.lifecycle.Lifecycle.State.DESTROYED){"打印所属窗口已关闭"};snapshot.pin();owner?.lifecycle?.addObserver(this)}
    private fun current(){check(!finished){"原文打印窗口已关闭"};snapshot.requireActiveOwner()}
    override fun onLayout(oldAttributes:PrintAttributes?,newAttributes:PrintAttributes,cancellationSignal:CancellationSignal,callback:LayoutResultCallback,extras:Bundle?) {
        requestLayout(oldAttributes,newAttributes,cancellationSignal){when(it){is PdfLayoutOutcome.Ready->callback.onLayoutFinished(it.info,it.changed);is PdfLayoutOutcome.Failed->callback.onLayoutFailed(it.message);PdfLayoutOutcome.Cancelled->callback.onLayoutCancelled()}}
    }
    internal fun requestLayout(oldAttributes:PrintAttributes?,newAttributes:PrintAttributes,cancellationSignal:CancellationSignal,complete:(PdfLayoutOutcome)->Unit) {
        if(finished){complete(PdfLayoutOutcome.Cancelled);return}
        val terminal=AtomicBoolean();fun deliver(block:()->Unit){if(terminal.compareAndSet(false,true))block()}
        val job=scope.launch {
            try {
                withContext(Dispatchers.IO){currentCoroutineContext().ensureActive();current();snapshot.validate();PDDocument.load(snapshot.file,documentPassword,MemoryUsageSetting.setupMixed(8L*1024*1024,512L*1024*1024)).use {pdf->require(pdf.numberOfPages==snapshot.document.pageCount&&pdf.currentAccessPermission.canPrint()){ "此原件不能按当前权限打印" }}}
                ensureActive();current();cancellationSignal.throwIfCanceled()
                deliver{complete(PdfLayoutOutcome.Ready(PrintDocumentInfo.Builder(snapshot.document.displayName.take(160).ifBlank{"论文原文.pdf"}).setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT).setPageCount(snapshot.document.pageCount).build(),oldAttributes!=newAttributes))}
            }catch(e:Exception){if(e is CancellationException||cancellationSignal.isCanceled||finished)deliver{complete(PdfLayoutOutcome.Cancelled)}else deliver{complete(PdfLayoutOutcome.Failed("无法读取此原始 PDF；请核对密码、原件权限或当前论文。"))}}
            finally{cancellationSignal.setOnCancelListener(null)}
        }
        cancellationSignal.setOnCancelListener{job.cancel()}
    }
    override fun onWrite(pages:Array<out PageRange>,destination:ParcelFileDescriptor,cancellationSignal:CancellationSignal,callback:WriteResultCallback) {
        requestWrite(pages,destination,cancellationSignal){when(it){is PdfWriteOutcome.Written->callback.onWriteFinished(it.ranges);is PdfWriteOutcome.Failed->callback.onWriteFailed(it.message);PdfWriteOutcome.Cancelled->callback.onWriteCancelled()}}
    }
    internal fun requestWrite(pages:Array<out PageRange>,destination:ParcelFileDescriptor,cancellationSignal:CancellationSignal,complete:(PdfWriteOutcome)->Unit) {
        if(finished){destination.close();complete(PdfWriteOutcome.Cancelled);return}
        val terminal=AtomicBoolean();fun deliver(block:()->Unit){if(terminal.compareAndSet(false,true))block()}
        val job=scope.launch {
            var written:PdfWrittenPages?=null
            try {
                written=withContext(Dispatchers.IO){
                    val context=currentCoroutineContext();val check={context.ensureActive();cancellationSignal.throwIfCanceled();current()}
                    check();snapshot.validate()
                    PdfOriginalWriter.write(snapshot,pages.map{PdfOutputRange(it.start,it.end)},snapshot.file.parentFile!!,documentPassword,check).also{written=it}
                }
                val result=requireNotNull(written)
                withContext(Dispatchers.IO){
                    val context=currentCoroutineContext();val check={context.ensureActive();cancellationSignal.throwIfCanceled();current()}
                    ParcelFileDescriptor.AutoCloseOutputStream(destination).use{out->result.file.inputStream().use{input->PdfOriginalSnapshot.copy(input,{b,n->out.write(b,0,n)},check)};out.flush()}
                }
                ensureActive();current();cancellationSignal.throwIfCanceled()
                deliver{complete(PdfWriteOutcome.Written(result.originalRanges.map{PageRange(it.first,it.last)}.toTypedArray()))}
            }catch(e:Exception){if(e is CancellationException||cancellationSignal.isCanceled||finished)deliver{complete(PdfWriteOutcome.Cancelled)}else deliver{complete(PdfWriteOutcome.Failed("原文打印写入失败；原文件已保留，未报告打印成功。"))}}
            finally{written?.file?.delete();runCatching{destination.close()};cancellationSignal.setOnCancelListener(null)}
        }
        cancellationSignal.setOnCancelListener{job.cancel()}
    }
    override fun onDestroy(owner:LifecycleOwner){onFinish()}
    override fun onFinish(){if(finished)return;finished=true;documentPassword="";scope.cancel();owner?.lifecycle?.removeObserver(this);snapshot.discard()}
    companion object {
        /** Same real handoff path for system submission and deterministic service-failure tests. */
        internal fun submitToSystem(snapshot:PdfOriginalSnapshot,password:String="",owner:LifecycleOwner?=null,submit:(PrintDocumentAdapter)->PrintJob?) {
            val adapter=PdfOriginalPrintAdapter(snapshot,password,owner)
            try {checkNotNull(submit(adapter)){"系统未能打开打印预览；原文件已保留，请稍后重试。"}}
            catch(error:Throwable){adapter.onFinish();throw error}
        }
        suspend fun openPreview(activity:Activity,snapshot:PdfOriginalSnapshot,password:String=""):String {
            snapshot.validate()
            return withContext(Dispatchers.Main.immediate){
                require(!activity.isFinishing&&!activity.isDestroyed){"当前窗口已关闭，未打印旧原件"};snapshot.requireActiveOwner()
                submitToSystem(snapshot,password,activity as? LifecycleOwner){adapter->
                    val manager=activity.getSystemService(Activity.PRINT_SERVICE) as? PrintManager ?: error("此设备未提供系统打印服务")
                    manager.print(snapshot.document.displayName.take(160).ifBlank{"论文原文.pdf"},adapter,null)
                }
                "已打开系统打印预览；尚未确认打印完成。"
            }
        }
    }
}

internal sealed interface PdfLayoutOutcome {
 data class Ready(val info:PrintDocumentInfo,val changed:Boolean):PdfLayoutOutcome
 data class Failed(val message:String):PdfLayoutOutcome
 data object Cancelled:PdfLayoutOutcome
}
internal sealed interface PdfWriteOutcome {
 data class Written(val ranges:Array<PageRange>):PdfWriteOutcome
 data class Failed(val message:String):PdfWriteOutcome
 data object Cancelled:PdfWriteOutcome
}
