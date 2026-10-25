package com.nanless.paperdigest

import android.content.Context
import android.net.Uri
import androidx.work.*
import com.nanless.paperdigest.cloud.*
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.model.StudyService
import com.nanless.paperdigest.pdf.*
import com.nanless.paperdigest.secret.SecretVault
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
class RootController(private val context: Context, private val installBackground: Boolean = true): AppController {
    private val research = File(context.noBackupFilesDir, "PaperDigest").canonicalFile
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
    private val secrets = SecretVault(context)
    private val modelKeyBinding = ModelKeyBinding(File(context.noBackupFilesDir, "PaperDigestDevice"))
    private val model = StudyService(personal, { modelKeyBinding.requireEndpoint(personal.settings().getString("endpoint")); secrets.load("model.primary") })
    private val exports = ExportService(context, personal, model, library::publishedRecords)
    private val capacity = StorageCapacity(research, File(context.noBackupFilesDir, "PaperDigestTransfers/Exports").canonicalFile,
        File(context.noBackupFilesDir, "PaperDigestCloud").canonicalFile, File(context.noBackupFilesDir, "PaperDigestDevice").canonicalFile)
    private val exportDestinationVerifier: ExportDestinationVerifier = { uri, sha, bytes -> verifyExportDestination(uri, sha, bytes) }
    private val maintenance = Mutex()
    private val dispatch = WorkspaceDispatch(File(context.noBackupFilesDir, "PaperDigestDevice"))
    private val generation = AtomicLong(0)
    private val active = ConcurrentHashMap<String, Job>()
    private val restores = ConcurrentHashMap<String, BackupCodec.Staged>()
    private val _state = MutableStateFlow(UiState())
    override val state: StateFlow<UiState> = _state
    private val workspace = object: CloudWorkspace {
        override suspend fun capture(output: File): BackupCodec.Captured = maintenance.withLock {
            require(active.keys.none { id -> personal.snapshot().getJSONArray("jobs").objects().any { it.optString("id") == id && !it.optString("kind").startsWith("cloud.") } }) { "请等当前资料任务结束再完整备份" }
            val snapshot = BackupCodec.capture(research, output)
            val id = currentCoroutineContext()[CoroutineName]?.name
            if (id != null) personal.snapshot().getJSONArray("jobs").objects().firstOrNull { it.optString("id") == id }?.let { row ->
                personal.upsertJob(row.copy().put("material", JSONObject().put("kind", "完整研究快照").put("createdAt", now()).put("fileCount", snapshot.fileCount).put("sha256", snapshot.sha256).put("encodedBytes", snapshot.encodedBytes)))
            }
            snapshot
        }
        override suspend fun restore(staged: BackupCodec.Staged) = maintenance.withLock {
            require(active.isEmpty()) { "请先结束当前任务再恢复完整资料" }
            require(personal.snapshot().getJSONArray("jobs").objects().none { it.optString("status") in listOf("queued", "running") }) { "请先停止或完成已排队的任务，再恢复研究资料" }
            dispatch.rotate()
            RestorePolicy.install(staged, research) { personal.reload(); personal.retireRestoredDispatch(); library.reload() }
            offlineReading = null
            generation.incrementAndGet()
            _state.update { it.copy(selectedPaperId = null, article = null, pdfDocument = null, pdfMode = false, pdfSelection = null, pdfPage = 1) }
            refresh()
        }
    }
    val cloud = CloudService(research, File(context.noBackupFilesDir, "PaperDigestCloud").canonicalFile, secrets, workspace, scheduleChanged = { scheduleCloud(it) })
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
    }

    private fun refresh() {
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
            reading.copy(readingMaterialID = readingID(reading), personal = p, settings = p.getJSONObject("settings").copy(), jobs = p.getJSONArray("jobs").objects(),
            sessions = p.getJSONArray("sessions").objects(), cloud = cloud.state(), zotero = zoteroView, catalogSyncedAt = library.summary().nullableString("syncedAt"), catalogSummary = library.summary(), storageWarning = personal.startupPersistenceWarning, busy = active.isNotEmpty(), offlinePaperIDs = library.offlinePaperIDs()) }
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
    private fun requireReading(access: ReadingAccess, pdfRequired: Boolean = false) {
        require(access.owner != null && _state.value.selectedPaperId == access.owner && generation.get() == access.generation) { "论文已经切换，原操作没有取得新论文的材料或派发权限" }
        if (pdfRequired) require(access.pdfSHA != null && _state.value.pdfDocument?.sha256 == access.pdfSHA) { "PDF 原件已经切换，未采用另一版本的页码或选区" }
    }
    private fun updateReading(access: ReadingAccess, pdfRequired: Boolean = false, update: (UiState) -> UiState) {
        _state.update { current ->
            require(access.owner != null && current.selectedPaperId == access.owner && generation.get() == access.generation) { "论文已经切换，旧视图没有覆盖新阅读空间" }
            if (pdfRequired) require(access.pdfSHA != null && current.pdfDocument?.sha256 == access.pdfSHA) { "PDF 原件已经切换，旧页码没有覆盖新原件" }
            update(current)
        }
    }

    override suspend fun execute(command: String, payload: JSONObject): JSONObject {
        // A cancelled search must not reset reader drafts or turn into a global task error.
        if (command == "library.search") return withContext(Dispatchers.IO) { maintenance.withLock { library.searchCached(payload.getString("query")) } }
        val current = _state.value
        val access = ReadingAccess(current.selectedPaperId, generation.get(), current.pdfDocument?.sha256, current.pdfSelection, current.pdfPage, readingID(current))
        return withContext(Dispatchers.IO) { executeBound(command, payload.copy(), access) }
    }
    private suspend fun executeBound(command: String, payload: JSONObject, access: ReadingAccess): JSONObject {
        try {
            _state.update { it.copy(error = null, notice = null) }
            val result = when (command) {
                "app.bootstrap" -> { refresh(); val z = zotero.execute("zotero.state", JSONObject()); _state.update { it.copy(zotero = z) }; JSONObject().put("ready", true) }
                "library.sync" -> runTask(command) { maintenance.withLock { library.sync { _, _, message -> _state.update { it.copy(notice = message) } } } }
                "paper.open" -> openPaper(payload.getString("paperID"), payload.optBoolean("refresh"))
                "pdf.open" -> runTask(command, access.owner.orEmpty()) {
                    val result = maintenance.withLock { requireReading(access); val owner = selected(); val original = currentPDF(owner); pdf.importFile(original.first, owner.title + ".pdf") }
                    requireReading(access)
                    val owner = selected()
                    val page = personal.snapshot().getJSONObject("readingState").optJSONObject(owner.id)?.optInt("pdfPage", 1)?.coerceIn(1, result.pageCount) ?: 1
                    updateReading(access) { it.copy(pdfDocument = result, pdfMode = true, pdfPage = page, pdfSelection = null, pdfReceipt = currentPDFReceipt(owner)) }
                    JSONObject().put("opened", true).put("pages", result.pageCount).put("sha256", result.sha256)
                }
                "pdf.close" -> { updateReading(access) { it.copy(pdfMode = false, pdfSelection = null) }; JSONObject().put("closed", true) }
                "pdf.annotation.open" -> openAnnotation(payload.getString("id"), access)
                "pdf.outline" -> maintenance.withLock {
                    requireReading(access, true); val document = _state.value.pdfDocument ?: error("PDF 尚未打开")
                    val chapters = pdf.outline(document); requireReading(access, true)
                    JSONObject().put("pdfSHA", document.sha256).put("chapters", JSONArray(chapters.map { c -> JSONObject().put("index", c.index).put("title", c.title).put("page", c.page).put("endPage", c.endPage).put("depth", c.depth) }))
                }
                "ui.pdfError" -> { val message = payload.optString("message", "原文显示未完成").take(500); _state.update { it.copy(error = message) }; JSONObject().put("reported", true) }
                "pdf.import" -> runTask(command) { maintenance.withLock {
                    val document = pdf.importPdf(Uri.parse(payload.getString("uri")))
                    val p = Paper(document.id, document.displayName.removeSuffix(".pdf"), sourceKind = "local", identityStatus = "local-original", localPDFPath = document.localPath, pdfSHA256 = document.sha256)
                    personal.rememberPaper(p)
                    if (generation.get() == access.generation) {
                        offlineReading = null
                        generation.incrementAndGet()
                        _state.update { it.copy(selectedPaperId = p.id, viewedPaper = Paper.fromJson(p.json()), article = null, pdfDocument = document, pdfMode = true, pdfPage = 1, pdfSelection = null, pdfReceipt = JSONObject().put("paperID", p.id).put("sha256", document.sha256).put("version", JSONObject.NULL).put("isStale", false).put("currentness", "local-original")) }
                    }
                    JSONObject().put("paperID", p.id).put("pageCount", document.pageCount)
                } }
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
                "storage.openPackage" -> runTask(command) { maintenance.withLock {
                    val operation = generation.incrementAndGet(); val opened = offline.open(payload.getString("id"))
                    require(generation.get() == operation) { "阅读上下文已经切换，离线包未覆盖新视图" }
                    personal.rememberPaper(opened.paper); offlineReading = opened
                    _state.update { previous -> require(generation.get() == operation); previous.copy(selectedPaperId = opened.paper.id, viewedPaper = Paper.fromJson(opened.paper.json()), article = library.prepareOfflineArticle(opened.article), pdfMode = false, pdfDocument = null, pdfReceipt = JSONObject(), pdfSelection = null, pdfPage = 1) }
                    JSONObject().put("opened", true).put("paperID", opened.paper.id).put("packageID", opened.id).put("offlineMode", true)
                } }
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
                    val id = payload.getString("id"); active[id]?.cancel()
                    runCatching { WorkManager.getInstance(context).cancelWorkById(UUID.fromString(id)) }
                    personal.session(id)?.let { session -> if (!session.optBoolean("requestIssued")) personal.appendSession(session.put("status", "cancelled")) }
                    personal.snapshot().getJSONArray("jobs").objects().firstOrNull { it.optString("id") == id && it.optString("status") == "queued" }?.let { personal.upsertJob(it.copy().put("status", "cancelled").put("endedAt", now()).put("message", "已取消尚未发出的研究任务")) }
                    JSONObject().put("cancelRequested", true).put("message", "已请求停止；已发出的请求可能已经产生费用")
                }
                "settings.save" -> maintenance.withLock { val changes = payload.optJSONObject("changes") ?: payload; validateSettings(changes); personal.updateSettings(changes); scheduleCatalog(); JSONObject().put("saved", true) }
                "export.prepare" -> maintenance.withLock {
                    require(active.isEmpty()) { "请待当前任务结束再导出完整材料" }
                    val format = payload.getString("format")
                    val sessionID = payload.nullableString("sessionID")
                    val historical = sessionID?.let { personal.session(it) ?: error("原研究记录不存在") }
                    require(historical == null || format in listOf("research-json", "research-md", "research-html")) { "原研究只能按其实际材料导出" }
                    val p = if (historical != null) null else _state.value.selectedPaperId?.let { selected() }
                    if (historical == null && format !in listOf("backup", "diagnostics")) requireReading(access)
                    // An old session is exported by its original owner, never by the currently open paper.
                    val article = if (historical != null) null else if (p != null && format == "guide-html" && offlineReading == null) library.article(p) else _state.value.article
                    val original = if (format == "paper-pdf") {
                        val opened = _state.value.pdfDocument
                        if (opened != null) {
                            requireReading(access, true)
                            val receipt = _state.value.pdfReceipt
                            require(receipt.optString("paperID", p?.id.orEmpty()) == p?.id && receipt.optString("sha256") == opened.sha256) { "实际原文与阅读回执不符" }
                            StoragePaths.resolve(opened.localPath, research, opened.sha256, 200 * 1024 * 1024L)
                        } else currentPDF(p ?: error("请先选择论文")).first
                    } else null
                    val prepared = exports.prepare(format, p, article, original, payload.nullableString("sessionID")).json()
                    if (historical == null && format !in listOf("backup", "diagnostics")) requireReading(access)
                    prepared
                }
                "export.save" -> maintenance.withLock {
                    val uri = requireExportDestination(payload.getString("uri")); val id = payload.getString("documentID")
                    val result = exports.save(uri, id)
                    try {
                        capacity.markExportSaved(id, uri.toString(), exportDestinationVerifier)
                        // A provider may decline persistence; future cleanup still requires an actual successful read.
                        val persistent = runCatching { context.contentResolver.takePersistableUriPermission(uri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION); true }.getOrDefault(false)
                        result.put("verified", true).put("persistentRead", persistent).put("message", "已写入所选位置，并完整回读核对字节与 SHA")
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) {
                        result.put("verified", false).put("message", "文件已交给所选位置，但完整回读或本机记录尚未确认；临时副本保留，不授予清理资格。")
                    }
                }
                "app.restore.prepare" -> runTask(command) {
                    val uri = Uri.parse(payload.getString("uri")); require(uri.scheme == "content")
                    val staged = context.contentResolver.openInputStream(uri)?.use { BackupCodec.stage(it, research.parentFile!!) } ?: error("无法打开备份")
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
                            val actual = if (command in listOf("zotero.archive", "zotero.resume")) runTask(command, access.owner.orEmpty()) { zotero.execute(command, bound) } else zotero.execute(command, bound)
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
                        _state.update { it.copy(zotero = z) }; result
                    }
                    else -> throw AppFailure("unsupported", "这个操作尚不受支持：$command")
                }
            }
            refresh()
            return result
        } catch (cancelled: CancellationException) {
            refresh(); _state.update { it.copy(error = "已取消；已有完整资料和已产生的用量记录保留") }; throw cancelled
        } catch (error: Exception) {
            refresh()
            val message = when (error) { is AppFailure, is CloudFailure, is IllegalArgumentException, is IllegalStateException -> error.message ?: "操作未完成"; else -> "操作未完成，原资料已保留；请检查连接、权限或所选文件" }
            _state.update { it.copy(error = message) }; throw AppFailure("operation", message)
        }
    }

    private suspend fun openPaper(id: String, refresh: Boolean = false): JSONObject {
        val p = paper(id); val captured = generation.incrementAndGet()
        offlineReading = null
        _state.update { it.copy(selectedPaperId = id, viewedPaper = Paper.fromJson(p.json()), article = null, pdfDocument = null, pdfMode = false, pdfSelection = null, pdfReceipt = JSONObject(), loading = p.blogURL.isNotEmpty()) }
        if (p.blogURL.isNotEmpty()) try {
            val a = maintenance.withLock { library.article(p, refresh) }
            if (captured == generation.get()) _state.update { it.copy(article = a, loading = false) }
        } catch (e: Exception) { if (captured == generation.get()) _state.update { it.copy(loading = false) }; throw e }
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
    private suspend fun runTask(kind: String, paperID: String = "", body: suspend () -> JSONObject): JSONObject {
        val id = UUID.randomUUID().toString(); val job = currentCoroutineContext()[Job]!!
        val row = JSONObject().put("id", id).put("kind", kind).put("paperID", paperID).put("status", "running").put("createdAt", now()).put("startedAt", now())
        maintenance.withLock { personal.upsertJob(row); active[id] = job }; refresh()
        try { val result = withContext(CoroutineName(id)) { body() }; val latest = personal.snapshot().getJSONArray("jobs").objects().firstOrNull { it.optString("id") == id } ?: row; personal.upsertJob(latest.put("status", "completed").put("endedAt", now()).put("message", if (kind.endsWith("restore.prepare")) "完整材料校验完成，等待明确确认；尚未恢复研究资料" else "已完成")); return result }
        catch (e: Exception) { val latest = personal.snapshot().getJSONArray("jobs").objects().firstOrNull { it.optString("id") == id } ?: row; personal.upsertJob(latest.put("status", if (e is CancellationException) "cancelled" else "failed").put("endedAt", now()).put("message", if (e is CancellationException) "已停止，原材料保留" else "未完成，请查看对应设置或检查点")); throw e }
        finally { active.remove(id); refresh() }
    }
    private suspend fun prepareStudy(command: String, payload: JSONObject, access: ReadingAccess): JSONObject = maintenance.withLock {
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
        val prepared = model.prepare(p?.id ?: "configuration-check", if (command == "model.check") "请只回复连接成功。" else payload.getString("question"), evidence, source, payload.optBoolean("force"))
        if (command != "model.check") {
            try { requireReading(access, payload.optString("evidenceKind", "guide") != "guide") }
            catch (e: Exception) { if (!prepared.optBoolean("reused")) personal.appendSession(prepared.copy().put("status", "cancelled").put("error", "准备期间阅读上下文变化，未派发请求")); throw e }
        }
        if (prepared.optBoolean("reused")) return@withLock prepared
        val id = prepared.getString("id"); val work = OneTimeWorkRequestBuilder<StudyWorker>().setId(UUID.fromString(id)).setInputData(workDataOf("sessionID" to id, "workspaceEpoch" to dispatch.epoch)).setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).addTag("paperdigest-paid-study").build()
        personal.upsertJob(JSONObject().put("id", id).put("kind", command).put("paperID", p?.id.orEmpty()).put("status", "queued").put("createdAt", now()).put("message", "等待系统执行；未发出的请求不会产生模型用量"))
        WorkManager.getInstance(context).enqueueUniqueWork("paperdigest-study-$id", ExistingWorkPolicy.KEEP, work)
        prepared.put("queued", true)
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
    override suspend fun updateSecret(kind: SecretKind, value: String?) = withContext(Dispatchers.IO) {
        if (kind == SecretKind.CLOUD) cloud.setPassword(value) else {
            val scope = if (kind == SecretKind.MODEL) "model.primary" else "zotero.primary"
            if (kind == SecretKind.MODEL) {
                maintenance.withLock {
                    val endpoint = if (value != null) StudyService.validatedConfig(personal.settings()).getString("endpoint") else ""
                    modelKeyBinding.clear()
                    if (value == null) secrets.remove(scope) else { secrets.save(scope, value); modelKeyBinding.bind(endpoint) }
                }
            } else if (value == null) secrets.remove(scope) else secrets.save(scope, value)
            if (kind == SecretKind.ZOTERO) { zotero.credentialsChanged(); val z = zotero.state(); _state.update { it.copy(zotero = z) } }
        }
        refresh()
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
    private suspend fun openAnnotation(id: String, access: ReadingAccess): JSONObject = maintenance.withLock {
        requireReading(access)
        val p = selected(); val mark = personal.annotations(p.id).firstOrNull { it.optString("id") == id } ?: error("批注不存在或属于其他论文")
        val hash = mark.getString("pdfSHA"); require(BackupCodec.validSHA(hash))
        val file = listOf(File(research, "Imports/$hash.pdf"), File(research, "PublishedLibrary/pdf/$hash.pdf")).firstOrNull { it.isFile && runCatching { StoragePaths.resolve(it.absolutePath, research, hash); true }.getOrDefault(false) }
            ?: throw AppFailure("missing", "这条标注对应的旧 SHA 原文尚未保存在本机，未跳转到另一版本的 PDF")
        val document = pdf.importFile(file, p.title + ".pdf"); val page = mark.getInt("page"); require(page in 1..document.pageCount)
        val oldVersion = mark.nullableString("sourceVersion")
        val receipt = JSONObject().put("paperID", p.id).put("sha256", hash).put("version", oldVersion ?: JSONObject.NULL).put("sourceURL", mark.optString("sourceURL"))
            .put("isStale", oldVersion == null || oldVersion != p.sourceVersion).put("currentness", "annotation-bound-original").put("notices", JSONArray(listOf("按标注的原 PDF SHA 打开；原文版本 ${oldVersion ?: "未标注"}，不代表网站当前版本。")))
        updateReading(access) { it.copy(pdfDocument = document, pdfPage = page, pdfMode = true, pdfSelection = null, pdfReceipt = receipt) }
        JSONObject().put("opened", true).put("page", page).put("sha256", hash)
    }
    private fun restoreToken(staged: BackupCodec.Staged): JSONObject {
        val id = UUID.randomUUID().toString(); restores[id] = staged
        return JSONObject().put("restoreID", id).put("fileCount", staged.entries.size).put("sha256", staged.encodedSHA256).put("message", "完整备份已通过逐文件校验。恢复后将回到此快照；保留本机连接、实际派发计数和恢复前副本。")
    }
    private suspend fun cloudCommand(command: String, payload: JSONObject): JSONObject = when (command) {
        "cloud.state" -> cloud.state()
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
        "cloud.list" -> JSONObject().put("snapshots", JSONArray(cloud.list(payload.getString("month")).map { row -> val r = row.getJSONObject("reference"); row.copy().put("month", r.getString("month")).put("id", r.getString("id")) }))
        "cloud.restore.prepare" -> runTask(command) { val prepared = cloud.prepareRestore(CloudReference(payload.getString("month"), payload.getString("id"))); restoreToken(prepared.staged).put("reference", prepared.manifest.reference.json()) }
        "cloud.archivePending" -> cloud.archivePending()
        "cloud.retained.list" -> JSONObject().put("retained", cloud.retainedList())
        "retained.list" -> JSONObject().put("transfers", JSONArray(cloud.retainedList().objects().map { row -> row.copy().put("id", row.optString("transferID", row.optString("id"))) }))
        "retained.export.prepare" -> exports.register(cloud.retainedSnapshot(payload.getString("transferID")), "application/octet-stream", "论文速递-保留快照.paperdigest").json()
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
        val digest = java.security.MessageDigest.getInstance("SHA-256"); var actual = 0L
        val operationContext = currentCoroutineContext()
        context.contentResolver.openInputStream(uri)?.use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                operationContext.ensureActive()
                val count = input.read(buffer); if (count < 0) break
                actual += count; require(actual <= expectedBytes) { "所选位置返回的文件长度与原件不符" }
                digest.update(buffer, 0, count)
            }
        } ?: throw AppFailure("storage", "无法重新读取所选导出文件，原临时副本保留")
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
}
