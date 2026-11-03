package com.nanless.paperdigest.cloud

import com.nanless.paperdigest.data.PersonalStore
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class PersonalWebDavSyncTest {
    private val mac = "00000000-0000-4000-8000-000000000001"
    private val android = "00000000-0000-4000-8000-000000000002"
    private val a = "arxiv:2601.00001"
    private val b = "arxiv:2601.00002"

    private fun local(vararg ids: String) = JSONObject().put("schema", 1)
        .put("favorites", JSONArray(ids.toList())).put("reading", JSONArray())
        .put("notes", JSONObject()).put("annotations", JSONObject()).put("readingState", JSONObject())
        .put("jobs", JSONArray()).put("sessions", JSONArray()).put("settings", JSONObject().put("endpoint", "local-only"))
    private fun note(root: JSONObject, text: String) {
        root.getJSONObject("notes").put(a, JSONObject().put("revision", 1).put("text", text))
    }

    @Test fun sharedWireFixtureReadsAcrossBothPlatforms() {
        val fixture = JSONObject(File("../../../tests/fixtures/workbench/personal-webdav-sync-v1.json").readText())
        val remote = fixture.keys().asSequence().associateWith { fixture.getJSONObject(it).toString().toByteArray() }
        val result = PersonalWebDavSync.plan(local(), "00000000-0000-4000-8000-000000000003", remote)
        assertNull(result.upload)
        assertEquals(JSONArray(listOf(a)).toString(), result.personal.getJSONArray("favorites").toString())
        assertEquals("跨设备笔记", result.personal.getJSONObject("notes").getJSONObject(a).getString("text"))
        assertEquals(0, result.conflicts)
    }

    @Test fun twoPeersMergeAndRemoveFavoritesAndCarryResearchMetadata() {
        val left = local(a, "local:pdf")
        note(left, "已读方法")
        left.put("reading", JSONArray(listOf(a)))
        left.getJSONObject("annotations").put(a, JSONArray().put(JSONObject().put("id", "highlight")))
        left.getJSONObject("readingState").put(a, JSONObject().put("pdfPage", 4))
        left.put("favoriteCollections", JSONObject("""{"version":1,"revision":0,"folders":[],"items":{"$a":{"addedAt":"2026-11-02T00:00:00.000Z","folderIDs":[]}}}"""))
        val remote = mutableMapOf(mac to PersonalWebDavSync.plan(left, mac, emptyMap()).upload!!)
        val right = PersonalWebDavSync.plan(local(b), android, remote)
        assertEquals(listOf(a, b), (0..1).map { right.personal.getJSONArray("favorites").getString(it) })
        assertEquals("已读方法", right.personal.getJSONObject("notes").getJSONObject(a).getString("text"))
        assertEquals("highlight", right.personal.getJSONObject("annotations").getJSONArray(a).getJSONObject(0).getString("id"))
        assertEquals(4, right.personal.getJSONObject("readingState").getJSONObject(a).getInt("pdfPage"))
        assertEquals(a, right.personal.getJSONArray("reading").getString(0))
        assertEquals("2026-11-02T00:00:00.000Z", right.personal.getJSONObject("favoriteCollections").getJSONObject("items").getJSONObject(a).getString("addedAt"))
        assertFalse(String(remote.getValue(mac)).contains("local-only"))
        assertFalse(String(remote.getValue(mac)).contains("local:pdf"))
        remote[android] = right.upload!!
        val pulled = PersonalWebDavSync.plan(left, mac, remote)
        assertNull(pulled.upload)
        assertEquals(3, pulled.personal.getJSONArray("favorites").length())
        pulled.personal.put("favorites", JSONArray(listOf(b, "local:pdf")))
        val removed = PersonalWebDavSync.plan(pulled.personal, mac, remote)
        remote[mac] = removed.upload!!
        val after = PersonalWebDavSync.plan(right.personal, android, remote)
        assertEquals(b, after.personal.getJSONArray("favorites").getString(0))
        assertEquals(1, after.personal.getJSONArray("favorites").length())
        assertNull(after.upload)
        assertThrows(IllegalArgumentException::class.java) { PersonalWebDavSync.plan(after.personal, android, remote - mac) }
    }

    @Test fun earliestUtcTimeWinsAndRewrittenPeerAtSameRevisionFails() {
        fun favorite(date: String) = local(a).put("favoriteCollections", JSONObject(
            """{"version":1,"revision":0,"folders":[],"items":{"$a":{"addedAt":"$date","folderIDs":[]}}}"""
        ))
        val exact = "2026-11-02T00:00:00Z"
        val later = "2026-11-02T00:00:00.000000001Z"
        val exactDoc = PersonalWebDavSync.plan(favorite(exact), mac, emptyMap()).upload!!
        val laterDoc = PersonalWebDavSync.plan(favorite(later), android, emptyMap()).upload!!
        val remote = mapOf(mac to exactDoc, android to laterDoc)
        val dated = PersonalWebDavSync.plan(local(), android, remote)
        assertEquals(exact, dated.personal.getJSONObject("favoriteCollections")
            .getJSONObject("items").getJSONObject(a).getString("addedAt"))
        val rejected = assertThrows(IllegalArgumentException::class.java) {
            PersonalWebDavSync.plan(dated.personal, android, remote + (mac to (exactDoc + byteArrayOf(32))))
        }
        assertTrue(rejected.message.orEmpty().contains("版本未变"))
    }

    @Test fun importedLegacyNoteInvalidatesAnOpenEmptyEditor() {
        val legacy = local()
        legacy.getJSONObject("notes").put(a, JSONObject().put("revision", 0).put("text", "旧版笔记"))
        val uploaded = PersonalWebDavSync.plan(legacy, mac, emptyMap()).upload!!
        val adopted = PersonalWebDavSync.plan(local(), android, mapOf(mac to uploaded))
        assertEquals(1, adopted.personal.getJSONObject("notes").getJSONObject(a).getInt("revision"))
    }

    @Test fun identicalNoteTextWithDifferentRevisionsIsNotAConflict() {
        fun document(device: String, revision: Int) = local().let { root ->
            root.getJSONObject("notes").put(a, JSONObject().put("revision", revision).put("text", "相同正文"))
            PersonalWebDavSync.plan(root, device, emptyMap()).upload!!
        }
        val result = PersonalWebDavSync.plan(local(), android, mapOf(mac to document(mac, 1), android to document(android, 3)))
        assertEquals(0, result.conflicts)
        assertEquals("相同正文", result.personal.getJSONObject("notes").getJSONObject(a).getString("text"))
    }

    @Test fun oldRestoredWorkspaceCannotOverwriteAnUnobservedSameDeviceNote() {
        val current = local().also { note(it, "已同步的新稿") }
        val remote = mapOf(mac to PersonalWebDavSync.plan(current, mac, emptyMap()).upload!!)
        val restored = local().also { note(it, "恢复的旧稿") }
        val failure = assertThrows(IllegalArgumentException::class.java) {
            PersonalWebDavSync.plan(restored, mac, remote)
        }
        assertTrue(failure.message.orEmpty().contains("未确认"))
        assertEquals("恢复的旧稿", restored.getJSONObject("notes").getJSONObject(a).getString("text"))
    }

    @Test fun newWorkspaceCreatesCurrentCollectionAndKeepsItOnTheNextSync() {
        val current = PersonalStore.initial().put("favorites", JSONArray(listOf(a)))
        val first = PersonalWebDavSync.plan(current, android, emptyMap())
        val metadata = first.personal.getJSONObject("favoriteCollections")
        assertTrue(metadata.has("contract"))
        assertFalse(metadata.has("version"))
        val repeated = PersonalWebDavSync.plan(first.personal, android, mapOf(android to first.upload!!))
        assertNull(repeated.upload)
        assertEquals(a, repeated.personal.getJSONArray("favorites").getString(0))
    }

    @Test fun independentlyEditedNotesStayOnBothPeersUntilAUserEditsAfterSeeingTheConflict() {
        val first = PersonalWebDavSync.plan(local(a).also { note(it, "原文") }, mac, emptyMap())
        val common = mapOf(mac to first.upload!!)
        val other = PersonalWebDavSync.plan(local(), android, common)
        note(first.personal, "Mac 编辑")
        note(other.personal, "Android 编辑")
        val left = PersonalWebDavSync.plan(first.personal, mac, common)
        val right = PersonalWebDavSync.plan(other.personal, android, common)
        val remote = mapOf(mac to left.upload!!, android to right.upload!!)
        val conflicted = PersonalWebDavSync.plan(left.personal, mac, remote)
        assertEquals(1, conflicted.conflicts)
        assertEquals("Mac 编辑", conflicted.personal.getJSONObject("notes").getJSONObject(a).getString("text"))
        assertEquals("Android 编辑", PersonalWebDavSync.plan(right.personal, android, remote)
            .personal.getJSONObject("notes").getJSONObject(a).getString("text"))
        note(conflicted.personal, "合并稿")
        val resolved = PersonalWebDavSync.plan(conflicted.personal, mac, remote)
        val adopted = PersonalWebDavSync.plan(right.personal, android, remote + (mac to resolved.upload!!))
        assertEquals(0, adopted.conflicts)
        assertEquals("合并稿", adopted.personal.getJSONObject("notes").getJSONObject(a).getString("text"))
    }
}
