/* Isolated browser integration for v1.5 Native Daily Podcast dock + Offline Filters UI.
 * Verifies CSP preservation, podcast dock hidden on 404, controls/chapters/rate/seek/jump-to-paper,
 * and v1.5 score presets, conference venue dropdown, resource filter, and relevance sort. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require('playwright');

const repo = path.resolve(__dirname, '../../..');
const resources = path.join(repo, 'apps/macos/Resources');

const server = http.createServer((req, res) => {
  let name;
  try { name = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); return res.end(); }
  let base = resources;
  let relative = name === '/' ? 'index.html' : name.slice(1);
  if (name.startsWith('/vendor/katex/')) {
    base = path.join(repo, 'apps/macos/node_modules/katex/dist');
    relative = name.slice('/vendor/katex/'.length);
  } else if (name.startsWith('/vendor/')) {
    base = path.join(repo, 'prototypes/macos-research/vendor');
    relative = name.slice('/vendor/'.length);
  }
  const file = path.resolve(base, relative);
  if (!file.startsWith(base + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : 'text/html');
    res.end(fs.readFileSync(file));
  } catch {
    res.writeHead(404);
    res.end();
  }
});

const samplePapers = [
  {
    id: 'arxiv:2611.00001',
    paperID: 'arxiv:2611.00001',
    title: 'Streaming TTS Codec',
    titleZh: '低延迟流式语音合成编解码器',
    date: '2026-11-24',
    score: 8.6,
    sourceKind: 'arxiv',
    authors: ['Alice Smith'],
    tags: ['TTS'],
    blogURL: 'https://fixture.example/blog/posts/p1/',
    sourceURL: 'https://arxiv.org/abs/2611.00001v1',
    websiteTagRecords: [{
      permalink: '/blog/posts/p1/',
      title: 'Streaming TTS Codec',
      titleZh: '低延迟流式语音合成编解码器',
      date: '2026-11-24',
      score: 8.6,
      sourceKind: 'arxiv',
      tags: ['TTS'],
      authors: ['Alice Smith'],
      tagConcepts: [{id: 'artifact.open-source-tool', label: '开源工具'}],
    }],
  },
  {
    id: 'conference:interspeech:2026:asr-42',
    paperID: 'conference:interspeech:2026:asr-42',
    title: 'Noise Robust Speech Recognition',
    titleZh: '强噪声鲁棒语音识别',
    date: '2026-11-20',
    score: 7.3,
    sourceKind: 'conference',
    authors: ['Bob Lin'],
    tags: ['ASR', 'TTS'],
    blogURL: 'https://fixture.example/blog/posts/p2/',
    sourceURL: 'https://www.isca-archive.org/interspeech_2026/asr42.html',
    websiteTagRecords: [{
      permalink: '/blog/posts/p2/',
      title: 'Noise Robust Speech Recognition',
      titleZh: '强噪声鲁棒语音识别',
      date: '2026-11-20',
      score: 7.3,
      sourceKind: 'conference',
      tags: ['ASR', 'TTS'],
      authors: ['Bob Lin'],
      tagConcepts: [{id: 'artifact.model-weights', label: '模型权重'}],
    }],
  },
  {
    id: 'arxiv:2611.00003',
    paperID: 'arxiv:2611.00003',
    title: 'Audio Synthesis Overview',
    titleZh: '音频合成综述',
    date: '2026-11-15',
    score: null,
    sourceKind: 'arxiv',
    authors: ['Carol Wu'],
    tags: ['Overview'],
    blogURL: 'https://fixture.example/blog/posts/p3/',
    sourceURL: 'https://arxiv.org/abs/2611.00003v1',
  },
];

const sampleEpisodes = [
  {
    id: 'daily-2026-11-24',
    date: '2026-11-24',
    title: '2026-11-24 音频论文速递播客',
    summary: '覆盖流式语音合成与鲁棒语音识别。',
    audioUrl: 'https://github.com/nanless/audio-paper-digest/releases/download/podcast-2026-11-24/daily-2026-11-24.mp3',
    bytes: 4194304,
    sha256: 'a'.repeat(64),
    durationSeconds: 300,
    mimeType: 'audio/mpeg',
    cached: false,
    chapters: [
      {title: '今日导读开场', startSeconds: 0, endSeconds: 45, paperId: null},
      {title: 'Streaming TTS Codec', startSeconds: 45, endSeconds: 180, paperId: '2611.00001v1'},
      {title: 'INTERSPEECH 鲁棒识别', startSeconds: 180, endSeconds: 300, paperId: 'conference:interspeech:2026:asr-42'},
    ],
    paperIds: ['arxiv:2611.00001', 'conference:interspeech:2026:asr-42'],
  },
];

async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  const url = `http://127.0.0.1:${port}/`;

  // Pure JS unit checks for podcast-ui.js exports & website-browser.js v1.5 helpers
  const podcastMod = await import('file://' + path.join(resources, 'podcast-ui.js'));
  assert.deepEqual(podcastMod.PODCAST_RATES, [0.75, 1.0, 1.25, 1.5, 2.0]);
  assert.equal(podcastMod.formatPodcastRate(0.75), '0.75x');
  assert.equal(podcastMod.formatPodcastRate(1.0), '1.0x');
  assert.equal(podcastMod.formatPodcastRate(1.25), '1.25x');
  assert.equal(podcastMod.formatPodcastRate(1.5), '1.5x');
  assert.equal(podcastMod.formatPodcastRate(2.0), '2.0x');
  assert.equal(podcastMod.formatPodcastTime(0), '00:00');
  assert.equal(podcastMod.formatPodcastTime(125), '02:05');
  assert.equal(podcastMod.formatPodcastTime(3661), '1:01:01');
  assert.equal(podcastMod.nextPodcastRate(1.0), 1.25);
  assert.equal(podcastMod.nextPodcastRate(2.0), 0.75);
  assert.equal(podcastMod.activeChapterIndex(sampleEpisodes[0].chapters, 50), 1);
  assert.equal(podcastMod.formatPodcastBytes(5 * 1024 * 1024), '5.0 MB');

  const browserMod = await import('file://' + path.join(resources, 'website-browser.js'));
  const parsedVenue = browserMod.parseConferenceVenue('conference:interspeech:2026:asr-42');
  assert.equal(parsedVenue.key, 'conference:interspeech:2026');
  assert.equal(parsedVenue.label, 'Interspeech 2026');
  assert.equal(parsedVenue.venue, 'interspeech');
  assert.equal(parsedVenue.year, 2026);
  // Canonical venue display parity & separator/case normalization (matching Swift/Kotlin/Portal)
  const venueParityCases = [
    ['conference:INTERSPEECH:2026:paper-02', 'Interspeech 2026'],
    ['conference:icassp:2026:999', 'ICASSP 2026'],
    ['conference:speech_prosody:2026:sp1', 'Speech Prosody 2026'],
    ['conference:speech-prosody:2026:sp2', 'Speech Prosody 2026'],
    ['conference:speechprosody:2026:sp3', 'Speech Prosody 2026'],
    ['conference:Speech-Prosody:2026:sp4', 'Speech Prosody 2026'],
    ['conference:waspaa:2025:w1', 'WASPAA 2025'],
    ['conference:asru:2025:a1', 'ASRU 2025'],
    ['conference:slt:2026:s1', 'SLT 2026'],
    ['conference:ismir:2026:i1', 'ISMIR 2026'],
    ['conference:dcase:2026:d1', 'DCASE 2026'],
    ['conference:taslp:2026:t1', 'TASLP 2026'],
    ['conference:ieee_acm_taslp:2026:t2', 'TASLP 2026'],
    ['conference:ieee-acm-taslp:2026:t3', 'TASLP 2026'],
    ['conference:ieee-acm_taslp:2026:t4', 'TASLP 2026'],
    ['conference:neurips:2025:abc', 'NeurIPS 2025'],
    ['conference:nips:2024:n1', 'NeurIPS 2024'],
    ['conference:icml:2026:m1', 'ICML 2026'],
    ['conference:iclr:2026:l1', 'ICLR 2026'],
    ['conference:acl:2026:acl1', 'ACL 2026'],
    ['conference:emnlp:2026:e1', 'EMNLP 2026'],
    ['conference:naacl:2026:na1', 'NAACL 2026'],
    ['conference:aaai:2026:aa1', 'AAAI 2026'],
    ['conference:ijcai:2026:ij1', 'IJCAI 2026'],
    ['conference:cvpr:2026:cv1', 'CVPR 2026'],
    ['conference:iccv:2025:ic1', 'ICCV 2025'],
    ['conference:eccv:2026:ec1', 'ECCV 2026'],
    ['conference:acmmm:2026:mm1', 'ACM MM 2026'],
    ['conference:acm_mm:2026:mm2', 'ACM MM 2026'],
    ['conference:acm-mm:2026:mm3', 'ACM MM 2026'],
    ['conference:mm:2026:mm4', 'ACM MM 2026'],
    ['conference:siggraph:2026:sg1', 'SIGGRAPH 2026'],
    ['conference:chi:2026:ch1', 'CHI 2026'],
    ['conference:ubicomp:2026:ub1', 'UbiComp 2026'],
    ['conference:mobicom:2026:mc1', 'MobiCom 2026'],
    ['conference:mobisys:2026:ms1', 'MobiSys 2026'],
    ['conference:sensys:2026:sn1', 'SenSys 2026'],
    ['conference:odyssey:2026:od1', 'Odyssey 2026'],
    ['conference:lrec:2026:lr1', 'LREC 2026'],
    ['conference:coling:2026:co1', 'COLING 2026'],
    ['conference:eacl:2026:ea1', 'EACL 2026'],
    ['conference:kdd:2026:kd1', 'KDD 2026'],
    ['conference:www:2026:ww1', 'WWW 2026'],
    ['conference:icra:2026:ir1', 'ICRA 2026'],
    ['conference:iros:2026:io1', 'IROS 2026'],
    ['conference:corl:2026:cl1', 'CoRL 2026'],
    ['conference:jmlr:2026:jm1', 'JMLR 2026'],
    ['conference:tmlr:2026:tm1', 'TMLR 2026'],
    ['conference:tacl:2026:ta1', 'TACL 2026'],
    ['conference:spl:2026:sp5', 'SPL 2026'],
    ['conference:dafx:2026:df1', 'DAFx 2026'],
    ['conference:chime:2026:cm1', 'CHiME 2026'],
    ['conference:custom_venue:2026:u1', 'CUSTOM_VENUE 2026'],
  ];
  for (const [paperId, expectedLabel] of venueParityCases) {
    assert.equal(browserMod.parseConferenceVenue(paperId)?.label, expectedLabel, `Venue parity for ${paperId}`);
  }
  // #11: prototype-chain defense
  assert.equal(browserMod.parseConferenceVenue('conference:constructor:2026:1').label, 'CONSTRUCTOR 2026');
  assert.equal(browserMod.resolvePaperResources({id: 'toString'}, {resourceBadges: {}}).pills.length, 0);
  // #2: cross-repo bare/versioned arXiv paperId canonical lookup
  assert.equal(browserMod.resolvePaperByCanonicalId(samplePapers, 'arxiv:2611.00001').id, 'arxiv:2611.00001');
  assert.equal(browserMod.resolvePaperByCanonicalId(samplePapers, '2611.00001v1').id, 'arxiv:2611.00001');
  assert.equal(browserMod.resolvePaperByCanonicalId(samplePapers, '2611.00001').id, 'arxiv:2611.00001');
  assert.equal(browserMod.resolvePaperByCanonicalId(samplePapers, 'conference:interspeech:2026:asr-42').id, 'conference:interspeech:2026:asr-42');
  // #19: query token dedup & 32-token cap
  const capped = browserMod.tokenizeQuery(Array.from({length: 45}, (_, i) => `k${i} k${i}`).join(' '));
  assert.equal(capped.length, 32);
  assert.equal(browserMod.scoreTierInfo(8.6).tier, 'featured');
  assert.equal(browserMod.scoreTierInfo(7.3).tier, 'high');
  assert.equal(browserMod.scoreTierInfo(6.2).tier, 'good');
  assert.deepEqual(browserMod.tokenizeQuery('  ＴＴＳ   Codec  '), ['tts', 'codec']);

  // Verify index.html CSP is intact (no media-src / no unsafe-inline script)
  const indexHTML = fs.readFileSync(path.join(resources, 'index.html'), 'utf8');
  assert.ok(indexHTML.includes("default-src 'self'"), 'index.html preserves strict CSP');
  assert.ok(!indexHTML.includes('media-src'), 'CSP must not be weakened with media-src');

  const browser = await chromium.launch({headless: true});
  try {
    // Scenario 1: Podcast endpoint unavailable (404) -> dock remains hidden, zero errors
    const page1 = await browser.newPage();
    const errors1 = [];
    page1.on('pageerror', e => errors1.push(e.message));
    await page1.addInitScript(({papers}) => {
      window.__calls = [];
      window.webkit = {
        messageHandlers: {
          desktop: {
            postMessage: async ({command, payload = {}}) => {
              window.__calls.push({command, payload});
              switch (command) {
                case 'app.bootstrap':
                  return {
                    nativePodcast: true,
                    nativeResourceBadges: true,
                    personal: {favorites: [], reading: [], notes: {}, sessions: [], readingState: {}, annotations: {}},
                    settings: {appearance: 'light', font: 18, endpoint: '', model: '', protocol: 'auto', maxTokens: 8192, dailyRequests: 50, syncHours: 12, httpProxy: '', reduceMotion: true, hasKey: false},
                    paper: null,
                    library: {paperCount: papers.length, recordCount: papers.length},
                  };
                case 'podcast.feed':
                  return {available: false, episodes: [], activeEpisodeId: null, isPlaying: false, currentTime: 0, duration: 0, rate: 1.0, cachedEpisodeIds: [], cachedBytes: 0};
                case 'library.resourceBadges':
                  return {available: false, papers: {}, cachedDemoIds: ['arxiv:2611.00003']};
                case 'library.list':
                  return {papers, count: papers.length, total: papers.length, totalInLibrary: papers.length, snapshotID: 'snap-1'};
                case 'library.tagIndex':
                  return {papers: {}, count: 0, snapshotID: 'snap-1', websiteTaxonomy: null};
                case 'aggregates.list':
                  return {records: [], available: false};
                case 'personal.snapshot':
                  return {favorites: [], reading: [], notes: {}, sessions: [], readingState: {}, annotations: {}};
                case 'personal.noteConflicts':
                  return {conflicts: []};
                default:
                  return {};
              }
            },
          },
        },
      };
    }, {papers: samplePapers});

    await page1.goto(url, {waitUntil: 'networkidle'});
    await page1.waitForTimeout(200);
    assert.equal(await page1.locator('#podcast-dock').isHidden(), true, 'Podcast dock stays hidden when feed is 404/unavailable');
    assert.deepEqual(errors1, [], 'Zero page errors on 404 podcast feed');

    // Verify v1.5 library filters in Scenario 1 (conference venue, score preset, resource filter, relevance sort)
    await page1.click('.nav-item[data-view="library"]');
    await page1.waitForSelector('#library-filter-toggle');
    await page1.click('#library-filter-toggle');
    await page1.waitForSelector('#library-venue');
    const venueOptions = await page1.locator('#library-venue option').allTextContents();
    assert.ok(venueOptions.some(t => t.includes('Interspeech 2026')), `Venue dropdown populated: ${venueOptions.join(', ')}`);
    await page1.selectOption('#library-venue', 'conference:interspeech:2026');
    await page1.waitForTimeout(100);
    assert.equal(await page1.locator('#paper-rows tr[data-library-row]').count(), 1, 'Conference venue filter leaves 1 Interspeech paper');
    await page1.selectOption('#library-venue', '');

    await page1.click('.library-score-preset[data-score-preset="8"]');
    await page1.waitForTimeout(100);
    assert.equal(await page1.locator('#paper-rows tr[data-library-row]').count(), 1, 'Featured >= 8.0 preset leaves 1 paper');
    await page1.click('.library-score-preset[data-score-preset="scored"]');
    await page1.waitForTimeout(100);
    assert.equal(await page1.locator('#paper-rows tr[data-library-row]').count(), 2, 'Scored-only preset excludes unscored paper');
    await page1.click('.library-score-preset[data-score-preset=""]');

    await page1.selectOption('#library-resource', 'demo');
    await page1.waitForTimeout(100);
    assert.equal(await page1.locator('#paper-rows tr[data-library-row]').count(), 1, 'Resource filter demo matches cachedDemoIds paper');
    await page1.selectOption('#library-resource', '');

    await page1.fill('#search-input', 'ＴＴＳ');
    await page1.waitForTimeout(300);
    const relHidden = await page1.locator('#sort option[value="relevance"]').evaluate(el => el.hidden);
    assert.equal(relHidden, false, 'Relevance sort option becomes visible when query is non-empty');
    await page1.selectOption('#sort', 'relevance');
    await page1.waitForTimeout(100);
    const firstRowId = await page1.locator('#paper-rows tr[data-library-row]:first-child').getAttribute('data-library-row');
    assert.equal(firstRowId, 'arxiv:2611.00001', 'Relevance sort puts title match first');
    await page1.close();

    // Scenario 2: Podcast feed available -> full playback controls, chapters, jump-to-paper, download, clearCache
    const page2 = await browser.newPage();
    const errors2 = [];
    page2.on('pageerror', e => errors2.push(e.message));
    await page2.addInitScript(({papers, episodes}) => {
      window.__calls = [];
      let pState = {
        available: true,
        episodes: structuredClone(episodes),
        activeEpisodeId: null,
        downloadingEpisodeId: null,
        isPlaying: false,
        currentTime: 0,
        duration: 300,
        rate: 1.0,
        cachedEpisodeIds: [],
        cachedBytes: 0,
      };
      window.webkit = {
        messageHandlers: {
          desktop: {
            postMessage: async ({command, payload = {}}) => {
              window.__calls.push({command, payload});
              switch (command) {
                case 'app.bootstrap':
                  return {
                    nativePodcast: true,
                    nativeResourceBadges: true,
                    personal: {favorites: [], reading: [], notes: {}, sessions: [], readingState: {}, annotations: {}},
                    settings: {appearance: 'light', font: 18, endpoint: '', model: '', protocol: 'auto', maxTokens: 8192, dailyRequests: 50, syncHours: 12, httpProxy: '', reduceMotion: true, hasKey: false},
                    paper: null,
                    library: {paperCount: papers.length, recordCount: papers.length},
                  };
                case 'podcast.feed':
                  return structuredClone(pState);
                case 'podcast.play':
                  pState.activeEpisodeId = payload.episodeId || pState.episodes[0].id;
                  pState.isPlaying = true;
                  pState.currentTime = Number(payload.startSeconds || 0);
                  pState.cachedEpisodeIds = [pState.activeEpisodeId];
                  pState.cachedBytes = 4194304;
                  pState.episodes[0].cached = true;
                  return structuredClone(pState);
                case 'podcast.pause':
                  pState.isPlaying = false;
                  return structuredClone(pState);
                case 'podcast.rate':
                  pState.rate = payload.rate;
                  return structuredClone(pState);
                case 'podcast.seek':
                  pState.currentTime = payload.seconds;
                  return structuredClone(pState);
                case 'podcast.download':
                  pState.cachedEpisodeIds = [payload.episodeId];
                  pState.cachedBytes = 4194304;
                  pState.episodes[0].cached = true;
                  return structuredClone(pState);
                case 'podcast.clearCache':
                  pState.cachedEpisodeIds = [];
                  pState.cachedBytes = 0;
                  pState.isPlaying = false;
                  pState.activeEpisodeId = null;
                  pState.episodes[0].cached = false;
                  return structuredClone(pState);
                case 'library.resourceBadges':
                  return {available: false, papers: {}, cachedDemoIds: []};
                case 'library.list':
                  return {papers, count: papers.length, total: papers.length, totalInLibrary: papers.length, snapshotID: 'snap-1'};
                case 'library.paperDetail':
                  return {paper: papers.find(p => p.id === payload.paperID) || papers[0], snapshotID: 'snap-1'};
                case 'library.article':
                  return {paperID: payload.paperID, markdown: '# Fixture paper\n\nBody.', html: '', revisionSHA256: 'b'.repeat(64), completeOffline: true, resources: [], notices: []};
                case 'library.tagIndex':
                  return {papers: {}, count: 0, snapshotID: 'snap-1', websiteTaxonomy: null};
                case 'aggregates.list':
                  return {records: [], available: false};
                case 'personal.snapshot':
                  return {favorites: [], reading: [], notes: {}, sessions: [], readingState: {}, annotations: {}};
                case 'personal.noteConflicts':
                  return {conflicts: []};
                case 'personal.annotations':
                  return {annotations: []};
                default:
                  return {};
              }
            },
          },
        },
      };
    }, {papers: samplePapers, episodes: sampleEpisodes});

    await page2.goto(url, {waitUntil: 'networkidle'});
    await page2.waitForSelector('#podcast-toggle-play');
    assert.equal(await page2.locator('#podcast-dock').isVisible(), true, 'Podcast dock is visible when feed has episodes');

    // Play -> check 1.0x label (#13) -> in-place progress tick (#14) -> Rate -> Chapters Drawer -> Chapter Seek -> Jump to Paper (#2 bare/versioned ID) -> Clear Cache
    assert.equal((await page2.locator('#podcast-rate-btn').innerText()).trim(), '1.0x');
    await page2.click('#podcast-toggle-play');
    await page2.waitForTimeout(80);
    assert.equal(await page2.locator('#podcast-toggle-play').getAttribute('aria-label'), '暂停播客');

    // #14: verify progress-only tick patches in place without replacing #podcast-scrubber DOM node
    const inPlacePreserved = await page2.evaluate(() => {
      const before = document.querySelector('#podcast-scrubber');
      window.dispatchEvent(new CustomEvent('podcast.state', {detail: {currentTime: 52, duration: 300, isPlaying: true}}));
      const after = document.querySelector('#podcast-scrubber');
      return before === after && after.value === '52' && document.querySelector('#podcast-time').textContent.includes('00:52');
    });
    assert.equal(inPlacePreserved, true, 'Progress tick must patch #podcast-scrubber in place without DOM rebuild');

    // Round-5 P2 (#9): scrubbing flag must reset on mid-drag DOM re-render and on pointercancel
    const scrubberRecovered = await page2.evaluate(() => {
      const el1 = document.querySelector('#podcast-scrubber');
      el1.value = '80';
      el1.dispatchEvent(new Event('input', {bubbles: true}));
      // Structural change mid-drag replaces dock.innerHTML
      window.dispatchEvent(new CustomEvent('podcast.state', {detail: {error: '临时提示', currentTime: 85, duration: 300, isPlaying: true}}));
      window.dispatchEvent(new CustomEvent('podcast.state', {detail: {error: null, currentTime: 95, duration: 300, isPlaying: true}}));
      const afterRebuildVal = document.querySelector('#podcast-scrubber').value;
      const afterRebuildTime = document.querySelector('#podcast-time').textContent;
      // Now test pointercancel mid-drag
      const el2 = document.querySelector('#podcast-scrubber');
      el2.value = '100';
      el2.dispatchEvent(new Event('input', {bubbles: true}));
      el2.dispatchEvent(new Event('pointercancel'));
      window.dispatchEvent(new CustomEvent('podcast.state', {detail: {currentTime: 110, duration: 300, isPlaying: true}}));
      const afterCancelVal = document.querySelector('#podcast-scrubber').value;
      const afterCancelTime = document.querySelector('#podcast-time').textContent;
      return {afterRebuildVal, afterRebuildTime, afterCancelVal, afterCancelTime};
    });
    assert.equal(scrubberRecovered.afterRebuildVal, '95', 'Scrubber resumes updating after mid-drag DOM rebuild');
    assert.ok(scrubberRecovered.afterRebuildTime.includes('01:35'), 'Elapsed time resumes updating after mid-drag DOM rebuild');
    assert.equal(scrubberRecovered.afterCancelVal, '110', 'Scrubber resumes updating after pointercancel');
    assert.ok(scrubberRecovered.afterCancelTime.includes('01:50'), 'Elapsed time resumes updating after pointercancel');

    // Round-5 P2 (#11): library.changed refreshes optional signals (resourceBadges + podcast feed with refresh=true)
    const callsBeforeChanged = await page2.evaluate(() => window.__calls.length);
    await page2.evaluate(() => window.dispatchEvent(new CustomEvent('library.changed')));
    await page2.waitForTimeout(120);
    const callsAfterChanged = await page2.evaluate(n => window.__calls.slice(n), callsBeforeChanged);
    assert.ok(callsAfterChanged.some(c => c.command === 'library.resourceBadges' && c.payload?.refresh === true), 'library.changed refreshes library.resourceBadges with refresh=true');
    assert.ok(callsAfterChanged.some(c => c.command === 'podcast.feed' && c.payload?.refresh === true), 'library.changed refreshes podcast.feed with refresh=true');

    await page2.click('#podcast-rate-btn');
    await page2.waitForTimeout(80);
    assert.equal((await page2.locator('#podcast-rate-btn').innerText()).trim(), '1.25x');

    await page2.click('#podcast-chapters-btn');
    await page2.waitForSelector('#podcast-drawer:not([hidden])');
    await page2.click('[data-podcast-chapter-start="45"]');
    await page2.waitForTimeout(80);
    assert.ok((await page2.locator('#podcast-time').innerText()).includes('00:45'), 'Chapter jump seeks to 00:45');

    // #2: chapter uses real producer versioned arXiv ID "2611.00001v1", must resolve to "arxiv:2611.00001"
    await page2.click('[data-podcast-paper-id="2611.00001v1"]');
    await page2.waitForTimeout(150);
    const calls = await page2.evaluate(() => window.__calls);
    assert.ok(calls.some(c => c.command === 'library.article' && c.payload.paperID === 'arxiv:2611.00001'), 'Jump-to-paper resolves versioned arXiv ID to canonical arxiv: paper');

    await page2.click('#podcast-clear-cache');
    await page2.waitForTimeout(80);
    const callsAfterClear = await page2.evaluate(() => window.__calls);
    assert.ok(callsAfterClear.some(c => c.command === 'podcast.clearCache'), 'clearCache command dispatched');
    assert.deepEqual(errors2, [], 'Zero page errors during full podcast flow');
    await page2.close();

    // Scenario 3: Multi-episode switching via #podcast-episode-select while playing, ticking, and paused
    const multiEpisodes = [
      ...sampleEpisodes,
      {
        id: 'daily-2026-11-23',
        date: '2026-11-23',
        title: '2026-11-23 音频论文速递播客（第 B 期）',
        summary: '第二期测试节目简介。',
        audioUrl: 'https://github.com/nanless/audio-paper-digest/releases/download/podcast-2026-11-23/daily-2026-11-23.mp3',
        bytes: 3145728,
        sha256: 'b'.repeat(64),
        durationSeconds: 240,
        mimeType: 'audio/mpeg',
        cached: false,
        chapters: [
          {title: '第 B 期开场', startSeconds: 0, endSeconds: 60, paperId: null},
          {title: 'Audio Synthesis Overview', startSeconds: 60, endSeconds: 240, paperId: 'arxiv:2611.00003'},
        ],
        paperIds: ['arxiv:2611.00003'],
      },
    ];
    const page3 = await browser.newPage();
    const errors3 = [];
    page3.on('pageerror', e => errors3.push(e.message));
    await page3.addInitScript(({papers, episodes}) => {
      window.__calls = [];
      let pState = {
        available: true,
        episodes: structuredClone(episodes),
        activeEpisodeId: null,
        downloadingEpisodeId: null,
        isPlaying: false,
        currentTime: 0,
        duration: 0,
        rate: 1.0,
        cachedEpisodeIds: [],
        cachedBytes: 0,
      };
      window.webkit = {
        messageHandlers: {
          desktop: {
            postMessage: async ({command, payload = {}}) => {
              window.__calls.push({command, payload});
              switch (command) {
                case 'app.bootstrap':
                  return {
                    nativePodcast: true,
                    nativeResourceBadges: true,
                    personal: {favorites: [], reading: [], notes: {}, sessions: [], readingState: {}, annotations: {}},
                    settings: {appearance: 'light', font: 18, endpoint: '', model: '', protocol: 'auto', maxTokens: 8192, dailyRequests: 50, syncHours: 12, httpProxy: '', reduceMotion: true, hasKey: false},
                    paper: null,
                    library: {paperCount: papers.length, recordCount: papers.length},
                  };
                case 'podcast.feed':
                  return structuredClone(pState);
                case 'podcast.play': {
                  const target = pState.episodes.find(e => e.id === payload.episodeId) || pState.episodes[0];
                  pState.activeEpisodeId = target.id;
                  pState.isPlaying = true;
                  pState.currentTime = Number(payload.startSeconds || 0);
                  pState.duration = target.durationSeconds;
                  target.cached = true;
                  if (!pState.cachedEpisodeIds.includes(target.id)) pState.cachedEpisodeIds.push(target.id);
                  pState.cachedBytes = pState.episodes.filter(e => e.cached).reduce((a, e) => a + e.bytes, 0);
                  return structuredClone(pState);
                }
                case 'podcast.pause':
                  pState.isPlaying = false;
                  return structuredClone(pState);
                case 'library.resourceBadges':
                  return {available: false, papers: {}, cachedDemoIds: []};
                case 'library.list':
                  return {papers, count: papers.length, total: papers.length, totalInLibrary: papers.length, snapshotID: 'snap-1'};
                case 'library.tagIndex':
                  return {papers: {}, count: 0, snapshotID: 'snap-1', websiteTaxonomy: null};
                case 'aggregates.list':
                  return {records: [], available: false};
                case 'personal.snapshot':
                  return {favorites: [], reading: [], notes: {}, sessions: [], readingState: {}, annotations: {}};
                case 'personal.noteConflicts':
                  return {conflicts: []};
                default:
                  return {};
              }
            },
          },
        },
      };
    }, {papers: samplePapers, episodes: multiEpisodes});

    await page3.goto(url, {waitUntil: 'networkidle'});
    await page3.waitForSelector('#podcast-episode-select');

    // Start playing Episode A
    await page3.click('#podcast-toggle-play');
    await page3.waitForTimeout(80);
    assert.equal(await page3.locator('#podcast-toggle-play').getAttribute('aria-label'), '暂停播客');
    assert.ok((await page3.locator('.podcast-episode-title').innerText()).includes('2026-11-24'));

    // Select Episode B while Episode A is actively playing
    await page3.selectOption('#podcast-episode-select', 'daily-2026-11-23');
    await page3.waitForTimeout(60);
    assert.equal(await page3.locator('#podcast-episode-select').inputValue(), 'daily-2026-11-23', 'Episode selector stays on Episode B while Episode A plays');
    assert.ok((await page3.locator('.podcast-episode-title').innerText()).includes('第 B 期'), 'Displayed title switches to Episode B');
    assert.equal(await page3.locator('#podcast-toggle-play').getAttribute('aria-label'), '播放播客', 'Play button shows Play for newly selected non-active Episode B');

    // Background progress tick for Episode A must NOT snap displayed selection back to Episode A
    await page3.evaluate(() => {
      window.dispatchEvent(new CustomEvent('podcast.state', {
        detail: {activeEpisodeId: 'daily-2026-11-24', isPlaying: true, currentTime: 35, duration: 300},
      }));
    });
    await page3.waitForTimeout(50);
    assert.equal(await page3.locator('#podcast-episode-select').inputValue(), 'daily-2026-11-23', 'Progress tick for Episode A preserves selected Episode B');
    assert.ok((await page3.locator('.podcast-episode-title').innerText()).includes('第 B 期'), 'Displayed episode remains Episode B after tick');

    // Clicking Play on Episode B must switch native playback to Episode B
    await page3.click('#podcast-toggle-play');
    await page3.waitForTimeout(80);
    assert.equal(await page3.locator('#podcast-toggle-play').getAttribute('aria-label'), '暂停播客', 'Episode B is now playing');
    const playCalls1 = await page3.evaluate(() => window.__calls.filter(c => c.command === 'podcast.play'));
    assert.equal(playCalls1.at(-1).payload.episodeId, 'daily-2026-11-23', 'Play dispatches podcast.play for Episode B');

    // Pause Episode B, then select Episode A and click Play -> must switch playback back to Episode A
    await page3.click('#podcast-toggle-play');
    await page3.waitForTimeout(80);
    assert.equal(await page3.locator('#podcast-toggle-play').getAttribute('aria-label'), '播放播客', 'Episode B paused');
    await page3.selectOption('#podcast-episode-select', 'daily-2026-11-24');
    await page3.waitForTimeout(60);
    assert.ok((await page3.locator('.podcast-episode-title').innerText()).includes('2026-11-24'), 'Displayed title switches back to Episode A while Episode B is paused');
    await page3.click('#podcast-toggle-play');
    await page3.waitForTimeout(80);
    const playCalls2 = await page3.evaluate(() => window.__calls.filter(c => c.command === 'podcast.play'));
    assert.equal(playCalls2.at(-1).payload.episodeId, 'daily-2026-11-24', 'Play switches playback to Episode A from paused Episode B');

    // Playback completion clears activeEpisodeId cleanly while keeping selected episode usable
    await page3.evaluate(() => {
      window.dispatchEvent(new CustomEvent('podcast.state', {
        detail: {activeEpisodeId: null, isPlaying: false, currentTime: 0, duration: 0},
      }));
    });
    await page3.waitForTimeout(50);
    assert.equal(await page3.locator('#podcast-toggle-play').getAttribute('aria-label'), '播放播客');
    assert.ok((await page3.locator('.podcast-episode-title').innerText()).includes('2026-11-24'));
    assert.deepEqual(errors3, [], 'Zero page errors during multi-episode switching flow');
    await page3.close();
  } finally {
    await browser.close();
    server.close();
  }
  console.log('PodcastUI.test.cjs: ALL CHECKS PASSED');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
