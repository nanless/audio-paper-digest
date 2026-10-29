package com.nanless.paperdigest.zotero

import com.nanless.paperdigest.data.AppFailure
import com.nanless.paperdigest.data.HttpBytes
import com.nanless.paperdigest.data.HttpFile
import com.nanless.paperdigest.data.sha256
import com.nanless.paperdigest.secret.SecretStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import okhttp3.Request
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** Synthetic values and an in-process transport only; never uses a vault, socket or account. */
class ZoteroHeaderSafetyTest {
    @get:Rule val temporary = TemporaryFolder()

    private class SyntheticKeys : SecretStore {
        var value = "synthetic-valid-zotero-header"
        var failure: Exception? = null
        override fun load(scope: String): String {
            check(scope == "zotero.primary")
            failure?.let { throw it }
            return value
        }
        override fun save(scope: String, secret: String) { value = secret }
        override fun remove(scope: String) { value = "" }
    }

    private class NoNetworkTransport(private val keys: SyntheticKeys) : ZoteroTransport {
        var calls = 0
        override suspend fun request(request: Request, limit: Int): HttpBytes {
            calls++
            check(request.method == "GET" && request.url.encodedPath == "/keys/current")
            assertTrue("Synthetic credential must reach only the injected transport", request.header("Zotero-API-Key") == keys.value)
            val access = JSONObject().put("library", true).put("write", true).put("files", true).put("notes", true)
            val result = JSONObject().put("userID", 123).put("access", JSONObject().put("user", access))
            return HttpBytes(200, emptyMap(), result.toString().toByteArray())
        }
        override suspend fun download(request: Request, target: File, limit: Long): HttpFile {
            calls++
            error("Synthetic header test never transfers files")
        }
    }

    private data class Fixture(val root: File, val keys: SyntheticKeys, val transport: NoNetworkTransport, val service: ZoteroService)
    private suspend fun fixture(): Fixture {
        val root = temporary.newFolder().canonicalFile
        val research = File(root, "Research").also { it.mkdirs() }
        val material = File(root, "synthetic.json").also { it.writeText("{}") }
        val keys = SyntheticKeys()
        val transport = NoNetworkTransport(keys)
        val provider = ZoteroMaterialProvider {
            ZoteroMaterials("synthetic-header-paper", "a".repeat(64), JSONObject().put("itemType", "preprint").put("title", "Synthetic header safety only"),
                listOf(ZoteroMaterial("source-metadata", "Synthetic", "application/json", material, sha256 = sha256(material.readBytes()))))
        }
        val service = ZoteroService(research, keys, provider, transport)
        service.execute("save", JSONObject().put("libraryType", "users").put("libraryID", "123"))
        return Fixture(research, keys, transport, service)
    }

    private suspend fun failure(block: suspend () -> Unit): Exception {
        try { block() } catch (error: Exception) { return error }
        throw AssertionError("Expected a synthetic header failure")
    }
    private fun assertFixedFailure(error: Exception) {
        // Boolean assertions intentionally do not echo the offending value even on regression.
        assertFalse("Credential sentinel escaped via exception", error.toString().contains(SENTINEL))
        assertTrue("Header failure must use a safe application category", error is AppFailure)
        assertEquals("credentialsUnavailable", (error as AppFailure).category)
        assertEquals(SAFE_MESSAGE, error.message)
        assertNull("Original header exception must not survive as a cause", error.cause)
        assertTrue(error.suppressed.isEmpty())
    }
    private fun assertNoSentinel(f: Fixture) {
        assertFalse("Credential sentinel escaped via UI state", f.service.state().toString().contains(SENTINEL))
        f.root.walkTopDown().filter { it.isFile }.forEach {
            assertFalse("Credential sentinel escaped into synthetic research", it.readText().contains(SENTINEL))
        }
        assertEquals(0, f.transport.calls)
        assertFalse(f.service.state().getBoolean("busy"))
        assertEquals("unknown", f.service.state().getString("credentialState"))
    }

    @Test fun actualLibraryCustomHeaderErrorCanContainTheSyntheticValue() {
        val error = try {
            Request.Builder().url("https://api.zotero.org/keys/current").header("Zotero-API-Key", SENTINEL + "\ninvalid").build()
            throw AssertionError("Library accepted an invalid synthetic header")
        } catch (error: IllegalArgumentException) { error }
        assertTrue("This regression must exercise the actual leaking custom-header exception", error.message.orEmpty().contains(SENTINEL))
    }

    @Test fun malformedHeaderMatrixFailsSafelyBeforeAnyTransport() = runBlocking {
        listOf('\n', '\r', '\u0000', '\u007f', '\u0100').forEach { invalid ->
            val f = fixture()
            f.keys.value = SENTINEL + invalid + "invalid"
            assertFixedFailure(failure { f.service.execute("check") })
            assertNoSentinel(f)
        }
    }

    @Test fun archiveAndResumePersistOnlyTheFixedFailureAndPreserveOriginalMaterials() = runBlocking {
        val f = fixture()
        val id = f.service.execute("prepare").getString("preparedID")
        val directory = File(f.root, "ZoteroArchives/$id")
        val originals = directory.listFiles()!!.filter { it.name != "journal.json" }.associate { it.name to it.readBytes() }
        val originalJournal = JSONObject(File(directory, "journal.json").readText())
        f.keys.value = SENTINEL + "\r\ninvalid"
        listOf("archive", "resume").forEach { command ->
            assertFixedFailure(failure { f.service.execute(command, JSONObject().put("journalID", id)) })
            val journal = JSONObject(File(directory, "journal.json").readText())
            assertEquals(id, journal.getString("id"))
            assertEquals("failed", journal.getString("status"))
            assertEquals(SAFE_MESSAGE, journal.getString("error"))
            assertEquals(originalJournal.getString("planSHA"), journal.getString("planSHA"))
            assertEquals(originals.keys, directory.listFiles()!!.filter { it.name != "journal.json" }.map { it.name }.toSet())
            originals.forEach { (name, bytes) -> assertArrayEquals(bytes, File(directory, name).readBytes()) }
            assertNoSentinel(f)
        }
    }

    @Test fun validHeaderStillConfirmsAndCancellationIsNotReclassified() = runBlocking {
        val f = fixture()
        val cancelled = CancellationException("Synthetic credential load cancelled")
        f.keys.failure = cancelled
        // Coroutine stack-trace recovery may copy the exception; cancellation type is the contract.
        assertTrue(failure { f.service.execute("check") } is CancellationException)
        assertEquals(0, f.transport.calls)
        f.keys.failure = null
        assertEquals("confirmed", f.service.execute("check").getString("credentialState"))
        assertEquals(1, f.transport.calls)
        assertFalse(f.service.state().getBoolean("busy"))
        assertFalse(f.service.state().toString().contains(f.keys.value))
    }

    companion object {
        private const val SENTINEL = "SYNTHETIC-ZOTERO-HEADER-DO-NOT-ECHO"
        private const val SAFE_MESSAGE = "Zotero 请求头无效，请在设置中重新保存 API key"
    }
}
