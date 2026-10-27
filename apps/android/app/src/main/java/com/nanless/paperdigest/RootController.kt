package com.nanless.paperdigest

import android.content.Context
import android.net.Uri
import androidx.work.*
import com.nanless.paperdigest.cloud.*
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.model.StudyService
import com.nanless.paperdigest.pdf.*
import com.nanless.paperdigest.secret.SecretVault
import com.nanless.paperdigest.secret.SecretStore
import com.nanless.paperdigest.ui.*
import com.nanless.paperdigest.zotero.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.TimeUnit

/** The Application owns one controller for UI and workers; maintenance never opens a second store. */
class RootController private constructor(private val context: Context, private val installBackground: Boolean,
    private val exportStoreFactory: ((File, File) -> PendingExportStore)?, secretStore: SecretStore?): AppController {
    internal constructor(context: Context, installBackground: Boolean = true, exportStoreFactory: ((File, File) -> PendingExportStore)? = null) :
        this(context, installBackground, exportStoreFactory, null)
    internal constructor(context: Context, installBackground: Boolean, secretStore: SecretStore) :
        this(context, installBackground, null, secretStore)
    private val research = RootResearchDirectory.resolve(context.noBackupFilesDir)
    val personal = PersonalStore(research)
    private val library = CatalogRepository(context, personal)
    private val offline = OfflineStore(research)
    @Volatile private var offlineReading: OfflineStore.Opened? = null
    private data class PreparedReading(val token: String, val paperID: String, val options: JSONObject, val roles: String)
    private data class ReadingRequest(val paper: Paper, val article: Article?, val offline: OfflineStore.Opened?, val document: PdfDocumentRef?, val receipt: JSONObject, val token: String) {
        @Volatile var authorization: PreparedReading? = null
    }
    private val readingRequests = ConcurrentHashMap<String, ReadingRequest>()
    private val preparedReadings = ConcurrentHashMap<String, PreparedReading>()
    private val pdf = PdfRepository(context, research)
    private val secrets: SecretStore = secretStore ?: SecretVault(context)
    private val modelKeyBinding = ModelKeyBinding(File(context.noBackupFilesDir.canonicalFile, "PaperDigestDevice"))
    private val model = StudyService(personal, { modelKeyBinding.requireEndpoint(personal.settings().getString("endpoint")); secrets.load("model.primary") })
    private val exports = ExportService(context, personal, model, library::publishedRecords, library::citationOriginal)
    private val capacity by lazy {
        val paths = RootResearchDirectory.capacityPaths(context.noBackupFilesDir)
        StorageCapacity(research, paths.first, paths.second, paths.third)
    }
    private val exportDestinationVerifier: ExportDestinationVerifier = { uri, sha, bytes -> verifyExportDestination(uri, sha, bytes) }
    private val maintenance = Mutex()
    private val dispatch = WorkspaceDispatch(File(context.noBackupFilesDir.canonicalFile, "PaperDigestDevice"))
    private val generation = AtomicLong(0)
    private val modelCredentialRevision = ModelCredentialRevision()
    private val freshStudies = FreshStudyGate<FreshStudyIntent>()
    private val active = ConcurrentHashMap<String, Job>()
    private val restores = ConcurrentHashMap<String, BackupCodec.Staged>()
    private val _state = MutableStateFlow(UiState())
    override val state: StateFlow<UiState> = _state
    /** Application lifetime work. A screen awaiting a result never owns the producer. */
    private val exportScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val pdfAdmission = Mutex()
    private val pdfBatchSequence = AtomicLong(0)
    private val pdfCommittedResults = ConcurrentHashMap<String, JSONObject>()
    private val pdfAcquisition = java.util.concurrent.atomic.AtomicReference<Deferred<JSONObject>?>(null)
    private val pdfUnlocks = PdfUnlockMailbox { prompt -> _state.update { it.copy(pdfUnlockPrompt = prompt) } }
    private val exportOwnedJobs = ConcurrentHashMap.newKeySet<String>()
    private val preservePreparationForRetain = ConcurrentHashMap.newKeySet<String>()
    private val nativeExportJobs = ConcurrentHashMap<String, JSONObject>()
    private val pendingControlRoot = File(context.noBackupFilesDir.canonicalFile, "PaperDigestTransfers/PendingExports")
    private val pendingStore: PendingExportStore by lazy {
        val output = File(context.noBackupFilesDir.canonicalFile, "PaperDigestTransfers/Exports")
        exportStoreFactory?.invoke(output, pendingControlRoot) ?: PendingExportStore(output, pendingControlRoot)
    }
    private data class ExportAttempt(val operationID: String, val attemptID: String, val epoch: String, val writerJobID: String? = null)
    private val exportAttempts = ConcurrentHashMap<String, ExportAttempt>()
    private val pendingExportViews = LinkedHashMap<String, JSONObject>() // Only under maintenance.
    private val retainedExports by lazy { RetainedExportService(pendingStore, pendingControlRoot, research,
        File(context.noBackupFilesDir.canonicalFile, "PaperDigestDevice"), { raw -> requireExportDestination(raw); Unit }) }
    private val retainedAccess = RetainedExportAccess({ pendingStore }, { retainedExports }, pendingControlRoot) { dispatch.epoch }

    private val workspace = object: CloudWorkspace {
        override suspend fun capture(output: File): BackupCodec.Captured = maintenance.withLock {
            require(active.keys.none { id -> (nativeExportJobs[id] ?: personal.snapshot().getJSONArray("jobs").objects().firstOrNull { it.optString("id") == id })?.optString("kind")?.startsWith("cloud.") != true }) { "请等当前资料任务结束再完整备份" }
            val captureContext = currentCoroutineContext()
            val snapshot = BackupCodec.capture(research, output) { captureContext.ensureActive() }
            val id = currentCoroutineContext()[CoroutineName]?.name
            if (id != null) personal.snapshot().getJSONArray("jobs").objects().firstOrNull { it.optString("id") == id }?.let { row ->
                personal.upsertJob(row.copy().put("material", JSONObject().put("kind", "完整研究快照").put("createdAt", now()).put("fileCount", snapshot.fileCount).put("sha256", snapshot.sha256).put("encodedBytes", snapshot.encodedBytes)))
            }
            snapshot
        }
        override suspend fun restore(staged: BackupCodec.Staged) = maintenance.withLock {
            require(active.isEmpty()) { "请先结束当前任务再恢复完整资料" }
            require(personal.snapshot().getJSONArray("jobs").objects().none { it.optString("status") in listOf("queued", "running") }) { "请先停止或完成已排队的任务，再恢复研究资料" }
            currentCoroutineContext().ensureActive()
            exportAttempts.clear()
            retainedAccess.retireAll(); retainedConfirmationClear()
            pdf.clearSessionPasswords()
            leaveAggregateView()
            dispatch.rotate();zotero.workspaceRestored();preparedReadings.clear()
            val restoreContext = currentCoroutineContext()
            RestorePolicy.install(staged, research, initialize = { personal.reload(); personal.retireRestoredDispatch(); library.reload() }, check = { restoreContext.ensureActive() })
            offlineReading = null
            generation.incrementAndGet()
            _state.update { it.copy(selectedPaperId = null, article = null, pdfDocument = null, pdfMode = false, pdfSelection = null, pdfPage = 1) }
            refresh()
        }
    }
    val cloud = CloudService(research, File(context.noBackupFilesDir.canonicalFile, "PaperDigestCloud"), secrets, workspace, scheduleChanged = { scheduleCloud(it) })
    private val aggregateViewRevision=AtomicLong(0)
    override fun captureAggregateView()=AggregateViewLease(aggregateViewRevision.get(),generation.get())
    override fun enterAggregateView(){aggregateViewRevision.incrementAndGet();aggregateBrowser.enter()}
    override fun leaveAggregateView(){aggregateViewRevision.incrementAndGet();aggregateBrowser.leave()}
    override fun retireAggregateView(){aggregateViewRevision.incrementAndGet();aggregateBrowser.retire()}
    override suspend fun executeAggregateInView(command:String,payload:JSONObject,lease:AggregateViewLease):JSONObject {
        if(captureAggregateView()!=lease)return JSONObject().put("status","not-adopted")
        val viewGuard={aggregateViewRevision.get()==lease.navigationEpoch}
        val claimGuard={generation.get()==lease.readingEpoch}
        if(command in setOf("aggregate.close","aggregate.back"))return aggregateBrowser.execute(command,payload.copy(),viewGuard,claimGuard)
        return withContext(Dispatchers.IO){val result=aggregateBrowser.execute(command,payload.copy(),viewGuard,claimGuard);refresh();result}
    }
    private val aggregateBrowser by lazy {
        AggregateBrowser(object:AggregateBrowsePort {
            override fun stamp()=library.aggregateStamp()
            override suspend fun catalog()=maintenance.withLock{library.aggregateCatalog()}
            override suspend fun revisions(id:String)=maintenance.withLock{library.aggregateCachedRevisions(id)}
            override suspend fun read(id:String)=maintenance.withLock{library.aggregateDocument(id)}
            override suspend fun cached(id:String,sha:String)=maintenance.withLock{library.aggregateCachedDocument(id,sha)}
            override fun offlineMode()=personal.settings().optBoolean("offlineMode")
            override fun readingEpoch()=generation.get()
            override fun mayPresent(readingEpoch:Long):Boolean {val view=_state.value;return generation.get()==readingEpoch&&view.selectedPaperId==null&&view.viewedPaper==null&&view.pdfDocument==null}
        },claimReading={live->
            pdfAdmission.withLock {
                if(!live())false else {
                    stopPdfAcquisition()
                    if(!live())false else {
                        generation.incrementAndGet();offlineReading=null
                        _state.update{it.copy(selectedPaperId=null,viewedPaper=null,article=null,pdfDocument=null,pdfMode=false,pdfSelection=null,pdfReceipt=JSONObject(),readingMaterialID="",loading=false,error=null)}
                        true
                    }
                }
            }
        },publish={value->_state.update{it.copy(aggregate=value)}},commitReading={live,commit->pdfAdmission.withLock{live()&&commit()}})
    }
    private val cloudSelections = CloudRestoreSelections(cloud) { CloudSelectionContext(cloud.targetID, dispatch.epoch) }
    private fun cloudView(): JSONObject = cloud.state().put("selectionContext", cloudSelections.contextToken())
    private val zotero = ZoteroService(research, secrets, ZoteroMaterialProvider { options ->
        maintenance.withLock {
            val bound = readingRequests[options.getString("readingRequestID")] ?: error("存档准备已失效，请重新核验当前阅读材料")
            require(readingID(_state.value) == bound.token) { "阅读材料已变化，未把新来源加入原准备请求" }
            val old = bound.offline?.let { offline.open(it.id) }
            val paper = bound.paper
            val article = bound.article?.let(library::prepareOfflineArticle)
            ReadingSourceBinding.requireArticle(paper, article)
            var receipt = bound.receipt.copy()
            val original = if (options.optBoolean("includePDF", true)) {
                if (old != null) {
                    old.pdfFile ?: error("此原离线快照没有包含 PDF，未自动换成网站另一版本")
                } else if (bound.document != null) {
                    val file = File(bound.document.localPath)
                    require(BackupCodec.hash(file) == bound.document.sha256) { "当前阅读的 PDF 原件已变化" }
                    ReadingSourceBinding.requirePDF(paper, receipt, bound.document.sha256)
                    file
                } else {
                    val saved = library.downloadPDF(paper)
                    receipt = library.pdfReceipt(paper.id)
                    ReadingSourceBinding.requirePDF(paper, receipt, saved.second)
                    saved.first
                }
            } else null
            require(readingID(_state.value) == bound.token) { "准备期间阅读材料已变化，原封存材料保留，请重新核验" }
            val materials = exports.zoteroMaterials(paper, article, original, options, receipt)
            bound.authorization = PreparedReading(bound.token, paper.id, options.copy(), ReadingSourceBinding.selectedRoleIdentity(personal.snapshot(), paper.id, options))
            materials
        }
    })
    init {
        if (installBackground) CloudWorkerRuntime.install({ cloud }, { service, expected -> runTask("cloud.automatic") { service.upload(automatic = true, expectedDestinationID = expected) } })
        refresh(); if (installBackground) { scheduleCloud(cloud.state()); scheduleCatalog() }
        exportScope.launch { try { reconcilePendingExports() } catch (_: Exception) { /* Independent pending-list error is already visible. */ } }
    }

    private fun refresh() {
        aggregateBrowser.observeNativeState()
        val p = personal.snapshot()
        val papers = library.papers()
        val zoteroView = zoteroPresentation(p)
        _state.update {
            val current = papers.firstOrNull { paper -> paper.id == it.selectedPaperId }
            val article = it.article?.let { old ->
                if (offlineReading == null && old.catalogEpoch != library.epoch()) old.copy(isStale = true, notices = (old.notices + "目录已重新同步，此导读仍是原保存版本，尚未重新核对网页修订。").distinct()) else old
            }
            val receipt = it.pdfReceipt.copy()
            if (offlineReading == null && current != null && current.sourceKind != "local" && it.pdfDocument != null &&
                (receipt.nullableString("version") != current.sourceVersion || receipt.nullableString("sourceURL") != current.pdfURL)) {
                receipt.put("isStale", true).put("currentness", "catalog-source-changed")
                val notices = receipt.optJSONArray("notices")?.strings().orEmpty()
                receipt.put("notices", JSONArray((notices + "当前打开的是原保存 PDF；最新目录指向不同原文版本或来源，未自动替换。").distinct()))
            }
            val viewed = offlineReading?.takeIf { old -> old.paper.id == it.selectedPaperId }?.paper ?: it.viewedPaper?.takeIf { old -> old.id == it.selectedPaperId } ?: current
            val reading = it.copy(papers = papers, viewedPaper = viewed, article = article, pdfReceipt = receipt)
            reading.copy(readingMaterialID = readingID(reading), personal = p, settings = p.getJSONObject("settings").copy(), jobs = mergedJobs(p.getJSONArray("jobs").objects()),
            sessions = p.getJSONArray("sessions").objects(), cloud = cloudView(), zotero = zotero.projectCredentialState(zoteroView), catalogSyncedAt = library.summary().nullableString("syncedAt"), catalogSummary = library.summary(), storageWarning = personal.startupPersistenceWarning, busy = active.isNotEmpty(), offlinePaperIDs = library.offlinePaperIDs()) }
    }
    private fun paper(id: String): Paper = library.papers().firstOrNull { it.id == id } ?: throw AppFailure("missing", "论文不在已保存资料库中")
    private fun selected(): Paper = offlineReading?.takeIf { it.paper.id == _state.value.selectedPaperId }?.paper ?: _state.value.viewedPaper?.takeIf { it.id == _state.value.selectedPaperId } ?: paper(_state.value.selectedPaperId ?: throw AppFailure("missing", "请先选择论文"))
    private fun zoteroPresentation(snapshot: JSONObject = personal.snapshot()): JSONObject = zotero.state().copy().also { state ->
        state.optJSONObject("prepared")?.let { preview ->
            val authorization = preparedReadings[preview.optString("preparedID")]
            preview.put("readingMaterialID", authorization?.token ?: JSONObject.NULL)
            val actual = if (authorization == null) null else try {
                ReadingSourceBinding.selectedRoleIdentity(snapshot, authorization.paperID, authorization.options)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { null }
            preview.put("materialsCurrent", authorization != null && actual != null && authorization.roles == actual)
            if (authorization != null && actual == null) preview.put("materialChangeMessage", "所选私人材料暂时无法完整核验，请分组后重新准备；原材料和断点保留。")
        }
    }
    private fun readingID(state: UiState): String {
        val owner = state.viewedPaper?.takeIf { it.id == state.selectedPaperId } ?: state.papers.firstOrNull { it.id == state.selectedPaperId } ?: return ""
        return ReadingSourceBinding.token(owner, state.article, state.pdfReceipt, dispatch.epoch, generation.get(), offlineReading?.takeIf { it.paper.id == owner.id }?.id)
    }
    private fun requireReadingMaterials(access: ReadingAccess) {
        requireReading(access)
        require(access.materialID.isNotEmpty() && readingID(_state.value) == access.materialID) { "阅读来源或修订已经变化，请重新准备当前材料" }
    }
    private fun freezeReading(access: ReadingAccess): ReadingRequest {
        requireReadingMaterials(access)
        val p = Paper.fromJson(selected().json())
        val article = _state.value.article?.let { a -> a.copy(citation = a.citation.copy(), researchContext = a.researchContext?.copy(), original = a.original?.copy(), resources = a.resources.toList(), inlineImages = a.inlineImages.toMap()) }
        ReadingSourceBinding.requireArticle(p, article)
        return ReadingRequest(p, article, offlineReading?.takeIf { it.paper.id == p.id }, _state.value.pdfDocument, _state.value.pdfReceipt.copy(), access.materialID)
    }

    private data class ReadingAccess(val owner: String?, val generation: Long, val pdfSHA: String?, val selection: PdfSelection?, val pdfPage: Int, val materialID: String)
    private data class FreshStudyIntent(val check: Boolean, val payload: JSONObject, val access: ReadingAccess, val epoch: String)
    private fun requireReading(access: ReadingAccess, pdfRequired: Boolean = false) {
        require(access.owner != null && _state.value.selectedPaperId == access.owner && generation.get() == access.generation) { "论文已经切换，原操作没有取得新论文的材料或派发权限" }
        if (pdfRequired) require(access.pdfSHA != null && _state.value.pdfDocument?.sha256 == access.pdfSHA) { "PDF 原件已经切换，未采用另一版本的页码或选区" }
    }
    /** Only this controller can turn the actual open document into an output capability. */
    override suspend fun prepareOriginalPdfOutput(expectedReadingMaterialID: String): PdfOriginalSnapshot {
        // Own a created capability across withContext's prompt-cancellation return boundary.
        // No caller Job is captured by the snapshot's long-lived source guard.
        val created = java.util.concurrent.atomic.AtomicReference<PdfOriginalSnapshot?>(null)
        try {
            val delivered = withContext(Dispatchers.IO) {
        maintenance.withLock {
            val current = _state.value
            require(expectedReadingMaterialID.isNotBlank() && current.readingMaterialID == expectedReadingMaterialID) {
                "阅读材料已变化，请按当前打开的原文重新准备"
            }
            val document = current.pdfDocument ?: throw AppFailure("missing", "请先打开要输出的原文 PDF")
            val access = ReadingAccess(current.selectedPaperId, generation.get(), document.sha256,
                current.pdfSelection, current.pdfPage, expectedReadingMaterialID)
            requireReadingMaterials(access)
            val owner = selected()
            ReadingSourceBinding.requirePDF(owner, current.pdfReceipt, document.sha256)
            val epoch = dispatch.epoch
            val operation = currentCoroutineContext()
            // Full source checks run at the boundaries. Streaming checks must not repeatedly
            // serialize the guide and all of its scientific images for every 64 KiB of PDF.
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
            try { created.getAndSet(null)?.discardIfUnhanded() }
            catch (cleanup: Throwable) { failure.addSuppressed(cleanup) }
            throw failure
        }
    }

    private fun updateReading(access: ReadingAccess, pdfRequired: Boolean = false, update: (UiState) -> UiState) {
        _state.update { current ->
            require(access.owner != null && current.selectedPaperId == access.owner && generation.get() == access.generation) { "论文已经切换，旧视图没有覆盖新阅读空间" }
            if (pdfRequired) require(access.pdfSHA != null && current.pdfDocument?.sha256 == access.pdfSHA) { "PDF 原件已经切换，旧页码没有覆盖新原件" }
            update(current)
        }
    }

    override suspend fun execute(command: String, payload: JSONObject): JSONObject {
        // A pending credential mutation must not wait behind maintenance and then silently acquire a new lease.
        if (command in setOf("model.fresh.prepare", "model.fresh.check.prepare", "model.fresh.commit")) modelCredentialRevision.ready()
        if(command.startsWith("aggregate."))return executeAggregateInView(command,payload,captureAggregateView())
        // A cancelled search must not reset reader drafts or turn into a global task error.
        if (command == "library.search") return withContext(Dispatchers.IO) { maintenance.withLock { library.searchCached(payload.getString("query")) } }
        val current = _state.value
        val access = ReadingAccess(current.selectedPaperId, generation.get(), current.pdfDocument?.sha256, current.pdfSelection, current.pdfPage, readingID(current))
        val dispatchAtStart = dispatch.epoch
        return withContext(Dispatchers.IO) { executeBound(command, payload.copy(), access, dispatchAtStart) }
    }
    private suspend fun executeBound(command: String, payload: JSONObject, access: ReadingAccess, dispatchAtStart: String): JSONObject {
        try {
            _state.update { it.copy(error = null, notice = null) }
            val result = when (command) {
                "app.bootstrap" -> { refresh(); val z = zotero.execute("zotero.state", JSONObject()); _state.update { it.copy(zotero = zotero.projectCredentialState(z)) }; JSONObject().put("ready", true) }
                "library.sync" -> runTask(command) { maintenance.withLock { library.sync { _, _, message -> _state.update { it.copy(notice = message) } } } }
                "paper.open" -> openPaper(payload.getString("paperID"), payload.optBoolean("refresh"))
                "pdf.open" -> ownedPdfAcquisition(command, access, dispatchAtStart) {
                    val prepared = maintenance.withLock {
                        requireReading(access); val owner = selected(); val original = currentPDF(owner)
                        Triple(owner, original, currentPDFReceipt(owner))
                    }
                    val operation = currentCoroutineContext()
                    val check = { operation.ensureActive(); dispatch.requireCurrent(dispatchAtStart); requireReading(access) }
                    val session = pdf.prepareFileImport(prepared.second.first, prepared.first.title + ".pdf", prepared.second.second, check)
                    val result = finishPdfSession(session, "open", check)
                    adoptPdfResult(result, check) { document ->
                        val page = personal.snapshot().getJSONObject("readingState").optJSONObject(prepared.first.id)?.optInt("pdfPage", 1)?.coerceIn(1, document.pageCount) ?: 1
                        updateReading(access) { it.copy(pdfDocument = document, pdfMode = true, pdfPage = page, pdfSelection = null, pdfReceipt = prepared.third) }
                        JSONObject().put("opened", true).put("pages", document.pageCount).put("sha256", document.sha256)
                    }
                }
                "pdf.close" -> pdfAdmission.withLock { stopPdfAcquisition(); updateReading(access) { it.copy(pdfMode = false, pdfSelection = null) }; JSONObject().put("closed", true) }
                "pdf.annotation.open" -> ownedPdfAcquisition(command, access, dispatchAtStart) { openAnnotation(payload.getString("id"), access, dispatchAtStart) }
                "pdf.outline" -> maintenance.withLock {
                    requireReading(access, true); val document = _state.value.pdfDocument ?: error("PDF 尚未打开")
                    val chapters = pdf.outline(document); requireReading(access, true)
                    JSONObject().put("pdfSHA", document.sha256).put("chapters", JSONArray(chapters.map { c -> JSONObject().put("index", c.index).put("title", c.title).put("page", c.page).put("endPage", c.endPage).put("depth", c.depth) }))
                }
                "ui.pdfError" -> { val message = payload.optString("message", "原文显示未完成").take(500); _state.update { it.copy(error = message) }; JSONObject().put("reported", true) }
                "pdf.import" -> ownedPdfAcquisition(command, access, dispatchAtStart) {
                    importPdfOriginal(Uri.parse(payload.getString("uri")), access, dispatchAtStart)
                }
                "pdf.page" -> {
                    maintenance.withLock {
                        requireReading(access, true)
                        if (payload.has("paperID")) require(payload.getString("paperID") == access.owner) { "页码回调属于其他论文" }
                        if (payload.has("pdfSHA")) require(payload.getString("pdfSHA") == access.pdfSHA) { "页码回调属于其他版本原文" }
                        val d = _state.value.pdfDocument ?: error("PDF 尚未打开"); val page = payload.getInt("page"); require(page in 1..d.pageCount)
                        val owner = access.owner!!; val reading = personal.snapshot().getJSONObject("readingState").optJSONObject(owner)?.copy() ?: JSONObject(); personal.saveReading(owner, reading.put("pdfPage", page))
                        updateReading(access, true) { it.copy(pdfPage = page, pdfSelection = null) }; JSONObject().put("page", page)
                    }
                }
                "personal.setList" -> maintenance.withLock { personal.setList(payload.getString("key"), payload.getJSONArray("ids").strings()); JSONObject().put("saved", true) }
                "personal.note" -> maintenance.withLock { personal.saveNote(payload.getString("paperID"), payload.getString("text"), payload.getInt("baseRevision")) }
                "personal.reading" -> maintenance.withLock {
                    val id = payload.getString("paperID"); val old = personal.snapshot().getJSONObject("readingState").optJSONObject(id)?.copy() ?: JSONObject()
                    listOf("question", "mode", "scope", "guideScroll", "from", "to", "split", "pdfOpen", "scroll", "fromPage", "toPage", "chapter").forEach { if (payload.has(it)) old.put(it, payload.get(it)) }; personal.saveReading(id, old); JSONObject().put("saved", true)
                }
                "pdf.highlight" -> highlight(payload, access)
                "pdf.removeAnnotation" -> annotationChange(payload, true, access)
                "personal.annotationNote" -> annotationChange(payload, false, access)
                "storage.list" -> JSONObject().put("packages", JSONArray(offline.list()))
                "storage.capacity" -> maintenance.withLock { capacity.summary() }
                "storage.cleanup.prepare" -> maintenance.withLock { capacity.cleanupPrepare(exportDestinationVerifier) }
                "storage.cleanup.commit" -> maintenance.withLock { capacity.cleanupCommit(payload.getString("planID"), exportDestinationVerifier) }
                "storage.prepare" -> runTask(command, access.owner.orEmpty()) { maintenance.withLock {
                    requireReading(access); require(offlineReading == null) { "当前正在读取原离线快照，可直接打开；请从网站论文入口另存新版本" }
                    val p = selected(); val a = library.article(p); ReadingSourceBinding.requireArticle(p, a); val original = library.downloadPDF(p)
                    ReadingSourceBinding.requirePDF(p, library.pdfReceipt(p.id), original.second)
                    require(!library.pdfReceipt(p.id).optBoolean("isStale") && !a.isStale) { "原文或导读当前性尚未核验，未混装为当前离线包" }
                    requireReading(access); offline.register(p, a, original.first)
                } }
                "storage.openPackage" -> pdfAdmission.withLock {
                    stopPdfAcquisition()
                    runTask(command) { maintenance.withLock {
                    val operation = generation.incrementAndGet(); val opened = offline.open(payload.getString("id"))
                    require(generation.get() == operation) { "阅读上下文已经切换，离线包未覆盖新视图" }
                    personal.rememberPaper(opened.paper); offlineReading = opened
                    _state.update { previous -> require(generation.get() == operation); previous.copy(selectedPaperId = opened.paper.id, viewedPaper = Paper.fromJson(opened.paper.json()), article = library.prepareOfflineArticle(opened.article), pdfMode = false, pdfDocument = null, pdfReceipt = JSONObject(), pdfSelection = null, pdfPage = 1) }
                    JSONObject().put("opened", true).put("paperID", opened.paper.id).put("packageID", opened.id).put("offlineMode", true)
                } } }
                "model.fresh.prepare", "model.fresh.check.prepare" -> prepareFreshStudy(command, payload, access, dispatchAtStart)
                "model.fresh.commit" -> commitFreshStudy(payload)
                "model.fresh.discard" -> maintenance.withLock { JSONObject().put("cancelled", freshStudies.discard(payload.getString("confirmationID"))) }
                "model.run", "model.check" -> prepareStudy(command, payload, access)
                "model.recover" -> maintenance.withLock {
                    require(active.isEmpty()) { "请待当前任务结束再核验原保存回答" }
                    val id = payload.getString("id")
                    val result = model.recoverSaved(id)
                    personal.snapshot().getJSONArray("jobs").objects().firstOrNull { it.optString("id") == id }?.let { original ->
                        personal.upsertJob(studyJob(original, result).put("status", "completed").put("endedAt", result.getString("endedAt")).put("message", "已核验原保存回答；未读取 API 密钥，未重新发出请求"))
                    }
                    result
                }
                "jobs.cancel" -> {
                    val id = payload.getString("id")
                    val pdfOwned = active.containsKey(id) && personal.snapshot().getJSONArray("jobs").objects().any { it.optString("id") == id && it.optString("kind") in setOf("pdf.import", "pdf.import.batch", "pdf.open", "pdf.annotation.open") }
                    if (id in exportOwnedJobs || pdfOwned) {
                        // A provider may be blocked inside an open/read/write call. No terminal state or lock release precedes actual drain.
                        _state.update { it.copy(notice = "已请求停止，正在等待本次文件操作关闭；原任务尚未报告停止。") }
                        active[id]?.let { it.cancel(); it.join() }
                        JSONObject().put("cancelRequested", true).put("drained", true)
                            .put("message", "本次文件任务已结束；实际结果请查看原记录，已接纳或封存的原件保留。")
                    } else {
                        active[id]?.cancel()
                        runCatching { WorkManager.getInstance(context).cancelWorkById(UUID.fromString(id)) }
                        personal.session(id)?.let { session -> if (!session.optBoolean("requestIssued")) personal.appendSession(session.put("status", "cancelled")) }
                        personal.snapshot().getJSONArray("jobs").objects().firstOrNull { it.optString("id") == id && it.optString("status") == "queued" }?.let { personal.upsertJob(it.copy().put("status", "cancelled").put("endedAt", now()).put("message", "已取消尚未发出的研究任务")) }
                        JSONObject().put("cancelRequested", true).put("message", "已请求停止；已发出的请求可能已经产生费用")
                    }
                }
                "settings.save" -> maintenance.withLock { val changes = payload.optJSONObject("changes") ?: payload; validateSettings(changes); personal.updateSettings(changes); scheduleCatalog(); JSONObject().put("saved", true) }
                "export.retained.stop" -> requestRetainExport(payload.getString("operationID"))
                "export.retained.confirm" -> confirmRetainExport(payload)
                "export.retained.confirm.discard" -> discardRetainConfirmation(payload)
                "export.retained.prepare" -> prepareRetainedDelivery(payload.getString("operationID"))
                "export.retained.delivery.validate" -> maintenance.withLock {
                    val lease = retainedAccess.lease(payload.getString("operationID"), payload.getString("attemptID"))
                    require(lease.writerJobID == null) { "原保存已开始，请等待实际写入结束" }
                    JSONObject().put("valid", true)
                }
                "export.retained.delivery.cancel" -> maintenance.withLock {
                    retainedAccess.cancelChooser(payload.getString("operationID"), payload.getString("attemptID")).also {
                        pendingView(pendingStore.get(payload.getString("operationID")))
                    }
                }
                "export.retained.save" -> saveRetainedExport(payload)
                "export.retained.history.reconcile" -> maintenance.withLock {
                    val op = payload.getString("operationID")
                    retainedExports.reconcileHistory(op, payload.getString("attemptID")).also { pendingView(pendingStore.get(op)) }
                }
                "export.prepare", "retained.export.prepare" -> preparePendingExport(command, payload, access)
                "export.pending.list" -> reconcilePendingExports()
                "export.reconcile" -> reconcilePendingExports(payload.getString("operationID"))
                "export.delivery.prepare" -> beginExportDelivery(payload.getString("operationID"))
                "export.delivery.cancel" -> cancelExportDelivery(payload)
                "export.delivery.validate" -> maintenance.withLock {
                    requireAttempt(payload.getString("operationID"), payload.getString("attemptID"))
                    JSONObject().put("valid", true)
                }
                "export.save" -> savePendingExport(payload)
                "app.restore.prepare" -> runTask(command) {
                    val uri = Uri.parse(payload.getString("uri")); require(uri.scheme == "content")
                    val operation = currentCoroutineContext()
                    val staged = context.contentResolver.openInputStream(uri)?.use { BackupCodec.stage(it, research.parentFile!!) { operation.ensureActive() } } ?: error("无法打开备份")
                    restoreToken(staged)
                }
                "app.restore.commit", "cloud.restore.commit" -> {
                    val id = payload.getString("restoreID"); val staged = restores[id] ?: error("恢复确认已失效，请重新选择备份")
                    workspace.restore(staged); restores.remove(id)
                    JSONObject().put("restored", true).put("sha256", staged.encodedSHA256).put("message", "研究资料已恢复；本机连接和实际派发计数保留，恢复前副本仍在本机")
                }
                "restore.discard" -> { restores.remove(payload.getString("restoreID"))?.directory?.deleteRecursively(); JSONObject().put("cancelled", true) }
                else -> when {
                    command.startsWith("cloud.") || command.startsWith("retained.") -> cloudCommand(command, payload)
                    command.startsWith("zotero.") -> {
                        val bound = payload.copy()
                        var handle: String? = null
                        if (command == "zotero.prepare") {
                            require(payload.optString("readingMaterialID") == access.materialID) { "前台阅读材料已变化，请按当前材料重新准备" }
                            val request = maintenance.withLock { freezeReading(access) }
                            handle = UUID.randomUUID().toString(); readingRequests[handle] = request
                            bound.put("paperID", request.paper.id).put("readingRequestID", handle)
                        }
                        var authorization: PreparedReading? = null
                        val result = try {
                            if (command == "zotero.archive") maintenance.withLock {
                                requireReadingMaterials(access)
                                require(payload.optString("readingMaterialID") == access.materialID) { "前台存档确认属于另一阅读材料，请重新准备" }
                                val confirmed = payload.getString("preparedID")
                                require(!payload.has("journalID") || payload.optString("journalID") == confirmed) { "存档确认不能指定另一原断点" }
                                bound.remove("journalID")
                                val original = preparedReadings[confirmed]
                                require(original != null && original.token == access.materialID) { "此预览属于另一阅读来源，请重新核验材料；原断点仍可在设置中明确续传" }
                                require(original.roles == ReadingSourceBinding.selectedRoleIdentity(personal.snapshot(), original.paperID, original.options)) { "所选笔记、标注或研究已经变化，请重新准备材料；原断点保留。" }
                            }
                            val actual = if (command != "zotero.state") runTask(command, access.owner.orEmpty(), gate = { require(active.isEmpty()) { "请等当前资料任务结束再操作 Zotero" } }) { zotero.execute(command, bound) } else zotero.execute(command, bound)
                            if (command == "zotero.prepare") authorization = handle?.let { readingRequests[it]?.authorization }
                            actual
                        } finally { handle?.let(readingRequests::remove) }
                        if (command == "zotero.prepare") {
                            requireReadingMaterials(access)
                            val original = authorization ?: error("准备材料未取得实际角色身份，请重新核验")
                            if (preparedReadings.size >= 64) preparedReadings.clear()
                            preparedReadings[result.getString("preparedID")] = original
                            result.put("readingMaterialID", access.materialID).put("materialsCurrent", original.roles == ReadingSourceBinding.selectedRoleIdentity(personal.snapshot(), original.paperID, original.options))
                        }
                        val z = zoteroPresentation()
                        _state.update { it.copy(zotero = zotero.projectCredentialState(z)) }; result
                    }
                    else -> throw AppFailure("unsupported", "这个操作尚不受支持：$command")
                }
            }
            refresh()
            return result
        } catch (cancelled: CancellationException) {
            refresh()
            if (!command.startsWith("export.retained.") && command !in setOf("export.prepare", "retained.export.prepare", "export.save", "pdf.import", "pdf.open", "pdf.annotation.open")) {
                _state.update { it.copy(error = "已取消；已有完整资料和已产生的用量记录保留") }
            }
            throw cancelled
        } catch (error: Exception) {
            refresh()
            val message = when (error) { is AppFailure, is CloudFailure, is IllegalArgumentException, is IllegalStateException -> error.message ?: "操作未完成"; else -> "操作未完成，原资料已保留；请检查连接、权限或所选文件" }
            _state.update { it.copy(error = message) }; throw AppFailure("operation", message)
        }
    }

    private suspend fun openPaper(id: String, refresh: Boolean = false): JSONObject {
        val p = paper(id)
        leaveAggregateView()
        val admissionView=aggregateViewRevision.get()
        val captured = pdfAdmission.withLock {
            if(aggregateViewRevision.get()!=admissionView)return JSONObject().put("status","not-adopted")
            stopPdfAcquisition()
            if(aggregateViewRevision.get()!=admissionView)return JSONObject().put("status","not-adopted")
            // Serialize a real source switch against a new native acquisition admission.
            val changed = generation.incrementAndGet()
            offlineReading = null
            _state.update { it.copy(selectedPaperId = id, viewedPaper = Paper.fromJson(p.json()), article = null, pdfDocument = null, pdfMode = false, pdfSelection = null, pdfReceipt = JSONObject(), loading = p.blogURL.isNotEmpty()) }
            changed
        }
        if (p.blogURL.isNotEmpty()) try {
            val a = maintenance.withLock { library.article(p, refresh) }
            if (captured == generation.get()) _state.update { it.copy(article = a, loading = false) }else return JSONObject().put("status","not-adopted")
        } catch (e: Exception) { if (captured != generation.get())return JSONObject().put("status","not-adopted");_state.update { it.copy(loading = false) }; throw e }
        return p.json()
    }
    private suspend fun currentPDF(p: Paper): Pair<File, String> {
        val old = offlineReading?.takeIf { it.paper.id == p.id }
        if (old == null) return library.downloadPDF(p)
        val verified = offline.open(old.id)
        val file = verified.pdfFile ?: throw AppFailure("missing", "此原离线快照没有包含 PDF；未自动换成网站另一版本")
        return file to BackupCodec.hash(file)
    }
    private fun currentPDFReceipt(p: Paper): JSONObject = offlineReading?.takeIf { it.paper.id == p.id }?.let { old ->
        JSONObject().put("paperID", p.id).put("sha256", old.pdfFile?.let(BackupCodec::hash) ?: "").put("version", old.article.sourceVersion ?: JSONObject.NULL)
            .put("sourceURL", old.paper.pdfURL ?: "").put("currentness", "offline-snapshot").put("isStale", true).put("notices", JSONArray(listOf("正在读取已封存的原离线快照；未联网核对网站当前修订。")))
    } ?: library.pdfReceipt(p.id)
    private suspend fun runTask(kind: String, paperID: String = "", gate: () -> Unit = {}, parentJobID: String? = null, itemIndex: Int? = null, taskID: String = UUID.randomUUID().toString(), body: suspend () -> JSONObject): JSONObject {
        val id = taskID; val job = currentCoroutineContext()[Job]!!
        val row = JSONObject().put("id", id).put("kind", kind).put("paperID", paperID).put("status", "running").put("createdAt", now()).put("startedAt", now())
        if (parentJobID != null) { require(itemIndex != null && itemIndex >= 0); row.put("parentJobID", parentJobID).put("itemIndex", itemIndex).put("title", "导入所选 PDF（第 ${itemIndex + 1} 份）") }
        maintenance.withLock { gate(); personal.upsertJob(row); active[id] = job }; refresh()
        try {
            val result = withContext(CoroutineName(id)) { body() }
            val latest = personal.snapshot().getJSONArray("jobs").objects().firstOrNull { it.optString("id") == id } ?: row
            if (kind == "pdf.import") latest.put("paperID", result.getString("paperID"))
            if (kind in setOf("pdf.import", "pdf.open", "pdf.annotation.open")) latest.put("result", result.copy())
            personal.upsertJob(latest.put("status", "completed").put("endedAt", now()).put("message", if (kind.endsWith("restore.prepare")) "完整材料校验完成，等待明确确认；尚未恢复研究资料" else "已完成"))
            return result
        }
        catch (e: Exception) {
            val latest = personal.snapshot().getJSONArray("jobs").objects().firstOrNull { it.optString("id") == id } ?: row
            val committed = pdfCommittedResults.remove(id)
            if (e is CancellationException && committed != null) {
                if (kind == "pdf.import") latest.put("paperID", committed.getString("paperID"))
                personal.upsertJob(latest.put("status", "completed").put("result", committed).put("endedAt", now())
                    .put("message", "原文已完成接纳并保留；返回窗口的等待被取消，没有删除已保存原件。"))
            } else personal.upsertJob(latest.put("status", if (e is CancellationException) "cancelled" else "failed").put("endedAt", now()).put("message", if (e is CancellationException) "已停止，原材料保留" else "未完成，请查看对应设置或检查点"))
            throw e
        }
        finally { pdfCommittedResults.remove(id); active.remove(id); refresh() }
    }
    private fun freshConfigIdentity(): String {
        val settings = personal.settings()
        return canonical(JSONObject().put("route", StudyService.validatedConfig(settings))
            .put("dailyRequests", settings.optInt("dailyRequests", 20).coerceIn(1, 1000)).put("offlineMode", settings.optBoolean("offlineMode")))
    }
    private fun freshStudyStamp(intent: FreshStudyIntent): FreshStudyStamp {
        dispatch.requireCurrent(intent.epoch)
        val current = _state.value
        val kind = intent.payload.optString("evidenceKind", "guide")
        if (!intent.check) {
            requireReadingMaterials(intent.access)
            requireReading(intent.access, kind != "guide")
            if (kind == "selection") require(intent.access.selection != null && current.pdfSelection == intent.access.selection) { "原文选区已变化，请重新确认。" }
            if (kind == "page") require(current.pdfPage == intent.access.pdfPage) { "原文物理页已变化，请重新确认。" }
        }
        return FreshStudyStamp(dispatch.epoch, modelCredentialRevision.ready(), if (intent.check) null else intent.access.owner,
            if (intent.check) "connection-check" else readingID(current), if (!intent.check && kind != "guide") current.pdfDocument?.sha256 else null,
            if (!intent.check && kind == "page") current.pdfPage else null, if (!intent.check && kind == "selection") current.pdfSelection else null,
            freshConfigIdentity(), canonical(intent.payload))
    }
    private suspend fun prepareFreshStudy(command: String, raw: JSONObject, access: ReadingAccess, expectedEpoch: String): JSONObject = maintenance.withLock {
        currentCoroutineContext().ensureActive()
        dispatch.requireCurrent(expectedEpoch)
        modelCredentialRevision.ready()
        val check = command == "model.fresh.check.prepare"
        require(raw.keys().asSequence().toSet().all { it in setOf("question", "evidenceKind", "fromPage", "toPage", "chapter", "readingMaterialID") }) { "确认参数无效，请重新准备。" }
        val payload = if (check) JSONObject().put("evidenceKind", "connection-check") else raw.copy().also {
            require(raw.getString("readingMaterialID").isNotBlank() && raw.getString("readingMaterialID") == access.materialID) { "阅读材料已变化，请重新准备。" }
            it.remove("readingMaterialID")
            val question = it.getString("question"); require(question.isNotBlank() && question.length <= 16000) { "请填写明确的研究问题。" }
            require(it.getString("evidenceKind") in listOf("guide", "selection", "page", "chapter", "range", "full")) { "请明确选择实际原文范围。" }
        }
        payload.put("force", true)
        val value = FreshStudyIntent(check, payload, access, expectedEpoch)
        val scope: String
        if (check) scope = "固定最小连接检查，不包含论文、笔记或选区。"
        else {
            requireReadingMaterials(access)
            val kind = payload.getString("evidenceKind")
            if (kind == "guide") {
                val article = _state.value.article ?: error("请先读取当前导读。")
                ReadingSourceBinding.requireArticle(selected(), article)
                scope = "当前导读文字与公式结构，不包含图像。"
            } else {
                requireReading(access, true)
                val doc = _state.value.pdfDocument ?: error("请先打开原文 PDF。")
                fun integer(key: String): Int { val n = payload.get(key); require(n is Number && n.toDouble().isFinite() && n.toDouble() == n.toInt().toDouble()) { "请填写实际物理页。" }; return n.toInt() }
                if (kind == "selection") {
                    val selection = access.selection ?: error("请先选择实际 PDF 文字。")
                    require(selection == _state.value.pdfSelection && selection.documentSHA256 == doc.sha256 && selection.text.isNotBlank())
                    require(selection.pages.isNotEmpty() && selection.pages.all { it in 1..doc.pageCount }) { "物理页范围无效。" }
                    scope = "原 PDF 当前选区，物理页 " + selection.pages.distinct().sorted().joinToString(", ") + " 的文字，不包含图像。"
                } else {
                    val range = when (kind) {
                        "page" -> access.pdfPage to access.pdfPage
                        "full" -> 1 to doc.pageCount
                        "chapter" -> { val entries = pdf.outline(doc); val index = integer("chapter"); require(index in entries.indices) { "请选择原 PDF 中实际存在的章节。" }; entries[index].page to entries[index].endPage }
                        else -> integer("fromPage") to integer("toPage")
                    }
                    require(range.first in 1..doc.pageCount && range.second in range.first..doc.pageCount) { "物理页范围无效。" }
                    scope = "原 PDF 物理页 ${range.first}–${range.second} 的文字，不包含图像。"
                }
            }
        }
        val stamp = freshStudyStamp(value)
        currentCoroutineContext().ensureActive()
        val intent = freshStudies.prepare(stamp, value)
        JSONObject().put("confirmationID", intent.id).put("kind", if (check) "connection-check" else "study")
            .put("draftIdentity", sha256(canonical(payload).toByteArray()))
            .put("question", if (check) "检查当前模型连接" else payload.getString("question")).put("scope", scope)
            .put("model", StudyService.validatedConfig(personal.settings()).getString("model"))
            .put("notice", "确认后将另建一次请求并可能产生费用；原研究记录、原回答和已产生用量保留。")
    }
    private suspend fun commitFreshStudy(payload: JSONObject): JSONObject = maintenance.withLock {
        val id = payload.getString("confirmationID")
        val intent = freshStudies.peek(id)
        try {
            val operation = currentCoroutineContext()
            val currentStamp = freshStudyStamp(intent.value)
            require(payload.getString("draftIdentity") == sha256(canonical(intent.value.payload).toByteArray())) { "问题或范围已变化，请重新确认。" }
            val confirmed = freshStudies.consume(id, currentStamp)
            prepareStudyLocked(if (confirmed.value.check) "model.check" else "model.run", confirmed.value.payload.copy(), confirmed.value.access) {
                operation.ensureActive()
                require(freshStudyStamp(confirmed.value) == confirmed.stamp) { "研究材料或模型连接已变化，请重新确认。" }
            }
        } catch (failure: Throwable) {
            freshStudies.discard(id)
            throw failure
        }
    }
    private suspend fun prepareStudy(command: String, payload: JSONObject, access: ReadingAccess): JSONObject = maintenance.withLock {
        prepareStudyLocked(command, payload, access)
    }
    private suspend fun prepareStudyLocked(command: String, payload: JSONObject, access: ReadingAccess, extraGuard: () -> Unit = {}): JSONObject {
        extraGuard()
        if (command != "model.check") requireReading(access, payload.optString("evidenceKind", "guide") != "guide")
        val evidenceKind = payload.optString("evidenceKind", "guide")
        if (command != "model.check" && evidenceKind == "selection") require(access.selection != null && _state.value.pdfSelection == access.selection) { "原文选区已经变化，旧问题没有采用另一段文字" }
        if (command != "model.check" && evidenceKind == "page") require(_state.value.pdfPage == access.pdfPage) { "原文物理页已经变化，旧问题没有采用另一页" }
        val p = if (command == "model.check") null else selected()
        val source = JSONObject().put("paperID", p?.id ?: "configuration-check").put("sourceVersion", p?.sourceVersion ?: "").put("sourceURL", p?.sourceURL ?: p?.blogURL ?: "")
        val evidence: String
        if (p == null) { evidence = "这是一项最小连接检查，不包含论文或私人资料。"; source.put("kind", "connection-check").put("extractor", "fixed-check-v1") }
        else {
            when (val kind = payload.optString("evidenceKind", "guide")) {
                "guide" -> { val a = _state.value.article; require(a != null && a.paperID == p.id) { "请先读取当前导读" }; ReadingSourceBinding.requireArticle(p, a); evidence = if (a.markdown != null || a.html.isBlank()) a.plainText else CatalogRepository.articlePlainText(org.jsoup.Jsoup.parseBodyFragment(a.html).body()); source.put("sourceVersion", a.sourceVersion ?: "").put("sourceURL", a.sourceURL).put("kind", "published-guide").put("revision", a.revisionSHA256).put("isStale", a.isStale).put("includesImages", false).put("notices", JSONArray(a.notices + "本次仅采用导读文字与公式结构，不包含科学图的像素内容。" )).put("extractor", if (a.markdown != null) "published-markdown-v1" else a.mathMLContract ?: "legacy-published-html-unverified") }
                "selection" -> { val selection = access.selection ?: error("请先在 PDF 中选择实际文字"); val d = _state.value.pdfDocument ?: error("PDF 尚未打开"); require(selection.documentSHA256 == d.sha256 && selection.text.isNotBlank()); evidence = selection.text; source.put("kind", "pdf-selection").put("pages", JSONArray(selection.pages)).put("pdfSHA", d.sha256).put("extractor", selection.extractor) }
                "page", "range", "full", "chapter" -> {
                    val d = _state.value.pdfDocument ?: error("请先打开 PDF")
                    val chapter = if (kind == "chapter") { val entries = pdf.outline(d); val index = payload.getInt("chapter"); require(index in entries.indices) { "请选择原 PDF 中实际存在的目录章节；没有目录时请使用页段" }; entries[index] } else null
                    val from = when (kind) { "full" -> 1; "page" -> access.pdfPage; "chapter" -> chapter!!.page; else -> payload.getInt("fromPage") }
                    val to = when (kind) { "full" -> d.pageCount; "page" -> from; "chapter" -> chapter!!.endPage; else -> payload.getInt("toPage") }
                    val e = pdf.evidence(d, from, to); require(e.missingTextPages.size < e.pages.size) { "这些页面没有可提取文字，不能将空文本当完整论文分析" }
                    evidence = e.text; source.put("kind", e.kind).put("pages", JSONArray(e.pages)).put("missingTextPages", JSONArray(e.missingTextPages)).put("allPagesHaveExtractableText", e.missingTextPages.isEmpty()).put("includesImages", false).put("textExtractionNotice", "本次为原PDF文字提取，不含图像；部分数学字体或版面可能无法完整映射，请核对原PDF。").put("pdfSHA", d.sha256).put("extractor", "android-pdfbox-physical-pages-v1")
                    chapter?.let { source.put("kind", "pdf-chapter").put("chapter", it.index).put("chapterTitle", it.title) }
                }
                else -> error("证据范围尚不支持")
            }
            if (payload.optString("evidenceKind", "guide") != "guide") {
                val actual = _state.value.pdfReceipt
                require(actual.optString("paperID", p.id) == p.id && actual.optString("sha256") == _state.value.pdfDocument?.sha256) { "PDF 来源回执与实际已开原件不符" }
                source.put("sourceVersion", actual.nullableString("version") ?: "").put("sourceURL", actual.optString("sourceURL"))
                    .put("isStale", actual.optBoolean("isStale")).put("currentness", actual.optString("currentness", "unknown")).put("notices", actual.optJSONArray("notices") ?: JSONArray())
                source.put("includesImages", false).put("textExtractionNotice", "本次为PDF实际文字，不含图像；数学字体与版面提取可能存在局限，请核对原件。")
            }
        }
        if (command != "model.check") requireReading(access, payload.optString("evidenceKind", "guide") != "guide")
        if (command != "model.check" && evidenceKind == "selection") require(_state.value.pdfSelection == access.selection) { "提取期间选区已经变化，未派发请求" }
        if (command != "model.check" && evidenceKind == "page") require(_state.value.pdfPage == access.pdfPage) { "提取期间物理页已经变化，未派发请求" }
        extraGuard()
        val prepared = model.prepare(p?.id ?: "configuration-check", if (command == "model.check") "请只回复连接成功。" else payload.getString("question"), evidence, source, payload.optBoolean("force"))
        try {
            if (command != "model.check") requireReading(access, payload.optString("evidenceKind", "guide") != "guide")
            extraGuard()
        } catch (e: Exception) {
            if (!prepared.optBoolean("reused")) personal.appendSession(prepared.copy().put("status", "cancelled").put("error", if (command == "model.check") "准备期间模型连接变化，未派发请求" else "准备期间阅读上下文变化，未派发请求"))
            throw e
        }
        if (prepared.optBoolean("reused")) return prepared
        val id = prepared.getString("id"); val work = OneTimeWorkRequestBuilder<StudyWorker>().setId(UUID.fromString(id)).setInputData(workDataOf("sessionID" to id, "workspaceEpoch" to dispatch.epoch)).setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).addTag("paperdigest-paid-study").build()
        personal.upsertJob(JSONObject().put("id", id).put("kind", command).put("paperID", p?.id.orEmpty()).put("status", "queued").put("createdAt", now()).put("message", "等待系统执行；未发出的请求不会产生模型用量"))
        WorkManager.getInstance(context).enqueueUniqueWork("paperdigest-study-$id", ExistingWorkPolicy.KEEP, work)
        return prepared.put("queued", true)
    }
    suspend fun performStudy(id: String, workspaceEpoch: String) {
        val job = currentCoroutineContext()[Job]!!
        val row = maintenance.withLock {
            dispatch.requireCurrent(workspaceEpoch)
            val original = personal.snapshot().getJSONArray("jobs").objects().firstOrNull { it.optString("id") == id }?.copy() ?: error("原研究调度不存在")
            personal.upsertJob(original.put("status", "running").put("startedAt", now())); active[id] = job; original
        }
        try { refresh(); val result = maintenance.withLock { model.run(id) }; personal.upsertJob(studyJob(row, result).put("status", "completed").put("endedAt", now()).put("message", "研究已完成，原始输入、回答和用量已保存")) }
        catch (e: Exception) { personal.upsertJob(studyJob(row, personal.session(id)).put("status", if (e is CancellationException) "cancelled" else "failed").put("endedAt", now()).put("message", "研究未完成；可能已有实际消费，请检查记录，未自动重发")); throw e }
        finally { active.remove(id); refresh() }
    }
    suspend fun performCloudUpload(id: String, workspaceEpoch: String, expectedDestinationID: String) {
        val job = currentCoroutineContext()[Job]!!
        val row = maintenance.withLock {
            dispatch.requireCurrent(workspaceEpoch)
            val original = personal.snapshot().getJSONArray("jobs").objects().firstOrNull { it.optString("id") == id }?.copy() ?: error("备份任务不存在")
            personal.upsertJob(original.put("status", "running").put("startedAt", now())); active[id] = job; original
        }
        try {
            refresh()
            withContext(CoroutineName(id)) { cloud.upload(expectedDestinationID = expectedDestinationID) }
            val latest = personal.snapshot().getJSONArray("jobs").objects().firstOrNull { it.optString("id") == id } ?: row
            personal.upsertJob(latest.put("status", "completed").put("endedAt", now()).put("message", "原快照所有分块及完成清单已回读核验"))
        } catch (e: Exception) { val latest = personal.snapshot().getJSONArray("jobs").objects().firstOrNull { it.optString("id") == id } ?: row; personal.upsertJob(latest.put("status", if (e is CancellationException) "cancelled" else "failed").put("endedAt", now()).put("message", if (e is CloudFailure && e.code == "targetChanged") e.message else "备份未完成；已有原快照和检查点保留，请核对后续传")); throw e }
        finally { active.remove(id); refresh() }
    }
    private fun studyJob(job: JSONObject, session: JSONObject?): JSONObject {
        if (session == null) return job
        val result = job.copy()
        listOf("usage", "actualModel", "model", "requestIssued", "charge", "costKnown").forEach { if (session.has(it)) result.put(it, session.get(it)) }
        result.put("material", JSONObject().put("kind", session.optJSONObject("source")?.optString("kind") ?: "研究输入").put("createdAt", session.optString("createdAt")).put("sha256", session.optString("inputSHA256")))
        return result
    }
    override suspend fun updateSecret(kind: SecretKind, value: String?) {
        val mutation = if (kind == SecretKind.MODEL) modelCredentialRevision.begin().also { freshStudies.invalidate() } else null
        val zoteroMutation = if (kind in setOf(SecretKind.ZOTERO, SecretKind.ZOTERO_DAV)) zotero.beginCredentialMutation() else null
        try {
            if (zoteroMutation != null) _state.update { current -> current.copy(zotero = current.zotero.copy().put("credentialState", "unknown").put("permissions", JSONObject.NULL)) }
            if (zoteroMutation != null) zotero.cancelAndDrain() // Never hold maintenance while waiting for real transport cleanup.
            withContext(Dispatchers.IO) {
        when(kind) {
            SecretKind.CLOUD -> cloud.setPassword(value)
            SecretKind.MODEL -> maintenance.withLock {
                val endpoint = if (value != null) StudyService.validatedConfig(personal.settings()).getString("endpoint") else ""
                modelKeyBinding.clear()
                if (value == null) secrets.remove("model.primary") else { secrets.save("model.primary", value); modelKeyBinding.bind(endpoint) }
            }
            SecretKind.ZOTERO, SecretKind.ZOTERO_DAV -> zotero.withCredentialMutation(zoteroMutation!!) {
                maintenance.withLock {
                    zotero.requireCredentialMutation(zoteroMutation)
                    val scope = if(kind == SecretKind.ZOTERO_DAV) zotero.webdavSecretScope() else "zotero.primary"
                    if (value == null) secrets.remove(scope) else secrets.save(scope, value)
                    zotero.credentialsChanged()
                    val z = zotero.state();_state.update { it.copy(zotero = zotero.projectCredentialState(z)) }
                }
            }
        }

        refresh()
            }
        } finally {
            if (zoteroMutation != null) zotero.endCredentialMutation(zoteroMutation)
            if (mutation != null) modelCredentialRevision.end(mutation)
        }
    }
    override fun importPdfs(uris: List<Uri>): Deferred<JSONObject> {
        val selectedUris = uris.toList() // Synchronous picker handoff; no Activity/Compose scope owns this copy.
        require(selectedUris.isNotEmpty() && selectedUris.all { it.scheme == "content" }) { "请通过系统文件选择器选择 PDF" }
        val current = _state.value
        val initial = ReadingAccess(current.selectedPaperId, generation.get(), current.pdfDocument?.sha256,
            current.pdfSelection, current.pdfPage, current.readingMaterialID)
        val epoch = dispatch.epoch
        val ticket = pdfBatchSequence.incrementAndGet()
        lateinit var task: Deferred<JSONObject>
        task = exportScope.async(start = CoroutineStart.LAZY) {
            try {
                pdfAdmission.withLock {
                    if (ticket != pdfBatchSequence.get()) throw CancellationException("这份选择已被后来的文件操作替代，未读取旧列表")
                    stopPdfAcquisition(retireQueuedBatch = false) // The previous parser drains without holding maintenance.
                    if (ticket != pdfBatchSequence.get()) throw CancellationException("这份选择已被后来的文件操作替代，未读取旧列表")
                    dispatch.requireCurrent(epoch)
                    requirePdfAcquisition(initial, true)
                    pdfAcquisition.set(task)
                }
                runPdfImportBatch(selectedUris, initial, epoch)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                val message = "本批 PDF 处理未正常结束；已接纳原件保留，请查看任务记录。"
                _state.update { it.copy(error = message) }
                throw AppFailure("operation", message) // Provider exception text may contain its private URI.
            }
        }
        task.invokeOnCompletion { pdfAcquisition.compareAndSet(task, null) }
        task.start()
        return task
    }

    private suspend fun runPdfImportBatch(uris: List<Uri>, initial: ReadingAccess, epoch: String): JSONObject {
        val operation = currentCoroutineContext()
        val job = operation[Job] ?: error("缺少本次批次作业")
        val id = UUID.randomUUID().toString()
        val progress = PdfImportBatchProgress(uris.size)
        val row = JSONObject().put("id", id).put("kind", "pdf.import.batch").put("paperID", "")
            .put("title", "导入所选 PDF（${uris.size} 份）").put("identity", "本机所选原件")
            .put("status", "running").put("createdAt", now()).put("startedAt", now())
        suspend fun persist(status: String) {
            maintenance.withLock {
                val latest = personal.snapshot().getJSONArray("jobs").objects().firstOrNull { it.optString("id") == id } ?: row.copy()
                latest.put("status", status).put("result", progress.snapshot(status)).put("message", progress.message())
                if (status != "running") latest.put("endedAt", now())
                personal.upsertJob(latest)
            }
            refresh()
        }
        maintenance.withLock {
            dispatch.requireCurrent(epoch); requirePdfAcquisition(initial, true); operation.ensureActive()
            personal.upsertJob(row.copy().put("result", progress.snapshot("running")).put("message", progress.message()))
            active[id] = job
        }
        refresh()
        _state.update { it.copy(notice = progress.message(), error = null) }
        var currentIndex = -1
        var accepted: java.util.concurrent.atomic.AtomicReference<JSONObject?>? = null
        var terminalFailure: Throwable? = null
        var cancelled = false
        try {
            for ((index, uri) in uris.withIndex()) {
                operation.ensureActive(); dispatch.requireCurrent(epoch)
                val access = maintenance.withLock {
                    dispatch.requireCurrent(epoch); operation.ensureActive()
                    val current = _state.value
                    ReadingAccess(current.selectedPaperId, generation.get(), current.pdfDocument?.sha256,
                        current.pdfSelection, current.pdfPage, current.readingMaterialID).also { requirePdfAcquisition(it, true) }
                }
                currentIndex = index
                val childID = UUID.randomUUID().toString()
                val acceptedItem = java.util.concurrent.atomic.AtomicReference<JSONObject?>(null)
                accepted = acceptedItem
                progress.begin(index, childID)
                persist("running")
                try {
                    val actual = runTask("pdf.import", gate = { dispatch.requireCurrent(epoch); requirePdfAcquisition(access, true) },
                        parentJobID = id, itemIndex = index, taskID = childID) {
                        importPdfOriginal(uri, access, epoch) { facts -> acceptedItem.set(facts.copy()) }
                    }
                    progress.completed(index, actual)
                } catch (failure: PdfInvalidDocumentException) {
                    // Only definite native structure failures qualify; provider/FS/parser IOException must stop the batch.
                    progress.failed(index)
                }
                persist("running")
                currentIndex = -1; accepted = null
            }
        } catch (failure: Throwable) {
            terminalFailure = failure
            cancelled = failure is CancellationException
            if (currentIndex >= 0 && progress.status(currentIndex) == "running") {
                val committed = accepted?.get()
                if (committed != null) progress.completed(currentIndex, committed)
                else if (cancelled) progress.cancelled(currentIndex) else progress.failed(currentIndex)
            }
        } finally {
            withContext(NonCancellable) {
                try { persist(progress.finalStatus(cancelled)) }
                catch (recordFailure: Throwable) {
                    if (terminalFailure != null) terminalFailure!!.addSuppressed(recordFailure) else terminalFailure = recordFailure
                    _state.update { it.copy(error = "批次记录未能完整保存；已接纳原件保留，未开始的文件没有报告成功。") }
                } finally { active.remove(id); refresh() }
            }
        }
        val status = progress.finalStatus(cancelled)
        val result = progress.snapshot(status).put("jobID", id).put("message", progress.message())
        _state.update { it.copy(notice = progress.message()) }
        terminalFailure?.let { throw it }
        return result
    }

    override suspend fun unlockPdf(requestID: String, password: CharArray) {
        pdfUnlocks.submit(requestID, password)
    }
    override suspend fun cancelPdfUnlock(requestID: String) {
        val original = pdfUnlocks.requestStop(requestID) ?: throw AppFailure("stale", "这份原文的解锁请求已经结束")
        original.join() // No maintenance mutex held; the native parser must actually close.
    }

    private fun requirePdfAcquisition(access: ReadingAccess, allowEmpty: Boolean = false) {
        require((allowEmpty || access.owner != null) && _state.value.selectedPaperId == access.owner && generation.get() == access.generation) {
            "阅读空间已切换，原解锁请求没有取得另一论文的权限"
        }
    }
    private suspend fun stopPdfAcquisition(retireQueuedBatch: Boolean = true) {
        if (retireQueuedBatch) pdfBatchSequence.incrementAndGet()
        val original = pdfAcquisition.get() ?: return
        original.cancel(); original.join()
    }
    private suspend fun ownedPdfAcquisition(kind: String, access: ReadingAccess, epoch: String, body: suspend () -> JSONObject): JSONObject {
        val task = pdfAdmission.withLock {
            stopPdfAcquisition()
            requirePdfAcquisition(access, kind == "pdf.import")
            val deferred = exportScope.async(start = CoroutineStart.LAZY) {
                runTask(kind, if (kind == "pdf.import") "" else access.owner.orEmpty(), gate = { dispatch.requireCurrent(epoch); requirePdfAcquisition(access, kind == "pdf.import") }, body = body)
            }
            pdfAcquisition.set(deferred)
            deferred.invokeOnCompletion { pdfAcquisition.compareAndSet(deferred, null) }
            deferred.start(); deferred
        }
        try { return task.await() }
        catch (cancelled: CancellationException) {
            _state.update { it.copy(notice = if (task.isActive) "原文准备仍在应用内进行；关闭等待窗口没有停止原任务。" else "原文准备已结束；请查看原任务的实际结果，原件保留。") }
            throw cancelled
        }
    }
    private suspend fun importPdfOriginal(uri: Uri, access: ReadingAccess, epoch: String, onAccepted: (JSONObject) -> Unit = {}): JSONObject {
        val operation = currentCoroutineContext()
        val check = { operation.ensureActive(); dispatch.requireCurrent(epoch); requirePdfAcquisition(access, true) }
        val session = pdf.prepareImport(uri, check)
        val result = finishPdfSession(session, "import", check)
        return adoptPdfResult(result, check) { document ->
            val p = Paper(document.id, document.displayName.removeSuffix(".pdf"), sourceKind = "local", identityStatus = "local-original", localPDFPath = document.localPath, pdfSHA256 = document.sha256)
            // No later cancellation can delete an original after this registration has returned.
            personal.rememberPaper(p)
            pdf.acceptImport(result)
            offlineReading = null; generation.incrementAndGet()
            _state.update { it.copy(selectedPaperId = p.id, viewedPaper = Paper.fromJson(p.json()), article = null, pdfDocument = document, pdfMode = true, pdfPage = 1, pdfSelection = null,
                pdfReceipt = JSONObject().put("paperID", p.id).put("sha256", document.sha256).put("version", JSONObject.NULL).put("isStale", false).put("currentness", "local-original")) }
            JSONObject().put("paperID", p.id).put("pageCount", document.pageCount).put("sha256", document.sha256).also { onAccepted(it) }
        }
    }

    private suspend fun finishPdfSession(session: PdfImportSession, purpose: String, check: () -> Unit): PdfImportedOriginal {
        var result: PdfImportedOriginal? = null
        try {
            var promptMessage: String? = null
            while (true) {
                check()
                try {
                    result = if (!session.passwordRequired && promptMessage == null) pdf.finishImport(session, null, check)
                    else {
                        val prompt = PdfUnlockPrompt(UUID.randomUUID().toString(), session.displayName.take(250), purpose, promptMessage)
                        val lifetime = pdfAcquisition.get() ?: error("本次原生解锁作业已结束")
                        pdfUnlocks.awaitAndUse(prompt, check, lifetime = lifetime) { password -> pdf.finishImport(session, password, check) }
                    }
                    check(); return result!!
                } catch (_: PdfPasswordRequiredException) {
                    promptMessage = "密码为空或不正确，请重新输入本次原文密码。"
                }
            }
        } catch (failure: Throwable) {
            withContext(NonCancellable) {
                try { result?.let { pdf.finalizeImport(it, false) } ?: pdf.cancelImport(session) }
                catch (cleanup: Throwable) { failure.addSuppressed(cleanup) }
            }
            throw failure
        }
    }
    private suspend fun adoptPdfResult(result: PdfImportedOriginal, check: () -> Unit, commit: (PdfDocumentRef) -> JSONObject): JSONObject {
        var accepted = false
        try {
            // Verify the native issued result and complete ciphertext before the short indivisible commit.
            check(); pdf.verifyImport(result, check)
            return withContext(NonCancellable) { maintenance.withLock {
                check()
                val answer = commit(result.document)
                pdf.acceptImport(result); accepted = true
                currentCoroutineContext()[CoroutineName]?.name?.let { id -> pdfCommittedResults[id] = answer.copy() }
                answer
            } }
        } finally {
            // acceptImport is synchronous and never removes an accepted/pre-existing original.
            withContext(NonCancellable) { pdf.finalizeImport(result, accepted) }
        }
    }

    override suspend fun updatePdfSelection(selection: PdfSelection) {
        val d = _state.value.pdfDocument ?: return
        require(selection.documentSHA256 == d.sha256 && selection.pages.all { it in 1..d.pageCount } && selection.text.length <= 100000)
        _state.update { it.copy(pdfSelection = selection.takeIf { s -> s.text.isNotBlank() && s.pages.isNotEmpty() }) }
    }
    private suspend fun highlight(payload: JSONObject, access: ReadingAccess): JSONObject = maintenance.withLock {
        requireReading(access, true); require(_state.value.pdfSelection == access.selection) { "原文选区已经变化，未保存另一段文字" }
        val d = _state.value.pdfDocument ?: error("PDF 尚未打开"); val p = selected(); val selection = _state.value.pdfSelection ?: error("请先选择实际 PDF 文字")
        val receipt = _state.value.pdfReceipt.copy()
        require(receipt.optString("paperID", p.id) == p.id && receipt.optString("sha256") == d.sha256) { "标注的来源回执不属于此原件" }
        val annotation = pdf.prepareAnnotation(d, selection, payload.optString("comment"))
        val marks = pdf.portableMarks(d, annotation)
        require(marks.isNotEmpty()) { "没有可保存的实际页坐标" }
        val complete = marks.map { mark -> mark.put("pages", JSONArray(listOf(mark.getInt("page")))).put("sourceVersion", receipt.opt("version") ?: JSONObject.NULL).put("sourceURL", receipt.optString("sourceURL")) }
        personal.replaceAnnotations(p.id, personal.annotations(p.id) + complete)
        JSONObject().put("saved", true).put("groupID", annotation.id).put("marks", JSONArray(marks))
    }
    private suspend fun annotationChange(payload: JSONObject, remove: Boolean, access: ReadingAccess): JSONObject = maintenance.withLock {
        requireReading(access)
        val p = selected(); val id = payload.getString("id"); val entry = personal.annotations(p.id).firstOrNull { it.optString("id") == id } ?: error("批注不存在或属于其他论文")
        if (payload.has("paperID")) require(payload.getString("paperID") == p.id)
        val group = entry.optString("groupID").takeIf { it.isNotBlank() } ?: id
        val updated = personal.annotations(p.id).mapNotNull { mark ->
            val markGroup = mark.optString("groupID").takeIf { it.isNotBlank() } ?: mark.optString("id")
            if (markGroup != group || mark.optString("pdfSHA") != entry.optString("pdfSHA")) mark else if (remove) null else mark.copy().put("comment", payload.optString("comment"))
        }
        personal.replaceAnnotations(p.id, updated)
        JSONObject().put("saved", true)
    }
    private suspend fun openAnnotation(id: String, access: ReadingAccess, epoch: String): JSONObject {
        val prepared = maintenance.withLock {
            requireReading(access)
            val p = selected(); val mark = personal.annotations(p.id).firstOrNull { it.optString("id") == id } ?: error("批注不存在或属于其他论文")
            val hash = mark.getString("pdfSHA"); require(BackupCodec.validSHA(hash))
            val file = listOf(File(research, "Imports/$hash.pdf"), File(research, "PublishedLibrary/pdf/$hash.pdf")).firstOrNull { it.isFile && runCatching { StoragePaths.resolve(it.absolutePath, research, hash); true }.getOrDefault(false) }
                ?: throw AppFailure("missing", "这条标注对应的旧 SHA 原文尚未保存在本机，未跳转到另一版本的 PDF")
            Triple(p, mark.copy(), file)
        }
        val operation = currentCoroutineContext()
        val check = { operation.ensureActive(); dispatch.requireCurrent(epoch); requireReading(access) }
        val hash = prepared.second.getString("pdfSHA")
        val session = pdf.prepareFileImport(prepared.third, prepared.first.title + ".pdf", hash, check)
        val result = finishPdfSession(session, "annotation", check)
        return adoptPdfResult(result, check) { document ->
            val page = prepared.second.getInt("page"); require(page in 1..document.pageCount)
            val oldVersion = prepared.second.nullableString("sourceVersion")
            val receipt = JSONObject().put("paperID", prepared.first.id).put("sha256", hash).put("version", oldVersion ?: JSONObject.NULL).put("sourceURL", prepared.second.optString("sourceURL"))
                .put("isStale", oldVersion == null || oldVersion != prepared.first.sourceVersion).put("currentness", "annotation-bound-original").put("notices", JSONArray(listOf("按标注的原 PDF SHA 打开；原文版本 ${oldVersion ?: "未标注"}，不代表网站当前版本。")))
            updateReading(access) { it.copy(pdfDocument = document, pdfPage = page, pdfMode = true, pdfSelection = null, pdfReceipt = receipt) }
            JSONObject().put("opened", true).put("page", page).put("sha256", hash)
        }
    }
    private fun restoreToken(staged: BackupCodec.Staged): JSONObject {
        val id = UUID.randomUUID().toString(); restores[id] = staged
        return JSONObject().put("restoreID", id).put("fileCount", staged.entries.size).put("sha256", staged.encodedSHA256).put("message", "完整备份已通过逐文件校验。恢复后将回到此快照；保留本机连接、实际派发计数和恢复前副本。")
    }
    private suspend fun cloudCommand(command: String, payload: JSONObject): JSONObject = when (command) {
        "cloud.state" -> cloudView()
        "cloud.save" -> cloud.save(payload.getString("account"), payload.optString("folder", "PaperDigest"), payload.optBoolean("automatic"), payload.optInt("intervalHours", 24))
        "cloud.check" -> runTask(command) { cloud.check() }
        "cloud.upload" -> maintenance.withLock {
            require(personal.snapshot().getJSONArray("jobs").objects().none { it.optString("kind") == "cloud.upload" && it.optString("status") in listOf("queued", "running") }) { "已有备份任务，请先等待或停止后续传" }
            val id = UUID.randomUUID(); val work = OneTimeWorkRequestBuilder<CloudTransferWorker>().setId(id).setInputData(workDataOf("destinationID" to cloud.targetID, "workspaceEpoch" to dispatch.epoch))
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).setRequiresStorageNotLow(true).build()).build()
            personal.upsertJob(JSONObject().put("id", id.toString()).put("kind", command).put("paperID", "").put("status", "queued").put("createdAt", now()).put("message", "等待网络可用后继续原快照备份"))
            WorkManager.getInstance(context).enqueueUniqueWork("paperdigest-cloud-manual-${cloud.targetID}", ExistingWorkPolicy.KEEP, work)
            JSONObject().put("queued", true).put("jobID", id.toString()).put("message", "备份已加入后台任务，完整回读通过后才会标为完成")
        }
        "cloud.list" -> cloudSelections.list(payload.getString("month"))
        "cloud.restore.prepare" -> {
            val selectionID = payload.getString("selectionID")
            runTask(command, gate = { cloudSelections.requireSelection(selectionID) }) {
                val operation = currentCoroutineContext()
                val prepared = cloudSelections.prepare(selectionID) { operation.ensureActive() }
                restoreToken(prepared.staged).put("reference", prepared.manifest.reference.json())
            }
        }
        "cloud.archivePending" -> cloud.archivePending()
        "cloud.retained.list" -> JSONObject().put("retained", cloud.retainedList())
        "retained.list" -> JSONObject().put("transfers", JSONArray(cloud.retainedList().objects().map { row -> row.copy().put("id", row.optString("transferID", row.optString("id"))) }))
        else -> throw AppFailure("unsupported", "云端操作尚不支持")
    }
    private fun scheduleCloud(profile: JSONObject) {
        if (!installBackground) return
        CloudScheduler.update(context, cloud.targetID, profile)
    }
    private fun scheduleCatalog() {
        if (!installBackground) return
        val manager = WorkManager.getInstance(context); val settings = personal.settings()
        if (settings.optBoolean("offlineMode")) { manager.cancelUniqueWork("paperdigest-published-catalog"); return }
        val hours = settings.optLong("syncHours", 12).coerceIn(1, 168)
        val request = PeriodicWorkRequestBuilder<CatalogSyncWorker>(hours, TimeUnit.HOURS).setInitialDelay(hours, TimeUnit.HOURS)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).setRequiresBatteryNotLow(true).setRequiresStorageNotLow(true).build()).build()
        manager.enqueueUniquePeriodicWork("paperdigest-published-catalog", ExistingPeriodicWorkPolicy.UPDATE, request)
    }
    private fun validateSettings(changes: JSONObject) {
        changes.keys().forEach { key ->
            when (key) {
                "font" -> changes.put(key, strictInteger(changes.get(key), 14, 30))
                "dailyRequests" -> changes.put(key, strictInteger(changes.get(key), 1, 1000))
                "maxTokens" -> changes.put(key, strictInteger(changes.get(key), 128, 64000))
                "timeoutMs" -> changes.put(key, strictInteger(changes.get(key), 1000, 600000))
                "syncHours" -> changes.put(key, strictInteger(changes.get(key), 1, 168))
                "appearance" -> require(changes.getString(key) in listOf("system", "light", "dark"))
                "httpProxy" -> if (changes.getString(key).isNotBlank()) { val u = URI(changes.getString(key)); require(u.scheme == "http" && u.host != null && u.port in 1..65535 && u.userInfo == null && u.query == null && u.fragment == null && u.path in listOf("", "/")) { "请输入不含密码的 HTTP CONNECT 代理" } }
            }
        }
        val merged = personal.settings(); changes.keys().forEach { merged.put(it, changes.get(it)) }
        if (merged.optString("endpoint").isNotBlank() && merged.optString("model").isNotBlank()) StudyService.validatedConfig(merged)
    }
    private fun requireExportDestination(raw: String): Uri = ExportService.externalDestination(context, raw)
    private suspend fun verifyExportDestination(raw: String, expectedSHA: String, expectedBytes: Long) {
        val uri = requireExportDestination(raw)
        require(BackupCodec.validSHA(expectedSHA) && expectedBytes in 0..BackupCodec.MAX_ENCODED)
        val operationContext = currentCoroutineContext()
        verifyExportDestinationBytes(uri, expectedSHA, expectedBytes) { operationContext.ensureActive() }
    }
    private fun verifyExportDestinationBytes(uri: Uri, expectedSHA: String, expectedBytes: Long, check: () -> Unit) {
        require(BackupCodec.validSHA(expectedSHA) && expectedBytes in 0..BackupCodec.MAX_ENCODED)
        val digest = java.security.MessageDigest.getInstance("SHA-256"); var actual = 0L
        context.contentResolver.openInputStream(uri)?.use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                check()
                val count = input.read(buffer); if (count < 0) break
                actual += count; require(actual <= expectedBytes) { "所选位置返回的文件长度与原件不符" }
                digest.update(buffer, 0, count)
            }
        } ?: throw AppFailure("storage", "无法重新读取所选导出文件，原临时副本保留")
        check()
        val sha = digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
        require(actual == expectedBytes && sha == expectedSHA) { "所选位置的实际文件与原件不符，原临时副本保留" }
    }
    private fun strictInteger(value: Any, min: Int, max: Int): Int {
        val number = when (value) {
            is Number -> value.toDouble().takeIf { it.isFinite() && it == value.toInt().toDouble() }?.toInt()
            is String -> value.takeIf { it.matches(Regex("[0-9]{1,9}")) }?.toIntOrNull()
            else -> null
        }
        require(number != null && number in min..max) { "数字设置超出允许范围" }; return number
    }
    private fun publishPendingExports(error: String? = null, loading: Boolean = false) {
        val rows = pendingExportViews.values.map(JSONObject::copy)
        _state.update { it.copy(pendingExports = rows, pendingExportsError = error, pendingExportsLoading = loading) }
    }
    private fun pendingView(view: PendingExportStore.PendingExport) {
        pendingExportViews[view.operationID] = retainedView(view)
        publishPendingExports()
    }
    private fun producerFor(view: PendingExportStore.PendingExport) = ExportProducerReceipt(
        File(pendingControlRoot, UUID.fromString(view.operationID).toString()), view.operationID,
        view.documentID, view.sourceIdentity)
    private fun exportResult(view: PendingExportStore.PendingExport): JSONObject = view.json().also {
        require(view.preparation == "ready" && view.artifact != null) { "原件还未就绪，不能选择保存位置" }
        it.put("message", "原件已准备，尚未保存到所选位置；可在待保存清单继续同一份原件。")
    }
    private fun exportJobRow(id: String, kind: String, source: JSONObject) = JSONObject()
        .put("id", id).put("kind", kind).put("paperID", source.optString("paperID"))
        .put("status", "running").put("createdAt", now()).put("startedAt", now())
        .put("identity", source.optString("label", "研究空间"))
        .put("message", "正在准备原件；完成后仍需选择保存位置。")
    private fun finishExportJob(row: JSONObject, view: PendingExportStore.PendingExport?, failure: Throwable?) {
        val ready = view?.preparation == "ready" && view.artifact != null
        val next = row.copy().put("endedAt", now())
            .put("status", if (ready) "completed" else if (failure is CancellationException) "cancelled" else "failed")
            .put("message", if (ready) "原件已准备，尚未保存到所选位置；可继续保存同一原件。" else if (failure is CancellationException) "准备已停止；已封存材料和研究原件保留。" else "准备未完成；已有材料保留，不会自动重新采集。")
        if (ready) {
            val actual = requireNotNull(view); val artifact = requireNotNull(actual.artifact)
            next.put("result", exportResult(actual))
            next.put("material", JSONObject().put("kind", "prepared-export").put("createdAt", actual.createdAt)
                .put("sha256", artifact.sha256).put("encodedBytes", artifact.bytes))
        }
        persistExportJob(next)
    }
    /** A single IO reconciliation owns the same maintenance snapshot as new begin/delivery. */
    private suspend fun reconcilePendingExports(operationID: String? = null): JSONObject = maintenance.withLock {
        val operation = currentCoroutineContext()
        _state.update { it.copy(pendingExportsLoading = true) }
        try {
            val activeIDs = active.keys.toSet()
            val rows = if (operationID == null) pendingStore.reconcile(activeIDs, exportAttempts.keys.toSet()) { operation.ensureActive() }
                else listOf(pendingStore.get(operationID) { operation.ensureActive() })
            if (operationID == null) pendingExportViews.clear()
            val loadedNativeIDs = HashSet<String>()
            for (original in rows) {
                operation.ensureActive()
                var row = original
                loadedNativeIDs.addAll(readNativeExportJobs(row, activeIDs))
                for (control in retainedAccess.readJobs(row, activeIDs)) {
                    val id = control.getString("id")
                    require(personal.snapshot().getJSONArray("jobs").objects().none { it.optString("id") == id } && personal.session(id) == null) { "本机保留任务与研究历史身份冲突" }
                    nativeExportJobs[id] = control; loadedNativeIDs.add(id)
                }
                // Parsing a complete ordinary bin/temp is not upstream production authority.
                // Only an exact normal BackupCodec.capture completion receipt may finish registration.
                if ((row.preparation == "interrupted" || (row.preparation == "preparing" && row.jobID !in activeIDs)) && row.sourceIdentity.optString("format") == "backup") {
                    val producer = producerFor(row)
                    if (producer.hasCompletionMaterials()) {
                        try {
                            val captured = producer.verifiedCapture { operation.ensureActive() }
                            requireRescueCaptureIdentity(row, captured.file) { operation.ensureActive() }
                            exports.registerCompleted(captured, row.documentID) { operation.ensureActive() }
                            row = pendingStore.markReady(row.operationID) { operation.ensureActive() }
                        } catch (cancelled: CancellationException) { throw cancelled }
                        catch (_: Exception) { /* Preserve original bytes and honest interrupted state. */ }
                    }
                }
                pendingExportViews[row.operationID] = retainedView(row).also { view ->
                    if (row.preparation == "preparing" && row.jobID !in activeIDs) view.put("preparation", "interrupted")
                        .put("message", "原准备任务已中断；本次核验未重新采集，也未授予原件就绪。")
                }
                if (row.preparation == "ready" && row.artifact != null) {
                    // Repair the current job only, never the captured personal.json or its paid history.
                    (nativeExportJobs[row.jobID] ?: personal.snapshot().getJSONArray("jobs").objects().firstOrNull { it.optString("id") == row.jobID })
                        ?.takeIf { it.optString("status") != "completed" || it.optJSONObject("result")?.optString("operationID") != row.operationID }
                        ?.let { finishExportJob(it, row, null) }
                }
            }
            require(nativeExportJobs.values.filter { operationID == null || it.optString("nativeOperationID") == operationID }.all { it.optString("id") in loadedNativeIDs }) { "既有本机救援控制记录未完整读取，未当成空历史。" }
            publishPendingExports()
            JSONObject().put("pendingExports", JSONArray(pendingExportViews.values.map(JSONObject::copy)))
        } catch (cancelled: CancellationException) {
            publishPendingExports("待保存清单读取已停止；原材料保留。")
            throw cancelled
        } catch (failure: Exception) {
            // Neither Application startup nor an unreadable control root becomes an empty success.
            publishPendingExports("待保存控制记录暂时无法完整读取；原材料保留，请明确重新核验。")
            throw failure
        }
    }

    private suspend fun preparePendingExport(command: String, payload: JSONObject, access: ReadingAccess): JSONObject {
        val requestContext = currentCoroutineContext()
        val deferred = maintenance.withLock {
            require(active.isEmpty()) { "请待当前任务结束再导出完整材料" }
            val format = if (command == "retained.export.prepare") "retained-backup" else payload.getString("format")
            val sessionID = payload.nullableString("sessionID")
            val historical = sessionID?.let { personal.session(it) ?: error("原研究记录不存在") }
            require(historical == null || format in listOf("research-json", "research-md", "research-html")) { "原研究只能按其实际材料导出" }
            val whole = format in listOf("backup", "diagnostics", "retained-backup")
            if (!whole && historical == null) requireReadingMaterials(access)
            val owner = historical?.optString("paperID") ?: if (whole) "" else selected().id
            val epoch = dispatch.epoch
            val source = JSONObject().put("format", format).put("workspaceEpoch", epoch).put("paperID", owner)
                .put("label", if (whole) "研究空间" else historical?.optString("question")?.take(120) ?: selected().titleZh.take(120))
                .put("createdAt", now()).put("readingMaterialID", if (!whole && historical == null) access.materialID else JSONObject.NULL)
            if (historical != null) source.put("sessionID", sessionID).put("inputSHA256", historical.optString("inputSHA256"))
            else if (!whole) {
                val actual = _state.value
                val version = if (format == "paper-pdf") { if (actual.pdfDocument != null) actual.pdfReceipt.nullableString("version") else selected().sourceVersion } else actual.article?.sourceVersion
                source.put("sourceVersion", version ?: JSONObject.NULL)
                if (format == "paper-pdf") source.put("pdfSHA256", actual.pdfDocument?.sha256 ?: JSONObject.NULL)
                else source.put("articleRevisionSHA256", actual.article?.revisionSHA256 ?: JSONObject.NULL)
            }
            val retained = if (format == "retained-backup") {
                val file = cloud.retainedSnapshot(payload.getString("transferID"))
                source.put("transferID", payload.getString("transferID")).put("originalSHA256", BackupCodec.hash(file) { requestContext.ensureActive() }).put("originalBytes", file.length())
                file
            } else null
            val id = UUID.randomUUID().toString()
            var jobRow = exportJobRow(id, command, source)
            val originalPersonal = if (format == "backup") personalFileIdentity { requestContext.ensureActive() } else null
            var rescue = false
            try { personal.upsertJob(jobRow) }
            catch (failure: AppFailure) {
                if (format != "backup" || failure.category != "capacity" || originalPersonal == null) throw failure
                require(personalFileIdentity { requestContext.ensureActive() } == originalPersonal) { "个人资料在容量拒绝期间已变化，未进入只读救援。" }
                rescue = true
                jobRow = jobRow.copy().put("localRescueExport", true)
                    .put("identity", "本机只读救援备份（控制任务不包含在原快照）")
                    .put("message", "个人记录容量已满；只读采集原研究目录，控制任务仅保存在本机传输记录。")
                source.put("rescueExport", true).put("originalPersonalSHA256", originalPersonal.second)
                    .put("originalPersonalBytes", originalPersonal.first).put("rescueJob", jobRow.copy())
            }
            val pending = try { pendingStore.begin(id, format, source) }
            catch (failure: Throwable) { if (!rescue) finishExportJob(jobRow, null, failure); throw failure }
            if (rescue) writeNativeExportJob(pending, jobRow)
            pendingView(pending)
            val producer = if (format == "backup") producerFor(pending) else null
            val task = exportScope.async(CoroutineName(id), start = CoroutineStart.LAZY) {
                var ready: PendingExportStore.PendingExport? = null
                try {
                    maintenance.withLock {
                        val work = currentCoroutineContext()
                        val check = { work.ensureActive(); dispatch.requireCurrent(epoch); if (!whole && historical == null) requireReading(access); Unit }
                        check()
                        if (!whole && historical == null) requireReadingMaterials(access)
                        val p = if (historical != null || whole) null else selected()
                        val article = if (historical != null) null else _state.value.article
                        if (format == "guide-html") require(article != null && article.paperID == p?.id) { "请先打开要导出的实际导读；未隐式刷新为另一份网页修订。" }
                        val original = if (format == "paper-pdf") {
                            val opened = _state.value.pdfDocument
                            if (opened != null) {
                                requireReading(access, true)
                                ReadingSourceBinding.requirePDF(p ?: error("请先选择论文"), _state.value.pdfReceipt, opened.sha256)
                                StoragePaths.resolve(opened.localPath, research, opened.sha256, 200 * 1024 * 1024L)
                            } else currentPDF(p ?: error("请先选择论文")).first
                        } else null
                        val phase: (String) -> Unit = { value -> check(); pendingView(pendingStore.phase(pending.operationID, value)) }
                        phase(if (format == "backup") "capturing" else "encoding")
                        if (retained != null) {
                            require(BackupCodec.hash(retained, check) == source.getString("originalSHA256")) { "原保留快照已变化，未替换为另一份材料" }
                            val registered = exports.register(retained, "application/octet-stream", "论文速递-保留快照.paperdigest", pending.documentID, check)
                            require(registered.sha256 == source.getString("originalSHA256") && registered.file.length() == source.getLong("originalBytes")) { "保留快照在复制期间已变化，未将变动副本标为就绪。" }
                        } else {
                            exports.prepare(format, p, article, original, sessionID, pending.documentID,
                                if (format == "backup") pendingStore.preparationFile(pending.operationID) else null,
                                check, phase, producer)
                        }
                        check()
                        if (!whole && historical == null) requireReadingMaterials(access)
                        phase("verifying")
                        if (rescue) requireRescueCaptureIdentity(pending, pendingStore.preparationFile(pending.operationID), check)
                        ready = pendingStore.markReady(pending.operationID, check)
                        pendingView(ready!!)
                        // Durable ready precedes the completed current job; no progress writes occurred during capture.
                        finishExportJob(jobRow, ready, null)
                        exportResult(ready!!)
                    }
                } catch (failure: Throwable) {
                    withContext(NonCancellable + Dispatchers.IO) {
                        maintenance.withLock {
                            // A crash/test boundary after ready.persisted is still a real ready result.
                            val disk = ready ?: runCatching { pendingStore.get(pending.operationID) }.getOrNull()
                            if (disk?.preparation == "ready" && disk.artifact != null) {
                                ready = disk; pendingView(disk); finishExportJob(jobRow, disk, null)
                            } else {
                                if (failure is CancellationException) {
                                    // A normal completed capture is the unique resumable original, not a disposable temp.
                                    val hasReceipt = if (producer != null) runCatching { producer.hasCompletionMaterials() }.getOrDefault(true) else false
                                    if (!hasReceipt && pending.operationID !in preservePreparationForRetain) runCatching { pendingView(pendingStore.cancelPreparation(pending.operationID)) }
                                }
                                finishExportJob(jobRow, null, failure)
                            }
                        }
                    }
                    throw failure
                } finally {
                    withContext(NonCancellable + Dispatchers.IO) {
                        maintenance.withLock {
                            active.remove(id); exportOwnedJobs.remove(id); preservePreparationForRetain.remove(pending.operationID)
                            try {
                                val actual = (ready ?: pendingStore.get(pending.operationID)).json()
                                if (actual.optString("preparation") == "preparing") actual.put("preparation", "interrupted")
                                    .put("message", "准备任务已停止；原材料保留，请明确重新核验。")
                                pendingExportViews[pending.operationID] = actual; publishPendingExports()
                            } catch (_: Exception) { publishPendingExports("待保存记录未能完整对账；原件保留，请重新核验。") }
                            refresh()
                        }
                    }
                }
            }
            active[id] = task; exportOwnedJobs.add(id); task.start(); refresh(); task
        }
        return awaitOwnedExport(deferred, "原件准备")
    }

    private fun requireAttempt(operationID: String, attemptID: String): ExportAttempt {
        val attempt = exportAttempts[attemptID] ?: error("系统保存许可已结束；原件保留，请从待保存清单重新选择位置。")
        require(attempt.operationID == operationID) { "保存回调与原操作不符，未写入另一份文件。" }
        dispatch.requireCurrent(attempt.epoch)
        return attempt
    }
    private suspend fun beginExportDelivery(operationID: String): JSONObject = maintenance.withLock {
        require(exportAttempts.isEmpty() && !retainedAccess.hasDelivery()) { "请先结束当前系统保存，再选择另一份原件。" }
        val work = currentCoroutineContext()
        val row = pendingStore.beginDelivery(operationID) { work.ensureActive() }
        val attempt = row.attemptID ?: error("原保存许可未生成")
        exportAttempts[attempt] = ExportAttempt(operationID, attempt, dispatch.epoch)
        pendingView(row); row.json()
    }
    private suspend fun cancelExportDelivery(payload: JSONObject): JSONObject = maintenance.withLock {
        val operation = payload.getString("operationID"); val attempt = payload.getString("attemptID")
        require(requireAttempt(operation, attempt).writerJobID == null) { "此原件已开始保存，请到任务请求停止并等待实际关闭。" }
        val row = pendingStore.chooserCancelled(operation, attempt)
        exportAttempts.remove(attempt); pendingView(row); row.json()
    }
    private suspend fun savePendingExport(payload: JSONObject): JSONObject {
        val operationID = payload.getString("operationID"); val attemptID = payload.getString("attemptID")
        val uri = requireExportDestination(payload.getString("uri"))
        val deferred = maintenance.withLock {
            val delivery = requireAttempt(operationID, attemptID)
            require(delivery.writerJobID == null) { "本次许可已开始保存，未重复创建写入任务。" }
            val id = UUID.randomUUID().toString()
            val row = exportJobRow(id, "export.save", JSONObject().put("label", "已准备的原导出文件"))
                .put("message", "正在写入并回读所选位置；原准备文件保留。")
            val originalPending = pendingStore.get(operationID)
            if (originalPending.sourceIdentity.optBoolean("rescueExport")) writeNativeExportJob(originalPending, row)
            else personal.upsertJob(row)
            exportAttempts[attemptID] = delivery.copy(writerJobID = id)
            val task = exportScope.async(CoroutineName(id), start = CoroutineStart.LAZY) {
                var closed = false
                try {
                    maintenance.withLock {
                        val work = currentCoroutineContext()
                        val check = { work.ensureActive(); requireAttempt(operationID, attemptID); Unit }
                        val artifact = pendingStore.startWriting(operationID, attemptID, check)
                        pendingView(originalPending.copy(delivery = "writing", attemptID = attemptID, artifact = artifact))
                        check()
                        context.contentResolver.openOutputStream(uri, "wt")?.use { output ->
                            artifact.file.inputStream().use { input ->
                                val buffer = ByteArray(64 * 1024)
                                while (true) { check(); val n = input.read(buffer); if (n < 0) break; output.write(buffer, 0, n) }
                                check(); output.flush()
                            }
                        } ?: error("无法写入用户选择的位置，原准备文件保留。")
                        closed = true
                        pendingView(pendingStore.recordWritten(operationID, attemptID, check))
                        var verified = false
                        var message = "文件已交给所选位置，但完整回读或本机登记尚未完整确认；临时副本保留，清理资格仍须独立核验。"
                        try {
                            capacity.markExportSaved(artifact.documentID, uri.toString(), exportDestinationVerifier)
                            pendingView(pendingStore.verifyDelivery(operationID, attemptID, check) { expected ->
                                verifyExportDestinationBytes(uri, expected.sha256, expected.bytes, check)
                            })
                            verified = true; message = "已写入所选位置，并完整回读核对字节与 SHA"
                        } catch (cancelled: CancellationException) { throw cancelled }
                        catch (_: Exception) { pendingView(pendingStore.get(operationID, check)) }
                        val persistent = if (verified) runCatching {
                            context.contentResolver.takePersistableUriPermission(uri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION); true
                        }.getOrDefault(false) else false
                        val result = JSONObject().put("saved", true).put("verified", verified).put("persistentRead", persistent)
                            .put("operationID", operationID).put("attemptID", attemptID).put("documentID", artifact.documentID)
                            .put("bytes", artifact.bytes).put("sha256", artifact.sha256).put("message", message)
                        persistExportJob(row.copy().put("status", if (verified) "completed" else "failed").put("endedAt", now()).put("message", message).put("result", result))
                        result
                    }
                } catch (failure: Throwable) {
                    withContext(NonCancellable + Dispatchers.IO) { maintenance.withLock {
                        runCatching { pendingView(pendingStore.deliveryFailed(operationID, attemptID)) }
                        persistExportJob(row.copy().put("status", if (failure is CancellationException) "cancelled" else "failed")
                            .put("endedAt", now()).put("message", if (closed) "文件写流已关闭，回读或登记未完成；原件保留。" else "保存已停止；外部位置可能已有部分文件，原件保留。"))
                    } }
                    throw failure
                } finally {
                    withContext(NonCancellable + Dispatchers.IO) { maintenance.withLock {
                        exportAttempts.remove(attemptID); active.remove(id); exportOwnedJobs.remove(id); refresh()
                    } }
                }
            }
            active[id] = task; exportOwnedJobs.add(id); task.start(); refresh(); task
        }
        return awaitOwnedExport(deferred, "原件写出与回读")
    }
    private suspend fun awaitOwnedExport(deferred: Deferred<JSONObject>, label: String): JSONObject = try { deferred.await() }
    catch (cancelled: CancellationException) {
        val message = if (deferred.isActive) "$label 仍在后台；请到任务查看实际进度。"
            else if (deferred.isCancelled) "$label 已停止；已有封存材料保留，请查看原记录。"
            else "$label 已结束；请到待保存清单查看实际结果。"
        _state.update { it.copy(notice = message) }
        throw cancelled
    }

    private fun requireRescueCaptureIdentity(view: PendingExportStore.PendingExport, file: File, check: () -> Unit) {
        if (view.sourceIdentity.opt("rescueExport") != true) return
        val staged = BackupCodec.stage(file.inputStream(), file.parentFile!!, check)
        try {
            val personal = staged.entries.single { it.path == "personal.json" }
            require(personal.sha256 == view.sourceIdentity.getString("originalPersonalSHA256") && personal.bytes == view.sourceIdentity.getLong("originalPersonalBytes")) { "救援快照不再对应原个人文件，未授予原件就绪。" }
        } finally { staged.directory.deleteRecursively() }
    }

    private fun mergedJobs(personalJobs: List<JSONObject>): List<JSONObject> {
        val ids = personalJobs.map { it.optString("id") }.toSet()
        return personalJobs + nativeExportJobs.values.filter { it.optString("id") !in ids }.map(JSONObject::copy)
    }
    private fun personalFileIdentity(check: () -> Unit): Pair<Long, String> {
        val file = BackupCodec.checkedFile(research, "personal.json")
        require(file.length() in 1..PersonalStore.MAX_BYTES)
        return file.length() to BackupCodec.hash(file, check)
    }
    private fun nativeJobFile(view: PendingExportStore.PendingExport, id: String): File {
        require(UUID.fromString(id).toString() == id)
        val directory = File(pendingControlRoot, view.operationID)
        BackupCodec.checkedDirectory(directory)
        return File(directory, "native-job-$id.json")
    }
    private fun writeNativeExportJob(view: PendingExportStore.PendingExport, job: JSONObject) {
        require(view.sourceIdentity.opt("rescueExport") == true && view.sourceIdentity.optString("format") == "backup")
        require(job.optString("kind") in setOf("export.prepare", "export.save"))
        val actual = pendingStore.get(view.operationID)
        require(actual.jobID == view.jobID && actual.documentID == view.documentID && canonical(actual.sourceIdentity) == canonical(view.sourceIdentity))
        val row = job.copy().put("localRescueExport", true).put("nativeOperationID", view.operationID)
        val wrapper = JSONObject().put("contract", "paperdigest-native-export-job-v1").put("operationID", view.operationID)
            .put("documentID", view.documentID).put("job", row)
        JsonFiles.write(nativeJobFile(view, row.getString("id")), wrapper)
        nativeExportJobs[row.getString("id")] = row
    }
    private fun readNativeExportJobs(view: PendingExportStore.PendingExport, activeIDs: Set<String>): Set<String> {
        val directory = File(pendingControlRoot, view.operationID)
        BackupCodec.checkedDirectory(directory)
        val children = directory.listFiles() ?: error("本机救援控制目录无法读取，未当成空记录。")
        val files = children.filter { it.name.startsWith("native-job-") }
        if (view.sourceIdentity.opt("rescueExport") != true) {
            require(files.isEmpty()) { "普通导出下存在未识别的救援任务，未合并到研究记录。" }
            return emptySet()
        }
        require(view.sourceIdentity.optString("format") == "backup")
        val initial = view.sourceIdentity.getJSONObject("rescueJob")
        require(initial.getString("id") == view.jobID && initial.getString("kind") == "export.prepare" && initial.opt("localRescueExport") == true)
        require(BackupCodec.validSHA(view.sourceIdentity.getString("originalPersonalSHA256")))
        val ids = HashSet<String>()
        val savedPersonal = personal.snapshot()
        val personalIDs = (savedPersonal.getJSONArray("jobs").objects() + savedPersonal.getJSONArray("sessions").objects()).map { it.optString("id") }.toSet()
        for (file in files) {
            require(file.name.matches(Regex("native-job-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\\.json")))
            val raw = JSONObject(PublishedUtf8.decode(JsonFiles.read(BackupCodec.checkedFile(directory, file.name), 65536)))
            require(raw.keys().asSequence().toSet() == setOf("contract", "operationID", "documentID", "job"))
            require(raw.getString("contract") == "paperdigest-native-export-job-v1" && raw.getString("operationID") == view.operationID && raw.getString("documentID") == view.documentID)
            val job = raw.getJSONObject("job"); val id = job.getString("id")
            require(file == nativeJobFile(view, id) && ids.add(id))
            require(job.opt("localRescueExport") == true && job.getString("nativeOperationID") == view.operationID)
            require(if (job.getString("kind") == "export.prepare") id == view.jobID else id != view.jobID)
            require(job.getString("kind") in setOf("export.prepare", "export.save") && job.getString("status") in setOf("running", "completed", "failed", "cancelled", "interrupted"))
            require(id !in personalIDs) { "本机控制任务与研究历史身份冲突，未替换原记录。" }
            if (job.optString("status") == "running" && id !in activeIDs) {
                val retired = job.copy().put("status", "interrupted").put("endedAt", now())
                    .put("message", "上次本机救援导出已中断；原研究记录和材料未改写。")
                writeNativeExportJob(view, retired)
            } else nativeExportJobs[id] = job.copy()
        }
        if (view.jobID !in ids) {
            require(nativeExportJobs[view.jobID] == null) { "已登记的救援任务文件丢失，未以初始状态覆盖原事实。" }
            // begin already durably included this original native running job in its small source identity.
            // A crash before the separate control row cannot create an invented completed task.
            val interrupted = initial.copy().put("status", "interrupted").put("endedAt", now())
                .put("message", "救援任务尚未完成控制登记即中断；未改写原研究记录。")
            writeNativeExportJob(view, interrupted)
            ids.add(view.jobID)
        }
        return ids
    }
    private fun persistExportJob(row: JSONObject) {
        val native = nativeExportJobs[row.getString("id")]
        if (native == null) personal.upsertJob(row)
        else if (native.optBoolean("localRetainedExport")) persistRetainedTask(native.getString("nativeOperationID"), row)
        else writeNativeExportJob(pendingStore.get(native.getString("nativeOperationID")), row)
    }


    private fun retainedView(row: PendingExportStore.PendingExport): JSONObject = row.json().also { view ->
        if (row.preparation == "retained") {
            view.put("retainedDelivery", retainedExports.deliveries(row.operationID))
            view.put("retainedHistory", JSONArray(retainedExports.deliveryHistory(row.operationID)))
        }
    }
    private fun retainedConfirmationClear() { _state.update { it.copy(retainedExportConfirmation = null) } }
    private suspend fun requestRetainExport(operationID: String): JSONObject {
        // This immutable published row selects only its original native job, never payload job IDs.
        val visible = _state.value.pendingExports.firstOrNull { it.optString("operationID") == operationID }
            ?: error("原准备记录尚未读取，请先重新核验清单")
        val epoch = dispatch.epoch
        val ownedIDs = setOf(visible.getString("jobID")) + nativeExportJobs.values
            .filter { it.optString("nativeOperationID") == operationID }.map { it.getString("id") }
        _state.update { it.copy(notice = "已请求停止原准备，正在等待实际文件操作关闭；尚未报告停止。") }
        // This explicit retain path preserves even incomplete owned preparation bytes. The original
        // producer's finally clears the marker only after its cancellation cleanup has drained.
        val producer = active[visible.getString("jobID")]
        require(producer == null || visible.getString("jobID") in exportOwnedJobs) { "原准备没有此实际作业的停止权限" }
        if (producer != null) preservePreparationForRetain.add(operationID)
        // A blocked producer may own maintenance. Never wait for its completion while holding that lock.
        for (id in ownedIDs) active[id]?.let { require(id in exportOwnedJobs); it.cancel(); it.join() }
        if (producer == null || producer.isCompleted) preservePreparationForRetain.remove(operationID)
        return maintenance.withLock {
            dispatch.requireCurrent(epoch)
            val current = pendingStore.reconcile(active.keys.toSet(), exportAttempts.keys.toSet()).single { it.operationID == operationID }
            require(current.preparation in setOf("interrupted", "unavailable")) {
                "原准备已就绪或状态变化，请按实际记录继续；未强制结束另一状态。"
            }
            exportAttempts.values.filter { it.operationID == operationID }.forEach { old ->
                require(old.writerJobID == null || !active.containsKey(old.writerJobID))
                if (old.writerJobID == null) pendingStore.chooserCancelled(operationID, old.attemptID)
                exportAttempts.remove(old.attemptID)
            }
            val confirmation = retainedAccess.confirmation(operationID)
            // chooserCancelled may have changed the immutable row read above.
            pendingView(pendingStore.get(operationID))
            _state.update { it.copy(retainedExportConfirmation = confirmation.copy(), notice = "原准备已停止；请确认是否结束本次准备并原样保留材料。") }
            confirmation
        }
    }
    private suspend fun confirmRetainExport(payload: JSONObject): JSONObject = maintenance.withLock {
        val id = payload.getString("confirmationID")
        val row = retainedAccess.retain(id)
        if (_state.value.retainedExportConfirmation?.optString("confirmationID") == id) retainedConfirmationClear()
        pendingView(row)
        row.json().put("message", "本次准备已结束，原材料和旧记录保留；尚未核验其是否可另存。")
    }
    private suspend fun discardRetainConfirmation(payload: JSONObject): JSONObject = maintenance.withLock {
        val id = payload.getString("confirmationID")
        retainedAccess.discardConfirmation(id)
        if (_state.value.retainedExportConfirmation?.optString("confirmationID") == id) retainedConfirmationClear()
        JSONObject().put("cancelled", true).put("message", "已取消保留确认；此前停止的准备不会自动重新执行，材料仍保留。")
    }
    private fun retainedTaskRow(id: String, kind: String, operationID: String, label: String): JSONObject =
        exportJobRow(id, kind, JSONObject().put("label", label))
            .put("localRetainedExport", true).put("nativeOperationID", operationID)
            .put("message", "正在处理已保留的原快照；不重新采集当前资料，不修改旧任务和费用。")
    private fun persistRetainedTask(operationID: String, row: JSONObject) {
        retainedAccess.writeJob(operationID, row)
        nativeExportJobs[row.getString("id")] = row.copy()
    }
    private suspend fun ownedRetainedTask(operationID: String, kind: String, label: String,
        attemptID: String? = null, body: suspend (() -> Unit) -> JSONObject): JSONObject {
        val task = maintenance.withLock {
            val epoch = dispatch.epoch
            require(pendingStore.get(operationID).preparation == "retained")
            require(nativeExportJobs.values.none { it.optString("nativeOperationID") == operationID && it.optString("status") == "running" && active.containsKey(it.optString("id")) }) { "请等原保留快照任务实际结束" }
            if (attemptID != null) require(retainedAccess.lease(operationID, attemptID).writerJobID == null) { "本次保存已开始，未重复创建控制任务" }
            val id = UUID.randomUUID().toString()
            val row = retainedTaskRow(id, kind, operationID, label)
            persistRetainedTask(operationID, row)
            if (attemptID != null) retainedAccess.claimWriter(operationID, attemptID, id)
            val deferred = exportScope.async(CoroutineName(id), start = CoroutineStart.LAZY) {
                try {
                    maintenance.withLock {
                        val work = currentCoroutineContext()
                        val check = { work.ensureActive(); dispatch.requireCurrent(epoch); Unit }
                        check()
                        val result = body(check)
                        persistRetainedTask(operationID, row.copy().put("status", "completed").put("endedAt", now())
                            .put("message", result.optString("message")).put("result", result.copy()))
                        pendingView(pendingStore.get(operationID)); result
                    }
                } catch (failure: Throwable) {
                    withContext(NonCancellable + Dispatchers.IO) { maintenance.withLock {
                        val actual = runCatching { retainedExports.deliveries(operationID) }.getOrNull()
                        val proven = attemptID != null && actual?.optString("attemptID") == attemptID && actual?.optBoolean("readbackProven") == true
                        val complete = proven && actual?.optString("state") == "verified"
                        val message = if (proven) actual!!.optString("message") else if (failure is CancellationException)
                            "本次保留快照操作已停止；原材料保留，外部位置可能已有部分或完整文件，未确认成功。"
                            else "本次保留快照操作未全部完成；请查看原回读事实，原材料和旧历史保留。"
                        val terminal = row.copy().put("status", if (complete) "completed" else if (failure is CancellationException && !proven) "cancelled" else "failed")
                            .put("endedAt", now()).put("message", message)
                        if (actual != null && actual.optString("attemptID") == attemptID) terminal.put("result", actual)
                        persistRetainedTask(operationID, terminal)
                        runCatching { pendingView(pendingStore.get(operationID)) }
                    } }
                    throw failure
                } finally {
                    withContext(NonCancellable + Dispatchers.IO) { maintenance.withLock {
                        attemptID?.let(retainedAccess::release)
                        active.remove(id); exportOwnedJobs.remove(id); refresh()
                    } }
                }
            }
            active[id] = deferred; exportOwnedJobs.add(id); deferred.start(); refresh(); deferred
        }
        return awaitOwnedExport(task, label)
    }
    private suspend fun prepareRetainedDelivery(operationID: String): JSONObject = ownedRetainedTask(
        operationID, "export.retained.prepare", "核验保留的原完整快照") { check ->
        require(exportAttempts.isEmpty() && !retainedAccess.hasDelivery()) { "请先结束当前系统保存，再核验另一份原件" }
        retainedAccess.prepare(operationID, check)
    }
    private suspend fun saveRetainedExport(payload: JSONObject): JSONObject {
        val operationID = payload.getString("operationID"); val attemptID = payload.getString("attemptID")
        val uri = requireExportDestination(payload.getString("uri"))
        // Validate before creating a control task; a cold/old callback may not create a new attempt.
        maintenance.withLock { retainedAccess.lease(operationID, attemptID) }
        return ownedRetainedTask(operationID, "export.retained.save", "另存并回读保留的原快照", attemptID) { check ->
            val original = retainedAccess.lease(operationID, attemptID)
            check()
            retainedExports.save(original.delivery, uri.toString(), openOutput = {
                check()
                context.contentResolver.openOutputStream(uri, "wt") ?: error("无法写入用户选择的位置，原快照保留")
            }, verifier = { _, expectedSHA, expectedBytes ->
                verifyExportDestinationBytes(uri, expectedSHA, expectedBytes, check)
            }).also { result ->
                result.put("saved", true).put("verified", result.optBoolean("readbackProven"))
                    .put("documentID", original.snapshot.documentID)
            }
        }
    }

}
