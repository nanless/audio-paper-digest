package com.nanless.paperdigest.platform

import com.nanless.paperdigest.data.AppFailure
import com.nanless.paperdigest.data.SafeHttp
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.Request
import org.bouncycastle.asn1.x500.X500Name
import org.bouncycastle.asn1.x509.Extension
import org.bouncycastle.asn1.x509.GeneralName
import org.bouncycastle.asn1.x509.GeneralNames
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder
import org.junit.Assert.*
import org.junit.Test
import java.math.BigInteger
import java.net.InetAddress
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.SecureRandom
import java.util.Date
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLException
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.SSLSocket
import kotlin.concurrent.thread

/** Fresh in-memory fixture keys; no persistent certificate, global trust override, Vault or external service. */
class PlatformTlsInstrumentedTest {
    @Test fun platformRejectsSelfSignedLoopbackBeforeSendingAnyHttpOrAuthorization() = runBlocking {
        val random = SecureRandom()
        val pair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048, random) }.generateKeyPair()
        val name = X500Name("CN=PaperDigest disposable QA TLS")
        val certificate = JcaX509CertificateConverter().getCertificate(
            JcaX509v3CertificateBuilder(name, BigInteger(128, random), Date(System.currentTimeMillis() - 60000),
                Date(System.currentTimeMillis() + 3600000), name, pair.public)
                .addExtension(Extension.subjectAlternativeName, false,
                    GeneralNames(GeneralName(GeneralName.iPAddress, "127.0.0.1")))
                .build(JcaContentSignerBuilder("SHA256withRSA").build(pair.private)))
        // Created directly on each actual Android platform, avoiding desktop PKCS12 encoding assumptions.
        val password = "disposable-test-key-only".toCharArray()
        val keyStore = KeyStore.getInstance("PKCS12").apply {
            load(null, null); setKeyEntry("fixture", pair.private, password, arrayOf(certificate))
        }
        val managers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(keyStore, password) }
        password.fill('\u0000')
        val serverContext = SSLContext.getInstance("TLS").apply { init(managers.keyManagers, null, random) }
        val listener = serverContext.serverSocketFactory.createServerSocket(0, 1, InetAddress.getByName("127.0.0.1")) as SSLServerSocket
        listener.enabledProtocols = arrayOf("TLSv1.2")
        listener.soTimeout = 12000
        val connected = CountDownLatch(1)
        val finished = CountDownLatch(1)
        val receivedHttpBytes = AtomicInteger()
        val handshakeFailure = AtomicReference<Throwable?>()
        val acceptedSocket = AtomicReference<SSLSocket?>()
        val server = thread(name = "PaperDigest-QA-TLS", isDaemon = true) {
            try {
                (listener.accept() as SSLSocket).use { socket ->
                    acceptedSocket.set(socket); socket.soTimeout = 10000; connected.countDown()
                    socket.startHandshake()
                    // Even one plaintext byte means TLS accepted an untrusted peer. Do not record header contents.
                    if (socket.inputStream.read() >= 0) receivedHttpBytes.incrementAndGet()
                }
            } catch (failure: Throwable) { handshakeFailure.set(failure) }
            finally { finished.countDown() }
        }
        try {
            val request = Request.Builder().url("https://127.0.0.1:${listener.localPort}/qa")
                .header("Authorization", "Bearer synthetic-qa-header-must-not-be-sent").build()
            val failure = runCatching { withTimeout(15000) { SafeHttp(localModel = true, timeoutMs = 10000).execute(request, 1024) } }.exceptionOrNull()
            assertTrue("The actual TLS server must be reached; a DNS/private-address rejection is insufficient", connected.await(2, TimeUnit.SECONDS))
            assertTrue("The server must finish its attempted TLS handshake", finished.await(12, TimeUnit.SECONDS))
            assertTrue("The production platform client must reject the certificate", failure is AppFailure)
            assertEquals("transport", (failure as AppFailure).category)
            assertTrue("An actual TLS failure must reach the server", handshakeFailure.get() is SSLException)
            assertEquals("No HTTP request or Authorization header may cross a rejected TLS connection", 0, receivedHttpBytes.get())
        } finally {
            acceptedSocket.get()?.close(); listener.close(); server.join(1000)
        }
    }
}
