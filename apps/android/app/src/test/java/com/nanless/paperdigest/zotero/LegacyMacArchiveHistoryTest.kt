package com.nanless.paperdigest.zotero

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.UUID

class LegacyMacArchiveHistoryTest {
    private fun root() = Files.createTempDirectory("mac-archive-history-").toRealPath().toFile()
    private val roles = listOf("bibliography", "source-metadata", "pdf", "guide", "analysis", "note")
    private fun journal(id: String = UUID.randomUUID().toString()): JSONObject = JSONObject()
        .put("id", id).put("serverID", "local-zotero-instance-only").put("fingerprint", "a".repeat(64))
        .put("parentKey", "ABCDEFGH").put("collectionKey", "23456789")
        .put("materialSHA256", JSONObject().put("pdf", "b".repeat(64)).put("guide", "c".repeat(64)))
        .put("request", JSONObject().put("identity", "arxiv:2610.27491").put("analysisHTML", "private analysis content")
            .put("noteHTML", "private note content").put("bibliography", JSONObject().put("title", "MiCLA published paper")))
        .put("steps", JSONArray(roles.map { JSONObject().put("role", it).put("key", "ABCDEFGH").put("verified", true) }))
    private fun write(root: File, value: JSONObject): File = File(root, "zotero-archives/${value.getString("id")}.json")
        .also { it.parentFile.mkdirs(); it.writeText(value.toString()) }
    private fun records(root: File) = LegacyMacArchiveHistory.read(root).getJSONArray("records")

    @Test fun absentDirectoryIsEmptyAndReadNeverCreatesIt() {
        val root = root()
        try { assertEquals(0, records(root).length()); assertFalse(File(root, "zotero-archives").exists()) }
        finally { root.deleteRecursively() }
    }
    @Test fun completeRecordKeepsAllSixOriginalKeysButNeverGrantsCurrentVerificationOrResume() {
        val root = root()
        try {
            val file = write(root, journal()); val before = file.readBytes(); val row = records(root).getJSONObject(0)
            assertEquals("complete", row.getString("reportedStatus")); assertEquals(6, row.getJSONArray("steps").length())
            assertEquals("source-metadata", row.getJSONArray("steps").getJSONObject(1).getString("role"))
            assertTrue(row.getBoolean("readOnly")); assertFalse(row.getBoolean("canResume")); assertFalse(row.getBoolean("currentRemoteVerified"))
            assertEquals("ABCDEFGH", row.getString("originalParentKey")); assertEquals("b".repeat(64), row.getJSONObject("originalMaterialSHA256").getString("pdf"))
            assertEquals("23456789", row.getString("originalCollectionKey"))
            assertFalse(row.has("serverID")); assertFalse(row.has("journalID")); assertFalse(row.toString().contains("private analysis content")); assertFalse(row.toString().contains("private note content"))
            assertArrayEquals(before, file.readBytes())
        } finally { root.deleteRecursively() }
    }
    @Test fun partialRecordRetainsReportedFailureWithoutInventingAnErrorOrChangingBytes() {
        val root = root()
        try {
            val j = journal(); j.getJSONArray("steps").getJSONObject(5).put("verified", false).put("error", "credential-looking private exception")
            val file = write(root, j); val before = file.readBytes(); val row = records(root).getJSONObject(0)
            assertEquals("partial", row.getString("reportedStatus")); assertFalse(row.getJSONArray("steps").getJSONObject(5).getBoolean("reportedVerified"))
            assertFalse(row.toString().contains("credential-looking")); assertArrayEquals(before, file.readBytes())
        } finally { root.deleteRecursively() }
    }
    @Test fun wrongIDDuplicateRoleAndMissingParentRemainExplicitlyUnreadable() {
        val root = root()
        try {
            val wrong = journal(); val f = write(root, wrong); wrong.put("id", UUID.randomUUID().toString()); f.writeText(wrong.toString())
            val duplicate = journal(); duplicate.getJSONArray("steps").getJSONObject(5).put("role", "pdf"); write(root, duplicate)
            val missing = journal(); missing.remove("parentKey"); write(root, missing)
            val result = LegacyMacArchiveHistory.read(root); assertEquals(0, result.getJSONArray("records").length()); assertEquals(3, result.getInt("unreadableCount"))
        } finally { root.deleteRecursively() }
    }
    @Test fun summaryRequiresSameOriginalRecordAndNeverOverridesJournalState() {
        val root = root()
        try {
            val j = journal(); write(root, j)
            val summary = JSONObject().put("archiveID", j.getString("id")).put("serverID", j.getString("serverID"))
                .put("identity", "arxiv:2610.27491").put("title", "MiCLA published paper").put("status", "complete").put("parentKey", "ABCDEFGH").put("updatedAt", 123.5)
            val file = File(root, "zotero-archives/${j.getString("id")}.summary.json"); file.writeText(summary.toString())
            assertEquals(123.5, records(root).getJSONObject(0).getDouble("originalUpdatedAt"), 0.0)
            summary.put("serverID", "another-instance"); file.writeText(summary.toString())
            val row = records(root).getJSONObject(0); assertTrue(row.getBoolean("summaryUnavailable")); assertFalse(row.has("originalUpdatedAt")); assertEquals("complete", row.getString("reportedStatus"))
        } finally { root.deleteRecursively() }
    }
    @Test fun directoryLinkAndJournalLinkNeverReadOrModifyOutsideMaterials() {
        val root = root(); val outside = root()
        try {
            val j = journal(); val outsideFile = write(outside, j); val before = outsideFile.readBytes()
            Files.createSymbolicLink(File(root, "zotero-archives").toPath(), outsideFile.parentFile.toPath())
            assertEquals(1, LegacyMacArchiveHistory.read(root).getInt("unreadableCount")); assertEquals(0, records(root).length())
            Files.delete(File(root, "zotero-archives").toPath()); File(root, "zotero-archives").mkdir()
            Files.createSymbolicLink(File(root, "zotero-archives/${j.getString("id")}.json").toPath(), outsideFile.toPath())
            assertEquals(1, LegacyMacArchiveHistory.read(root).getInt("unreadableCount")); assertEquals(0, records(root).length()); assertArrayEquals(before, outsideFile.readBytes())
        } finally { File(root, "zotero-archives").takeIf { Files.isSymbolicLink(it.toPath()) }?.delete(); root.deleteRecursively(); outside.deleteRecursively() }
    }
    @Test fun malformedAndNonMacRecordsHaveVisibleCountAndOriginalsRemain() {
        val root = root()
        try {
            val dir = File(root, "zotero-archives").also { it.mkdir() }
            val a = File(dir, "${UUID.randomUUID()}.json").also { it.writeText("{truncated") }
            val b = File(dir, "${UUID.randomUUID()}.json").also { it.writeText("{\"contract\":\"paperdigest-zotero-web-v1\"}") }
            val result = LegacyMacArchiveHistory.read(root); assertEquals(2, result.getInt("unreadableCount")); assertEquals(0, result.getJSONArray("records").length())
            assertEquals("{truncated", a.readText()); assertTrue(b.exists())
        } finally { root.deleteRecursively() }
    }
}
