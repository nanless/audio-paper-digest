package com.nanless.paperdigest.data

import org.jsoup.Jsoup
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

class ArticleImageAccessTest {
    private val png = java.util.Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==")
    private fun article(html: String, resources: List<ArticleResource>) = Article("p1", html, "图文", "https://example.org/paper", "https://example.org/post/", "a".repeat(64), "2026-11-03T00:00:00Z", resources = resources)
    @Test fun readingStreamsOnlyBoundImageAndDoesNotSerializeItsRouteOrExpandBytes() {
        val root = Files.createTempDirectory("article-image-").toRealPath().toFile()
        try {
            val file = root.resolve("original.png").apply { writeBytes(png) }
            val url = "https://example.org/figure.png"
            val original = article("<figure><img src='$url' srcset='https://tracker.invalid/x 2x' alt='原图'><figcaption>原图注</figcaption></figure>", listOf(ArticleResource(url, localPath = file.absolutePath, sha256 = sha256(png))))
            val before = original.json().toString()
            val access = ArticleImageAccess(original, root)
            val doc = Jsoup.parseBodyFragment(access.bodyHTML); val source = doc.selectFirst("img")!!.attr("src")
            assertTrue(source.startsWith(access.cspImageSource)); assertFalse(access.bodyHTML.contains("base64")); assertEquals("原图注", doc.select("figcaption").text())
            assertFalse(doc.selectFirst("img")!!.hasAttr("srcset")); assertEquals("lazy", doc.selectFirst("img")!!.attr("loading"))
            val response = access.open(source, false, "GET")!!
            assertEquals("image/png", response.first); response.second.use { assertArrayEquals(png, it.readBytes()) }
            assertNull(access.open(source, true, "GET")); assertNull(access.open(source, false, "POST"))
            assertNull(access.open(source + "?x=1", false, "GET")); assertNull(access.open("https://example.org/figure.png", false, "GET"))
            assertNull(ArticleImageAccess(original, root).open(source, false, "GET"))
            assertEquals(before, original.copy(displayImages = access).json().toString())
            val held = access.open(source, false, "GET")!!.second
            val replacement = root.resolve("replacement.png").apply { writeBytes(png + byteArrayOf(1, 2, 3)) }
            Files.move(replacement.toPath(), file.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING)
            held.use { assertArrayEquals("Already verified handle never follows a replaced path", png, it.readBytes()) }
            file.appendText("changed")
            assertThrows(IllegalArgumentException::class.java) { access.open(source, false, "GET") }
        } finally { root.deleteRecursively() }
    }
    @Test fun missingConflictingOrExternalMaterialNeverCreatesAnImageRoute() {
        val root = Files.createTempDirectory("article-missing-").toRealPath().toFile()
        try {
            val file = root.resolve("pic.png").apply { writeBytes(png) }; val url = "https://example.org/f.png"
            val resource = ArticleResource(url, localPath = file.absolutePath, sha256 = sha256(png))
            for (resources in listOf(emptyList(), listOf(resource, resource.copy(sha256 = "b".repeat(64))), listOf(resource.copy(missingReason = "未核验")))) {
                val access = ArticleImageAccess(article("<img src='$url' alt='图片名'><p>正文与原图注</p>", resources), root)
                assertTrue(Jsoup.parseBodyFragment(access.bodyHTML).select("img").isEmpty()); assertTrue(access.bodyHTML.contains("正文与原图注")); assertTrue(access.bodyHTML.contains("图片名"))
            }
            val outside = Files.createTempFile("article-outside-", ".png").toRealPath().toFile()
            try {
                outside.writeBytes(png)
                val access = ArticleImageAccess(article("<img src='$url'>", listOf(resource.copy(localPath = outside.absolutePath))), root)
                assertThrows(IllegalArgumentException::class.java) { access.open(Jsoup.parseBodyFragment(access.bodyHTML).selectFirst("img")!!.attr("src"), false, "GET") }
            } finally { outside.delete() }
        } finally { root.deleteRecursively() }
    }
    @Test fun legacyEmbeddedImageRequiresExactOriginalHashBeforeUsingFile() {
        val root = Files.createTempDirectory("article-legacy-").toRealPath().toFile()
        try {
            val file = root.resolve("pic.png").apply { writeBytes(png) }; val uri = "data:image/png;base64," + java.util.Base64.getEncoder().encodeToString(png)
            val resource = ArticleResource("https://example.org/old.png", localPath = file.absolutePath, sha256 = sha256(png))
            val access = ArticleImageAccess(article("<img src='$uri'>", listOf(resource)), root)
            assertFalse(access.bodyHTML.contains("base64")); assertEquals(1, Jsoup.parseBodyFragment(access.bodyHTML).select("img").size)
            assertTrue(Jsoup.parseBodyFragment(ArticleImageAccess(article("<img src='$uri'>", listOf(resource.copy(sha256 = "b".repeat(64)))), root).bodyHTML).select("img").isEmpty())
        } finally { root.deleteRecursively() }
    }
}
