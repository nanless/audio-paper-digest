package com.nanless.paperdigest

import android.os.Looper
import androidx.test.platform.app.InstrumentationRegistry
import com.nanless.paperdigest.data.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.attribute.BasicFileAttributes

/** Native filesystem diagnostics against exact public fixtures; not UI acceptance or live HTTP. */
class PublishedCitationDirectoryIdentityInstrumentedTest {
    @Test fun delayedNormalCallbacksAndCrossSecondMkdirKeepAllThreeOriginalsUsable() = runBlocking(Dispatchers.IO) {
        fixture(delayCallbacks = true) { f ->
            val rootSecond = f.root.lastModified() / 1000
            val article = f.bound()
            assertTrue("The delayed page callback must cross a root mkdir timestamp second",
                f.root.lastModified() / 1000 > rootSecond)
            for (format in PublishedCitationRepository.Format.entries) {
                val source = f.source(format)
                val expected = f.responses.getValue(source)
                val original = f.repo.original(f.paper, article, format)
                assertArrayEquals(expected, original.bytes)
                assertEquals(sha256(expected), original.sha256)
                assertEquals(source, original.sourceURL)
                assertEquals(format.filename, original.filename)
                assertEquals(format.mime, original.mime)
                val metadata = original.metadata()
                assertEquals(source, metadata.getString("sourceURL"))
                assertEquals(expected.size, metadata.getInt("bytes"))
                assertFalse(metadata.getBoolean("bundleHashVerified"))
                assertTrue(metadata.has("publishedSHA256") && metadata.isNull("publishedSHA256"))
                val binding = metadata.getJSONObject("binding")
                assertEquals(f.paper.id, binding.getJSONObject("paper").getString("id"))
                assertEquals(article.revisionSHA256, binding.getString("articleRevisionSHA256"))
                assertEquals(f.paper.blogURL, binding.getString("pageURL"))
                assertEquals(sha256(f.responses.getValue(f.paper.blogURL)), binding.getString("pageSHA256"))
                assertArrayEquals(expected, f.repo.original(f.paper, article, format, offline = true).bytes)
            }
            assertEquals(listOf(f.paper.blogURL) + PublishedCitationRepository.Format.entries.map(f::source), f.calls)
        }
        Unit // JUnit4 requires a void method, not a coroutine result object.
    }

    @Test fun identicalFilesInRecreatedLogicalRootCannotBeAdoptedByTheLiveOldRepository() = runBlocking(Dispatchers.IO) {
        fixture { f ->
            val article = f.bound()
            val original = f.repo.original(f.paper, article, PublishedCitationRepository.Format.BIBTEX)
            val before = snapshot(f.root)
            val calls = f.calls.toList()
            val oldKey = fileKey(f.root)
            val retired = File(f.owner, "RetainedCitationOriginals")
            f.requireOwned(f.root)
            f.requireOwned(retired)
            assertFalse(Files.exists(retired.toPath(), NOFOLLOW_LINKS))
            Files.move(f.root.toPath(), retired.toPath()) // Keep the original inode and live repository pin.
            assertTrue(f.root.mkdir())
            copyTree(retired, f.root)
            assertNotEquals(oldKey, fileKey(f.root))
            assertSnapshot(before, f.root)
            assertIdentityRejected(f, article)
            assertEquals("Identity rejection must precede any transport callback", calls, f.calls)
            assertSnapshot(before, retired)
            assertArrayEquals(original.bytes, File(retired, "raw/${original.sha256}.bib").readBytes())
        }
        Unit
    }

    @Test fun symlinkedOwnedAncestorIsRejectedEvenWhenTheActualRootFileKeyIsUnchanged() = runBlocking(Dispatchers.IO) {
        fixture { f ->
            val article = f.bound()
            val original = f.repo.original(f.paper, article, PublishedCitationRepository.Format.BIBTEX)
            val before = snapshot(f.root)
            val calls = f.calls.toList()
            val oldKey = fileKey(f.root)
            val retainedOwner = File(f.top, "RetainedOwner")
            f.requireOwned(f.owner)
            f.requireOwned(retainedOwner)
            assertFalse(Files.exists(retainedOwner.toPath(), NOFOLLOW_LINKS))
            Files.move(f.owner.toPath(), retainedOwner.toPath())
            f.requireOwned(f.owner) // The now-absent destination still resolves inside our fixture.
            f.requireOwned(retainedOwner)
            Files.createSymbolicLink(f.owner.toPath(), retainedOwner.toPath())
            val retainedRoot = File(retainedOwner, "Research/CitationOriginals")
            assertTrue(Files.isSymbolicLink(f.owner.toPath()))
            assertEquals(retainedRoot.canonicalFile, f.root.canonicalFile)
            assertEquals("This negative must keep the actual root inode", oldKey, fileKey(f.root))
            assertIdentityRejected(f, article)
            assertEquals("Path rejection must precede any transport callback", calls, f.calls)
            assertSnapshot(before, retainedRoot)
            assertArrayEquals(original.bytes, File(retainedRoot, "raw/${original.sha256}.bib").readBytes())
        }
        Unit
    }

    private suspend fun assertIdentityRejected(f: Fixture, article: Article) {
        val error = runCatching {
            f.repo.original(f.paper, article, PublishedCitationRepository.Format.BIBTEX, offline = true)
        }.exceptionOrNull()
        assertTrue("Expected fixed root-identity failure, got $error", error is IllegalArgumentException)
        assertEquals("引用研究目录身份已变化，未在新目录认领旧保存记录", error!!.message)
    }

    private suspend fun fixture(delayCallbacks: Boolean = false, block: suspend (Fixture) -> Unit) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val cache = instrumentation.targetContext.cacheDir.canonicalFile
        val top = Files.createTempDirectory(cache.toPath(), "published-citation-identity-").toRealPath().toFile()
        try {
            fun asset(name: String): ByteArray {
                require('/' !in name && '\\' !in name && name != "..")
                return instrumentation.context.assets.open("published-citation-v1/$name").use { it.readBytes() }
            }
            val records = JSONObject(PublishedUtf8.decode(asset("public-source-manifest.json"))).getJSONArray("records")
            val row = (0 until records.length()).map { records.getJSONObject(it) }.single { it.getString("kind") == "arxiv-micla" }
            val paper = requireNotNull(CatalogRepository.parsePaper(JSONObject(PublishedUtf8.decode(asset(row.getString("rowFile"))))))
            val responses = linkedMapOf<String, ByteArray>()
            val page = row.getJSONObject("page")
            val sidecars = row.getJSONArray("sidecars")
            for (source in listOf(page) + (0 until sidecars.length()).map { sidecars.getJSONObject(it) }) {
                val raw = asset(source.getString("name"))
                assertEquals(source.getInt("bytes"), raw.size)
                assertEquals(source.getString("sha256"), sha256(raw))
                responses[source.getString("url")] = raw
            }
            assertEquals(page.getString("url"), paper.blogURL)
            block(Fixture(top, paper, responses, delayCallbacks))
        } finally {
            // Never follow the intentional ancestor symlink, even during failure cleanup.
            require(top.absoluteFile == top.canonicalFile && top.parentFile == cache)
            require(top.name.startsWith("published-citation-identity-") && !Files.isSymbolicLink(top.toPath()))
            Files.walkFileTree(top.toPath(), object : SimpleFileVisitor<Path>() {
                private fun scoped(path: Path) {
                    require(path.isAbsolute && path.normalize().startsWith(top.toPath()) && path != cache.toPath())
                }
                override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                    scoped(file); Files.delete(file); return FileVisitResult.CONTINUE
                }
                override fun postVisitDirectory(dir: Path, error: java.io.IOException?): FileVisitResult {
                    if (error != null) throw error
                    scoped(dir); Files.delete(dir); return FileVisitResult.CONTINUE
                }
            })
        }
    }

    private class Fixture(val top: File, val paper: Paper, val responses: Map<String, ByteArray>, delayed: Boolean) {
        val owner = File(top, "Owner").canonicalFile
        val root = File(owner, "Research/CitationOriginals").canonicalFile
        val calls = mutableListOf<String>()
        val repo = PublishedCitationRepository(root) { url, limit ->
            assertNotEquals("Transport must not block Android's main thread", Looper.getMainLooper(), Looper.myLooper())
            calls += url
            if (delayed) Thread.sleep(1200) // Real elapsed time, only inside the production IO callback.
            val raw = responses[url] ?: error("Unexpected request outside exact public fixture: $url")
            require(raw.size <= limit)
            raw.copyOf()
        }
        suspend fun bound(): Article {
            val page = repo.fetchPage(paper)
            return try {
                repo.bindPage(paper, CatalogRepository.extractArticle(page.html, paper, "native-public-fixture"), page)
            } finally { repo.releasePage(page) }
        }
        fun source(format: PublishedCitationRepository.Format) = responses.keys.single { it.endsWith("/${format.filename}") }
        fun requireOwned(file: File) {
            val absolute = file.absoluteFile
            require(absolute == file.canonicalFile && absolute.toPath().normalize().startsWith(top.toPath()))
            require(absolute != top && !Files.isSymbolicLink(absolute.toPath()))
            var ancestor: File? = absolute
            while (ancestor != null) {
                require(!Files.isSymbolicLink(ancestor.toPath()))
                ancestor = ancestor.parentFile
            }
        }
    }

    private fun fileKey(file: File): Any = requireNotNull(
        Files.readAttributes(file.toPath(), BasicFileAttributes::class.java, NOFOLLOW_LINKS).fileKey()
    )

    private fun snapshot(root: File): Map<String, ByteArray> {
        val files = linkedMapOf<String, ByteArray>()
        Files.walkFileTree(root.toPath(), object : SimpleFileVisitor<Path>() {
            override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                require(attrs.isRegularFile && !attrs.isSymbolicLink)
                files[root.toPath().relativize(file).toString()] = Files.readAllBytes(file)
                return FileVisitResult.CONTINUE
            }
        })
        return files
    }

    private fun assertSnapshot(expected: Map<String, ByteArray>, root: File) {
        val actual = snapshot(root)
        assertEquals(expected.keys, actual.keys)
        expected.forEach { (name, bytes) -> assertArrayEquals(name, bytes, actual.getValue(name)) }
    }

    private fun copyTree(source: File, target: File) {
        Files.walkFileTree(source.toPath(), object : SimpleFileVisitor<Path>() {
            override fun preVisitDirectory(dir: Path, attrs: BasicFileAttributes): FileVisitResult {
                require(!attrs.isSymbolicLink)
                Files.createDirectories(target.toPath().resolve(source.toPath().relativize(dir)))
                return FileVisitResult.CONTINUE
            }
            override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                require(attrs.isRegularFile && !attrs.isSymbolicLink)
                Files.copy(file, target.toPath().resolve(source.toPath().relativize(file)))
                return FileVisitResult.CONTINUE
            }
        })
    }
}
