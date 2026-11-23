package com.nanless.paperdigest

import com.nanless.paperdigest.cloud.*
import com.nanless.paperdigest.data.*
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

internal data class RestorePreparation(val staged: BackupCodec.Staged, val workspaceEpoch: String)

/** Coordinates WebDAV cloud backup/restore projection, full/personal sync, and concurrent note conflict CAS resolution. */
internal class CloudSyncCoordinator(
    private val research: File,
    private val personal: PersonalStore,
    private val cloud: CloudService,
    private val restores: ConcurrentHashMap<String, RestorePreparation>,
    private val active: ConcurrentHashMap<String, Job>,
    private val maintenance: () -> Mutex,
    private val currentEpoch: () -> String,
    private val requireCurrentEpoch: (String) -> Unit,
    private val reloadLibrary: () -> Unit,
    private val onRefresh: () -> Unit,
    private val onNotice: (String) -> Unit,
    private val runTask: suspend (String, () -> Unit, suspend () -> JSONObject) -> JSONObject,
    private val isPlatformCloudWorkFinished: suspend (String, UUID?) -> Boolean,
    private val enqueueCloudUploadWork: suspend (UUID, String, String) -> Unit,
) {
    private val cloudSelections = CloudRestoreSelections(cloud) { CloudSelectionContext(cloud.targetID, currentEpoch()) }
    private val noteConflictLock = Any()
    private val pendingNoteConflicts = LinkedHashMap<String, NoteConflictItem>()

    fun noteConflictsSnapshot(): List<NoteConflictItem> = synchronized(noteConflictLock) {
        pendingNoteConflicts.values.toList()
    }

    fun clearNoteConflicts() {
        synchronized(noteConflictLock) {
            pendingNoteConflicts.clear()
        }
    }

    fun clearNoteConflict(paperId: String) {
        synchronized(noteConflictLock) {
            pendingNoteConflicts.remove(paperId)
        }
    }

    internal fun recordSyncedNoteConflicts(items: List<NoteConflictItem>) {
        synchronized(noteConflictLock) {
            pendingNoteConflicts.clear()
            for (item in items) {
                pendingNoteConflicts[item.paperId] = item
            }
        }
    }

    fun cloudView(snapshot: JSONObject = personal.snapshot()): JSONObject {
        val result = cloud.state().put("selectionContext", cloudSelections.contextToken())
        val transfers = snapshot.getJSONArray("jobs").objects().filter { row ->
            row.optString("kind") in setOf("cloud.upload", "cloud.automatic") &&
                row.optString("status") in setOf("queued", "running")
        }
        val transfer = transfers.firstOrNull { it.optString("status") == "running" } ?: transfers.firstOrNull()
        if (transfer != null) {
            result.put("activeJobID", transfer.getString("id")).put("transferStatus", transfer.getString("status"))
        }
        return result
    }

    /** Called under maintenance. A job row alone cannot authorize a new upload. */
    suspend fun reconcileCloudTransfers() {
        val jobs = personal.snapshot().getJSONArray("jobs").objects()
        for (row in jobs) {
            val kind = row.optString("kind")
            val id = row.optString("id")
            if (kind !in setOf("cloud.upload", "cloud.automatic") ||
                row.optString("status") !in setOf("queued", "running") || active.containsKey(id)
            ) continue
            val workID = runCatching { UUID.fromString(id) }.getOrNull()
            if (isPlatformCloudWorkFinished(kind, workID)) {
                personal.upsertJob(
                    row.copy().put("status", "interrupted").put("endedAt", now())
                        .put("message", "系统备份任务已结束或不存在。原材料保留，可重新选择继续备份。")
                )
            }
        }
    }

    fun requireRestorePreparation(id: String, workspaceEpoch: String): RestorePreparation {
        requireCurrentEpoch(workspaceEpoch)
        val preparation = restores[id] ?: error("恢复确认已失效，请重新选择备份")
        requireCurrentEpoch(preparation.workspaceEpoch)
        return preparation
    }

    fun restoreToken(staged: BackupCodec.Staged, workspaceEpoch: String): JSONObject {
        requireCurrentEpoch(workspaceEpoch)
        val id = UUID.randomUUID().toString()
        restores[id] = RestorePreparation(staged, workspaceEpoch)
        return JSONObject()
            .put("restoreID", id)
            .put("fileCount", staged.entries.size)
            .put("sha256", staged.encodedSHA256)
            .put("message", "完整备份已通过逐文件校验。恢复后将回到此快照；保留本机连接、实际派发计数和恢复前副本。")
    }

    suspend fun discardRestore(id: String): JSONObject = maintenance().withLock {
        restores.remove(id)?.staged?.directory?.deleteRecursively()
        JSONObject().put("cancelled", true)
    }

    suspend fun savePersonalNoteAndClearConflict(
        paperId: String,
        text: String,
        baseRevision: Int,
        workspaceEpoch: String,
    ): JSONObject = maintenance().withLock {
        requireCurrentEpoch(workspaceEpoch)
        personal.saveNote(paperId, text, baseRevision).also {
            clearNoteConflict(paperId)
        }
    }

    suspend fun resolveNoteConflict(payload: JSONObject, workspaceEpoch: String): JSONObject = maintenance().withLock {
        requireCurrentEpoch(workspaceEpoch)
        val paperId = payload.getString("paperID")
        require(paperId.isNotEmpty()) { "缺少冲突笔记所属论文编号" }
        val strategy = NoteConflictStrategy.parse(payload.getString("strategy"))
        val rawBase = payload.get("baseRevision")
        val baseRevision = when (rawBase) {
            is Int -> rawBase.takeIf { it in 0 until Int.MAX_VALUE }
            is Long -> rawBase.takeIf { it in 0L until Int.MAX_VALUE.toLong() }?.toInt()
            is Number -> rawBase.toDouble().takeIf {
                it.isFinite() && it == it.toLong().toDouble() && it.toLong() in 0L until Int.MAX_VALUE.toLong()
            }?.toInt()
            else -> null
        } ?: throw IllegalArgumentException("笔记冲突解决需要有效的 baseRevision")
        val conflict = synchronized(noteConflictLock) { pendingNoteConflicts[paperId] }
            ?: throw AppFailure("missing", "这篇论文当前没有待决的云端笔记冲突")
        val currentNote = personal.note(paperId)
        if (currentNote.getInt("revision") != baseRevision) {
            throw AppFailure("conflict", "笔记已在其他视图修改，保留当前草稿；请先读取新版本。")
        }
        if (currentNote.optString("text") != conflict.localNote) {
            throw AppFailure("conflict", "本机笔记正文已在冲突捕获后发生变化，拒绝使用旧冲突快照覆盖当前笔记。")
        }
        val snapshot = personal.snapshot()
        val resolvedText = NoteConflictMerger.resolve(conflict, strategy, snapshot)
        val saved = personal.saveNote(paperId, resolvedText, baseRevision)
        val remaining = synchronized(noteConflictLock) {
            pendingNoteConflicts.remove(paperId)
            pendingNoteConflicts.size
        }
        JSONObject()
            .put("resolved", true)
            .put("paperID", paperId)
            .put("strategy", strategy.name)
            .put("text", saved.getString("text"))
            .put("revision", saved.getInt("revision"))
            .put("updatedAt", saved.optString("updatedAt"))
            .put("remainingConflicts", remaining)
    }

    suspend fun executeCloudCommand(
        command: String,
        payload: JSONObject,
        workspaceEpoch: String,
        cloudMutation: CloudCredentialMutation?,
    ): JSONObject = when (command) {
        "cloud.state" -> cloudView()
        "cloud.save" -> {
            val targetChanging = cloud.credentialsTargetWouldChange(
                payload.getString("account"),
                payload.optString("folder", "PaperDigest")
            )
            val saved = cloud.save(
                payload.getString("account"),
                payload.optString("folder", "PaperDigest"),
                payload.optBoolean("automatic"),
                payload.optInt("intervalHours", 24),
                cloudMutation
            )
            if (targetChanging) clearNoteConflicts()
            saved
        }
        "cloud.check" -> runTask(command, {}) { cloud.check() }
        "cloud.noteConflicts" -> JSONObject().put(
            "noteConflicts",
            JSONArray(noteConflictsSnapshot().map { it.json() })
        )
        "cloud.noteConflict.resolve" -> resolveNoteConflict(payload, workspaceEpoch)
        "cloud.syncPersonal", "cloud.syncWorkspace" -> runTask(command, { requireCurrentEpoch(workspaceEpoch) }) {
            require(payload.length() == 0) { "同步入口只使用已保存的 WebDAV 连接" }
            require(!personal.settings().optBoolean("offlineMode")) { "离线模式已开启" }
            var workspaceFailed = false
            var personalFailed = false
            val full = if (command == "cloud.syncWorkspace") try {
                cloud.syncFull(
                    workspaceEpoch,
                    capture = { output ->
                        maintenance().withLock {
                            requireCurrentEpoch(workspaceEpoch)
                            val operation = currentCoroutineContext()
                            BackupCodec.captureSelection(
                                research,
                                output,
                                FullWorkspaceMerge.capturePersonal(personal.snapshot()),
                                FullWorkspaceMerge::includes
                            ) { operation.ensureActive() }
                        }
                    },
                    merge = { incoming ->
                        maintenance().withLock {
                            requireCurrentEpoch(workspaceEpoch)
                            val operation = currentCoroutineContext()
                            val owner = operation[CoroutineName]?.name
                            require(active.keys.none { it != owner }) { "请等待其他研究任务完成，再合并原件" }
                            val conflicts = FullWorkspaceMerge.merge(research, personal, incoming) { operation.ensureActive() }
                            reloadLibrary()
                            conflicts
                        }
                    }
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                workspaceFailed = true
                null
            } else null

            val result = try {
                cloud.syncPersonal(
                    capture = {
                        maintenance().withLock {
                            requireCurrentEpoch(workspaceEpoch)
                            personal.snapshot()
                        }
                    },
                    preUploadCheck = { before, _ ->
                        maintenance().withLock {
                            currentCoroutineContext().ensureActive()
                            requireCurrentEpoch(workspaceEpoch)
                            val current = personal.snapshot()
                            require(PersonalWebDavSync.unchanged(before, current)) { "同步期间本机资料已编辑，请再同步一次" }
                        }
                    },
                    commit = { before, plan ->
                        maintenance().withLock {
                            currentCoroutineContext().ensureActive()
                            requireCurrentEpoch(workspaceEpoch)
                            val current = personal.snapshot()
                            if (!PersonalWebDavSync.unchanged(before, current)) {
                                if (plan.upload != null) {
                                    runCatching {
                                        personal.replaceValidated(PersonalWebDavSync.acknowledgeUpload(current, plan))
                                    }
                                }
                                throw IllegalArgumentException("同步期间本机资料已编辑，请再同步一次")
                            }
                            personal.replaceValidated(PersonalWebDavSync.apply(current, plan))
                            recordSyncedNoteConflicts(plan.noteConflicts)
                        }
                    }
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (command != "cloud.syncWorkspace") throw error
                personalFailed = true
                JSONObject()
                    .put("favorites", personal.snapshot().getJSONArray("favorites").length())
                    .put("conflicts", 0)
                    .put("noteConflicts", JSONArray(noteConflictsSnapshot().map { it.json() }))
            }
            result.put("workspaceSynced", full != null).put("personalSynced", !personalFailed)

            val artifactConflicts = full?.getInt("artifactConflicts") ?: 0
            if (full != null) {
                result.put("uploaded", full.getBoolean("uploaded"))
                    .put("snapshots", full.getInt("snapshots"))
                    .put("artifactConflicts", artifactConflicts)
            }
            val summary = when {
                workspaceFailed && personalFailed -> "WebDAV 同步未完成，原资料已保留"
                workspaceFailed -> "收藏和笔记已同步，研究资料待重试"
                personalFailed -> "研究资料已同步，收藏和笔记待重试"
                else -> "WebDAV 同步完成"
            }
            onNotice(
                "$summary · 收藏 ${result.getInt("favorites")} 篇" +
                    (if (result.getInt("conflicts") > 0) " · ${result.getInt("conflicts")} 项编辑冲突，两端版本已保留" else "") +
                    (if (artifactConflicts > 0) " · $artifactConflicts 项原件冲突，可在资料设置中导出保留快照" else "")
            )
            result
        }
        "cloud.upload" -> maintenance().withLock {
            requireCurrentEpoch(workspaceEpoch)
            val profile = cloud.state()
            require(profile.optString("account").isNotBlank()) { "请先保存坚果云账号" }
            require(profile.optString("credentialState") !in setOf("missing", "unavailable")) { "请先安全保存坚果云应用密码" }
            reconcileCloudTransfers()
            require(
                personal.snapshot().getJSONArray("jobs").objects().none {
                    it.optString("kind") == "cloud.upload" && it.optString("status") in setOf("queued", "running")
                }
            ) { "已有备份任务，请先等待或停止后续传" }
            val id = UUID.randomUUID()
            val row = JSONObject()
                .put("id", id.toString())
                .put("kind", command)
                .put("paperID", "")
                .put("status", "queued")
                .put("createdAt", now())
                .put("message", "等待网络可用后继续原快照备份")
            personal.upsertJob(row)
            withContext(NonCancellable) {
                try {
                    enqueueCloudUploadWork(id, cloud.targetID, workspaceEpoch)
                } catch (_: Exception) {
                    personal.upsertJob(
                        row.copy().put("status", "interrupted").put("endedAt", now())
                            .put("message", "系统未确认接收备份任务。原材料保留，可重新选择继续备份。")
                    )
                    throw AppFailure("backupQueue", "系统未确认接收备份任务，请重试。")
                }
            }
            JSONObject()
                .put("queued", true)
                .put("jobID", id.toString())
                .put("message", "备份已加入后台任务，完整回读通过后才会标为完成")
        }
        "cloud.list" -> cloudSelections.list(payload.getString("month"))
        "cloud.restore.prepare" -> {
            val selectionID = payload.getString("selectionID")
            runTask(command, {
                requireCurrentEpoch(workspaceEpoch)
                cloudSelections.requireSelection(selectionID)
            }) {
                val operation = currentCoroutineContext()
                val prepared = cloudSelections.prepare(selectionID) { operation.ensureActive() }
                restoreToken(prepared.staged, workspaceEpoch).put("reference", prepared.manifest.reference.json())
            }
        }
        "cloud.archivePending" -> cloud.archivePending()
        "cloud.retained.list" -> JSONObject().put("retained", cloud.retainedList())
        "retained.list" -> JSONObject().put(
            "transfers",
            JSONArray(cloud.retainedList().objects().map { row ->
                row.copy().put("id", row.optString("transferID", row.optString("id")))
            })
        )
        else -> throw AppFailure("unsupported", "云端操作尚不支持")
    }

    suspend fun performCloudUpload(
        id: String,
        workspaceEpoch: String,
        expectedDestinationID: String,
        enterForeground: suspend () -> Unit = {},
    ) {
        val job = currentCoroutineContext()[Job]!!
        val row = maintenance().withLock {
            requireCurrentEpoch(workspaceEpoch)
            val original = personal.snapshot().getJSONArray("jobs").objects()
                .firstOrNull { it.optString("id") == id }?.copy() ?: error("备份任务不存在")
            require(!active.containsKey(id)) { "原备份任务正在运行" }
            require(original.optString("kind") == "cloud.upload" && original.optString("status") in setOf("queued", "running")) {
                "原备份任务已结束"
            }
            personal.upsertJob(original.put("status", "running").put("startedAt", now()))
            active[id] = job
            original
        }
        try {
            onRefresh()
            enterForeground()
            withContext(CoroutineName(id)) { cloud.upload(expectedDestinationID = expectedDestinationID) }
            val latest = personal.snapshot().getJSONArray("jobs").objects().firstOrNull { it.optString("id") == id } ?: row
            personal.upsertJob(
                latest.put("status", "completed").put("endedAt", now())
                    .put("message", "原快照所有分块及完成清单已回读核验")
            )
        } catch (e: Exception) {
            val latest = personal.snapshot().getJSONArray("jobs").objects().firstOrNull { it.optString("id") == id } ?: row
            personal.upsertJob(
                latest.put("status", if (e is CancellationException) "cancelled" else "failed").put("endedAt", now())
                    .put(
                        "message",
                        if (e is CloudFailure && e.code == "targetChanged") e.message
                        else "备份未完成；已有原快照和检查点保留，请核对后续传"
                    )
            )
            throw e
        } finally {
            active.remove(id)
            onRefresh()
        }
    }
}
