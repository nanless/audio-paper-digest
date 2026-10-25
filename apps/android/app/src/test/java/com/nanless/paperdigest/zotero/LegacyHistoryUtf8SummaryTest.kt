package com.nanless.paperdigest.zotero

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.UUID

class LegacyHistoryUtf8SummaryTest {
    @Test fun validReplacementCharacterStaysValidButMalformedSummaryIsNotReplacedAndAdopted() {
        val root = Files.createTempDirectory("mac-history-summary-utf8-").toRealPath().toFile()
        try {
            val id = UUID.randomUUID().toString(); val title = "Original \uFFFD title"
            val journal = JSONObject().put("id", id).put("serverID", "local-instance").put("fingerprint", "a".repeat(64))
                .put("parentKey", "ABCDEFGH").put("request", JSONObject().put("identity", "synthetic:source").put("bibliography", JSONObject().put("title", title)))
                .put("steps", JSONArray().put(JSONObject().put("role", "bibliography").put("key", "ABCDEFGH").put("verified", true)))
            val directory = File(root, "zotero-archives").also { it.mkdir() }
            val file = File(directory, "$id.json").also { it.writeText(journal.toString()) }
            val summary = JSONObject().put("archiveID", id).put("serverID", "local-instance").put("identity", "synthetic:source")
                .put("title", title).put("parentKey", "ABCDEFGH").put("status", "complete").put("updatedAt", 123.5)
            val summaryFile = File(directory, "$id.summary.json").also { it.writeText(summary.toString()) }
            val good = LegacyMacArchiveHistory.read(root).getJSONArray("records").getJSONObject(0)
            assertEquals(title, good.getString("title")); assertEquals(123.5, good.getDouble("originalUpdatedAt"), 0.0)
            val before = file.readBytes(); val raw = summaryFile.readBytes()
            val i = raw.indices.first { it + 2 < raw.size && raw[it] == 0xef.toByte() && raw[it + 1] == 0xbf.toByte() && raw[it + 2] == 0xbd.toByte() }
            val malformed = raw.copyOfRange(0, i) + byteArrayOf(0xff.toByte()) + raw.copyOfRange(i + 3, raw.size)
            summaryFile.writeBytes(malformed)
            val row = LegacyMacArchiveHistory.read(root).getJSONArray("records").getJSONObject(0)
            assertEquals(title, row.getString("title")); assertTrue(row.getBoolean("summaryUnavailable")); assertFalse(row.has("originalUpdatedAt"))
            assertArrayEquals(before, file.readBytes()); assertArrayEquals(malformed, summaryFile.readBytes())
        } finally { root.deleteRecursively() }
    }
}
