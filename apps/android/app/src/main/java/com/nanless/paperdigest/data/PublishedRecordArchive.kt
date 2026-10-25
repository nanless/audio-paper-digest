package com.nanless.paperdigest.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Preserve unknown published metadata without duplicating every raw row in the live 8,000-paper view. */
class PublishedRecordArchive(private val directory: File) {
    suspend fun read(paper: Paper): JSONObject = withContext(Dispatchers.IO) {
        val snapshot = paper.original?.nullableString("publishedSnapshotID")
        if (snapshot == null) {
            val legacy = paper.original?.nullableString("legacyPublishedIndexSHA256")
            if (legacy != null) {
                require(legacy.matches(Regex("[a-f0-9]{64}")))
                val size = requireNotNull(paper.original).get("legacyPublishedIndexBytes")
                require(size is Number && size.toDouble().isFinite() && size.toDouble() == size.toLong().toDouble() && size.toLong() in 1..CatalogRepository.MAX_TOTAL.toLong())
                val file = File(directory, "index-manifests/$legacy.json")
                require(file.isFile && !java.nio.file.Files.isSymbolicLink(file.toPath()) && file.length() == size.toLong()) { "原旧式目录字节不可用" }
                val digest = java.security.MessageDigest.getInstance("SHA-256"); var read = 0L
                file.inputStream().use { input ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) { currentCoroutineContext().ensureActive(); val count = input.read(buffer); if (count < 0) break; read += count; require(read <= size.toLong()); digest.update(buffer, 0, count) }
                }
                require(read == size.toLong() && digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) } == legacy) { "原旧式目录长度或指纹不符" }
                return@withContext unavailable("此保存版本使用旧式整表目录；原目录字节已保留，但本次未取得逐篇扩展元数据，不将已有书目称为完整原始元数据。")
                    .put("legacyOriginalSHA256", legacy).put("legacyOriginalBytes", read)
            }
            return@withContext unavailable("此保存版本尚未绑定原始目录清单；已有书目、导读和研究材料仍分别保留")
        }
        require(snapshot.matches(Regex("[a-f0-9]{64}"))) { "原始目录身份无效" }
        val rawManifest = JsonFiles.read(File(directory, "index-manifests/$snapshot.json"), 1024 * 1024)
        require(sha256(rawManifest) == snapshot) { "原始目录清单字节已变化" }
        val manifest = JSONObject(decodeUTF8(rawManifest))
        require(manifest.getString("contract") == "paper-search-index-manifest-v1") { "原始目录协议尚不支持" }
        val shards = manifest.getJSONArray("shards").objects()
        require(shards.size in 1..128)
        val wanted = paper.appearances.toSet().ifEmpty { setOf(paper.blogURL) }
        require(paper.blogURL in wanted)
        val records = JSONArray(); val found = mutableSetOf<String>(); val descriptors = mutableSetOf<String>()
        var count = 0L; var totalBytes = 0L
        for (shard in shards) {
            currentCoroutineContext().ensureActive()
            val hash = shard.getString("sha256"); val url = shard.getString("url")
            require(hash.matches(Regex("[a-f0-9]{64}")) && url.matches(Regex("search-index/part-[0-9]{4,}-[a-f0-9]{12}\\.json")) && url.endsWith("-${hash.take(12)}.json") && descriptors.add(url))
            val raw = JsonFiles.read(File(directory, "index/$hash.json"), 1024 * 1024)
            require(raw.size == shard.getInt("bytes") && sha256(raw) == hash) { "原始目录分片字节不符，未归档错误元数据" }
            val rows = JSONArray(decodeUTF8(raw))
            require(rows.length() == shard.getInt("recordCount")) { "原始目录分片记录数不符" }
            count += rows.length(); totalBytes += raw.size
            for (index in 0 until rows.length()) {
                currentCoroutineContext().ensureActive()
                val row = rows.getJSONObject(index); val page = CatalogRepository.sameSite(row.getString("permalink"))
                if (page !in wanted) continue
                val actual = CatalogRepository.parsePaper(row) ?: error("所选原始目录记录不是论文")
                require(actual.id == paper.id && actual.sourceKind == paper.sourceKind && actual.identityStatus == paper.identityStatus && found.add(page)) { "原始目录记录不属于同一篇论文" }
                if (page == paper.blogURL) require(actual.title == paper.title && actual.sourceVersion == paper.sourceVersion && actual.sourceURL == paper.sourceURL && actual.pdfURL == paper.pdfURL && canonical(actual.citation) == canonical(paper.citation)) { "原始目录主记录与这份保存版本不符" }
                records.put(JSONObject().put("shardSHA256", hash).put("rowIndex", index).put("record", row))
            }
        }
        require(count == manifest.getLong("recordCount") && totalBytes == manifest.getLong("totalBytes") && found == wanted) { "原始目录成员、总量或论文出现记录不完整" }
        JSONObject().put("contract", "android-published-record-archive-v1").put("status", "verified-local-originals")
            .put("snapshotID", snapshot).put("manifestSHA256", snapshot).put("manifestBytes", rawManifest.size)
            .put("manifestRawBase64", java.util.Base64.getEncoder().encodeToString(rawManifest)).put("records", records)
    }
    companion object {
        private fun decodeUTF8(bytes: ByteArray): String = Charsets.UTF_8.newDecoder()
            .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT).onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
            .decode(java.nio.ByteBuffer.wrap(bytes)).toString()
        fun unavailable(message: String) = JSONObject().put("contract", "android-published-record-archive-v1").put("status", "unavailable").put("message", message)
    }
}
