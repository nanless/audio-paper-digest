package com.nanless.paperdigest.data

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** Mac schema 1 stays lossless: modifications replace only the requested field. */
class PersonalStore(val directory: File) {
    private val file = File(directory, "personal.json")
    private var value: JSONObject
    @Volatile var startupPersistenceWarning: String? = null
        private set
    init {
        directory.mkdirs()
        val hadFile = file.exists()
        value = if (hadFile) readSaved() else initial()
        var interruptionChanged = false
        // An issued model request may already have been billed; process recreation never reissues it.
        value.getJSONArray("jobs").objects().forEach {
            if (it.optString("status") in listOf("running", "queued")) {
                interruptionChanged = true
                it.put("status", "interrupted").put("message", "上次运行中断；请核对保存结果。付费分析不会自动重发。")
            }
        }
        value.getJSONArray("sessions").objects().forEach {
            if (it.optString("status") == "pending") {
                interruptionChanged = true
                it.put("status", "interrupted").put("charge", "unknown").put("error", "请求可能已经产生费用，不会自动重发")
            }
        }
        val startupBytes = if (hadFile && !interruptionChanged) null else try { encodedForWrite(value) } catch (error: AppFailure) {
            if (error.category != "capacity") throw error
            // A valid imported/older file may have no room for interruption
            // labels. Keep all original disk bytes and expose a conservative
            // interrupted in-memory view; never block reading the originals.
            startupPersistenceWarning = "个人记录接近 32 MiB 上限；已在当前视图标记中断，但未改写原文件。请先导出完整备份并整理记录，恢复可保存空间。"
            null
        }
        if (startupBytes != null) JsonFiles.write(file, startupBytes)
    }

    @Synchronized fun snapshot(): JSONObject = value.copy()
    @Synchronized fun settings(): JSONObject = value.getJSONObject("settings").copy()
    @Synchronized fun reload() { value = readSaved() }
    @Synchronized fun retireRestoredDispatch() = mutate { o ->
        o.getJSONArray("jobs").objects().forEach { if (it.optString("status") in listOf("queued", "running")) it.put("status", "interrupted").put("message", "这是恢复的历史任务，未授予本机自动派发权限") }
        o.getJSONArray("sessions").objects().forEach { s ->
            if (s.optString("status") in listOf("prepared", "pending")) s.put("status", "interrupted").put("charge", if (s.optBoolean("requestIssued")) "unknown" else "not-issued").put("error", "恢复的原始记录已保留，不会自动重新发出请求")
        }
    }
    @Synchronized fun replaceValidated(replacement: JSONObject) {
        // Own every mutable container before serialization. Immutable strings
        // need not be duplicated merely to commit the same bounded JSON.
        val committed = replacement.copy().also(::validate)
        val encoded = encodedForWrite(committed)
        JsonFiles.write(file, encoded); value = committed; startupPersistenceWarning = null
    }
    @Synchronized private fun mutate(block: (JSONObject) -> Unit) {
        val replacement = value.copy()
        block(replacement); validate(replacement)
        JsonFiles.write(file, encodedForWrite(replacement)); value = replacement; startupPersistenceWarning = null
    }
    private fun readSaved(): JSONObject {
        if (file.isFile && file.length() > MAX_BYTES) throw AppFailure("capacity", "个人记录超过本版 32 MiB 读取上限；原文件已保留，请先保全研究目录后迁移。")
        return JSONObject(JsonFiles.read(file, MAX_BYTES).toString(Charsets.UTF_8)).also(::validate)
    }
    private fun encodedForWrite(replacement: JSONObject): ByteArray {
        val bytes = replacement.toString().toByteArray(Charsets.UTF_8)
        if (bytes.size.toLong() > MAX_BYTES || bytes.size.toLong() + startupDelta(replacement) > MAX_BYTES) throw capacityError()
        return bytes
    }
    /** Count only changed field bytes, never stringify a second full answer/library tree. */
    private fun startupDelta(replacement: JSONObject): Long {
        fun delta(record: JSONObject, key: String, text: String): Long {
            fun fieldBytes(value: Any): Long = JSONObject().put(key, value).toString().toByteArray(Charsets.UTF_8).size.toLong() - 2
            val next = fieldBytes(text)
            return if (record.has(key)) next - fieldBytes(record.get(key)) else next + if (record.length() > 0) 1L else 0L
        }
        var total = 0L
        replacement.getJSONArray("jobs").objects().forEach { record ->
            if (record.optString("status") in listOf("running", "queued")) {
                total += delta(record, "status", "interrupted")
                total += delta(record, "message", "上次运行中断；请核对保存结果。付费分析不会自动重发。")
            }
        }
        replacement.getJSONArray("sessions").objects().forEach { record ->
            if (record.optString("status") == "pending") {
                total += delta(record, "status", "interrupted")
                total += delta(record, "charge", "unknown")
                total += delta(record, "error", "请求可能已经产生费用，不会自动重发")
            }
        }
        return total
    }
    private fun capacityError() = AppFailure("capacity", "个人记录超过 32 MiB 保存上限；此次更改未保存，原资料仍保留。请先导出完整备份，再整理记录。")
    @Synchronized fun updateSettings(changes: JSONObject) = mutate { replacement ->
        val allowed = setOf("appearance", "font", "reduceMotion", "syncHours", "httpProxy", "endpoint", "model", "protocol", "responsesStream", "reasoningEffort", "maxTokens", "timeoutMs", "dailyRequests", "lastSettingPane", "offlineMode")
        changes.keys().forEach { key -> if (key in allowed) replacement.getJSONObject("settings").put(key, changes.get(key)) }
    }
    @Synchronized fun note(id: String): JSONObject = value.getJSONObject("notes").optJSONObject(id)?.copy() ?: JSONObject().put("text", "").put("revision", 0)
    @Synchronized fun saveNote(id: String, text: String, baseRevision: Int): JSONObject {
        require(id.isNotEmpty() && text.toByteArray().size <= 2 * 1024 * 1024) { "笔记身份缺失或内容过长" }
        val previous = note(id)
        if (previous.getInt("revision") != baseRevision) throw AppFailure("conflict", "笔记已在其他视图修改，保留当前草稿；请先读取新版本。")
        val note = JSONObject().put("text", text).put("revision", baseRevision + 1).put("updatedAt", now())
        mutate { it.getJSONObject("notes").put(id, note) }
        return note.copy()
    }
    @Synchronized fun list(key: String): List<String> { require(key in listOf("favorites", "reading")); return value.getJSONArray(key).strings() }
    @Synchronized fun setList(key: String, ids: List<String>) {
        require(key in listOf("favorites", "reading") && ids.size <= 100000)
        mutate { it.put(key, JSONArray(ids.distinct().sorted())) }
    }
    @Synchronized fun toggleList(key: String, id: String) { val old = list(key); setList(key, if (id in old) old - id else old + id) }
    @Synchronized fun saveReading(id: String, reading: JSONObject) = mutate { it.getJSONObject("readingState").put(id, reading.copy().put("updatedAt", now())) }
    @Synchronized fun annotations(id: String): List<JSONObject> = value.getJSONObject("annotations").optJSONArray(id)?.objects()?.map { it.copy() } ?: emptyList()
    @Synchronized fun saveAnnotation(id: String, annotation: JSONObject, remove: Boolean = false): List<JSONObject> {
        val key = annotation.optString("id").ifEmpty { UUID.randomUUID().toString() }
        val entries = annotations(id).filter { it.optString("id") != key }.toMutableList()
        if (!remove) entries += annotation.copy().put("id", key).also { if (!it.has("createdAt")) it.put("createdAt", now()) }
        require(entries.size <= 100000)
        mutate { it.getJSONObject("annotations").put(id, JSONArray(entries)) }
        return entries
    }
    @Synchronized fun replaceAnnotations(id: String, entries: List<JSONObject>) {
        require(id.isNotEmpty() && entries.size <= 100000 && entries.map { it.getString("id") }.toSet().size == entries.size) { "标注集合缺少身份、重复或超限" }
        mutate { it.getJSONObject("annotations").put(id, JSONArray(entries.map { entry -> entry.copy() })) }
    }
    @Synchronized fun rememberPaper(paper: Paper) = mutate { o ->
        val papers = o.optJSONObject("personalPapers") ?: JSONObject().also { o.put("personalPapers", it) }
        papers.put(paper.id, paper.json())
    }
    @Synchronized fun personalPapers(): List<Paper> = value.optJSONObject("personalPapers")?.let { o -> o.keys().asSequence().map { Paper.fromJson(o.getJSONObject(it)) }.toList() } ?: emptyList()
    @Synchronized fun upsertJob(job: JSONObject) = upsert("jobs", job)
    @Synchronized fun appendSession(session: JSONObject) = upsert("sessions", session)
    @Synchronized private fun upsert(field: String, item: JSONObject) = mutate { o ->
        require(item.optString("id").isNotEmpty())
        val all = o.getJSONArray(field).objects().toMutableList()
        val position = all.indexOfFirst { it.optString("id") == item.getString("id") }
        if (position < 0) all.add(0, item.copy()) else all[position] = item.copy()
        o.put(field, JSONArray(all))
    }
    @Synchronized fun session(id: String): JSONObject? = value.getJSONArray("sessions").objects().firstOrNull { it.optString("id") == id }?.copy()

    companion object {
        const val MAX_BYTES: Long = 32L * 1024 * 1024
        fun initial() = JSONObject().put("schema", 1).put("notes", JSONObject()).put("favorites", JSONArray()).put("reading", JSONArray())
            .put("readingState", JSONObject()).put("annotations", JSONObject()).put("sessions", JSONArray()).put("jobs", JSONArray())
            .put("settings", JSONObject().put("appearance", "system").put("font", 18).put("syncHours", 12).put("dailyRequests", 20).put("maxTokens", 8000).put("timeoutMs", 180000))
        fun validate(o: JSONObject) {
            require(o.get("schema") is Number && o.getInt("schema") == 1) { "个人资料版本尚不支持" }
            listOf("notes", "settings", "readingState", "annotations").forEach { o.getJSONObject(it) }
            listOf("favorites", "reading").forEach { require(o.getJSONArray(it).length() <= 100000); o.getJSONArray(it).strings() }
            listOf("sessions", "jobs").forEach { o.getJSONArray(it).objects() }
            o.getJSONObject("notes").let { notes -> notes.keys().forEach { id -> val n = notes.getJSONObject(id); n.getString("text"); require(n.get("revision") is Number && n.getInt("revision") >= 0) } }
            o.getJSONObject("readingState").let { states -> states.keys().forEach { states.getJSONObject(it) } }
            o.getJSONObject("annotations").let { all -> all.keys().forEach { all.getJSONArray(it).objects() } }
            o.optJSONObject("personalPapers")?.let { papers ->
                require(papers.length() <= 100000)
                papers.keys().forEach { id ->
                    val p = papers.getJSONObject(id)
                    require(p.getString("id") == id && id.isNotEmpty() && id.length <= 256 && p.getString("title").isNotEmpty() && p.getString("sourceKind").isNotEmpty())
                    if (p.getString("sourceKind") == "local") require(p.getString("localPDFPath").startsWith("/") && p.getString("pdfSHA").matches(Regex("[a-f0-9]{64}")) && id == "local:" + p.getString("pdfSHA"))
                }
            }
        }
    }
}
