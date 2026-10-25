package com.nanless.paperdigest.ui

import android.graphics.BitmapFactory
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.nanless.paperdigest.BuildConfig
import com.nanless.paperdigest.R
import java.io.ByteArrayInputStream

@Composable internal fun AboutContent(openLicenses: () -> Unit) {
    val resources = LocalContext.current.resources
    val icon = remember(resources) { BitmapFactory.decodeResource(resources, R.drawable.pd_icon, BitmapFactory.Options().apply { inSampleSize = 4; inScaled = false }) }
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        icon?.let { Image(it.asImageBitmap(), null, Modifier.size(76.dp).clip(RoundedCornerShape(18.dp))) }
        Text("论文速递", style = MaterialTheme.typography.headlineMedium)
        Text("把每天的新论文，读成自己的理解。", style = MaterialTheme.typography.titleMedium)
        Text("版本 ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        HorizontalDivider()
        Text("阅读网站已发布的图文导读，保存原文与笔记，再沿着自己的问题继续研究。", style = MaterialTheme.typography.bodyLarge)
        FilledTonalButton(openLicenses) { Text("开源许可") }
        Text("完整许可、版权声明和相关来源随应用离线保存，按条目打开即可查看。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable internal fun OfflineLicensesDialog(close: () -> Unit) {
    var web by remember { mutableStateOf<WebView?>(null) }
    var canGoBack by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf(false) }
    val background = MaterialTheme.colorScheme.surface.toArgb()
    val textZoom = (100 * LocalDensity.current.fontScale).toInt().coerceIn(50, 300)
    Dialog(close, DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        BackHandler { val current = web; if (current?.canGoBack() == true) current.goBack() else close() }
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    if (canGoBack) TextButton({ web?.goBack() }) { Text("返回") }
                    Text("开源许可", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                    TextButton(close) { Text("关闭") }
                }
                HorizontalDivider()
                if (error) Row(Modifier.padding(12.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    Text("这份离线许可暂时无法打开。", Modifier.weight(1f), color = MaterialTheme.colorScheme.error)
                    TextButton({ error = false; web?.loadUrl(OfflineLicenseRoute.INDEX) }) { Text("返回目录") }
                }
                AndroidView(modifier = Modifier.weight(1f).fillMaxWidth(), factory = { context ->
                    WebView(context).apply {
                        web = this
                        setBackgroundColor(background)
                        settings.apply { javaScriptEnabled = false; allowFileAccess = false; allowContentAccess = false; blockNetworkLoads = true; domStorageEnabled = false; builtInZoomControls = true; displayZoomControls = false; this.textZoom = textZoom }
                        webViewClient = object : WebViewClient() {
                            private fun denied(code: Int) = WebResourceResponse("text/plain", "utf-8", code, if (code == 404) "Not Found" else "Forbidden", emptyMap(), ByteArrayInputStream(byteArrayOf()))
                            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = request == null || OfflineLicenseRoute.assetPath(request.url.toString(), request.method) == null
                            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse {
                                val path = request?.let { OfflineLicenseRoute.assetPath(it.url.toString(), it.method) } ?: return denied(403)
                                val stream = runCatching { context.assets.open(path) }.getOrNull() ?: return denied(404)
                                val type = if (path.endsWith(".html")) "text/html" else "text/plain"
                                return WebResourceResponse(type, "utf-8", 200, "OK", mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff", "Content-Security-Policy" to "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'"), stream)
                            }
                            override fun onPageFinished(view: WebView?, url: String?) { if (web === view) canGoBack = view?.canGoBack() == true }
                            override fun onReceivedHttpError(view: WebView?, request: WebResourceRequest?, response: WebResourceResponse?) { if (web === view && request?.isForMainFrame == true) error = true }
                            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, failure: android.webkit.WebResourceError?) { if (web === view && request?.isForMainFrame == true) error = true }
                        }
                        loadUrl(OfflineLicenseRoute.INDEX)
                    }
                }, update = { view -> view.setBackgroundColor(background); view.settings.textZoom = textZoom }, onRelease = { view ->
                    if (web === view) web = null
                    view.stopLoading(); view.webViewClient = WebViewClient(); view.destroy()
                })
            }
        }
    }
}
