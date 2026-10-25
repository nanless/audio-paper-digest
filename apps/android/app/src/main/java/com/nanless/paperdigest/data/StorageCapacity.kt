package com.nanless.paperdigest.data

import com.nanless.paperdigest.cloud.BackupCodec
import com.nanless.paperdigest.cloud.RequestContinuity
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.nio.file.Files
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Return only after the selected content URI has been streamed in full and its actual bytes match. */
typealias ExportDestinationVerifier = suspend (uri: String, expectedSHA256: String, expectedBytes: Long) -> Unit

/** Root holds its shared maintenance lock while marking saves or preparing/committing cleanup. */
class StorageCapacity(researchRoot: File, exportsRoot: File, cloudControlRoot: File, deviceControlRoot: File,
    private val now: () -> String = { com.nanless.paperdigest.data.now() },
    private val available: (File) -> Long = { it.usableSpace },
    private val removeFile: (File) -> Boolean = { it.delete() }) {
    private val research = checkedRoot(researchRoot)
    private val exports = checkedRoot(exportsRoot)
    private val pendingExports = checkedRoot(File(requireNotNull(exports.parentFile) { "导出目录缺少受控父目录" }, "PendingExports"))
    private val cloud = checkedRoot(cloudControlRoot)
    private val device = checkedRoot(deviceControlRoot)
    private val mutex = Mutex()
    private val plans = LinkedHashMap<String, Plan>()
    @Volatile private var lastCleanup: JSONObject? = null
    init {
        val roots = listOf(research, exports, pendingExports, cloud, device)
        require(roots.indices.all { a -> roots.indices.all { b -> a == b || !overlaps(roots[a], roots[b]) } }) { "容量目录必须彼此独立，设备证明不得进入研究备份" }
    }
    private data class Count(val files: Long = 0, val bytes: Long = 0) { fun json() = JSONObject().put("fileCount", files).put("bytes", bytes) }
    private data class Document(val id: String, val manifest: File, val raw: ByteArray, val meta: JSONObject, val bin: File, val bytes: Long, val sha256: String)
    private data class Candidate(val document: Document, val proof: File, val proofSHA: String, val history: File, val historySHA: String, val uri: String)
    private data class Plan(val id: String, val expiresAt: Long, val candidates: List<Candidate>)

    fun summary(): JSONObject {
        val rows = listOf(Triple("research", "研究资料", research), Triple("exports", "导出临时副本", exports), Triple("pendingExports", "待保存准备材料", pendingExports), Triple("cloudTransfers", "云端传输材料", cloud), Triple("deviceControl", "本机派发与导出证明", device)).map { (id, label, root) -> count(root).json().put("id", id).put("label", label).put("exists", root.exists()) }
        var retained = Count()
        if (cloud.exists()) children(cloud).filter { it.name.matches(Regex("archived-[a-fA-F0-9-]{36}")) }.forEach { folder ->
            val value = count(folder); retained = Count(Math.addExact(retained.files, value.files), Math.addExact(retained.bytes, value.bytes))
        }
        val free = try { available(research) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { throw AppFailure("storage", "无法确认当前可用空间，请检查本机存储状态。") }
        require(free > 0) { "无法确认当前可用空间或空间已用尽" }
        return JSONObject().put("scope", "research-and-transfer-materials").put("measuredAt", timestamp()).put("rows", JSONArray(rows)).put("availableBytes", free)
            .put("retainedCloud", retained.json().put("subsetOf", "cloudTransfers")).put("lastCleanup", lastCleanup?.copy() ?: JSONObject.NULL)
    }

    suspend fun markExportSaved(documentID: String, uri: String, verifier: ExportDestinationVerifier): JSONObject = operation {
        contentURI(uri)
        val original = document(documentID)
        verifyDestination(uri, original.sha256, original.bytes, verifier)
        sameDocument(original)
        val time = timestamp(); val proofID = UUID.randomUUID().toString()
        val next = original.meta.copy().put("savedAt", time).put("savedSHA256", original.sha256).put("savedBytes", original.bytes).put("savedProofID", proofID)
        val nextBytes = canonical(next).toByteArray(Charsets.UTF_8)
        val history = JSONObject().put("contract", "paperdigest-export-history-v1").put("proofID", proofID).put("documentID", documentID)
            .put("savedAt", time).put("sha256", original.sha256).put("bytes", original.bytes).put("mime", next.getString("mime")).put("suggestedName", next.getString("suggestedName"))
        val historyBytes = canonical(history).toByteArray(Charsets.UTF_8)
        val proof = JSONObject().put("contract", "paperdigest-native-export-save-v1").put("proofID", proofID).put("documentID", documentID).put("uri", uri)
            .put("savedAt", time).put("sha256", original.sha256).put("bytes", original.bytes).put("manifestSHA256", sha256(nextBytes)).put("historySHA256", sha256(historyBytes))
        proof.put("hmacSHA256", authenticate(proof, create = true))
        val historyFile = historyFile(proofID); val proofFile = proofFile(proofID)
        writeNew(historyFile, historyBytes); writeNew(proofFile, canonical(proof).toByteArray(Charsets.UTF_8))
        sameDocument(original)
        JsonFiles.write(original.manifest, nextBytes)
        val verified = candidate(documentID)
        require(verified.proofSHA == sha256(JsonFiles.read(proofFile, PROOF_LIMIT)) && verified.historySHA == sha256(historyBytes)) { "导出回执回读失败，临时副本保留" }
        plans.clear()
        JSONObject().put("documentID", documentID).put("proofID", proofID).put("savedAt", time).put("sha256", original.sha256).put("bytes", original.bytes).put("verified", true)
    }

    suspend fun cleanupPrepare(verifier: ExportDestinationVerifier): JSONObject = operation {
        val epoch = instant(); plans.entries.removeAll { it.value.expiresAt < epoch }
        val candidates = ArrayList<Candidate>(); var retained = 0; var unknown = 0; var deferred = 0
        if (exports.exists()) {
            val top = children(exports).sortedBy { it.name }
            val pairedBins = top.mapNotNull { Regex("([a-f0-9-]{36})\\.json").matchEntire(it.name)?.groupValues?.get(1)?.plus(".bin") }.toSet()
            for (file in top) {
                currentCoroutineContext().ensureActive()
                val match = Regex("([a-f0-9-]{36})\\.json").matchEntire(file.name)
                if (match == null) { if (file.name !in pairedBins) unknown++; continue }
                if (candidates.size >= MAX_PLAN_DOCUMENTS) { deferred++; continue }
                try {
                    val value = candidate(match.groupValues[1])
                    verifyDestination(value.uri, value.document.sha256, value.document.bytes, verifier)
                    sameCandidate(value)
                    candidates += value
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { currentCoroutineContext().ensureActive(); retained++ }
            }
        }
        val id = UUID.randomUUID().toString(); val expires = Math.addExact(epoch, 10 * 60 * 1000L)
        if (plans.size >= 4) plans.remove(plans.keys.first())
        plans[id] = Plan(id, expires, candidates)
        JSONObject().put("planID", id).put("expiresAt", Instant.ofEpochMilli(expires).toString()).put("documents", candidates.size).put("files", candidates.size * 2)
            .put("bytes", candidates.sumOf { it.document.bytes + it.document.raw.size }).put("retainedDocuments", retained).put("unknownEntries", unknown).put("deferredDocuments", deferred)
            .put("items", JSONArray(candidates.map { c -> JSONObject().put("documentID", c.document.id).put("name", c.document.meta.getString("suggestedName")).put("bytes", c.document.bytes) }))
    }

    suspend fun cleanupCommit(planID: String, verifier: ExportDestinationVerifier): JSONObject = operation {
        val plan = plans.remove(planID) ?: throw AppFailure("storage", "清理确认已失效，请重新核对临时副本")
        require(instant() <= plan.expiresAt) { "清理计划已过期，请重新核对" }
        for (value in plan.candidates) {
            sameCandidate(value)
            verifyDestination(value.uri, value.document.sha256, value.document.bytes, verifier)
        }
        // A later verifier must not be able to change an earlier candidate.
        for (value in plan.candidates) sameCandidate(value)
        currentCoroutineContext().ensureActive()
        if (plan.candidates.isEmpty()) return@operation JSONObject().put("status", "completed").put("removedFiles", 0).put("removedBytes", 0).put("byteMeasure", "logical-file-length").put("retainedFiles", 0)
        val stage = File(exports, ".cleanup-${plan.id}"); require(!stage.exists() && stage.mkdir()); BackupCodec.privateDirectory(stage)
        val moved = ArrayList<Pair<File, File>>()
        try {
            for (value in plan.candidates) {
                currentCoroutineContext().ensureActive()
                for (original in listOf(value.document.bin, value.document.manifest)) {
                    val target = File(stage, original.name)
                    Files.move(original.toPath(), target.toPath(), ATOMIC_MOVE); moved += original to target
                }
            }
            for (value in plan.candidates) {
                require(fileSHA(File(stage, value.document.bin.name), value.document.bytes) == value.document.sha256 && fileSHA(File(stage, value.document.manifest.name), MANIFEST_LIMIT.toLong()) == sha256(value.document.raw)) { "清理暂存字节变化" }
            }
            currentCoroutineContext().ensureActive()
        } catch (error: Exception) {
            restoreMoved(moved)
            if (stage.listFiles()?.isEmpty() == true) stage.delete()
            throw error
        }
        // All original/destination proofs passed before the first unlink. File
        // system failures after this point are reported with actual partial counts.
        var removed = 0; var freed = 0L; var failures = 0
        for (value in plan.candidates) {
            val bin = File(stage, value.document.bin.name); val manifest = File(stage, value.document.manifest.name)
            runCatching { removeFile(bin) }
            if (!Files.exists(bin.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
                removed++; freed = Math.addExact(freed, value.document.bytes)
                runCatching { removeFile(manifest) }
                if (!Files.exists(manifest.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS)) { removed++; freed = Math.addExact(freed, value.document.raw.size.toLong()) } else failures++
            } else failures++
        }
        restoreMoved(moved.filter { Files.exists(it.second.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS) })
        val stagedLeft = if (stage.exists()) runCatching { count(stage).files }.getOrNull() else 0L
        if (stagedLeft == 0L) stage.delete()
        val result = JSONObject().put("status", if (failures == 0 && stagedLeft == 0L) "completed" else "partial").put("removedFiles", removed).put("removedBytes", freed).put("byteMeasure", "logical-file-length")
            .put("retainedFiles", plan.candidates.size * 2 - removed).put("retainedStagingFiles", stagedLeft ?: JSONObject.NULL)
            .put("message", if (failures == 0 && stagedLeft == 0L) "已清理经目的文件整件回读核验的导出临时副本" else "临时副本清理部分完成，剩余材料已保留；请重新统计容量")
        lastCleanup = result.copy()
        result
    }

    private suspend fun <T> operation(block: suspend () -> T): T = withContext(Dispatchers.IO) { mutex.withLock { currentCoroutineContext().ensureActive(); block() } }
    private suspend fun verifyDestination(uri: String, sha: String, bytes: Long, verifier: ExportDestinationVerifier) {
        contentURI(uri); currentCoroutineContext().ensureActive()
        try { verifier(uri, sha, bytes) } catch (c: CancellationException) { throw c } catch (_: Exception) { currentCoroutineContext().ensureActive(); throw AppFailure("storage", "目的文件无法完成整件回读核验，原导出临时副本保留") }
        currentCoroutineContext().ensureActive()
    }
    private suspend fun document(id: String, verifyBin: Boolean = true): Document {
        uuid(id); val manifest = checkedFile(exports, "$id.json"); val raw = JsonFiles.read(manifest, MANIFEST_LIMIT)
        val meta = JSONObject(raw.toString(Charsets.UTF_8)); require(meta.keys().asSequence().toSet().all { it in MANIFEST_KEYS } && meta.getString("documentID") == id)
        require(meta.getString("mime").length in 1..200 && meta.getString("suggestedName").length in 1..2000)
        val bytes = integer(meta, "bytes"); val sha = meta.getString("sha256"); require(bytes in 0..BackupCodec.MAX_ENCODED && BackupCodec.validSHA(sha))
        val bin = checkedFile(exports, "$id.bin"); require(bin.length() == bytes && (!verifyBin || fileSHA(bin, bytes) == sha)) { "导出临时原件已变化" }
        return Document(id, manifest, raw, meta, bin, bytes, sha)
    }
    private suspend fun sameDocument(expected: Document) {
        val actual = document(expected.id)
        require(actual.raw.contentEquals(expected.raw) && actual.bytes == expected.bytes && actual.sha256 == expected.sha256) { "导出材料已变化，未授予清理资格" }
    }
    private suspend fun candidate(id: String): Candidate {
        // Unmarked exports are protected, so do not hash potentially huge bins
        // merely to discover that no native saved proof exists.
        val d = document(id, verifyBin = false); val proofID = d.meta.getString("savedProofID"); uuid(proofID)
        val proofFile = proofFile(proofID); val proofRaw = JsonFiles.read(proofFile, PROOF_LIMIT); val proof = JSONObject(proofRaw.toString(Charsets.UTF_8))
        require(proof.keys().asSequence().toSet() == PROOF_KEYS && proof.getString("contract") == "paperdigest-native-export-save-v1" && proof.getString("documentID") == id && proof.getString("proofID") == proofID)
        val signature = proof.getString("hmacSHA256"); require(BackupCodec.validSHA(signature)); val unsigned = proof.copy().also { it.remove("hmacSHA256") }
        require(MessageDigest.isEqual(signature.toByteArray(), authenticate(unsigned, create = false).toByteArray())) { "本机原生导出证明不符" }
        require(proof.getString("manifestSHA256") == sha256(d.raw) && proof.getString("sha256") == d.sha256 && integer(proof, "bytes") == d.bytes)
        require(d.meta.getString("savedSHA256") == d.sha256 && integer(d.meta, "savedBytes") == d.bytes && d.meta.getString("savedAt") == proof.getString("savedAt") && RequestContinuity.validTime(proof.getString("savedAt")))
        val historyFile = historyFile(proofID); val historyRaw = JsonFiles.read(historyFile, PROOF_LIMIT); val history = JSONObject(historyRaw.toString(Charsets.UTF_8))
        require(sha256(historyRaw) == proof.getString("historySHA256") && history.keys().asSequence().toSet() == HISTORY_KEYS && history.getString("contract") == "paperdigest-export-history-v1" && history.getString("proofID") == proofID && history.getString("documentID") == id)
        require(history.getString("sha256") == d.sha256 && integer(history, "bytes") == d.bytes && history.getString("savedAt") == proof.getString("savedAt") && history.getString("mime") == d.meta.getString("mime") && history.getString("suggestedName") == d.meta.getString("suggestedName"))
        val uri = proof.getString("uri"); contentURI(uri)
        require(fileSHA(d.bin, d.bytes) == d.sha256) { "导出临时原件与原保存证明不符" }
        return Candidate(d, proofFile, sha256(proofRaw), historyFile, sha256(historyRaw), uri)
    }
    private suspend fun sameCandidate(expected: Candidate) {
        val actual = candidate(expected.document.id)
        require(actual.document.raw.contentEquals(expected.document.raw) && actual.document.sha256 == expected.document.sha256 && actual.proofSHA == expected.proofSHA && actual.historySHA == expected.historySHA && actual.uri == expected.uri) { "清理确认后材料或证明已变化" }
    }
    private fun authenticate(value: JSONObject, create: Boolean): String {
        val keyFile = File(device, "export-save-integrity.key")
        require(!Files.isSymbolicLink(keyFile.toPath())) { "本机原生导出证明不能是链接" }
        val key = if (keyFile.exists()) JsonFiles.read(checkedFile(device, keyFile.name), 32) else {
            require(!Files.isSymbolicLink(keyFile.toPath()) && create) { "缺少本机原生导出证明材料" }
            ByteArray(32).also { SecureRandom().nextBytes(it); JsonFiles.write(keyFile, it) }
        }
        require(key.size == 32)
        return try { Mac.getInstance("HmacSHA256").run { init(SecretKeySpec(key, "HmacSHA256")); doFinal(canonical(value).toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 255) } } } finally { key.fill(0) }
    }
    private fun proofFile(id: String): File { uuid(id); return File(checkedRoot(File(device, "ExportSaveProofs")), "$id.json") }
    private fun historyFile(id: String): File { uuid(id); return File(checkedRoot(File(research, "ExportHistory")), "$id.json") }
    private fun writeNew(file: File, bytes: ByteArray) {
        require(!Files.isSymbolicLink(file.toPath()) && !file.exists()) { "导出历史或本机回执已存在，未覆盖" }
        JsonFiles.write(file, bytes)
        require(JsonFiles.read(file, PROOF_LIMIT).contentEquals(bytes)) { "导出回执保存失败" }
    }
    private suspend fun fileSHA(file: File, limit: Long): String {
        checkedFile(file.parentFile!!, file.name); require(file.length() <= limit)
        val hash = MessageDigest.getInstance("SHA-256"); var total = 0L
        file.inputStream().use { stream -> val buffer = ByteArray(64 * 1024); while (true) { currentCoroutineContext().ensureActive(); val count = stream.read(buffer); if (count < 0) break; total += count; require(total <= limit); hash.update(buffer, 0, count) } }
        require(!Files.isSymbolicLink(file.toPath()) && file.length() == total)
        return hash.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
    }
    private fun restoreMoved(moved: List<Pair<File, File>>) {
        for ((original, staged) in moved.asReversed()) if (staged.exists() && !original.exists() && !Files.isSymbolicLink(original.toPath())) runCatching { Files.move(staged.toPath(), original.toPath(), ATOMIC_MOVE) }
    }
    private fun count(root: File): Count {
        checkedRoot(root); if (!root.exists()) return Count()
        require(root.isDirectory)
        var files = 0L; var bytes = 0L; var entries = 0L
        Files.walk(root.toPath()).use { stream -> stream.forEach { path ->
            require(!Files.isSymbolicLink(path)) { "容量统计遇到链接，未跟随" }
            entries++; require(entries <= 1_000_000) { "容量条目超过可核对范围" }
            if (Files.isRegularFile(path)) { files++; bytes = Math.addExact(bytes, Files.size(path)) } else require(Files.isDirectory(path)) { "容量统计遇到非普通文件" }
        } }
        return Count(files, bytes)
    }
    private fun children(root: File): List<File> { checkedRoot(root); return Files.newDirectoryStream(root.toPath()).use { stream -> stream.map { it.toFile() } } }
    private fun timestamp(): String = now().also { require(RequestContinuity.validTime(it)) }
    private fun instant() = Instant.parse(timestamp()).toEpochMilli()
    companion object {
        private const val MANIFEST_LIMIT = 64L * 1024
        private const val PROOF_LIMIT = 64L * 1024
        private const val MAX_PLAN_DOCUMENTS = 20
        private val MANIFEST_KEYS = setOf("documentID", "mime", "suggestedName", "bytes", "sha256", "savedAt", "savedSHA256", "savedBytes", "savedProofID")
        private val PROOF_KEYS = setOf("contract", "proofID", "documentID", "uri", "savedAt", "sha256", "bytes", "manifestSHA256", "historySHA256", "hmacSHA256")
        private val HISTORY_KEYS = setOf("contract", "proofID", "documentID", "savedAt", "sha256", "bytes", "mime", "suggestedName")
        private fun integer(o: JSONObject, key: String): Long { val n = o.get(key); require(n is Number && n.toDouble().isFinite() && n.toDouble() == n.toLong().toDouble()); return n.toLong() }
        private fun uuid(id: String) { require(UUID.fromString(id).toString() == id) { "导出记录身份无效" } }
        private fun contentURI(raw: String) { val uri = URI(raw); require(raw.length <= 8192 && uri.scheme == "content" && !uri.authority.isNullOrBlank() && uri.userInfo == null && uri.fragment == null) { "导出目的地须来自系统文件选择器" } }
        private fun overlaps(a: File, b: File) = a == b || a.path.startsWith(b.path + File.separator) || b.path.startsWith(a.path + File.separator)
        private fun checkedRoot(root: File): File { BackupCodec.checkedRoot(root.absolutePath); var parent: File? = root.absoluteFile; while (parent != null) { require(!Files.isSymbolicLink(parent.toPath())) { "资料目录不能经过链接" }; parent = parent.parentFile }; require(!root.exists() || root.isDirectory); return root.absoluteFile }
        private fun checkedFile(root: File, name: String): File { checkedRoot(root); require(!name.contains('/') && !name.contains('\\')); val file = File(root, name); require(!Files.isSymbolicLink(file.toPath()) && Files.isRegularFile(file.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS)) { "原始文件缺失或不是普通文件" }; return file }
    }
}
