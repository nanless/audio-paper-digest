package com.nanless.paperdigest.data

import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files

class CachedGuideSearchTest {
    private val paper = Paper("arxiv:fixture", "Original title", blogURL = "https://nanless.github.io/audio-paper-digest-blog/posts/fixture/")
    private fun fixture(body: suspend (File) -> Unit) = runBlocking {
        val root = Files.createTempDirectory("cached-guide-search-").toRealPath().toFile()
        try { body(root) } finally { root.deleteRecursively() }
    }
    private fun file(root: File, p: Paper = paper) = File(root, sha256(p.blogURL.toByteArray()) + ".json")
    private fun document(text: String, p: Paper = paper) = JSONObject().put("paperID", p.id).put("blogURL", p.blogURL)
        .put("revisionSHA256", "a".repeat(64)).put("plainText", text).put("html", "<p>HTML-only unindexed-keyword</p>")
    private suspend fun find(root: File, query: String, papers: List<Paper> = listOf(paper)) = CachedGuideSearch(root).search(query, papers)
    private fun fingerprint(file: File): String {
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input -> val buffer = ByteArray(32768); while (true) { val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) } }
        return digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
    }

    @Test fun decodedTextIncludesChineseEscapesCaseAndBufferBoundary() = fixture { root ->
        val value = document("x".repeat(32767) + "中\n国 CASE study \\ \"引句\"")
        file(root).writeText(value.toString().replace("中国", "\\u4e2d\\u56fd"))
        for (query in listOf("中\n国", "case STUDY", "\\ \"引句\"")) {
            val result = find(root, query)
            assertEquals(listOf(paper.id), result.getJSONArray("paperIDs").strings())
            assertEquals(1, result.getInt("scannedArticles")); assertEquals(0, result.getInt("unavailableArticles"))
        }
        assertEquals(0, find(root, "unindexed-keyword").getJSONArray("paperIDs").length())
    }

    @Test fun largeImageValueIsSkippedWithoutMaterializingOrSearchingIt() = fixture { root ->
        file(root).bufferedWriter().use { writer ->
            writer.write("{\"paperID\":" + JSONObject.quote(paper.id) + ",\"blogURL\":" + JSONObject.quote(paper.blogURL) + ",\"revisionSHA256\":\"" + "a".repeat(64) + "\",\"html\":\"<img src='data:image/png;base64,")
            repeat(2048) { writer.write("A".repeat(8192)) }
            writer.write("'>\",\"plainText\":\"真实残差对齐与边界匹配\"}")
        }
        val before = fingerprint(file(root))
        assertEquals(1, find(root, "残差对齐").getJSONArray("paperIDs").length())
        assertEquals(0, find(root, "AAAA").getJSONArray("paperIDs").length())
        assertEquals(before, fingerprint(file(root)))
    }

    @Test fun malformedOrUnboundFilesAreReportedWithoutHidingOtherMatches() = fixture { root ->
        file(root).writeText(document("known match").toString())
        val second = paper.copy(id = "arxiv:second", blogURL = paper.blogURL + "second/")
        file(root, second).writeText(document("known match", second).toString().dropLast(1))
        File(root, "not-a-source.json").writeText(document("known match").toString())
        File(root, "unrelated.bin").writeText("known match")
        val result = find(root, "known", listOf(paper, second))
        assertEquals(listOf(paper.id), result.getJSONArray("paperIDs").strings())
        assertEquals(1, result.getInt("scannedArticles")); assertEquals(2, result.getInt("unavailableArticles"))
    }

    @Test fun strictJsonRejectsDuplicateFieldsTrailingBytesInvalidNumbersAndInvalidUtf8() = fixture { root ->
        val normal = document("match").toString()
        val variants = listOf(
            normal.dropLast(1) + ",\"plainText\":\"match\"}",
            normal + "{}",
            normal.dropLast(1) + ",\"extra\":01}",
            normal.dropLast(1) + ",\"extra\":1.}",
            normal.dropLast(1) + ",\"extra\":1e+}",
            normal.replace("match", "bad\\qmatch"),
            normal.replace("\"plainText\":\"match\"", "\"plainText\":null"),
            normal.replace("a".repeat(64), "wrong")
        )
        for (value in variants) {
            file(root).writeText(value)
            val result = find(root, "match")
            assertEquals(value, 0, result.getJSONArray("paperIDs").length()); assertEquals(1, result.getInt("unavailableArticles"))
        }
        file(root).writeBytes(normal.toByteArray() + byteArrayOf(0xc3.toByte(), 0x28))
        assertEquals(1, find(root, "match").getInt("unavailableArticles"))
    }

    @Test fun identityAndCurrentBlogMustMatchBeforeAnySearchHitIsReturned() = fixture { root ->
        for (value in listOf(document("match").put("paperID", "different"), document("match").put("blogURL", "https://example.invalid/"))) {
            file(root).writeText(value.toString())
            assertEquals(0, find(root, "match").getJSONArray("paperIDs").length())
            assertEquals(1, find(root, "match").getInt("unavailableArticles"))
        }
    }

    @Test fun cancellationDoesNotWriteOrDeleteSavedGuide() = fixture { root ->
        file(root).bufferedWriter().use { writer ->
            writer.write(document("original").toString().dropLast(1) + ",\"padding\":\"")
            repeat(4096) { writer.write("A".repeat(8192)) }; writer.write("\"}")
        }
        val length = file(root).length(); val stamp = file(root).lastModified()
        coroutineScope { val job = launch { find(root, "absent") }; delay(5); job.cancelAndJoin(); assertTrue(job.isCancelled) }
        assertEquals(length, file(root).length()); assertEquals(stamp, file(root).lastModified())
        assertEquals(1, root.listFiles()!!.size)
    }

    @Test fun emptySearchDoesNotInspectCorruptCacheAndLongQueryDoesNotMutateIt() = fixture { root ->
        file(root).writeText("not json")
        assertEquals(0, find(root, "  ").getInt("unavailableArticles"))
        assertTrue(runCatching { find(root, "x".repeat(257)) }.isFailure)
        assertEquals("not json", file(root).readText())
    }

    @Test fun escapedRootKeysAndAllJsonValueKindsRemainReadable() = fixture { root ->
        val value = document("match").put("unselected", org.json.JSONArray().put(JSONObject.NULL).put(true).put(false).put(-0.5e10).put(JSONObject().put("nested", "match")))
        file(root).writeText(value.toString().replace("plainText", "plain\\u0054ext"))
        assertEquals(1, find(root, "match").getJSONArray("paperIDs").length())
    }
}
