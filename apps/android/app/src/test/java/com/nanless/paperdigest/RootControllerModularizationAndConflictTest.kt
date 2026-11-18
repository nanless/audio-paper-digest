package com.nanless.paperdigest

import com.nanless.paperdigest.cloud.*
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.model.StudyService
import com.nanless.paperdigest.pdf.PdfChapter
import com.nanless.paperdigest.pdf.PdfEvidence
import com.nanless.paperdigest.pdf.PdfRepository
import com.nanless.paperdigest.secret.SecretStore
import com.nanless.paperdigest.ui.UiState
import com.nanless.paperdigest.ui.readerSourceNotices
import com.nanless.paperdigest.zotero.ZoteroMaterials
import com.nanless.paperdigest.zotero.ZoteroService
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.test.runTest
import okhttp3.Request
import okio.Buffer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.Collections
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

class RootControllerModularizationAndConflictTest {
    private val paperA = "arxiv:2601.00001"
    private val paperB = "arxiv:2601.00002"

    private suspend fun withIsolatedTempDir(block: suspend (File) -> Unit) {
        val dir = Files.createTempDirectory("pd-root-modular-test-").toRealPath().toFile()
        try {
            block(dir)
        } finally {
            dir.deleteRecursively()
        }
    }

    private class MemorySecretStore : SecretStore {
        private val map = ConcurrentHashMap<String, String>()
        override fun load(scope: String): String? = map[scope]
        override fun save(scope: String, secret: String) {
            map[scope] = secret
        }
        override fun remove(scope: String) {
            map.remove(scope)
        }
    }

    private class InMemoryWebDav : CloudTransport {
        val files = ConcurrentHashMap<String, ByteArray>()
        val directories: MutableSet<String> = Collections.newSetFromMap(ConcurrentHashMap())

        init {
            directories += "/dav/"
        }

        private fun listing(path: String, members: List<String>, filesInDir: List<String>): ByteArray {
            val dirXml = members.joinToString("") {
                "<d:response><d:href>$it</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
            }
            val fileXml = filesInDir.joinToString("") {
                "<d:response><d:href>$it</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
            }
            return "<d:multistatus xmlns:d=\"DAV:\">$dirXml$fileXml</d:multistatus>".toByteArray(Charsets.UTF_8)
        }

        override suspend fun execute(request: Request, limit: Int): CloudHTTP {
            val path = request.url.encodedPath
            return when (request.method) {
                "MKCOL" -> CloudHTTP(if (directories.add(path)) 201 else 405, emptyMap(), ByteArray(0))
                "PROPFIND" -> {
                    if (path !in directories) return CloudHTTP(404, emptyMap(), ByteArray(0))
                    val depth = request.header("Depth")
                    val childDirs = if (depth == "1") {
                        directories.filter { it != path && it.startsWith(path) && '/' !in it.removePrefix(path).removeSuffix("/") }.sorted()
                    } else emptyList()
                    val childFiles = if (depth == "1") {
                        files.keys.filter { it.startsWith(path) && '/' !in it.removePrefix(path) }.sorted()
                    } else emptyList()
                    CloudHTTP(207, emptyMap(), listing(path, listOf(path) + childDirs, childFiles))
                }
                "GET" -> files[path]?.let { CloudHTTP(200, emptyMap(), it.copyOf()) }
                    ?: CloudHTTP(404, emptyMap(), ByteArray(0))
                "PUT" -> {
                    val buffer = Buffer()
                    request.body!!.writeTo(buffer)
                    val bytes = buffer.readByteArray()
                    val previous = files.putIfAbsent(path, bytes)
                    CloudHTTP(if (previous == null) 201 else 412, emptyMap(), ByteArray(0))
                }
                else -> error("Unsupported WebDAV method: ${request.method}")
            }
        }
    }

    private class CloudPeerHarness(baseDir: File, name: String, transport: InMemoryWebDav) {
        val peerRoot = File(baseDir, name).apply { mkdirs() }
        val research = File(peerRoot, "PaperDigest").apply { mkdirs() }
        val cloudControl = File(peerRoot, "PaperDigestCloud")
        val deviceDir = File(peerRoot, "PaperDigestDevice")
        val personal = PersonalStore(research)
        val secrets = MemorySecretStore()
        val maintenance = Mutex()
        val dispatch = WorkspaceDispatch(deviceDir)
        val restores = ConcurrentHashMap<String, RestorePreparation>()
        val active = ConcurrentHashMap<String, Job>()
        val state = MutableStateFlow(UiState())
        val notices = mutableListOf<String>()

        val workspace: CloudWorkspace = object : CloudWorkspace {
            override suspend fun capture(output: File): BackupCodec.Captured =
                BackupCodec.capture(research, output)
            override suspend fun restore(staged: BackupCodec.Staged) {
                RestorePolicy.install(staged, research, initialize = {
                    personal.reload()
                    dispatch.rotate()
                })
                coordinator.clearNoteConflicts()
                refreshState()
            }
        }

        val cloud: CloudService = CloudService(
            researchRoot = research,
            controlRoot = cloudControl,
            vault = secrets,
            workspace = workspace,
            transport = transport,
            sleep = {},
        )

        val coordinator: CloudSyncCoordinator = CloudSyncCoordinator(
            research = research,
            personal = personal,
            cloud = cloud,
            restores = restores,
            active = active,
            maintenance = { maintenance },
            currentEpoch = { dispatch.epoch },
            requireCurrentEpoch = dispatch::requireCurrent,
            reloadLibrary = {},
            onRefresh = ::refreshState,
            onNotice = { msg -> notices += msg; state.update { it.copy(notice = msg) } },
            runTask = { _, gate, body -> gate(); body() },
            isPlatformCloudWorkFinished = { _, _ -> true },
            enqueueCloudUploadWork = { _, _, _ -> },
        )

        fun refreshState() {
            val snap = personal.snapshot()
            state.update {
                it.copy(
                    workspaceEpoch = dispatch.epoch,
                    personal = snap,
                    cloud = coordinator.cloudView(snap),
                    noteConflicts = coordinator.noteConflictsSnapshot(),
                )
            }
        }

        suspend fun configureAccount(account: String = "researcher@example.invalid", folder: String = "PaperDigest") {
            coordinator.executeCloudCommand(
                "cloud.save",
                JSONObject().put("account", account).put("folder", folder).put("automatic", false).put("intervalHours", 24),
                dispatch.epoch,
                null
            )
            cloud.setPassword("synthetic-app-password")
            refreshState()
        }

        suspend fun savePersonalNote(paperId: String, text: String, baseRevision: Int): JSONObject {
            val saved = coordinator.savePersonalNoteAndClearConflict(paperId, text, baseRevision, dispatch.epoch)
            refreshState()
            return saved
        }

        suspend fun exec(command: String, payload: JSONObject = JSONObject()): JSONObject {
            val result = coordinator.executeCloudCommand(command, payload, dispatch.epoch, null)
            refreshState()
            return result
        }
    }

    @Test
    fun endToEndWebDavNoteConflictCaptureDualCasProtectionAndMergeBothConvergence() = runTest {
        withIsolatedTempDir { dir ->
            val sharedDav = InMemoryWebDav()
            val peerMac = CloudPeerHarness(dir, "mac", sharedDav)
            val peerAndroid = CloudPeerHarness(dir, "android", sharedDav)
            peerMac.configureAccount()
            peerAndroid.configureAccount()

            // 1. Seed initial note on peerMac and sync to peerAndroid
            peerMac.personal.setList("favorites", listOf(paperA))
            peerMac.personal.saveNote(paperA, "共识初稿：基线模型 WER 4.2%", baseRevision = 0)
            peerMac.exec("cloud.syncPersonal")

            val initialPull = peerAndroid.exec("cloud.syncPersonal")
            assertEquals(0, initialPull.getInt("conflicts"))
            assertEquals("共识初稿：基线模型 WER 4.2%", peerAndroid.personal.note(paperA).getString("text"))
            val syncedRevision = peerAndroid.personal.note(paperA).getInt("revision")

            // 2. Concurrent heterogeneous edits on both peers
            peerMac.personal.saveNote(paperA, "Mac 笔记：新增定理 2 证明细节", baseRevision = 1)
            peerAndroid.personal.saveNote(paperA, "Android 笔记：补充消融实验对比结论", baseRevision = syncedRevision)

            peerMac.exec("cloud.syncPersonal")
            val conflictedSync = peerAndroid.exec("cloud.syncPersonal")

            assertEquals(1, conflictedSync.getInt("conflicts"))
            assertEquals(1, conflictedSync.getJSONArray("noteConflicts").length())
            assertEquals(1, peerAndroid.state.value.noteConflicts.size)

            val conflict = peerAndroid.state.value.noteConflicts.single()
            assertEquals(paperA, conflict.paperId)
            assertEquals("Android 笔记：补充消融实验对比结论", conflict.localNote)
            assertEquals("Mac 笔记：新增定理 2 证明细节", conflict.remoteNote)
            assertEquals(peerMac.cloud.targetID, conflict.remoteDeviceId)

            assertTrue(readerSourceNotices(peerAndroid.state.value, paperA, null).any { it.title == "云端笔记冲突" })
            assertFalse(readerSourceNotices(peerAndroid.state.value, paperB, null).any { it.title == "云端笔记冲突" })

            // 3. Positive MERGE_BOTH resolution at exact conflict revision & causal convergence across both peers
            val conflictRev = peerAndroid.personal.note(paperA).getInt("revision")
            // Stale baseRevision (conflictRev + 5) is strictly rejected
            val wrongBaseFailure = assertThrows(AppFailure::class.java) {
                runBlocking {
                    peerAndroid.exec(
                        "cloud.noteConflict.resolve",
                        JSONObject().put("paperID", paperA).put("strategy", "MERGE_BOTH").put("baseRevision", conflictRev + 5)
                    )
                }
            }
            assertEquals("conflict", wrongBaseFailure.category)
            assertEquals(1, peerAndroid.state.value.noteConflicts.size)

            val resolved = peerAndroid.exec(
                "cloud.noteConflict.resolve",
                JSONObject().put("paperID", paperA).put("strategy", "MERGE_BOTH").put("baseRevision", conflictRev)
            )
            assertTrue(resolved.getBoolean("resolved"))
            assertEquals(conflictRev + 1, resolved.getInt("revision"))
            assertTrue(peerAndroid.state.value.noteConflicts.isEmpty())
            val mergedText = peerAndroid.personal.note(paperA).getString("text")
            assertTrue(mergedText.contains("Android 笔记：补充消融实验对比结论"))
            assertTrue(mergedText.contains("Mac 笔记：新增定理 2 证明细节"))

            val postResolveAndroid = peerAndroid.exec("cloud.syncPersonal")
            assertEquals(0, postResolveAndroid.getInt("conflicts"))
            assertTrue(peerAndroid.state.value.noteConflicts.isEmpty())

            val postResolveMac = peerMac.exec("cloud.syncPersonal")
            assertEquals(0, postResolveMac.getInt("conflicts"))
            assertTrue(peerMac.state.value.noteConflicts.isEmpty())
            assertEquals(mergedText, peerMac.personal.note(paperA).getString("text"))
        }
    }

    @Test
    fun keepLocalAndAdoptRemoteConvergeCausallyAcrossRealTwoPeerWebDavSync() = runTest {
        withIsolatedTempDir { dir ->
            val sharedDav = InMemoryWebDav()
            val peerMac = CloudPeerHarness(dir, "mac", sharedDav)
            val peerAndroid = CloudPeerHarness(dir, "android", sharedDav)
            peerMac.configureAccount()
            peerAndroid.configureAccount()

            // Seed shared baseline
            peerMac.personal.saveNote(paperA, "初始版本", baseRevision = 0)
            peerMac.exec("cloud.syncPersonal")
            peerAndroid.exec("cloud.syncPersonal")

            // Round 1: KEEP_LOCAL (text unchanged on Android, revision + 1 advances causal seen vector!)
            peerMac.personal.saveNote(paperA, "Mac 并发修改 V1", baseRevision = peerMac.personal.note(paperA).getInt("revision"))
            peerAndroid.personal.saveNote(paperA, "Android 本机版本 V1", baseRevision = peerAndroid.personal.note(paperA).getInt("revision"))
            peerMac.exec("cloud.syncPersonal")
            val sync1 = peerAndroid.exec("cloud.syncPersonal")
            assertEquals(1, sync1.getInt("conflicts"))
            assertEquals(1, peerAndroid.state.value.noteConflicts.size)

            val revBeforeKeep = peerAndroid.personal.note(paperA).getInt("revision")
            val kept = peerAndroid.exec(
                "cloud.noteConflict.resolve",
                JSONObject().put("paperID", paperA).put("strategy", "KEEP_LOCAL").put("baseRevision", revBeforeKeep)
            )
            assertEquals("Android 本机版本 V1", kept.getString("text"))
            assertEquals(revBeforeKeep + 1, kept.getInt("revision"))
            assertTrue(peerAndroid.state.value.noteConflicts.isEmpty())

            val androidPushKeep = peerAndroid.exec("cloud.syncPersonal")
            assertEquals(0, androidPushKeep.getInt("conflicts"))
            val macPullKeep = peerMac.exec("cloud.syncPersonal")
            assertEquals(0, macPullKeep.getInt("conflicts"))
            assertEquals("Android 本机版本 V1", peerMac.personal.note(paperA).getString("text"))

            // Round 2: ADOPT_REMOTE across real WebDAV sync
            peerMac.personal.saveNote(paperA, "Mac 并发修改 V2（将被采用）", baseRevision = peerMac.personal.note(paperA).getInt("revision"))
            peerAndroid.personal.saveNote(paperA, "Android 并发修改 V2", baseRevision = peerAndroid.personal.note(paperA).getInt("revision"))
            peerMac.exec("cloud.syncPersonal")
            val sync2 = peerAndroid.exec("cloud.syncPersonal")
            assertEquals(1, sync2.getInt("conflicts"))

            val revBeforeAdopt = peerAndroid.personal.note(paperA).getInt("revision")
            val adopted = peerAndroid.exec(
                "cloud.noteConflict.resolve",
                JSONObject().put("paperID", paperA).put("strategy", "ADOPT_REMOTE").put("baseRevision", revBeforeAdopt)
            )
            assertEquals("Mac 并发修改 V2（将被采用）", adopted.getString("text"))
            assertTrue(peerAndroid.state.value.noteConflicts.isEmpty())

            val androidPushAdopt = peerAndroid.exec("cloud.syncPersonal")
            assertEquals(0, androidPushAdopt.getInt("conflicts"))
            val macPullAdopt = peerMac.exec("cloud.syncPersonal")
            assertEquals(0, macPullAdopt.getInt("conflicts"))
            assertEquals("Mac 并发修改 V2（将被采用）", peerMac.personal.note(paperA).getString("text"))
        }
    }

    @Test
    fun unresolvedConflictSurvivesSecondSyncOnOtherPapersAndDualCasGuardsAgainstDirectStoreWrites() = runTest {
        withIsolatedTempDir { dir ->
            val sharedDav = InMemoryWebDav()
            val peerMac = CloudPeerHarness(dir, "mac", sharedDav)
            val peerAndroid = CloudPeerHarness(dir, "android", sharedDav)
            peerMac.configureAccount()
            peerAndroid.configureAccount()

            peerMac.personal.saveNote(paperA, "初稿", baseRevision = 0)
            peerMac.exec("cloud.syncPersonal")
            peerAndroid.exec("cloud.syncPersonal")

            peerMac.personal.saveNote(paperA, "Mac 异文", baseRevision = peerMac.personal.note(paperA).getInt("revision"))
            peerAndroid.personal.saveNote(paperA, "Android 异文", baseRevision = peerAndroid.personal.note(paperA).getInt("revision"))
            peerMac.exec("cloud.syncPersonal")
            val firstConflictSync = peerAndroid.exec("cloud.syncPersonal")
            assertEquals(1, firstConflictSync.getInt("conflicts"))
            assertEquals(paperA, peerAndroid.state.value.noteConflicts.single().paperId)

            // 1. While paperA conflict is unresolved, edit paperB (favorite + note) and run second syncPersonal
            peerAndroid.personal.setList("favorites", listOf(paperB))
            peerAndroid.savePersonalNote(paperB, "论文 B 的独立笔记", baseRevision = 0)
            val secondSync = peerAndroid.exec("cloud.syncPersonal")
            assertEquals(1, secondSync.getInt("conflicts"))
            assertEquals(1, peerAndroid.state.value.noteConflicts.size)
            assertEquals(paperA, peerAndroid.state.value.noteConflicts.single().paperId)
            assertEquals("Android 异文", peerAndroid.state.value.noteConflicts.single().localNote)

            // 2. If underlying store text for paperA changed directly, resolveNoteConflict MUST reject EVEN IF caller passes new revision!
            val beforeUnderlyingWriteRev = peerAndroid.personal.note(paperA).getInt("revision")
            peerAndroid.personal.saveNote(paperA, "底层直接改写的新草稿（绝不能被旧冲突快照覆盖）", baseRevision = beforeUnderlyingWriteRev)
            val newUnderlyingRev = peerAndroid.personal.note(paperA).getInt("revision")

            // Stale baseRevision fails
            val staleRevFailure = assertThrows(AppFailure::class.java) {
                runBlocking {
                    peerAndroid.exec(
                        "cloud.noteConflict.resolve",
                        JSONObject().put("paperID", paperA).put("strategy", "MERGE_BOTH").put("baseRevision", beforeUnderlyingWriteRev)
                    )
                }
            }
            assertEquals("conflict", staleRevFailure.category)

            // Passing newUnderlyingRev ALSO fails because currentNote.text != conflict.localNote!
            val textChangedFailure = assertThrows(AppFailure::class.java) {
                runBlocking {
                    peerAndroid.exec(
                        "cloud.noteConflict.resolve",
                        JSONObject().put("paperID", paperA).put("strategy", "MERGE_BOTH").put("baseRevision", newUnderlyingRev)
                    )
                }
            }
            assertEquals("conflict", textChangedFailure.category)
            assertEquals(
                "底层直接改写的新草稿（绝不能被旧冲突快照覆盖）",
                peerAndroid.personal.note(paperA).getString("text")
            )

            // 3. Normal "personal.note" save immediately clears paperA's pending conflict and converges on next sync
            peerAndroid.savePersonalNote(paperA, "用户最终定稿笔记", baseRevision = newUnderlyingRev)
            assertTrue(peerAndroid.state.value.noteConflicts.isEmpty())
            val convergedSync = peerAndroid.exec("cloud.syncPersonal")
            assertEquals(0, convergedSync.getInt("conflicts"))
            assertTrue(peerAndroid.state.value.noteConflicts.isEmpty())
        }
    }

    @Test
    fun workspaceRestoreClearsNoteConflictsInvalidatesFreshStudyAndSyncsCatalogSchedule() = runTest {
        withIsolatedTempDir { dir ->
            val sharedDav = InMemoryWebDav()
            val peer = CloudPeerHarness(dir, "restore-peer", sharedDav)
            peer.configureAccount()
            peer.personal.updateSettings(
                JSONObject()
                    .put("endpoint", "https://api.example.invalid/v1")
                    .put("model", "deepseek-v4.1-flash")
                    .put("protocol", "chat")
                    .put("syncHours", 48)
            )
            peer.personal.saveNote(paperA, "备份快照中的干净笔记", baseRevision = 0)
            val backupFile = File(dir, "clean.paperdigest")
            val captured = peer.workspace.capture(backupFile)
            assertTrue(captured.fileCount >= 1)

            // Mutate settings and inject pending note conflict + pending FreshStudy confirmation
            peer.personal.updateSettings(JSONObject().put("syncHours", 6))
            peer.coordinator.recordSyncedNoteConflicts(
                listOf(NoteConflictItem(paperA, "冲突本机稿", "冲突云端稿", UUID.randomUUID().toString(), 4L))
            )
            peer.refreshState()
            assertEquals(1, peer.state.value.noteConflicts.size)

            val scheduled = mutableListOf<CatalogRefreshSettings>()
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
            try {
                val catalogCoordinator = CatalogMaintenanceCoordinator(
                    installBackground = true,
                    foregroundOwners = Collections.newSetFromMap(ConcurrentHashMap()),
                    scope = { scope },
                    maintenance = { peer.maintenance },
                    settings = peer.personal::settings,
                    library = object : CatalogMaintenancePort {
                        override fun summary(): JSONObject = JSONObject()
                        override suspend fun hasPublishedCatalogUpdate(): Boolean = false
                        override suspend fun sync(onProgress: (Int, Int, String) -> Unit): JSONObject = JSONObject()
                        override fun aggregateStamp(): AggregateCatalogStamp = AggregateCatalogStamp("a".repeat(64), "e1")
                        override suspend fun aggregateCatalog(): PublishedAggregateCatalog? = null
                        override suspend fun preloadAggregateDocument(id: String, expected: AggregateCatalogStamp, withCommitLock: suspend (() -> Unit) -> Unit) {}
                        override fun papers(): List<Paper> = emptyList()
                        override suspend fun preloadArticle(paper: Paper) {}
                    },
                    hasActiveTasks = { false },
                    hasSelectedAggregate = { false },
                    readingGeneration = { 0L },
                    pauseAggregatePreviews = {},
                    resumeAggregatePreviews = {},
                    enterAggregateBrowser = {},
                    leaveAggregateBrowser = {},
                    retireAggregateBrowser = {},
                    executeAggregateBrowser = { _, _, _, _ -> JSONObject() },
                    runTask = { _, body -> body() },
                    onCatalogCheckedAt = {},
                    onNotice = {},
                    onRefresh = {},
                    updatePeriodicSchedule = { scheduled += it },
                )
                catalogCoordinator.scheduleCatalog()
                assertEquals(6L, scheduled.last().hours)

                val studyService = StudyService(peer.personal, { "synthetic-secret" })
                val studyCoordinator = StudyCoordinator(
                    research = peer.research,
                    personal = peer.personal,
                    model = studyService,
                    active = peer.active,
                    maintenance = { peer.maintenance },
                    currentEpoch = { peer.dispatch.epoch },
                    requireCurrentEpoch = peer.dispatch::requireCurrent,
                    currentState = { peer.state.value },
                    currentReadingID = { "" },
                    requireReading = { _, _ -> },
                    requireReadingMaterials = {},
                    selectedPaper = { error("Unused") },
                    pdfOutline = { emptyList() },
                    pdfEvidence = { _, _, _ -> PdfEvidence("a".repeat(64), "pdf-range", listOf(1), "text", emptyList()) },
                    enqueueStudyWork = { _, _ -> },
                    onRefresh = {},
                )
                val preRestoreCheck = studyCoordinator.prepareFreshStudy(
                    "model.fresh.check.prepare",
                    JSONObject(),
                    ReadingAccess(null, 0L, null, null, 1, ""),
                    peer.dispatch.epoch
                )

                // Stage and restore clean workspace
                val staged = BackupCodec.stage(backupFile.inputStream(), peer.peerRoot)
                try {
                    peer.workspace.restore(staged)
                    studyCoordinator.workspaceRestored()
                    catalogCoordinator.workspaceRestored()
                } finally {
                    staged.directory.deleteRecursively()
                }

                // Verify noteConflicts cleared, restored syncHours=48 re-scheduled, and old FreshStudy confirmation invalidated
                assertTrue(peer.state.value.noteConflicts.isEmpty())
                assertEquals(48L, scheduled.last().hours)
                assertThrows(Exception::class.java) {
                    runBlocking {
                        studyCoordinator.commitFreshStudy(
                            JSONObject()
                                .put("confirmationID", preRestoreCheck.getString("confirmationID"))
                                .put("draftIdentity", preRestoreCheck.getString("draftIdentity"))
                        )
                    }
                }
            } finally {
                scope.cancel()
            }
        }
    }

    @Test
    fun coordinatorRejectsTwoMiBMergeOverflowLeavingStoreAndConflictUntouched() = runTest {
        withIsolatedTempDir { dir ->
            val dav = InMemoryWebDav()
            val peer = CloudPeerHarness(dir, "single", dav)
            peer.configureAccount()
            val largeLocal = "甲".repeat(400_000)
            val largeRemote = "乙".repeat(400_000)
            peer.personal.saveNote(paperA, largeLocal, baseRevision = 0)
            peer.coordinator.recordSyncedNoteConflicts(
                listOf(NoteConflictItem(paperA, largeLocal, largeRemote, UUID.randomUUID().toString(), 2L))
            )
            peer.refreshState()

            val rejected = assertThrows(AppFailure::class.java) {
                runBlocking {
                    peer.exec(
                        "cloud.noteConflict.resolve",
                        JSONObject().put("paperID", paperA).put("strategy", "MERGE_BOTH").put("baseRevision", 1)
                    )
                }
            }
            assertEquals("capacity", rejected.category)
            assertEquals(largeLocal, peer.personal.note(paperA).getString("text"))
            assertEquals(1, peer.personal.note(paperA).getInt("revision"))
            assertEquals(1, peer.state.value.noteConflicts.size)
        }
    }

    @Test
    fun catalogMaintenanceCoordinatorGatesReadersCoalescesSyncAndManagesAggregateLeases() = runTest {
        val nowElapsed = 100_000L
        val nowWall = 1_762_000_000_000L
        val syncCount = AtomicInteger(0)
        val preloadedAggregates = mutableListOf<String>()
        val preloadedPapers = mutableListOf<String>()
        val scheduledSettings = mutableListOf<CatalogRefreshSettings>()
        val foregroundOwners: MutableSet<Any> = Collections.newSetFromMap(ConcurrentHashMap())
        val maintenance = Mutex()
        val settings = AtomicReference(JSONObject().put("offlineMode", false).put("syncHours", 12))
        val syncedAt = AtomicReference<String?>("2020-01-01T00:00:00Z")
        val stamp = AggregateCatalogStamp("a".repeat(64), "epoch-1")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

        try {
            val descriptor = PublishedAggregate(
                id = "daily:2026-11-01",
                kind = "daily",
                conferenceScope = null,
                title = "2026-11-01 论文速递",
                titleZh = "2026-11-01 论文速递",
                summary = "受控日更摘要",
                rawDate = "2026-11-01",
                displayDate = "2026-11-01",
                categories = emptyList(),
                tags = emptyList(),
                sourceURL = "https://nanless.github.io/audio-paper-digest-blog/posts/2026-11-01/",
                source = AggregateSource("a".repeat(64), "b".repeat(64), 128, "search-index/part-0001-bbbbbbbbbbbb.json", 0, "c".repeat(64), "foundation-sorted-keys-json"),
            )
            val samplePaper = Paper(
                id = paperA,
                title = "Sample Audio Paper",
                date = "2026-11-01",
                sourceKind = "arxiv",
                blogURL = "https://nanless.github.io/audio-paper-digest-blog/papers/1/",
            )
            val port = object : CatalogMaintenancePort {
                override fun summary(): JSONObject = JSONObject()
                    .put("snapshotID", "snap-1")
                    .put("paperCount", 1)
                    .put("syncedAt", syncedAt.get() ?: JSONObject.NULL)
                override suspend fun hasPublishedCatalogUpdate(): Boolean = false
                override suspend fun sync(onProgress: (Int, Int, String) -> Unit): JSONObject {
                    syncCount.incrementAndGet()
                    syncedAt.set("2026-06-02T06:00:00Z")
                    return JSONObject().put("synced", true)
                }
                override fun aggregateStamp(): AggregateCatalogStamp = stamp
                override suspend fun aggregateCatalog(): PublishedAggregateCatalog = PublishedAggregateCatalog(
                    snapshotSHA256 = stamp.snapshotSHA256,
                    sourceRecordCount = 1,
                    records = listOf(descriptor),
                )
                override suspend fun preloadAggregateDocument(
                    id: String,
                    expected: AggregateCatalogStamp,
                    withCommitLock: suspend (() -> Unit) -> Unit,
                ) {
                    withCommitLock { preloadedAggregates += id }
                }
                override fun papers(): List<Paper> = listOf(samplePaper)
                override suspend fun preloadArticle(paper: Paper) {
                    preloadedPapers += paper.id
                }
            }

            val coordinator = CatalogMaintenanceCoordinator(
                installBackground = true,
                foregroundOwners = foregroundOwners,
                scope = { scope },
                maintenance = { maintenance },
                settings = settings::get,
                library = port,
                hasActiveTasks = { false },
                hasSelectedAggregate = { false },
                readingGeneration = { 7L },
                pauseAggregatePreviews = {},
                resumeAggregatePreviews = {},
                enterAggregateBrowser = {},
                leaveAggregateBrowser = {},
                retireAggregateBrowser = {},
                executeAggregateBrowser = { command, _, _, _ ->
                    JSONObject().put("status", if (command == "aggregate.list") "index-ready" else "ok")
                },
                runTask = { _, body -> body() },
                onCatalogCheckedAt = {},
                onNotice = {},
                onRefresh = {},
                updatePeriodicSchedule = { scheduledSettings += it },
                elapsedRealtimeMillis = { nowElapsed },
                currentTimeMillis = { nowWall },
            )

            coordinator.scheduleCatalog()
            coordinator.scheduleCatalog()
            assertEquals(1, scheduledSettings.size)

            val activity = Any()
            val reader1 = Any()
            val reader2 = Any()
            foregroundOwners.add(activity)
            coordinator.readingViewVisible(reader1, true)
            coordinator.readingViewVisible(reader2, true)
            assertFalse(coordinator.performAutomaticCatalogSync())
            assertEquals(0, syncCount.get())

            coordinator.readingViewVisible(reader1, false)
            assertFalse(coordinator.performAutomaticCatalogSync())
            coordinator.readingViewVisible(reader2, false)
            assertNotNull(coordinator.automaticCatalogJob.get())
            assertFalse(coordinator.performAutomaticCatalogSync())
            coordinator.giveForegroundPriority()
            assertTrue(coordinator.performAutomaticCatalogSync())
            assertEquals(1, syncCount.get())

            coordinator.publishedPreload.get()?.join()
            assertEquals(listOf("daily:2026-11-01"), preloadedAggregates)
            assertEquals(listOf(paperA), preloadedPapers)

            val staleLease = coordinator.captureAggregateView()
            coordinator.enterAggregateView()
            assertEquals(
                "not-adopted",
                coordinator.executeAggregateInView("aggregate.list", JSONObject(), staleLease).getString("status")
            )
            val currentLease = coordinator.captureAggregateView()
            assertEquals(
                "index-ready",
                coordinator.executeAggregateInView("aggregate.list", JSONObject(), currentLease).getString("status")
            )
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun settingsValidatorStudyGateAndZoteroCoordinatorBehaveCorrectly() = runTest {
        withIsolatedTempDir { dir ->
            val currentSettings = PersonalStore.initial().getJSONObject("settings")
            val validChanges = JSONObject().put("font", "22").put("syncHours", 24).put("appearance", "dark")
                .put("httpProxy", "http://127.0.0.1:7890")
            SettingsValidator.validate(validChanges, currentSettings)
            assertEquals(22, validChanges.getInt("font"))

            assertThrows(IllegalArgumentException::class.java) {
                SettingsValidator.validate(JSONObject().put("font", 99), currentSettings)
            }
            assertThrows(IllegalArgumentException::class.java) {
                SettingsValidator.validate(JSONObject().put("httpProxy", "http://user:pass@127.0.0.1:7890"), currentSettings)
            }

            val research = File(dir, "PaperDigest").apply { mkdirs() }
            val personal = PersonalStore(research)
            personal.updateSettings(
                JSONObject()
                    .put("endpoint", "https://api.example.invalid/v1")
                    .put("model", "deepseek-v4.1-flash")
                    .put("protocol", "chat")
            )
            val secrets = MemorySecretStore().apply { save("model.primary", "synthetic-secret") }
            val studyService = StudyService(personal, { secrets.load("model.primary") })
            val active = ConcurrentHashMap<String, Job>()
            val maintenance = Mutex()
            val enqueuedSessions = mutableListOf<String>()
            val uiState = MutableStateFlow(UiState())
            val studyCoordinator = StudyCoordinator(
                research = research,
                personal = personal,
                model = studyService,
                active = active,
                maintenance = { maintenance },
                currentEpoch = { "epoch-1" },
                requireCurrentEpoch = { require(it == "epoch-1") },
                currentState = { uiState.value },
                currentReadingID = { "" },
                requireReading = { _, _ -> },
                requireReadingMaterials = {},
                selectedPaper = { error("No selected paper needed for connection-check") },
                pdfOutline = { emptyList<PdfChapter>() },
                pdfEvidence = { _, _, _ -> PdfEvidence("a".repeat(64), "pdf-range", listOf(1), "text", emptyList()) },
                enqueueStudyWork = { sessionId, _ -> enqueuedSessions += sessionId },
                onRefresh = {},
            )

            val access = ReadingAccess(null, 0L, null, null, 1, "")
            val preparedCheck = studyCoordinator.prepareFreshStudy("model.fresh.check.prepare", JSONObject(), access, "epoch-1")
            val confirmationId = preparedCheck.getString("confirmationID")

            assertThrows(IllegalArgumentException::class.java) {
                runBlocking {
                    studyCoordinator.commitFreshStudy(
                        JSONObject().put("confirmationID", confirmationId).put("draftIdentity", "0".repeat(64))
                    )
                }
            }

            val preparedCheck2 = studyCoordinator.prepareFreshStudy("model.fresh.check.prepare", JSONObject(), access, "epoch-1")
            val committed = studyCoordinator.commitFreshStudy(
                JSONObject()
                    .put("confirmationID", preparedCheck2.getString("confirmationID"))
                    .put("draftIdentity", preparedCheck2.getString("draftIdentity"))
            )
            assertTrue(committed.getBoolean("queued"))
            assertEquals(1, enqueuedSessions.size)

            val borrowing = CloudCredentialBorrowing { "epoch-1" }
            val offline = OfflineStore(research)
            val zoteroCoordinator = ZoteroCoordinator(
                personal = personal,
                offline = offline,
                cloudCredentialBorrowing = borrowing,
                maintenance = { maintenance },
                currentEpoch = { "epoch-1" },
                requireCurrentEpoch = { require(it == "epoch-1") },
                currentCloudBinding = { CloudCredentialBinding("dest-1", "", "PaperDigest") },
                currentReadingToken = { "token-1" },
                prepareOfflineArticle = { it },
                downloadPDF = { error("Not called") },
                pdfReceipt = { JSONObject() },
                buildMaterials = { _, _, _, _, _ -> ZoteroMaterials(paperA, "id-1", JSONObject(), emptyList()) },
            )
            val zotero = ZoteroService(research, secrets, zoteroCoordinator.materialProvider())
            val revoked = zoteroCoordinator.executeMigrationCommand(
                "zotero.migration.revoke",
                JSONObject(),
                zotero,
                hasActiveTasks = { false },
                runTask = { _, gate, body -> gate(); body() }
            )
            assertTrue(revoked.getBoolean("revoked"))
            zoteroCoordinator.workspaceRestored(zotero)
        }
    }

    @Test
    fun rootControllerPreservesAllPublicInternalAndReflectionContracts() {
        val clazz = RootController::class.java
        val requiredFields = mapOf(
            "personal" to PersonalStore::class.java,
            "cloud" to CloudService::class.java,
            "maintenance" to Mutex::class.java,
            "library" to CatalogRepository::class.java,
            "exportScope" to CoroutineScope::class.java,
            "pdf" to PdfRepository::class.java,
            "_state" to MutableStateFlow::class.java,
            "generation" to AtomicLong::class.java,
            "active" to ConcurrentHashMap::class.java,
            "pdfAcquisition" to AtomicReference::class.java,
            "dispatch" to WorkspaceDispatch::class.java,
            "restores" to ConcurrentHashMap::class.java,
            "foregroundOwners" to Set::class.java,
        )
        for ((name, expectedType) in requiredFields) {
            val field = clazz.getDeclaredField(name)
            assertTrue(
                "Field $name (${field.type}) must remain assignable to $expectedType",
                expectedType.isAssignableFrom(field.type)
            )
        }
        assertNotNull(clazz.getDeclaredMethod("refresh"))
        assertTrue(clazz.declaredMethods.any { it.returnType == AggregateBrowser::class.java && it.parameterTypes.isEmpty() })
        assertEquals(4, clazz.declaredConstructors.filter { !it.isSynthetic }.size)
    }
}
