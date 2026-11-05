package com.nanless.paperdigest.data

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files

class OfflineIndexTest {
    private fun tempDir(name: String) = Files.createTempDirectory("offline-index-$name-").toRealPath().toFile()
    private fun shaName(value: String) = sha256(value.toByteArray()) + ".json"

    private fun articleEntry(file: File, paperID: String?, hasBody: Boolean) =
        requireNotNull(OfflineIndex.articleEntry(file, paperID, hasBody))

    @Test fun roundTripKeepsArticleAndPointerIdentityWithFileSignatures() {
        val root = tempDir("roundtrip")
        try {
            val articles = root.resolve("articles").also { it.mkdirs() }
            val pointers = root.resolve("pdf-pointers").also { it.mkdirs() }
            val cached = articles.resolve(shaName("https://nanless.github.io/audio-paper-digest-blog/a/"))
            cached.writeText("""{"paperID":"arxiv:1","html":"<p>正文</p>"}""")
            val bodyOnly = articles.resolve("1".repeat(64) + ".json")
            bodyOnly.writeText("""{"paperID":"arxiv:2","html":"","markdown":null}""")
            val pointer = pointers.resolve(shaName("https://arxiv.org/pdf/1.pdf"))
            pointer.writeText("{}")
            val original = root.resolve("orig.pdf").also { it.writeBytes(ByteArray(5) { 1 }) }
            val receipt = JSONObject().put("paperID", "arxiv:1").put("filePath", original.absolutePath)
                .put("bytes", original.length()).put("sha256", sha256(original.readBytes()))
            val snapshot = OfflineIndexSnapshot(
                mapOf(cached.name to articleEntry(cached, "arxiv:1", true), bodyOnly.name to articleEntry(bodyOnly, "arxiv:2", false)),
                mapOf(pointer.name to requireNotNull(OfflineIndex.pdfEntry(pointer, receipt, original))))
            OfflineIndex.write(root.resolve("offline-index.json"), snapshot)
            val read = requireNotNull(OfflineIndex.read(root.resolve("offline-index.json")))
            assertEquals(setOf(cached.name, bodyOnly.name), read.articles.keys)
            assertEquals(setOf(pointer.name), read.pdfPointers.keys)
            assertEquals(false, read.articles.getValue(bodyOnly.name).hasBody)
            assertEquals("arxiv:2", read.articles.getValue(bodyOnly.name).paperID)
            assertEquals(original.absolutePath, read.pdfPointers.getValue(pointer.name).originalPath)
            assertEquals(setOf("arxiv:1"), OfflineIndex.offlineIDs(read, articles, pointers))
        } finally { root.deleteRecursively() }
    }

    @Test fun missingCorruptOversizedAndFutureIndexesAreNeverAccepted() {
        val root = tempDir("unreadable")
        try {
            val file = root.resolve("offline-index.json")
            assertNull(OfflineIndex.read(file))
            file.writeText("{")
            assertNull(OfflineIndex.read(file))
            file.writeText(OfflineIndex.FORMAT)
            assertNull(OfflineIndex.read(file))
            val future = JSONObject().put("format", OfflineIndex.FORMAT).put("version", OfflineIndex.VERSION + 1)
                .put("articles", JSONObject()).put("pdfPointers", JSONObject())
            file.writeText(canonical(future))
            assertNull(OfflineIndex.read(file))
            val extra = JSONObject().put("format", OfflineIndex.FORMAT).put("version", OfflineIndex.VERSION)
                .put("articles", JSONObject()).put("pdfPointers", JSONObject()).put("unexpected", 1)
            file.writeText(canonical(extra))
            assertNull(OfflineIndex.read(file))
        } finally { root.deleteRecursively() }
    }

    @Test fun validationRejectsChangedExtraAndMissingArticleEntries() {
        val root = tempDir("articles")
        try {
            val articles = root.resolve("articles").also { it.mkdirs() }
            val pointers = root.resolve("pdf-pointers").also { it.mkdirs() }
            val cached = articles.resolve(shaName("paper-one")); cached.writeText("第一版正文")
            val snapshot = OfflineIndexSnapshot(mapOf(cached.name to articleEntry(cached, "arxiv:1", true)), emptyMap())
            assertEquals(setOf("arxiv:1"), OfflineIndex.offlineIDs(snapshot, articles, pointers))
            // Size and modification time are both part of the entry; changing either invalidates the whole index.
            cached.writeText("第一版正文加上更多内容")
            assertNull(OfflineIndex.offlineIDs(snapshot, articles, pointers))
            cached.writeText("第一版正文")
            cached.setLastModified(cached.lastModified() - 5_000)
            assertNull(OfflineIndex.offlineIDs(snapshot, articles, pointers))
            val rebuilt = OfflineIndexSnapshot(mapOf(cached.name to articleEntry(cached, "arxiv:1", true)), emptyMap())
            assertEquals(setOf("arxiv:1"), OfflineIndex.offlineIDs(rebuilt, articles, pointers))
            // Adding a file that the index does not cover must force a scan, not silently hide it.
            val extra = articles.resolve("2".repeat(64) + ".json").also { it.writeText("另一篇正文") }
            assertNull(OfflineIndex.offlineIDs(rebuilt, articles, pointers))
            extra.delete()
            assertEquals(setOf("arxiv:1"), OfflineIndex.offlineIDs(rebuilt, articles, pointers))
            // Removing an indexed file is equally a mismatch.
            cached.delete()
            assertNull(OfflineIndex.offlineIDs(rebuilt, articles, pointers))
        } finally { root.deleteRecursively() }
    }

    @Test fun validationRequiresThePointerAndItsOriginalToStayExact() {
        val root = tempDir("pointers")
        try {
            val articles = root.resolve("articles")
            val pointers = root.resolve("pdf-pointers").also { it.mkdirs() }
            val original = root.resolve("orig.pdf").also { it.writeBytes(ByteArray(8) { 2 }) }
            val originalModified = original.lastModified()
            val pointer = pointers.resolve(shaName("https://arxiv.org/pdf/2.pdf")); pointer.writeText("pointer")
            val receipt = JSONObject().put("paperID", "arxiv:2").put("filePath", original.absolutePath)
                .put("bytes", original.length()).put("sha256", sha256(original.readBytes()))
            val snapshot = OfflineIndexSnapshot(emptyMap(), mapOf(pointer.name to requireNotNull(OfflineIndex.pdfEntry(pointer, receipt, original))))
            assertEquals(setOf("arxiv:2"), OfflineIndex.offlineIDs(snapshot, articles, pointers))
            original.writeBytes(ByteArray(9) { 2 })
            assertNull(OfflineIndex.offlineIDs(snapshot, articles, pointers))
            original.writeBytes(ByteArray(8) { 2 }); original.setLastModified(originalModified)
            assertEquals(setOf("arxiv:2"), OfflineIndex.offlineIDs(snapshot, articles, pointers))
            original.setLastModified(originalModified - 5_000)
            assertNull(OfflineIndex.offlineIDs(snapshot, articles, pointers))
            original.delete()
            assertNull(OfflineIndex.offlineIDs(snapshot, articles, pointers))
        } finally { root.deleteRecursively() }
    }

    @Test fun fallbackArticleScanCoversUnreadableCachesAndRebuildsAValidIndex() {
        val root = tempDir("scan-articles")
        try {
            val articles = root.resolve("articles").also { it.mkdirs() }
            val pointers = root.resolve("pdf-pointers") // deliberately absent, matching an unused cache
            val article = Article("arxiv:9", "<p>正文</p>", "正文", "https://arxiv.org/abs/9",
                "https://nanless.github.io/audio-paper-digest-blog/posts/9/", sha256("revision".toByteArray()), "2026-01-01T00:00:00Z")
            articles.resolve(shaName("paper-nine")).writeText(canonical(article.json()))
            articles.resolve("f".repeat(64) + ".json").writeText("not json")
            val (entries, ids) = OfflineIndex.scanArticles(articles)
            assertEquals(setOf(shaName("paper-nine"), "f".repeat(64) + ".json"), entries.keys)
            assertEquals(setOf("arxiv:9"), ids)
            assertNull(entries.getValue("f".repeat(64) + ".json").paperID)
            // Coverage of the unreadable file keeps the rebuilt snapshot immediately trustworthy.
            assertEquals(setOf("arxiv:9"), OfflineIndex.offlineIDs(OfflineIndexSnapshot(entries, emptyMap()), articles, pointers))
        } finally { root.deleteRecursively() }
    }

    @Test fun fallbackPointerScanUsesTheVerifiedOriginalAndSkipsBrokenPointers() {
        val root = tempDir("scan-pointers")
        try {
            val pointers = root.resolve("pdf-pointers").also { it.mkdirs() }
            val original = root.resolve("orig.pdf").also { it.writeBytes(ByteArray(4) { 3 }) }
            val pointer = pointers.resolve(shaName("https://arxiv.org/pdf/3.pdf"))
            pointer.writeText(canonical(JSONObject().put("paperID", "arxiv:3").put("filePath", original.absolutePath)
                .put("bytes", original.length()).put("sha256", sha256(original.readBytes()))))
            val broken = pointers.resolve("e".repeat(64) + ".json").also { it.writeText("not json") }
            val (entries, ids) = OfflineIndex.scanPointers(pointers) { receipt ->
                File(receipt.getString("filePath")).takeIf { it.isFile && it.length() == receipt.getLong("bytes") }
            }
            assertEquals(setOf(pointer.name, broken.name), entries.keys)
            assertEquals(setOf("arxiv:3"), ids)
            // A broken pointer stays as a negative entry so the next start does not rescan forever.
            assertEquals(setOf("arxiv:3"), OfflineIndex.offlineIDs(OfflineIndexSnapshot(emptyMap(), entries), root.resolve("articles"), pointers))
            broken.delete()
            assertNull(OfflineIndex.offlineIDs(OfflineIndexSnapshot(emptyMap(), entries), root.resolve("articles"), pointers))
        } finally { root.deleteRecursively() }
    }

    @Test fun emptyDirectoriesAreAValidEmptyIndexAndWriteIsAtomic() {
        val root = tempDir("empty")
        try {
            val snapshot = OfflineIndexSnapshot(emptyMap(), emptyMap())
            val file = root.resolve("offline-index.json")
            OfflineIndex.write(file, snapshot)
            assertTrue(file.isFile)
            assertFalse(root.listFiles()!!.any { it.name.endsWith(".tmp") })
            val read = requireNotNull(OfflineIndex.read(file))
            assertEquals(emptySet<String>(), OfflineIndex.offlineIDs(read, root.resolve("articles"), root.resolve("pdf-pointers")))
            assertTrue(canonical(JSONObject(file.readText())).isNotEmpty())
            // Replacing it never leaves the previous generation readable as a partial document.
            OfflineIndex.write(file, snapshot)
            assertNotNull(OfflineIndex.read(file))
        } finally { root.deleteRecursively() }
    }
}
