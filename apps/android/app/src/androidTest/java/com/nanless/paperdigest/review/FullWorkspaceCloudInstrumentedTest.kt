package com.nanless.paperdigest.review

import android.content.ContextWrapper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nanless.paperdigest.RootController
import com.nanless.paperdigest.cloud.*
import com.nanless.paperdigest.data.OfflineStore
import com.nanless.paperdigest.data.PersonalStore
import com.nanless.paperdigest.model.StudyService
import com.nanless.paperdigest.secret.SecretStore
import com.nanless.paperdigest.ui.SecretKind
import kotlinx.coroutines.runBlocking
import okio.Buffer
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.Base64
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class FullWorkspaceCloudInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val fixture by lazy { JSONObject(instrumentation.context.assets.open("full-webdav-sync-v1.json").bufferedReader().use { it.readText() }) }
    private fun source(platform: String) = fixture.getJSONArray("sources").let { rows ->
        (0 until rows.length()).map { rows.getJSONObject(it) }.single { it.getString("platform") == platform }
    }
    private fun seed(directory: File, platform: String, controls: Boolean = true) {
        val rows = source(platform).getJSONArray("files")
        for (index in 0 until rows.length()) {
            val row = rows.getJSONObject(index)
            val path = row.getString("path")
            if (!controls && (!FullWorkspaceMerge.includes(path) || BackupCodec.isLocalOnlyIntegrityPath(path))) continue
            val bytes = Base64.getDecoder().decode(row.getString("data"))
            assertEquals(row.getString("sha256"), BackupCodec.hash(bytes))
            BackupCodec.checkedPath(path)
            File(directory, path).apply { parentFile!!.mkdirs(); writeBytes(bytes) }
        }
    }

    private class MemorySecrets : SecretStore {
        val values = mutableMapOf<String, String>()
        override fun save(scope: String, secret: String) { values[scope] = secret }
        override fun load(scope: String): String? = values[scope]
        override fun remove(scope: String) { values.remove(scope) }
    }
    private class FixtureDav : CloudTransport {
        val dirs = mutableSetOf("/dav/")
        val files = mutableMapOf<String, ByteArray>()
        var interrupt = false
        override suspend fun execute(request: okhttp3.Request, limit: Int): CloudHTTP {
            val path = request.url.encodedPath
            fun response(status: Int, body: ByteArray = byteArrayOf()) = CloudHTTP(status, emptyMap(), body)
            return when (request.method) {
                "MKCOL" -> response(if (dirs.add(path)) 201 else 405)
                "PROPFIND" -> {
                    if (path !in dirs) return response(404)
                    val members = if (request.header("Depth") == "0") listOf(path) else
                        (listOf(path) + (dirs + files.keys).filter { it != path && it.startsWith(path) && '/' !in it.removePrefix(path).removeSuffix("/") })
                    response(207, ("<d:multistatus xmlns:d=\"DAV:\">" + members.joinToString("") {
                        "<d:response><d:href>$it</d:href><d:propstat><d:prop><d:resourcetype>${if (it in dirs) "<d:collection/>" else ""}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
                    } + "</d:multistatus>").toByteArray())
                }
                "GET" -> files[path]?.let { response(200, it) } ?: response(404)
                "PUT" -> {
                    if (request.header("If-None-Match") == "*" && path in files) return response(412)
                    val body = Buffer().also { request.body!!.writeTo(it) }.readByteArray()
                    files[path] = body
                    if (interrupt && path.contains("/chunk-")) { interrupt = false; throw IOException("fixture disconnect after upload") }
                    response(201)
                }
                else -> error("Unexpected test method")
            }
        }
    }

    @Test fun isolatedMergeAndRetry() = runBlocking {
        val temporary = Files.createTempDirectory(instrumentation.targetContext.noBackupFilesDir.canonicalFile.toPath(), "qa-workspace-").toFile()
        try {
            val dav = FixtureDav()
            data class Peer(val root: File, val store: PersonalStore, val cloud: CloudService)
            suspend fun peer(platform: String): Peer {
                val dir = File(temporary, platform).apply { mkdirs() }
                seed(dir, platform)
                val store = PersonalStore(dir)
                val cloud = CloudService(dir, File(temporary, "$platform-control"), MemorySecrets(), object : CloudWorkspace {
                    override suspend fun capture(output: File) = BackupCodec.capture(dir, output)
                    override suspend fun restore(staged: BackupCodec.Staged) = error("Fixture must use additive merge")
                }, transport = dav, sleep = {})
                cloud.save("fixture", "FixtureFull", false, 24)
                cloud.setPassword("fixture")
                return Peer(dir, store, cloud)
            }
            suspend fun sync(peer: Peer, epoch: String) = peer.cloud.syncFull(epoch,
                capture = { BackupCodec.captureSelection(peer.root, it, FullWorkspaceMerge.capturePersonal(peer.store.snapshot()), FullWorkspaceMerge::includes) {} },
                merge = { FullWorkspaceMerge.merge(peer.root, peer.store, it) {} })
            val left = peer("mac")
            val right = peer("android")
            val historyID = UUID.randomUUID().toString()
            left.store.appendSession(JSONObject().put("id", historyID).put("status", "completed")
                .put("paperID", "fixture:paper").put("requestIssued", true).put("answer", "Original foreign research"))
            dav.interrupt = true
            try { sync(left, "before-restore"); fail("The fixture disconnect must interrupt upload") } catch (_: CloudFailure) {}
            val folderAfterFailure = dav.dirs.filter { it.matches(Regex(".*/[0-9a-f-]{36}/")) }
            val pdf = fixture.getJSONObject("expected").getJSONObject("pdf").getString("path")
            assertTrue(File(left.root, pdf).delete())
            sync(left, "after-restore")
            assertTrue(File(left.root, pdf).isFile)
            assertEquals(folderAfterFailure, dav.dirs.filter { it.matches(Regex(".*/[0-9a-f-]{36}/")) })
            val result = sync(right, "right")
            assertTrue(result.getInt("artifactConflicts") > 0)
            val history = requireNotNull(right.store.session(historyID))
            assertTrue(history.getBoolean("syncedHistory"))
            assertEquals("Original foreign research", history.getString("answer"))
            assertTrue(RequestContinuity.sessions(JSONObject().put("sessions", JSONArray().put(history))).isEmpty())
            val study = StudyService(right.store, { error("Synced history must never load a credential") })
            for (entry in listOf<suspend () -> Unit>({ study.run(historyID) }, { study.recoverSaved(historyID) })) {
                try { entry(); fail("Foreign history cannot be run or recovered on this device") }
                catch (failure: IllegalArgumentException) { assertTrue(failure.message.orEmpty().contains("只能查看")) }
            }
            val retained = right.cloud.retainedList()
            assertTrue(retained.length() > 0)
            val original = right.cloud.retainedSnapshot(retained.getJSONObject(0).getString("transferID"))
            val staged = BackupCodec.stage(original.inputStream(), temporary)
            try {
                val expected = fixture.getJSONObject("expected")
                val id = expected.getString("studyID")
                val inputs = expected.getJSONObject("preservedSHA256").getJSONArray("studyInputs")
                assertEquals(setOf(inputs.getString(0), inputs.getString(1)), setOf(
                    BackupCodec.hash(BackupCodec.checkedFile(staged.directory, "ModelUsage/$id-input.json")),
                    BackupCodec.hash(BackupCodec.checkedFile(right.root, "ModelUsage/$id-input.json"))
                ))
                val excluded = expected.getJSONArray("excludedSHA256")
                assertTrue(staged.entries.none { entry -> (0 until excluded.length()).any { excluded.getString(it) == entry.sha256 } })
            } finally { staged.directory.deleteRecursively() }
            assertEquals(2, OfflineStore(right.root).list().size)
            val archiveID = fixture.getJSONObject("expected").getString("archiveID")
            assertTrue(File(right.root, "SyncedArchiveHistory").walkTopDown().any { it.name == "$archiveID.json" })
            assertEquals(0, sync(right, "right").getInt("snapshots"))
            assertTrue(dav.files.keys.none { it.contains("ZoteroConnection") || it.contains("response-integrity") })
        } finally { temporary.deleteRecursively() }
        Unit
    }

    @Test fun realNutstore() = runBlocking {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("qaFullSync") == "true")
        val base = instrumentation.targetContext.noBackupFilesDir.canonicalFile
        val credentialFile = BackupCodec.checkedFile(base, "full-sync-qa-credentials.json")
        val credentials = JSONObject(credentialFile.readText())
        val folder = credentials.getString("folder")
        require(folder.matches(Regex("PD-FullSync-QA-[a-f0-9]{12,32}")))
        val private = File(base, "full-sync-qa-$folder").apply { mkdirs() }
        val research = File(private, "PaperDigest").apply { mkdirs() }
        val context = object : ContextWrapper(instrumentation.targetContext) { override fun getNoBackupFilesDir() = private }
        when (args.getString("qaPhase")) {
            "seed" -> {
                require(!File(research, "personal.json").exists())
                seed(research, "android", controls = false)
                File(research, "Exports/android-full-sync.txt").apply { parentFile!!.mkdirs(); writeText("Android full-sync original\n") }
            }
            "sync" -> {
                require(File(research, "Exports/android-full-sync.txt").isFile)
                val controller = RootController(context, installBackground = false, secretStore = MemorySecrets())
                controller.execute("cloud.save", JSONObject().put("folder", folder).put("account", credentials.getString("account")).put("automatic", false).put("intervalHours", 24))
                controller.updateSecret(SecretKind.CLOUD, credentials.getString("password"))
                val result = controller.execute("cloud.syncWorkspace")
                assertTrue("Native workspace synchronization failed", result.getBoolean("workspaceSynced"))
            }
            "verify" -> {
                assertEquals("Mac full-sync original\n", File(research, "Exports/macos-full-sync.txt").readText())
                val expected = fixture.getJSONObject("expected")
                assertEquals(expected.getJSONObject("pdf").getString("sha256"), BackupCodec.hash(File(research, expected.getJSONObject("pdf").getString("path"))))
                assertEquals(2, OfflineStore(research).list().size)
                assertTrue(File(research, "SyncedArchiveHistory").walkTopDown().any { it.name == "${expected.getString("archiveID")}.json" })
                val conflicts = File(private, "PaperDigestCloud").listFiles().orEmpty().filter { it.name.startsWith("archived-") }
                assertTrue(conflicts.isNotEmpty())
                val observed = research.walkTopDown().filter { it.isFile }.map { BackupCodec.hash(it) }.toMutableSet()
                for (folder in conflicts) {
                    val raw = BackupCodec.checkedFile(folder, "snapshot.paperdigest")
                    val staged = BackupCodec.stage(raw.inputStream(), private)
                    try { observed += staged.entries.map { it.sha256 } } finally { staged.directory.deleteRecursively() }
                }
                val preserved = expected.getJSONObject("preservedSHA256")
                for (name in listOf("studyInputs", "studyResponses", "archiveReceipts")) {
                    val hashes = preserved.getJSONArray(name)
                    for (index in 0 until hashes.length()) assertTrue("Missing exact $name original", hashes.getString(index) in observed)
                }
            }
            else -> error("Choose seed, sync or verify")
        }
        Unit
    }
}
