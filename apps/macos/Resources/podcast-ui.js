const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export const PODCAST_RATES = [0.75, 1.0, 1.25, 1.5, 2.0];

export function formatPodcastRate(rate) {
  const safe = Number.isFinite(Number(rate)) && Number(rate) > 0 ? Number(rate) : 1.0;
  return `${safe.toFixed(2).replace(/(\.\d)0$/, '$1')}x`;
}

export function formatPodcastTime(seconds) {
  const safe = Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : 0;
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function nextPodcastRate(current) {
  const idx = PODCAST_RATES.findIndex(r => Math.abs(r - Number(current)) < 0.01);
  return PODCAST_RATES[(idx + 1) % PODCAST_RATES.length];
}

export function activeChapterIndex(chapters, currentTime) {
  if (!Array.isArray(chapters) || !chapters.length) return -1;
  const t = Number.isFinite(currentTime) && currentTime >= 0 ? currentTime : 0;
  let active = -1;
  for (let i = 0; i < chapters.length; i++) {
    const start = Number(chapters[i]?.startSeconds);
    if (!Number.isFinite(start)) continue;
    if (t >= start) active = i;
    else break;
  }
  return active;
}

export function formatPodcastBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 MB';
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Native daily audio podcast dock controller. Audio fetching & playback are 100% native. */
export function mountPodcast(app, {dockElement, onOpenPaper} = {}) {
  const dock = dockElement || document.getElementById('podcast-dock');
  let state = {
    available: false,
    episodes: [],
    activeEpisodeId: null,
    downloadingEpisodeId: null,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    rate: 1.0,
    cachedEpisodeIds: [],
    cachedBytes: 0,
    error: null,
  };
  let selectedEpisodeId = null;
  let drawerOpen = false;
  let scrubbing = false;
  let busy = false;
  let lastStructureKey = '';

  const fail = err => {
    if (typeof app.error === 'function') app.error(err);
    else if (typeof app.toast === 'function') app.toast(err?.message || String(err));
  };

  function currentEpisode() {
    const list = Array.isArray(state.episodes) ? state.episodes : [];
    if (!list.length) return null;
    if (selectedEpisodeId) {
      const picked = list.find(e => e.id === selectedEpisodeId);
      if (picked) return picked;
    }
    if (state.activeEpisodeId) {
      const playing = list.find(e => e.id === state.activeEpisodeId);
      if (playing) return playing;
    }
    return list[0];
  }

  function applyState(next) {
    if (!next || typeof next !== 'object') return;
    const prevActiveId = state.activeEpisodeId;
    state = {
      ...state,
      ...next,
      episodes: Array.isArray(next.episodes) ? next.episodes : state.episodes,
      cachedEpisodeIds: Array.isArray(next.cachedEpisodeIds) ? next.cachedEpisodeIds : state.cachedEpisodeIds,
      error: next.error || null,
    };
    if (state.activeEpisodeId && state.activeEpisodeId !== prevActiveId) {
      selectedEpisodeId = state.activeEpisodeId;
    } else if ((!selectedEpisodeId || !state.episodes.some(e => e.id === selectedEpisodeId)) && state.episodes.length) {
      selectedEpisodeId = state.activeEpisodeId || state.episodes[0].id;
    }
    render();
  }

  function buildMetaText(episode, curChapter, isDownloading, isCached) {
    return `${episode.date}${curChapter ? ' · ' + curChapter.title : ''}${isDownloading ? ' · 正在下载并校验音频…' : isCached ? ' · 已离线缓存' : ''}`;
  }

  function computeStructureKey(episodes, episode, isActive, isDownloading, isCached) {
    const epSig = episodes.map(e => `${e.id}:${e.cached ? 1 : 0}:${(e.chapters || []).length}`).join('|');
    return JSON.stringify([
      episode.id,
      selectedEpisodeId || '',
      epSig,
      state.activeEpisodeId || '',
      state.downloadingEpisodeId || '',
      isActive,
      Boolean(state.isPlaying),
      isDownloading,
      isCached,
      formatPodcastRate(state.rate),
      drawerOpen,
      state.error || '',
      (state.cachedEpisodeIds || []).join(','),
      Number(state.cachedBytes) || 0,
      busy,
    ]);
  }

  function patchProgressInPlace(episode, isActive, isDownloading, isCached, position, duration, chapters, curChapterIdx) {
    const scrubber = dock.querySelector('#podcast-scrubber');
    const timeEl = dock.querySelector('#podcast-time');
    const metaEl = dock.querySelector('.podcast-episode-meta');
    if (!scrubber || !timeEl) return false;
    const maxVal = Math.max(1, Math.floor(duration));
    scrubber.max = String(maxVal);
    scrubber.disabled = !(isActive && duration > 0);
    if (!scrubbing) {
      scrubber.value = String(Math.floor(position));
      timeEl.textContent = `${formatPodcastTime(position)} / ${formatPodcastTime(duration)}`;
    }
    if (metaEl) {
      const curChapter = curChapterIdx >= 0 ? chapters[curChapterIdx] : null;
      metaEl.textContent = buildMetaText(episode, curChapter, isDownloading, isCached);
    }
    const items = dock.querySelectorAll('.podcast-chapter-item');
    items.forEach((li, idx) => li.classList.toggle('is-current', idx === curChapterIdx));
    return true;
  }

  function render() {
    if (!dock) return;
    const episodes = Array.isArray(state.episodes) ? state.episodes : [];
    const episode = currentEpisode();
    const shouldShow = (state.available && episodes.length > 0) || Boolean(state.activeEpisodeId) || Boolean(state.downloadingEpisodeId);
    dock.hidden = !shouldShow;
    if (!shouldShow || !episode) {
      scrubbing = false;
      lastStructureKey = '';
      dock.replaceChildren();
      return;
    }
    const isActive = state.activeEpisodeId === episode.id;
    const isDownloading = state.downloadingEpisodeId === episode.id;
    const isCached = Boolean(episode.cached) || (state.cachedEpisodeIds || []).includes(episode.id);
    const duration = isActive && state.duration > 0 ? state.duration : (Number(episode.durationSeconds) || 0);
    const position = isActive ? Math.min(Number(state.currentTime) || 0, duration || Infinity) : 0;
    const chapters = Array.isArray(episode.chapters) ? episode.chapters : [];
    const curChapterIdx = isActive ? activeChapterIndex(chapters, position) : -1;
    const curChapter = curChapterIdx >= 0 ? chapters[curChapterIdx] : null;
    const rateLabel = formatPodcastRate(state.rate);

    const structureKey = computeStructureKey(episodes, episode, isActive, isDownloading, isCached);
    if (lastStructureKey === structureKey && patchProgressInPlace(episode, isActive, isDownloading, isCached, position, duration, chapters, curChapterIdx)) {
      return;
    }
    lastStructureKey = structureKey;
    scrubbing = false;

    const episodeOptions = episodes.length > 1
      ? `<select class="podcast-episode-select" id="podcast-episode-select" aria-label="选择播客节目">${episodes.map(ep => `<option value="${esc(ep.id)}" ${ep.id === episode.id ? 'selected' : ''}>${esc(ep.date)} · ${esc(ep.title)}</option>`).join('')}</select>`
      : '';

    const chapterItems = chapters.map((ch, idx) => `
      <li class="podcast-chapter-item ${idx === curChapterIdx ? 'is-current' : ''}">
        <button type="button" class="podcast-chapter-seek" data-podcast-chapter-start="${esc(ch.startSeconds)}" data-podcast-episode-id="${esc(episode.id)}">
          <span class="podcast-chapter-time">${esc(formatPodcastTime(ch.startSeconds))}</span>
          <span>${esc(ch.title)}</span>
        </button>
        ${ch.paperId ? `<button type="button" class="podcast-chapter-paper" data-podcast-paper-id="${esc(ch.paperId)}">打开论文</button>` : ''}
      </li>
    `).join('');

    dock.innerHTML = `
      <div class="podcast-bar">
        <button type="button" class="podcast-play-btn" id="podcast-toggle-play" aria-label="${isActive && state.isPlaying ? '暂停播客' : '播放播客'}" ${busy || isDownloading ? 'disabled' : ''}>${isDownloading ? '…' : (isActive && state.isPlaying ? '❚❚' : '▶')}</button>
        <div class="podcast-info">
          <div class="podcast-title-row">
            <span class="podcast-episode-title" title="${esc(episode.title)}">${esc(episode.title)}</span>
          </div>
          <span class="podcast-episode-meta">${esc(buildMetaText(episode, curChapter, isDownloading, isCached))}</span>
        </div>
        <div class="podcast-progress-wrap">
          <input type="range" class="podcast-scrubber" id="podcast-scrubber" min="0" max="${Math.max(1, Math.floor(duration))}" value="${Math.floor(position)}" step="1" aria-label="播客播放进度" ${isActive && duration > 0 ? '' : 'disabled'} />
          <span class="podcast-time" id="podcast-time">${esc(formatPodcastTime(position))} / ${esc(formatPodcastTime(duration))}</span>
        </div>
        <div class="podcast-controls">
          ${episodeOptions}
          <button type="button" class="podcast-chip-btn" id="podcast-rate-btn" aria-label="切换播放倍速">${esc(rateLabel)}</button>
          <button type="button" class="podcast-chip-btn" id="podcast-download-btn" ${isCached || isDownloading || busy ? 'disabled' : ''}>${isDownloading ? '下载中…' : isCached ? '已缓存' : '缓存'}</button>
          <button type="button" class="podcast-chip-btn ${drawerOpen ? 'is-active' : ''}" id="podcast-chapters-btn" aria-expanded="${drawerOpen}">${chapters.length ? `章节 (${chapters.length})` : '详情'}</button>
        </div>
      </div>
      ${state.error ? `<div class="podcast-error" role="alert">${esc(state.error)}</div>` : ''}
      <div class="podcast-drawer" id="podcast-drawer" ${drawerOpen ? '' : 'hidden'}>
        <div class="podcast-drawer-header">
          <span>本地音频缓存：${esc((state.cachedEpisodeIds || []).length)} 期 · ${esc(formatPodcastBytes(state.cachedBytes))}（最多 5 期 / 150 MB）</span>
          <button type="button" class="podcast-chip-btn" id="podcast-clear-cache" ${(state.cachedEpisodeIds || []).length ? '' : 'disabled'}>清理音频缓存</button>
        </div>
        ${chapters.length ? `<ol class="podcast-chapter-list">${chapterItems}</ol>` : `<p class="podcast-episode-meta">${esc(episode.summary || '本节目暂未提供章节列表。')}</p>`}
      </div>
    `;

    const playBtn = dock.querySelector('#podcast-toggle-play');
    if (playBtn) {
      playBtn.onclick = async () => {
        if (busy) return;
        busy = true;
        try {
          if (isActive && state.isPlaying) {
            applyState(await app.call('podcast.pause', {}));
          } else {
            applyState(await app.call('podcast.play', {episodeId: episode.id}));
          }
        } catch (err) { fail(err); }
        finally { busy = false; render(); }
      };
    }

    const rateBtn = dock.querySelector('#podcast-rate-btn');
    if (rateBtn) {
      rateBtn.onclick = async () => {
        try {
          const next = nextPodcastRate(state.rate);
          applyState(await app.call('podcast.rate', {rate: next}));
        } catch (err) { fail(err); }
      };
    }

    const downloadBtn = dock.querySelector('#podcast-download-btn');
    if (downloadBtn) {
      downloadBtn.onclick = async () => {
        if (busy) return;
        busy = true;
        try {
          applyState(await app.call('podcast.download', {episodeId: episode.id}));
          app.toast?.('播客音频已下载并通过 SHA-256 校验');
        } catch (err) { fail(err); }
        finally { busy = false; render(); }
      };
    }

    const chaptersBtn = dock.querySelector('#podcast-chapters-btn');
    if (chaptersBtn) {
      chaptersBtn.onclick = () => {
        drawerOpen = !drawerOpen;
        render();
      };
    }

    const clearBtn = dock.querySelector('#podcast-clear-cache');
    if (clearBtn) {
      clearBtn.onclick = async () => {
        try {
          applyState(await app.call('podcast.clearCache', {}));
          app.toast?.('已清理播客音频缓存');
        } catch (err) { fail(err); }
      };
    }

    const select = dock.querySelector('#podcast-episode-select');
    if (select) {
      select.onchange = () => {
        selectedEpisodeId = select.value;
        render();
      };
    }

    const scrubber = dock.querySelector('#podcast-scrubber');
    if (scrubber) {
      scrubber.oninput = () => {
        scrubbing = true;
        const label = dock.querySelector('#podcast-time');
        if (label) label.textContent = `${formatPodcastTime(Number(scrubber.value))} / ${formatPodcastTime(duration)}`;
      };
      scrubber.onchange = async () => {
        scrubbing = false;
        try {
          applyState(await app.call('podcast.seek', {seconds: Number(scrubber.value)}));
        } catch (err) { fail(err); }
      };
      scrubber.onpointercancel = () => {
        scrubbing = false;
      };
    }

    for (const btn of dock.querySelectorAll('[data-podcast-chapter-start]')) {
      btn.onclick = async () => {
        const start = Number(btn.dataset.podcastChapterStart);
        const epId = btn.dataset.podcastEpisodeId;
        try {
          if (state.activeEpisodeId === epId && state.isPlaying) {
            applyState(await app.call('podcast.seek', {seconds: start}));
          } else {
            applyState(await app.call('podcast.play', {episodeId: epId, startSeconds: start}));
          }
        } catch (err) { fail(err); }
      };
    }

    for (const btn of dock.querySelectorAll('[data-podcast-paper-id]')) {
      btn.onclick = () => {
        const pid = btn.dataset.podcastPaperId;
        if (pid && typeof onOpenPaper === 'function') onOpenPaper(pid);
      };
    }
  }

  const onStateEvent = event => {
    applyState(event.detail);
  };
  window.addEventListener('podcast.state', onStateEvent);

  async function refreshFeed({refresh = false} = {}) {
    try {
      const result = await app.call('podcast.feed', {refresh});
      applyState(result);
      return result;
    } catch {
      // Optional podcast feed must never disrupt catalog sync or reading.
      return null;
    }
  }

  function destroy() {
    window.removeEventListener('podcast.state', onStateEvent);
  }

  return {refreshFeed, applyState, getState: () => structuredClone(state), destroy};
}
