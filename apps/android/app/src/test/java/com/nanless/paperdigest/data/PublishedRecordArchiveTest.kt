package com.nanless.paperdigest.data

import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files

class PublishedRecordArchiveTest {
    private val base = CatalogRepository.SITE
    private fun row(page: String, version: String = "2610.12345v1") = JSONObject().put("pageType", "paper").put("permalink", page)
        .put("arxivId", version).put("identityStatus", "verified").put("sourceKind", "arxiv").put("originalTitle", "Original scientific title")
        .put("citation", JSONObject().put("arxivId", version).put("sourceUrl", "https://arxiv.org/abs/$version").put("pdfUrl", "https://arxiv.org/pdf/$version.pdf").put("authors", JSONArray(listOf("Original Author"))))
        .put("tagCatalogSha256", "f".repeat(64)).put("primaryTaskId", "task.audio-classification").put("unknownFuture", JSONObject().put("nested", JSONArray(listOf("retain", 42))))
    private class Fixture(val rows: List<JSONObject>) {
        val root = Files.createTempDirectory("published-record-archive-").toRealPath().toFile()
        val shards = rows.mapIndexed { i, row ->
            val raw = JSONArray().put(row).toString().toByteArray(); val hash = sha256(raw)
            JsonFiles.write(File(root, "index/$hash.json"), raw)
            JSONObject().put("url", "search-index/part-${i.toString().padStart(4, '0')}-${hash.take(12)}.json").put("sha256", hash).put("bytes", raw.size).put("recordCount", 1)
        }
        val manifest = JSONObject().put("contract", "paper-search-index-manifest-v1").put("shards", JSONArray(shards)).put("recordCount", rows.size).put("totalBytes", shards.sumOf { it.getInt("bytes") })
        val rawManifest = manifest.toString().toByteArray()
        val snapshot = sha256(rawManifest)
        init { JsonFiles.write(File(root, "index-manifests/$snapshot.json"), rawManifest) }
        fun paper(primary: Int = 0) = CatalogRepository.parsePaper(rows[primary])!!.copy(appearances = rows.map { CatalogRepository.sameSite(it.getString("permalink")) }, original = JSONObject().put("publishedSnapshotID", snapshot))
        suspend fun read(p: Paper = paper()) = PublishedRecordArchive(root).read(p)
        fun close() { root.deleteRecursively() }
    }
    @Test fun allAppearancesPreserveUnknownOriginalFieldsAndManifestBytes() = runBlocking {
        val f = Fixture(listOf(row(base + "posts/first/"), row(base + "posts/second/", "2610.12345v2")))
        try {
            val result = f.read(f.paper(1)); assertEquals("verified-local-originals", result.getString("status"))
            assertArrayEquals(f.rawManifest, java.util.Base64.getDecoder().decode(result.getString("manifestRawBase64")))
            val records = result.getJSONArray("records"); assertEquals(2, records.length())
            for (i in 0 until records.length()) { assertEquals(canonical(f.rows[i]), canonical(records.getJSONObject(i).getJSONObject("record"))); assertEquals(0, records.getJSONObject(i).getInt("rowIndex")) }
            assertTrue(records.getJSONObject(1).getJSONObject("record").has("unknownFuture"))
        } finally { f.close() }
    }
    @Test fun missingOrChangedShardCannotBeArchivedAsVerified() = runBlocking {
        for (remove in listOf(false, true)) {
            val f = Fixture(listOf(row(base + "posts/first/")))
            try { val file = File(f.root, "index/${f.shards[0].getString("sha256")}.json"); if (remove) file.delete() else file.appendText(" "); assertTrue(runCatching { f.read() }.isFailure) } finally { f.close() }
        }
    }
    @Test fun manifestBytesAndCompleteMemberSetMustRemainBound() = runBlocking {
        val f = Fixture(listOf(row(base + "posts/first/")))
        try {
            assertTrue(runCatching { f.read(f.paper().copy(appearances = listOf(base + "posts/first/", base + "posts/missing/"))) }.isFailure)
            val original = File(f.root, "index-manifests/${f.snapshot}.json"); original.appendText(" ")
            assertTrue(runCatching { f.read() }.isFailure)
        } finally { f.close() }
    }
    @Test fun anotherPaperOrAnotherSourceVersionCannotBorrowValidSourceFiles() = runBlocking {
        val f = Fixture(listOf(row(base + "posts/first/")))
        try {
            assertTrue(runCatching { f.read(f.paper().copy(id = "arxiv:2610.99999")) }.isFailure)
            assertTrue(runCatching { f.read(f.paper().copy(sourceVersion = "2610.12345v2")) }.isFailure)
            assertTrue(runCatching { f.read(f.paper().copy(citation = JSONObject().put("forged", true))) }.isFailure)
        } finally { f.close() }
    }
    @Test fun relativePermalinksAreBoundByTheSameCanonicalWebsiteRules() = runBlocking {
        val f = Fixture(listOf(row("posts/first/")))
        try { assertEquals(1, f.read().getJSONArray("records").length()) } finally { f.close() }
    }
    @Test fun legacyUnboundPaperIsHonestUnavailableWithoutInventingSource() = runBlocking {
        val root = Files.createTempFile("archive-not-directory-", ".txt").toFile()
        try { val result = PublishedRecordArchive(root).read(Paper("old", "Original")); assertEquals("unavailable", result.getString("status")); assertFalse(result.has("records")) } finally { root.delete() }
    }
    @Test fun validLargeLegacyIndexIsRetainedAsLegacyRatherThanMisreadAsShardedManifest() = runBlocking {
        val root = Files.createTempDirectory("legacy-index-archive-").toRealPath().toFile()
        try {
            val raw = JSONArray().put(row(base + "posts/legacy/").put("legacyUnknown", "x".repeat(2 * 1024 * 1024))).toString().toByteArray()
            val hash = sha256(raw); val source = File(root, "index-manifests/$hash.json"); JsonFiles.write(source, raw)
            val paper = CatalogRepository.parsePaper(row(base + "posts/legacy/"))!!.copy(original = JSONObject().put("legacyPublishedIndexSHA256", hash).put("legacyPublishedIndexBytes", raw.size))
            val result = PublishedRecordArchive(root).read(paper)
            assertEquals("unavailable", result.getString("status")); assertEquals(hash, result.getString("legacyOriginalSHA256")); assertEquals(raw.size.toLong(), result.getLong("legacyOriginalBytes")); assertArrayEquals(raw, source.readBytes())
            source.appendText(" ")
            assertTrue(runCatching { PublishedRecordArchive(root).read(paper) }.isFailure)
        } finally { root.deleteRecursively() }
    }
}
