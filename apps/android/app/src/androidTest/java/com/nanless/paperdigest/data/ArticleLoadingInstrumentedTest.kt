package com.nanless.paperdigest.data

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.*
import org.jsoup.Jsoup
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

/** Deterministic delayed optional image, exercising the normal parser/cache/citation pipeline. */
class ArticleLoadingInstrumentedTest {
    private val paper = Paper("arxiv:2601.00001", "Synthetic loading fixture", blogURL = CatalogRepository.SITE + "posts/loading-fixture/",
        sourceURL = "https://arxiv.org/abs/2601.00001v1", pdfURL = "https://arxiv.org/pdf/2601.00001v1", sourceVersion = "2601.00001v1", sourceKind = "arxiv")
    private val imageURL = CatalogRepository.SITE + "images/loading.png"
    private val page get() = "<html><body><div id='article-body' class='post-content'><h1>立即可读的正文</h1><p>原始段落与公式 \\(x+1\\)</p><figure><img src='$imageURL' alt='原图'><figcaption>保留原图注</figcaption></figure></div></body></html>".toByteArray()
    private val png = java.util.Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==")
    @Test fun bodyIsPublishedAndSavedBeforeDelayedImageThenImagesStayStreamed() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>(); val directory = Files.createTempDirectory(context.cacheDir.toPath(), "article-loading-").toRealPath().toFile()
        try {
            val personal = PersonalStore(directory); val body = CompletableDeferred<Article>(); val requested = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
            val repo = CatalogRepository(context, personal) { url, _ -> when (url) {
                paper.blogURL -> page
                imageURL -> { requested.complete(Unit); release.await(); png }
                else -> error("Unexpected fixture request")
            } }
            val loading = async { repo.article(paper, onReadable = { body.complete(it) }) }
            val early = withTimeout(10_000) { body.await() }; withTimeout(10_000) { requested.await() }
            assertFalse(loading.isCompleted); assertTrue(early.html.contains("立即可读的正文")); assertFalse(early.completeOffline); assertNotNull(early.displayImages)
            assertTrue(Jsoup.parseBodyFragment(early.displayImages!!.bodyHTML).select("img").isEmpty()); assertTrue(early.inlineImages.isEmpty())
            val saved = directory.resolve("PublishedLibrary/articles/${sha256(paper.blogURL.toByteArray())}.json")
            assertTrue(saved.isFile); assertTrue(saved.readText().contains("立即可读的正文")); assertFalse(saved.readText().contains("data:image/"))
            release.complete(Unit); val complete = withTimeout(10_000) { loading.await() }
            assertTrue(complete.completeOffline); assertTrue(complete.inlineImages.isEmpty()); assertFalse(complete.html.contains("data:image/")); assertFalse(saved.readText().contains("data:image/"))
            val display = requireNotNull(complete.displayImages); val source = Jsoup.parseBodyFragment(display.bodyHTML).selectFirst("img")!!.attr("src")
            display.open(source, false, "GET")!!.second.use { assertArrayEquals(png, it.readBytes()) }
            val original = repo.prepareOfflineArticle(complete)
            assertTrue("Explicit exports still receive verified inline material", original.inlineImages[imageURL]!!.startsWith("data:image/png;base64,"))
            assertNull(original.displayImages)
            val exported = com.nanless.paperdigest.ui.ResearchRenderer.renderArticle(context, original)
            assertFalse(exported.contains("reader.invalid")); assertTrue(exported.contains("data:image/png;base64,"))
        } finally { directory.deleteRecursively() }
    }
    @Test fun cancelledOptionalImagesKeepSavedTextForTheNextOfflineRead() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>(); val directory = Files.createTempDirectory(context.cacheDir.toPath(), "article-cancel-").toRealPath().toFile()
        try {
            val personal = PersonalStore(directory); val ready = CompletableDeferred<Unit>()
            val repo = CatalogRepository(context, personal) { url, _ -> if (url == paper.blogURL) page else awaitCancellation() }
            val task = launch { repo.article(paper, onReadable = { ready.complete(Unit) }) }
            withTimeout(10_000) { ready.await() }; task.cancelAndJoin(); personal.updateSettings(org.json.JSONObject().put("offlineMode", true))
            val offline = repo.article(paper)
            assertTrue(offline.isStale); assertTrue(offline.html.contains("立即可读的正文")); assertFalse(offline.completeOffline); assertTrue(offline.inlineImages.isEmpty())
        } finally { directory.deleteRecursively() }
    }
    @Test fun zeroImagePartialDoesNotMasqueradeAsAFinishedCacheAfterCancellation() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>(); val directory = Files.createTempDirectory(context.cacheDir.toPath(), "article-zero-image-").toRealPath().toFile()
        try {
            val personal = PersonalStore(directory); val held = CompletableDeferred<Unit>(); var pause = true; var sidecarReads = 0
            val sidecar = CatalogRepository.SITE + "data/papers/loading-fixture/citation.json"
            val html = "<a href='$sidecar'>引用原件</a><div id='article-body' class='post-content'><p>零图正文</p></div>".toByteArray()
            val repo = CatalogRepository(context, personal) { url, _ -> when (url) {
                paper.blogURL -> html
                sidecar -> { sidecarReads++; held.complete(Unit); if (pause) awaitCancellation() else error("Synthetic optional sidecar unavailable") }
                else -> error("Unexpected fixture request")
            } }
            val first = launch { repo.article(paper) }; withTimeout(10_000) { held.await() }; first.cancelAndJoin()
            pause = false
            val resumed = withTimeout(10_000) { repo.article(paper) }
            assertEquals(2, sidecarReads); assertTrue(resumed.completeOffline); assertTrue(resumed.html.contains("零图正文"))
        } finally { directory.deleteRecursively() }
    }
}
