package com.nanless.paperdigest

import android.content.Context
import android.content.Intent
import android.net.Uri
import com.nanless.paperdigest.cloud.BackupCodec
import com.nanless.paperdigest.cloud.CloudService
import com.nanless.paperdigest.data.*
import com.nanless.paperdigest.protocols.ClientProtocols
import com.nanless.paperdigest.ui.UiState
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** Coordinates pending exports, capacity-full native rescue captures, and retained snapshot deliveries. */
internal class PendingExportCoordinator(
    private val context: Context,
    private val research: File,
    private val deviceRoot: File,
    private val pendingControlRoot: File,
    private val personal: PersonalStore,
    private val exports: ExportService,
    private val cloud: () -> CloudService,
    private val capacity: () -> StorageCapacity,
    private val pendingStoreProvider: () -> PendingExportStore,
    private val scope: () -> CoroutineScope,
    private val maintenance: () -> Mutex,
    private val active: ConcurrentHashMap<String, Job>,
    private val currentEpoch: () -> String,
    private val requireCurrentEpoch: (String) -> Unit,
    private val currentState: () -> UiState,
    private val requireReading: (ReadingAccess, Boolean) -> Unit,
    private val requireReadingMaterials: (ReadingAccess) -> Unit,
    private val selectedPaper: () -> Paper,
    private val currentPDF: suspend (Paper) -> Pair<File, String>,
    private val onPublishPendingExports: (List<JSONObject>, String?, Boolean) -> Unit,
    private val onPublishRetainedConfirmation: (JSONObject?) -> Unit,
    private val onNotice: (String) -> Unit,
    private val onRefresh: () -> Unit,
) {
    private data class ExportAttempt(
        val operationID: String,
        val attemptID: String,
        val epoch: String,
        val writerJobID: String? = null,
    )

    private val exportOwnedJobs = ConcurrentHashMap.newKeySet<String>()
    private val preservePreparationForRetain = ConcurrentHashMap.newKeySet<String>()
    private val nativeExportJobs = ConcurrentHashMap<String, JSONObject>()
    private val exportAttempts = ConcurrentHashMap<String, ExportAttempt>()
    private val pendingExportViews = LinkedHashMap<String, JSONObject>() // Only under maintenance.

    private val pendingStore: PendingExportStore get() = pendingStoreProvider()

    private val retainedExports by lazy {
        RetainedExportService(
            pendingStore,
            pendingControlRoot,
            research,
            deviceRoot,
            { raw -> requireExportDestination(raw); Unit }
        )
    }

    private val retainedAccess = RetainedExportAccess(
        { pendingStore },
        { retainedExports },
        pendingControlRoot,
        currentEpoch
    )

    val exportDestinationVerifier: ExportDestinationVerifier = { uri, sha, bytes ->
        verifyExportDestination(uri, sha, bytes)
    }

    fun isOwnedExportJob(id: String): Boolean = id in exportOwnedJobs

    fun hasBlockingNonCloudTask(): Boolean = active.keys.any { id ->
        (nativeExportJobs[id] ?: personal.snapshot().getJSONArray("jobs").objects().firstOrNull { it.optString("id") == id })
            ?.optString("kind")?.startsWith("cloud.") != true
    }

    fun mergedJobs(personalJobs: List<JSONObject>): List<JSONObject> {
        val ids = personalJobs.map { it.optString("id") }.toSet()
        return personalJobs + nativeExportJobs.values.filter { it.optString("id") !in ids }.map(JSONObject::copy)
    }

    fun retireForWorkspaceRestore() {
        exportAttempts.clear()
        retainedAccess.retireAll()
        onPublishRetainedConfirmation(null)
    }

    private fun requireExportDestination(raw: String): Uri = ExportService.externalDestination(context, raw)

    suspend fun verifyExportDestination(raw: String, expectedSHA: String, expectedBytes: Long) {
        val uri = requireExportDestination(raw)
        require(BackupCodec.validSHA(expectedSHA) && expectedBytes in 0..BackupCodec.MAX_ENCODED)
        val operationContext = currentCoroutineContext()
        verifyExportDestinationBytes(uri, expectedSHA, expectedBytes) { operationContext.ensureActive() }
    }

    private fun verifyExportDestinationBytes(uri: Uri, expectedSHA: String, expectedBytes: Long, check: () -> Unit) {
        require(BackupCodec.validSHA(expectedSHA) && expectedBytes in 0..BackupCodec.MAX_ENCODED)
        val digest = MessageDigest.getInstance("SHA-256")
        var actual = 0L
        context.contentResolver.openInputStream(uri)?.use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                check()
                val count = input.read(buffer)
                if (count < 0) break
                actual += count
                require(actual <= expectedBytes) { "所选位置返回的文件长度与原件不符" }
                digest.update(buffer, 0, count)
            }
        } ?: throw AppFailure("storage", "无法重新读取所选导出文件，原临时副本保留")
        check()
        val sha = digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
        require(actual == expectedBytes && sha == expectedSHA) { "所选位置的实际文件与原件不符，原临时副本保留" }
    }

    private fun publishPendingExports(error: String? = null, loading: Boolean = false) {
        val rows = pendingExportViews.values.map(JSONObject::copy)
        onPublishPendingExports(rows, error, loading)
    }

    private fun pendingView(view: PendingExportStore.PendingExport) {
        pendingExportViews[view.operationID] = retainedView(view)
        publishPendingExports()
    }

    private fun producerFor(view: PendingExportStore.PendingExport) = ExportProducerReceipt(
        File(pendingControlRoot, UUID.fromString(view.operationID).toString()),
        view.operationID,
        view.documentID,
        view.sourceIdentity
    )

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
            .put(
                "message",
                if (ready) "原件已准备，尚未保存到所选位置；可继续保存同一原件。"
                else if (failure is CancellationException) "准备已停止；已封存材料和研究原件保留。"
                else "准备未完成；已有材料保留，不会自动重新采集。"
            )
        if (ready) {
            val actual = requireNotNull(view)
            val artifact = requireNotNull(actual.artifact)
            next.put("result", exportResult(actual))
            next.put(
                "material",
                JSONObject()
                    .put("kind", "prepared-export")
                    .put("createdAt", actual.createdAt)
                    .put("sha256", artifact.sha256)
                    .put("encodedBytes", artifact.bytes)
            )
        }
        persistExportJob(next)
    }

    /** A single IO reconciliation owns the same maintenance snapshot as new begin/delivery. */
    suspend fun reconcilePendingExports(operationID: String? = null): JSONObject = maintenance().withLock {
        val operation = currentCoroutineContext()
        onPublishPendingExports(currentState().pendingExports, currentState().pendingExportsError, true)
        try {
            val activeIDs = active.keys.toSet()
            val rows = if (operationID == null) {
                pendingStore.reconcile(activeIDs, exportAttempts.keys.toSet()) { operation.ensureActive() }
            } else {
                listOf(pendingStore.get(operationID) { operation.ensureActive() })
            }
            if (operationID == null) pendingExportViews.clear()
            val loadedNativeIDs = HashSet<String>()
            for (original in rows) {
                operation.ensureActive()
                var row = original
                loadedNativeIDs.addAll(readNativeExportJobs(row, activeIDs))
                for (control in retainedAccess.readJobs(row, activeIDs)) {
                    val id = control.getString("id")
                    require(
                        personal.snapshot().getJSONArray("jobs").objects().none { it.optString("id") == id } &&
                            personal.session(id) == null
                    ) { "本机保留任务与研究历史身份冲突" }
                    nativeExportJobs[id] = control
                    loadedNativeIDs.add(id)
                }
                if ((row.preparation == "interrupted" || (row.preparation == "preparing" && row.jobID !in activeIDs)) &&
                    row.sourceIdentity.optString("format") == "backup"
                ) {
                    val producer = producerFor(row)
                    if (producer.hasCompletionMaterials()) {
                        try {
                            val captured = producer.verifiedCapture { operation.ensureActive() }
                            requireRescueCaptureIdentity(row, captured.file) { operation.ensureActive() }
                            exports.registerCompleted(captured, row.documentID) { operation.ensureActive() }
                            row = pendingStore.markReady(row.operationID) { operation.ensureActive() }
                        } catch (cancelled: CancellationException) {
                            throw cancelled
                        } catch (_: Exception) {
                            /* Preserve original bytes and honest interrupted state. */
                        }
                    }
                }
                pendingExportViews[row.operationID] = retainedView(row).also { view ->
                    if (row.preparation == "preparing" && row.jobID !in activeIDs) {
                        view.put("preparation", "interrupted")
                            .put("message", "原准备任务已中断；本次核验未重新采集，也未授予原件就绪。")
                    }
                }
                if (row.preparation == "ready" && row.artifact != null) {
                    (nativeExportJobs[row.jobID] ?: personal.snapshot().getJSONArray("jobs").objects().firstOrNull { it.optString("id") == row.jobID })
                        ?.takeIf { it.optString("status") != "completed" || it.optJSONObject("result")?.optString("operationID") != row.operationID }
                        ?.let { finishExportJob(it, row, null) }
                }
            }
            require(
                nativeExportJobs.values.filter { operationID == null || it.optString("nativeOperationID") == operationID }
                    .all { it.optString("id") in loadedNativeIDs }
            ) { "既有本机救援控制记录未完整读取，未当成空历史。" }
            publishPendingExports()
            JSONObject().put("pendingExports", JSONArray(pendingExportViews.values.map(JSONObject::copy)))
        } catch (cancelled: CancellationException) {
            publishPendingExports("待保存清单读取已停止；原材料保留。")
            throw cancelled
        } catch (failure: Exception) {
            publishPendingExports("待保存控制记录暂时无法完整读取；原材料保留，请明确重新核验。")
            throw failure
        }
    }

    suspend fun preparePendingExport(command: String, payload: JSONObject, access: ReadingAccess): JSONObject {
        val requestContext = currentCoroutineContext()
        val deferred = maintenance().withLock {
            require(active.isEmpty()) { "请待当前任务结束再导出完整材料" }
            val format = if (command == "retained.export.prepare") "retained-backup" else payload.getString("format")
            val sessionID = payload.nullableString("sessionID")
            val historical = sessionID?.let { personal.session(it) ?: error("原研究记录不存在") }
            require(historical == null || format in listOf("research-json", "research-md", "research-html")) { "原研究只能按其实际材料导出" }
            val whole = format in listOf("backup", "diagnostics", "retained-backup")
            if (!whole && historical == null) requireReadingMaterials(access)
            val owner = historical?.optString("paperID") ?: if (whole) "" else selectedPaper().id
            val epoch = currentEpoch()
            val source = JSONObject()
                .put("format", format)
                .put("workspaceEpoch", epoch)
                .put("paperID", owner)
                .put("label", if (whole) "研究空间" else historical?.optString("question")?.take(120) ?: selectedPaper().titleZh.take(120))
                .put("createdAt", now())
                .put("readingMaterialID", if (!whole && historical == null) access.materialID else JSONObject.NULL)
            if (historical != null) {
                source.put("sessionID", sessionID).put("inputSHA256", historical.optString("inputSHA256"))
            } else if (!whole) {
                val actual = currentState()
                val version = if (format == "paper-pdf") {
                    if (actual.pdfDocument != null) actual.pdfReceipt.nullableString("version") else selectedPaper().sourceVersion
                } else actual.article?.sourceVersion
                source.put("sourceVersion", version ?: JSONObject.NULL)
                if (format == "paper-pdf") source.put("pdfSHA256", actual.pdfDocument?.sha256 ?: JSONObject.NULL)
                else source.put("articleRevisionSHA256", actual.article?.revisionSHA256 ?: JSONObject.NULL)
            }
            val retained = if (format == "retained-backup") {
                val file = cloud().retainedSnapshot(payload.getString("transferID"))
                source.put("transferID", payload.getString("transferID"))
                    .put("originalSHA256", BackupCodec.hash(file) { requestContext.ensureActive() })
                    .put("originalBytes", file.length())
                file
            } else null
            val id = UUID.randomUUID().toString()
            var jobRow = exportJobRow(id, command, source)
            val originalPersonal = if (format == "backup") personalFileIdentity { requestContext.ensureActive() } else null
            var rescue = false
            try {
                personal.upsertJob(jobRow)
            } catch (failure: AppFailure) {
                if (format != "backup" || failure.category != "capacity" || originalPersonal == null) throw failure
                require(personalFileIdentity { requestContext.ensureActive() } == originalPersonal) { "个人资料在容量拒绝期间已变化，未进入只读救援。" }
                rescue = true
                jobRow = jobRow.copy().put("localRescueExport", true)
                    .put("identity", "本机只读救援备份（控制任务不包含在原快照）")
                    .put("message", "个人记录容量已满；只读采集原研究目录，控制任务仅保存在本机传输记录。")
                source.put("rescueExport", true)
                    .put("originalPersonalSHA256", originalPersonal.second)
                    .put("originalPersonalBytes", originalPersonal.first)
                    .put("rescueJob", jobRow.copy())
            }
            val pending = try {
                pendingStore.begin(id, format, source)
            } catch (failure: Throwable) {
                if (!rescue) finishExportJob(jobRow, null, failure)
                throw failure
            }
            if (rescue) writeNativeExportJob(pending, jobRow)
            pendingView(pending)
            val producer = if (format == "backup") producerFor(pending) else null
            val task = scope().async(CoroutineName(id), start = CoroutineStart.LAZY) {
                var ready: PendingExportStore.PendingExport? = null
                try {
                    maintenance().withLock {
                        val work = currentCoroutineContext()
                        val check = {
                            work.ensureActive()
                            requireCurrentEpoch(epoch)
                            if (!whole && historical == null) requireReading(access, false)
                            Unit
                        }
                        check()
                        if (!whole && historical == null) requireReadingMaterials(access)
                        val p = if (historical != null || whole) null else selectedPaper()
                        val actualState = currentState()
                        val article = if (historical != null) null else actualState.article
                        if (format == "guide-html") require(article != null && article.paperID == p?.id) {
                            "请先打开要导出的实际导读；未隐式刷新为另一份网页修订。"
                        }
                        val original = if (format == "paper-pdf") {
                            val opened = actualState.pdfDocument
                            if (opened != null) {
                                requireReading(access, true)
                                ReadingSourceBinding.requirePDF(p ?: error("请先选择论文"), actualState.pdfReceipt, opened.sha256)
                                StoragePaths.resolve(opened.localPath, research, opened.sha256, 200 * 1024 * 1024L)
                            } else currentPDF(p ?: error("请先选择论文")).first
                        } else null
                        val phase: (String) -> Unit = { value -> check(); pendingView(pendingStore.phase(pending.operationID, value)) }
                        phase(if (format == "backup") "capturing" else "encoding")
                        if (retained != null) {
                            require(BackupCodec.hash(retained, check) == source.getString("originalSHA256")) { "原保留快照已变化，未替换为另一份材料" }
                            val registered = exports.register(retained, "application/octet-stream", "论文速递工作台-保留快照.paperdigest", pending.documentID, check)
                            require(registered.sha256 == source.getString("originalSHA256") && registered.file.length() == source.getLong("originalBytes")) {
                                "保留快照在复制期间已变化，未将变动副本标为就绪。"
                            }
                        } else {
                            exports.prepare(
                                format, p, article, original, sessionID, pending.documentID,
                                if (format == "backup") pendingStore.preparationFile(pending.operationID) else null,
                                check, phase, producer
                            )
                        }
                        check()
                        if (!whole && historical == null) requireReadingMaterials(access)
                        phase("verifying")
                        if (rescue) requireRescueCaptureIdentity(pending, pendingStore.preparationFile(pending.operationID), check)
                        ready = pendingStore.markReady(pending.operationID, check)
                        pendingView(ready!!)
                        finishExportJob(jobRow, ready, null)
                        exportResult(ready!!)
                    }
                } catch (failure: Throwable) {
                    withContext(NonCancellable + Dispatchers.IO) {
                        maintenance().withLock {
                            val disk = ready ?: runCatching { pendingStore.get(pending.operationID) }.getOrNull()
                            if (disk?.preparation == "ready" && disk.artifact != null) {
                                ready = disk
                                pendingView(disk)
                                finishExportJob(jobRow, disk, null)
                            } else {
                                if (failure is CancellationException) {
                                    val hasReceipt = if (producer != null) runCatching { producer.hasCompletionMaterials() }.getOrDefault(true) else false
                                    if (!hasReceipt && pending.operationID !in preservePreparationForRetain) {
                                        runCatching { pendingView(pendingStore.cancelPreparation(pending.operationID)) }
                                    }
                                }
                                finishExportJob(jobRow, null, failure)
                            }
                        }
                    }
                    throw failure
                } finally {
                    withContext(NonCancellable + Dispatchers.IO) {
                        maintenance().withLock {
                            active.remove(id)
                            exportOwnedJobs.remove(id)
                            preservePreparationForRetain.remove(pending.operationID)
                            try {
                                val actual = (ready ?: pendingStore.get(pending.operationID)).json()
                                if (actual.optString("preparation") == "preparing") {
                                    actual.put("preparation", "interrupted")
                                        .put("message", "准备任务已停止；原材料保留，请明确重新核验。")
                                }
                                pendingExportViews[pending.operationID] = actual
                                publishPendingExports()
                            } catch (_: Exception) {
                                publishPendingExports("待保存记录未能完整对账；原件保留，请重新核验。")
                            }
                            onRefresh()
                        }
                    }
                }
            }
            active[id] = task
            exportOwnedJobs.add(id)
            task.start()
            onRefresh()
            task
        }
        return awaitOwnedExport(deferred, "原件准备")
    }

    private fun requireAttempt(operationID: String, attemptID: String): ExportAttempt {
        val attempt = exportAttempts[attemptID] ?: error("系统保存许可已结束；原件保留，请从待保存清单重新选择位置。")
        require(attempt.operationID == operationID) { "保存回调与原操作不符，未写入另一份文件。" }
        requireCurrentEpoch(attempt.epoch)
        return attempt
    }

    suspend fun beginExportDelivery(operationID: String): JSONObject = maintenance().withLock {
        require(exportAttempts.isEmpty() && !retainedAccess.hasDelivery()) { "请先结束当前系统保存，再选择另一份原件。" }
        val work = currentCoroutineContext()
        val row = pendingStore.beginDelivery(operationID) { work.ensureActive() }
        val attempt = row.attemptID ?: error("原保存许可未生成")
        exportAttempts[attempt] = ExportAttempt(operationID, attempt, currentEpoch())
        pendingView(row)
        row.json()
    }

    suspend fun cancelExportDelivery(payload: JSONObject): JSONObject = maintenance().withLock {
        val operation = payload.getString("operationID")
        val attempt = payload.getString("attemptID")
        require(requireAttempt(operation, attempt).writerJobID == null) { "此原件已开始保存，请到任务请求停止并等待实际关闭。" }
        val row = pendingStore.chooserCancelled(operation, attempt)
        exportAttempts.remove(attempt)
        pendingView(row)
        row.json()
    }

    suspend fun validateExportDelivery(operationID: String, attemptID: String): JSONObject = maintenance().withLock {
        requireAttempt(operationID, attemptID)
        JSONObject().put("valid", true)
    }

    suspend fun savePendingExport(payload: JSONObject): JSONObject {
        val operationID = payload.getString("operationID")
        val attemptID = payload.getString("attemptID")
        val uri = requireExportDestination(payload.getString("uri"))
        val deferred = maintenance().withLock {
            val delivery = requireAttempt(operationID, attemptID)
            require(delivery.writerJobID == null) { "本次许可已开始保存，未重复创建写入任务。" }
            val id = UUID.randomUUID().toString()
            val row = exportJobRow(id, "export.save", JSONObject().put("label", "已准备的原导出文件"))
                .put("message", "正在写入并回读所选位置；原准备文件保留。")
            val originalPending = pendingStore.deliverySource(operationID)
            if (originalPending.sourceIdentity.optBoolean("rescueExport")) writeNativeExportJob(originalPending, row)
            else personal.upsertJob(row)
            exportAttempts[attemptID] = delivery.copy(writerJobID = id)
            val task = scope().async(CoroutineName(id), start = CoroutineStart.LAZY) {
                var closed = false
                try {
                    maintenance().withLock {
                        val work = currentCoroutineContext()
                        val check = { work.ensureActive(); requireAttempt(operationID, attemptID); Unit }
                        val artifact = pendingStore.startWriting(operationID, attemptID, check)
                        pendingView(originalPending.copy(delivery = "writing", attemptID = attemptID, artifact = artifact))
                        check()
                        context.contentResolver.openOutputStream(uri, "wt")?.use { output ->
                            artifact.file.inputStream().use { input ->
                                val buffer = ByteArray(64 * 1024)
                                while (true) {
                                    check()
                                    val n = input.read(buffer)
                                    if (n < 0) break
                                    output.write(buffer, 0, n)
                                }
                                check()
                                output.flush()
                            }
                        } ?: error("无法写入用户选择的位置，原准备文件保留。")
                        closed = true
                        pendingView(pendingStore.recordWritten(operationID, attemptID, check))
                        var verified = false
                        var message = "文件已交给所选位置，但完整回读或本机登记尚未完整确认；临时副本保留，清理资格仍须独立核验。"
                        try {
                            capacity().markExportSaved(artifact.documentID, uri.toString(), exportDestinationVerifier)
                            pendingView(pendingStore.verifyDelivery(operationID, attemptID, check) { expected ->
                                verifyExportDestinationBytes(uri, expected.sha256, expected.bytes, check)
                            })
                            verified = true
                            message = "已写入所选位置，并完整回读核对字节与 SHA"
                        } catch (cancelled: CancellationException) {
                            throw cancelled
                        } catch (_: Exception) {
                            pendingView(pendingStore.get(operationID, check))
                        }
                        val persistent = if (verified) runCatching {
                            context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            true
                        }.getOrDefault(false) else false
                        val result = JSONObject()
                            .put("saved", true)
                            .put("verified", verified)
                            .put("persistentRead", persistent)
                            .put("operationID", operationID)
                            .put("attemptID", attemptID)
                            .put("documentID", artifact.documentID)
                            .put("bytes", artifact.bytes)
                            .put("sha256", artifact.sha256)
                            .put("message", message)
                        persistExportJob(
                            row.copy().put("status", if (verified) "completed" else "failed")
                                .put("endedAt", now()).put("message", message).put("result", result)
                        )
                        result
                    }
                } catch (failure: Throwable) {
                    withContext(NonCancellable + Dispatchers.IO) {
                        maintenance().withLock {
                            runCatching { pendingView(pendingStore.deliveryFailed(operationID, attemptID)) }
                            persistExportJob(
                                row.copy().put("status", if (failure is CancellationException) "cancelled" else "failed")
                                    .put("endedAt", now())
                                    .put("message", if (closed) "文件写流已关闭，回读或登记未完成；原件保留。" else "保存已停止；外部位置可能已有部分文件，原件保留。")
                            )
                        }
                    }
                    throw failure
                } finally {
                    withContext(NonCancellable + Dispatchers.IO) {
                        maintenance().withLock {
                            exportAttempts.remove(attemptID)
                            active.remove(id)
                            exportOwnedJobs.remove(id)
                            onRefresh()
                        }
                    }
                }
            }
            active[id] = task
            exportOwnedJobs.add(id)
            task.start()
            onRefresh()
            task
        }
        return awaitOwnedExport(deferred, "原件写出与回读")
    }

    private suspend fun awaitOwnedExport(deferred: Deferred<JSONObject>, label: String): JSONObject = try {
        deferred.await()
    } catch (cancelled: CancellationException) {
        val message = if (deferred.isActive) "$label 仍在后台；请到任务查看实际进度。"
        else if (deferred.isCancelled) "$label 已停止；已有封存材料保留，请查看原记录。"
        else "$label 已结束；请到待保存清单查看实际结果。"
        onNotice(message)
        throw cancelled
    }

    private fun requireRescueCaptureIdentity(view: PendingExportStore.PendingExport, file: File, check: () -> Unit) {
        if (view.sourceIdentity.opt("rescueExport") != true) return
        val staged = BackupCodec.stage(file.inputStream(), file.parentFile!!, check)
        try {
            val personalEntry = staged.entries.single { it.path == "personal.json" }
            require(
                personalEntry.sha256 == view.sourceIdentity.getString("originalPersonalSHA256") &&
                    personalEntry.bytes == view.sourceIdentity.getLong("originalPersonalBytes")
            ) { "救援快照不再对应原个人文件，未授予原件就绪。" }
        } finally {
            staged.directory.deleteRecursively()
        }
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
        require(
            actual.jobID == view.jobID && actual.documentID == view.documentID &&
                canonical(actual.sourceIdentity) == canonical(view.sourceIdentity)
        )
        val row = job.copy().put("localRescueExport", true).put("nativeOperationID", view.operationID)
        val file = nativeJobFile(view, row.getString("id"))
        val family = "paperdigest-native-export-job"
        val header = if (file.exists()) {
            val original = JSONObject(PublishedUtf8.decode(JsonFiles.read(file, 65536)))
            require(
                ClientProtocols.hasValidHeader(original, family) &&
                    original.keys().asSequence().toSet() == ClientProtocols.recordKeys(
                        original.get("contract"), family, setOf("operationID", "documentID", "job"), original.opt("schemaFingerprint") as? String
                    ) &&
                    original.getString("operationID") == view.operationID &&
                    original.getString("documentID") == view.documentID &&
                    original.getJSONObject("job").getString("id") == row.getString("id") &&
                    original.getJSONObject("job").getString("kind") == row.getString("kind")
            ) { "原本机救援控制任务的格式或身份已变化" }
            ClientProtocols.recordHeader(original.get("contract"), family, original.opt("schemaFingerprint") as? String)
        } else {
            ClientProtocols.recordHeader(family, family)
        }
        val wrapper = header.put("operationID", view.operationID).put("documentID", view.documentID).put("job", row)
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
        val personalIDs = (savedPersonal.getJSONArray("jobs").objects() + savedPersonal.getJSONArray("sessions").objects())
            .map { it.optString("id") }.toSet()
        for (file in files) {
            require(file.name.matches(Regex("native-job-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\\.json")))
            val raw = JSONObject(PublishedUtf8.decode(JsonFiles.read(BackupCodec.checkedFile(directory, file.name), 65536)))
            require(
                ClientProtocols.hasValidHeader(raw, "paperdigest-native-export-job") &&
                    raw.keys().asSequence().toSet() == ClientProtocols.recordKeys(
                        raw.get("contract"), "paperdigest-native-export-job", setOf("operationID", "documentID", "job"), raw.opt("schemaFingerprint") as? String
                    )
            )
            require(
                ClientProtocols.hasValidHeader(raw, "paperdigest-native-export-job") &&
                    raw.getString("operationID") == view.operationID && raw.getString("documentID") == view.documentID
            )
            val job = raw.getJSONObject("job")
            val id = job.getString("id")
            require(file == nativeJobFile(view, id) && ids.add(id))
            require(job.opt("localRescueExport") == true && job.getString("nativeOperationID") == view.operationID)
            require(if (job.getString("kind") == "export.prepare") id == view.jobID else id != view.jobID)
            require(job.getString("kind") in setOf("export.prepare", "export.save") && job.getString("status") in setOf("running", "completed", "failed", "cancelled", "interrupted"))
            require(id !in personalIDs) { "本机控制任务与研究历史身份冲突，未替换原记录。" }
            if (job.optString("status") == "running" && id !in activeIDs) {
                val retired = job.copy().put("status", "interrupted").put("endedAt", now())
                    .put("message", "上次本机救援导出已中断；原研究记录和材料未改写。")
                writeNativeExportJob(view, retired)
            } else {
                nativeExportJobs[id] = job.copy()
            }
        }
        if (view.jobID !in ids) {
            require(nativeExportJobs[view.jobID] == null) { "已登记的救援任务文件丢失，未以初始状态覆盖原事实。" }
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

    suspend fun requestRetainExport(operationID: String): JSONObject {
        val visible = currentState().pendingExports.firstOrNull { it.optString("operationID") == operationID }
            ?: error("原准备记录尚未读取，请先重新核验清单")
        val epoch = currentEpoch()
        val ownedIDs = setOf(visible.getString("jobID")) + nativeExportJobs.values
            .filter { it.optString("nativeOperationID") == operationID }.map { it.getString("id") }
        onNotice("已请求停止原准备，正在等待实际文件操作关闭；尚未报告停止。")
        val producer = active[visible.getString("jobID")]
        require(producer == null || visible.getString("jobID") in exportOwnedJobs) { "原准备没有此实际作业的停止权限" }
        if (producer != null) preservePreparationForRetain.add(operationID)
        // A blocked producer may own maintenance. Never wait for its completion while holding that lock.
        for (id in ownedIDs) active[id]?.let { require(id in exportOwnedJobs); it.cancel(); it.join() }
        if (producer == null || producer.isCompleted) preservePreparationForRetain.remove(operationID)
        return maintenance().withLock {
            requireCurrentEpoch(epoch)
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
            pendingView(pendingStore.get(operationID))
            onPublishRetainedConfirmation(confirmation.copy())
            onNotice("原准备已停止；请确认是否结束本次准备并原样保留材料。")
            confirmation
        }
    }

    suspend fun confirmRetainExport(payload: JSONObject): JSONObject = maintenance().withLock {
        val id = payload.getString("confirmationID")
        val row = retainedAccess.retain(id)
        if (currentState().retainedExportConfirmation?.optString("confirmationID") == id) {
            onPublishRetainedConfirmation(null)
        }
        pendingView(row)
        row.json().put("message", "本次准备已结束，原材料和旧记录保留；尚未核验其是否可另存。")
    }

    suspend fun discardRetainConfirmation(payload: JSONObject): JSONObject = maintenance().withLock {
        val id = payload.getString("confirmationID")
        retainedAccess.discardConfirmation(id)
        if (currentState().retainedExportConfirmation?.optString("confirmationID") == id) {
            onPublishRetainedConfirmation(null)
        }
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

    private suspend fun ownedRetainedTask(
        operationID: String,
        kind: String,
        label: String,
        attemptID: String? = null,
        body: suspend (() -> Unit) -> JSONObject,
    ): JSONObject {
        val task = maintenance().withLock {
            val epoch = currentEpoch()
            require(pendingStore.get(operationID).preparation == "retained")
            require(
                nativeExportJobs.values.none {
                    it.optString("nativeOperationID") == operationID &&
                        it.optString("status") == "running" &&
                        active.containsKey(it.optString("id"))
                }
            ) { "请等原保留快照任务实际结束" }
            if (attemptID != null) require(retainedAccess.lease(operationID, attemptID).writerJobID == null) { "本次保存已开始，未重复创建控制任务" }
            val id = UUID.randomUUID().toString()
            val row = retainedTaskRow(id, kind, operationID, label)
            persistRetainedTask(operationID, row)
            if (attemptID != null) retainedAccess.claimWriter(operationID, attemptID, id)
            val deferred = scope().async(CoroutineName(id), start = CoroutineStart.LAZY) {
                try {
                    maintenance().withLock {
                        val work = currentCoroutineContext()
                        val check = { work.ensureActive(); requireCurrentEpoch(epoch); Unit }
                        check()
                        val result = body(check)
                        persistRetainedTask(
                            operationID,
                            row.copy().put("status", "completed").put("endedAt", now())
                                .put("message", result.optString("message")).put("result", result.copy())
                        )
                        pendingView(pendingStore.get(operationID))
                        result
                    }
                } catch (failure: Throwable) {
                    withContext(NonCancellable + Dispatchers.IO) {
                        maintenance().withLock {
                            val actual = runCatching { retainedExports.deliveries(operationID) }.getOrNull()
                            val proven = attemptID != null && actual?.optString("attemptID") == attemptID && actual.optBoolean("readbackProven")
                            val complete = proven && actual?.optString("state") == "verified"
                            val message = if (proven) actual!!.optString("message")
                            else if (failure is CancellationException) "本次保留快照操作已停止；原材料保留，外部位置可能已有部分或完整文件，未确认成功。"
                            else "本次保留快照操作未全部完成；请查看原回读事实，原材料和旧历史保留。"
                            val terminal = row.copy()
                                .put("status", if (complete) "completed" else if (failure is CancellationException && !proven) "cancelled" else "failed")
                                .put("endedAt", now()).put("message", message)
                            if (actual != null && actual.optString("attemptID") == attemptID) terminal.put("result", actual)
                            persistRetainedTask(operationID, terminal)
                            runCatching { pendingView(pendingStore.get(operationID)) }
                        }
                    }
                    throw failure
                } finally {
                    withContext(NonCancellable + Dispatchers.IO) {
                        maintenance().withLock {
                            attemptID?.let(retainedAccess::release)
                            active.remove(id)
                            exportOwnedJobs.remove(id)
                            onRefresh()
                        }
                    }
                }
            }
            active[id] = deferred
            exportOwnedJobs.add(id)
            deferred.start()
            onRefresh()
            deferred
        }
        return awaitOwnedExport(task, label)
    }

    suspend fun prepareRetainedDelivery(operationID: String): JSONObject = ownedRetainedTask(
        operationID, "export.retained.prepare", "核验保留的原完整快照"
    ) { check ->
        require(exportAttempts.isEmpty() && !retainedAccess.hasDelivery()) { "请先结束当前系统保存，再核验另一份原件" }
        retainedAccess.prepare(operationID, check)
    }

    suspend fun validateRetainedDelivery(operationID: String, attemptID: String): JSONObject = maintenance().withLock {
        val lease = retainedAccess.lease(operationID, attemptID)
        require(lease.writerJobID == null) { "原保存已开始，请等待实际写入结束" }
        JSONObject().put("valid", true)
    }

    suspend fun cancelRetainedDelivery(operationID: String, attemptID: String): JSONObject = maintenance().withLock {
        retainedAccess.cancelChooser(operationID, attemptID).also {
            pendingView(pendingStore.get(operationID))
        }
    }

    suspend fun reconcileRetainedHistory(operationID: String, attemptID: String): JSONObject = maintenance().withLock {
        retainedExports.reconcileHistory(operationID, attemptID).also {
            pendingView(pendingStore.get(operationID))
        }
    }

    suspend fun saveRetainedExport(payload: JSONObject): JSONObject {
        val operationID = payload.getString("operationID")
        val attemptID = payload.getString("attemptID")
        val uri = requireExportDestination(payload.getString("uri"))
        maintenance().withLock { retainedAccess.lease(operationID, attemptID) }
        return ownedRetainedTask(operationID, "export.retained.save", "另存并回读保留的原快照", attemptID) { check ->
            val original = retainedAccess.lease(operationID, attemptID)
            check()
            retainedExports.save(
                original.delivery,
                uri.toString(),
                openOutput = {
                    check()
                    context.contentResolver.openOutputStream(uri, "wt") ?: error("无法写入用户选择的位置，原快照保留")
                },
                verifier = { _, expectedSHA, expectedBytes ->
                    verifyExportDestinationBytes(uri, expectedSHA, expectedBytes, check)
                }
            ).also { result ->
                result.put("saved", true)
                    .put("verified", result.optBoolean("readbackProven"))
                    .put("documentID", original.snapshot.documentID)
            }
        }
    }
}
