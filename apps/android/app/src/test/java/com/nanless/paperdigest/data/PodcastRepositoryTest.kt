package com.nanless.paperdigest.data

import com.nanless.paperdigest.protocols.ClientProtocols
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class PodcastRepositoryTest {
    @get:Rule val temp = TemporaryFolder()

    private fun makeMp3(seed: Int, size: Int = 256): ByteArray {
        val bytes = ByteArray(size)
        // Valid ID3v2.3 header (10 bytes) + valid MPEG-1 Layer III frame header
        val header = byteArrayOf(0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xFF.toByte(), 0xFB.toByte(), 0x90.toByte(), 0x00)
        header.copyInto(bytes)
        for (i in header.size until size) {
            bytes[i] = ((seed + i) and 0xFF).toByte()
        }
        return bytes
    }

    private fun episodeJson(
        id: String,
        date: String,
        title: String,
        audioUrl: String,
        bytes: ByteArray,
        shaOverride: String? = null,
        bytesOverride: Int? = null,
    ): JSONObject = JSONObject().apply {
        put("id", id)
        put("date", date)
        put("title", title)
        put("summary", "测试音频播客摘要")
        put("audioUrl", audioUrl)
        put("bytes", bytesOverride ?: bytes.size)
        put("sha256", shaOverride ?: PodcastRepository.sha256Hex(bytes))
        put("durationSeconds", 360.0)
        put("mimeType", "audio/mpeg")
        put("chapters", JSONArray().apply {
            put(JSONObject().put("title", "开场").put("startSeconds", 0).put("endSeconds", 60))
            put(JSONObject().put("title", "精选论文").put("startSeconds", 60).put("endSeconds", 240).put("paperId", "arxiv:2611.00001"))
        })
        put("paperIds", JSONArray(listOf("arxiv:2611.00001")))
    }

    private fun makeFeedBytes(vararg episodes: JSONObject): ByteArray {
        val fields = JSONObject()
            .put("generatedAt", "2026-11-24T06:00:00Z")
            .put("episodes", JSONArray(episodes.toList()))
        return ClientProtocols.record("paper-daily-podcast-feed", fields).toString().toByteArray(Charsets.UTF_8)
    }

    @Test
    fun strictReleaseUrlAndRedirectAndMp3MagicValidation() {
        val mainRepo = "https://github.com/nanless/audio-paper-digest/releases/download/podcast-2026-11-24/daily-2026-11-24.mp3"
        val blogRepo = "https://github.com/nanless/audio-paper-digest-blog/releases/download/v1.5.0/ep01.mp3"
        assertTrue(PodcastRepository.isValidInitialAudioUrl(mainRepo))
        assertTrue(PodcastRepository.isValidInitialAudioUrl(blogRepo))

        val badInitials = listOf(
            "http://github.com/nanless/audio-paper-digest/releases/download/v1/ep.mp3",
            "https://github.com/other/audio-paper-digest/releases/download/v1/ep.mp3",
            "https://github.com/nanless/other-repo/releases/download/v1/ep.mp3",
            "https://github.com/nanless/audio-paper-digest/releases/download/v1/ep.wav",
            "https://github.com/nanless/audio-paper-digest/releases/download/v1/ep.mp3?token=1",
            "https://github.com/nanless/audio-paper-digest/releases/download/v1/ep.mp3#frag",
            "https://github.com/nanless/audio-paper-digest/releases/download/v1/%2e%2e/ep.mp3",
            "https://objects.githubusercontent.com/nanless/ep.mp3",
        )
        badInitials.forEach { assertFalse("must reject $it", PodcastRepository.isValidInitialAudioUrl(it)) }

        assertTrue(PodcastRepository.isValidRedirectAudioUrl("https://release-assets.githubusercontent.com/asset/123?sig=ok"))
        assertTrue(PodcastRepository.isValidRedirectAudioUrl("https://objects.githubusercontent.com/asset/123?sig=ok"))
        assertTrue(PodcastRepository.isValidRedirectAudioUrl(blogRepo))
        assertFalse(PodcastRepository.isValidRedirectAudioUrl("https://evil.example/a.mp3"))
        assertFalse(PodcastRepository.isValidRedirectAudioUrl("https://raw.githubusercontent.com/nanless/a.mp3"))
        assertFalse(PodcastRepository.isValidRedirectAudioUrl("http://objects.githubusercontent.com/a.mp3"))

        assertTrue(PodcastRepository.isValidMp3Magic(makeMp3(1)))
        assertTrue(PodcastRepository.isValidMp3Magic(byteArrayOf(0xFF.toByte(), 0xFB.toByte(), 0x90.toByte(), 0x00, 0x11)))
        assertFalse(PodcastRepository.isValidMp3Magic("<html>not audio</html>".toByteArray()))
        assertFalse(PodcastRepository.isValidMp3Magic("{\"error\":true}".toByteArray()))
        assertFalse(PodcastRepository.isValidMp3Magic("%PDF-1.7\n".toByteArray()))
        assertFalse(PodcastRepository.isValidMp3Magic(byteArrayOf(0xFF.toByte(), 0xE1.toByte(), 0xFF.toByte(), 0xFF.toByte())))
    }

    @Test
    fun feed404And410AreSilentGracefulAnd200FailsClosed() = runBlocking {
        var feedStatus = 404
        var feedBody = "Not Found".toByteArray()
        val repo = PodcastRepository(
            cacheDir = temp.newFolder("podcast-feed-test"),
            feedTransport = { _, _ -> HttpBytes(feedStatus, emptyMap(), feedBody) },
        )

        val res404 = repo.fetchFeed(forceRefresh = true)
        assertFalse(res404.available)
        assertNull(res404.feed)

        feedStatus = 410
        val res410 = repo.fetchFeed(forceRefresh = true)
        assertFalse(res410.available)
        assertNull(res410.feed)

        // HTTP 200 corrupt JSON -> fail closed
        feedStatus = 200
        feedBody = "not-json".toByteArray()
        assertTrue(runCatching { repo.fetchFeed(forceRefresh = true) }.isFailure)

        // HTTP 200 wrong schemaFingerprint -> fail closed
        val badFp = ClientProtocols.recordHeader("paper-daily-podcast-feed", "paper-daily-podcast-feed")
            .put("schemaFingerprint", "0".repeat(64))
            .put("generatedAt", "2026-11-24T06:00:00Z")
            .put("episodes", JSONArray())
        feedBody = badFp.toString().toByteArray()
        assertTrue(runCatching { repo.fetchFeed(forceRefresh = true) }.isFailure)

        // HTTP 200 > 40 MiB declared bytes -> fail closed
        val mp3 = makeMp3(7, 512)
        val url = "https://github.com/nanless/audio-paper-digest/releases/download/v1.5/ep.mp3"
        feedBody = makeFeedBytes(episodeJson("ep-big", "2026-11-24", "Too Big", url, mp3, bytesOverride = PodcastRepository.MAX_AUDIO_BYTES + 1))
        assertTrue(runCatching { repo.fetchFeed(forceRefresh = true) }.isFailure)

        // HTTP 200 valid feed -> succeeds & respects offlineMode cache read
        feedBody = makeFeedBytes(episodeJson("ep-ok", "2026-11-24", "Valid Episode", url, mp3))
        val ok = repo.fetchFeed(forceRefresh = true)
        assertTrue(ok.available)
        assertEquals(1, ok.feed?.episodes?.size)

        // Offline mode serves saved feed without hitting transport
        feedStatus = 500
        val offline = repo.fetchFeed(forceRefresh = true, offlineMode = true)
        assertTrue(offline.available)
        assertTrue(offline.fromCache)
    }

    @Test
    fun downloadVerifiesRedirectsIntegrityAndEnforcesOfflineAndLruCache() = runBlocking {
        val mp3A = makeMp3(10, 400)
        val mp3_5Hops = makeMp3(21, 400)
        val mp3_Evil = makeMp3(22, 400)
        val mp3_BadSha = makeMp3(23, 400)
        val mp3_BadBytes = makeMp3(24, 400)
        val fakeNonMp3 = ByteArray(400) { 0x41 } // valid bytes & sha, invalid MP3 magic

        val hop0 = "https://github.com/nanless/audio-paper-digest/releases/download/v1.5/a.mp3"
        val hop1 = "https://release-assets.githubusercontent.com/h1/a.mp3?s=1"
        val hop2 = "https://objects.githubusercontent.com/h2/a.mp3?s=2"
        val hop3 = "https://objects.githubusercontent.com/h3/a.mp3?s=3"
        val hop4 = "https://release-assets.githubusercontent.com/h4/a.mp3?s=4"

        val url5Hops = "https://github.com/nanless/audio-paper-digest/releases/download/v1.5/5hops.mp3"
        val urlEvil = "https://github.com/nanless/audio-paper-digest/releases/download/v1.5/evil.mp3"
        val urlBadSha = "https://github.com/nanless/audio-paper-digest/releases/download/v1.5/badsha.mp3"
        val urlBadBytes = "https://github.com/nanless/audio-paper-digest/releases/download/v1.5/badbytes.mp3"
        val urlBadMagic = "https://github.com/nanless/audio-paper-digest/releases/download/v1.5/badmagic.mp3"

        val responses = mutableMapOf<String, HttpBytes>(
            hop0 to HttpBytes(302, mapOf("Location" to hop1), byteArrayOf()),
            hop1 to HttpBytes(302, mapOf("Location" to hop2), byteArrayOf()),
            hop2 to HttpBytes(307, mapOf("Location" to hop3), byteArrayOf()),
            hop3 to HttpBytes(302, mapOf("Location" to hop4), byteArrayOf()),
            hop4 to HttpBytes(200, emptyMap(), mp3A),
            url5Hops to HttpBytes(302, mapOf("Location" to "https://objects.githubusercontent.com/x1"), byteArrayOf()),
            "https://objects.githubusercontent.com/x1" to HttpBytes(302, mapOf("Location" to "https://objects.githubusercontent.com/x2"), byteArrayOf()),
            "https://objects.githubusercontent.com/x2" to HttpBytes(302, mapOf("Location" to "https://objects.githubusercontent.com/x3"), byteArrayOf()),
            "https://objects.githubusercontent.com/x3" to HttpBytes(302, mapOf("Location" to "https://objects.githubusercontent.com/x4"), byteArrayOf()),
            "https://objects.githubusercontent.com/x4" to HttpBytes(302, mapOf("Location" to "https://objects.githubusercontent.com/x5"), byteArrayOf()),
            "https://objects.githubusercontent.com/x5" to HttpBytes(200, emptyMap(), mp3A),
            urlEvil to HttpBytes(302, mapOf("Location" to "https://evil.example/leak.mp3"), byteArrayOf()),
            urlBadSha to HttpBytes(200, emptyMap(), makeMp3(99, 400)),
            urlBadBytes to HttpBytes(200, emptyMap(), makeMp3(10, 300)),
            urlBadMagic to HttpBytes(200, emptyMap(), fakeNonMp3),
        )

        val feedBytes = makeFeedBytes(
            episodeJson("ep-4hops", "2026-11-24", "4 Hops OK", hop0, mp3A),
            episodeJson("ep-5hops", "2026-11-23", "5 Hops Fail", url5Hops, mp3_5Hops),
            episodeJson("ep-evil", "2026-11-22", "Evil Redirect", urlEvil, mp3_Evil),
            episodeJson("ep-badsha", "2026-11-21", "Bad SHA", urlBadSha, mp3_BadSha),
            episodeJson("ep-badbytes", "2026-11-20", "Bad Bytes", urlBadBytes, mp3_BadBytes),
            episodeJson("ep-badmagic", "2026-11-19", "Bad Magic", urlBadMagic, fakeNonMp3),
        )
        val repo = PodcastRepository(
            cacheDir = temp.newFolder("podcast-download-test"),
            feedTransport = { _, _ -> HttpBytes(200, emptyMap(), feedBytes) },
            audioTransport = { url, _ -> responses[url] ?: HttpBytes(404, emptyMap(), byteArrayOf()) },
        )
        val episodes = repo.fetchFeed(forceRefresh = true).feed!!.episodes.associateBy { it.id }

        // Offline mode refuses uncached download
        assertTrue(runCatching { repo.downloadEpisode(episodes.getValue("ep-4hops"), offlineMode = true) }.isFailure)

        // 4-hop valid chain succeeds
        val cached = repo.downloadEpisode(episodes.getValue("ep-4hops"), offlineMode = false)
        assertTrue(cached.isFile)
        assertArrayEquals(mp3A, cached.readBytes())

        // Offline mode succeeds once cached & verified
        val cachedOffline = repo.downloadEpisode(episodes.getValue("ep-4hops"), offlineMode = true)
        assertEquals(cached.absolutePath, cachedOffline.absolutePath)

        // 5-hop, evil host, bad SHA, bad bytes, bad magic ALL fail closed
        assertTrue(runCatching { repo.downloadEpisode(episodes.getValue("ep-5hops")) }.isFailure)
        assertTrue(runCatching { repo.downloadEpisode(episodes.getValue("ep-evil")) }.isFailure)
        assertTrue(runCatching { repo.downloadEpisode(episodes.getValue("ep-badsha")) }.isFailure)
        assertTrue(runCatching { repo.downloadEpisode(episodes.getValue("ep-badbytes")) }.isFailure)
        assertTrue(runCatching { repo.downloadEpisode(episodes.getValue("ep-badmagic")) }.isFailure)

        // LRU eviction: 5-episode cap & byte cap + clearCache
        val lruAudio = mutableMapOf<String, HttpBytes>()
        val lruEpJson = (1..6).map { idx ->
            val data = makeMp3(idx * 13, 300)
            val url = "https://github.com/nanless/audio-paper-digest-blog/releases/download/v1.5/ep-$idx.mp3"
            lruAudio[url] = HttpBytes(200, emptyMap(), data)
            episodeJson("ep-$idx", "2026-11-%02d".format(idx), "Ep $idx", url, data)
        }
        val lruFeed = makeFeedBytes(*lruEpJson.toTypedArray())
        val lruRepo = PodcastRepository(
            cacheDir = temp.newFolder("podcast-lru-count"),
            feedTransport = { _, _ -> HttpBytes(200, emptyMap(), lruFeed) },
            audioTransport = { url, _ -> lruAudio[url] ?: HttpBytes(404, emptyMap(), byteArrayOf()) },
            maxCacheBytes = PodcastRepository.MAX_CACHE_BYTES,
            maxCachedEpisodes = 5,
        )
        val lruMap = lruRepo.fetchFeed(forceRefresh = true).feed!!.episodes.associateBy { it.id }
        for (idx in 1..6) {
            lruRepo.downloadEpisode(lruMap.getValue("ep-$idx"))
            Thread.sleep(5)
        }
        val cachedIds = lruRepo.cachedEpisodeIds()
        assertEquals(5, cachedIds.size)
        assertFalse(cachedIds.contains("ep-1"))
        assertTrue(cachedIds.contains("ep-6"))

        // Byte budget eviction (650 B fits 2 x 300B, evicts oldest on 3rd)
        val budgetRepo = PodcastRepository(
            cacheDir = temp.newFolder("podcast-lru-budget"),
            feedTransport = { _, _ -> HttpBytes(200, emptyMap(), lruFeed) },
            audioTransport = { url, _ -> lruAudio[url] ?: HttpBytes(404, emptyMap(), byteArrayOf()) },
            maxCacheBytes = 650L,
            maxCachedEpisodes = 5,
        )
        val budgetMap = budgetRepo.fetchFeed(forceRefresh = true).feed!!.episodes.associateBy { it.id }
        for (idx in 1..3) {
            budgetRepo.downloadEpisode(budgetMap.getValue("ep-$idx"))
            Thread.sleep(5)
        }
        assertTrue(budgetRepo.cachedTotalBytes() <= 650L)
        assertEquals(setOf("ep-2", "ep-3"), budgetRepo.cachedEpisodeIds())

        budgetRepo.clearCache()
        assertEquals(0L, budgetRepo.cachedTotalBytes())
        assertTrue(budgetRepo.cachedEpisodeIds().isEmpty())
    }

    @Test
    fun resourceBadges404SilentGraceful200FailClosedAndLocalDemoScan() = runBlocking {
        val libDir = temp.newFolder("published-lib")
        val articlesDir = File(libDir, "articles").also { it.mkdirs() }
        File(articlesDir, "demo.json").writeText(
            JSONObject()
                .put("paperID", "arxiv:2611.00099")
                .put("html", "<div class=\"audio-spec-quick-card\"><a class=\"audio-demo-cta-btn\" href=\"https://demo.example\">试听</a></div>")
                .toString()
        )
        var status = 404
        var body = "Not Found".toByteArray()
        val repo = ResourceBadgesRepository(libDir) { _, _ -> HttpBytes(status, emptyMap(), body) }

        val res404 = repo.load(forceRefresh = true)
        assertFalse(res404.available)
        assertTrue(res404.papers.isEmpty())
        assertEquals(setOf("arxiv:2611.00099"), res404.cachedDemoIds)

        status = 410
        val res410 = repo.load(forceRefresh = true)
        assertFalse(res410.available)

        // Bad schemaFingerprint -> fail closed
        status = 200
        body = ClientProtocols.recordHeader("paper-resource-badges-index", "paper-resource-badges-index")
            .put("schemaFingerprint", "f".repeat(64))
            .put("generatedAt", "2026-11-24T06:00:00Z")
            .put("papers", JSONObject())
            .toString().toByteArray()
        assertTrue(runCatching { repo.load(forceRefresh = true) }.isFailure)

        // Non-HTTPS URL -> fail closed
        val badUrlFields = JSONObject()
            .put("generatedAt", "2026-11-24T06:00:00Z")
            .put("papers", JSONObject().put("arxiv:2611.00001", JSONObject().put("hasCode", true).put("codeUrls", JSONArray(listOf("http://github.com/a/b")))))
        body = ClientProtocols.record("paper-resource-badges-index", badUrlFields).toString().toByteArray()
        assertTrue(runCatching { repo.load(forceRefresh = true) }.isFailure)

        // Valid 200 response succeeds
        val goodFields = JSONObject()
            .put("generatedAt", "2026-11-24T06:00:00Z")
            .put("papers", JSONObject().put(
                "arxiv:2611.00001",
                JSONObject()
                    .put("hasCode", true)
                    .put("hasModel", true)
                    .put("hasDataset", false)
                    .put("hasDemo", true)
                    .put("hasProjectPage", true)
                    .put("codeUrls", JSONArray(listOf("https://github.com/nanless/demo-code")))
            ))
        body = ClientProtocols.record("paper-resource-badges-index", goodFields).toString().toByteArray()
        val res200 = repo.load(forceRefresh = true)
        assertTrue(res200.available)
        assertTrue(res200.papers.getValue("arxiv:2611.00001").hasCode)
        assertTrue(res200.papers.getValue("arxiv:2611.00001").hasProjectPage)
        assertEquals(setOf("arxiv:2611.00099"), res200.cachedDemoIds)
    }

    @Test
    fun regressionNullCoercionStrictSchemaCalendarAndStreamingVerification() = runBlocking {
        val mp3 = makeMp3(42, 512)
        val url = "https://github.com/nanless/audio-paper-digest/releases/download/podcast-2026-11-24/daily-2026-11-24.mp3"

        // P0 #1: Exact buildClientPodcastFeedJson payload with JSONObject.NULL for intro chapter.paperId & episode.summary
        val introChapter = JSONObject()
            .put("title", "今日播客开场")
            .put("startSeconds", 0)
            .put("endSeconds", 45)
            .put("paperId", JSONObject.NULL)
        val paperChapter = JSONObject()
            .put("title", "核心论文精讲")
            .put("startSeconds", 45)
            .put("endSeconds", 240)
            .put("paperId", "2611.10001v1")
        val realProducerEpisode = JSONObject()
            .put("id", "daily-2026-11-24")
            .put("date", "2026-11-24")
            .put("title", "2026-11-24 音频论文速递")
            .put("summary", JSONObject.NULL)
            .put("audioUrl", url)
            .put("bytes", mp3.size)
            .put("sha256", PodcastRepository.sha256Hex(mp3))
            .put("durationSeconds", 360.0)
            .put("mimeType", "audio/mpeg")
            .put("chapters", JSONArray(listOf(introChapter, paperChapter)))
            .put("paperIds", JSONArray(listOf("2611.10001v1")))

        val parsed = PodcastRepository.parseFeed(makeFeedBytes(realProducerEpisode))
        assertEquals(1, parsed.episodes.size)
        val ep = parsed.episodes.first()
        assertEquals("", ep.summary)
        assertNull("JSON null paperId must decode to null, never string \"null\"", ep.chapters[0].paperId)
        assertFalse(ep.chapters[0].json().has("paperId"))
        assertEquals("2611.10001v1", ep.chapters[1].paperId)

        // P0 #1: generatedAt JSONObject.NULL must fail closed in both feed & resource badges
        val nullGenFeed = ClientProtocols.record(
            "paper-daily-podcast-feed",
            JSONObject().put("generatedAt", JSONObject.NULL).put("episodes", JSONArray())
        ).toString().toByteArray(Charsets.UTF_8)
        assertTrue(runCatching { PodcastRepository.parseFeed(nullGenFeed) }.isFailure)

        val nullGenBadges = ClientProtocols.record(
            "paper-resource-badges-index",
            JSONObject().put("generatedAt", JSONObject.NULL).put("papers", JSONObject())
        ).toString().toByteArray(Charsets.UTF_8)
        assertTrue(runCatching { ResourceBadgesRepository.parseIndex(nullGenBadges) }.isFailure)

        // P1 #9: Redirect URL encoded & decoded traversal rejection
        val badRedirects = listOf(
            "https://objects.githubusercontent.com/bucket/%2e%2e/secret.mp3",
            "https://objects.githubusercontent.com/bucket/%2E%2E/secret.mp3",
            "https://release-assets.githubusercontent.com/bucket/%5c/a.mp3",
            "https://release-assets.githubusercontent.com/bucket/%00/a.mp3",
            "https://objects.githubusercontent.com/bucket/../secret.mp3",
        )
        badRedirects.forEach { bad ->
            assertFalse("must reject redirect $bad", PodcastRepository.isValidRedirectAudioUrl(bad))
        }

        // P1 #10: Calendar date validation (reject impossible dates, accept leap year 2024-02-29)
        assertTrue(PodcastRepository.isValidCalendarDate("2024-02-29"))
        assertFalse(PodcastRepository.isValidCalendarDate("2025-02-29"))
        assertFalse(PodcastRepository.isValidCalendarDate("2026-02-30"))
        assertFalse(PodcastRepository.isValidCalendarDate("2026-04-31"))
        assertFalse(PodcastRepository.isValidCalendarDate("2026-13-01"))

        // P1 #10: Strict schema keys, integer bytes, positive duration, audio/mpeg mimeType, string paperIds
        val extraRoot = ClientProtocols.record(
            "paper-daily-podcast-feed",
            JSONObject()
                .put("generatedAt", "2026-11-24T06:00:00Z")
                .put("episodes", JSONArray())
                .put("unexpected", true)
        ).toString().toByteArray(Charsets.UTF_8)
        assertTrue(runCatching { PodcastRepository.parseFeed(extraRoot) }.isFailure)

        val extraEpisode = episodeJson("ep-extra", "2026-11-24", "Extra", url, mp3).put("extraField", 1)
        assertTrue(runCatching { PodcastRepository.parseFeed(makeFeedBytes(extraEpisode)) }.isFailure)

        val floatBytes = episodeJson("ep-float", "2026-11-24", "Float", url, mp3).put("bytes", 512.5)
        assertTrue(runCatching { PodcastRepository.parseFeed(makeFeedBytes(floatBytes)) }.isFailure)

        val zeroDuration = episodeJson("ep-zero", "2026-11-24", "Zero", url, mp3).put("durationSeconds", 0.0)
        assertTrue(runCatching { PodcastRepository.parseFeed(makeFeedBytes(zeroDuration)) }.isFailure)

        val badMime = episodeJson("ep-mime", "2026-11-24", "Mime", url, mp3).put("mimeType", "audio/mp3")
        assertTrue(runCatching { PodcastRepository.parseFeed(makeFeedBytes(badMime)) }.isFailure)

        val badPaperIds = episodeJson("ep-pids", "2026-11-24", "BadPids", url, mp3)
            .put("paperIds", JSONArray().put(JSONObject.NULL))
        assertTrue(runCatching { PodcastRepository.parseFeed(makeFeedBytes(badPaperIds)) }.isFailure)

        val badDateEp = episodeJson("ep-date", "2026-02-30", "BadDate", url, mp3)
        assertTrue(runCatching { PodcastRepository.parseFeed(makeFeedBytes(badDateEp)) }.isFailure)

        // P1 #10 & #11: Resource badges reject undeclared keys & prototype-pollution keys
        for (dangerKey in listOf("__proto__", "constructor", "prototype")) {
            val poison = ClientProtocols.record(
                "paper-resource-badges-index",
                JSONObject()
                    .put("generatedAt", "2026-11-24T06:00:00Z")
                    .put("papers", JSONObject().put(dangerKey, JSONObject().put("hasCode", true)))
            ).toString().toByteArray(Charsets.UTF_8)
            assertTrue("must reject $dangerKey", runCatching { ResourceBadgesRepository.parseIndex(poison) }.isFailure)
        }
        val extraBadgeKey = ClientProtocols.record(
            "paper-resource-badges-index",
            JSONObject()
                .put("generatedAt", "2026-11-24T06:00:00Z")
                .put("papers", JSONObject().put("arxiv:2611.00001", JSONObject().put("hasCode", true).put("bogus", 1)))
        ).toString().toByteArray(Charsets.UTF_8)
        assertTrue(runCatching { ResourceBadgesRepository.parseIndex(extraBadgeKey) }.isFailure)

        // P1 #6: Streaming file verification (size, SHA-256, MP3 magic, symlink)
        val stageDir = temp.newFolder("stream-verify")
        val validFile = File(stageDir, "valid.mp3").apply { writeBytes(mp3) }
        PodcastRepository.streamVerifyAudioFile(validFile, mp3.size, PodcastRepository.sha256Hex(mp3))
        assertTrue(runCatching { PodcastRepository.streamVerifyAudioFile(validFile, mp3.size + 1, PodcastRepository.sha256Hex(mp3)) }.isFailure)
        assertTrue(runCatching { PodcastRepository.streamVerifyAudioFile(validFile, mp3.size, "0".repeat(64)) }.isFailure)
        val nonMp3 = File(stageDir, "non.mp3").apply { writeBytes("<html>not mp3</html>".toByteArray()) }
        assertTrue(runCatching { PodcastRepository.streamVerifyAudioFile(nonMp3, nonMp3.length().toInt(), PodcastRepository.sha256Hex(nonMp3.readBytes())) }.isFailure)
        val linkFile = File(stageDir, "link.mp3")
        java.nio.file.Files.createSymbolicLink(linkFile.toPath(), validFile.toPath())
        assertTrue(runCatching { PodcastRepository.streamVerifyAudioFile(linkFile, mp3.size, PodcastRepository.sha256Hex(mp3)) }.isFailure)

        // P1 #8: Corrupt cache-index.json with path traversal / JSON null sha256 is safely ignored
        val poisonCacheDir = temp.newFolder("poison-cache")
        File(poisonCacheDir, "cache-index.json").writeText(
            JSONObject().put("entries", JSONArray().apply {
                put(JSONObject().put("sha256", "../outside").put("episodeId", "evil").put("bytes", 100).put("lastAccessedAt", 1L))
                put(JSONObject().put("sha256", JSONObject.NULL).put("episodeId", JSONObject.NULL).put("bytes", 100).put("lastAccessedAt", 1L))
            }).toString()
        )
        val poisonRepo = PodcastRepository(poisonCacheDir)
        assertTrue(poisonRepo.cachedEpisodeIds().isEmpty())
        assertEquals(0L, poisonRepo.cachedTotalBytes())
    }
}
