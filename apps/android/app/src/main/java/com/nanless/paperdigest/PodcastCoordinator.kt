package com.nanless.paperdigest

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.PlaybackParams
import com.nanless.paperdigest.data.AppFailure
import com.nanless.paperdigest.data.PodcastEpisode
import com.nanless.paperdigest.data.PodcastRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

data class PodcastUiState(
    val available: Boolean = false,
    val episodes: List<PodcastEpisode> = emptyList(),
    val activeEpisodeId: String? = null,
    val downloadingEpisodeId: String? = null,
    val isPlaying: Boolean = false,
    val currentTimeSeconds: Double = 0.0,
    val durationSeconds: Double = 0.0,
    val rate: Float = 1.0f,
    val cachedEpisodeIds: Set<String> = emptySet(),
    val cachedBytes: Long = 0L,
    val error: String? = null,
    val attemptedFeed: Boolean = false,
) {
    val activeEpisode: PodcastEpisode?
        get() = activeEpisodeId?.let { id -> episodes.firstOrNull { it.id == id } } ?: episodes.firstOrNull()

    fun json(): JSONObject = JSONObject().apply {
        put("available", available)
        put("episodes", JSONArray(episodes.map { it.json(it.id in cachedEpisodeIds) }))
        put("activeEpisodeId", activeEpisodeId ?: JSONObject.NULL)
        put("downloadingEpisodeId", downloadingEpisodeId ?: JSONObject.NULL)
        put("isPlaying", isPlaying)
        put("currentTime", currentTimeSeconds)
        put("duration", durationSeconds)
        put("rate", rate.toDouble())
        put("cachedEpisodeIds", JSONArray(cachedEpisodeIds.sorted()))
        put("cachedBytes", cachedBytes)
        if (error != null) put("error", error)
    }
}

/**
 * Built-in android.media.MediaPlayer + AudioAttributes + AudioFocusRequest + PlaybackParams coordinator.
 * Zero extra Gradle dependencies, zero Manifest edits, 100% native playback of verified cached MP3 files.
 * Monotonic generation tokens & tracked downloads prevent A->B switch races and stale callbacks.
 */
internal class PodcastCoordinator(
    private val context: Context,
    private val repository: PodcastRepository,
    private val scope: CoroutineScope,
    private val offlineMode: () -> Boolean,
    private val httpProxy: () -> String?,
    private val onStateChanged: (PodcastUiState) -> Unit,
) {
    private val playerMutex = Mutex()
    private var mediaPlayer: MediaPlayer? = null
    private var focusRequest: AudioFocusRequest? = null
    private var progressJob: Job? = null
    private var playbackGeneration: Long = 0L
    private var downloadGeneration: Long = 0L
    private var activePlayDownload: Deferred<File>? = null
    private var activeCacheDownload: Deferred<File>? = null
    private var playDownloadingId: String? = null
    private var cacheDownloadingId: String? = null
    @Volatile private var currentState = PodcastUiState()

    private val audioManager: AudioManager?
        get() = context.getSystemService(AudioManager::class.java)

    private val audioAttributes: AudioAttributes by lazy {
        AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
    }

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                scope.launch(Dispatchers.IO) {
                    runCatching { pause() }
                }
            }
        }
    }

    suspend fun state(): PodcastUiState = playerMutex.withLock {
        refreshStateLocked()
    }

    suspend fun fetchFeed(forceRefresh: Boolean = false, silent: Boolean = false): JSONObject {
        return try {
            val result = repository.fetchFeed(forceRefresh = forceRefresh, offlineMode = offlineMode())
            val episodes = result.feed?.episodes.orEmpty()
            val cachedIds = repository.cachedEpisodeIds(episodes)
            val cachedBytes = repository.cachedTotalBytes()
            playerMutex.withLock {
                publishLocked(
                    currentState.copy(
                        available = result.available,
                        episodes = episodes,
                        cachedEpisodeIds = cachedIds,
                        cachedBytes = cachedBytes,
                        error = if (silent) currentState.error else null,
                        attemptedFeed = true,
                    )
                )
                currentState.json()
            }
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            playerMutex.withLock {
                publishLocked(
                    if (silent) currentState.copy(attemptedFeed = true)
                    else currentState.copy(error = e.message ?: "播客清单读取失败", attemptedFeed = true)
                )
            }
            throw e
        }
    }

    suspend fun download(episodeId: String): JSONObject {
        val episode = findEpisode(episodeId)
            ?: throw IllegalArgumentException("未找到指定的播客节目：$episodeId")
        val downloadTask: Deferred<File>
        playerMutex.withLock {
            downloadGeneration += 1L
            activeCacheDownload?.cancel()
            val playingSha = currentState.activeEpisodeId?.let { id -> currentState.episodes.firstOrNull { it.id == id }?.sha256 }
            cacheDownloadingId = episode.id
            publishLocked(currentState.copy(downloadingEpisodeId = playDownloadingId ?: cacheDownloadingId, error = null))
            downloadTask = scope.async(Dispatchers.IO) {
                repository.downloadEpisode(
                    episode = episode,
                    offlineMode = offlineMode(),
                    proxy = httpProxy(),
                    protectedSha = playingSha,
                )
            }
            activeCacheDownload = downloadTask
        }
        return try {
            downloadTask.await()
            playerMutex.withLock {
                if (activeCacheDownload === downloadTask) {
                    activeCacheDownload = null
                    cacheDownloadingId = null
                }
                refreshStateLocked().json()
            }
        } catch (e: Exception) {
            if (e is CancellationException) {
                downloadTask.cancel()
            }
            withContext(NonCancellable) {
                playerMutex.withLock {
                    if (activeCacheDownload === downloadTask) {
                        activeCacheDownload = null
                        cacheDownloadingId = null
                    }
                    val nextDownloading = playDownloadingId ?: cacheDownloadingId
                    if (e is CancellationException) {
                        publishLocked(currentState.copy(downloadingEpisodeId = nextDownloading))
                    } else {
                        publishLocked(currentState.copy(downloadingEpisodeId = nextDownloading, error = e.message ?: "播客下载失败"))
                    }
                }
            }
            throw e
        }
    }

    suspend fun play(episodeId: String?, startSeconds: Double? = null): JSONObject {
        if (startSeconds != null) {
            require(startSeconds.isFinite() && startSeconds >= 0.0) { "播客起始播放时间无效。" }
        }
        val targetId = episodeId?.takeIf { it.isNotBlank() }
            ?: currentState.activeEpisodeId
            ?: currentState.episodes.firstOrNull()?.id
            ?: throw IllegalStateException("当前没有可播放的播客节目。")
        val episode = findEpisode(targetId)
            ?: throw IllegalArgumentException("未找到指定的播客节目：$targetId")

        val myGen: Long
        val downloadTask: Deferred<File>
        playerMutex.withLock {
            playbackGeneration += 1L
            myGen = playbackGeneration
            activePlayDownload?.cancel()
            activePlayDownload = null
            playDownloadingId = null

            val existing = mediaPlayer
            if (currentState.activeEpisodeId == episode.id && existing != null) {
                if (!requestAudioFocusLocked()) {
                    throw AppFailure("audio-focus", "无法获取系统音频焦点，暂未开始播放。")
                }
                if (startSeconds != null) {
                    val durMs = existing.duration.takeIf { it > 0 } ?: (episode.durationSeconds * 1000).toInt()
                    existing.seekTo((startSeconds * 1000.0).toInt().coerceIn(0, durMs.coerceAtLeast(0)))
                }
                applyRateLocked(existing, currentState.rate)
                existing.start()
                val posSec = existing.currentPosition.coerceAtLeast(0) / 1000.0
                val durSec = existing.duration.takeIf { it > 0 }?.div(1000.0) ?: episode.durationSeconds
                publishLocked(
                    currentState.copy(
                        downloadingEpisodeId = cacheDownloadingId,
                        isPlaying = true,
                        currentTimeSeconds = posSec,
                        durationSeconds = durSec,
                        error = null,
                    )
                )
                startProgressLoopLocked(existing)
                return currentState.json()
            }

            playDownloadingId = episode.id
            publishLocked(currentState.copy(downloadingEpisodeId = playDownloadingId, error = null))
            downloadTask = scope.async(Dispatchers.IO) {
                repository.downloadEpisode(
                    episode = episode,
                    offlineMode = offlineMode(),
                    proxy = httpProxy(),
                    protectedSha = episode.sha256,
                )
            }
            activePlayDownload = downloadTask
        }

        val localFile: File = try {
            downloadTask.await()
        } catch (e: Exception) {
            if (e is CancellationException) {
                downloadTask.cancel()
            }
            withContext(NonCancellable) {
                playerMutex.withLock {
                    if (activePlayDownload === downloadTask) {
                        activePlayDownload = null
                        playDownloadingId = null
                    }
                    val nextDownloading = playDownloadingId ?: cacheDownloadingId
                    if (e is CancellationException) {
                        publishLocked(currentState.copy(downloadingEpisodeId = nextDownloading))
                    } else {
                        publishLocked(currentState.copy(downloadingEpisodeId = nextDownloading, error = e.message ?: "播客下载失败"))
                    }
                }
            }
            throw e
        }

        return try {
            playerMutex.withLock {
                if (activePlayDownload === downloadTask) {
                    activePlayDownload = null
                    playDownloadingId = null
                }
                if (playbackGeneration != myGen) {
                    publishLocked(currentState.copy(downloadingEpisodeId = playDownloadingId ?: cacheDownloadingId))
                    throw CancellationException("播客播放已被更新的请求替代")
                }
                stopAndReleaseLocked()
                val mp = MediaPlayer()
                try {
                    mp.setAudioAttributes(audioAttributes)
                    mp.setDataSource(localFile.absolutePath)
                    mp.prepare()
                    mp.setOnCompletionListener {
                        scope.launch(Dispatchers.IO) {
                            playerMutex.withLock {
                                if (mediaPlayer !== mp) return@withLock
                                progressJob?.cancel()
                                progressJob = null
                                abandonAudioFocusLocked()
                                val dur = mp.duration.takeIf { it > 0 }?.div(1000.0) ?: currentState.durationSeconds
                                publishLocked(currentState.copy(isPlaying = false, currentTimeSeconds = dur))
                            }
                        }
                    }
                    mp.setOnErrorListener { _, _, _ ->
                        scope.launch(Dispatchers.IO) {
                            playerMutex.withLock {
                                if (mediaPlayer !== mp) return@withLock
                                stopAndReleaseLocked()
                                publishLocked(
                                    currentState.copy(
                                        activeEpisodeId = null,
                                        isPlaying = false,
                                        currentTimeSeconds = 0.0,
                                        durationSeconds = 0.0,
                                        error = "系统音频播放器播放中断",
                                    )
                                )
                            }
                        }
                        true
                    }
                    if (!requestAudioFocusLocked()) {
                        throw AppFailure("audio-focus", "无法获取系统音频焦点，暂未开始播放。")
                    }
                    if (startSeconds != null) {
                        val durMs = mp.duration.takeIf { it > 0 } ?: (episode.durationSeconds * 1000).toInt()
                        mp.seekTo((startSeconds * 1000.0).toInt().coerceIn(0, durMs.coerceAtLeast(0)))
                    }
                    applyRateLocked(mp, currentState.rate)
                    mp.start()
                    mediaPlayer = mp
                    val durSec = mp.duration.takeIf { it > 0 }?.div(1000.0) ?: episode.durationSeconds
                    val posSec = mp.currentPosition.coerceAtLeast(0) / 1000.0
                    val cachedIds = repository.cachedEpisodeIds(currentState.episodes)
                    val cachedBytes = repository.cachedTotalBytes()
                    publishLocked(
                        currentState.copy(
                            activeEpisodeId = episode.id,
                            downloadingEpisodeId = playDownloadingId ?: cacheDownloadingId,
                            isPlaying = true,
                            currentTimeSeconds = posSec,
                            durationSeconds = durSec,
                            cachedEpisodeIds = cachedIds,
                            cachedBytes = cachedBytes,
                            error = null,
                        )
                    )
                    startProgressLoopLocked(mp)
                    currentState.json()
                } catch (e: Exception) {
                    runCatching { mp.release() }
                    abandonAudioFocusLocked()
                    publishLocked(
                        currentState.copy(
                            activeEpisodeId = null,
                            downloadingEpisodeId = playDownloadingId ?: cacheDownloadingId,
                            isPlaying = false,
                            currentTimeSeconds = 0.0,
                            durationSeconds = 0.0,
                            error = if (e is CancellationException) currentState.error else (e.message ?: "无法启动音频播放"),
                        )
                    )
                    throw e
                }
            }
        } catch (e: CancellationException) {
            withContext(NonCancellable) {
                playerMutex.withLock {
                    if (activePlayDownload === downloadTask) {
                        activePlayDownload = null
                        playDownloadingId = null
                        publishLocked(currentState.copy(downloadingEpisodeId = playDownloadingId ?: cacheDownloadingId))
                    }
                }
            }
            throw e
        }
    }

    suspend fun pause(): JSONObject = playerMutex.withLock {
        playbackGeneration += 1L
        val mp = mediaPlayer
        if (mp != null && runCatching { mp.isPlaying }.getOrDefault(false)) {
            runCatching { mp.pause() }
        }
        progressJob?.cancel()
        progressJob = null
        abandonAudioFocusLocked()
        val posSec = mp?.let { runCatching { it.currentPosition.coerceAtLeast(0) / 1000.0 }.getOrNull() } ?: currentState.currentTimeSeconds
        publishLocked(currentState.copy(isPlaying = false, currentTimeSeconds = posSec))
        currentState.json()
    }

    suspend fun seek(seconds: Double): JSONObject = playerMutex.withLock {
        require(seconds.isFinite() && seconds >= 0.0) { "跳转时间无效。" }
        val mp = mediaPlayer ?: throw IllegalStateException("尚未开始播放播客节目。")
        val maxSec = mp.duration.takeIf { it > 0 }?.div(1000.0) ?: currentState.durationSeconds
        val clamped = seconds.coerceIn(0.0, maxSec.coerceAtLeast(0.0))
        mp.seekTo((clamped * 1000.0).toInt())
        publishLocked(currentState.copy(currentTimeSeconds = clamped))
        currentState.json()
    }

    suspend fun setRate(rate: Float): JSONObject = playerMutex.withLock {
        require(rate.isFinite()) { "播放倍速无效。" }
        val canonical = PodcastRepository.ALLOWED_RATES.firstOrNull { kotlin.math.abs(it - rate) < 0.01f }
            ?: throw IllegalArgumentException("播放倍速仅支持 0.75 / 1.0 / 1.25 / 1.5 / 2.0。")
        mediaPlayer?.let { mp ->
            val wasPlaying = runCatching { mp.isPlaying }.getOrDefault(false)
            applyRateLocked(mp, canonical)
            if (!wasPlaying && runCatching { mp.isPlaying }.getOrDefault(false)) {
                runCatching { mp.pause() }
            }
        }
        publishLocked(currentState.copy(rate = canonical))
        currentState.json()
    }

    suspend fun clearCache(): JSONObject = playerMutex.withLock {
        playbackGeneration += 1L
        downloadGeneration += 1L
        activePlayDownload?.cancel()
        activePlayDownload = null
        playDownloadingId = null
        activeCacheDownload?.cancel()
        activeCacheDownload = null
        cacheDownloadingId = null
        stopAndReleaseLocked()
        repository.clearCache()
        publishLocked(
            currentState.copy(
                activeEpisodeId = null,
                downloadingEpisodeId = null,
                isPlaying = false,
                currentTimeSeconds = 0.0,
                durationSeconds = 0.0,
                cachedEpisodeIds = emptySet(),
                cachedBytes = 0L,
                error = null,
            )
        )
        currentState.json()
    }

    suspend fun stop(): JSONObject = playerMutex.withLock {
        playbackGeneration += 1L
        downloadGeneration += 1L
        activePlayDownload?.cancel()
        activePlayDownload = null
        playDownloadingId = null
        activeCacheDownload?.cancel()
        activeCacheDownload = null
        cacheDownloadingId = null
        stopAndReleaseLocked()
        publishLocked(
            currentState.copy(
                activeEpisodeId = null,
                downloadingEpisodeId = null,
                isPlaying = false,
                currentTimeSeconds = 0.0,
                durationSeconds = 0.0,
            )
        )
        currentState.json()
    }

    suspend fun release() {
        playerMutex.withLock {
            playbackGeneration += 1L
            downloadGeneration += 1L
            activePlayDownload?.cancel()
            activePlayDownload = null
            playDownloadingId = null
            activeCacheDownload?.cancel()
            activeCacheDownload = null
            cacheDownloadingId = null
            stopAndReleaseLocked()
            publishLocked(
                currentState.copy(
                    activeEpisodeId = null,
                    downloadingEpisodeId = null,
                    isPlaying = false,
                    currentTimeSeconds = 0.0,
                    durationSeconds = 0.0,
                )
            )
        }
    }

    private fun findEpisode(id: String): PodcastEpisode? =
        currentState.episodes.firstOrNull { it.id == id } ?: repository.currentFeed()?.episodes?.firstOrNull { it.id == id }

    private suspend fun refreshStateLocked(): PodcastUiState {
        val episodes = currentState.episodes.ifEmpty { repository.currentFeed()?.episodes.orEmpty() }
        val cachedIds = repository.cachedEpisodeIds(episodes)
        val cachedBytes = repository.cachedTotalBytes()
        val next = currentState.copy(
            downloadingEpisodeId = playDownloadingId ?: cacheDownloadingId,
            cachedEpisodeIds = cachedIds,
            cachedBytes = cachedBytes,
        )
        publishLocked(next)
        return next
    }

    private fun applyRateLocked(mp: MediaPlayer, speed: Float) {
        runCatching {
            val params = PlaybackParams().setSpeed(speed)
            mp.playbackParams = params
        }
    }

    private fun requestAudioFocusLocked(): Boolean {
        val am = audioManager ?: return true
        abandonAudioFocusLocked()
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(audioAttributes)
            .setOnAudioFocusChangeListener(focusListener)
            .build()
        val result = runCatching { am.requestAudioFocus(req) }.getOrDefault(AudioManager.AUDIOFOCUS_REQUEST_FAILED)
        if (result == AudioManager.AUDIOFOCUS_REQUEST_FAILED) {
            return false
        }
        focusRequest = req
        return true
    }

    private fun abandonAudioFocusLocked() {
        val req = focusRequest ?: return
        focusRequest = null
        runCatching { audioManager?.abandonAudioFocusRequest(req) }
    }

    private fun stopAndReleaseLocked() {
        progressJob?.cancel()
        progressJob = null
        runCatching { mediaPlayer?.stop() }
        runCatching { mediaPlayer?.release() }
        mediaPlayer = null
        abandonAudioFocusLocked()
    }

    private fun startProgressLoopLocked(owner: MediaPlayer) {
        progressJob?.cancel()
        progressJob = scope.launch(Dispatchers.IO) {
            while (isActive) {
                delay(500L)
                playerMutex.withLock {
                    if (mediaPlayer !== owner) return@launch
                    val playing = runCatching { owner.isPlaying }.getOrDefault(false)
                    val posSec = runCatching { owner.currentPosition.coerceAtLeast(0) / 1000.0 }.getOrDefault(currentState.currentTimeSeconds)
                    val durSec = runCatching { owner.duration.takeIf { it > 0 }?.div(1000.0) }.getOrNull() ?: currentState.durationSeconds
                    publishLocked(currentState.copy(isPlaying = playing, currentTimeSeconds = posSec, durationSeconds = durSec))
                    if (!playing) return@launch
                }
            }
        }
    }

    private fun publishLocked(next: PodcastUiState) {
        currentState = next
        onStateChanged(next)
    }
}
