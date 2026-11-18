package com.nanless.paperdigest.cloud

import com.nanless.paperdigest.data.AppFailure
import com.nanless.paperdigest.data.PersonalStore
import com.nanless.paperdigest.data.copy
import org.json.JSONArray
import org.json.JSONObject

/** Metadata and text of a single remote concurrent head in a multi-device note conflict. */
data class RemoteNoteCandidate(
    val remoteNote: String,
    val remoteDeviceId: String,
    val remoteRevision: Long,
) {
    init {
        require(remoteDeviceId.isNotEmpty()) { "冲突笔记缺少远端设备标识" }
        require(remoteRevision in 1..PersonalWebDavSync.MAX_REVISION) { "冲突笔记远端同步版本无效" }
    }

    fun json(): JSONObject = JSONObject()
        .put("remoteNote", remoteNote)
        .put("remoteDeviceId", remoteDeviceId)
        .put("remoteRevision", remoteRevision)

    companion object {
        fun fromJson(json: JSONObject): RemoteNoteCandidate = RemoteNoteCandidate(
            remoteNote = json.getString("remoteNote"),
            remoteDeviceId = json.getString("remoteDeviceId"),
            remoteRevision = json.getLong("remoteRevision"),
        )
    }
}

/** In-memory representation of a concurrent heterogeneous note edit observed during WebDAV sync. */
data class NoteConflictItem @JvmOverloads constructor(
    val paperId: String,
    val localNote: String,
    val remoteNote: String,
    val remoteDeviceId: String,
    val remoteRevision: Long,
    val additionalRemotes: List<RemoteNoteCandidate> = emptyList(),
) {
    init {
        require(paperId.isNotEmpty()) { "冲突笔记缺少论文编号" }
        require(remoteDeviceId.isNotEmpty()) { "冲突笔记缺少远端设备标识" }
        require(remoteRevision in 1..PersonalWebDavSync.MAX_REVISION) { "冲突笔记远端同步版本无效" }
    }

    fun allRemoteCandidates(): List<RemoteNoteCandidate> =
        listOf(RemoteNoteCandidate(remoteNote, remoteDeviceId, remoteRevision)) + additionalRemotes

    fun json(): JSONObject = JSONObject()
        .put("paperId", paperId)
        .put("localNote", localNote)
        .put("remoteNote", remoteNote)
        .put("remoteDeviceId", remoteDeviceId)
        .put("remoteRevision", remoteRevision)
        .put("additionalRemotes", JSONArray(additionalRemotes.map { it.json() }))

    companion object {
        fun fromJson(json: JSONObject): NoteConflictItem {
            val extras = json.optJSONArray("additionalRemotes")?.let { arr ->
                (0 until arr.length()).map { index -> RemoteNoteCandidate.fromJson(arr.getJSONObject(index)) }
            } ?: emptyList()
            return NoteConflictItem(
                paperId = json.getString("paperId"),
                localNote = json.getString("localNote"),
                remoteNote = json.getString("remoteNote"),
                remoteDeviceId = json.getString("remoteDeviceId"),
                remoteRevision = json.getLong("remoteRevision"),
                additionalRemotes = extras,
            )
        }
    }
}

enum class NoteConflictStrategy {
    KEEP_LOCAL,
    ADOPT_REMOTE,
    MERGE_BOTH;

    companion object {
        fun parse(raw: String): NoteConflictStrategy = when (raw.trim()) {
            "KEEP_LOCAL", "keep_local", "keep-local" -> KEEP_LOCAL
            "ADOPT_REMOTE", "adopt_remote", "adopt-remote" -> ADOPT_REMOTE
            "MERGE_BOTH", "merge_both", "merge-both" -> MERGE_BOTH
            else -> throw IllegalArgumentException("不支持的笔记冲突解决策略：$raw")
        }
    }
}

/** Pure, lossless three-way strategy resolver with strict 2 MiB note and 32 MiB personal.json guards. */
object NoteConflictMerger {
    const val MAX_NOTE_BYTES: Int = 2 * 1024 * 1024
    const val MAX_PERSONAL_BYTES: Long = PersonalStore.MAX_BYTES
    const val LOCAL_SECTION_HEADER: String = "====== 本机笔记 ======"
    private const val MAX_ISO_TIMESTAMP_PLACEHOLDER: String = "9999-12-31T23:59:59.999999999Z"

    fun remoteSectionHeader(remoteDeviceId: String, remoteRevision: Long): String =
        "====== 云端并发笔记（设备 $remoteDeviceId · 同步版本 $remoteRevision） ======"

    @JvmOverloads
    fun resolve(
        conflict: NoteConflictItem,
        strategy: NoteConflictStrategy,
        personalSnapshot: JSONObject? = null,
        existingPersonalBytes: Long = 0L,
    ): String {
        require(existingPersonalBytes >= 0L) { "个人记录当前字节数无效" }
        val resolved = when (strategy) {
            NoteConflictStrategy.KEEP_LOCAL -> conflict.localNote
            NoteConflictStrategy.ADOPT_REMOTE -> conflict.remoteNote
            NoteConflictStrategy.MERGE_BOTH -> formatMergedBoth(conflict)
        }
        val noteBytes = resolved.toByteArray(Charsets.UTF_8).size
        if (noteBytes > MAX_NOTE_BYTES) {
            throw AppFailure(
                "capacity",
                "合并后的笔记长度为 $noteBytes 字节，超过单篇 2 MiB 上限；已拒绝截断，本机与云端原笔记均完整保留。"
            )
        }
        if (personalSnapshot != null) {
            val candidate = personalSnapshot.copy()
            val notes = candidate.optJSONObject("notes") ?: JSONObject().also { candidate.put("notes", it) }
            val currentRevision = notes.optJSONObject(conflict.paperId)?.optInt("revision") ?: 0
            require(currentRevision in 0 until Int.MAX_VALUE) { "笔记版本号无效或已达上限" }
            notes.put(
                conflict.paperId,
                JSONObject()
                    .put("text", resolved)
                    .put("revision", currentRevision + 1)
                    .put("updatedAt", MAX_ISO_TIMESTAMP_PLACEHOLDER)
            )
            if (PersonalStore.exceedsWriteCapacity(candidate)) {
                throw AppFailure(
                    "capacity",
                    "合并后个人记录超过 32 MiB 保存上限；已拒绝截断，本机与云端原资料均完整保留。"
                )
            }
        } else if (existingPersonalBytes > 0L) {
            val entryWrapper = "," + JSONObject().put(
                conflict.paperId,
                JSONObject()
                    .put("text", resolved)
                    .put("revision", Int.MAX_VALUE)
                    .put("updatedAt", MAX_ISO_TIMESTAMP_PLACEHOLDER)
            ).toString()
            val entryUpperBoundBytes = entryWrapper.toByteArray(Charsets.UTF_8).size.toLong()
            if (existingPersonalBytes + entryUpperBoundBytes > MAX_PERSONAL_BYTES) {
                throw AppFailure(
                    "capacity",
                    "合并后个人记录将超过 32 MiB 保存上限；已拒绝截断，本机与云端原资料均完整保留。"
                )
            }
        }
        return resolved
    }

    private fun formatMergedBoth(conflict: NoteConflictItem): String {
        val distinctRemotes = LinkedHashMap<String, RemoteNoteCandidate>()
        for (candidate in conflict.allRemoteCandidates()) {
            if (candidate.remoteNote != conflict.localNote) {
                distinctRemotes.putIfAbsent(candidate.remoteNote, candidate)
            }
        }
        if (distinctRemotes.isEmpty()) return conflict.localNote
        val combinedRemoteTail = distinctRemotes.values.joinToString("\n\n") { candidate ->
            "${remoteSectionHeader(candidate.remoteDeviceId, candidate.remoteRevision)}\n${candidate.remoteNote}"
        }
        if (conflict.localNote.startsWith("$LOCAL_SECTION_HEADER\n") && conflict.localNote.endsWith(combinedRemoteTail)) {
            return conflict.localNote
        }
        return buildString(conflict.localNote.length + combinedRemoteTail.length + 48) {
            append(LOCAL_SECTION_HEADER)
            append('\n')
            append(conflict.localNote)
            if (conflict.localNote.isNotEmpty() && !conflict.localNote.endsWith('\n')) {
                append('\n')
            }
            append('\n')
            append(combinedRemoteTail)
        }
    }
}
