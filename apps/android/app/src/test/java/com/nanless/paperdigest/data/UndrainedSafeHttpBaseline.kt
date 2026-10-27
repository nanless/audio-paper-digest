package com.nanless.paperdigest.data

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.io.File
import java.io.FileOutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URI
import java.util.concurrent.TimeUnit
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException


/** Redirects are evaluated by the caller; credentials never follow them automatically. */
internal class UndrainedSafeHttpBaseline(private val downloadCalls:Call.Factory, private val proxy:String?=null,private val localModel:Boolean=false,timeoutMs:Long=180000) {
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        .connectTimeout(30, TimeUnit.SECONDS).callTimeout(timeoutMs.coerceIn(1000, 600000), TimeUnit.MILLISECONDS)
        .readTimeout(timeoutMs.coerceIn(1000, 600000), TimeUnit.MILLISECONDS)
        .dns(object: Dns { override fun lookup(hostname: String): List<InetAddress> {
            val addresses = Dns.SYSTEM.lookup(hostname)
            if (!(localModel && hostname.lowercase() in setOf("localhost", "127.0.0.1", "::1"))) {
                require(addresses.isNotEmpty() && addresses.all(::isPublic)) { "服务解析到私网或保留地址，已停止连接" }
            }
            return addresses
        } }).apply {
            if (!proxy.isNullOrBlank()) {
                val uri = URI(proxy)
                require(uri.scheme == "http" && uri.host != null && uri.userInfo == null && uri.port in 1..65535 && uri.rawQuery == null && uri.fragment == null && uri.path in listOf("", "/")) { "代理须为不含密码的 HTTP CONNECT 地址" }
                proxy(Proxy(Proxy.Type.HTTP, InetSocketAddress(uri.host, uri.port)))
            } else proxy(Proxy.NO_PROXY)
        }.build()

    suspend fun execute(request: Request, limit: Int): HttpBytes = suspendCancellableCoroutine { continuation ->
        val uri = request.url
        require(uri.scheme == "https" || (localModel && uri.scheme == "http" && uri.host in setOf("localhost", "127.0.0.1", "::1"))) { "服务必须使用 HTTPS" }
        require(uri.username.isEmpty() && uri.password.isEmpty()) { "地址中不能包含密码" }
        val call = client.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object: Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (continuation.isActive) continuation.resumeWithException(AppFailure("transport", "连接未完成；保留已有结果，请检查网络或代理。"))
            }
            override fun onResponse(call: Call, response: Response) {
                try {
                    response.use {
                        val body = response.body ?: throw AppFailure("transport", "服务未返回内容")
                        require(body.contentLength() <= limit) { "服务响应超过大小限制" }
                        val output = java.io.ByteArrayOutputStream()
                        body.byteStream().use { stream ->
                            val buffer = ByteArray(32 * 1024)
                            while (continuation.isActive) {
                                val count = stream.read(buffer)
                                if (count < 0) break
                                require(output.size().toLong() + count <= limit) { "服务响应超过大小限制" }
                                output.write(buffer, 0, count)
                            }
                        }
                        if (continuation.isActive) continuation.resume(HttpBytes(response.code, response.headers.names().associateWith { response.header(it).orEmpty() }, output.toByteArray()))
                    }
                } catch (e: Exception) { if (continuation.isActive) continuation.resumeWithException(if (e is IllegalArgumentException || e is AppFailure) e else AppFailure("transport", "读取响应未完成，已保留已有资料")) }
            }
        })
    }

    /** Only model callers opt in. Cancellation returns after the writer callback has fully drained. */
    suspend fun execute(request: Request, limit: Int, capture: HttpResponseCapture): HttpBytes {
        val uri = request.url
        require(uri.scheme == "https" || (localModel && uri.scheme == "http" && uri.host in setOf("localhost", "127.0.0.1", "::1"))) { "服务必须使用 HTTPS" }
        require(uri.username.isEmpty() && uri.password.isEmpty() && limit > 0)
        val drained = CompletableDeferred<Unit>()
        fun terminal(status: String): Exception? = try { capture.finish(status); null } catch (e: Exception) { e }
        fun safe(error: Exception) = if (error is AppFailure) error else AppFailure("transport", "读取模型响应未完成；保留可保全的原始字节，未自动重试。")
        try {
            return suspendCancellableCoroutine { continuation ->
                try {
                    val call = client.newCall(request)
                    continuation.invokeOnCancellation { call.cancel() }
                    call.enqueue(object: Callback {
                        override fun onFailure(call: Call, e: IOException) {
                            try {
                                val failure = terminal(if (continuation.isActive) "failed" else "cancelled")
                                if (continuation.isActive) continuation.resumeWithException(failure ?: safe(e))
                            } finally { drained.complete(Unit) }
                        }
                        override fun onResponse(call: Call, response: Response) {
                            try {
                                val result = response.use {
                                    capture.responseStarted(response.code)
                                    val body = response.body ?: throw AppFailure("transport", "服务未返回内容")
                                    require(body.contentLength() <= limit) { "服务响应超过大小限制" }
                                    val output = java.io.ByteArrayOutputStream()
                                    var complete = false
                                    body.byteStream().use { stream ->
                                        val buffer = ByteArray(32 * 1024)
                                        while (continuation.isActive) {
                                            val count = stream.read(buffer)
                                            if (count < 0) { complete = true; break }
                                            val accepted = minOf(count, limit - output.size())
                                            if (accepted > 0) { capture.append(buffer, 0, accepted); output.write(buffer, 0, accepted) }
                                            require(accepted == count) { "服务响应超过大小限制" }
                                        }
                                    }
                                    if (complete) HttpBytes(response.code, response.headers.names().associateWith { response.header(it).orEmpty() }, output.toByteArray()) else null
                                }
                                val failure = terminal(if (result == null) "cancelled" else "body-complete")
                                if (continuation.isActive) {
                                    if (failure != null) continuation.resumeWithException(failure)
                                    else if (result != null) continuation.resume(result)
                                    else continuation.resumeWithException(AppFailure("transport", "响应读取尚未完整结束"))
                                }
                            } catch (e: Exception) {
                                val failure = terminal(if (continuation.isActive) "failed" else "cancelled")
                                if (continuation.isActive) continuation.resumeWithException(failure ?: safe(e))
                            } finally { drained.complete(Unit) }
                        }
                    })
                } catch (e: Exception) {
                    try {
                        val failure = terminal(if (continuation.isActive) "failed" else "cancelled")
                        if (continuation.isActive) continuation.resumeWithException(failure ?: safe(e))
                    } finally { drained.complete(Unit) }
                }
            }
        } finally {
            // call.cancel() alone only requests cancellation. Do not let a
            // backup observe a directory that an HTTP callback can still edit.
            withContext(NonCancellable) { drained.await() }
        }
    }

    suspend fun download(request: Request, target: File, limit: Long): HttpFile = suspendCancellableCoroutine { continuation ->
        val url = request.url
        require(url.scheme == "https" || (localModel && url.scheme == "http" && url.host in setOf("localhost", "127.0.0.1", "::1")))
        require(url.username.isEmpty() && url.password.isEmpty() && limit > 0)
        target.parentFile!!.mkdirs()
        val temporary = File(target.parentFile, ".download-${UUID.randomUUID()}")
        val call = downloadCalls.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object: Callback {
            override fun onFailure(call: Call, e: IOException) {
                temporary.delete()
                if (continuation.isActive) continuation.resumeWithException(AppFailure("transport", "下载未完成，已保留原文件"))
            }
            override fun onResponse(call: Call, response: Response) {
                try {
                    response.use {
                        val headers = response.headers.names().associateWith { response.header(it).orEmpty() }
                        if (response.code !in 200..299) {
                            if (continuation.isActive) continuation.resume(HttpFile(response.code, headers, 0, null))
                            return
                        }
                        val body = response.body ?: throw AppFailure("transport", "服务未返回文件")
                        require(body.contentLength() <= limit) { "下载文件超过大小限制" }
                        var count = 0L; val digest = MessageDigest.getInstance("SHA-256")
                        FileOutputStream(temporary).use { output -> body.byteStream().use { input ->
                            val buffer = ByteArray(64 * 1024)
                            while (continuation.isActive) {
                                val n = input.read(buffer); if (n < 0) break
                                count += n; require(count <= limit) { "下载文件超过大小限制" }
                                digest.update(buffer, 0, n); output.write(buffer, 0, n)
                            }
                            output.fd.sync()
                        } }
                        if (continuation.isActive) {
                            require(!Files.isSymbolicLink(target.toPath())) { "下载目标不能是链接" }
                            Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
                            continuation.resume(HttpFile(response.code, headers, count, digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }))
                        }
                    }
                } catch (e: Exception) { if (continuation.isActive) continuation.resumeWithException(if (e is IllegalArgumentException || e is AppFailure) e else AppFailure("transport", "下载未完成，原文件已保留")) }
                finally { temporary.delete() }
            }
        })
    }

    companion object {
        fun isPublic(address: InetAddress): Boolean {
            if (address.isAnyLocalAddress || address.isLoopbackAddress || address.isLinkLocalAddress || address.isSiteLocalAddress || address.isMulticastAddress) return false
            val b = address.address.map { it.toInt() and 255 }
            if (b.size == 4) {
                val a = b[0]; val c = b[1]; val d = b[2]
                return !(a == 0 || a == 10 || a == 127 || a >= 224 || (a == 100 && c in 64..127) || (a == 169 && c == 254) || (a == 172 && c in 16..31) || (a == 192 && (c == 168 || (c == 0 && d in listOf(0, 2)) || (c == 88 && d == 99))) || (a == 198 && (c in 18..19 || (c == 51 && d == 100))) || (a == 203 && c == 0 && d == 113))
            }
            return b.size == 16 && b[0] and 0xe0 == 0x20 && !(b[0] == 0x20 && b[1] == 1 && (b[2] < 2 || (b[2] == 0x0d && b[3] == 0xb8))) && !(b[0] == 0x20 && b[1] == 2) && !(b[0] == 0x3f && b[1] == 0xff && b[2] < 16)
        }
    }
}
