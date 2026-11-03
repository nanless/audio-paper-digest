package com.nanless.paperdigest.cloud

import com.nanless.paperdigest.protocols.ClientProtocols
import com.nanless.paperdigest.secret.SecretStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.time.Instant
import java.util.UUID
import kotlin.coroutines.coroutineContext

/** Root implements this with its shared editing/job/maintenance lock and confirmation UI. */
interface CloudWorkspace {
    suspend fun capture(output: File): BackupCodec.Captured
    suspend fun restore(staged: BackupCodec.Staged)
}

class CloudService(
    private val researchRoot: File, val controlRoot: File, private val vault: SecretStore,
    private val workspace: CloudWorkspace, private val transport: CloudTransport = NutstoreTransport(),
    private val now: () -> Long = System::currentTimeMillis,
    private val scheduleChanged: (JSONObject) -> Unit = {},
    private val sleep: suspend (Long) -> Unit = { kotlinx.coroutines.delay(it) },
    private val borrowing: CloudCredentialBorrowing? = null
) {
    private val lock = Mutex(); @Volatile private var busy = false
    @Volatile private var credentialState = "unknown"; @Volatile private var memoryPaused = false
    private var cached: Pair<String, CloudArchive>? = null
    @Volatile private var profile: JSONObject
    init {
        require(!controlRoot.canonicalPath.startsWith(researchRoot.canonicalPath + "/") && controlRoot.canonicalPath != researchRoot.canonicalPath)
        if (!controlRoot.exists()) require(controlRoot.mkdirs()); BackupCodec.checkedDirectory(controlRoot); BackupCodec.privateDirectory(controlRoot)
        val file = File(controlRoot, "profile.json")
        profile = if (file.exists()) readJSON(file, 64 * 1024) else ClientProtocols.record("paperdigest-android-cloud-profile").put("destinationID", UUID.randomUUID().toString()).put("account", "").put("folder", "PaperDigest").put("automatic", false).put("intervalHours", 24).put("automaticPaused", false)
        validateProfile(profile)
        borrowing?.attachOwner(::credentialBinding, ::borrowedAuthorization)
    }
    fun credentialBinding(): CloudCredentialBinding { val p = profile; return CloudCredentialBinding(p.getString("destinationID"), p.getString("account"), p.getString("folder")) }
    fun credentialsTargetWouldChange(account: String, folder: String): Boolean = account.trim() != profile.getString("account") || folder != profile.getString("folder")
    fun beginCredentialMutation(): CloudCredentialMutation? = borrowing?.beginMutation()
    suspend fun drainCredentialBorrowers(token: CloudCredentialMutation?) { if (token != null) requireNotNull(borrowing).drain(token) }
    fun endCredentialMutation(token: CloudCredentialMutation?) { if (token != null) requireNotNull(borrowing).endMutation(token) }
    private fun borrowedAuthorization(binding: CloudCredentialBinding): String {
        if (binding != credentialBinding()) throw CloudFailure("selectionExpired")
        val password = try { vault.load("cloud.${binding.destinationID}") ?: throw CloudFailure("credentialsUnavailable") }
        catch (e: CancellationException) { throw e } catch (_: Exception) { throw CloudFailure("credentialsUnavailable") }
        if (binding != credentialBinding()) throw CloudFailure("selectionExpired")
        require(password.toByteArray(Charsets.UTF_8).size <= 8192 && password.isNotBlank() && Charsets.UTF_8.newEncoder().canEncode(password) && password.none { it.code < 32 || it.code == 127 }) { "已保存的坚果云连接暂不可用" }
        return okhttp3.Credentials.basic(binding.account, password, Charsets.UTF_8)
    }
    private val destinationID get() = profile.getString("destinationID")
    val targetID: String get() = destinationID
    val credentialScope get() = "cloud.$destinationID"
    private fun targetFolder(id: String = destinationID): File = File(controlRoot, id).also { if (it.exists()) BackupCodec.checkedDirectory(it) }
    private fun hasPending(id: String = destinationID): Boolean { val folder = targetFolder(id); return listOf("pending.json", "snapshot.paperdigest").any { File(folder, it).exists() || Files.isSymbolicLink(File(folder, it).toPath()) } }
    private fun persistProfile(next: JSONObject) { validateProfile(next); BackupCodec.atomicJSON(File(controlRoot, "profile.json"), next); profile = next }
    private fun copyProfile() = JSONObject(profile.toString())
    private fun pause(paused: Boolean) { memoryPaused = paused; val next = copyProfile().put("automaticPaused", paused); persistProfile(next); scheduleChanged(state()) }
    fun state(): JSONObject {
        val current = profile; val id = current.getString("destinationID")
        val state = JSONObject(current.toString()).put("busy", busy).put("credentialState", credentialState).put("automaticPaused", memoryPaused || current.optBoolean("automaticPaused"))
        state.remove("destinationID")
        if (hasPending(id)) {
            val pending = runCatching { pending(id) }.getOrNull()
            state.put("pending", if (pending == null) JSONObject().put("damaged", true).put("notice", "未完成材料损坏或缺失，可原样保留退出；不保证恢复") else JSONObject().put("createdAt", pending.getString("createdAt")).put("fileCount", pending.getInt("fileCount")).put("encodedBytes", pending.getLong("encodedBytes")).put("sha256", pending.getString("sha256")).put("retryAfter", pending.optJSONObject("checkpoint")?.opt("retryAfter") ?: JSONObject.NULL))
        } else state.put("pending", JSONObject.NULL)
        return state
    }
    private suspend fun <T> operation(body: suspend () -> T): T = withContext(Dispatchers.IO) {
        if (!lock.tryLock()) throw CloudFailure("busy"); busy = true
        try { coroutineContext.ensureActive(); body() }
        catch (e: CancellationException) { throw e }
        catch (e: CloudFailure) { if (e.code == "authentication" || e.code == "credentialsUnavailable") pause(true); throw e }
        finally { busy = false; lock.unlock() }
    }
    suspend fun save(account: String, folder: String, automatic: Boolean, intervalHours: Int, credentialMutation: CloudCredentialMutation? = null): JSONObject {
        val owned = credentialMutation == null
        val token = credentialMutation ?: if (credentialsTargetWouldChange(account, folder)) beginCredentialMutation() else null
        try {
            drainCredentialBorrowers(token)
            return operation {
                if (token != null) requireNotNull(borrowing).requireMutation(token)
        val trimmed = account.trim(); val changed = trimmed != profile.getString("account") || folder != profile.getString("folder")
        require(!changed || !hasPending()) { "请先续传或原样保留未完成材料，再更换账号或目录" }
        val next = copyProfile().put("account", trimmed).put("folder", folder).put("automatic", automatic).put("intervalHours", intervalHours)
        if (changed) { next.put("destinationID", UUID.randomUUID().toString()).remove("lastBackup"); next.remove("lastAttemptAt"); next.put("automaticPaused", false) }
        validateProfile(next); require(!automatic || trimmed.isNotEmpty()) { "先保存账号再开启自动备份" }
        persistProfile(next)
        if (changed) { cached = null; credentialState = "unknown"; memoryPaused = false }
        scheduleChanged(state()); state()
            }
        } finally { if (owned) endCredentialMutation(token) }
    }
    suspend fun setPassword(value: String?, credentialMutation: CloudCredentialMutation? = null): JSONObject {
        val owned = credentialMutation == null; val token = credentialMutation ?: beginCredentialMutation()
        try {
            drainCredentialBorrowers(token)
            return operation {
                if (token != null) requireNotNull(borrowing).requireMutation(token)
                if (value == null) { vault.remove(credentialScope); cached = null; credentialState = "missing"; pause(true) }
                else { vault.save(credentialScope, value); cached = null; credentialState = "present" }
                state()
            }
        } finally { if (owned) endCredentialMutation(token) }
    }
    suspend fun check(): JSONObject = operation { archive().probe(); credentialState = "present"; pause(false); state() }
    suspend fun list(month: String): List<JSONObject> = operation { archive().list(month).map { it.info() } }
    internal suspend fun listBound(month: String, expectedDestinationID: String): List<CloudSnapshotIdentity> = operation {
        if (destinationID != expectedDestinationID) throw CloudFailure("selectionExpired")
        archive().listIdentities(month)
    }
    suspend fun upload(automatic: Boolean = false, expectedDestinationID: String = targetID): JSONObject = operation {
        // A queued worker's target is authority, not a hint. Check after the
        // operation mutex is held, before obtaining credentials or a snapshot.
        if (destinationID != expectedDestinationID) throw CloudFailure("targetChanged")
        if (automatic) require(profile.optBoolean("automatic") && !profile.optBoolean("automaticPaused") && !memoryPaused) { "自动备份已暂停" }
        val capturedContext=coroutineContext;val check={capturedContext.ensureActive()}
        val archive = archive(); var pendingRecord = pending()
        if (pendingRecord == null) {
            require(!hasPending()) { "原待传材料损坏，须先原样保留退出" }
            archive.probe(); coroutineContext.ensureActive()
            val folder = targetFolder(); require(folder.exists() || folder.mkdir()); BackupCodec.privateDirectory(folder)
            val snapshot = workspace.capture(File(folder, "snapshot.paperdigest"))
            require(snapshot.file.canonicalPath == File(folder, "snapshot.paperdigest").canonicalPath && snapshot.encodedBytes == snapshot.file.length()) { "快照材料未绑定本机原文件" }
            pendingRecord = ClientProtocols.record("paperdigest-android-cloud-pending").put("destinationID", destinationID).put("createdAt", Instant.ofEpochMilli(now()).toString()).put("fileCount", snapshot.fileCount).put("encodedBytes", snapshot.encodedBytes).put("sha256", snapshot.sha256)
            BackupCodec.atomicJSON(File(folder, "pending.json"), pendingRecord)
        }
        val original = pendingRecord ?: error("未找到待传材料"); val file = validateSnapshot(original,check)
        val next = copyProfile().put("lastAttemptAt", Instant.ofEpochMilli(now()).toString()); persistProfile(next)
        val old = original.optJSONObject("checkpoint")?.let(CloudCheckpoint::parse)
        val info = archive.upload(file, old)
        val final = pending() ?: error("续传记录未保存"); validateSnapshot(final,check)
        val checkpoint = CloudCheckpoint.parse(final.getJSONObject("checkpoint"))
        require(checkpoint.manifest == info && checkpoint.manifestVerified && checkpoint.verified == info.chunks.indices.toSet()) { "完整回执未逐项绑定原快照" }
        val completedProfile = copyProfile().put("lastBackup", info.info()).put("automaticPaused", false)
        persistProfile(completedProfile); memoryPaused = false
        val retained = File(controlRoot, "completed-${UUID.randomUUID()}"); Files.move(targetFolder().toPath(), retained.toPath(), ATOMIC_MOVE)
        retained.deleteRecursively(); scheduleChanged(state()); info.info()
    }
    data class PreparedRestore(val id: String, val staged: BackupCodec.Staged, val manifest: CloudManifest)
    suspend fun prepareRestore(reference: CloudReference, check: () -> Unit = {}): PreparedRestore = prepareRestoreInternal(reference, null, null, check)
    internal suspend fun prepareRestoreBound(expected: CloudSnapshotIdentity, expectedDestinationID: String, check: () -> Unit = {}): PreparedRestore =
        prepareRestoreInternal(expected.reference, expected, expectedDestinationID, check)
    private suspend fun prepareRestoreInternal(reference: CloudReference, expected: CloudSnapshotIdentity?, expectedDestinationID: String?, check: () -> Unit): PreparedRestore {
        var preparedStage:BackupCodec.Staged?=null
        try { return operation {
            if (expectedDestinationID != null && destinationID != expectedDestinationID) throw CloudFailure("selectionExpired")
            val capturedContext=coroutineContext;val stageCheck={capturedContext.ensureActive();check()}
            stageCheck()
            val file = File(controlRoot, "download-${UUID.randomUUID()}.paperdigest")
            try {
                val manifest = archive().download(reference, file, expected)
                val staged = BackupCodec.stage(file.inputStream(), researchRoot.parentFile!!,stageCheck)
                preparedStage=staged
                if (staged.encodedSHA256 != manifest.sha256 || staged.encodedBytes != manifest.encodedBytes) throw CloudFailure("integrity")
                stageCheck();PreparedRestore(UUID.randomUUID().toString(), staged, manifest)
            } finally { file.delete() }
        }} catch(failure:Throwable) {
            // Includes cancellation while returning from operation's IO dispatcher.
            preparedStage?.directory?.let{if(it.exists())it.deleteRecursively()}
            throw failure
        }
    }
    suspend fun retainedList(): JSONArray = operation {
        val rows = controlRoot.listFiles().orEmpty().filter { it.name.matches(Regex("archived-[a-fA-F0-9-]{36}")) }.sortedBy { it.name }.map { folder ->
            BackupCodec.checkedDirectory(folder)
            val file = File(folder, "snapshot.paperdigest")
            val present = file.isFile && !Files.isSymbolicLink(file.toPath())
            JSONObject().put("transferID", folder.name).put("snapshotPresent", present).put("encodedBytes", if (present) file.length() else 0).put("notice", "原样保留材料；损坏或缺失快照不保证恢复")
        }
        JSONArray(rows)
    }
    suspend fun retainedSnapshot(transferID: String): File = operation {
        require(transferID.matches(Regex("archived-[a-fA-F0-9-]{36}")))
        val folder = File(controlRoot, transferID); BackupCodec.checkedDirectory(folder)
        BackupCodec.checkedFile(folder, "snapshot.paperdigest").also { require(it.length() <= BackupCodec.MAX_ENCODED) }
    }
    suspend fun restore(reference: CloudReference, credentialMutation: CloudCredentialMutation? = null): JSONObject {
        val owned=credentialMutation==null;val token=credentialMutation?:beginCredentialMutation()
        try {
            drainCredentialBorrowers(token)
            return operation {
                if(token!=null)requireNotNull(borrowing).requireMutation(token)
        val file = File(controlRoot, "download-${UUID.randomUUID()}.paperdigest")
        var staged: BackupCodec.Staged? = null
        try {
            val manifest = archive().download(reference, file)
            val capturedContext=coroutineContext
            staged = BackupCodec.stage(file.inputStream(), researchRoot.parentFile!!){capturedContext.ensureActive()}
            require(staged.encodedSHA256 == manifest.sha256 && staged.encodedBytes == manifest.encodedBytes)
            workspace.restore(staged)
            JSONObject().put("sha256", manifest.sha256).put("reference", reference.json()).put("status", "complete")
        } finally { file.delete(); staged?.directory?.let { if (it.exists()) it.deleteRecursively() } }
            }
        } finally { if(owned)endCredentialMutation(token) }
    }
    internal suspend fun syncPersonal(
        capture: suspend () -> JSONObject,
        commit: suspend (JSONObject, PersonalWebDavSync.Plan) -> Unit
    ): JSONObject = operation {
        val original = capture()
        val service = archive()
        val device = destinationID
        val remote = service.personalDocuments()
        val plan = PersonalWebDavSync.plan(original, device, remote.heads)
        plan.upload?.let { service.writePersonalDocument(it, remote) }
        coroutineContext.ensureActive()
        commit(original, plan)
        JSONObject().put("favorites", plan.personal.getJSONArray("favorites").length())
            .put("conflicts", plan.conflicts)
    }

    internal suspend fun syncFull(
        workspaceEpoch: String,
        capture: suspend (File) -> BackupCodec.Captured,
        merge: suspend (BackupCodec.Staged) -> Int
    ): JSONObject = operation {
        val activeContext = coroutineContext
        val check = { activeContext.ensureActive() }
        val directory = fullSyncFolder(destinationID)
        val outbox = File(directory, "pending.paperdigest")
        val checkpointFile = File(directory, "checkpoint.json")
        val captureIdentity = File(directory, "capture.json")
        val last = File(directory, "last-sent.json")
        val service = archive(fullSync = true)
        try {
            if (!outbox.exists()) {
                require(!checkpointFile.exists()) { "待同步快照缺失，原续传记录已保留" }
                BackupCodec.atomicJSON(captureIdentity, JSONObject().put("workspaceEpoch", workspaceEpoch))
                val captured = capture(outbox)
                BackupCodec.requireNormalCapture(captured)
                require(captured.file == outbox)
            }
            val file = BackupCodec.checkedFile(directory, outbox.name)
            val sha = BackupCodec.hash(file, check)
            val old = if (checkpointFile.exists()) CloudCheckpoint.parse(readJSON(checkpointFile, 4 * 1024 * 1024)) else null
            var sent = false
            if (old != null || !last.exists() || readJSON(last, 64 * 1024).optString("sha256") != sha) {
                val stage = BackupCodec.stage(file.inputStream(), directory, check)
                try { BackupCodec.requirePortableInventory(stage.entries) } finally { stage.directory.deleteRecursively() }
                val manifest = service.upload(file, old)
                val final = CloudCheckpoint.parse(readJSON(checkpointFile, 4 * 1024 * 1024))
                require(final.manifest == manifest && final.manifestVerified && final.verified == manifest.chunks.indices.toSet())
                BackupCodec.atomicJSON(File(directory, "sent-${manifest.reference.id}.json"), manifest.info().put("workspaceEpoch", if (captureIdentity.exists()) readJSON(captureIdentity, 64 * 1024).getString("workspaceEpoch") else ""))
                BackupCodec.atomicJSON(last, manifest.info())
                sent = true
            }
            // Retire the checkpoint first. A crash between deletions still
            // leaves the original outbox and the durable completed receipt.
            if (checkpointFile.exists()) require(checkpointFile.delete())
            require(file.delete())
            if (captureIdentity.exists()) require(captureIdentity.delete())
            val sentID = readJSON(last, 64 * 1024).getJSONObject("reference").getString("id")
            val observed = HashSet<String>()
            val required = directory.listFiles().orEmpty().mapNotNull {
                val matched = Regex("^(?:accepted|sent)-([a-f0-9-]{36})[.]json$").matchEntire(it.name)
                matched?.groupValues?.get(1)
            }.toSet() + sentID
            var imported = 0
            var conflicts = 0
            for (month in service.fullSyncMonths()) for (identity in service.listIdentities(month)) {
                check()
                val id = identity.reference.id
                require(observed.add(id)) { "云端返回了重复的同步版本" }
                val accepted = File(directory, "accepted-$id.json")
                val previous = File(directory, "sent-$id.json")
                if (previous.exists()) {
                    val receipt = readJSON(previous, 64 * 1024)
                    require(receipt.getString("sha256") == identity.sha256) { "原云端同步版本已变化" }
                    if (receipt.optString("workspaceEpoch") == workspaceEpoch) continue
                }
                val prior = if (accepted.exists()) readJSON(accepted, 64 * 1024) else null
                if (prior != null) {
                    require(prior.getString("manifestSHA256") == identity.manifestSHA256) { "原云端同步版本已变化" }
                    if (prior.optString("workspaceEpoch") == workspaceEpoch) continue
                }
                val retained = File(controlRoot, "archived-$id")
                if (!retained.exists()) require(retained.mkdir())
                BackupCodec.checkedDirectory(retained); BackupCodec.privateDirectory(retained)
                val original = File(retained, "snapshot.paperdigest")
                if (!original.exists()) {
                    val partial = File(directory, ".download-${UUID.randomUUID()}")
                    try {
                        service.download(identity.reference, partial, identity)
                        require(partial.length() == identity.encodedBytes && BackupCodec.hash(partial, check) == identity.sha256)
                        Files.move(partial.toPath(), original.toPath(), ATOMIC_MOVE)
                    } finally { partial.delete() }
                }
                val staged = BackupCodec.stage(BackupCodec.checkedFile(retained, original.name).inputStream(), directory, check)
                try {
                    require(staged.encodedSHA256 == identity.sha256 && staged.encodedBytes == identity.encodedBytes)
                    val count = merge(staged)
                    conflicts += count
                    BackupCodec.atomicJSON(accepted, identity.info().put("conflicts", maxOf(count, prior?.optInt("conflicts") ?: 0)).put("workspaceEpoch", workspaceEpoch))
                    imported++
                    if (count == 0 && (prior?.optInt("conflicts") ?: 0) == 0) retained.deleteRecursively()
                } finally { staged.directory.deleteRecursively() }
            }
            require(observed.containsAll(required)) { "未能重新核对已见过的云端版本，原资料仍在本机" }
            JSONObject().put("uploaded", sent).put("snapshots", imported).put("artifactConflicts", conflicts)
        } finally {
            // Both archive scopes persist the same account request pacing.
            // The ordinary archive must reload it after a full sync.
            cached = null
        }
    }

    private fun fullSyncFolder(id: String): File {
        val directory = File(controlRoot, "full-sync-$id")
        if (!directory.exists()) require(directory.mkdir())
        BackupCodec.checkedDirectory(directory); BackupCodec.privateDirectory(directory)
        return directory
    }

    suspend fun archivePending(): JSONObject = operation {
        require(hasPending()) { "没有未完成材料" }; val folder = targetFolder(); BackupCodec.checkedDirectory(folder)
        val connection = File(folder, if (File(folder, "connection.json").exists()) "connection-${UUID.randomUUID()}.json" else "connection.json")
        BackupCodec.atomicJSON(connection, profile); pause(true)
        val retained = File(controlRoot, "archived-${UUID.randomUUID()}"); Files.move(folder.toPath(), retained.toPath(), ATOMIC_MOVE)
        JSONObject().put("transferID", retained.name).put("notice", "已原样保留材料并结束本次续传；损坏或缺失快照不保证恢复")
    }
    private fun pending(id: String = destinationID): JSONObject? {
        val file = File(targetFolder(id), "pending.json"); if (!file.exists()) return null
        val o = readJSON(file, 4 * 1024 * 1024)
        require(ClientProtocols.hasValidHeader(o,"paperdigest-android-cloud-pending") && o.getString("destinationID") == id)
        require(CloudManifest.number(o, "encodedBytes") in 1..BackupCodec.MAX_ENCODED && CloudManifest.number(o, "fileCount") in 1..BackupCodec.MAX_ENTRIES.toLong() && BackupCodec.validSHA(o.getString("sha256")))
        return o
    }
    private fun validateSnapshot(pending: JSONObject, check: () -> Unit): File {
        val file = BackupCodec.checkedFile(targetFolder(), "snapshot.paperdigest")
        require(file.length() == pending.getLong("encodedBytes") && BackupCodec.hash(file,check) == pending.getString("sha256")) { "原待传快照字节已变化" }
        val stage = BackupCodec.stage(file.inputStream(), controlRoot,check)
        try {
            require(stage.entries.size == pending.getInt("fileCount")) { "原快照文件数变化" }
            // Check the actual original archive inventory before upload, checkpoint
            // updates or lastAttemptAt writes. Do not normalize old pending bytes.
            BackupCodec.requirePortableInventory(stage.entries)
        } finally { stage.directory.deleteRecursively() }
        return file
    }
    private fun archive(fullSync: Boolean = false): CloudArchive {
        if (!fullSync) cached?.takeIf { it.first == destinationID }?.let { return it.second }
        val id = destinationID; val folder = profile.getString("folder"); val account = profile.getString("account"); require(account.isNotEmpty()) { "请先保存坚果云账号" }
        return CloudArchive(folder, id, credentials = {
            try { val password = vault.load("cloud.$id") ?: throw CloudFailure("credentialsUnavailable"); credentialState = "present"; CloudCredentials(account, password) }
            catch (e: CancellationException) { throw e } catch (e: Exception) { coroutineContext.ensureActive(); credentialState = "unavailable"; throw CloudFailure("credentialsUnavailable") }
        }, saveCheckpoint = { cp ->
            require(destinationID == id && cp.destinationID == id)
            if (fullSync) {
                require(cp.folder == "$folder/full-sync-v1")
                val file = File(fullSyncFolder(id), "checkpoint.json")
                if (file.exists()) require(CloudCheckpoint.parse(readJSON(file, 4 * 1024 * 1024)).manifest == cp.manifest)
                BackupCodec.atomicJSON(file, cp.json())
            } else {
                require(cp.folder == folder)
                val original = pending() ?: error("原续传记录缺失")
                require(cp.manifest.sha256 == original.getString("sha256") && cp.manifest.encodedBytes == original.getLong("encodedBytes"))
                original.optJSONObject("checkpoint")?.let { oldJSON -> val old = CloudCheckpoint.parse(oldJSON); require(old.manifest == cp.manifest) { "不能更换原远端版本" } }
                BackupCodec.atomicJSON(File(targetFolder(), "pending.json"), original.put("checkpoint", cp.json()))
            }
        }, transport = transport, now = now, sleep = sleep, loadTraffic = { val file = File(controlRoot, "traffic-$id.json"); if (file.exists()) readJSON(file, 128 * 1024) else JSONObject() }, saveTraffic = { BackupCodec.atomicJSON(File(controlRoot, "traffic-$id.json"), it) }, fullSync = fullSync).also { if (!fullSync) cached = id to it }
    }
    companion object {
        private fun validateProfile(o: JSONObject) {
            require(ClientProtocols.hasValidHeader(o,"paperdigest-android-cloud-profile")); UUID.fromString(o.getString("destinationID"))
            val account = o.getString("account"); require(account.toByteArray().size <= 320 && ':' !in account && account.none { it.code < 32 || it.code == 127 })
            require(CloudArchive.validFolder(o.getString("folder")) && CloudManifest.number(o, "intervalHours") in 6..168 && o.get("automatic") is Boolean && o.get("automaticPaused") is Boolean)
        }
        private fun readJSON(file: File, limit: Int): JSONObject { require(file.isFile && !Files.isSymbolicLink(file.toPath()) && file.length() <= limit); return JSONObject(file.readText()) }
    }
}
