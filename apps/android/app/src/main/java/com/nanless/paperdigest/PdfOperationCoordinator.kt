package com.nanless.paperdigest

import android.net.Uri
import com.nanless.paperdigest.cloud.BackupCodec
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.pdf.*
import com.nanless.paperdigest.ui.PdfUnlockPrompt
import com.nanless.paperdigest.ui.UiState
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/** Coordinates PDF single/batch import, password unlock sessions, portable annotations, and study-source navigation. */
internal class PdfOperationCoordinator(
    private val research: File,
    private val personal: PersonalStore,
    private val pdf: PdfRepository,
    private val pdfAdmission: Mutex,
    private val pdfAcquisition: AtomicReference<Deferred<JSONObject>?>,
    private val pdfCommittedResults: ConcurrentHashMap<String, JSONObject>,
    private val active: ConcurrentHashMap<String, Job>,
    private val generation: AtomicLong,
    private val scope: () -> CoroutineScope,
    private val maintenance: () -> Mutex,
    private val currentState: () -> UiState,
    private val updateState: ((UiState) -> UiState) -> Unit,
    private val updateReading: (ReadingAccess, Boolean, (UiState) -> UiState) -> Unit,
    private val requireCurrentEpoch: (String) -> Unit,
    private val requireReading: (ReadingAccess, Boolean) -> Unit,
    private val clearOfflineReading: () -> Unit,
    private val selectedPaper: () -> Paper,
    private val findPaper: (String) -> Paper,
    private val catalogPapers: () -> List<Paper>,
    private val cachedPDFBySHA: suspend (String) -> File?,
    private val currentPDF: suspend (Paper) -> Pair<File, String>,
    private val currentPDFReceipt: (Paper) -> JSONObject,
    private val originalStudySession: (String) -> JSONObject,
    private val requireSavedStudySource: (String) -> SavedStudySource,
    private val runTask: suspend (String, String, () -> Unit, String?, Int?, String, suspend () -> JSONObject) -> JSONObject,
    private val onRefresh: () -> Unit,
) {
    private val pdfBatchSequence = AtomicLong(0)
    private val pdfUnlocks = PdfUnlockMailbox { prompt -> updateState { it.copy(pdfUnlockPrompt = prompt) } }

    fun requirePdfAcquisition(access: ReadingAccess, allowEmpty: Boolean = false) {
        require((allowEmpty || access.owner != null) && currentState().selectedPaperId == access.owner && generation.get() == access.generation) {
            "阅读空间已切换，原解锁请求没有取得另一论文的权限"
        }
    }

    suspend fun stopPdfAcquisition(retireQueuedBatch: Boolean = true) {
        if (retireQueuedBatch) pdfBatchSequence.incrementAndGet()
        val original = pdfAcquisition.get() ?: return
        original.cancel()
        original.join()
    }

    suspend fun unlockPdf(requestID: String, password: CharArray) {
        pdfUnlocks.submit(requestID, password)
    }

    suspend fun cancelPdfUnlock(requestID: String) {
        val original = pdfUnlocks.requestStop(requestID) ?: throw AppFailure("stale", "这份原文的解锁请求已经结束")
        original.join()
    }

    fun importPdfs(uris: List<Uri>, epoch: String): Deferred<JSONObject> {
        val selectedUris = uris.toList()
        require(selectedUris.isNotEmpty() && selectedUris.all { it.scheme == "content" }) { "请通过系统文件选择器选择 PDF" }
        val current = currentState()
        val initial = ReadingAccess(
            current.selectedPaperId,
            generation.get(),
            current.pdfDocument?.sha256,
            current.pdfSelection,
            current.pdfPage,
            current.readingMaterialID
        )
        val ticket = pdfBatchSequence.incrementAndGet()
        lateinit var task: Deferred<JSONObject>
        task = scope().async(start = CoroutineStart.LAZY) {
            try {
                pdfAdmission.withLock {
                    if (ticket != pdfBatchSequence.get()) throw CancellationException("这份选择已被后来的文件操作替代，未读取旧列表")
                    stopPdfAcquisition(retireQueuedBatch = false)
                    if (ticket != pdfBatchSequence.get()) throw CancellationException("这份选择已被后来的文件操作替代，未读取旧列表")
                    requireCurrentEpoch(epoch)
                    requirePdfAcquisition(initial, true)
                    pdfAcquisition.set(task)
                }
                runPdfImportBatch(selectedUris, initial, epoch)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                val message = "本批 PDF 处理未正常结束；已接纳原件保留，请查看任务记录。"
                updateState { it.copy(error = message) }
                throw AppFailure("operation", message)
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
        val row = JSONObject()
            .put("id", id)
            .put("kind", "pdf.import.batch")
            .put("paperID", "")
            .put("title", "导入所选 PDF（${uris.size} 份）")
            .put("identity", "本机所选原件")
            .put("status", "running")
            .put("createdAt", now())
            .put("startedAt", now())

        suspend fun persist(status: String) {
            maintenance().withLock {
                val latest = personal.snapshot().getJSONArray("jobs").objects().firstOrNull { it.optString("id") == id } ?: row.copy()
                latest.put("status", status).put("result", progress.snapshot(status)).put("message", progress.message())
                if (status != "running") latest.put("endedAt", now())
                personal.upsertJob(latest)
            }
            onRefresh()
        }

        maintenance().withLock {
            requireCurrentEpoch(epoch)
            requirePdfAcquisition(initial, true)
            operation.ensureActive()
            personal.upsertJob(row.copy().put("result", progress.snapshot("running")).put("message", progress.message()))
            active[id] = job
        }
        onRefresh()
        updateState { it.copy(notice = progress.message(), error = null) }
        var currentIndex = -1
        var accepted: AtomicReference<JSONObject?>? = null
        var terminalFailure: Throwable? = null
        var cancelled = false
        try {
            for ((index, uri) in uris.withIndex()) {
                operation.ensureActive()
                requireCurrentEpoch(epoch)
                val access = maintenance().withLock {
                    requireCurrentEpoch(epoch)
                    operation.ensureActive()
                    val current = currentState()
                    ReadingAccess(
                        current.selectedPaperId,
                        generation.get(),
                        current.pdfDocument?.sha256,
                        current.pdfSelection,
                        current.pdfPage,
                        current.readingMaterialID
                    ).also { requirePdfAcquisition(it, true) }
                }
                currentIndex = index
                val childID = UUID.randomUUID().toString()
                val acceptedItem = AtomicReference<JSONObject?>(null)
                accepted = acceptedItem
                progress.begin(index, childID)
                persist("running")
                try {
                    val actual = runTask(
                        "pdf.import",
                        "",
                        { requireCurrentEpoch(epoch); requirePdfAcquisition(access, true) },
                        id,
                        index,
                        childID,
                    ) {
                        importPdfOriginal(uri, access, epoch) { facts -> acceptedItem.set(facts.copy()) }
                    }
                    progress.completed(index, actual)
                } catch (_: PdfInvalidDocumentException) {
                    progress.failed(index)
                }
                persist("running")
                currentIndex = -1
                accepted = null
            }
        } catch (failure: Throwable) {
            terminalFailure = failure
            cancelled = failure is CancellationException
            if (currentIndex >= 0 && progress.status(currentIndex) == "running") {
                val committed = accepted?.get()
                if (committed != null) progress.completed(currentIndex, committed)
                else if (cancelled) progress.cancelled(currentIndex)
                else progress.failed(currentIndex)
            }
        } finally {
            withContext(NonCancellable) {
                try {
                    persist(progress.finalStatus(cancelled))
                } catch (recordFailure: Throwable) {
                    if (terminalFailure != null) terminalFailure!!.addSuppressed(recordFailure) else terminalFailure = recordFailure
                    updateState { it.copy(error = "批次记录未能完整保存；已接纳原件保留，未开始的文件没有报告成功。") }
                } finally {
                    active.remove(id)
                    onRefresh()
                }
            }
        }
        val status = progress.finalStatus(cancelled)
        val result = progress.snapshot(status).put("jobID", id).put("message", progress.message())
        updateState { it.copy(notice = progress.message()) }
        terminalFailure?.let { throw it }
        return result
    }

    suspend fun ownedPdfAcquisition(
        kind: String,
        access: ReadingAccess,
        epoch: String,
        allowEmpty: Boolean = kind == "pdf.import",
        ledgerOwner: String = if (kind == "pdf.import") "" else access.owner.orEmpty(),
        body: suspend () -> JSONObject,
    ): JSONObject {
        val task = pdfAdmission.withLock {
            stopPdfAcquisition()
            requirePdfAcquisition(access, allowEmpty)
            val deferred = scope().async(start = CoroutineStart.LAZY) {
                runTask(
                    kind,
                    ledgerOwner,
                    { requireCurrentEpoch(epoch); requirePdfAcquisition(access, allowEmpty) },
                    null,
                    null,
                    UUID.randomUUID().toString(),
                    body
                )
            }
            pdfAcquisition.set(deferred)
            deferred.invokeOnCompletion { pdfAcquisition.compareAndSet(deferred, null) }
            deferred.start()
            deferred
        }
        try {
            return task.await()
        } catch (cancelled: CancellationException) {
            updateState {
                it.copy(
                    notice = if (task.isActive) "原文准备仍在应用内进行；关闭等待窗口没有停止原任务。"
                    else "原文准备已结束；请查看原任务的实际结果，原件保留。"
                )
            }
            throw cancelled
        }
    }

    suspend fun openCurrentPaperPdf(command: String, access: ReadingAccess, dispatchAtStart: String): JSONObject =
        ownedPdfAcquisition(command, access, dispatchAtStart) {
            val prepared = maintenance().withLock {
                requireReading(access, false)
                val owner = selectedPaper()
                val original = currentPDF(owner)
                Triple(owner, original, currentPDFReceipt(owner))
            }
            val operation = currentCoroutineContext()
            val check = { operation.ensureActive(); requireCurrentEpoch(dispatchAtStart); requireReading(access, false) }
            val session = pdf.prepareFileImport(prepared.second.first, prepared.first.title + ".pdf", prepared.second.second, check)
            val imported = finishPdfSession(session, "open", check)
            adoptPdfResult(imported, check) { document ->
                val page = personal.snapshot().getJSONObject("readingState")
                    .optJSONObject(prepared.first.id)?.optInt("pdfPage", 1)?.coerceIn(1, document.pageCount) ?: 1
                updateReading(access, false) {
                    it.copy(pdfDocument = document, pdfMode = true, pdfPage = page, pdfSelection = null, pdfReceipt = prepared.third)
                }
                JSONObject().put("opened", true).put("pages", document.pageCount).put("sha256", document.sha256)
            }
        }

    suspend fun importPdfOriginal(
        uri: Uri,
        access: ReadingAccess,
        epoch: String,
        onAccepted: (JSONObject) -> Unit = {},
    ): JSONObject {
        val operation = currentCoroutineContext()
        val check = { operation.ensureActive(); requireCurrentEpoch(epoch); requirePdfAcquisition(access, true) }
        val session = pdf.prepareImport(uri, check)
        val result = finishPdfSession(session, "import", check)
        return adoptPdfResult(result, check) { document ->
            val p = Paper(
                document.id,
                document.displayName.removeSuffix(".pdf"),
                sourceKind = "local",
                identityStatus = "local-original",
                localPDFPath = document.localPath,
                pdfSHA256 = document.sha256,
            )
            personal.rememberPaper(p)
            pdf.acceptImport(result)
            clearOfflineReading()
            generation.incrementAndGet()
            updateState {
                it.copy(
                    selectedPaperId = p.id,
                    viewedPaper = Paper.fromJson(p.json()),
                    article = null,
                    pdfDocument = document,
                    pdfMode = true,
                    pdfPage = 1,
                    pdfSelection = null,
                    pdfReceipt = JSONObject()
                        .put("paperID", p.id)
                        .put("sha256", document.sha256)
                        .put("version", JSONObject.NULL)
                        .put("isStale", false)
                        .put("currentness", "local-original"),
                )
            }
            JSONObject().put("paperID", p.id).put("pageCount", document.pageCount).put("sha256", document.sha256)
                .also { onAccepted(it) }
        }
    }

    private suspend fun finishPdfSession(session: PdfImportSession, purpose: String, check: () -> Unit): PdfImportedOriginal {
        var result: PdfImportedOriginal? = null
        try {
            var promptMessage: String? = null
            while (true) {
                check()
                try {
                    result = if (!session.passwordRequired && promptMessage == null) {
                        pdf.finishImport(session, null, check)
                    } else {
                        val prompt = PdfUnlockPrompt(UUID.randomUUID().toString(), session.displayName.take(250), purpose, promptMessage)
                        val lifetime = pdfAcquisition.get() ?: error("本次原生解锁作业已结束")
                        pdfUnlocks.awaitAndUse(prompt, check, lifetime = lifetime) { password ->
                            pdf.finishImport(session, password, check)
                        }
                    }
                    check()
                    return result!!
                } catch (_: PdfPasswordRequiredException) {
                    promptMessage = "密码为空或不正确，请重新输入本次原文密码。"
                }
            }
        } catch (failure: Throwable) {
            withContext(NonCancellable) {
                try {
                    result?.let { pdf.finalizeImport(it, false) } ?: pdf.cancelImport(session)
                } catch (cleanup: Throwable) {
                    failure.addSuppressed(cleanup)
                }
            }
            throw failure
        }
    }

    private suspend fun adoptPdfResult(
        result: PdfImportedOriginal,
        check: () -> Unit,
        commit: (PdfDocumentRef) -> JSONObject,
    ): JSONObject {
        var accepted = false
        try {
            check()
            pdf.verifyImport(result, check)
            return withContext(NonCancellable) {
                maintenance().withLock {
                    check()
                    val answer = commit(result.document)
                    pdf.acceptImport(result)
                    accepted = true
                    currentCoroutineContext()[CoroutineName]?.name?.let { id -> pdfCommittedResults[id] = answer.copy() }
                    answer
                }
            }
        } finally {
            withContext(NonCancellable) { pdf.finalizeImport(result, accepted) }
        }
    }

    suspend fun highlight(payload: JSONObject, access: ReadingAccess, workspaceEpoch: String): JSONObject = maintenance().withLock {
        requireCurrentEpoch(workspaceEpoch)
        requireReading(access, true)
        val state = currentState()
        require(state.pdfSelection == access.selection) { "原文选区已经变化，未保存另一段文字" }
        val d = state.pdfDocument ?: error("PDF 尚未打开")
        val p = selectedPaper()
        val selection = state.pdfSelection ?: error("请先选择实际 PDF 文字")
        val receipt = state.pdfReceipt.copy()
        require(receipt.optString("paperID", p.id) == p.id && receipt.optString("sha256") == d.sha256) { "标注的来源回执不属于此原件" }
        val annotation = pdf.prepareAnnotation(d, selection, payload.optString("comment"))
        val marks = pdf.portableMarks(d, annotation)
        require(marks.isNotEmpty()) { "没有可保存的实际页坐标" }
        val complete = marks.map { mark ->
            mark.put("pages", JSONArray(listOf(mark.getInt("page"))))
                .put("sourceVersion", receipt.opt("version") ?: JSONObject.NULL)
                .put("sourceURL", receipt.optString("sourceURL"))
        }
        personal.replaceAnnotations(p.id, personal.annotations(p.id) + complete)
        JSONObject().put("saved", true).put("groupID", annotation.id).put("marks", JSONArray(marks))
    }

    suspend fun annotationChange(payload: JSONObject, remove: Boolean, access: ReadingAccess, workspaceEpoch: String): JSONObject = maintenance().withLock {
        requireCurrentEpoch(workspaceEpoch)
        requireReading(access, false)
        val p = selectedPaper()
        val id = payload.getString("id")
        val entry = personal.annotations(p.id).firstOrNull { it.optString("id") == id } ?: error("批注不存在或属于其他论文")
        if (payload.has("paperID")) require(payload.getString("paperID") == p.id)
        val group = entry.optString("groupID").takeIf { it.isNotBlank() } ?: id
        val updated = personal.annotations(p.id).mapNotNull { mark ->
            val markGroup = mark.optString("groupID").takeIf { it.isNotBlank() } ?: mark.optString("id")
            if (markGroup != group || mark.optString("pdfSHA") != entry.optString("pdfSHA")) mark
            else if (remove) null
            else mark.copy().put("comment", payload.optString("comment"))
        }
        personal.replaceAnnotations(p.id, updated)
        JSONObject().put("saved", true)
    }

    suspend fun openStudySource(binding: SavedStudySource, page: Int, access: ReadingAccess, epoch: String): JSONObject {
        val operation = currentCoroutineContext()
        val check = {
            operation.ensureActive()
            requireCurrentEpoch(epoch)
            requirePdfAcquisition(access, true)
            val original = originalStudySession(binding.sessionID)
            require(
                original.opt("paperID") == binding.owner &&
                    original.opt("inputSHA256") == binding.inputSHA &&
                    canonical(original.optJSONObject("source")) == binding.sourceJSON
            ) { "原研究来源已变化，未采用另一份输入" }
            require(page in binding.pages) { "页码不属于这次研究的原始输入" }
        }
        val prepared = maintenance().withLock {
            check()
            val owner = currentState().viewedPaper?.takeIf { it.id == binding.owner } ?: findPaper(binding.owner)
            val hash = binding.pdfSHA
            val file = pdf.importedPDFBySHA(hash) ?: cachedPDFBySHA(hash)
                ?: throw AppFailure("missing", "这次研究的原 SHA PDF 未保存在本机或校验失败；未换成当前版本")
            owner to file
        }
        val session = pdf.prepareFileImport(prepared.second, prepared.first.title + ".pdf", binding.pdfSHA, check)
        val result = finishPdfSession(session, "study-source", check)
        return adoptPdfResult(result, check) { document ->
            synchronized(personal) {
                check()
                require(document.sha256 == binding.pdfSHA && page in 1..document.pageCount && binding.pages.all { it in 1..document.pageCount }) {
                    "原研究页码或 PDF 身份不符，未切换原文"
                }
                require(requireSavedStudySource(binding.sessionID) == binding) {
                    "原封存输入、已保存响应材料字节或身份已变化，未切换原文"
                }
                val source = JSONObject(binding.sourceJSON)
                val version = source.nullableString("sourceVersion")?.takeIf { it.isNotBlank() }
                val currentVersion = catalogPapers().firstOrNull { it.id == binding.owner }?.sourceVersion?.takeIf { it.isNotBlank() }
                val differentVersion = version != null && currentVersion != null && version != currentVersion
                val versionNotice = when {
                    differentVersion -> "研究输入登记版本 $version，当前目录登记为 $currentVersion；按原输入 SHA 读取，未换成当前版本。"
                    version == null -> "按本条研究封存输入的原 PDF SHA 读取；输入未登记网站版本，未联网核对当前修订。"
                    else -> "按本条研究封存输入的原 PDF SHA 读取；登记版本 $version，未联网重新核对网站当前修订。"
                }
                val receipt = JSONObject()
                    .put("paperID", binding.owner)
                    .put("sha256", binding.pdfSHA)
                    .put("version", version ?: JSONObject.NULL)
                    .put("sourceURL", source.optString("sourceURL"))
                    .put("sessionID", binding.sessionID)
                    .put("inputSHA256", binding.inputSHA)
                    .put("sourceNavigationID", UUID.randomUUID().toString())
                    .put("currentness", "study-input-bound-original")
                    .put("isStale", differentVersion)
                    .put("notices", JSONArray(listOf(versionNotice)))
                val viewed = Paper.fromJson(prepared.first.json())
                val reading = personal.snapshot().getJSONObject("readingState").optJSONObject(binding.owner)?.copy() ?: JSONObject()
                check()
                personal.saveReading(binding.owner, reading.put("pdfPage", page))
                clearOfflineReading()
                generation.incrementAndGet()
                updateState { current ->
                    current.copy(
                        selectedPaperId = binding.owner,
                        viewedPaper = viewed,
                        article = current.article?.takeIf { current.selectedPaperId == binding.owner && it.paperID == binding.owner },
                        pdfDocument = document,
                        pdfMode = true,
                        pdfPage = page,
                        pdfSelection = null,
                        pdfReceipt = receipt,
                        loading = false,
                    )
                }
                JSONObject()
                    .put("opened", true)
                    .put("paperID", binding.owner)
                    .put("sessionID", binding.sessionID)
                    .put("page", page)
                    .put("sha256", binding.pdfSHA)
            }
        }
    }

    suspend fun openAnnotation(id: String, access: ReadingAccess, epoch: String): JSONObject {
        val prepared = maintenance().withLock {
            requireReading(access, false)
            val p = selectedPaper()
            val mark = personal.annotations(p.id).firstOrNull { it.optString("id") == id } ?: error("批注不存在或属于其他论文")
            val hash = mark.getString("pdfSHA")
            require(BackupCodec.validSHA(hash))
            val file = listOf(File(research, "Imports/$hash.pdf"), File(research, "PublishedLibrary/pdf/$hash.pdf"))
                .firstOrNull { it.isFile && runCatching { StoragePaths.resolve(it.absolutePath, research, hash); true }.getOrDefault(false) }
                ?: throw AppFailure("missing", "这条标注对应的旧 SHA 原文尚未保存在本机，未跳转到另一版本的 PDF")
            Triple(p, mark.copy(), file)
        }
        val operation = currentCoroutineContext()
        val check = { operation.ensureActive(); requireCurrentEpoch(epoch); requireReading(access, false) }
        val hash = prepared.second.getString("pdfSHA")
        val session = pdf.prepareFileImport(prepared.third, prepared.first.title + ".pdf", hash, check)
        val result = finishPdfSession(session, "annotation", check)
        return adoptPdfResult(result, check) { document ->
            val page = prepared.second.getInt("page")
            require(page in 1..document.pageCount)
            val oldVersion = prepared.second.nullableString("sourceVersion")
            val receipt = JSONObject()
                .put("paperID", prepared.first.id)
                .put("sha256", hash)
                .put("version", oldVersion ?: JSONObject.NULL)
                .put("sourceURL", prepared.second.optString("sourceURL"))
                .put("isStale", oldVersion == null || oldVersion != prepared.first.sourceVersion)
                .put("currentness", "annotation-bound-original")
                .put("notices", JSONArray(listOf("按标注的原 PDF SHA 打开；原文版本 ${oldVersion ?: "未标注"}，不代表网站当前版本。")))
            updateReading(access, false) { it.copy(pdfDocument = document, pdfPage = page, pdfMode = true, pdfSelection = null, pdfReceipt = receipt) }
            JSONObject().put("opened", true).put("page", page).put("sha256", hash)
        }
    }
}
