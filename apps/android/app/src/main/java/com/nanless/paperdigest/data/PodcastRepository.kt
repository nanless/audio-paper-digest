package com.nanless.paperdigest.data

import com.nanless.paperdigest.protocols.ClientProtocols
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.URI
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.time.LocalDate
import java.util.UUID

data class PodcastChapter(
    val title: String,
    val startSeconds: Double,
    val endSeconds: Double? = null,
    val paperId: String? = null,
) {
    fun json(): JSONObject = JSONObject().apply {
        put("title", title)
        put("startSeconds", startSeconds)
        if (endSeconds != null) put("endSeconds", endSeconds)
        if (!paperId.isNullOrBlank()) put("paperId", paperId)
    }
}

data class PodcastEpisode(
    val id: String,
    val date: String,
    val title: String,
    val summary: String,
    val audioUrl: String,
    val bytes: Int,
    val sha256: String,
    val durationSeconds: Double,
    val mimeType: String,
    val chapters: List<PodcastChapter>,
    val paperIds: List<String>,
) {
    fun json(cached: Boolean): JSONObject = JSONObject().apply {
        put("id", id)
        put("date", date)
        put("title", title)
        put("summary", summary)
        put("audioUrl", audioUrl)
        put("bytes", bytes)
        put("sha256", sha256)
        put("durationSeconds", durationSeconds)
        put("mimeType", mimeType)
        put("chapters", JSONArray(chapters.map { it.json() }))
        put("paperIds", JSONArray(paperIds))
        put("cached", cached)
    }
}

data class PodcastFeed(
    val generatedAt: String,
    val episodes: List<PodcastEpisode>,
)

data class PodcastFeedResult(
    val available: Boolean,
    val feed: PodcastFeed?,
    val fromCache: Boolean = false,
)

data class PodcastCacheEntry(
    val sha256: String,
    val episodeId: String,
    val bytes: Int,
    val lastAccessedAt: Long,
)

/**
 * Native daily audio podcast feed loader, verified GitHub Release downloader, and backup-excluded LRU cache.
 * Lives under cacheDir/podcast-cache (outside noBackupFilesDir/PaperDigest), so WebDAV and backups never include it.
 * All audio downloads and cached file checks stream in 64 KiB chunks (never loading 40 MiB into heap).
 */
class PodcastRepository(
    val cacheDir: File,
    private val feedTransport: (suspend (String, Int) -> HttpBytes)? = null,
    private val audioTransport: (suspend (String, Int) -> HttpBytes)? = null,
    private val maxCacheBytes: Long = MAX_CACHE_BYTES,
    private val maxCachedEpisodes: Int = MAX_CACHED_EPISODES,
) {
    private val episodesDir = File(cacheDir, "episodes").also { it.mkdirs() }
    private val indexFile = File(cacheDir, "cache-index.json")
    private val feedCacheFile = File(cacheDir, "feed.json")
    private val mutex = Mutex()
    private val publishedHttp by lazy { SafeHttp.publishedSite() }
    @Volatile private var cachedFeed: PodcastFeed? = loadCachedFeedFromDisk()
    private val cacheEntries = mutableListOf<PodcastCacheEntry>().apply { addAll(loadCacheIndexFromDisk()) }

    fun currentFeed(): PodcastFeed? = cachedFeed

    fun episodeFile(sha256: String): File = File(episodesDir, "$sha256.mp3")

    suspend fun cachedEpisodeIds(): Set<String> = mutex.withLock {
        cacheEntries.filter { isValidSha256(it.sha256) && episodeFile(it.sha256).isFile }.mapTo(linkedSetOf()) { it.episodeId }
    }

    suspend fun cachedTotalBytes(): Long = mutex.withLock {
        cacheEntries.filter { isValidSha256(it.sha256) && episodeFile(it.sha256).isFile }.sumOf { it.bytes.toLong() }
    }

    suspend fun fetchFeed(forceRefresh: Boolean = false, offlineMode: Boolean = false): PodcastFeedResult {
        if (offlineMode) {
            val existing = cachedFeed
            return PodcastFeedResult(available = existing != null && existing.episodes.isNotEmpty(), feed = existing, fromCache = true)
        }
        if (!forceRefresh) {
            val existing = cachedFeed
            if (existing != null) {
                return PodcastFeedResult(available = existing.episodes.isNotEmpty(), feed = existing, fromCache = true)
            }
        }
        val url = CatalogRepository.sameSite("client/podcast/feed.json")
        val response = if (feedTransport != null) {
            feedTransport.invoke(url, MAX_FEED_BYTES)
        } else {
            publishedHttp.execute(Request.Builder().url(url).header("Cache-Control", "no-cache").get().build(), MAX_FEED_BYTES)
        }
        if (response.code == 404 || response.code == 410) {
            mutex.withLock {
                cachedFeed = null
                feedCacheFile.delete()
            }
            return PodcastFeedResult(available = false, feed = null, fromCache = false)
        }
        if (response.code != 200) {
            throw AppFailure("http", "播客订阅清单返回 HTTP ${response.code}，已保留已有缓存。")
        }
        val parsed = parseFeed(response.bytes)
        mutex.withLock {
            atomicWrite(response.bytes, feedCacheFile)
            cachedFeed = parsed
        }
        return PodcastFeedResult(available = parsed.episodes.isNotEmpty(), feed = parsed, fromCache = false)
    }

    suspend fun verifiedCachedAudioFile(episode: PodcastEpisode): File? = mutex.withLock {
        verifiedCachedAudioFileLocked(episode)
    }

    private fun verifiedCachedAudioFileLocked(episode: PodcastEpisode): File? {
        if (!isValidSha256(episode.sha256)) return null
        val target = episodeFile(episode.sha256)
        if (!target.exists()) return null
        val ok = runCatching { streamVerifyAudioFile(target, episode.bytes, episode.sha256) }.isSuccess
        if (!ok) {
            target.delete()
            cacheEntries.removeAll { it.sha256 == episode.sha256 }
            saveCacheIndexLocked()
            return null
        }
        touchEntryLocked(episode.sha256, episode.id, episode.bytes)
        return target
    }

    suspend fun downloadEpisode(
        episode: PodcastEpisode,
        offlineMode: Boolean = false,
        proxy: String? = null,
        protectedSha: String? = null,
    ): File {
        mutex.withLock {
            verifiedCachedAudioFileLocked(episode)?.let { return it }
        }
        if (offlineMode) {
            throw AppFailure("offline", "当前处于离线模式，且该播客节目尚未缓存到本地。")
        }
        require(isValidInitialAudioUrl(episode.audioUrl)) { "播客音频地址未通过 GitHub Release HTTPS 白名单校验。" }
        require(isValidSha256(episode.sha256)) { "播客音频 SHA-256 格式无效。" }

        val stageFile = File(episodesDir, ".stage-${UUID.randomUUID()}.tmp")
        try {
            fetchVerifiedReleaseAudioToFile(episode.audioUrl, episode.bytes, proxy, stageFile)
            streamVerifyAudioFile(stageFile, episode.bytes, episode.sha256)
            return mutex.withLock {
                val target = episodeFile(episode.sha256)
                require(!Files.isSymbolicLink(target.toPath())) { "播客缓存目标不能是符号链接。" }
                Files.move(stageFile.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
                touchEntryLocked(episode.sha256, episode.id, episode.bytes)
                evictCacheIfNeededLocked(setOfNotNull(episode.sha256, protectedSha))
                target
            }
        } finally {
            if (stageFile.exists()) stageFile.delete()
        }
    }

    suspend fun clearCache(): Unit = mutex.withLock {
        episodesDir.listFiles()?.forEach { it.delete() }
        cacheEntries.clear()
        saveCacheIndexLocked()
    }

    private suspend fun fetchVerifiedReleaseAudioToFile(
        initialUrl: String,
        expectedBytes: Int,
        proxy: String?,
        stageFile: File,
    ) {
        var currentUrl = initialUrl
        val limit = minOf(MAX_AUDIO_BYTES, maxOf(expectedBytes, 1))
        val http = if (audioTransport == null) SafeHttp.podcastRelease(proxy = proxy) else null
        for (hop in 0..MAX_REDIRECTS) {
            if (hop == 0) {
                require(isValidInitialAudioUrl(currentUrl)) { "播客初始音频链接不在受控仓库 Release 白名单内。" }
            } else {
                require(isValidRedirectAudioUrl(currentUrl)) { "播客音频重定向地址超出允许域名范围。" }
            }
            val code: Int
            val headers: Map<String, String>
            if (audioTransport != null) {
                val response = audioTransport.invoke(currentUrl, MAX_AUDIO_BYTES)
                code = response.code
                headers = response.headers
                if (code == 200) {
                    require(response.bytes.size <= MAX_AUDIO_BYTES && response.bytes.size <= limit) {
                        "播客音频响应超过允许大小上限。"
                    }
                    atomicWrite(response.bytes, stageFile)
                    return
                }
            } else {
                val downloaded = http!!.download(Request.Builder().url(currentUrl).get().build(), stageFile, limit.toLong())
                code = downloaded.code
                headers = downloaded.headers
                if (code == 200) {
                    require(downloaded.bytes in 1L..limit.toLong() && downloaded.bytes <= MAX_AUDIO_BYTES.toLong()) {
                        "播客音频响应超过允许大小上限。"
                    }
                    return
                }
                if (stageFile.exists()) stageFile.delete()
            }
            if (code in setOf(301, 302, 303, 307, 308)) {
                if (hop >= MAX_REDIRECTS) {
                    throw AppFailure("redirect", "播客音频重定向超过最大 $MAX_REDIRECTS 次上限。")
                }
                val location = headers.entries.firstOrNull { it.key.equals("location", ignoreCase = true) }?.value?.trim()
                if (location.isNullOrEmpty()) {
                    throw AppFailure("redirect", "播客音频重定向缺少 Location 响应头。")
                }
                val resolved = runCatching { URI(currentUrl).resolve(location).toString() }.getOrNull()
                    ?: throw AppFailure("redirect", "播客音频重定向地址格式无效。")
                if (!isValidRedirectAudioUrl(resolved)) {
                    throw AppFailure("redirect", "播客音频重定向目标不在允许域名白名单内。")
                }
                currentUrl = resolved
                continue
            }
            throw AppFailure("http", "播客音频下载返回 HTTP $code。")
        }
        throw AppFailure("redirect", "播客音频重定向过多。")
    }

    private fun touchEntryLocked(sha256: String, episodeId: String, bytes: Int) {
        val now = System.currentTimeMillis()
        val idx = cacheEntries.indexOfFirst { it.sha256 == sha256 }
        if (idx >= 0) {
            cacheEntries[idx] = PodcastCacheEntry(sha256, episodeId, bytes, now)
        } else {
            cacheEntries.add(PodcastCacheEntry(sha256, episodeId, bytes, now))
        }
        saveCacheIndexLocked()
    }

    private fun evictCacheIfNeededLocked(protectedShas: Set<String>) {
        cacheEntries.removeAll { !isValidSha256(it.sha256) || !episodeFile(it.sha256).isFile }
        var total = cacheEntries.sumOf { it.bytes.toLong() }
        while (cacheEntries.size > maxCachedEpisodes || total > maxCacheBytes) {
            val victim = cacheEntries
                .filter { it.sha256 !in protectedShas }
                .minByOrNull { it.lastAccessedAt }
                ?: break
            cacheEntries.remove(victim)
            total -= victim.bytes.toLong()
            if (isValidSha256(victim.sha256)) {
                episodeFile(victim.sha256).delete()
            }
        }
        saveCacheIndexLocked()
    }

    private fun atomicWrite(bytes: ByteArray, target: File) {
        target.parentFile?.mkdirs()
        require(!Files.isSymbolicLink(target.toPath())) { "播客缓存目标不能是符号链接。" }
        val tmp = File(target.parentFile, ".tmp-${UUID.randomUUID()}")
        try {
            FileOutputStream(tmp).use { out ->
                out.write(bytes)
                out.fd.sync()
            }
            Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally {
            if (tmp.exists()) tmp.delete()
        }
    }

    private fun loadCacheIndexFromDisk(): List<PodcastCacheEntry> = runCatching {
        if (!indexFile.isFile) return emptyList()
        val root = JSONObject(indexFile.readText(Charsets.UTF_8))
        val arr = root.optJSONArray("entries") ?: return emptyList()
        val seen = HashSet<String>()
        buildList {
            for (i in 0 until arr.length()) {
                val row = arr.optJSONObject(i) ?: continue
                val sha = row.nullableString("sha256").orEmpty()
                val id = row.nullableString("episodeId").orEmpty()
                val bytes = row.optInt("bytes", 0)
                val ts = row.optLong("lastAccessedAt", 0L)
                if (isValidSha256(sha) && id.isNotEmpty() && bytes in 1..MAX_AUDIO_BYTES && seen.add(sha)) {
                    add(PodcastCacheEntry(sha, id, bytes, ts))
                }
            }
        }
    }.getOrDefault(emptyList())

    private fun saveCacheIndexLocked() {
        runCatching {
            val arr = JSONArray()
            cacheEntries.forEach { e ->
                arr.put(
                    JSONObject()
                        .put("sha256", e.sha256)
                        .put("episodeId", e.episodeId)
                        .put("bytes", e.bytes)
                        .put("lastAccessedAt", e.lastAccessedAt)
                )
            }
            atomicWrite(JSONObject().put("entries", arr).toString().toByteArray(Charsets.UTF_8), indexFile)
        }
    }

    private fun loadCachedFeedFromDisk(): PodcastFeed? = runCatching {
        if (!feedCacheFile.isFile) return null
        parseFeed(feedCacheFile.readBytes())
    }.getOrNull()

    companion object {
        const val MAX_FEED_BYTES = 2 * 1024 * 1024
        const val MAX_AUDIO_BYTES = 40 * 1024 * 1024
        const val MAX_REDIRECTS = 4
        const val MAX_EPISODES = 120
        const val MAX_CACHE_BYTES = 150L * 1024L * 1024L
        const val MAX_CACHED_EPISODES = 5
        val ALLOWED_RATES = listOf(0.75f, 1.0f, 1.25f, 1.5f, 2.0f)

        private val INITIAL_RELEASE_URL_REGEX =
            Regex("^https://github\\.com/nanless/(?:audio-paper-digest|audio-paper-digest-blog|audio-research-workbench|audio-research-portal)/releases/download/[A-Za-z0-9._-]{1,128}/[A-Za-z0-9._-]{1,128}\\.mp3$")
        private val SHA256_REGEX = Regex("^[a-f0-9]{64}$")
        private val DATE_REGEX = Regex("^\\d{4}-\\d{2}-\\d{2}$")
        private val EPISODE_ID_REGEX = Regex("^[A-Za-z0-9._:-]{1,128}$")
        private val ALLOWED_ROOT_KEYS = setOf("contract", "schemaFingerprint", "generatedAt", "episodes")
        private val ALLOWED_EPISODE_KEYS = setOf(
            "id", "date", "title", "summary", "audioUrl", "bytes", "sha256",
            "durationSeconds", "mimeType", "chapters", "paperIds",
        )
        private val ALLOWED_CHAPTER_KEYS = setOf("title", "startSeconds", "endSeconds", "paperId")

        fun isValidCalendarDate(value: String): Boolean {
            if (!DATE_REGEX.matches(value)) return false
            val parsed = runCatching { LocalDate.parse(value) }.getOrNull() ?: return false
            return parsed.year in 1970..9999 && parsed.toString() == value
        }

        fun isValidInitialAudioUrl(raw: String): Boolean {
            if (!INITIAL_RELEASE_URL_REGEX.matches(raw)) return false
            val uri = runCatching { URI(raw) }.getOrNull() ?: return false
            if (uri.scheme != "https" || !uri.host.equals("github.com", ignoreCase = true)) return false
            if (uri.port != -1 && uri.port != 443) return false
            if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) return false
            val rawPath = uri.rawPath ?: return false
            if ('%' in rawPath || '\\' in rawPath || "//" in rawPath || ".." in rawPath) return false
            return true
        }

        fun isValidRedirectAudioUrl(raw: String): Boolean {
            val uri = runCatching { URI(raw) }.getOrNull() ?: return false
            val host = uri.host?.lowercase() ?: return false
            if (uri.scheme != "https" || host !in SafeHttp.PODCAST_RELEASE_HOSTS) return false
            if (uri.port != -1 && uri.port != 443) return false
            if (uri.rawUserInfo != null) return false
            if (host == "github.com") return isValidInitialAudioUrl(raw)
            val rawPath = uri.rawPath ?: return false
            val decodedPath = uri.path ?: return false
            val lowerRaw = rawPath.lowercase()
            if (rawPath.isEmpty() || decodedPath.isEmpty()) return false
            if (".." in rawPath || ".." in decodedPath || '\\' in rawPath || '\\' in decodedPath) return false
            if ("%2e" in lowerRaw || "%5c" in lowerRaw || "%00" in lowerRaw || '\u0000' in decodedPath) return false
            return true
        }

        fun isValidMp3Magic(bytes: ByteArray): Boolean {
            if (bytes.size < 4) return false
            // ID3v2 header: "ID3" + version (<0xFF) + flags + 4 synchsafe bytes
            if (bytes.size >= 10 &&
                bytes[0] == 0x49.toByte() &&
                bytes[1] == 0x44.toByte() &&
                bytes[2] == 0x33.toByte() &&
                (bytes[3].toInt() and 0xFF) < 0xFF &&
                (bytes[4].toInt() and 0xFF) < 0xFF &&
                (bytes[6].toInt() and 0x80) == 0 &&
                (bytes[7].toInt() and 0x80) == 0 &&
                (bytes[8].toInt() and 0x80) == 0 &&
                (bytes[9].toInt() and 0x80) == 0
            ) {
                return true
            }
            // Raw MPEG audio frame sync: 11 sync bits (0xFF, 0xE0..0xFF), valid version/layer/bitrate/sampleRate
            val b0 = bytes[0].toInt() and 0xFF
            val b1 = bytes[1].toInt() and 0xFF
            val b2 = bytes[2].toInt() and 0xFF
            if (b0 != 0xFF || (b1 and 0xE0) != 0xE0) return false
            val version = (b1 shr 3) and 0x03
            val layer = (b1 shr 1) and 0x03
            val bitrate = (b2 shr 4) and 0x0F
            val sampleRate = (b2 shr 2) and 0x03
            return version != 0x01 && layer != 0x00 && bitrate != 0x0F && sampleRate != 0x03
        }

        fun isValidSha256(value: String): Boolean = SHA256_REGEX.matches(value)

        fun sha256Hex(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }

        /** Stream-verifies exact byte count, SHA-256, and MP3 magic in 64 KiB chunks (no 40 MiB RAM buffer). */
        fun streamVerifyAudioFile(file: File, expectedBytes: Int, expectedSha256: String) {
            require(!Files.isSymbolicLink(file.toPath()) && file.isFile) { "播客缓存文件不是有效普通文件。" }
            require(expectedBytes in 1..MAX_AUDIO_BYTES) { "播客声明大小超出允许上限。" }
            val actualLength = file.length()
            require(actualLength == expectedBytes.toLong() && actualLength <= MAX_AUDIO_BYTES.toLong()) {
                "播客音频实际字节数与清单声明不符（期望 $expectedBytes，实际 $actualLength）。"
            }
            val digest = MessageDigest.getInstance("SHA-256")
            val magicBuf = ByteArray(10)
            var magicFilled = 0
            var totalRead = 0L
            val chunk = ByteArray(64 * 1024)
            FileInputStream(file).use { input ->
                while (true) {
                    val n = input.read(chunk)
                    if (n < 0) break
                    totalRead += n
                    require(totalRead <= expectedBytes.toLong() && totalRead <= MAX_AUDIO_BYTES.toLong()) {
                        "播客音频在校验期间超过声明大小上限。"
                    }
                    if (magicFilled < magicBuf.size) {
                        val copyLen = minOf(magicBuf.size - magicFilled, n)
                        System.arraycopy(chunk, 0, magicBuf, magicFilled, copyLen)
                        magicFilled += copyLen
                    }
                    digest.update(chunk, 0, n)
                }
            }
            require(totalRead == expectedBytes.toLong()) {
                "播客音频实际字节数与清单声明不符（期望 $expectedBytes，实际 $totalRead）。"
            }
            val actualSha = digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
            require(actualSha == expectedSha256) {
                "播客音频 SHA-256 校验失败，已拒绝播放并丢弃下载文件。"
            }
            val magicSlice = if (magicFilled == magicBuf.size) magicBuf else magicBuf.copyOf(magicFilled)
            require(isValidMp3Magic(magicSlice)) {
                "播客下载内容不是有效 MP3 文件头，已拒绝缓存。"
            }
        }

        private fun requireString(obj: JSONObject, key: String, label: String): String {
            require(obj.has(key) && !obj.isNull(key)) { "缺少字段：$label.$key" }
            val raw = obj.opt(key)
            require(raw is String) { "字段必须为字符串：$label.$key" }
            return raw
        }

        private fun optionalStringOrNull(obj: JSONObject, key: String, label: String): String? {
            if (!obj.has(key) || obj.isNull(key)) return null
            val raw = obj.opt(key)
            require(raw is String) { "字段必须为字符串或 null：$label.$key" }
            return raw
        }

        fun parseFeed(rawBytes: ByteArray): PodcastFeed {
            require(rawBytes.size <= MAX_FEED_BYTES) { "播客订阅清单超过 2 MiB 上限。" }
            val text = rawBytes.toString(Charsets.UTF_8)
            val root = runCatching { JSONObject(text) }.getOrNull()
                ?: throw IllegalArgumentException("播客订阅清单不是有效 JSON 对象。")
            require(ClientProtocols.isCurrentHeader(root, "paper-daily-podcast-feed")) {
                "播客订阅清单协议头或 schemaFingerprint 无效。"
            }
            require(root.keys().asSequence().all { it in ALLOWED_ROOT_KEYS }) {
                "播客订阅清单包含未声明顶层字段。"
            }
            val generatedAt = requireString(root, "generatedAt", "feed").trim()
            require(generatedAt.isNotEmpty()) { "播客订阅清单缺少 generatedAt。" }
            val arr = root.opt("episodes") as? JSONArray
                ?: throw IllegalArgumentException("播客订阅清单缺少 episodes 数组。")
            require(arr.length() <= MAX_EPISODES) { "播客订阅清单节目数超过 $MAX_EPISODES 上限。" }

            val seen = HashSet<String>()
            val episodes = ArrayList<PodcastEpisode>(arr.length())
            for (i in 0 until arr.length()) {
                val row = arr.opt(i) as? JSONObject ?: throw IllegalArgumentException("播客节目条目 #$i 不是对象。")
                require(row.keys().asSequence().all { it in ALLOWED_EPISODE_KEYS }) {
                    "播客节目条目 #$i 包含未声明字段。"
                }
                val id = requireString(row, "id", "episode#$i")
                require(EPISODE_ID_REGEX.matches(id) && seen.add(id)) { "播客节目编号无效或重复：$id" }
                val date = requireString(row, "date", id)
                require(isValidCalendarDate(date)) { "播客节目日期格式或日历日期无效：$id" }
                val title = requireString(row, "title", id).trim()
                require(title.isNotEmpty()) { "播客节目标题为空：$id" }
                val summary = optionalStringOrNull(row, "summary", id)?.trim().orEmpty()
                val audioUrl = requireString(row, "audioUrl", id)
                require(isValidInitialAudioUrl(audioUrl)) { "播客音频地址不在受控 GitHub Release HTTPS 白名单内：$id" }
                val rawBytesVal = row.opt("bytes")
                require(rawBytesVal is Int || rawBytesVal is Long) { "播客音频声明大小必须为整数：$id" }
                val bytesLong = (rawBytesVal as Number).toLong()
                require(bytesLong in 1L..MAX_AUDIO_BYTES.toLong()) { "播客音频声明大小超出 40 MiB 上限：$id" }
                val sha = requireString(row, "sha256", id)
                require(isValidSha256(sha)) { "播客音频 SHA-256 无效：$id" }
                val rawDur = row.opt("durationSeconds")
                require(rawDur is Number && rawDur !is Boolean) { "播客节目时长无效：$id" }
                val duration = rawDur.toDouble()
                require(duration.isFinite() && duration > 0.0 && duration <= 86400.0) { "播客节目时长必须大于 0 且不超过 86400 秒：$id" }
                val mimeType = requireString(row, "mimeType", id)
                require(mimeType == "audio/mpeg") { "播客仅支持标准 audio/mpeg 格式：$id" }

                val chapters = mutableListOf<PodcastChapter>()
                if (row.has("chapters") && !row.isNull("chapters")) {
                    val chArr = row.opt("chapters") as? JSONArray ?: throw IllegalArgumentException("播客章节列表无效：$id")
                    for (j in 0 until chArr.length()) {
                        val ch = chArr.opt(j) as? JSONObject ?: throw IllegalArgumentException("播客章节条目无效：$id")
                        require(ch.keys().asSequence().all { it in ALLOWED_CHAPTER_KEYS }) {
                            "播客章节包含未声明字段：$id"
                        }
                        val chTitle = requireString(ch, "title", "$id.chapter#$j").trim()
                        val rawStart = ch.opt("startSeconds")
                        require(chTitle.isNotEmpty() && rawStart is Number && rawStart !is Boolean) { "播客章节字段无效：$id" }
                        val start = rawStart.toDouble()
                        require(start.isFinite() && start >= 0.0) { "播客章节起始时间无效：$id" }
                        val end = if (ch.has("endSeconds") && !ch.isNull("endSeconds")) {
                            val rawEnd = ch.opt("endSeconds")
                            require(rawEnd is Number && rawEnd !is Boolean) { "播客章节结束时间无效：$id" }
                            val e = rawEnd.toDouble()
                            require(e.isFinite() && e >= start) { "播客章节结束时间早于起始时间：$id" }
                            e
                        } else null
                        val paperId = optionalStringOrNull(ch, "paperId", "$id.chapter#$j")?.trim()?.ifEmpty { null }
                        chapters.add(PodcastChapter(chTitle, start, end, paperId))
                    }
                }
                val paperIds = buildList {
                    if (row.has("paperIds") && !row.isNull("paperIds")) {
                        val pidArr = row.opt("paperIds") as? JSONArray
                            ?: throw IllegalArgumentException("播客论文列表无效：$id")
                        for (j in 0 until pidArr.length()) {
                            val rawPid = pidArr.opt(j)
                            require(rawPid is String) { "播客论文编号必须为字符串：$id" }
                            val trimmed = rawPid.trim()
                            if (trimmed.isNotEmpty()) add(trimmed)
                        }
                    }
                }
                episodes.add(
                    PodcastEpisode(
                        id = id,
                        date = date,
                        title = title,
                        summary = summary,
                        audioUrl = audioUrl,
                        bytes = bytesLong.toInt(),
                        sha256 = sha,
                        durationSeconds = duration,
                        mimeType = mimeType,
                        chapters = chapters,
                        paperIds = paperIds,
                    )
                )
            }
            episodes.sortWith(compareByDescending<PodcastEpisode> { it.date }.thenByDescending { it.id })
            return PodcastFeed(generatedAt = generatedAt, episodes = episodes)
        }
    }
}
