package com.nanless.paperdigest.offline

import com.nanless.paperdigest.cloud.BackupCodec
import com.nanless.paperdigest.data.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.Base64

class OfflineStoreTest {
    private fun fixtures() = javaClass.classLoader!!.getResourceAsStream("offline-swift-vectors.json")!!.use { JSONObject(it.readBytes().toString(Charsets.UTF_8)) }
    private fun temp(body: (File) -> Unit) { val dir = Files.createTempDirectory("offline-swift-contract-").toRealPath().toFile(); try { body(dir) } finally { dir.deleteRecursively() } }
    private fun unpack(root: File, packet: JSONObject): File {
        val folder = File(root, "Offline/${packet.getString("id")}").apply { mkdirs() }
        packet.getJSONArray("files").objects().forEach { e -> val bytes = Base64.getDecoder().decode(e.getString("data")); assertEquals(e.getString("sha256"), BackupCodec.hash(bytes)); BackupCodec.atomicBytes(File(folder, e.getString("path")), bytes) }
        return folder
    }
    @Test fun actualFoundationUTF8AndBinaryFloatVectorsMatchExactly() {
        for (vector in fixtures().getJSONArray("foundationVectors").objects()) {
            val expected = vector.getString("expectedUTF8").toByteArray(); assertEquals(vector.getString("sha256"), BackupCodec.hash(expected))
            val parsed = OfflineFoundationJSON.parse(vector.optString("inputUTF8", vector.getString("expectedUTF8")).toByteArray()); assertArrayEquals(expected, OfflineFoundationJSON.encode(parsed))
        }
    }
    @Test fun actualMacV1AndV2PacketsOpenAndKeepAllOriginalBytes() = temp { root ->
        val store = OfflineStore(root)
        fixtures().getJSONArray("packets").objects().forEach { packet ->
            assertTrue(packet.getBoolean("actualMacVerificationPassed")); val folder = unpack(root, packet); val before = folder.walkTopDown().filter { it.isFile }.associate { it.relativeTo(folder).invariantSeparatorsPath to it.readBytes() }
            val result = store.open(packet.getString("id")); assertEquals("fixture:paper", result.paper.id); if (packet.optBoolean("hasPDF")) assertEquals(result.paper.pdfSHA256, BackupCodec.hash(result.pdfFile!!)) else assertNull(result.pdfFile); assertTrue(result.article.notices.any { it.contains("不代表网站最新") })
            if (packet.optBoolean("hasImages")) { assertEquals(1, result.article.resources.size); assertTrue(result.article.html.contains("data:image/png;base64,")) }
            before.forEach { (name, bytes) -> assertArrayEquals(bytes, File(folder, name).readBytes()) }
        }
        assertEquals(4, store.list().count { it.getString("status") == "verified" })
    }
    @Test fun changedScientificJSONFailsEvenAfterUpdatingOnlyItsFileSHA() = temp { root ->
        val packet = fixtures().getJSONArray("packets").getJSONObject(1); val folder = unpack(root, packet)
        val articleFile = File(folder, "article.json"); val article = OfflineFoundationJSON.parse(articleFile.readBytes()).put("plainText", "forged different scientific claim")
        BackupCodec.atomicBytes(articleFile, OfflineFoundationJSON.encode(article))
        val manifest = JSONObject(File(folder, "manifest.json").readText()); manifest.getJSONArray("files").objects().first { it.getString("role") == "article" }.put("bytes", articleFile.length()).put("sha256", BackupCodec.hash(articleFile)); BackupCodec.atomicJSON(File(folder, "manifest.json"), manifest)
        assertThrows(IllegalArgumentException::class.java) { OfflineStore(root).open(packet.getString("id")) }
        assertEquals("corrupt", OfflineStore(root).list().single().getString("status"))
    }
    @Test fun manifestSizesMustBeJSONIntegersNotStringsOrFractions() = temp { root ->
        val packet = fixtures().getJSONArray("packets").getJSONObject(1); val folder = unpack(root, packet); val original = File(folder, "manifest.json").readBytes()
        for (fraction in listOf(false, true)) {
            val manifest = JSONObject(original.toString(Charsets.UTF_8)); val row = manifest.getJSONArray("files").getJSONObject(0); val size = row.getLong("bytes")
            row.put("bytes", if (fraction) size + 0.5 else size.toString()); BackupCodec.atomicJSON(File(folder, "manifest.json"), manifest)
            assertThrows(IllegalArgumentException::class.java) { OfflineStore(root).open(packet.getString("id")) }
        }
    }
    @Test fun unlistedFilesAndFutureContractsFailWithoutDeletingOriginals() = temp { root ->
        val packet = fixtures().getJSONArray("packets").getJSONObject(0); val folder = unpack(root, packet); File(folder, "unlisted.bin").writeBytes(byteArrayOf(1))
        assertThrows(IllegalArgumentException::class.java) { OfflineStore(root).open(packet.getString("id")) }; assertTrue(File(folder, "unlisted.bin").exists())
        File(folder, "unlisted.bin").delete(); val manifest = JSONObject(File(folder, "manifest.json").readText()).put("contract", "paperdigest-offline-package-v99"); BackupCodec.atomicJSON(File(folder, "manifest.json"), manifest)
        assertThrows(IllegalArgumentException::class.java) { OfflineStore(root).open(packet.getString("id")) }
    }
    @Test fun registerRequiresRealMatchingCacheAndRoundTripsAsMacV2() = temp { root ->
        val packet = fixtures().getJSONArray("packets").getJSONObject(1); val fileMap = packet.getJSONArray("files").objects().associate { it.getString("path") to Base64.getDecoder().decode(it.getString("data")) }
        val paper = Paper.fromJson(OfflineFoundationJSON.parse(fileMap.getValue("paper.json"))); val rawArticle = OfflineFoundationJSON.parse(fileMap.getValue("article.json")); val article = Article.fromJson(rawArticle)
        val store = OfflineStore(root)
        assertThrows(IllegalArgumentException::class.java) { store.register(paper, article) }
        val cache = File(root, "PublishedLibrary/articles/${BackupCodec.hash(paper.blogURL.toByteArray())}.json"); BackupCodec.atomicBytes(cache, fileMap.getValue("article.json"))
        val result = store.register(paper, article); assertFalse(result.getBoolean("reused")); val opened = store.open(result.getString("id")); assertEquals(paper.id, opened.paper.id)
        assertTrue(store.register(paper, article).getBoolean("reused"))
        val different = article.copy(plainText = "not actual cache", original = null)
        assertThrows(IllegalArgumentException::class.java) { store.register(paper, different) }
    }
    @Test fun legacyHTMLWarningAndMarkdownStayInDisplayProjection() = temp { root ->
        // This third packet was genuinely registered and opened by the original
        // Mac reader without a MathML contract. Its original id is unchanged.
        val packet = fixtures().getJSONArray("packets").getJSONObject(2); val folder = unpack(root, packet)
        val opened = OfflineStore(root).open(packet.getString("id")); assertNull(opened.article.mathMLContract); assertTrue(opened.article.notices.any { it.contains("旧离线HTML") })
        assertTrue(opened.articleJSON.getBoolean("offlineMode")); assertEquals("not-checked", opened.articleJSON.getString("websiteFreshness")); assertTrue(folder.isDirectory)
    }
}
