package com.nanless.paperdigest.data

import com.nanless.paperdigest.protocols.ClientProtocols
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.IOException
import java.nio.file.Files

class ResourceBadgesRepositoryTest {
    private fun tempDir(): File = Files.createTempDirectory("resource-badges-test-").toFile()

    private fun validIndexBytes(paperId: String = "arxiv:2611.00001"): ByteArray =
        ClientProtocols.record("paper-resource-badges-index")
            .put("generatedAt", "2026-11-25T06:00:00Z")
            .put(
                "papers",
                JSONObject().put(
                    paperId,
                    JSONObject()
                        .put("hasCode", true)
                        .put("hasModel", false)
                        .put("hasDataset", false)
                        .put("hasDemo", false)
                        .put("hasProjectPage", true)
                        .put("codeUrls", JSONArray().put("https://github.com/nanless/example"))
                        .put("projectUrls", JSONArray().put("https://example.org/project")),
                ),
            )
            .toString()
            .toByteArray(Charsets.UTF_8)

    private fun seedLocalAudioDemos(libraryDir: File) {
        val articlesDir = File(libraryDir, "articles").apply { mkdirs() }
        File(articlesDir, "demo-1.json").writeText(
            JSONObject()
                .put("paperID", "arxiv:2611.00004")
                .put("html", "<div class='audio-spec-quick-card'><a class='audio-demo-cta-btn' href='https://demo.example'>Demo</a></div>")
                .toString(),
        )
        val desktopArticlesDir = File(libraryDir, "desktop-details/articles").apply { mkdirs() }
        val desktopPapersDir = File(libraryDir, "desktop-details/papers").apply { mkdirs() }
        val articleSha = "a".repeat(64)
        File(desktopArticlesDir, "$articleSha.html").writeText(
            "<div class='audio-spec-quick-card'><a class='audio-demo-cta-btn' href='https://demo.example/2'>Demo 2</a></div>",
        )
        // Unverified paper without paperId: appearanceId is relative "posts/unverified-demo/"
        // Must resolve via CatalogRepository.sameSite -> "page:/audio-research-portal/posts/unverified-demo/"
        val detail = JSONObject()
            .put("paperId", JSONObject.NULL)
            .put("appearanceId", "posts/unverified-demo/")
            .put(
                "articleRevision",
                JSONObject().put(
                    "articleDescriptor",
                    JSONObject().put("sha256", articleSha),
                ),
            )
        File(desktopPapersDir, "detail-unverified.json").writeText(detail.toString())
    }

    @Test
    fun unverifiedDesktopDetailUsesCanonicalSameSitePageId() {
        val dir = tempDir()
        try {
            seedLocalAudioDemos(dir)
            val repo = ResourceBadgesRepository(dir)
            val demoIds = repo.scanCachedAudioDemoPaperIds()
            assertTrue("Should include verified article demo ID", "arxiv:2611.00004" in demoIds)
            assertTrue(
                "Unverified desktop detail should resolve to canonical page:/audio-research-portal/posts/unverified-demo/",
                "page:/audio-research-portal/posts/unverified-demo/" in demoIds,
            )
            assertFalse(
                "Must not emit mismatched relative page:posts/... ID",
                "page:posts/unverified-demo/" in demoIds,
            )
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun networkAndTransientHttpFailuresReturnTier1DemosWithoutMarkingLoadedAndPreserveCachedSignals() = runTest {
        val dir = tempDir()
        try {
            seedLocalAudioDemos(dir)
            var calls = 0
            var mode = "ioError"
            val repo = ResourceBadgesRepository(dir) { _, _ ->
                calls++
                when (mode) {
                    "ioError" -> throw IOException("simulated offline network down")
                    "http503" -> HttpBytes(503, emptyMap(), ByteArray(0))
                    "http200" -> HttpBytes(200, emptyMap(), validIndexBytes("arxiv:2611.00001"))
                    "cancel" -> throw CancellationException("cancelled")
                    "bad200" -> HttpBytes(200, emptyMap(), """{"contract":"wrong"}""".toByteArray())
                    else -> HttpBytes(404, emptyMap(), ByteArray(0))
                }
            }

            // 1. Network down: returns Tier 1 cachedDemoIds, does NOT mark loaded
            val offlineResult = repo.load(forceRefresh = false, offlineMode = false)
            assertFalse(offlineResult.available)
            assertTrue(offlineResult.papers.isEmpty())
            assertEquals(
                setOf("arxiv:2611.00004", "page:/audio-research-portal/posts/unverified-demo/"),
                offlineResult.cachedDemoIds,
            )
            assertEquals(1, calls)

            // 2. Transient HTTP 503: still retries because not marked loaded, returns Tier 1 demos
            mode = "http503"
            val http503Result = repo.load(forceRefresh = false, offlineMode = false)
            assertFalse(http503Result.available)
            assertTrue(http503Result.papers.isEmpty())
            assertEquals(
                setOf("arxiv:2611.00004", "page:/audio-research-portal/posts/unverified-demo/"),
                http503Result.cachedDemoIds,
            )
            assertEquals(2, calls)

            // 3. Network recovers (HTTP 200): non-forced load retries and caches Tier 2 signals
            mode = "http200"
            val okResult = repo.load(forceRefresh = false, offlineMode = false)
            assertTrue(okResult.available)
            assertTrue(okResult.papers["arxiv:2611.00001"]?.hasCode == true)
            assertEquals(
                setOf("arxiv:2611.00004", "page:/audio-research-portal/posts/unverified-demo/"),
                okResult.cachedDemoIds,
            )
            assertEquals(3, calls)

            // 4. Subsequent forced refresh fails with IOException -> preserves prior cachedSignals AND Tier 1 demos
            mode = "ioError"
            val preservedResult = repo.load(forceRefresh = true, offlineMode = false)
            assertTrue(preservedResult.available)
            assertTrue(preservedResult.papers["arxiv:2611.00001"]?.hasCode == true)
            assertEquals(
                setOf("arxiv:2611.00004", "page:/audio-research-portal/posts/unverified-demo/"),
                preservedResult.cachedDemoIds,
            )

            // 5. CancellationException is always rethrown (never swallowed)
            mode = "cancel"
            try {
                repo.load(forceRefresh = true, offlineMode = false)
                fail("Expected CancellationException to propagate")
            } catch (_: CancellationException) {
            }

            // 6. HTTP 200 corrupt JSON still fails closed
            mode = "bad200"
            try {
                repo.load(forceRefresh = true, offlineMode = false)
                fail("Expected malformed HTTP 200 index to fail closed")
            } catch (_: IllegalArgumentException) {
            }
        } finally {
            dir.deleteRecursively()
        }
    }
}
