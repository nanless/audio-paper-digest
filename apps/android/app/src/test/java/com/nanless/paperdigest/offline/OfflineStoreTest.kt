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
    @Test fun singlePaperPackageSupportsUpTo64ScientificImages() = temp { root ->
        val tinyPng = Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==")
        val paper = Paper(
            id = "conference:icml:2026:many-figs",
            title = "Many Figures Conference Paper",
            titleZh = "多图会议论文",
            authors = listOf("Alice"),
            date = "2026-11-26",
            score = 8.4,
            tags = listOf("speech"),
            sourceKind = "conference",
            identityStatus = "verified",
            blogURL = CatalogRepository.SITE + "posts/many-figs/",
            sourceURL = "https://proceedings.iclr.cc/paper_files/paper/2026/file/many-figs.pdf",
            pdfURL = null,
            sourceVersion = "ICML 2026",
            citation = JSONObject().put("title", "Many Figures Conference Paper"),
        )
        val imgDir = File(root, "PublishedLibrary/images").apply { mkdirs() }
        val resources = (1..36).map { i ->
            val imgBytes = tinyPng.copyOf()
            val file = File(imgDir, "fig-$i.png").apply { writeBytes(imgBytes) }
            ArticleResource(
                sourceURL = "https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main/icml-2026/0123456789ab/fig-$i.png",
                localPath = file.absolutePath,
                sha256 = BackupCodec.hash(imgBytes),
            )
        }
        val html = "<div id='article-body'>" + resources.mapIndexed { idx, res -> "<img data-resource='${res.sourceURL}' alt='Fig ${idx + 1}'/>" }.joinToString("") + "</div>"
        val rawArticle = Article(
            paperID = paper.id,
            html = html,
            plainText = "多图会议论文正文",
            sourceURL = paper.sourceURL!!,
            blogURL = paper.blogURL,
            revisionSHA256 = BackupCodec.hash(html.toByteArray()),
            fetchedAt = "2026-11-26T00:00:00Z",
            sourceVersion = paper.sourceVersion,
            completeOffline = true,
            resources = resources,
        ).json()
        val cache = File(root, "PublishedLibrary/articles/${BackupCodec.hash(paper.blogURL.toByteArray())}.json")
        BackupCodec.atomicBytes(cache, OfflineFoundationJSON.encode(rawArticle))
        val article = Article.fromJson(OfflineFoundationJSON.parse(cache.readBytes()))

        val store = OfflineStore(root)
        val registered = store.register(paper, article)
        val opened = store.open(registered.getString("id"))
        assertEquals(36, opened.article.resources.size)
        assertTrue(opened.article.completeOffline)
    }
}
