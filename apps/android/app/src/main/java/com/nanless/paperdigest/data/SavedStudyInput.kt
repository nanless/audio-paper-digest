package com.nanless.paperdigest.data

import com.nanless.paperdigest.cloud.BackupCodec
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Collections
import java.util.UUID

/** Read-only provenance, NOT response/fee authentication or permission to issue a request.
 * Hashes the original bytes before parsing; never rewrites a restored input or requires device HMAC.
 */
fun verifiedSavedStudyInput(session: JSONObject, inputBytes: ByteArray): SavedStudySource? = try {
    verifyStudyInput(session, inputBytes)
} catch (_: Exception) { null }

/** researchRoot must be the application's resolved research directory, not a caller supplied file path. */
fun readSavedStudyInput(session: JSONObject, researchRoot: File): SavedStudySource? = try {
    val id = studyInputID(session)
    val file = BackupCodec.checkedFile(researchRoot, "ModelUsage/$id-input.json")
    val bytes = JsonFiles.read(file, 8L * 1024 * 1024)
    val input = verifiedSavedStudyInput(session, bytes) ?: error("Invalid original input")
    val android = JSONObject(bytes.toString(Charsets.UTF_8)).opt("contract") == "android-study-input-v1"
    input.copy(originalResponseBinding = readOriginalStudyResponse(session, researchRoot, input, android))
} catch (_: Exception) { null }

/** Read-only original-byte binding, not response authenticity, success, billing or replay authority.
 * Android StudyService saves a raw .bin plus a receipt; Mac ModelService instead saves a
 * desktop-model-response-recovery-v1 envelope containing its normalized response session.
 * There is no Mac UUID-response.bin contract: never invent one or consult current settings.
 */
private fun readOriginalStudyResponse(session: JSONObject, root: File, input: SavedStudySource, android: Boolean): String? {
    val id = input.sessionID
    val usage = BackupCodec.checkedFile(root, "ModelUsage/$id-input.json").parentFile!!
    fun exists(name: String) = java.nio.file.Files.exists(File(usage, name).toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS)
    fun read(name: String, limit: Long) = JsonFiles.read(BackupCodec.checkedFile(root, "ModelUsage/$name"), limit)
    fun json(bytes: ByteArray) = JSONObject(Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString())
    val receiptName = "$id-response.json"
    val bodyName = "$id-response.bin"
    // requestIssued alone is NOT a response claim. Prepared, pending and failed requests can
    // have no response at all. Supplementary Android captures start life as empty files.
    var declared = session.has("responseSHA256") || session.has("httpStatus") ||
        session.optString("status") in setOf("completed", "complete") ||
        listOf("answer", "text", "response").any { (session.opt(it) as? String)?.isNotEmpty() == true } ||
        (session.optString("finishStatus").let { it.isNotEmpty() && it != "unknown" }) ||
        (!session.isNull("usage") || !session.isNull("actualModel")) ||
        exists(receiptName) || exists(bodyName)
    val captures = JSONArray()
    val names = usage.list() ?: error("Original response directory unavailable")
    val pattern = Regex(Regex.escape(id) + "-response-capture-([a-f0-9-]{36})\\.(json|bin)")
    val captureNames = names.filter { pattern.matches(it) }.sorted()
    require(captureNames.size <= 20000)
    for (name in captureNames) {
        val match = pattern.matchEntire(name)!!
        val captureID = match.groupValues[1]
        require(UUID.fromString(captureID).toString() == captureID)
        val bytes = read(name, if (name.endsWith(".json")) 1024L * 1024 else 16L * 1024 * 1024)
        captures.put(JSONObject().put("name", name).put("sha256", sha256(bytes)))
        if (name.endsWith(".bin")) {
            if (bytes.isNotEmpty()) declared = true
        } else {
            val capture = json(bytes)
            require(capture.get("contract") == "android-http-response-capture-v1" &&
                capture.get("sessionID") == id && capture.get("inputSHA256") == input.inputSHA && capture.get("captureID") == captureID)
            val count = capture.get("byteCount")
            require(count is Number && count.toLong() >= 0 && count.toDouble() == count.toLong().toDouble())
            if (count.toLong() > 0 || !capture.isNull("httpStatus") || capture.optString("status") in setOf("receiving", "body-complete")) declared = true
        }
    }
    if (!declared) return null
    val receiptBytes = read(receiptName, if (android) 1024L * 1024 else 64L * 1024 * 1024) // Actual readers' limits.
    val receipt = json(receiptBytes)
    val binding = JSONObject().put("record", session).put("inputSHA256", input.inputSHA)
        .put("receiptSHA256", sha256(receiptBytes)).put("captures", captures)
    when (receipt.get("contract")) {
        "android-model-response-v1" -> {
            require(android)
            val body = read(bodyName, 16L * 1024 * 1024)
            val bodySHA = sha256(body)
            require(receipt.get("sessionID") == id && receipt.get("inputSHA256") == input.inputSHA && receipt.get("sha256") == bodySHA)
            if (session.has("responseSHA256")) require(session.get("responseSHA256") == bodySHA)
            for ((recordKey, receiptKey) in listOf("httpStatus" to "httpStatus", "startedAt" to "startedAt")) {
                if (session.has(recordKey)) require(session.get(recordKey) == receipt.get(receiptKey))
            }
            binding.put("bodySHA256", bodySHA)
        }
        "desktop-model-response-recovery-v1" -> {
            // This actual producer embeds the saved text/response in the exact envelope bytes;
            // its MAC is opaque here. Do not touch the installation's integrity key or keychain.
            require(!android)
            val saved = receipt.getJSONObject("session")
            require(saved.get("id") == id && saved.get("inputSHA256") == input.inputSHA)
            for (field in listOf("id", "kind", "paperID", "question", "source", "fingerprint", "model", "inputSHA256", "startedAt", "parentSessionID")) {
                require(canonical(saved.opt(field)) == canonical(session.opt(field)))
            }
            require(saved.get("text") is String && saved.get("response") == saved.get("text"))
            for (field in listOf("responseSHA256", "httpStatus", "text", "response", "answer", "actualModel", "usage", "protocol", "finishStatus")) {
                if (session.has(field)) require(canonical(session.get(field)) == canonical(saved.opt(field)))
            }
            // A stray Android-style body must not be silently ignored for a desktop envelope.
            require(!exists(bodyName))
        }
        else -> error("Unsupported original response contract")
    }
    return sha256(canonical(binding).toByteArray(Charsets.UTF_8))
}

private fun studyInputID(session: JSONObject): String {
    val id = session.get("id") as String
    require(UUID.fromString(id).toString().equals(id, ignoreCase = true))
    return id
}

private fun verifyStudyInput(session: JSONObject, bytes: ByteArray): SavedStudySource {
    val id = studyInputID(session)
    require(bytes.isNotEmpty() && bytes.size <= 8 * 1024 * 1024)
    val inputSHA = session.get("inputSHA256") as String
    require(BackupCodec.validSHA(inputSHA) && sha256(bytes) == inputSHA)
    // Reject malformed UTF-8 instead of accepting replacement characters in original evidence.
    val text = Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString()
    val sealed = JSONObject(text)
    val owner = session.get("paperID") as String
    val question = session.get("question") as String
    require(owner.isNotBlank() && question.isNotBlank() && session.get("kind") == "study")
    val source = sealed.getJSONObject("source")
    require(canonical(source) == canonical(session.getJSONObject("source")) && source.get("paperID") == owner)
    val pdfSHA = source.get("pdfSHA") as String
    require(BackupCodec.validSHA(pdfSHA))
    val pages = studyPages(source.getJSONArray("pages"))
    require(pages.isNotEmpty())
    val config = sealed.getJSONObject("config")
    require(!config.has("key") && config.get("model") is String && config.get("model") == session.get("model"))
    val messages = sealed.getJSONArray("messages")
    require(messages.length() == 2)
    for ((index, role) in listOf("system", "user").withIndex()) {
        val message = messages.getJSONObject(index)
        require(message.keys().asSequence().toSet() == setOf("role", "content") && message.get("role") == role && message.get("content") is String)
        require(message.getString("content").isNotBlank())
    }
    val fingerprint = session.get("fingerprint") as String
    require(BackupCodec.validSHA(fingerprint) && sealed.get("fingerprint") == fingerprint)
    val android = sealed.opt("contract") == "android-study-input-v1"
    val sourceHeader = if (android) canonical(source) else desktopStudyJSON(source)
    val prefix = "研究问题：\n$question\n\n来源身份：\n$sourceHeader\n\n实际证据：\n"
    val user = messages.getJSONObject(1).getString("content")
    require(user.startsWith(prefix))
    val evidence = user.substring(prefix.length)
    require(evidence.isNotBlank() && evidence.toByteArray(Charsets.UTF_8).size <= 1024 * 1024)
    if (android) {
        require(sealed.keys().asSequence().toSet() == setOf("contract", "config", "messages", "source", "fingerprint", "identity"))
        require(!session.has("inputContract") || session.get("inputContract") == "android-study-input-v1")
        val identity = sealed.getJSONObject("identity")
        require(identity.keys().asSequence().toSet() == setOf("contract", "extractor", "kind", "paperID", "question", "messages", "source", "config"))
        require(identity.get("contract") == "android-study-v1" && identity.get("kind") == "study")
        require(identity.get("paperID") == owner && identity.get("question") == question)
        require(canonical(identity.getJSONObject("source")) == canonical(source))
        require(canonical(identity.getJSONArray("messages")) == canonical(messages))
        require(canonical(identity.getJSONObject("config")) == canonical(config))
        require(identity.get("extractor") == source.optString("extractor", "published-html-mathml-v1"))
        require(sha256(canonical(identity).toByteArray(Charsets.UTF_8)) == fingerprint)
        require(source.get("kind") in setOf("pdf-selection", "pdf-range", "pdf-document", "pdf-chapter"))
    } else {
        // Mac v3/v4 sealed inputs have no identity/contract member. Reconstruct THEIR original
        // fingerprint schema and Foundation sorted-JSON encoding; never invent an Android identity.
        require(sealed.keys().asSequence().toSet() == setOf("config", "messages", "source", "fingerprint"))
        require(source.get("kind") in setOf("pdf-selection", "page", "range", "chapter", "full", "pdf-page", "pdf-range", "pdf-chapter", "pdf-full"))
        val budget = positiveStudySourcePage(config.get("maxTokens")) ?: error("Invalid input")
        val identity = JSONObject().put("contract", "desktop-study-v3").put("extractor", "pdfkit-physical-pages-v1")
            .put("kind", "study").put("paperID", owner).put("messages", messages).put("model", config.get("model"))
            .put("endpoint", config.get("endpoint") as String).put("protocol", config.opt("protocol") ?: "auto")
            .put("question", question).put("evidence", evidence).put("source", source).put("maxTokens", budget)
        val old = sha256(desktopStudyJSON(identity).toByteArray(Charsets.UTF_8))
        identity.put("contract", "desktop-study-v4").put("responsesStream", config.opt("responsesStream") ?: false)
            .put("reasoningEffort", config.opt("reasoningEffort") ?: "default")
        require(old == fingerprint || sha256(desktopStudyJSON(identity).toByteArray(Charsets.UTF_8)) == fingerprint)
    }
    validateStudyPages(source, pages, evidence, android)
    return SavedStudySource(id, owner, pdfSHA, Collections.unmodifiableList(pages), inputSHA, canonical(source))
}

private fun studyPages(array: JSONArray): List<Int> {
    val result = (0 until array.length()).map { positiveStudySourcePage(array.get(it)) ?: error("Invalid input") }
    require(result.distinct().size == result.size)
    return result
}

private fun validateStudyPages(source: JSONObject, pages: List<Int>, evidence: String, android: Boolean) {
    if (source.has("page")) require(positiveStudySourcePage(source.get("page")) == pages.first())
    require(!source.has("missingTextPages") || source.opt("missingTextPages") is JSONArray)
    val missing = source.optJSONArray("missingTextPages")?.let(::studyPages).orEmpty()
    require(missing.all { it in pages } && missing.size < pages.size)
    for (key in listOf("completeTextCoverage", "allPagesHaveExtractableText")) {
        if (source.has(key)) require(source.get(key) == missing.isEmpty())
    }
    if (source.has("text")) require(source.get("text") == evidence)
    if (source.get("kind") == "pdf-selection") return // Selection text has no synthetic page headers.
    val expected = if (android) pages else pages.filterNot { it in missing }
    val marker = if (android) Regex("(?m)^\\[原文物理页 ([0-9]+)]\\n") else Regex("(?m)^\\[p\\.([0-9]+)]\\n")
    require(evidence.startsWith(if (android) "[原文物理页 ${expected.first()}]\n" else "\n[p.${expected.first()}]\n"))
    require(marker.findAll(evidence).map { it.groupValues[1].toInt() }.toList() == expected)
}

/** Foundation JSONSerialization.sortedKeys escapes solidus; old byte identities retain that format. */
internal fun desktopStudyJSON(value: Any?): String = when (value) {
    is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") { desktopStudyJSON(it) + ":" + desktopStudyJSON(value.get(it)) }
    is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { desktopStudyJSON(value.get(it)) }
    is String -> JSONObject.quote(value).replace("\\/", "/").replace("/", "\\/")
    else -> canonical(value)
}
