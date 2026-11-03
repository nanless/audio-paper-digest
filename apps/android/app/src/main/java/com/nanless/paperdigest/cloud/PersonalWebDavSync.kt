package com.nanless.paperdigest.cloud

import com.nanless.paperdigest.data.FavoriteCollections
import com.nanless.paperdigest.data.PersonalStore
import com.nanless.paperdigest.data.canonical
import com.nanless.paperdigest.data.copy
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

/** Each installation writes its own document. Observed revisions identify concurrent edits. */
internal object PersonalWebDavSync {
    const val LIMIT = 8 * 1024 * 1024
    const val DIRECTORY = "personal-sync-v1"
    const val REVISIONS_DIRECTORY = "personal-sync-revisions-v1"
    const val MAX_REVISION = 9_007_199_254_740_991L
    const val REVISIONS_PER_BUCKET = 256
    const val MAX_BUCKETS = 748
    const val LEGACY_DIGEST = "legacySHA256"
    private const val FORMAT = "paperdigest-personal-sync-v1"
    private const val BASELINE = "webDavSyncBaseline"
    private val fields = listOf("favorites", "reading", "notes", "annotations", "readingState")
    private val sets = fields.take(2)
    private val maps = fields.drop(2)

    data class Plan(val personal: JSONObject, val upload: ByteArray?, val conflicts: Int)

    fun validDevice(id: String) = runCatching { UUID.fromString(id).toString() == id }.getOrDefault(false)
    private fun validPaper(id: String) = id.isNotEmpty() && id.length <= 2048 && !id.startsWith("local:")
    private fun revision(value: Any): Long {
        val number = value as? Number ?: error("WebDAV 同步版本无效")
        val revision = number.toLong()
        require(revision in 1..MAX_REVISION && revision.toDouble() == number.toDouble()) { "WebDAV 同步版本无效" }
        return revision
    }

    fun documentRevision(bytes: ByteArray, owner: String): Long {
        require(validDevice(owner) && bytes.size in 1..LIMIT)
        val document = JSONObject(bytes.decodeToString(throwOnInvalidSequence = true))
        require(document.getString("format") == FORMAT && document.getString("device") == owner)
        return revision(document.get("revision"))
    }

    fun bucket(revision: Long): Long = (revision - 1) / REVISIONS_PER_BUCKET

    private fun project(personal: JSONObject): JSONObject = JSONObject().also { output ->
        for (field in fields) {
            val rows = JSONObject()
            if (field in sets) {
                val ids = personal.optJSONArray(field) ?: JSONArray()
                val items = if (field == "favorites") FavoriteCollections.editable(personal).getJSONObject("items") else null
                for (i in 0 until ids.length()) {
                    val id = ids.getString(i)
                    if (validPaper(id)) rows.put(id, if (field == "reading") true else
                        JSONObject().put("addedAt", items?.optJSONObject(id)?.opt("addedAt") ?: JSONObject.NULL))
                }
            } else {
                val source = personal.optJSONObject(field) ?: JSONObject()
                source.keys().forEach { if (validPaper(it)) rows.put(it, source.get(it)) }
            }
            output.put(field, rows)
        }
    }

    private fun hashes(projection: JSONObject): JSONObject = JSONObject().also { result ->
        for (field in fields) {
            val rows = projection.getJSONObject(field)
            result.put(field, JSONObject().also { out ->
                rows.keys().forEach { out.put(it, BackupCodec.hash(canonical(rows.get(it)).toByteArray())) }
            })
        }
    }

    private data class Edit(val device: String, val revision: Long, val seen: JSONObject, val value: Any)

    fun plan(local: JSONObject, device: String, remote: Map<String, ByteArray>): Plan {
        require(validDevice(device) && remote.size <= 24)
        val documents = remote.mapValues { (owner, bytes) ->
            require(validDevice(owner) && bytes.size in 1..LIMIT)
            val doc = JSONObject(bytes.decodeToString(throwOnInvalidSequence = true))
            require(doc.getString("format") == FORMAT && doc.getString("device") == owner)
            val version = revision(doc.get("revision"))
            val records = doc.getJSONObject("records")
            require(records.keys().asSequence().toSet() == fields.toSet())
            for (field in fields) {
                val rows = records.getJSONObject(field)
                require(rows.length() <= 100000)
                rows.keys().forEach { id ->
                    require(validPaper(id))
                    val row = rows.getJSONObject(id)
                    require(revision(row.get("revision")) <= version)
                    val seen = row.getJSONObject("seen")
                    require(seen.length() <= 24 && !seen.has(owner))
                    seen.keys().forEach { require(validDevice(it)); revision(seen.get(it)) }
                    val value = row.get("value")
                    require(value == JSONObject.NULL || when (field) {
                        "favorites" -> value is JSONObject && value.length() == 1 && value.has("addedAt") &&
                            (value.isNull("addedAt") || runCatching { FavoriteCollections.instant(value.getString("addedAt")) }.isSuccess)
                        "reading" -> value == true
                        "annotations" -> value is JSONArray && (0 until value.length()).all { value.optJSONObject(it) != null }
                        "notes" -> value is JSONObject && value.opt("text") is String &&
                            (value.opt("revision") as? Number)?.let { it.toDouble() == it.toLong().toDouble() && it.toLong() in 0L until Int.MAX_VALUE.toLong() } == true
                        else -> value is JSONObject
                    })
                }
            }
            doc
        }
        val previous = local.optJSONObject(BASELINE)?.takeIf { it.optString("device") == device }
        val observed = previous?.getJSONObject("observed") ?: JSONObject()
        val observedDigests = previous?.optJSONObject("digests") ?: JSONObject()
        val digests = JSONObject()
        remote.forEach { (id, bytes) -> digests.put(id, BackupCodec.hash(bytes)) }
        observed.keys().forEach { id ->
            val current = documents[id]?.getLong("revision") ?: 0L
            val version = observed.getLong(id)
            require(current >= version) { "云端同步记录缺失或回退，已保留本机资料" }
            require(current != version || !observedDigests.has(id) || observedDigests.getString(id) == digests.optString(id)) {
                "云端同步记录版本未变但内容已更改，已保留本机资料"
            }
        }
        for (document in documents.values) {
            val all = document.getJSONObject("records")
            for (field in fields) {
                val rows = all.getJSONObject(field)
                rows.keys().forEach { id ->
                    val seen = rows.getJSONObject(id).getJSONObject("seen")
                    seen.keys().forEach { require((documents[it]?.getLong("revision") ?: 0) >= seen.getLong(it)) }
                }
            }
        }
        val baseline = previous?.getJSONObject("hashes") ?: JSONObject()
        val projection = project(local)
        val localHashes = hashes(projection)
        val own = documents[device]
        val records = own?.getJSONObject("records")?.copy() ?: JSONObject().also {
            for (field in fields) it.put(field, JSONObject())
        }
        val ownVersion = own?.getLong("revision") ?: 0L
        val next = ownVersion + 1
        revision(next)
        val seen = observed.copy().also { it.remove(device) }
        var changed = false
        for (field in fields) {
            val rows = records.getJSONObject(field)
            val current = projection.getJSONObject(field)
            val previousHashes = baseline.optJSONObject(field) ?: JSONObject()
            val currentHashes = localHashes.getJSONObject(field)
            rows.keys().forEach { id ->
                val row = rows.getJSONObject(id)
                if (row.getLong("revision") > observed.optLong(device) && (previous != null || current.has(id))) {
                    require(canonical(current.opt(id) ?: JSONObject.NULL) == canonical(row.get("value"))) {
                        "同一设备有未确认的云端编辑，本机与云端资料均已保留"
                    }
                }
            }
            val ids = current.keys().asSequence().toSet() + previousHashes.keys().asSequence().toSet()
            for (id in ids) {
                if (currentHashes.optString(id) == previousHashes.optString(id)) continue
                val value = current.opt(id) ?: JSONObject.NULL
                if (ownVersion > observed.optLong(device) && rows.has(id) && canonical(rows.getJSONObject(id).get("value")) == canonical(value)) continue
                rows.put(id, JSONObject().put("revision", next).put("seen", seen).put("value", value))
                changed = true
            }
        }
        val combined = documents.toMutableMap()
        var upload: ByteArray? = null
        if (changed) {
            require(own != null || remote.size < 24) { "同步设备数量超过上限" }
            val legacyDigest = own?.opt(LEGACY_DIGEST) ?: remote[device]?.let(BackupCodec::hash) ?: JSONObject.NULL
            val document = JSONObject().put("format", FORMAT).put("device", device).put("revision", next)
                .put("records", records).put(LEGACY_DIGEST, legacyDigest)
            upload = document.toString().toByteArray().also { require(it.size <= LIMIT) { "同步资料超过 8 MiB" } }
            digests.put(device, BackupCodec.hash(upload))
            combined[device] = document
        }
        val merged = JSONObject()
        var conflicts = 0
        for (field in fields) {
            val byPaper = mutableMapOf<String, MutableList<Edit>>()
            for ((owner, document) in combined) {
                val rows = document.getJSONObject("records").getJSONObject(field)
                rows.keys().forEach { id ->
                    val row = rows.getJSONObject(id)
                    byPaper.getOrPut(id) { mutableListOf() }.add(Edit(owner, row.getLong("revision"), row.getJSONObject("seen"), row.get("value")))
                }
            }
            val result = JSONObject()
            for ((id, edits) in byPaper) {
                val heads = edits.filter { a -> edits.none { b -> b.seen.optLong(a.device) >= a.revision } }
                require(heads.isNotEmpty()) { "云端同步记录存在循环引用" }
                val value = if (field in listOf("notes", "annotations") && heads.map { edit ->
                    if (field == "notes" && edit.value is JSONObject) canonical(edit.value.getString("text")) else canonical(edit.value)
                }.toSet().size > 1) {
                    conflicts++
                    projection.getJSONObject(field).opt(id) ?: JSONObject.NULL
                } else if (field in sets && heads.any { it.value == JSONObject.NULL }) JSONObject.NULL
                else if (field == "favorites") {
                    heads.map { it.value as JSONObject }.minWith(compareBy<JSONObject> {
                        if (it.isNull("addedAt")) Instant.MAX else FavoriteCollections.instant(it.getString("addedAt"))
                    }.thenBy { it.optString("addedAt") })
                } else heads.maxWith(compareBy<Edit> { it.revision }.thenBy { it.device }).value
                if (value != JSONObject.NULL) result.put(id, value)
            }
            merged.put(field, result)
        }
        val result = local.copy()
        for (field in sets) {
            val rows = merged.getJSONObject(field)
            val old = local.optJSONArray(field) ?: JSONArray()
            val localOnly = (0 until old.length()).map { old.getString(it) }.filterNot(::validPaper)
            result.put(field, JSONArray((localOnly + rows.keys().asSequence().toList()).sorted()))
        }
        for (field in maps) {
            val old = local.optJSONObject(field) ?: JSONObject()
            val rows = merged.getJSONObject(field).copy()
            old.keys().forEach { if (!validPaper(it)) rows.put(it, old.get(it)) }
            if (field == "notes") rows.keys().asSequence().toList().forEach { id ->
                val oldNote = old.optJSONObject(id)
                val note = rows.getJSONObject(id)
                val previousRevision = oldNote?.getInt("revision") ?: 0
                val revision = note.getInt("revision")
                val textChanged = note.getString("text") != (oldNote?.getString("text") ?: "")
                if (textChanged && revision <= previousRevision) {
                    require(previousRevision < Int.MAX_VALUE - 1) { "笔记版本已达上限" }
                    rows.put(id, note.copy().put("revision", previousRevision + 1))
                } else if (revision < previousRevision) {
                    rows.put(id, note.copy().put("revision", previousRevision))
                }
            }
            result.put(field, rows)
        }
        val favorites = FavoriteCollections.editable(result)
        val items = favorites.getJSONObject("items")
        val mergedFavorites = merged.getJSONObject("favorites")
        val oldItems = canonical(items)
        val oldFavorites = local.getJSONArray("favorites")
        for (index in 0 until oldFavorites.length()) {
            val id = oldFavorites.getString(index)
            if (validPaper(id) && !mergedFavorites.has(id)) items.remove(id)
        }
        mergedFavorites.keys().forEach { id ->
            val item = items.optJSONObject(id) ?: JSONObject().put("folderIDs", JSONArray())
            item.put("addedAt", mergedFavorites.getJSONObject(id).get("addedAt"))
            items.put(id, item)
        }
        if (oldItems != canonical(items)) favorites.put("revision", favorites.getLong("revision") + 1)
        result.put("favoriteCollections", favorites)
        val observedNext = JSONObject()
        combined.forEach { (id, doc) -> observedNext.put(id, doc.getLong("revision")) }
        result.put(BASELINE, JSONObject().put("device", device).put("observed", observedNext).put("digests", digests).put("hashes", hashes(project(result))))
        PersonalStore.validate(result)
        require(result.toString().toByteArray().size <= PersonalStore.MAX_BYTES)
        return Plan(result, upload, conflicts)
    }

    fun unchanged(before: JSONObject, after: JSONObject): Boolean =
        (fields + listOf("favoriteCollections", BASELINE)).all { canonical(before.opt(it)) == canonical(after.opt(it)) }

    fun apply(current: JSONObject, plan: Plan): JSONObject = current.copy().also { result ->
        for (field in fields + listOf("favoriteCollections", BASELINE)) result.put(field, plan.personal.get(field))
    }
}
