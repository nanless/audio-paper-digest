package com.nanless.paperdigest.data

import com.nanless.paperdigest.cloud.BackupCodec
import kotlinx.coroutines.CancellationException
import org.json.JSONObject
import java.io.File
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardOpenOption
import java.security.MessageDigest
import java.util.UUID

/** Native-only control files outside Research. This store never regenerates research or grants cleanup. */
class PendingExportStore(exportsRoot: File, controlRoot: File,
    private val timestamp: () -> String = { now() },
    private val persistedBoundary: (String) -> Unit = {}) {
    private val exports = root(exportsRoot)
    private val controls = root(controlRoot)
    private val controlIdentity = directoryIdentity(controls)
    init {
        require(exports != controls && !exports.toPath().startsWith(controls.toPath()) && !controls.toPath().startsWith(exports.toPath()))
    }

    data class Artifact(val documentID: String, val file: File, val mime: String, val name: String,
        val bytes: Long, val sha256: String, val manifestSHA256: String)
    data class PendingExport(val operationID: String, val jobID: String, val documentID: String,
        val preparation: String, val phase: String, val delivery: String, val attemptID: String?,
        val sourceIdentity: JSONObject, val createdAt: String, val updatedAt: String,
        val message: String?, val artifact: Artifact?) {
        fun json() = JSONObject().put("operationID", operationID).put("jobID", jobID).put("documentID", documentID)
            .put("preparation", preparation).put("phase", phase).put("delivery", delivery)
            .put("attemptID", attemptID ?: JSONObject.NULL).put("sourceIdentity", sourceIdentity.copy())
            .put("createdAt", createdAt).put("updatedAt", updatedAt).put("message", message ?: JSONObject.NULL)
            .put("ready", artifact != null && preparation == "ready")
            .also { out -> artifact?.let { out.put("mime", it.mime).put("suggestedName", it.name).put("bytes", it.bytes).put("sha256", it.sha256).put("manifestSHA256", it.manifestSHA256) } }
    }

    /** Reserve the document UUID before any output exists. ExportService must use this exact UUID. */
    @Synchronized fun begin(jobID: String, format: String, sourceIdentity: JSONObject): PendingExport {
        uuid(jobID); require(format.matches(Regex("[a-z][a-z0-9-]{0,63}")))
        val source = sourceIdentity.copy(); require(canonical(source).toByteArray(Charsets.UTF_8).size <= 4096)
        val id = UUID.randomUUID().toString(); val document = UUID.randomUUID().toString(); val time = time()
        val dir = operationDirectory(id, create = true)
        val record = JSONObject().put("contract", CONTRACT).put("operationID", id).put("jobID", jobID)
            .put("documentID", document).put("format", format).put("sourceIdentity", source)
            .put("createdAt", time).put("updatedAt", time).put("preparation", "preparing").put("phase", "requested")
            .put("delivery", "none").put("attemptID", JSONObject.NULL)
        write(record); persistedBoundary("begin.persisted")
        return view(record, null)
    }

    /** The only preparation temp owned by this operation. Existing bytes are never overwritten here. */
    @Synchronized fun preparationFile(operationID: String): File {
        val record = record(operationID); require(record.getString("preparation") in setOf("preparing", "interrupted"))
        return checked(operationDirectory(operationID), "capture.tmp", regularIfPresent = true)
    }

    @Synchronized fun phase(operationID: String, phase: String): PendingExport {
        require(phase in setOf("requested", "capturing", "encoding", "verifying"))
        val record = record(operationID); require(record.getString("preparation") in setOf("preparing", "interrupted"))
        record.put("preparation", "preparing").put("phase", phase); write(record)
        return view(record, null)
    }

    /** Actual manifest/bin verification precedes the durable ready commit; no caller-provided hash is trusted. */
    @Synchronized fun markReady(operationID: String, check: () -> Unit = {}): PendingExport {
        val record = record(operationID)
        require(record.getString("preparation") in setOf("preparing", "interrupted", "ready", "unavailable"))
        check()
        val documentID = record.getString("documentID")
        val current = readExport(documentID, check)
        val original = checked(operationDirectory(operationID), "manifest.original.json", regularIfPresent = true)
        val expected = record.nullableString("manifestSHA256")
        if (expected != null) {
            require(BackupCodec.validSHA(expected))
            if (!original.exists()) {
                require(BackupCodec.hash(current.second) == expected) { "原清单尚未封存且当前清单已变化，未认领另一份导出" }
                createOnly(original, current.second)
            }
            require(original.isFile && hash(original, check) == expected) { "原准备清单不可用，未重建或认领另一份导出" }
            require(core(JSONObject(PublishedUtf8.decode(JsonFiles.read(original, META_LIMIT)))) == core(current.first)) { "原导出材料身份已经变化" }
        } else {
            // Intent binds this reserved UUID to these exact original bytes before ready.
            val raw = current.second
            record.put("manifestSHA256", BackupCodec.hash(raw)); write(record); persistedBoundary("candidate.persisted")
            if (original.exists()) require(JsonFiles.read(original, META_LIMIT).contentEquals(raw)) { "原准备清单存在且不同，不覆盖" }
            else createOnly(original, raw)
            persistedBoundary("manifest.persisted")
        }
        val sha = record.getString("manifestSHA256")
        require(original.isFile && hash(original, check) == sha)
        // Recheck after writing control material, before success becomes observable.
        val artifact = verify(record, check)
        check(); record.put("preparation", "ready").put("phase", "ready").remove("message")
        write(record); persistedBoundary("ready.persisted")
        return view(record, artifact)
    }

    /** Reconciliation is read/verify only. Interrupted preparations are never automatically recaptured/adopted. */
    @Synchronized fun reconcile(activeJobIDs: Set<String> = emptySet(), activeAttemptIDs: Set<String> = emptySet(), check: () -> Unit = {}): List<PendingExport> {
        val result = ArrayList<PendingExport>()
        requireControlDirectory()
        for (entry in children(controls).sortedBy { it.name }) {
            check()
            if (!UUID_PATTERN.matches(entry.name)) continue // Preserve unknown material; never delete it.
            val record = record(entry.name)
            if (record.getString("preparation") == "preparing" && record.getString("jobID") !in activeJobIDs) {
                record.put("preparation", "interrupted").put("message", "上次准备中断；已有材料保留，不会自动重新采集。")
                write(record)
            }
            val attempt = record.nullableString("attemptID")
            if (attempt != null && attempt !in activeAttemptIDs && record.getString("delivery") in setOf("choosing", "writing")) {
                record.put("delivery", "failed").put("message", "上次系统保存中断；外部位置可能已有部分文件，原准备文件仍保留。")
                write(record)
            }
            result += inspect(record, check)
        }
        return result
    }

    @Synchronized fun get(operationID: String, check: () -> Unit = {}): PendingExport = inspect(record(operationID), check)

    /** UUID attempts prevent a late SAF callback from targeting a later chooser/save. */
    @Synchronized fun beginDelivery(operationID: String, check: () -> Unit = {}): PendingExport {
        val record = record(operationID); val artifact = verifyReady(record, check)
        require(record.getString("delivery") !in setOf("choosing", "writing")) { "请先结束此文件当前的保存操作" }
        val attempt = UUID.randomUUID().toString()
        record.put("attemptID", attempt).put("delivery", "choosing").remove("message"); record.remove("verifiedAt"); write(record)
        return view(record, artifact)
    }

    @Synchronized fun chooserCancelled(operationID: String, attemptID: String): PendingExport {
        val record = attempt(operationID, attemptID); require(record.getString("delivery") == "choosing")
        record.put("delivery", "cancelled").put("message", "已取消选择位置；原准备文件保留，可继续保存。")
        write(record); return inspect(record) {}
    }

    @Synchronized fun startWriting(operationID: String, attemptID: String, check: () -> Unit = {}): Artifact {
        val record = attempt(operationID, attemptID); require(record.getString("delivery") == "choosing")
        val artifact = verifyReady(record, check)
        record.put("delivery", "writing"); write(record); return artifact
    }

    @Synchronized fun recordWritten(operationID: String, attemptID: String, check: () -> Unit = {}): PendingExport {
        val record = attempt(operationID, attemptID); require(record.getString("delivery") == "writing")
        val artifact = verifyReady(record, check)
        record.put("delivery", "written-unverified").put("message", "已写入所选位置，完整回读尚未确认；原临时文件保留。")
        write(record); return view(record, artifact)
    }

    /** Root supplies a real full destination readback; no JSON boolean can mark verification. */
    @Synchronized fun verifyDelivery(operationID: String, attemptID: String, check: () -> Unit = {},
        verifier: (Artifact) -> Unit): PendingExport {
        val record = attempt(operationID, attemptID)
        require(record.getString("delivery") == "written-unverified")
        val revision = operationRevision(operationID)
        val artifact = verifyReady(record, check)
        verifier(artifact)
        check(); verifyReady(record, check)
        require(operationRevision(operationID) == revision) { "保存状态在回读期间已经变化，旧回调未改写当前操作。" }
        val current = attempt(operationID, attemptID)
        require(current.getString("delivery") == "written-unverified") { "原保存尝试已结束，未采用迟到的回读结果。" }
        current.put("delivery", "verified").put("verifiedAt", time()).put("message", "所选位置已完整回读，与原准备文件相符。")
        write(current); return view(current, artifact)
    }

    /** An unfinished provider write can leave an external partial file; never promise its rollback. */
    @Synchronized fun deliveryFailed(operationID: String, attemptID: String): PendingExport {
        val record = attempt(operationID, attemptID)
        require(record.getString("delivery") in setOf("choosing", "writing", "written-unverified"))
        record.put("delivery", "failed").put("message", "保存或回读未完成；所选位置可能已有部分文件，原准备文件保留。")
        write(record); return inspect(record) {}
    }

    /** Only this operation's capture.tmp may be removed; ready/result bins and old attempts are preserved. */
    @Synchronized fun cancelPreparation(operationID: String): PendingExport {
        val record = record(operationID)
        require(record.getString("preparation") in setOf("preparing", "interrupted", "unavailable")) { "已就绪的原件不能由准备取消删除" }
        val file = checked(operationDirectory(operationID), "capture.tmp", regularIfPresent = true)
        if (file.exists()) require(file.delete()) { "本次暂存文件未能清理，未声称已删除" }
        record.put("preparation", "cancelled").put("phase", "cancelled").put("message", "本次准备已取消；研究原件及已生成的导出文件未删除。")
        write(record); return view(record, null)
    }

    private fun inspect(record: JSONObject, check: () -> Unit): PendingExport {
        if (record.getString("preparation") != "ready") return view(record, null)
        return try { view(record, verify(record, check)) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) {
            record.put("preparation", "unavailable").put("message", "原准备文件或清单不可用，未重新生成，也未将此结果标为可继续保存。")
            write(record); view(record, null)
        }
    }
    private fun verifyReady(record: JSONObject, check: () -> Unit): Artifact {
        require(record.getString("preparation") == "ready") { "原件尚未就绪，请先核验原准备材料" }
        return verify(record, check)
    }
    private fun verify(record: JSONObject, check: () -> Unit): Artifact {
        val original = checked(operationDirectory(record.getString("operationID")), "manifest.original.json", regularIfPresent = true)
        val raw = JsonFiles.read(original, META_LIMIT)
        require(BackupCodec.hash(raw) == record.getString("manifestSHA256")) { "原准备清单已变化" }
        val originalMeta = JSONObject(PublishedUtf8.decode(raw)); val current = readExport(record.getString("documentID"), check)
        // Capacity may append independently verified save-proof fields to its mutable export manifest.
        require(core(originalMeta) == core(current.first)) { "待保存材料与原准备清单不符" }
        val id = record.getString("documentID")
        return Artifact(id, checked(exports, "$id.bin", true), originalMeta.getString("mime"), originalMeta.getString("suggestedName"),
            originalMeta.getLong("bytes"), originalMeta.getString("sha256"), record.getString("manifestSHA256"))
    }
    private fun readExport(id: String, check: () -> Unit): Pair<JSONObject, ByteArray> {
        uuid(id); val manifest = checked(exports, "$id.json", true); val raw = JsonFiles.read(manifest, META_LIMIT)
        val value = JSONObject(PublishedUtf8.decode(raw)); require(value.getString("documentID") == id)
        require(value.get("bytes") is Number && value.getLong("bytes") in 0..BackupCodec.MAX_ENCODED && value.getDouble("bytes") == value.getLong("bytes").toDouble())
        require(BackupCodec.validSHA(value.getString("sha256")))
        require(value.getString("mime").length in 3..128 && value.getString("suggestedName").length in 1..160 && '\u0000' !in value.getString("suggestedName"))
        val bin = checked(exports, "$id.bin", true)
        require(bin.isFile && bin.length() == value.getLong("bytes") && hash(bin, check) == value.getString("sha256")) { "原准备文件长度或 SHA 不符" }
        return value to raw
    }
    private fun core(value: JSONObject): String = canonical(value.copy().also { item ->
        for (key in listOf("savedAt", "savedSHA256", "savedBytes", "savedProofID")) item.remove(key)
    })
    private fun record(id: String): JSONObject {
        uuid(id); val file = checked(operationDirectory(id), "operation.json", true)
        val value = JSONObject(PublishedUtf8.decode(JsonFiles.read(file, META_LIMIT)))
        require(value.getString("contract") == CONTRACT && value.getString("operationID") == id)
        uuid(value.getString("jobID")); uuid(value.getString("documentID"))
        require(value.getString("preparation") in setOf("preparing", "interrupted", "ready", "unavailable", "cancelled"))
        require(value.getString("delivery") in setOf("none", "choosing", "cancelled", "writing", "written-unverified", "failed", "verified"))
        value.nullableString("attemptID")?.let(::uuid); return value
    }
    private fun attempt(id: String, attempt: String): JSONObject {
        uuid(attempt); return record(id).also { require(it.nullableString("attemptID") == attempt) { "系统保存回调属于先前的文件操作，未改写当前结果" } }
    }
    private fun write(value: JSONObject) {
        value.put("updatedAt", time()); val file = checked(operationDirectory(value.getString("operationID")), "operation.json", true)
        writeAttempt(value)
        val raw = value.toString().toByteArray(Charsets.UTF_8)
        require(raw.size <= META_LIMIT)
        JsonFiles.write(file, raw); require(JsonFiles.read(file, META_LIMIT).contentEquals(raw))
    }
    /** Immutable completed attempt facts survive a later retry; no URI/permission is stored here. */
    private fun writeAttempt(value: JSONObject) {
        val id = value.nullableString("attemptID") ?: return; uuid(id)
        val file = checked(operationDirectory(value.getString("operationID")), "attempt-$id.json", true)
        val old = if (file.exists()) JSONObject(PublishedUtf8.decode(JsonFiles.read(file, META_LIMIT))) else null
        if (old != null) {
            require(old.getString("operationID") == value.getString("operationID") && old.getString("documentID") == value.getString("documentID") && old.getString("attemptID") == id)
            if (old.getString("delivery") == "verified") { require(value.getString("delivery") == "verified"); return }
        }
        val attempt = JSONObject().put("contract", "paperdigest-export-delivery-v1").put("operationID", value.getString("operationID"))
            .put("documentID", value.getString("documentID")).put("attemptID", id).put("createdAt", old?.getString("createdAt") ?: time())
            .put("updatedAt", time()).put("delivery", value.getString("delivery")).put("manifestSHA256", value.getString("manifestSHA256"))
        if (value.getString("delivery") == "verified") attempt.put("verifiedAt", value.getString("verifiedAt"))
        JsonFiles.write(file, attempt)
    }
    @Synchronized fun deliveryHistory(operationID: String): List<JSONObject> {
        record(operationID)
        return children(operationDirectory(operationID)).filter { it.name.matches(Regex("attempt-[a-f0-9-]{36}\\.json")) }.sortedBy { it.name }.map { file ->
            checked(file.parentFile, file.name, true)
            JSONObject(PublishedUtf8.decode(JsonFiles.read(file, META_LIMIT))).also { item ->
                require(item.getString("contract") == "paperdigest-export-delivery-v1" && item.getString("operationID") == operationID)
                uuid(item.getString("attemptID")); require(file.name == "attempt-${item.getString("attemptID")}.json")
            }
        }
    }
    private fun view(value: JSONObject, artifact: Artifact?) = PendingExport(value.getString("operationID"), value.getString("jobID"), value.getString("documentID"),
        value.getString("preparation"), value.getString("phase"), value.getString("delivery"), value.nullableString("attemptID"), value.getJSONObject("sourceIdentity").copy(),
        value.getString("createdAt"), value.getString("updatedAt"), value.nullableString("message"), artifact)
    private fun operationDirectory(id: String, create: Boolean = false): File {
        uuid(id); requireControlDirectory(); val file = checked(controls, id, false)
        if (create) require(file.mkdir()) { "准备操作目录已存在，不覆盖" }
        require(file.isDirectory && !Files.isSymbolicLink(file.toPath()))
        BackupCodec.privateDirectory(file); return file
    }
    private fun requireControlDirectory() {
        require(directoryIdentity(controls) == controlIdentity) { "导出续接目录已变化或不可读，未将原记录隐藏成空列表。" }
    }
    private fun operationRevision(operationID: String): String = BackupCodec.hash(JsonFiles.read(
        checked(operationDirectory(operationID), "operation.json", true), META_LIMIT))
    private fun time() = timestamp().also { require(com.nanless.paperdigest.cloud.RequestContinuity.validTime(it)) }
    companion object {
        private const val CONTRACT = "paperdigest-pending-export-v1"
        private const val META_LIMIT = 1024 * 1024L
        private val UUID_PATTERN = Regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")
        private fun uuid(id: String) { require(UUID_PATTERN.matches(id) && UUID.fromString(id).toString() == id) { "导出操作身份无效" } }
        private fun directoryIdentity(file: File): Any {
            var cursor: File? = file
            while (cursor != null) { require(!Files.isSymbolicLink(cursor.toPath())); cursor = cursor.parentFile }
            val attributes = Files.readAttributes(file.toPath(), java.nio.file.attribute.BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
            require(attributes.isDirectory && !attributes.isSymbolicLink) { "导出续接目录不可用，未返回空记录。" }
            return attributes.fileKey() ?: throw AppFailure("storage", "无法确认导出续接目录身份，原记录未改写。")
        }
        private fun children(directory: File): Array<File> {
            directoryIdentity(directory)
            return directory.listFiles() ?: throw AppFailure("storage", "无法列出原导出记录，未将读取失败视为空列表。")
        }
        private fun root(file: File): File {
            val path = file.absoluteFile.toPath().normalize(); var cursor: java.nio.file.Path? = path
            while (cursor != null) { require(!Files.isSymbolicLink(cursor)); cursor = cursor.parent }
            if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) Files.createDirectories(path)
            require(Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)); return path.toRealPath().toFile().also(BackupCodec::privateDirectory)
        }
        private fun checked(parent: File, name: String, regularIfPresent: Boolean): File {
            require(name.isNotEmpty() && '/' !in name && '\\' !in name && name != "." && name != "..")
            var cursor: File? = parent
            while (cursor != null) { require(!Files.isSymbolicLink(cursor.toPath())); cursor = cursor.parentFile }
            val target = File(parent, name)
            require(!Files.isSymbolicLink(target.toPath())) { "导出控制或原件不能经过链接" }
            if (regularIfPresent && Files.exists(target.toPath(), LinkOption.NOFOLLOW_LINKS)) require(Files.isRegularFile(target.toPath(), LinkOption.NOFOLLOW_LINKS))
            return target
        }
        private fun createOnly(file: File, bytes: ByteArray) {
            val temporary = Files.createTempFile(file.parentFile.toPath(), ".pending-manifest-", ".tmp").toFile()
            try {
                FileChannel.open(temporary.toPath(), StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS).use { channel ->
                    BackupCodec.privateFile(temporary); val buffer = java.nio.ByteBuffer.wrap(bytes)
                    while (buffer.hasRemaining()) channel.write(buffer); channel.force(true)
                }
                require(!Files.exists(file.toPath(), LinkOption.NOFOLLOW_LINKS)) { "原清单已存在，不覆盖" }
                Files.move(temporary.toPath(), file.toPath(), java.nio.file.StandardCopyOption.ATOMIC_MOVE)
            } finally { temporary.delete() }
        }
        private fun hash(file: File, check: () -> Unit): String {
            val digest = MessageDigest.getInstance("SHA-256"); val bytes = ByteArray(64 * 1024)
            FileChannel.open(file.toPath(), StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS).use { channel ->
                while (true) { check(); val buffer = java.nio.ByteBuffer.wrap(bytes); val count = channel.read(buffer); if (count < 0) break; digest.update(bytes, 0, count) }
            }
            return digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
        }
    }
}
