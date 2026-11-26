package com.nanless.paperdigest.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.nanless.paperdigest.PodcastUiState
import com.nanless.paperdigest.data.PodcastChapter
import com.nanless.paperdigest.data.PodcastEpisode
import com.nanless.paperdigest.data.PodcastRepository
import kotlin.math.abs

internal fun formatPodcastClock(seconds: Double): String {
    val safe = if (seconds.isFinite() && seconds >= 0.0) seconds.toLong() else 0L
    val h = safe / 3600L
    val m = (safe % 3600L) / 60L
    val s = safe % 60L
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%02d:%02d".format(m, s)
}

internal fun nextPodcastRate(current: Float): Float {
    val rates = PodcastRepository.ALLOWED_RATES
    val idx = rates.indexOfFirst { abs(it - current) < 0.01f }
    return rates[(idx + 1) % rates.size]
}

internal fun activePodcastChapterIndex(chapters: List<PodcastChapter>, positionSeconds: Double): Int {
    if (chapters.isEmpty()) return -1
    val t = if (positionSeconds.isFinite() && positionSeconds >= 0.0) positionSeconds else 0.0
    var active = -1
    for (i in chapters.indices) {
        if (t >= chapters[i].startSeconds) active = i else break
    }
    return active
}

internal fun formatPodcastSizeMb(bytes: Long): String {
    if (bytes <= 0L) return "0.0 MB"
    return "%.1f MB".format(bytes / (1024.0 * 1024.0))
}

/**
 * Compact docked native podcast mini-player shown above NavigationBar when an episode is playing,
 * downloading, or available after playback begins; tapping opens the full chapter/rate/cache sheet.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun PodcastPlayerBar(
    podcast: PodcastUiState,
    offlineMode: Boolean,
    action: Action,
    onOpenPaper: (String) -> Unit,
) {
    val episode = podcast.activeEpisode ?: return
    val visible = podcast.activeEpisodeId != null || podcast.downloadingEpisodeId != null || (podcast.available && podcast.episodes.isNotEmpty())
    if (!visible) return

    var expanded by remember { mutableStateOf(false) }
    val isActive = podcast.activeEpisodeId == episode.id
    val isDownloading = podcast.downloadingEpisodeId == episode.id
    val isCached = episode.id in podcast.cachedEpisodeIds
    val duration = if (isActive && podcast.durationSeconds > 0.0) podcast.durationSeconds else episode.durationSeconds
    val position = if (isActive) podcast.currentTimeSeconds.coerceIn(0.0, duration.coerceAtLeast(1.0)) else 0.0
    val chapterIdx = if (isActive) activePodcastChapterIndex(episode.chapters, position) else -1
    val curChapter = episode.chapters.getOrNull(chapterIdx)

    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLowest,
        shape = MaterialTheme.shapes.medium,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.78f)),
        tonalElevation = 2.dp,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 4.dp),
    ) {
        Column(Modifier.fillMaxWidth()) {
            if (isDownloading) {
                LinearProgressIndicator(
                    modifier = Modifier.fillMaxWidth().height(2.5.dp),
                    color = MaterialTheme.colorScheme.primary,
                    trackColor = MaterialTheme.colorScheme.surfaceVariant,
                )
            } else if (isActive && duration > 0.0) {
                LinearProgressIndicator(
                    progress = { (position / duration).toFloat().coerceIn(0f, 1f) },
                    modifier = Modifier.fillMaxWidth().height(2.5.dp),
                    color = MaterialTheme.colorScheme.tertiary,
                    trackColor = MaterialTheme.colorScheme.surfaceVariant,
                )
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { expanded = true }
                    .padding(horizontal = 10.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                FilledTonalIconButton(
                    onClick = {
                        if (isActive && podcast.isPlaying) action("podcast.pause", obj())
                        else action("podcast.play", obj("episodeId" to episode.id))
                    },
                    enabled = !isDownloading && (!offlineMode || isCached || isActive),
                    colors = IconButtonDefaults.filledTonalIconButtonColors(
                        containerColor = MaterialTheme.colorScheme.tertiaryContainer,
                        contentColor = MaterialTheme.colorScheme.onTertiaryContainer,
                    ),
                ) {
                    Icon(
                        imageVector = if (isActive && podcast.isPlaying) Icons.Outlined.Pause else Icons.Outlined.PlayArrow,
                        contentDescription = if (isActive && podcast.isPlaying) "暂停播客" else "播放播客",
                    )
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        text = episode.title,
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        text = buildString {
                            append(episode.date)
                            if (curChapter != null) append(" · ").append(curChapter.title)
                            else if (isDownloading) append(" · 正在下载并校验 MP3…")
                            else if (isCached) append(" · 已离线缓存")
                            if (isActive && duration > 0.0) {
                                append(" · ").append(formatPodcastClock(position)).append("/").append(formatPodcastClock(duration))
                            }
                        },
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    podcast.error?.takeIf { it.isNotBlank() }?.let { err ->
                        Text(
                            text = err,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.error,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                Surface(
                    shape = MaterialTheme.shapes.extraSmall,
                    color = MaterialTheme.colorScheme.surfaceContainerHigh,
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.65f)),
                ) {
                    TextButton(
                        onClick = { action("podcast.rate", obj("rate" to nextPodcastRate(podcast.rate).toDouble())) },
                        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp),
                        modifier = Modifier.heightIn(min = 32.dp),
                    ) {
                        Text("${podcast.rate}x", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                    }
                }
                IconButton(onClick = { expanded = true }) {
                    Icon(Icons.Outlined.ExpandLess, "展开播客播放器")
                }
            }
        }
    }

    if (expanded) {
        ModalBottomSheet(
            onDismissRequest = { expanded = false },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        ) {
            PodcastExpandedSheet(
                podcast = podcast,
                episode = episode,
                offlineMode = offlineMode,
                action = action,
                onOpenPaper = { pid ->
                    expanded = false
                    onOpenPaper(pid)
                },
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PodcastExpandedSheet(
    podcast: PodcastUiState,
    episode: PodcastEpisode,
    offlineMode: Boolean,
    action: Action,
    onOpenPaper: (String) -> Unit,
) {
    val isActive = podcast.activeEpisodeId == episode.id
    val isDownloading = podcast.downloadingEpisodeId == episode.id
    val isCached = episode.id in podcast.cachedEpisodeIds
    val duration = if (isActive && podcast.durationSeconds > 0.0) podcast.durationSeconds else episode.durationSeconds
    val position = if (isActive) podcast.currentTimeSeconds.coerceIn(0.0, duration.coerceAtLeast(1.0)) else 0.0
    val chapterIdx = if (isActive) activePodcastChapterIndex(episode.chapters, position) else -1
    var isScrubbing by remember(episode.id) { mutableStateOf(false) }
    var scrubValue by remember(episode.id) { mutableFloatStateOf(position.toFloat()) }
    LaunchedEffect(position, isScrubbing) {
        if (!isScrubbing) scrubValue = position.toFloat()
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Surface(
                shape = CircleShape,
                color = MaterialTheme.colorScheme.tertiaryContainer,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.tertiary.copy(alpha = 0.28f)),
            ) {
                Icon(
                    Icons.Outlined.GraphicEq,
                    null,
                    Modifier.padding(12.dp).size(24.dp),
                    tint = MaterialTheme.colorScheme.onTertiaryContainer,
                )
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("每日音频播客 · ${episode.date}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.tertiary, fontWeight = FontWeight.SemiBold)
                Text(episode.title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
            }
        }
        if (episode.summary.isNotBlank()) {
            Text(episode.summary, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        podcast.error?.let { err ->
            Text(err, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }
        Column(Modifier.fillMaxWidth()) {
            Slider(
                value = scrubValue.coerceIn(0f, duration.toFloat().coerceAtLeast(1f)),
                onValueChange = {
                    isScrubbing = true
                    scrubValue = it
                },
                onValueChangeFinished = {
                    isScrubbing = false
                    if (isActive) action("podcast.seek", obj("seconds" to scrubValue.toDouble()))
                },
                valueRange = 0f..duration.toFloat().coerceAtLeast(1f),
                enabled = isActive && duration > 0.0,
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(formatPodcastClock(scrubValue.toDouble()), style = MaterialTheme.typography.labelSmall)
                Text(formatPodcastClock(duration), style = MaterialTheme.typography.labelSmall)
            }
        }
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Button(
                onClick = {
                    if (isActive && podcast.isPlaying) action("podcast.pause", obj())
                    else action("podcast.play", obj("episodeId" to episode.id))
                },
                enabled = !isDownloading && (!offlineMode || isCached || isActive),
            ) {
                Icon(if (isActive && podcast.isPlaying) Icons.Outlined.Pause else Icons.Outlined.PlayArrow, null)
                Spacer(Modifier.width(6.dp))
                Text(if (isDownloading) "下载校验中…" else if (isActive && podcast.isPlaying) "暂停" else "播放")
            }
            OutlinedButton(
                onClick = { action("podcast.download", obj("episodeId" to episode.id)) },
                enabled = !isCached && !isDownloading && !offlineMode,
            ) {
                Icon(Icons.Outlined.DownloadForOffline, null, Modifier.size(18.dp))
                Spacer(Modifier.width(4.dp))
                Text(if (isCached) "已离线缓存" else "离线缓存")
            }
            if (isActive) {
                TextButton(onClick = { action("podcast.stop", obj()) }) { Text("停止") }
            }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            PodcastRepository.ALLOWED_RATES.forEach { r ->
                FilterChip(
                    selected = abs(podcast.rate - r) < 0.01f,
                    onClick = { action("podcast.rate", obj("rate" to r.toDouble())) },
                    label = { Text("${r}x") },
                )
            }
        }
        if (episode.chapters.isNotEmpty()) {
            Text("节目章节", style = MaterialTheme.typography.titleSmall)
            episode.chapters.forEachIndexed { idx, chapter ->
                Surface(
                    color = if (idx == chapterIdx) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.5f)
                    else MaterialTheme.colorScheme.surfaceContainerLow,
                    shape = MaterialTheme.shapes.small,
                    border = BorderStroke(
                        1.dp,
                        if (idx == chapterIdx) MaterialTheme.colorScheme.primary.copy(alpha = 0.35f)
                        else MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f),
                    ),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable(enabled = !offlineMode || isCached || isActive) {
                                if (isActive && podcast.isPlaying) {
                                    action("podcast.seek", obj("seconds" to chapter.startSeconds))
                                } else {
                                    action("podcast.play", obj("episodeId" to episode.id, "startSeconds" to chapter.startSeconds))
                                }
                            }
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            formatPodcastClock(chapter.startSeconds),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        Text(
                            chapter.title,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.weight(1f),
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                        if (!chapter.paperId.isNullOrBlank()) {
                            TextButton(onClick = { onOpenPaper(chapter.paperId) }) {
                                Text("打开论文")
                            }
                        }
                    }
                }
            }
        }
        if (podcast.episodes.size > 1) {
            Text("最近节目", style = MaterialTheme.typography.titleSmall)
            podcast.episodes.take(10).forEach { ep ->
                val epCached = ep.id in podcast.cachedEpisodeIds
                val epDownloading = podcast.downloadingEpisodeId == ep.id
                EditorialCard(
                    onClick = { if (!epDownloading) action("podcast.play", obj("episodeId" to ep.id)) },
                    enabled = !epDownloading && (!offlineMode || epCached || ep.id == podcast.activeEpisodeId),
                    selected = ep.id == podcast.activeEpisodeId,
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(ep.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("${ep.date} · ${formatPodcastClock(ep.durationSeconds)}" + if (epCached) " · 已缓存" else "", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (ep.id == podcast.activeEpisodeId) {
                            Icon(Icons.Outlined.GraphicEq, "当前节目", tint = MaterialTheme.colorScheme.tertiary)
                        }
                    }
                }
            }
        }
        HorizontalDivider()
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                "本地缓存：${podcast.cachedEpisodeIds.size} 期 · ${formatPodcastSizeMb(podcast.cachedBytes)}（最多 5 期 / 150 MB）",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            TextButton(
                onClick = { action("podcast.clearCache", obj()) },
                enabled = podcast.cachedEpisodeIds.isNotEmpty(),
            ) {
                Text("清理缓存")
            }
        }
        Spacer(Modifier.height(12.dp))
    }
}

/** Daily podcast highlight card displayed at the top of the daily digest view when an episode is published. */
@Composable
internal fun DailyPodcastCard(
    podcast: PodcastUiState,
    offlineMode: Boolean,
    action: Action,
) {
    val episode = podcast.episodes.firstOrNull() ?: return
    if (!podcast.available) return
    val isActive = podcast.activeEpisodeId == episode.id
    val isDownloading = podcast.downloadingEpisodeId == episode.id
    val isCached = episode.id in podcast.cachedEpisodeIds

    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLowest,
        shape = MaterialTheme.shapes.medium,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.tertiary.copy(alpha = 0.34f)),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Surface(
                    shape = CircleShape,
                    color = MaterialTheme.colorScheme.tertiaryContainer,
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.tertiary.copy(alpha = 0.25f)),
                ) {
                    Icon(Icons.Outlined.Podcasts, null, tint = MaterialTheme.colorScheme.onTertiaryContainer, modifier = Modifier.padding(8.dp).size(18.dp))
                }
                Text("每日音频播客 · ${episode.date}", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.tertiary, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                MonographPill(
                    text = formatPodcastClock(episode.durationSeconds),
                    containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                    contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(episode.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (episode.summary.isNotBlank()) {
                Text(episode.summary, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                FilledTonalButton(
                    onClick = {
                        if (isActive && podcast.isPlaying) action("podcast.pause", obj())
                        else action("podcast.play", obj("episodeId" to episode.id))
                    },
                    enabled = !isDownloading && (!offlineMode || isCached || isActive),
                    colors = ButtonDefaults.filledTonalButtonColors(
                        containerColor = MaterialTheme.colorScheme.tertiaryContainer,
                        contentColor = MaterialTheme.colorScheme.onTertiaryContainer,
                    ),
                ) {
                    Icon(if (isActive && podcast.isPlaying) Icons.Outlined.Pause else Icons.Outlined.PlayArrow, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(4.dp))
                    Text(if (isDownloading) "校验中…" else if (isActive && podcast.isPlaying) "暂停播放" else "收听本期")
                }
                if (!isCached && !offlineMode) {
                    OutlinedButton(
                        onClick = { action("podcast.download", obj("episodeId" to episode.id)) },
                        enabled = !isDownloading,
                    ) {
                        Text("离线缓存")
                    }
                } else if (isCached) {
                    MonographPill(
                        text = "已离线缓存",
                        containerColor = MaterialTheme.colorScheme.primaryContainer,
                        contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                        icon = Icons.Outlined.CheckCircleOutline,
                    )
                }
            }
        }
    }
}
