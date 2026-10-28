package com.nanless.paperdigest.data

import org.json.JSONObject

/** A reading position is UI metadata, never a change to the original study/input/response. */
data class StudyAnswerPositionIdentity(val sessionID: String, val owner: String, val binding: String)

fun studyAnswerPositionIdentity(session: JSONObject): StudyAnswerPositionIdentity? {
    val id = (session.opt("id") as? String)?.takeIf { it.isNotBlank() } ?: return null
    val owner = (session.opt("paperID") as? String)?.takeIf { it.isNotBlank() } ?: return null
    val source = session.optJSONObject("source")
    if (source != null && source.has("paperID") && !source.isNull("paperID") && source.opt("paperID") != owner) return null
    val answer = listOf("answer", "text", "response").firstNotNullOfOrNull { (session.opt(it) as? String)?.takeIf(String::isNotBlank) }.orEmpty()
    val material = org.json.JSONArray().put(id).put(owner).put(session.optString("inputSHA256"))
        .put(session.optString("responseSHA256")).put(sha256(answer.toByteArray(Charsets.UTF_8)))
        .put(source?.let(::canonical).orEmpty())
    return StudyAnswerPositionIdentity(id, owner, sha256(material.toString().toByteArray(Charsets.UTF_8)))
}

fun savedStudyAnswerScroll(personal: JSONObject, session: JSONObject): Int {
    val identity = studyAnswerPositionIdentity(session) ?: return 0
    val entry = personal.optJSONObject("readingState")?.optJSONObject(identity.owner)
        ?.optJSONObject("studyAnswerScroll")?.optJSONObject(identity.sessionID) ?: return 0
    if (entry.optString("binding") != identity.binding) return 0
    return (entry.opt("offset") as? Int)?.takeIf { it >= 0 } ?: 0
}

/** Merge just this record; stale response callbacks cannot replace another record's saved position. */
fun mergedStudyAnswerScroll(reading: JSONObject, session: JSONObject, binding: String, offset: Int): JSONObject {
    val identity = requireNotNull(studyAnswerPositionIdentity(session)) { "原研究记录身份不足，未保存另一条记录的位置" }
    require(identity.binding == binding) { "原研究输入或回答已变化，未保存旧回答的位置" }
    require(offset >= 0) { "阅读位置无效" }
    val result = JSONObject(reading.toString())
    val positions = result.optJSONObject("studyAnswerScroll")?.let { JSONObject(it.toString()) } ?: JSONObject()
    positions.put(identity.sessionID, JSONObject().put("binding", binding).put("offset", offset))
    return result.put("studyAnswerScroll", positions)
}
