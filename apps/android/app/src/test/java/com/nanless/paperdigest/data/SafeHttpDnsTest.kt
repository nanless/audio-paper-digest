package com.nanless.paperdigest.data

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.Dispatcher
import okhttp3.Dns
import okhttp3.Request
import okhttp3.OkHttpClient
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Response
import org.junit.Assert.*
import org.junit.Test
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.Executors
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class SafeHttpDnsTest {
    private fun ip(vararg bytes: Int) = InetAddress.getByAddress(bytes.map { it.toByte() }.toByteArray())
    private fun answers(vararg values: InetAddress) = object : Dns { override fun lookup(hostname: String) = values.toList() }

    @Test fun vpnFakeIPsPrivateAndEmptyAnswersAreIoFailuresWithoutWeakeningTheAddressGuard() {
        val public = ip(1, 1, 1, 1)
        for (dns in listOf(answers(ip(198, 18, 0, 7)), answers(ip(198, 19, 255, 3)), answers(ip(10, 0, 0, 1)), answers(ip(127, 0, 0, 1)), answers(), answers(public, ip(192, 168, 1, 1)))) {
            assertThrows(UnknownHostException::class.java) { SafeHttp.PublicDns(false, dns).lookup("published.example.invalid") }
        }
        assertEquals(listOf(public), SafeHttp.PublicDns(false, answers(public)).lookup("published.example.invalid"))
    }
    @Test fun onlyTheDedicatedPublisherClientAcceptsSyntheticRoutesForItsFixedHost() {
        val fakeIp = ip(198, 18, 0, 15)
        val publisher = "nanless.github.io"
        assertThrows(UnknownHostException::class.java) {
            SafeHttp.PublicDns(false, answers(fakeIp)).lookup(publisher)
        }
        val dns = SafeHttp.PublicDns(false, answers(fakeIp), publisherOnly = true)
        assertEquals(listOf(fakeIp), dns.lookup(publisher))
        assertThrows(UnknownHostException::class.java) { dns.lookup("example.invalid") }
        val mixed = SafeHttp.PublicDns(false, answers(fakeIp, ip(192, 168, 1, 1)), publisherOnly = true)
        assertThrows(UnknownHostException::class.java) { mixed.lookup(publisher) }
    }
    @Test fun onlyExplicitLocalModelHostKeepsItsExistingLoopbackAllowance() {
        val loopback = ip(127, 0, 0, 1); val dns = answers(loopback)
        assertEquals(listOf(loopback), SafeHttp.PublicDns(true, dns).lookup("localhost"))
        assertThrows(UnknownHostException::class.java) { SafeHttp.PublicDns(true, dns).lookup("published.example.invalid") }
        assertThrows(UnknownHostException::class.java) { SafeHttp.PublicDns(false, dns).lookup("localhost") }
    }
    @Test fun brokenSystemOrVpnResolverCannotLeakAnUncheckedException() {
        val broken = object : Dns { override fun lookup(hostname: String): List<InetAddress> = throw IllegalStateException("synthetic resolver error") }
        val error = assertThrows(UnknownHostException::class.java) { SafeHttp.PublicDns(false, broken).lookup("example.invalid") }
        assertTrue(error.cause is IllegalStateException)
    }
    @Test fun actualAsyncTransportReportsVpnDnsFailureWithoutAnUncaughtDispatcherException() = runBlocking {
        val uncaught = AtomicReference<Throwable?>(null)
        val threads = Executors.newSingleThreadExecutor { body -> Thread(body, "paperdigest-dns-regression").apply { uncaughtExceptionHandler = Thread.UncaughtExceptionHandler { _, error -> uncaught.set(error) } } }
        try {
            val http = SafeHttp(answers(ip(198, 18, 0, 7)), Dispatcher(threads))
            val result = withTimeout(5_000) { runCatching { http.execute(Request.Builder().url("https://published.example.invalid/guide").build(), 1024) } }
            val error = result.exceptionOrNull(); assertTrue(error is AppFailure); assertEquals("dns", (error as AppFailure).category); assertTrue(error.message!!.contains("VPN"))
            threads.shutdown(); assertTrue(threads.awaitTermination(5, TimeUnit.SECONDS))
            assertNull("DNS rejection must not escape OkHttp's asynchronous worker", uncaught.get())
        } finally { threads.shutdownNow() }
    }
    @Test fun originalUncheckedDnsGuardReallyEscapesTheOkHttpWorker() {
        // Exact old rejection shape, on an isolated executor whose handler captures the fatal path.
        // No real DNS lookup, socket, global handler or application process is involved.
        val uncaught = AtomicReference<Throwable?>(null); val escaped = CountDownLatch(1); val callback = CountDownLatch(1)
        val threads = Executors.newSingleThreadExecutor { body -> Thread(body, "paperdigest-original-dns-baseline").apply { uncaughtExceptionHandler = Thread.UncaughtExceptionHandler { _, error -> uncaught.set(error); escaped.countDown() } } }
        try {
            val oldDns = object : Dns { override fun lookup(hostname: String): List<InetAddress> {
                val addresses = listOf(ip(198, 18, 0, 7))
                require(addresses.isNotEmpty() && addresses.all(SafeHttp::isPublic)) { "服务解析到私网或保留地址，已停止连接" }
                return addresses
            } }
            val client = OkHttpClient.Builder().proxy(java.net.Proxy.NO_PROXY).dispatcher(Dispatcher(threads)).dns(oldDns).retryOnConnectionFailure(false).build()
            client.newCall(Request.Builder().url("https://published.example.invalid/guide").build()).enqueue(object : Callback {
                override fun onFailure(call: Call, e: java.io.IOException) { callback.countDown() }
                override fun onResponse(call: Call, response: Response) { response.close(); throw AssertionError("DNS guard must prevent sockets") }
            })
            assertTrue(callback.await(5, TimeUnit.SECONDS)); assertTrue(escaped.await(5, TimeUnit.SECONDS)); assertTrue(uncaught.get() is IllegalArgumentException)
        } finally { threads.shutdownNow() }
    }
}
