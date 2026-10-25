package com.nanless.paperdigest.data

import org.json.JSONObject
import org.json.JSONArray
import java.security.MessageDigest

/** A saved guide keeps its own identity even when the public catalog changes. */
object ReadingSourceBinding {
    fun requireArticle(paper: Paper, article: Article?) {
        if (article == null) return
        require(article.paperID == paper.id && article.blogURL == paper.blogURL &&
            article.sourceURL == (paper.sourceURL ?: paper.blogURL) &&
            article.sourceVersion == paper.sourceVersion && article.pdfURL == paper.pdfURL) {
            "导读与所选论文的原文版本或来源不同；原稿保留，请刷新或打开对应的原离线研究包后再组合材料。"
        }
    }

    fun requireCitation(paper: Paper, citation: JSONObject) {
        for (key in listOf("absUrl", "sourceUrl")) {
            val declared = citation.nullableString(key)?.takeIf { it.isNotBlank() } ?: continue
            require(paper.sourceURL == null || declared == paper.sourceURL) { "引用中的原文地址与所选论文来源不同，未混用旧题录。" }
        }
        citation.nullableString("pdfUrl")?.takeIf { it.isNotBlank() }?.let { declared ->
            require(paper.pdfURL == null || declared == paper.pdfURL) { "引用中的 PDF 地址与所选原件不同。" }
        }
        if (paper.sourceKind == "arxiv" && paper.sourceVersion != null) {
            val base = paper.sourceVersion.replace(Regex("v[1-9][0-9]*$"), "")
            for (key in listOf("arxivId", "arxivVersionedId", "id")) {
                val declared = citation.nullableString(key)?.takeIf { Regex("[0-9]{4}\\.[0-9]{4,5}(?:v[1-9][0-9]*)?").matches(it) } ?: continue
                require(declared.replace(Regex("v[1-9][0-9]*$"), "") == base && (!Regex("v[1-9][0-9]*$").containsMatchIn(declared) || declared == paper.sourceVersion)) { "引用中的 arXiv 身份或版本与所选原件不同。" }
            }
        }
    }

    /** Only selected private roles participate; excluded materials are not inspected. */
    fun selectedRoleIdentity(personal: JSONObject, paperID: String, options: JSONObject): String {
        val selected = JSONObject().put("paperID", paperID)
        if (options.optBoolean("includeNote", true)) {
            selected.put("note", personal.getJSONObject("notes").optJSONObject(paperID) ?: JSONObject().put("text", "").put("revision", 0))
                .put("annotations", personal.getJSONObject("annotations").optJSONArray(paperID) ?: JSONArray())
        }
        if (options.optBoolean("includeAnalysis", true)) {
            val chosen = options.nullableString("sessionID")
            selected.put("sessions", JSONArray(personal.getJSONArray("sessions").objects().filter { it.optString("paperID") == paperID && (chosen == null || it.optString("id") == chosen) }))
        }
        return structureIdentity(selected)
    }

    fun requirePDF(paper: Paper, receipt: JSONObject, actualSHA: String) {
        require(receipt.optString("paperID", paper.id) == paper.id && receipt.optString("sha256") == actualSHA &&
            (paper.pdfSHA256 == null || paper.pdfSHA256 == actualSHA) &&
            (paper.sourceKind == "local" || (receipt.nullableString("version") == paper.sourceVersion && receipt.nullableString("sourceURL") == paper.pdfURL))) {
            "PDF 原件与所选论文的来源回执或版本不同，未混装为同一份原件。"
        }
    }

    // A local identity of the actual immutable display strings, not a claimed file SHA.
    // Encode UTF-16 code units in bounded blocks so large inline figures aren't copied.
    private fun textIdentity(value: String): String {
        val digest = MessageDigest.getInstance("SHA-256"); val bytes = ByteArray(8192)
        var offset = 0
        while (offset < value.length) {
            val count = minOf(value.length - offset, bytes.size / 2)
            for (index in 0 until count) { val c = value[offset + index].code; bytes[index * 2] = (c ushr 8).toByte(); bytes[index * 2 + 1] = c.toByte() }
            digest.update(bytes, 0, count * 2); offset += count
        }
        return digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
    }

    private fun structureIdentity(root: JSONObject): String {
        val digest = MessageDigest.getInstance("SHA-256"); val bytes = ByteArray(8192); val length = ByteArray(8)
        var visited = 0
        fun number(value: Long) { for (index in 0..7) length[index] = (value ushr ((7 - index) * 8)).toByte(); digest.update(length) }
        fun text(value: String) {
            number(value.length.toLong()); var offset = 0
            while (offset < value.length) {
                val count = minOf(value.length - offset, bytes.size / 2)
                for (index in 0 until count) { val c = value[offset + index].code; bytes[index * 2] = (c ushr 8).toByte(); bytes[index * 2 + 1] = c.toByte() }
                digest.update(bytes, 0, count * 2); offset += count
            }
        }
        fun visit(value: Any?, depth: Int) {
            require(depth <= 64 && ++visited <= 100000) { "所选私人材料超过完整性核验范围，请分组处理" }
            when (value) {
                null, JSONObject.NULL -> digest.update(0.toByte())
                is JSONObject -> { digest.update(1.toByte()); val keys = value.keys().asSequence().toList().sorted(); number(keys.size.toLong()); keys.forEach { text(it); visit(value.get(it), depth + 1) } }
                is JSONArray -> { digest.update(2.toByte()); number(value.length().toLong()); for (index in 0 until value.length()) visit(value.get(index), depth + 1) }
                is String -> { digest.update(3.toByte()); text(value) }
                is Number -> { digest.update(4.toByte()); text(JSONObject.numberToString(value)) }
                is Boolean -> digest.update(if (value) 5.toByte() else 6.toByte())
                else -> error("所选私人材料包含不支持的原始类型")
            }
        }
        text("paperdigest-selected-roles-v1"); visit(root, 0)
        return digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
    }

    /** Currentness projections do not change the underlying source identity. */
    fun token(paper: Paper, article: Article?, receipt: JSONObject, epoch: String, opened: Long, offlineID: String?): String =
        sha256(canonical(JSONObject().put("contract", "paperdigest-reading-materials-v1")
            .put("workspace", epoch).put("opened", opened).put("offlinePackageID", offlineID ?: JSONObject.NULL)
            .put("paper", paper.json()).put("article", article?.let {
                JSONObject().put("paperID", it.paperID).put("blogURL", it.blogURL).put("sourceURL", it.sourceURL)
                    .put("sourceVersion", it.sourceVersion ?: JSONObject.NULL).put("pdfURL", it.pdfURL ?: JSONObject.NULL)
                    .put("revisionSHA256", it.revisionSHA256)
                    .put("visibleSourceUTF16SHA256", textIdentity(it.markdown?.takeIf { value -> value.isNotEmpty() } ?: it.html))
                    .put("resources", JSONArray(it.resources.map { resource -> JSONObject().put("sourceURL", resource.sourceURL).put("kind", resource.kind)
                        .put("sha256", resource.sha256 ?: JSONObject.NULL).put("missing", resource.localPath == null || resource.missingReason != null) }))
                    .put("inlineImages", JSONArray(it.inlineImages.toSortedMap().map { (key, value) -> JSONObject().put("sourceURL", key).put("projectionUTF16SHA256", textIdentity(value)) }))
            } ?: JSONObject.NULL)
            .put("pdf", if (receipt.has("sha256")) JSONObject().apply {
                for (key in listOf("paperID", "sha256", "version", "sourceURL")) put(key, receipt.opt(key) ?: JSONObject.NULL)
            } else JSONObject.NULL)).toByteArray(Charsets.UTF_8))
}
