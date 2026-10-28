package com.nanless.paperdigest.data

import org.json.JSONObject
import java.util.Collections

/** Immutable source binding. Input verification is pure; only readSavedStudyInput checks response files. */
data class SavedStudySource internal constructor(
    val sessionID: String,
    val owner: String,
    val pdfSHA: String,
    val pages: List<Int>,
    val inputSHA: String,
    val sourceJSON: String,
    val originalResponseBinding: String? = null
)

internal fun positiveStudySourcePage(value: Any?): Int? {
    if (value !is Int && value !is Long && value !is Short && value !is Byte) return null
    val number = (value as Number).toLong()
    return number.takeIf { it in 1..Int.MAX_VALUE.toLong() }?.toInt()
}

/** Nullable UI projection ONLY, not a trusted capability: summary fields do not verify input bytes.
 * Use readSavedStudyInput before original-page navigation; the pure verifier checks input only. Never mutates session. */
fun savedStudySource(session: JSONObject): SavedStudySource? {
    val id = (session.opt("id") as? String)?.takeIf { it.isNotBlank() } ?: return null
    val owner = (session.opt("paperID") as? String)?.takeIf { it.isNotBlank() } ?: return null
    val source = session.optJSONObject("source") ?: return null
    if (source.opt("paperID") != owner) return null
    if (source.opt("kind") !in setOf("pdf-selection", "pdf-range", "pdf-document", "pdf-chapter", "page", "range", "chapter", "full", "pdf-page", "pdf-full")) return null
    val sha = source.opt("pdfSHA") as? String ?: return null
    val inputSHA = session.opt("inputSHA256") as? String ?: return null
    val validSHA = Regex("[a-f0-9]{64}")
    if (!validSHA.matches(sha) || !validSHA.matches(inputSHA)) return null
    val original = source.optJSONArray("pages") ?: return null
    if (original.length() == 0) return null
    val pages = (0 until original.length()).map { positiveStudySourcePage(original.opt(it)) ?: return null }
    if (pages.toSet().size != pages.size) return null
    return SavedStudySource(id, owner, sha, Collections.unmodifiableList(pages), inputSHA, canonical(source))
}
