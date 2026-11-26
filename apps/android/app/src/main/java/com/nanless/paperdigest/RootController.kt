package com.nanless.paperdigest

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import androidx.work.*
import com.nanless.paperdigest.cloud.*
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.model.StudyService
import com.nanless.paperdigest.pdf.*
import com.nanless.paperdigest.secret.SecretStore
import com.nanless.paperdigest.secret.SecretVault
import com.nanless.paperdigest.ui.*
import com.nanless.paperdigest.zotero.*
import com.nanless.paperdigest.zotero.webdav.ZoteroDavFailure
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Collections
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/** The Application owns one controller for UI and workers; maintenance never opens a second store. */
class RootController private constructor(
    private val context: Context,
    private val installBackground: Boolean,
    private val exportStoreFactory: ((File, File) -> PendingExportStore)?,
    secretStore: SecretStore?,
    catalogFactory: ((Context, PersonalStore) -> CatalogRepository)?,
) : AppController {
    internal constructor(
        context: Context,
        installBackground: Boolean = true,
        exportStoreFactory: ((File, File) -> PendingExportStore)? = null,
    ) : this(context, installBackground, exportStoreFactory, null, null)

    internal constructor(context: Context, installBackground: Boolean, secretStore: SecretStore) :
        this(context, installBackground, null, secretStore, null)

    internal constructor(
        context: Context,
        installBackground: Boolean,
        secretStore: SecretStore,
        catalogFactory: (Context, PersonalStore) -> CatalogRepository,
    ) : this(context, installBackground, null, secretStore, catalogFactory)

    private val research: File = RootResearchDirectory.resolve(context.noBackupFilesDir)
    private val deviceRoot: File = File(context.noBackupFilesDir.canonicalFile, "PaperDigestDevice")
    val personal: PersonalStore = PersonalStore(research)
    private val library: CatalogRepository = catalogFactory?.invoke(context, personal) ?: CatalogRepository(context, personal)
    private val offline: OfflineStore = OfflineStore(research)
    @Volatile private var offlineReading: OfflineStore.Opened? = null
    private val pdf: PdfRepository = PdfRepository(context, research)
    private val secrets: SecretStore = secretStore ?: SecretVault(context)
    private val modelKeyBinding: ModelKeyBinding = ModelKeyBinding(deviceRoot)
    private val model: StudyService = StudyService(personal, {
        modelKeyBinding.requireEndpoint(personal.settings().getString("endpoint"))
        secrets.load("model.primary")
    })
    private val exports: ExportService = ExportService(context, personal, model, library::publishedRecords, library::citationOriginal)
    private val capacity: StorageCapacity by lazy {
        val paths = RootResearchDirectory.capacityPaths(context.noBackupFilesDir)
        StorageCapacity(research, paths.first, paths.second, paths.third)
    }

    private val maintenance: Mutex = Mutex()
    private val dispatch: WorkspaceDispatch = WorkspaceDispatch(deviceRoot)
    private val workspaceAdmission = Any()
    private class WorkspacePhase(val installing: Boolean)
    @Volatile private var workspacePhase = WorkspacePhase(false)

    private fun workspaceActionEpoch(expectedEpoch: String? = null): String = synchronized(workspaceAdmission) {
        if (workspacePhase.installing) throw AppFailure("restoreInProgress", "正在恢复研究资料，请等恢复完成后再操作")
        expectedEpoch?.let(dispatch::requireCurrent)
        dispatch.epoch
    }

    private val cloudCredentialBorrowing: CloudCredentialBorrowing = CloudCredentialBorrowing { dispatch.epoch }
    private val generation: AtomicLong = AtomicLong(0)
    private val active: ConcurrentHashMap<String, Job> = ConcurrentHashMap()
    private val restores: ConcurrentHashMap<String, RestorePreparation> = ConcurrentHashMap()
    private val _state: MutableStateFlow<UiState> = MutableStateFlow(
        UiState(nativePodcastEnabled = true, nativeResourceBadgesEnabled = true)
    )
    override val state: StateFlow<UiState> = _state

    /** Application lifetime work. A screen awaiting a result never owns the producer. */
    private val exportScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val podcastRepository: PodcastRepository by lazy {
        PodcastRepository(File(context.cacheDir, "podcast-cache"))
    }
    private val podcastCoordinator: PodcastCoordinator by lazy {
        PodcastCoordinator(
            context = context,
            repository = podcastRepository,
            scope = exportScope,
            offlineMode = { personal.settings().optBoolean("offlineMode") },
            httpProxy = { personal.settings().nullableString("httpProxy")?.trim()?.ifEmpty { null } },
            onStateChanged = { next -> _state.update { it.copy(podcast = next) } },
        )
    }
    private val resourceBadgesRepository: ResourceBadgesRepository by lazy {
        ResourceBadgesRepository(File(research, "PublishedLibrary"))
    }
    private val pdfAdmission: Mutex = Mutex()
    private val pdfCommittedResults: ConcurrentHashMap<String, JSONObject> = ConcurrentHashMap()
    private val pdfAcquisition: AtomicReference<Deferred<JSONObject>?> = AtomicReference(null)
    private val foregroundOwners: MutableSet<Any> = Collections.newSetFromMap(ConcurrentHashMap<Any, Boolean>())

    private val pendingControlRoot: File = File(context.noBackupFilesDir.canonicalFile, "PaperDigestTransfers/PendingExports")
    private val pendingStore: PendingExportStore by lazy {
        val output = File(context.noBackupFilesDir.canonicalFile, "PaperDigestTransfers/Exports")
        exportStoreFactory?.invoke(output, pendingControlRoot) ?: PendingExportStore(output, pendingControlRoot)
    }

    private val exportCoordinator: PendingExportCoordinator = PendingExportCoordinator(
        context = context,
        research = research,
        deviceRoot = deviceRoot,
        pendingControlRoot = pendingControlRoot,
        personal = personal,
        exports = exports,
        cloud = { cloud },
        capacity = { capacity },
        pendingStoreProvider = { pendingStore },
        scope = { exportScope },
        maintenance = { maintenance },
        active = active,
        currentEpoch = { dispatch.epoch },
        requireCurrentEpoch = dispatch::requireCurrent,
        currentState = { _state.value },
        requireReading = ::requireReading,
        requireReadingMaterials = ::requireReadingMaterials,
        selectedPaper = ::selected,
        currentPDF = ::currentPDF,
        onPublishPendingExports = { rows, error, loading ->
            _state.update { it.copy(pendingExports = rows, pendingExportsError = error, pendingExportsLoading = loading) }
        },
        onPublishRetainedConfirmation = { confirmation ->
            _state.update { it.copy(retainedExportConfirmation = confirmation) }
        },
        onNotice = { message -> _state.update { it.copy(notice = message) } },
        onRefresh = ::refresh,
    )

    private val zoteroCoordinator: ZoteroCoordinator = ZoteroCoordinator(
        personal = personal,
        offline = offline,
        cloudCredentialBorrowing = cloudCredentialBorrowing,
        maintenance = { maintenance },
        currentEpoch = { dispatch.epoch },
        requireCurrentEpoch = dispatch::requireCurrent,
        currentCloudBinding = { cloud.credentialBinding() },
        currentReadingToken = { readingID(_state.value) },
        prepareOfflineArticle = library::prepareOfflineArticle,
        downloadPDF = library::downloadPDF,
        pdfReceipt = library::pdfReceipt,
        buildMaterials = { paper, article, original, options, receipt ->
            exports.zoteroMaterials(paper, article, original, options, receipt)
        },
    )

    private val zotero: ZoteroService = ZoteroService(research, secrets, zoteroCoordinator.materialProvider())

    private suspend fun restoreWorkspace(staged: BackupCodec.Staged, admit: () -> Unit) = maintenance.withLock {
        admit()
        if (installBackground) cloudCoordinator.reconcileCloudTransfers()
        require(active.isEmpty()) { "请先结束当前任务再恢复完整资料" }
        require(personal.snapshot().getJSONArray("jobs").objects().none { it.optString("status") in listOf("queued", "running") }) {
            "请先停止或完成已排队的任务，再恢复研究资料"
        }
        val restoreContext = currentCoroutineContext()
        restoreContext.ensureActive()
        synchronized(workspaceAdmission) { workspacePhase = WorkspacePhase(true) }
        try {
            catalogCoordinator.withExclusiveArticleReadDrain {
                exportCoordinator.retireForWorkspaceRestore()
                podcastCoordinator.release()
                pdf.clearSessionPasswords()
                leaveAggregateView()
                aggregateBrowser.invalidatePreviews()
                cloudCredentialBorrowing.workspaceRestored()
                zoteroCoordinator.workspaceRestored(zotero)
                cloudCoordinator.clearNoteConflicts()

                var firstInitialization = true
                RestorePolicy.install(staged, research, initialize = {
                    val adopting = firstInitialization
                    firstInitialization = false
                    personal.reload()
                    if (adopting) personal.retireRestoredDispatch()
                    library.reload()
                    if (adopting) dispatch.rotate()
                }, check = { restoreContext.ensureActive() })
                studyCoordinator.workspaceRestored()
                catalogCoordinator.workspaceRestored()
                cloudCoordinator.clearNoteConflicts()
                offlineReading = null
                generation.incrementAndGet()
                _state.update {
                    it.copy(
                        selectedPaperId = null,
                        article = null,
                        pdfDocument = null,
                        pdfMode = false,
                        pdfSelection = null,
                        pdfPage = 1,
                        noteConflicts = emptyList(),
                        cachedDemoIds = emptySet(),
                    )
                }
                refresh(publishingRestore = true)
            }
        } finally {
            synchronized(workspaceAdmission) { workspacePhase = WorkspacePhase(false) }
        }
    }

    private val workspace: CloudWorkspace = object : CloudWorkspace {
        override suspend fun capture(output: File): BackupCodec.Captured = maintenance.withLock {
            require(!exportCoordinator.hasBlockingNonCloudTask()) { "请等当前资料任务结束再完整备份" }
            val captureContext = currentCoroutineContext()
            catalogCoordinator.withExclusiveArticleReadDrain {
                val snapshot = BackupCodec.capture(research, output) { captureContext.ensureActive() }
                val id = currentCoroutineContext()[CoroutineName]?.name
                if (id != null) {
                    personal.snapshot().getJSONArray("jobs").objects().firstOrNull { it.optString("id") == id }?.let { row ->
                        personal.upsertJob(
                            row.copy().put(
                                "material",
                                JSONObject()
                                    .put("kind", "完整研究快照")
                                    .put("createdAt", now())
                                    .put("fileCount", snapshot.fileCount)
                                    .put("sha256", snapshot.sha256)
                                    .put("encodedBytes", snapshot.encodedBytes)
                            )
                        )
                    }
                }
                snapshot
            }
        }

        override suspend fun restore(staged: BackupCodec.Staged) = restoreWorkspace(staged) {}
    }

    val cloud: CloudService = CloudService(
        research,
        File(context.noBackupFilesDir.canonicalFile, "PaperDigestCloud"),
        secrets,
        workspace,
        scheduleChanged = { scheduleCloud(it) },
        borrowing = cloudCredentialBorrowing,
    )

    private val cloudCoordinator: CloudSyncCoordinator = CloudSyncCoordinator(
        research = research,
        personal = personal,
        cloud = cloud,
        restores = restores,
        active = active,
        maintenance = { maintenance },
        currentEpoch = { dispatch.epoch },
        requireCurrentEpoch = dispatch::requireCurrent,
        reloadLibrary = library::reload,
        onRefresh = ::refresh,
        onNotice = { message -> _state.update { it.copy(notice = message) } },
        runTask = { kind, gate, body -> runTask(kind, gate = gate, body = body) },
        isPlatformCloudWorkFinished = { kind, workID ->
            val manager = WorkManager.getInstance(context)
            val work = if (kind == "cloud.upload" && workID != null) manager.getWorkInfoByIdFlow(workID).first() else null
            work == null || work.state.isFinished
        },
        enqueueCloudUploadWork = { id, destinationID, epoch ->
            val work = OneTimeWorkRequestBuilder<CloudTransferWorker>()
                .setId(id)
                .setInputData(workDataOf("destinationID" to destinationID, "workspaceEpoch" to epoch))
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).setRequiresStorageNotLow(true).build())
                .build()
            WorkManager.getInstance(context).enqueue(work).await()
        },
    )

    private val studyCoordinator: StudyCoordinator = StudyCoordinator(
        research = research,
        personal = personal,
        model = model,
        active = active,
        maintenance = { maintenance },
        currentEpoch = { dispatch.epoch },
        requireCurrentEpoch = dispatch::requireCurrent,
        currentState = { _state.value },
        currentReadingID = ::readingID,
        requireReading = ::requireReading,
        requireReadingMaterials = ::requireReadingMaterials,
        selectedPaper = ::selected,
        pdfOutline = { doc -> pdf.outline(doc) },
        pdfEvidence = { doc, from, to -> pdf.evidence(doc, from, to) },
        enqueueStudyWork = { sessionID, epoch ->
            val work = OneTimeWorkRequestBuilder<StudyWorker>()
                .setId(UUID.fromString(sessionID))
                .setInputData(workDataOf("sessionID" to sessionID, "workspaceEpoch" to epoch))
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .addTag("paperdigest-paid-study")
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("paperdigest-study-$sessionID", ExistingWorkPolicy.KEEP, work)
        },
        onRefresh = ::refresh,
    )

    private val pdfCoordinator: PdfOperationCoordinator = PdfOperationCoordinator(
        research = research,
        personal = personal,
        pdf = pdf,
        pdfAdmission = pdfAdmission,
        pdfAcquisition = pdfAcquisition,
        pdfCommittedResults = pdfCommittedResults,
        active = active,
        generation = generation,
        scope = { exportScope },
        maintenance = { maintenance },
        currentState = { _state.value },
        updateState = { transform -> _state.update(transform) },
        updateReading = { access, pdfRequired, transform -> updateReading(access, pdfRequired, transform) },
        requireCurrentEpoch = dispatch::requireCurrent,
        requireReading = ::requireReading,
        clearOfflineReading = { offlineReading = null },
        selectedPaper = ::selected,
        findPaper = ::paper,
        catalogPapers = library::papers,
        cachedPDFBySHA = library::cachedPDFBySHA,
        currentPDF = ::currentPDF,
        currentPDFReceipt = ::currentPDFReceipt,
        originalStudySession = studyCoordinator::originalStudySession,
        requireSavedStudySource = studyCoordinator::requireSavedStudySource,
        runTask = { kind, paperID, gate, parentJobID, itemIndex, taskID, body ->
            runTask(kind, paperID, gate, parentJobID, itemIndex, taskID, body)
        },
        onRefresh = ::refresh,
    )

    private val catalogPort: CatalogMaintenancePort = object : CatalogMaintenancePort {
        override fun summary(): JSONObject = library.summary()
        override suspend fun hasPublishedCatalogUpdate(): Boolean = library.hasPublishedCatalogUpdate()
        override suspend fun sync(onProgress: (Int, Int, String) -> Unit): JSONObject = library.sync(onProgress)
        override fun aggregateStamp(): AggregateCatalogStamp = library.aggregateStamp()
        override suspend fun aggregateCatalog(): PublishedAggregateCatalog? = library.aggregateCatalog()
        override suspend fun preloadAggregateDocument(
            id: String,
            expected: AggregateCatalogStamp,
            withCommitLock: suspend (() -> Unit) -> Unit,
        ) = library.preloadAggregateDocument(id, expected, withCommitLock)
        override fun papers(): List<Paper> = library.papers()
        override suspend fun preloadArticle(paper: Paper) {
            library.article(paper)
        }
    }

    private val catalogCoordinator: CatalogMaintenanceCoordinator = CatalogMaintenanceCoordinator(
        installBackground = installBackground,
        foregroundOwners = foregroundOwners,
        scope = { exportScope },
        maintenance = { maintenance },
        settings = personal::settings,
        library = catalogPort,
        hasActiveTasks = { active.isNotEmpty() },
        hasSelectedAggregate = { _state.value.aggregate.selected != null },
        readingGeneration = generation::get,
        pauseAggregatePreviews = { aggregateBrowser.pausePreviews() },
        resumeAggregatePreviews = { aggregateBrowser.resumePreviews() },
        enterAggregateBrowser = { aggregateBrowser.enter() },
        leaveAggregateBrowser = { aggregateBrowser.leave() },
        retireAggregateBrowser = { aggregateBrowser.retire() },
        executeAggregateBrowser = { command, payload, viewGuard, claimGuard ->
            aggregateBrowser.execute(command, payload, viewGuard, claimGuard)
        },
        runTask = { kind, body -> runTask(kind, body = body) },
        onCatalogCheckedAt = { checkedAt -> _state.update { it.copy(catalogCheckedAt = checkedAt) } },
        onNotice = { message -> _state.update { it.copy(notice = message) } },
        onRefresh = ::refresh,
        updatePeriodicSchedule = { settings ->
            val manager = WorkManager.getInstance(context)
            if (settings.offline) {
                manager.cancelUniqueWork("paperdigest-published-catalog")
            } else {
                val request = PeriodicWorkRequestBuilder<CatalogSyncWorker>(settings.hours, TimeUnit.HOURS)
                    .setConstraints(
                        Constraints.Builder()
                            .setRequiredNetworkType(NetworkType.CONNECTED)
                            .setRequiresBatteryNotLow(true)
                            .setRequiresStorageNotLow(true)
                            .build()
                    ).build()
                manager.enqueueUniquePeriodicWork("paperdigest-published-catalog", ExistingPeriodicWorkPolicy.UPDATE, request)
            }
        },
    )

    private val aggregateBrowser: AggregateBrowser by lazy {
        AggregateBrowser(
            object : AggregateBrowsePort {
                override fun stamp() = library.aggregateStamp()
                override suspend fun catalog() = maintenance.withLock { library.aggregateCatalog() }
                override suspend fun savedSelection(id: String) = maintenance.withLock { library.aggregateSavedSelection(id) }
                override suspend fun revisions(id: String) = maintenance.withLock { library.aggregateCachedRevisions(id) }
                override suspend fun read(id: String) = maintenance.withLock { library.aggregateDocument(id) }
                override suspend fun cached(id: String, sha: String) = maintenance.withLock { library.aggregateCachedDocument(id, sha) }
                override suspend fun images(id: String, rawHTMLSHA256: String, allowNetwork: Boolean): AggregateImageAccess? =
                    catalogCoordinator.trackAggregateImage {
                        maintenance.withLock { library.aggregateImages(id, rawHTMLSHA256, allowNetwork) }
                    }
                override suspend fun link(document: AggregateDocumentView, href: String) = maintenance.withLock { library.aggregateLink(document, href) }
                override fun offlineMode() = personal.settings().optBoolean("offlineMode")
                override fun readingEpoch() = generation.get()
                override fun mayPresent(readingEpoch: Long): Boolean {
                    val view = _state.value
                    return generation.get() == readingEpoch && view.selectedPaperId == null && view.viewedPaper == null && view.pdfDocument == null
                }
            },
            claimReading = { live ->
                pdfAdmission.withLock {
                    if (!live()) false else {
                        catalogCoordinator.drainArticleReadJobs()
                        pdfCoordinator.stopPdfAcquisition()
                        if (!live()) false else {
                            generation.incrementAndGet()
                            offlineReading = null
                            _state.update {
                                it.copy(
                                    selectedPaperId = null,
                                    viewedPaper = null,
                                    article = null,
                                    pdfDocument = null,
                                    pdfMode = false,
                                    pdfSelection = null,
                                    pdfReceipt = JSONObject(),
                                    readingMaterialID = "",
                                    loading = false,
                                    error = null,
                                )
                            }
                            true
                        }
                    }
                }
            },
            publish = { value -> _state.update { it.copy(aggregate = value) } },
            commitReading = { live, commit -> pdfAdmission.withLock { live() && commit() } },
            openLinkedPaper = { paper, live -> openPaper(paper.id, admissionGuard = live, expectedEpoch = dispatch.epoch) },
        )
    }

    init {
        cloudCredentialBorrowing.attachDrain { zotero.cancelAndDrainBorrowed() }
        refresh()
        if (installBackground) {
            CloudWorkerRuntime.install(
                { cloud },
                { service, expected -> runTask("cloud.automatic") { service.upload(automatic = true, expectedDestinationID = expected) } }
            )
            scheduleCloud(cloud.state())
            catalogCoordinator.scheduleCatalog()
            observeCatalogConnectivity()
        }
        exportScope.launch {
            try {
                exportCoordinator.reconcilePendingExports()
            } catch (_: Exception) {
                /* Independent pending-list error is already visible. */
            }
        }
    }

    private fun observeCatalogConnectivity() {
        val connectivity = context.getSystemService(ConnectivityManager::class.java) ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            private var validatedNetwork: Network? = null

            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                if (!capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) {
                    if (validatedNetwork == network) validatedNetwork = null
                    return
                }
                if (validatedNetwork == network) return
                validatedNetwork = network
                catalogCoordinator.onValidatedNetworkAvailable()
            }

            override fun onLost(network: Network) {
                if (validatedNetwork == network) validatedNetwork = null
            }
        }
        runCatching { connectivity.registerDefaultNetworkCallback(callback) }
        catalogCoordinator.startPeriodicProbeLoop()
    }

    override fun readingViewVisible(owner: Any, visible: Boolean) = catalogCoordinator.readingViewVisible(owner, visible)
    fun foregroundStarted(owner: Any) = catalogCoordinator.foregroundStarted(owner)
    fun foregroundStopped(owner: Any) = catalogCoordinator.foregroundStopped(owner)

    internal suspend fun performAutomaticCatalogSync(initialDelayMillis: Long = 0, registeredOwner: Job? = null): Boolean =
        catalogCoordinator.performAutomaticCatalogSync(initialDelayMillis, registeredOwner)

    override fun aggregateLinkIsCurrent(nonce: String, index: Int) = aggregateBrowser.linkIsCurrent(nonce, index)
    override fun captureAggregateView() = catalogCoordinator.captureAggregateView()
    override fun enterAggregateView() = catalogCoordinator.enterAggregateView()
    override fun leaveAggregateView() = catalogCoordinator.leaveAggregateView()
    override fun retireAggregateView() = catalogCoordinator.retireAggregateView()
    override suspend fun executeAggregateInView(command: String, payload: JSONObject, lease: AggregateViewLease): JSONObject =
        catalogCoordinator.executeAggregateInView(command, payload, lease)

    private fun refresh() = refresh(publishingRestore = false)

    private fun refresh(publishingRestore: Boolean) {
        val phase = workspacePhase
        if (phase.installing && !publishingRestore) return
        val viewEpoch = dispatch.epoch
        aggregateBrowser.observeNativeState()
        val p = personal.snapshot()
        val papers = library.papers()
        val zoteroView = zoteroCoordinator.zoteroPresentation(zotero, p)
        val conflicts = cloudCoordinator.noteConflictsSnapshot()
        _state.update {
            if (workspacePhase !== phase || dispatch.epoch != viewEpoch) return@update it
            val current = papers.firstOrNull { paper -> paper.id == it.selectedPaperId }
            val article = it.article?.let { old ->
                if (offlineReading == null && old.catalogEpoch != library.epoch()) {
                    old.copy(
                        isStale = true,
                        notices = (old.notices + "目录已重新同步，此导读仍是原保存版本，尚未重新核对网页修订。").distinct()
                    )
                } else old
            }
            val receipt = it.pdfReceipt.copy()
            if (offlineReading == null && current != null && current.sourceKind != "local" && it.pdfDocument != null &&
                (receipt.nullableString("version") != current.sourceVersion || receipt.nullableString("sourceURL") != current.pdfURL)
            ) {
                if (receipt.optString("currentness") == "study-input-bound-original") {
                    val originalVersion = receipt.nullableString("version")?.takeIf { v -> v.isNotBlank() }
                    val catalogVersion = current.sourceVersion?.takeIf { v -> v.isNotBlank() }
                    receipt.put("isStale", originalVersion != null && catalogVersion != null && originalVersion != catalogVersion)
                } else {
                    receipt.put("isStale", true).put("currentness", "catalog-source-changed")
                }
                val notices = receipt.optJSONArray("notices")?.strings().orEmpty()
                val mismatchNotice = if (receipt.optString("currentness") == "study-input-bound-original") {
                    "当前目录不能与此封存输入的版本和来源完全对应；仍按原输入 PDF SHA 读取，未自动替换。"
                } else {
                    "当前打开的是原保存 PDF；最新目录指向不同原文版本或来源，未自动替换。"
                }
                receipt.put("notices", JSONArray((notices + mismatchNotice).distinct()))
            }
            val viewed = offlineReading?.takeIf { old -> old.paper.id == it.selectedPaperId }?.paper
                ?: it.viewedPaper?.takeIf { old -> old.id == it.selectedPaperId }
                ?: current
            val reading = it.copy(
                papers = papers,
                websiteTaxonomy = library.websiteTaxonomy(),
                viewedPaper = viewed,
                article = article,
                pdfReceipt = receipt,
            )
            reading.copy(
                workspaceEpoch = viewEpoch,
                readingMaterialID = readingID(reading),
                personal = p,
                settings = p.getJSONObject("settings").copy(),
                jobs = exportCoordinator.mergedJobs(p.getJSONArray("jobs").objects()),
                sessions = p.getJSONArray("sessions").objects(),
                cloud = cloudCoordinator.cloudView(p),
                zotero = zotero.projectCredentialState(zoteroView),
                catalogSyncedAt = library.summary().nullableString("syncedAt"),
                catalogSummary = library.summary(),
                storageWarning = personal.startupPersistenceWarning,
                busy = active.isNotEmpty(),
                offlinePaperIDs = library.offlinePaperIDs(),
                noteConflicts = conflicts,
            )
        }
    }

    private fun paper(id: String): Paper =
        resolvePaperByCanonicalId(library.papers(), id) ?: throw AppFailure("missing", "论文不在已保存资料库中")

    private fun selected(): Paper =
        offlineReading?.takeIf { it.paper.id == _state.value.selectedPaperId }?.paper
            ?: _state.value.viewedPaper?.takeIf { it.id == _state.value.selectedPaperId }
            ?: paper(_state.value.selectedPaperId ?: throw AppFailure("missing", "请先选择论文"))

    private fun readingID(state: UiState): String {
        val owner = state.viewedPaper?.takeIf { it.id == state.selectedPaperId }
            ?: state.papers.firstOrNull { it.id == state.selectedPaperId }
            ?: return ""
        return ReadingSourceBinding.token(
            owner,
            state.article,
            state.pdfReceipt,
            dispatch.epoch,
            generation.get(),
            offlineReading?.takeIf { it.paper.id == owner.id }?.id
        )
    }

    private fun requireReadingMaterials(access: ReadingAccess) {
        requireReading(access)
        require(access.materialID.isNotEmpty() && readingID(_state.value) == access.materialID) {
            "阅读来源或修订已经变化，请重新准备当前材料"
        }
    }

    private fun freezeReading(access: ReadingAccess): ReadingRequest {
        requireReadingMaterials(access)
        val p = Paper.fromJson(selected().json())
        val article = _state.value.article?.let { a ->
            a.copy(
                citation = a.citation.copy(),
                researchContext = a.researchContext?.copy(),
                original = a.original?.copy(),
                resources = a.resources.toList(),
                inlineImages = a.inlineImages.toMap()
            )
        }
        ReadingSourceBinding.requireArticle(p, article)
        return ReadingRequest(
            p,
            article,
            offlineReading?.takeIf { it.paper.id == p.id },
            _state.value.pdfDocument,
            _state.value.pdfReceipt.copy(),
            access.materialID
        )
    }

    private fun requireReading(access: ReadingAccess, pdfRequired: Boolean = false) {
        require(access.owner != null && _state.value.selectedPaperId == access.owner && generation.get() == access.generation) {
            "论文已经切换，原操作没有取得新论文的材料或派发权限"
        }
        if (pdfRequired) {
            require(access.pdfSHA != null && _state.value.pdfDocument?.sha256 == access.pdfSHA) {
                "PDF 原件已经切换，未采用另一版本的页码或选区"
            }
        }
    }

    /** Only this controller can turn the actual open document into an output capability. */
    override suspend fun prepareOriginalPdfOutput(expectedReadingMaterialID: String): PdfOriginalSnapshot {
        val created = AtomicReference<PdfOriginalSnapshot?>(null)
        try {
            val delivered = withContext(Dispatchers.IO) {
                maintenance.withLock {
                    val current = _state.value
                    require(expectedReadingMaterialID.isNotBlank() && current.readingMaterialID == expectedReadingMaterialID) {
                        "阅读材料已变化，请按当前打开的原文重新准备"
                    }
                    val document = current.pdfDocument ?: throw AppFailure("missing", "请先打开要输出的原文 PDF")
                    val access = ReadingAccess(
                        current.selectedPaperId,
                        generation.get(),
                        document.sha256,
                        current.pdfSelection,
                        current.pdfPage,
                        expectedReadingMaterialID
                    )
                    requireReadingMaterials(access)
                    val owner = selected()
                    ReadingSourceBinding.requirePDF(owner, current.pdfReceipt, document.sha256)
                    val epoch = dispatch.epoch
                    val operation = currentCoroutineContext()
                    val check = {
                        dispatch.requireCurrent(epoch)
                        requireReading(access, pdfRequired = true)
                        require(_state.value.pdfDocument == document) { "打开的原文已变化，未输出另一份文件" }
                    }
                    check()
                    operation.ensureActive()
                    val snapshot = PdfOriginalSnapshot.prepare(context, pdf, document, owner.id, check)
                    created.set(snapshot)
                    try {
                        requireReadingMaterials(access)
                        ReadingSourceBinding.requirePDF(owner, _state.value.pdfReceipt, document.sha256)
                        check()
                        operation.ensureActive()
                        snapshot
                    } catch (failure: Throwable) {
                        snapshot.discardIfUnhanded()
                        throw failure
                    }
                }
            }
            created.compareAndSet(delivered, null)
            return delivered
        } catch (failure: Throwable) {
            try {
                created.getAndSet(null)?.discardIfUnhanded()
            } catch (cleanup: Throwable) {
                failure.addSuppressed(cleanup)
            }
            throw failure
        }
    }

    private fun updateReading(access: ReadingAccess, pdfRequired: Boolean = false, update: (UiState) -> UiState) {
        _state.update { current ->
            require(access.owner != null && current.selectedPaperId == access.owner && generation.get() == access.generation) {
                "论文已经切换，旧视图没有覆盖新阅读空间"
            }
            if (pdfRequired) {
                require(access.pdfSHA != null && current.pdfDocument?.sha256 == access.pdfSHA) {
                    "PDF 原件已经切换，旧页码没有覆盖新原件"
                }
            }
            update(current)
        }
    }

    override suspend fun execute(command: String, payload: JSONObject): JSONObject =
        executeForWorkspace(command, payload, null)

    override suspend fun executeInWorkspace(command: String, payload: JSONObject, expectedEpoch: String): JSONObject =
        executeForWorkspace(command, payload, expectedEpoch)

    private suspend fun executeForWorkspace(command: String, payload: JSONObject, expectedEpoch: String?): JSONObject {
        val passivePosition = command == "personal.reading" || command == "personal.studyScroll"
        val dispatchAtStart = try {
            workspaceActionEpoch(expectedEpoch)
        } catch (error: Exception) {
            if (passivePosition) return JSONObject().put("status", "not-adopted")
            throw error
        }
        if (command == "app.restore.commit" || command == "cloud.restore.commit") {
            cloudCoordinator.requireRestorePreparation(payload.getString("restoreID"), dispatchAtStart)
        }
        if (command in setOf("model.fresh.prepare", "model.fresh.check.prepare", "model.fresh.commit")) {
            studyCoordinator.requireReadyCredentials()
        }
        if (command in setOf("settings.save", "app.restore.commit", "cloud.restore.commit")) {
            catalogCoordinator.cancelPublishedPreload()
        }
        if (command.startsWith("aggregate.")) return executeAggregateInView(command, payload, captureAggregateView())
        val prioritized = catalogCoordinator.beginForegroundOperation(command)
        try {
            if (prioritized) withContext(Dispatchers.IO) { catalogCoordinator.giveForegroundPriority() }
            if (command == "library.search") {
                return withContext(Dispatchers.IO) { maintenance.withLock { library.searchCached(payload.getString("query")) } }
            }
            if (command == "library.resourceBadges") {
                return withContext(Dispatchers.IO) {
                    val force = payload.optBoolean("refresh", false)
                    val offline = personal.settings().optBoolean("offlineMode")
                    val loaded = resourceBadgesRepository.load(forceRefresh = force, offlineMode = offline)
                    dispatch.requireCurrent(dispatchAtStart)
                    _state.update { current ->
                        if (dispatch.epoch != dispatchAtStart) current
                        else current.copy(resourceBadges = loaded.papers, cachedDemoIds = loaded.cachedDemoIds)
                    }
                    JSONObject()
                        .put("available", loaded.available)
                        .put("count", loaded.papers.size)
                        .put("cachedDemoIds", JSONArray(loaded.cachedDemoIds.sorted()))
                }
            }
            if (command.startsWith("podcast.")) {
                return withContext(Dispatchers.IO) {
                    when (command) {
                        "podcast.feed" -> {
                            val force = payload.optBoolean("refresh", false)
                            val silent = payload.optBoolean("silent", false)
                            if (silent) {
                                try {
                                    podcastCoordinator.fetchFeed(forceRefresh = force, silent = true)
                                } catch (cancelled: CancellationException) {
                                    throw cancelled
                                } catch (_: Exception) {
                                    _state.value.podcast.json()
                                }
                            } else {
                                podcastCoordinator.fetchFeed(forceRefresh = force, silent = false)
                            }
                        }
                        "podcast.state" -> podcastCoordinator.state().json()
                        "podcast.play" -> {
                            val epId = if (payload.has("episodeId") && !payload.isNull("episodeId")) {
                                val raw = payload.opt("episodeId")
                                require(raw is String) { "播客节目编号无效。" }
                                raw.trim().ifEmpty { null }
                            } else null
                            val start = if (payload.has("startSeconds") && !payload.isNull("startSeconds")) {
                                val raw = payload.opt("startSeconds")
                                require(raw is Number && raw !is Boolean) { "播客起始播放时间无效。" }
                                val d = raw.toDouble()
                                require(d.isFinite() && d >= 0.0) { "播客起始播放时间无效。" }
                                d
                            } else null
                            podcastCoordinator.play(epId, start)
                        }
                        "podcast.pause" -> podcastCoordinator.pause()
                        "podcast.seek" -> {
                            val raw = payload.opt("seconds")
                            require(raw is Number && raw !is Boolean) { "播客跳转时间无效。" }
                            podcastCoordinator.seek(raw.toDouble())
                        }
                        "podcast.rate" -> {
                            val raw = payload.opt("rate")
                            require(raw is Number && raw !is Boolean) { "播客倍速无效。" }
                            podcastCoordinator.setRate(raw.toDouble().toFloat())
                        }
                        "podcast.download" -> {
                            val raw = if (payload.has("episodeId") && !payload.isNull("episodeId")) payload.opt("episodeId") else null
                            require(raw is String && raw.trim().isNotEmpty()) { "缺少要下载的播客节目编号。" }
                            podcastCoordinator.download(raw.trim())
                        }
                        "podcast.clearCache" -> podcastCoordinator.clearCache()
                        "podcast.stop" -> podcastCoordinator.stop()
                        else -> throw AppFailure("unsupported", "不支持的播客操作：$command")
                    }
                }
            }
            val current = _state.value
            val access = ReadingAccess(
                current.selectedPaperId,
                generation.get(),
                current.pdfDocument?.sha256,
                current.pdfSelection,
                current.pdfPage,
                readingID(current)
            )
            if (command == "app.restore.commit" || command == "cloud.restore.commit") {
                cloudCoordinator.requireRestorePreparation(payload.getString("restoreID"), dispatchAtStart)
            }
            val cloudMutation = when {
                command == "cloud.save" && cloud.credentialsTargetWouldChange(payload.getString("account"), payload.optString("folder", "PaperDigest")) ->
                    cloud.beginCredentialMutation()
                command in setOf("app.restore.commit", "cloud.restore.commit", "zotero.migration.revoke") ->
                    cloud.beginCredentialMutation()
                else -> null
            }
            if (cloudMutation != null) {
                zoteroCoordinator.retireBorrowedMigrationViews(zotero) { transform ->
                    _state.update { it.copy(zotero = transform(it.zotero)) }
                }
            }
            val pausePreviews = command in setOf("library.sync", "app.restore.commit", "cloud.restore.commit")
            if (pausePreviews) aggregateBrowser.pausePreviews()
            try {
                cloud.drainCredentialBorrowers(cloudMutation)
                return withContext(Dispatchers.IO) {
                    executeBound(command, payload.copy(), access, dispatchAtStart, cloudMutation)
                }
            } finally {
                cloud.endCredentialMutation(cloudMutation)
                if (pausePreviews) aggregateBrowser.resumePreviews()
            }
        } finally {
            if (prioritized) catalogCoordinator.finishForegroundOperation(command)
        }
    }

    private suspend fun executeBound(
        command: String,
        payload: JSONObject,
        access: ReadingAccess,
        dispatchAtStart: String,
        cloudMutation: CloudCredentialMutation? = null,
    ): JSONObject {
        try {
            _state.update { it.copy(error = null, notice = null) }
            val result = when (command) {
                "app.bootstrap" -> {
                    if (installBackground) maintenance.withLock { cloudCoordinator.reconcileCloudTransfers() }
                    refresh()
                    val z = zotero.execute("zotero.state", JSONObject())
                    _state.update { it.copy(zotero = zotero.projectCredentialState(z)) }
                    JSONObject().put("ready", true)
                }
                "library.sync" -> catalogCoordinator.executeManualLibrarySync(command)
                "paper.open" -> openPaper(payload.getString("paperID"), payload.optBoolean("refresh"), expectedEpoch = dispatchAtStart)
                "pdf.open" -> pdfCoordinator.openCurrentPaperPdf(command, access, dispatchAtStart)
                "pdf.close" -> pdfAdmission.withLock {
                    pdfCoordinator.stopPdfAcquisition()
                    updateReading(access) { it.copy(pdfMode = false, pdfSelection = null) }
                    JSONObject().put("closed", true)
                }
                "pdf.annotation.open" -> pdfCoordinator.ownedPdfAcquisition(command, access, dispatchAtStart) {
                    pdfCoordinator.openAnnotation(payload.getString("id"), access, dispatchAtStart)
                }
                "pdf.studySource.open" -> {
                    val binding = maintenance.withLock {
                        dispatch.requireCurrent(dispatchAtStart)
                        pdfCoordinator.requirePdfAcquisition(access, true)
                        val id = (payload.opt("sessionID") ?: payload.opt("id")) as? String ?: error("缺少原研究身份")
                        require(!payload.has("id") || payload.opt("id") == id) { "原研究身份不一致" }
                        studyCoordinator.requireSavedStudySource(id)
                    }
                    val page = positiveStudySourcePage(payload.opt("page")) ?: error("原研究页码无效")
                    require(page in binding.pages) { "页码不属于这次研究的原始输入" }
                    pdfCoordinator.ownedPdfAcquisition(command, access, dispatchAtStart, allowEmpty = true, ledgerOwner = binding.owner) {
                        pdfCoordinator.openStudySource(binding, page, access, dispatchAtStart)
                    }
                }
                "pdf.outline" -> maintenance.withLock {
                    requireReading(access, true)
                    val document = _state.value.pdfDocument ?: error("PDF 尚未打开")
                    val chapters = pdf.outline(document)
                    requireReading(access, true)
                    JSONObject().put("pdfSHA", document.sha256).put(
                        "chapters",
                        JSONArray(chapters.map { c ->
                            JSONObject().put("index", c.index).put("title", c.title)
                                .put("page", c.page).put("endPage", c.endPage).put("depth", c.depth)
                        })
                    )
                }
                "ui.pdfError" -> {
                    val message = payload.optString("message", "原文显示未完成").take(500)
                    _state.update { it.copy(error = message) }
                    JSONObject().put("reported", true)
                }
                "pdf.import" -> pdfCoordinator.ownedPdfAcquisition(command, access, dispatchAtStart) {
                    pdfCoordinator.importPdfOriginal(Uri.parse(payload.getString("uri")), access, dispatchAtStart)
                }
                "pdf.page" -> maintenance.withLock {
                    dispatch.requireCurrent(dispatchAtStart)
                    requireReading(access, true)
                    if (payload.has("paperID")) require(payload.getString("paperID") == access.owner) { "页码回调属于其他论文" }
                    if (payload.has("pdfSHA")) require(payload.getString("pdfSHA") == access.pdfSHA) { "页码回调属于其他版本原文" }
                    val d = _state.value.pdfDocument ?: error("PDF 尚未打开")
                    val page = payload.getInt("page")
                    require(page in 1..d.pageCount)
                    val owner = access.owner!!
                    val reading = personal.snapshot().getJSONObject("readingState").optJSONObject(owner)?.copy() ?: JSONObject()
                    personal.saveReading(owner, reading.put("pdfPage", page))
                    updateReading(access, true) { it.copy(pdfPage = page, pdfSelection = null) }
                    JSONObject().put("page", page)
                }
                "personal.setList" -> maintenance.withLock {
                    dispatch.requireCurrent(dispatchAtStart)
                    personal.setList(payload.getString("key"), payload.getJSONArray("ids").strings())
                    JSONObject().put("saved", true)
                }
                "personal.list.edit" -> maintenance.withLock {
                    dispatch.requireCurrent(dispatchAtStart)
                    personal.editList(payload.getString("key"), payload.getString("action"), FavoriteCollections.paperIDs(payload.getJSONArray("ids")))
                }
                "personal.favorite.edit" -> maintenance.withLock {
                    dispatch.requireCurrent(dispatchAtStart)
                    personal.editFavorites(payload)
                }
                "personal.note" -> cloudCoordinator.savePersonalNoteAndClearConflict(
                    payload.getString("paperID"),
                    payload.getString("text"),
                    payload.getInt("baseRevision"),
                    dispatchAtStart
                )
                "personal.reading" -> maintenance.withLock {
                    if (dispatch.epoch != dispatchAtStart) return@withLock JSONObject().put("status", "not-adopted")
                    val id = payload.getString("paperID")
                    val old = personal.snapshot().getJSONObject("readingState").optJSONObject(id)?.copy() ?: JSONObject()
                    listOf("question", "mode", "scope", "guideScroll", "from", "to", "split", "pdfOpen", "scroll", "fromPage", "toPage", "chapter").forEach {
                        if (payload.has(it)) old.put(it, payload.get(it))
                    }
                    personal.saveReading(id, old)
                    JSONObject().put("saved", true)
                }
                "personal.studyScroll" -> maintenance.withLock {
                    if (dispatch.epoch != dispatchAtStart) return@withLock JSONObject().put("status", "not-adopted")
                    val id = payload.getString("sessionID")
                    val original = personal.snapshot().getJSONArray("sessions").objects().filter { it.opt("id") == id }.singleOrNull()
                        ?: error("原研究不存在或身份重复，未保存另一条记录的位置")
                    val identity = requireNotNull(studyAnswerPositionIdentity(original)) { "原研究记录身份不足" }
                    val offset = payload.opt("scroll") as? Int ?: error("阅读位置无效")
                    val old = personal.snapshot().getJSONObject("readingState").optJSONObject(identity.owner)?.copy() ?: JSONObject()
                    personal.saveReading(identity.owner, mergedStudyAnswerScroll(old, original, payload.getString("binding"), offset))
                    JSONObject().put("saved", true)
                }
                "pdf.highlight" -> pdfCoordinator.highlight(payload, access, dispatchAtStart)
                "pdf.removeAnnotation" -> pdfCoordinator.annotationChange(payload, true, access, dispatchAtStart)
                "personal.annotationNote" -> pdfCoordinator.annotationChange(payload, false, access, dispatchAtStart)
                "storage.list" -> JSONObject().put("packages", JSONArray(offline.list()))
                "storage.capacity" -> maintenance.withLock { capacity.summary() }
                "storage.cleanup.prepare" -> maintenance.withLock { capacity.cleanupPrepare(exportCoordinator.exportDestinationVerifier) }
                "storage.cleanup.commit" -> maintenance.withLock { capacity.cleanupCommit(payload.getString("planID"), exportCoordinator.exportDestinationVerifier) }
                "storage.prepare" -> runTask(command, access.owner.orEmpty()) {
                    maintenance.withLock {
                        requireReading(access)
                        require(offlineReading == null) { "当前正在读取原离线快照，可直接打开；请从网站论文入口另存新版本" }
                        val p = selected()
                        val a = library.article(p)
                        val boundPaper = library.papers().firstOrNull { it.id == p.id } ?: p
                        ReadingSourceBinding.requireArticle(boundPaper, a)
                        val original = library.downloadPDF(boundPaper)
                        ReadingSourceBinding.requirePDF(boundPaper, library.pdfReceipt(boundPaper.id), original.second)
                        require(!library.pdfReceipt(boundPaper.id).optBoolean("isStale") && !a.isStale) { "原文或导读当前性尚未核验，未混装为当前离线包" }
                        requireReading(access)
                        offline.register(boundPaper, a, original.first)
                    }
                }
                "storage.openPackage" -> pdfAdmission.withLock {
                    pdfCoordinator.stopPdfAcquisition()
                    runTask(command) {
                        maintenance.withLock {
                            val operation = generation.incrementAndGet()
                            val opened = offline.open(payload.getString("id"))
                            require(generation.get() == operation) { "阅读上下文已经切换，离线包未覆盖新视图" }
                            personal.rememberPaper(opened.paper)
                            offlineReading = opened
                            _state.update { previous ->
                                require(generation.get() == operation)
                                previous.copy(
                                    selectedPaperId = opened.paper.id,
                                    viewedPaper = Paper.fromJson(opened.paper.json()),
                                    article = library.prepareOfflineArticle(opened.article),
                                    pdfMode = false,
                                    pdfDocument = null,
                                    pdfReceipt = JSONObject(),
                                    pdfSelection = null,
                                    pdfPage = 1,
                                )
                            }
                            JSONObject().put("opened", true).put("paperID", opened.paper.id).put("packageID", opened.id).put("offlineMode", true)
                        }
                    }
                }
                "model.fresh.prepare", "model.fresh.check.prepare" -> studyCoordinator.prepareFreshStudy(command, payload, access, dispatchAtStart)
                "model.fresh.commit" -> studyCoordinator.commitFreshStudy(payload)
                "model.fresh.discard" -> studyCoordinator.discardFreshStudy(payload.getString("confirmationID"))
                "model.run", "model.check" -> studyCoordinator.prepareStudy(command, payload, access)
                "model.recover" -> studyCoordinator.recoverSavedStudy(payload.getString("id"))
                "jobs.cancel" -> cancelJob(payload.getString("id"))
                "settings.save" -> maintenance.withLock {
                    val changes = payload.optJSONObject("changes") ?: payload
                    SettingsValidator.validate(changes, personal.settings())
                    personal.updateSettings(changes)
                    catalogCoordinator.scheduleCatalog()
                    JSONObject().put("saved", true)
                }
                "export.retained.stop" -> exportCoordinator.requestRetainExport(payload.getString("operationID"))
                "export.retained.confirm" -> exportCoordinator.confirmRetainExport(payload)
                "export.retained.confirm.discard" -> exportCoordinator.discardRetainConfirmation(payload)
                "export.retained.prepare" -> exportCoordinator.prepareRetainedDelivery(payload.getString("operationID"))
                "export.retained.delivery.validate" -> exportCoordinator.validateRetainedDelivery(payload.getString("operationID"), payload.getString("attemptID"))
                "export.retained.delivery.cancel" -> exportCoordinator.cancelRetainedDelivery(payload.getString("operationID"), payload.getString("attemptID"))
                "export.retained.save" -> exportCoordinator.saveRetainedExport(payload)
                "export.retained.history.reconcile" -> exportCoordinator.reconcileRetainedHistory(payload.getString("operationID"), payload.getString("attemptID"))
                "export.prepare", "retained.export.prepare" -> exportCoordinator.preparePendingExport(command, payload, access)
                "export.pending.list" -> exportCoordinator.reconcilePendingExports()
                "export.reconcile" -> exportCoordinator.reconcilePendingExports(payload.getString("operationID"))
                "export.delivery.prepare" -> exportCoordinator.beginExportDelivery(payload.getString("operationID"))
                "export.delivery.cancel" -> exportCoordinator.cancelExportDelivery(payload)
                "export.delivery.validate" -> exportCoordinator.validateExportDelivery(payload.getString("operationID"), payload.getString("attemptID"))
                "export.save" -> exportCoordinator.savePendingExport(payload)
                "app.restore.prepare" -> runTask(command, gate = { dispatch.requireCurrent(dispatchAtStart) }) {
                    val uri = Uri.parse(payload.getString("uri"))
                    require(uri.scheme == "content")
                    val operation = currentCoroutineContext()
                    val staged = context.contentResolver.openInputStream(uri)?.use {
                        BackupCodec.stage(it, research.parentFile!!) { operation.ensureActive() }
                    } ?: error("无法打开备份")
                    cloudCoordinator.restoreToken(staged, dispatchAtStart)
                }
                "app.restore.commit", "cloud.restore.commit" -> {
                    val id = payload.getString("restoreID")
                    val preparation = cloudCoordinator.requireRestorePreparation(id, dispatchAtStart)
                    restoreWorkspace(preparation.staged) {
                        dispatch.requireCurrent(dispatchAtStart)
                        dispatch.requireCurrent(preparation.workspaceEpoch)
                        require(restores[id] === preparation) { "恢复确认已失效，请重新选择备份" }
                    }
                    restores.remove(id, preparation)
                    JSONObject()
                        .put("restored", true)
                        .put("sha256", preparation.staged.encodedSHA256)
                        .put("message", "研究资料已恢复；本机连接和实际派发计数保留，恢复前副本仍在本机")
                }
                "restore.discard" -> cloudCoordinator.discardRestore(payload.getString("restoreID"))
                else -> when {
                    command.startsWith("cloud.") || command.startsWith("retained.") ->
                        cloudCoordinator.executeCloudCommand(command, payload, dispatchAtStart, cloudMutation)
                    command.startsWith("zotero.migration.") ->
                        zoteroCoordinator.executeMigrationCommand(
                            command,
                            payload,
                            zotero,
                            hasActiveTasks = { active.isNotEmpty() },
                            runTask = { kind, gate, body -> runTask(kind, gate = gate, body = body) },
                        )
                    command.startsWith("zotero.") ->
                        zoteroCoordinator.executeZoteroCommand(
                            command = command,
                            payload = payload,
                            materialID = access.materialID,
                            ownerPaperID = access.owner.orEmpty(),
                            zotero = zotero,
                            requireReadingMaterials = { requireReadingMaterials(access) },
                            freezeReading = { freezeReading(access) },
                            hasActiveTasks = { active.isNotEmpty() },
                            runTask = { kind, owner, gate, body -> runTask(kind, owner, gate = gate, body = body) },
                            publishProjectedZotero = { projected -> _state.update { it.copy(zotero = projected) } },
                        )
                    else -> throw AppFailure("unsupported", "这个操作尚不受支持：$command")
                }
            }
            refresh()
            return result
        } catch (cancelled: CancellationException) {
            refresh()
            if (!command.startsWith("export.retained.") && command !in setOf(
                    "app.bootstrap", "personal.reading", "paper.open", "export.prepare",
                    "retained.export.prepare", "export.save", "pdf.import", "pdf.open",
                    "pdf.annotation.open", "pdf.studySource.open"
                )
            ) {
                _state.update { it.copy(error = "已取消；已有完整资料和已产生的用量记录保留") }
            }
            throw cancelled
        } catch (error: Exception) {
            refresh()
            val message = when (error) {
                is AppFailure, is CloudFailure, is ZoteroDavFailure, is IllegalArgumentException, is IllegalStateException -> error.message ?: "操作未完成"
                else -> "操作未完成，原资料已保留；请检查连接、权限或所选文件"
            }
            _state.update { it.copy(error = message) }
            throw ZoteroTransportObservation.operationFailure(message, error)
        }
    }

    private suspend fun cancelJob(id: String): JSONObject {
        val pdfOwned = active.containsKey(id) && personal.snapshot().getJSONArray("jobs").objects().any {
            it.optString("id") == id && it.optString("kind") in setOf(
                "pdf.import", "pdf.import.batch", "pdf.open", "pdf.annotation.open", "pdf.studySource.open"
            )
        }
        return if (exportCoordinator.isOwnedExportJob(id) || pdfOwned) {
            _state.update { it.copy(notice = "已请求停止，正在等待本次文件操作关闭；原任务尚未报告停止。") }
            active[id]?.let { it.cancel(); it.join() }
            JSONObject()
                .put("cancelRequested", true)
                .put("drained", true)
                .put("message", "本次文件任务已结束；实际结果请查看原记录，已接纳或封存的原件保留。")
        } else {
            active[id]?.cancel()
            runCatching { WorkManager.getInstance(context).cancelWorkById(UUID.fromString(id)) }
            personal.session(id)?.let { session ->
                if (!session.optBoolean("requestIssued")) personal.appendSession(session.put("status", "cancelled"))
            }
            personal.snapshot().getJSONArray("jobs").objects()
                .firstOrNull { it.optString("id") == id && it.optString("status") == "queued" }
                ?.let {
                    personal.upsertJob(
                        it.copy().put("status", "cancelled").put("endedAt", now()).put("message", "已取消尚未发出的研究任务")
                    )
                }
            JSONObject().put("cancelRequested", true).put("message", "已请求停止；已发出的请求可能已经产生费用")
        }
    }

    private suspend fun openPaper(
        requestedId: String,
        refresh: Boolean = false,
        admissionGuard: (() -> Boolean)? = null,
        expectedEpoch: String = dispatch.epoch,
    ): JSONObject {
        if (dispatch.epoch != expectedEpoch) return JSONObject().put("status", "not-adopted")
        val p = paper(requestedId)
        val id = p.id
        if (admissionGuard == null) leaveAggregateView()
        val admissionView = catalogCoordinator.aggregateViewRevision.get()
        val ready = CompletableDeferred<Unit>()
        val captured = pdfAdmission.withLock {
            if (dispatch.epoch != expectedEpoch
                || catalogCoordinator.aggregateViewRevision.get() != admissionView
                || admissionGuard?.invoke() == false
            ) {
                return JSONObject().put("status", "not-adopted")
            }
            catalogCoordinator.drainArticleReadJobs()
            pdfCoordinator.stopPdfAcquisition()
            val canCommit: () -> Boolean = {
                dispatch.epoch == expectedEpoch
                    && !synchronized(workspaceAdmission) { workspacePhase.installing }
                    && catalogCoordinator.aggregateViewRevision.get() == admissionView
                    && admissionGuard?.invoke() != false
            }
            if (p.blogURL.isEmpty()) {
                val changed = catalogCoordinator.commitArticleReadAdmission(
                    producer = null,
                    canCommit = canCommit,
                ) {
                    if (admissionGuard != null) leaveAggregateView()
                    val next = generation.incrementAndGet()
                    offlineReading = null
                    _state.update {
                        it.copy(
                            selectedPaperId = id,
                            viewedPaper = Paper.fromJson(p.json()),
                            article = null,
                            pdfDocument = null,
                            pdfMode = false,
                            pdfSelection = null,
                            pdfReceipt = JSONObject(),
                            loading = false,
                        )
                    }
                    next
                } ?: return JSONObject().put("status", "not-adopted")
                ready.complete(Unit)
                changed
            } else {
                val expectedGeneration = AtomicLong(0L)
                val producer = exportScope.launch(start = CoroutineStart.LAZY) {
                    val changed = expectedGeneration.get()
                    fun publish(article: Article) {
                        val enriched = library.papers().firstOrNull { it.id == id }
                        _state.update { current ->
                            if (generation.get() != changed || current.selectedPaperId != id) current
                            else current.copy(
                                papers = if (enriched != null && enriched.original?.optBoolean("desktopDetailVerified") == true) {
                                    current.papers.map { if (it.id == id) enriched else it }
                                } else current.papers,
                                viewedPaper = if (enriched != null && enriched.original?.optBoolean("desktopDetailVerified") == true) {
                                    Paper.fromJson(enriched.json())
                                } else current.viewedPaper,
                                article = article,
                                loading = false,
                            ).let { it.copy(readingMaterialID = readingID(it)) }
                        }
                    }
                    try {
                        ensureActive()
                        if (generation.get() != changed) throw CancellationException("阅读入口已变化")
                        val article = library.article(p, refresh, onReadable = { value -> publish(value); ready.complete(Unit) })
                        publish(article)
                        ready.complete(Unit)
                    } catch (cancelled: CancellationException) {
                        ready.cancel(cancelled)
                    } catch (error: Exception) {
                        if (!ready.isCompleted) ready.completeExceptionally(error)
                        else _state.update {
                            if (generation.get() == changed && it.selectedPaperId == id) {
                                it.copy(notice = "导读补充未完成，已显示的内容仍可阅读。")
                            } else it
                        }
                    }
                }
                val changed = catalogCoordinator.commitArticleReadAdmission(
                    producer = producer,
                    canCommit = canCommit,
                ) {
                    if (admissionGuard != null) leaveAggregateView()
                    val next = generation.incrementAndGet()
                    expectedGeneration.set(next)
                    offlineReading = null
                    _state.update {
                        it.copy(
                            selectedPaperId = id,
                            viewedPaper = Paper.fromJson(p.json()),
                            article = null,
                            pdfDocument = null,
                            pdfMode = false,
                            pdfSelection = null,
                            pdfReceipt = JSONObject(),
                            loading = true,
                        )
                    }
                    next
                } ?: run {
                    producer.cancel()
                    ready.complete(Unit)
                    return JSONObject().put("status", "not-adopted")
                }
                producer.invokeOnCompletion { cause ->
                    if (!ready.isCompleted) when (cause) {
                        is CancellationException -> ready.cancel(cause)
                        null -> ready.completeExceptionally(IllegalStateException("尚未取得可读正文，请重新打开导读"))
                        else -> ready.completeExceptionally(cause)
                    }
                    _state.update { if (generation.get() == changed && it.selectedPaperId == id) it.copy(loading = false) else it }
                }
                producer.start()
                changed
            }
        }
        ready.await()
        if (captured != generation.get()) return JSONObject().put("status", "not-adopted")
        return (_state.value.viewedPaper?.takeIf { it.id == id } ?: library.papers().firstOrNull { it.id == id } ?: p).json()
    }

    private suspend fun currentPDF(p: Paper): Pair<File, String> {
        val old = offlineReading?.takeIf { it.paper.id == p.id }
        if (old == null) return library.downloadPDF(p)
        val verified = offline.open(old.id)
        val file = verified.pdfFile ?: throw AppFailure("missing", "此原离线快照没有包含 PDF；未自动换成网站另一版本")
        return file to BackupCodec.hash(file)
    }

    private fun currentPDFReceipt(p: Paper): JSONObject = offlineReading?.takeIf { it.paper.id == p.id }?.let { old ->
        JSONObject()
            .put("paperID", p.id)
            .put("sha256", old.pdfFile?.let(BackupCodec::hash) ?: "")
            .put("version", old.article.sourceVersion ?: JSONObject.NULL)
            .put("sourceURL", old.paper.pdfURL ?: "")
            .put("currentness", "offline-snapshot")
            .put("isStale", true)
            .put("notices", JSONArray(listOf("正在读取已封存的原离线快照；未联网核对网站当前修订。")))
    } ?: library.pdfReceipt(p.id)

    private suspend fun runTask(
        kind: String,
        paperID: String = "",
        gate: () -> Unit = {},
        parentJobID: String? = null,
        itemIndex: Int? = null,
        taskID: String = UUID.randomUUID().toString(),
        body: suspend () -> JSONObject,
    ): JSONObject {
        val id = taskID
        val job = currentCoroutineContext()[Job]!!
        val row = JSONObject()
            .put("id", id)
            .put("kind", kind)
            .put("paperID", paperID)
            .put("status", "running")
            .put("createdAt", now())
            .put("startedAt", now())
        if (parentJobID != null) {
            require(itemIndex != null && itemIndex >= 0)
            row.put("parentJobID", parentJobID).put("itemIndex", itemIndex).put("title", "导入所选 PDF（第 ${itemIndex + 1} 份）")
        }
        maintenance.withLock { gate(); personal.upsertJob(row); active[id] = job }
        refresh()
        try {
            val result = withContext(CoroutineName(id)) { body() }
            val latest = personal.snapshot().getJSONArray("jobs").objects().firstOrNull { it.optString("id") == id } ?: row
            if (kind == "pdf.import") latest.put("paperID", result.getString("paperID"))
            if (kind in setOf("pdf.import", "pdf.open", "pdf.annotation.open", "pdf.studySource.open")) latest.put("result", result.copy())
            val isPartial = result.optBoolean("partial")
            personal.upsertJob(
                latest.put("status", if (isPartial) "partial" else "completed").put("endedAt", now())
                    .put(
                        "message",
                        when {
                            isPartial -> result.optString("summary", "部分完成").ifBlank { "部分完成" }
                            kind.endsWith("restore.prepare") -> "完整材料校验完成，等待明确确认；尚未恢复研究资料"
                            else -> "已完成"
                        }
                    )
            )
            return result
        } catch (e: Exception) {
            val latest = personal.snapshot().getJSONArray("jobs").objects().firstOrNull { it.optString("id") == id } ?: row
            val committed = pdfCommittedResults.remove(id)
            if (e is CancellationException && committed != null) {
                if (kind == "pdf.import") latest.put("paperID", committed.getString("paperID"))
                personal.upsertJob(
                    latest.put("status", "completed").put("result", committed).put("endedAt", now())
                        .put("message", "原文已完成接纳并保留；返回窗口的等待被取消，没有删除已保存原件。")
                )
            } else {
                personal.upsertJob(
                    latest.put("status", if (e is CancellationException) "cancelled" else "failed")
                        .put("endedAt", now())
                        .put("message", if (e is CancellationException) "已停止，原材料保留" else "未完成，请查看对应设置或检查点")
                )
            }
            throw e
        } finally {
            pdfCommittedResults.remove(id)
            active.remove(id)
            refresh()
        }
    }

    suspend fun performStudy(id: String, workspaceEpoch: String) =
        studyCoordinator.performStudy(id, workspaceEpoch)

    suspend fun performCloudUpload(
        id: String,
        workspaceEpoch: String,
        expectedDestinationID: String,
        enterForeground: suspend () -> Unit = {},
    ) = cloudCoordinator.performCloudUpload(id, workspaceEpoch, expectedDestinationID, enterForeground)

    override suspend fun updateSecret(kind: SecretKind, value: String?) {
        val mutation = if (kind == SecretKind.MODEL) studyCoordinator.beginCredentialMutation() else null
        val cloudMutation = if (kind == SecretKind.CLOUD) cloud.beginCredentialMutation() else null
        if (cloudMutation != null) {
            zoteroCoordinator.retireBorrowedMigrationViews(zotero) { transform ->
                _state.update { it.copy(zotero = transform(it.zotero)) }
            }
        }
        val zoteroMutation = if (kind in setOf(SecretKind.ZOTERO, SecretKind.ZOTERO_DAV)) zotero.beginCredentialMutation() else null
        try {
            cloud.drainCredentialBorrowers(cloudMutation)
            if (zoteroMutation != null) {
                _state.update { current ->
                    current.copy(zotero = zotero.projectCredentialState(current.zotero).put("credentialState", "unknown").put("permissions", JSONObject.NULL))
                }
                zotero.cancelAndDrain()
            }
            withContext(Dispatchers.IO) {
                when (kind) {
                    SecretKind.CLOUD -> {
                        cloud.setPassword(value, cloudMutation)
                        if (value == null) cloudCoordinator.clearNoteConflicts()
                    }
                    SecretKind.MODEL -> maintenance.withLock {
                        val endpoint = if (value != null) StudyService.validatedConfig(personal.settings()).getString("endpoint") else ""
                        modelKeyBinding.clear()
                        if (value == null) secrets.remove("model.primary") else {
                            secrets.save("model.primary", value)
                            modelKeyBinding.bind(endpoint)
                        }
                    }
                    SecretKind.ZOTERO, SecretKind.ZOTERO_DAV -> zotero.withCredentialMutation(zoteroMutation!!) {
                        maintenance.withLock {
                            zotero.requireCredentialMutation(zoteroMutation)
                            val scope = if (kind == SecretKind.ZOTERO_DAV) zotero.webdavSecretScope() else "zotero.primary"
                            if (value == null) secrets.remove(scope) else secrets.save(scope, value)
                            zotero.credentialsChanged()
                            val z = zotero.state()
                            _state.update { it.copy(zotero = zotero.projectCredentialState(z)) }
                        }
                    }
                }
                refresh()
            }
        } finally {
            cloud.endCredentialMutation(cloudMutation)
            if (zoteroMutation != null) zotero.endCredentialMutation(zoteroMutation)
            if (mutation != null) studyCoordinator.endCredentialMutation(mutation)
        }
    }

    override fun importPdfs(uris: List<Uri>): Deferred<JSONObject> {
        val epoch = workspaceActionEpoch()
        return pdfCoordinator.importPdfs(uris, epoch)
    }

    override suspend fun unlockPdf(requestID: String, password: CharArray) {
        pdfCoordinator.unlockPdf(requestID, password)
    }

    override suspend fun cancelPdfUnlock(requestID: String) {
        pdfCoordinator.cancelPdfUnlock(requestID)
    }

    override suspend fun updatePdfSelection(selection: PdfSelection) {
        val d = _state.value.pdfDocument ?: return
        require(selection.documentSHA256 == d.sha256 && selection.pages.all { it in 1..d.pageCount } && selection.text.length <= 100000)
        _state.update { it.copy(pdfSelection = selection.takeIf { s -> s.text.isNotBlank() && s.pages.isNotEmpty() }) }
    }

    private fun scheduleCloud(profile: JSONObject) {
        if (!installBackground) return
        CloudScheduler.update(context, cloud.targetID, profile)
    }
}
