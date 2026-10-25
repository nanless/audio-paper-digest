package com.nanless.paperdigest.ui

import android.content.Context
import android.print.PrintDocumentAdapter
import android.print.PrintAttributes
import android.print.PageRange
import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.print.PrintManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import com.nanless.paperdigest.data.ExportService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.ByteArrayInputStream
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** System printing receives the same static, offline document as HTML export. */
internal suspend fun printPaper(context:Context,title:String,body:String)=withContext(Dispatchers.Main) {
 suspendCancellableCoroutine<Unit> { continuation ->
  val web=WebView(context)
  var delivered=false
  web.settings.apply{javaScriptEnabled=false;allowFileAccess=false;allowContentAccess=false;blockNetworkLoads=true}
  continuation.invokeOnCancellation{android.os.Handler(android.os.Looper.getMainLooper()).post{if(!delivered)web.destroy()}}
  web.webViewClient=object:WebViewClient(){
   override fun shouldInterceptRequest(view:WebView?,request:WebResourceRequest?):WebResourceResponse?=if(request?.url?.scheme=="data")null else WebResourceResponse("text/plain","utf-8",ByteArrayInputStream(byteArrayOf()))
   override fun onPageFinished(view:WebView?,url:String?){
    if(delivered||!continuation.isActive)return
    try{
     val manager=context.getSystemService(Context.PRINT_SERVICE) as PrintManager
     val delegate=web.createPrintDocumentAdapter(title)
     val adapter=object:PrintDocumentAdapter(){
      override fun onStart(){delegate.onStart()}
      override fun onLayout(oldAttributes:PrintAttributes?,newAttributes:PrintAttributes,cancellationSignal:CancellationSignal,callback:LayoutResultCallback,extras:Bundle?){delegate.onLayout(oldAttributes,newAttributes,cancellationSignal,callback,extras)}
      override fun onWrite(pages:Array<out PageRange>,destination:ParcelFileDescriptor,cancellationSignal:CancellationSignal,callback:WriteResultCallback){delegate.onWrite(pages,destination,cancellationSignal,callback)}
      override fun onFinish(){try{delegate.onFinish()}finally{web.destroy()}}
     }
     manager.print(title,adapter,null)
     delivered=true
     continuation.resume(Unit)
    }catch(e:Exception){delivered=true;web.destroy();continuation.resumeWithException(IllegalArgumentException("无法打开系统打印，请先导出 HTML 后打印"))}
   }
  }
  web.loadDataWithBaseURL("https://reader.invalid/",ExportService.htmlDocument(title,body),"text/html","UTF-8",null)
 }
}
