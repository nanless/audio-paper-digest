package com.nanless.paperdigest.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintJob
import android.print.PrintManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import com.nanless.paperdigest.data.HtmlDocumentSegments
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.ByteArrayInputStream
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Only reports that the system accepted opening a preview; never a saved/printed outcome. */
internal suspend fun printPaper(
    context: Context, title: String, body: String, notices: List<String> = emptyList(),
    requireCurrent: () -> Unit,
): String = withContext(Dispatchers.Main) {
    requireCurrent()
    val activity = requireNotNull(context.printActivity()) { "打印需要仍在使用的应用窗口" }
    val owner = requireNotNull(activity as? LifecycleOwner) { "打印窗口没有可追踪的生命周期" }
    require(!activity.isFinishing && !activity.isDestroyed) { "打印所属窗口已关闭" }
    val document = withContext(Dispatchers.Default) { HtmlDocumentSegments.create(title, body, notices).asStreamedDocument() }
    requireCurrent()
    PaperPrintOperation(activity, owner, title, document, requireCurrent).awaitPreview()
}

private fun Context.printActivity(): Activity? {
    var candidate: Context = this
    val visited = java.util.IdentityHashMap<Context, Boolean>()
    while (visited.put(candidate, true) == null) {
        if (candidate is Activity) return candidate
        candidate = (candidate as? ContextWrapper)?.baseContext ?: return null
    }
    return null
}

/** One owned WebView/delegate and exactly one cleanup, also for null/throw/cancel paths. */
internal class PaperPrintOperation(
    context: Context, private val owner: LifecycleOwner, private val title: String,
    internal val document: StreamedHtmlDocument, private val requireCurrent: () -> Unit,
    private val submit: (String, PrintDocumentAdapter) -> PrintJob? = { name, adapter ->
        val manager = requireNotNull(context.getSystemService(PrintManager::class.java)) { "系统打印服务不可用" }
        manager.print(name, adapter, null)
    },
    webFactory: (Context) -> WebView = { WebView(it) },
    private val delegateFactory: (WebView, String) -> PrintDocumentAdapter = { web, name -> web.createPrintDocumentAdapter(name) },
) : DefaultLifecycleObserver {
    internal val webView: WebView = webFactory(context)
    internal var cleanupCount: Int = 0; private set
    internal var delegateFinishCount: Int = 0; private set
    internal var observerRegistered: Boolean = false; private set
    private var continuation: CancellableContinuation<String>? = null
    private var delegate: PrintDocumentAdapter? = null
    private var adapter: PrintDocumentAdapter? = null
    @Volatile private var closed = false
    private var attempted = false
    private var handedOff = false
    private val main = Handler(Looper.getMainLooper())

    init {
        check(Looper.myLooper() == Looper.getMainLooper()) { "打印视图必须在主线程创建" }
        webView.settings.apply {
            javaScriptEnabled = false; allowFileAccess = false; allowContentAccess = false
            blockNetworkLoads = true; domStorageEnabled = false
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse {
                if (!closed && view === webView && request != null &&
                    document.canServe(request.url.toString(), request.isForMainFrame, request.method)) {
                    return WebResourceResponse("text/html", "utf-8", 200, "OK", mapOf("Cache-Control" to "no-store"), document.openStream())
                }
                return WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(byteArrayOf()))
            }
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean =
                closed || view !== webView || request == null || !request.isForMainFrame ||
                    request.method != "GET" || !document.mayNavigateWithin(request.url.toString())
            override fun onPageFinished(view: WebView?, url: String?) { pageFinished(view, url) }
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                if (view !== webView) return false
                fail(IllegalStateException("打印文档显示进程已结束；原导读与原图保留，请重新打开预览"))
                return true
            }
            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                if (view === webView && request?.isForMainFrame == true && request.url.toString() == document.url) {
                    fail(IllegalStateException("打印文档载入失败；原导读与原图保留"))
                }
            }
        }
    }

    internal suspend fun awaitPreview(): String = suspendCancellableCoroutine { pending ->
        check(continuation == null) { "此打印准备不能重复启动" }
        continuation = pending
        pending.invokeOnCancellation { main.post { finish() } }
        try {
            current()
            owner.lifecycle.addObserver(this); observerRegistered = true
            current()
            webView.loadUrl(document.url)
        } catch (failure: Exception) { fail(failure) }
    }

    private fun current() {
        check(!closed && owner.lifecycle.currentState != Lifecycle.State.DESTROYED) { "打印所属窗口已关闭" }
        if (!handedOff && continuation?.isActive == false) throw kotlinx.coroutines.CancellationException("已取消打开打印预览；未提交新的打印请求")
        requireCurrent()
    }
    internal fun pageFinished(view: WebView?, url: String?) {
        if (closed || attempted || view !== webView || url != document.url || continuation?.isActive != true) return
        attempted = true
        try {
            current()
            val original = delegateFactory(webView, title); delegate = original
            val forwarding = object : PrintDocumentAdapter() {
                override fun onStart() { if (!closed) original.onStart() }
                override fun onLayout(oldAttributes: PrintAttributes?, newAttributes: PrintAttributes, cancellationSignal: CancellationSignal, callback: LayoutResultCallback, extras: Bundle?) {
                    try { current() } catch (failure: Exception) { callback.onLayoutFailed(failure.message); finish(); return }
                    original.onLayout(oldAttributes, newAttributes, cancellationSignal, callback, extras)
                }
                override fun onWrite(pages: Array<out PageRange>, destination: ParcelFileDescriptor, cancellationSignal: CancellationSignal, callback: WriteResultCallback) {
                    try { current() } catch (failure: Exception) { callback.onWriteFailed(failure.message); finish(); return }
                    original.onWrite(pages, destination, cancellationSignal, callback)
                }
                override fun onFinish() { finish() }
            }
            adapter = forwarding
            // The actual public PrintManager call and test null/throw boundaries
            // share this exact path; a null PrintJob is never an opened preview.
            current()
            checkNotNull(submit(title, forwarding)) { "系统未能打开打印预览；本次没有打印或保存文件" }
            current()
            handedOff = true
            continuation?.takeIf { it.isActive }?.resume("已打开系统打印预览；是否打印或保存由系统窗口决定")
        } catch (failure: Exception) { fail(failure) }
    }
    private fun fail(failure: Exception) {
        val pending = continuation
        cleanup(cancelPending = false)?.let { failure.addSuppressed(it) }
        if (pending?.isActive == true) pending.resumeWithException(failure)
    }
    internal fun finish() { cleanup(cancelPending = true) }
    private fun cleanup(cancelPending: Boolean): Exception? {
        if (Looper.myLooper() != Looper.getMainLooper()) { main.post { cleanup(cancelPending) }; return null }
        if (closed) return null
        closed = true; cleanupCount++
        if (observerRegistered) { owner.lifecycle.removeObserver(this); observerRegistered = false }
        var failure: Exception? = null
        fun clean(block: () -> Unit) { try { block() } catch (error: Exception) { if (failure == null) failure = error else failure?.addSuppressed(error) } }
        clean { delegate?.let { delegate = null; delegateFinishCount++; it.onFinish() } }
        adapter = null
        clean { webView.stopLoading() }; clean { webView.webViewClient = WebViewClient() }
        clean { webView.removeAllViews() }; clean { webView.destroy() }
        if (cancelPending && !handedOff) continuation?.takeIf { it.isActive }?.cancel(kotlinx.coroutines.CancellationException("已取消打开打印预览；未打印或保存文件"))
        return failure
    }
    override fun onDestroy(owner: LifecycleOwner) { finish() }
}
