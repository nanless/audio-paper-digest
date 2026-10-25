package com.nanless.paperdigest.cloud

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.time.Instant
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.time.format.ResolverStyle
import java.util.UUID

object RequestContinuity {
    const val FILE = "RequestBudgetContinuity.json"
    data class Issued(val id: String, val startedAt: String)
    fun union(vararg groups: List<Issued>): List<Issued> {
        val result = sortedMapOf<String, Issued>()
        groups.forEach { group -> group.forEach { item ->
            require(item.id.isNotEmpty() && item.id.toByteArray().size <= 256 && validTime(item.startedAt)) { "原请求身份或时间无效" }
            val old = result.putIfAbsent(item.id, item); require(old == null || old == item) { "同一原请求的派发时间冲突" }; require(result.size <= 100_000) { "请求连续性超限" }
        } }; return result.values.toList()
    }
    fun validTime(value: String): Boolean {
        if (!Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?Z").matches(value) || value.take(4) == "0000") return false
        return runCatching { LocalDateTime.parse(value.take(19), DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss").withResolverStyle(ResolverStyle.STRICT)); Instant.parse(value); true }.getOrDefault(false)
    }
    fun sessions(personal: JSONObject): List<Issued> {
        val a = personal.getJSONArray("sessions"); return (0 until a.length()).map { a.getJSONObject(it) }.filter { it.opt("requestIssued") == true }.map { Issued(it.getString("id"), it.getString("startedAt")) }
    }
    fun read(directory: File): List<Issued> {
        val file = File(directory, FILE); if (!file.exists()) { require(!Files.isSymbolicLink(file.toPath())); return emptyList() }
        BackupCodec.checkedFile(directory, FILE); require(file.length() <= 32L * 1024 * 1024)
        val obj = JSONObject(file.readText()); require(obj.getString("contract") == "paperdigest-request-continuity-v1")
        val a = obj.getJSONArray("requests"); require(a.length() <= 100_000)
        return union((0 until a.length()).map { val row = a.getJSONObject(it); Issued(row.getString("id"), row.getString("startedAt")) })
    }
    fun count(dayUTC: String, directory: File, personal: JSONObject): Int = union(read(directory), sessions(personal)).count { it.startedAt.startsWith(dayUTC + "T") }
    fun json(entries: List<Issued>) = JSONObject().put("contract", "paperdigest-request-continuity-v1").put("requests", JSONArray(entries.map { JSONObject().put("id", it.id).put("startedAt", it.startedAt) }))
}

/** Root holds its shared maintenance lock, flushes edits, and obtains consent first. */
object RestorePolicy {
    val CONNECTION_KEYS = setOf("endpoint", "model", "protocol", "httpProxy", "responsesStream", "reasoningEffort", "maxTokens", "timeoutMs", "dailyRequests")
    fun apply(stage: File, current: File) {
        val original = BackupCodec.checkedFile(stage, "personal.json").readBytes()
        val local = JSONObject(BackupCodec.checkedFile(current, "personal.json").readText()); val restored = JSONObject(original.toString(Charsets.UTF_8))
        BackupCodec.validatePersonal(local); BackupCodec.validatePersonal(restored)
        val old = local.getJSONObject("settings"); val settings = restored.getJSONObject("settings")
        CONNECTION_KEYS.forEach { key -> settings.remove(key); if (old.has(key)) settings.put(key, old.get(key)) }
        val all = RequestContinuity.union(RequestContinuity.read(current), RequestContinuity.read(stage), RequestContinuity.sessions(local), RequestContinuity.sessions(restored))
        val receipts = File(stage, "RestorationReceipts"); if (!receipts.exists()) require(receipts.mkdir()); BackupCodec.checkedDirectory(receipts); BackupCodec.privateDirectory(receipts)
        BackupCodec.atomicBytes(File(receipts, "${UUID.randomUUID()}-original-personal.json"), original)
        BackupCodec.atomicJSON(File(stage, RequestContinuity.FILE), RequestContinuity.json(all)); BackupCodec.atomicJSON(File(stage, "personal.json"), restored)
    }
    /** Returns the retained original workspace. A callback failure restores it. */
    fun install(staged: BackupCodec.Staged, current: File, initialize: () -> Unit): File {
        BackupCodec.checkedDirectory(current); BackupCodec.checkedDirectory(staged.directory)
        require(staged.directory.canonicalFile != current.canonicalFile && staged.directory.parentFile.canonicalFile == current.parentFile.canonicalFile) { "恢复暂存须位于同一本机文件系统" }
        staged.entries.filter { it.path != BackupCodec.ROOTS_FILE }.forEach { require(BackupCodec.hash(BackupCodec.checkedFile(staged.directory, it.path)) == it.sha256) { "确认前恢复材料已变化" } }
        apply(staged.directory, current)
        val before = File(current.parentFile, "${current.name}-BeforeRestore-${UUID.randomUUID()}")
        Files.move(current.toPath(), before.toPath(), ATOMIC_MOVE)
        try { Files.move(staged.directory.toPath(), current.toPath(), ATOMIC_MOVE) }
        catch (t: Throwable) { try { Files.move(before.toPath(), current.toPath(), ATOMIC_MOVE) } catch (_: Throwable) { throw IllegalStateException("恢复安装失败，原资料仍保留在恢复前副本，请手动核对") }; throw t }
        try { initialize() }
        catch (t: Throwable) {
            val failed = File(current.parentFile, "${current.name}-FailedRestore-${UUID.randomUUID()}")
            try { Files.move(current.toPath(), failed.toPath(), ATOMIC_MOVE); Files.move(before.toPath(), current.toPath(), ATOMIC_MOVE); initialize() }
            catch (_: Throwable) { throw IllegalStateException("恢复初始化失败，原资料与失败副本已保留，请手动核对") }
            throw t
        }
        return before
    }
}
