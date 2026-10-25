package com.nanless.paperdigest.data

import org.json.JSONArray
import org.json.JSONObject

data class Paper(
    val id: String,
    val title: String,
    val titleZh: String = title,
    val authors: List<String> = emptyList(),
    val date: String = "",
    val score: Double? = null,
    val task: String = "",
    val method: String = "",
    val tags: List<String> = emptyList(),
    val sourceKind: String = "unknown",
    val identityStatus: String = "unverified",
    val blogURL: String = "",
    val sourceURL: String? = null,
    val pdfURL: String? = null,
    val sourceVersion: String? = null,
    val citation: JSONObject = JSONObject(),
    val pdfSHA256: String? = null,
    val appearances: List<String> = emptyList(),
    val localPDFPath: String? = null,
    val original: JSONObject? = null
) {
    /** Reuse only equal immutable values after the new row has been fully decoded and checked. */
    internal fun sharingCatalogValues(previous: Paper?): Paper {
        if (previous == null || previous.id != id) return this
        fun text(value: String, old: String) = if (value == old) old else value
        fun optional(value: String?, old: String?) = if (value == old) old else value
        fun strings(value: List<String>, old: List<String>) = if (value == old) old else value
        return copy(id = previous.id, title = text(title, previous.title), titleZh = text(titleZh, previous.titleZh),
            authors = strings(authors, previous.authors), date = text(date, previous.date), task = text(task, previous.task),
            method = text(method, previous.method), tags = strings(tags, previous.tags), sourceKind = text(sourceKind, previous.sourceKind),
            identityStatus = text(identityStatus, previous.identityStatus), blogURL = text(blogURL, previous.blogURL),
            sourceURL = optional(sourceURL, previous.sourceURL), pdfURL = optional(pdfURL, previous.pdfURL),
            sourceVersion = optional(sourceVersion, previous.sourceVersion), pdfSHA256 = optional(pdfSHA256, previous.pdfSHA256),
            localPDFPath = optional(localPDFPath, previous.localPDFPath), appearances = strings(appearances, previous.appearances),
            citation = if (equalCatalogJson(citation, previous.citation, 0)) previous.citation else citation)
        // original is deliberately new: the just-verified manifest is never replaced by old provenance.
    }

    fun json() = (original?.copy() ?: JSONObject()).put("id", id).put("title", title).put("titleZh", titleZh)
        .put("authors", JSONArray(authors)).put("date", date).put("score", score ?: JSONObject.NULL)
        .put("task", task).put("method", method).put("tags", JSONArray(tags)).put("sourceKind", sourceKind)
        .put("identityStatus", identityStatus).put("blogURL", blogURL).put("sourceURL", sourceURL ?: JSONObject.NULL)
        .put("pageType", "paper")
        .put("pdfURL", pdfURL ?: JSONObject.NULL).put("sourceVersion", sourceVersion ?: JSONObject.NULL)
        .put("citation", citation.copy()).put("pdfSHA256", pdfSHA256 ?: JSONObject.NULL).put("appearances", JSONArray(appearances))
        .put("localPDFPath", localPDFPath ?: JSONObject.NULL).also { if (sourceKind == "local") it.put("pdfSHA", pdfSHA256) }

    companion object {
        private fun equalCatalogJson(value: Any?, old: Any?, depth: Int): Boolean {
            require(depth <= 64) { "目录嵌套超过安全读取范围" }
            if (value === old) return true
            return when (value) {
                is JSONObject -> old is JSONObject && value.length() == old.length() && value.keys().asSequence().all { key ->
                    old.has(key) && equalCatalogJson(value.get(key), old.get(key), depth + 1)
                }
                is JSONArray -> old is JSONArray && value.length() == old.length() && (0 until value.length()).all { index ->
                    equalCatalogJson(value.get(index), old.get(index), depth + 1)
                }
                // Conservative scalar equality: unlike textual coercion, this cannot hide a changed JSON type.
                else -> value?.javaClass == old?.javaClass && value == old
            }
        }
        fun fromJson(o: JSONObject): Paper { val owned = o.copy(); return decode(owned, owned) }
        // The catalog owns this freshly decoded tree and exposes it as an immutable view.
        // Public imports still copy; exports always copy before modifying fields.
        internal fun fromOwnedCatalogJson(o: JSONObject): Paper {
            // json() regenerates these exact fields from the typed values. Retain only
            // the extension tree here instead of also keeping all known containers.
            val replaced = setOf("id", "title", "titleZh", "authors", "date", "score", "task", "method", "tags", "sourceKind", "identityStatus", "blogURL", "sourceURL", "pageType", "pdfURL", "sourceVersion", "citation", "pdfSHA256", "appearances", "localPDFPath")
            val extensions = JSONObject()
            o.keys().forEach { key -> if (key !in replaced && !(key == "pdfSHA" && o.optString("sourceKind") == "local")) extensions.put(key, o.get(key)) }
            return decode(o, extensions)
        }
        private fun decode(o: JSONObject, original: JSONObject) = Paper(o.getString("id"), o.getString("title"), o.optString("titleZh", o.getString("title")),
            o.optJSONArray("authors")?.strings() ?: emptyList(), o.optString("date"), score(o.opt("score")),
            o.optString("task"), o.optString("method"), o.optJSONArray("tags")?.strings() ?: emptyList(),
            o.optString("sourceKind", "unknown"), o.optString("identityStatus", "unverified"), o.optString("blogURL"),
            o.nullableString("sourceURL"), o.nullableString("pdfURL"), o.nullableString("sourceVersion"), o.optJSONObject("citation") ?: JSONObject(),
            o.nullableString("pdfSHA256") ?: o.nullableString("pdfSHA"), o.optJSONArray("appearances")?.strings() ?: emptyList(), o.nullableString("localPDFPath"), original)
        fun score(value: Any?): Double? = when (value) { is Number -> value.toDouble(); is String -> value.toDoubleOrNull(); else -> null }?.takeIf { it.isFinite() && it in 0.0..10.0 }
    }
}

data class ArticleResource(val sourceURL: String, val kind: String = "image", val localPath: String? = null, val sha256: String? = null, val missingReason: String? = null) {
    fun json() = JSONObject().put("sourceURL", sourceURL).put("kind", kind).put("localPath", localPath ?: JSONObject.NULL).put("sha256", sha256 ?: JSONObject.NULL).put("missingReason", missingReason ?: JSONObject.NULL)
}

data class Article(val paperID: String, val html: String, val plainText: String, val sourceURL: String, val blogURL: String,
    val revisionSHA256: String, val fetchedAt: String, val sourceVersion: String? = null, val completeOffline: Boolean = false,
    val notices: List<String> = emptyList(), val isStale: Boolean = false, val citation: JSONObject = JSONObject(),
    val resources: List<ArticleResource> = emptyList(), val catalogEpoch: String = "", val researchContext: JSONObject? = null, val pdfURL: String? = null,
    val markdown: String? = null, val mathMLContract: String? = null, val original: JSONObject? = null, val inlineImages: Map<String, String> = emptyMap()) {
    fun json() = (original?.copy() ?: JSONObject()).put("paperID", paperID).put("html", html).put("plainText", plainText).put("sourceURL", sourceURL)
        .put("blogURL", blogURL).put("revisionSHA256", revisionSHA256).put("fetchedAt", fetchedAt).put("sourceVersion", sourceVersion ?: JSONObject.NULL)
        .put("completeOffline", completeOffline).put("notices", JSONArray(notices)).put("isStale", isStale).put("citation", citation.copy())
        .put("resources", JSONArray(resources.map { it.json() })).put("catalogEpoch", catalogEpoch).put("researchContext", researchContext?.copy() ?: JSONObject.NULL)
        .put("pdfURL", pdfURL ?: JSONObject.NULL)
        .also { value -> if (markdown != null) value.put("markdown", markdown); if (mathMLContract != null) value.put("mathMLContract", mathMLContract) }
    companion object {
        fun fromJson(o: JSONObject): Article = decode(o.copy())
        private fun decode(o: JSONObject) = Article(o.getString("paperID"), o.getString("html"), o.getString("plainText"), o.getString("sourceURL"), o.getString("blogURL"),
            o.getString("revisionSHA256"), o.getString("fetchedAt"), o.nullableString("sourceVersion"), o.optBoolean("completeOffline"),
            o.optJSONArray("notices")?.strings() ?: emptyList(), o.optBoolean("isStale"), o.getJSONObject("citation"),
            o.optJSONArray("resources")?.objects()?.map { ArticleResource(it.getString("sourceURL"), it.optString("kind", "image"), it.nullableString("localPath"), it.nullableString("sha256"), it.nullableString("missingReason")) } ?: emptyList(),
            o.optString("catalogEpoch"), o.optJSONObject("researchContext"), o.nullableString("pdfURL"), o.nullableString("markdown"), o.nullableString("mathMLContract"), o)
    }
}
