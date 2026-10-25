package com.nanless.paperdigest.zotero

import com.nanless.paperdigest.data.JsonFiles
import com.nanless.paperdigest.data.PublishedUtf8
import com.nanless.paperdigest.data.sha256
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.util.UUID

/** A read-only projection of preserved Mac journals, never Web API authority. */
object LegacyMacArchiveHistory {
    private val roles = setOf("bibliography", "source-metadata", "pdf", "guide", "analysis", "note")

    fun read(researchRoot: File): JSONObject {
        val records = JSONArray()
        val result = JSONObject().put("contract", "mac-local-archive-history-v1")
            .put("records", records).put("unreadableCount", 0)
        // The caller resolves only its OS-provided base before appending the
        // controlled research child. Do not erase child links by canonicalizing.
        val root = researchRoot.toPath().toAbsolutePath().normalize()
        if (generateSequence(root) { it.parent }.any { Files.isSymbolicLink(it) || !Files.isDirectory(it, NOFOLLOW_LINKS) }) {
            return result.put("unreadableCount", 1)
        }
        val directory = root.resolve("zotero-archives").toFile()
        if (!Files.exists(directory.toPath(), NOFOLLOW_LINKS)) return result
        if (!Files.isDirectory(directory.toPath(), NOFOLLOW_LINKS) || Files.isSymbolicLink(directory.toPath())) {
            return result.put("unreadableCount", 1)
        }
        val files = directory.listFiles() ?: return result.put("unreadableCount", 1)
        var unreadable = 0
        for (file in files.sortedBy { it.name }) {
            if (!file.name.endsWith(".json") || file.name.endsWith(".summary.json")) continue
            val id = file.name.removeSuffix(".json")
            try {
                require(UUID.fromString(id).toString().equals(id, ignoreCase = true))
                val bytes = JsonFiles.read(file, 8L * 1024 * 1024)
                val journal = JSONObject(PublishedUtf8.decode(bytes))
                require(journal.getString("id") == id)
                require(journal.getString("serverID").isNotBlank())
                require(journal.getString("fingerprint").matches(Regex("[a-f0-9]{64}")))
                val request = journal.getJSONObject("request")
                val identity = request.getString("identity")
                require(identity.isNotBlank() && identity.length <= 4096)
                val title = request.getJSONObject("bibliography").getString("title")
                require(title.isNotBlank() && title.length <= 4096)
                val steps = journal.getJSONArray("steps")
                require(steps.length() in 1..roles.size)
                val seen = mutableSetOf<String>()
                val projected = JSONArray()
                var allReportedVerified = true
                for (i in 0 until steps.length()) {
                    val step = steps.getJSONObject(i)
                    val role = step.getString("role")
                    require(role in roles && seen.add(role))
                    require(step.get("verified") is Boolean)
                    val verified = step.getBoolean("verified")
                    val key = step.opt("key")
                    if (verified) require(key is String && validObjectKey(key))
                    if (key != null && key != JSONObject.NULL) require(key is String && validObjectKey(key))
                    allReportedVerified = allReportedVerified && verified
                    projected.put(JSONObject().put("role", role).put("originalKey", key ?: JSONObject.NULL)
                        .put("reportedVerified", verified))
                }
                require("bibliography" in seen)
                val parent = journal.opt("parentKey")
                if (parent != null && parent != JSONObject.NULL) require(parent is String && validObjectKey(parent))
                val collection = journal.opt("collectionKey")
                if (collection != null && collection != JSONObject.NULL) require(collection is String && validObjectKey(collection))
                val bibliography = (0 until projected.length()).map { projected.getJSONObject(it) }
                    .single { it.getString("role") == "bibliography" }
                require(bibliography.opt("originalKey") == (parent ?: JSONObject.NULL))
                val hashes = journal.optJSONObject("materialSHA256") ?: JSONObject()
                require(hashes.keys().asSequence().all { it in setOf("pdf", "guide") && hashes.getString(it).matches(Regex("[a-f0-9]{64}")) })
                val row = JSONObject().put("origin", "mac-local").put("id", id)
                    .put("identity", identity).put("title", title).put("originalParentKey", parent ?: JSONObject.NULL)
                    .put("originalCollectionKey", collection ?: JSONObject.NULL)
                    .put("steps", projected).put("originalMaterialSHA256", JSONObject(hashes.toString()))
                    .put("sourceSHA256", sha256(bytes)).put("reportedStatus", if (allReportedVerified) "complete" else "partial")
                    .put("readOnly", true).put("canResume", false).put("currentRemoteVerified", false)
                val summaryFile = File(directory, "$id.summary.json")
                if (Files.exists(summaryFile.toPath(), NOFOLLOW_LINKS)) {
                    try {
                        val summary = JSONObject(PublishedUtf8.decode(JsonFiles.read(summaryFile, 32768)))
                        require(summary.getString("archiveID") == id && summary.getString("serverID") == journal.getString("serverID"))
                        require(summary.getString("identity") == identity && summary.getString("title") == title)
                        require(summary.optString("parentKey") == (parent as? String ?: ""))
                        require(summary.getString("status") == row.getString("reportedStatus"))
                        val timestamp = summary.getDouble("updatedAt")
                        require(timestamp.isFinite() && timestamp >= 0)
                        row.put("originalUpdatedAt", timestamp)
                    } catch (_: Exception) { row.put("summaryUnavailable", true) }
                }
                records.put(row)
            } catch (_: Exception) { unreadable++ }
        }
        return result.put("unreadableCount", unreadable)
    }

    private fun validObjectKey(value: String) = value.matches(Regex("[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}"))
}
