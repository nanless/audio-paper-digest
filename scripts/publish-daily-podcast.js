#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    CHILD_ENV_PASSTHROUGH_KEYS,
    requireExternalRuntime,
    loadProjectEnv
} = require('./env-loader.js');
const {
    buildDailyPodcastScript,
    DEFAULT_MAX_HIGHLIGHTS,
    DEFAULT_BLOG_BASE_URL
} = require('./lib/daily-podcast-script.js');
const {
    DEFAULT_PODCAST_GITHUB_REPO,
    DEFAULT_RELEASE_TAG_PREFIX,
    DEFAULT_TAG_GROUPING,
    resolvePodcastGitHubRepo,
    buildReleaseTag,
    validateAssetFileName,
    buildReleaseDownloadUrl,
    publishPodcastToGitHubRelease,
    buildPodcastEpisodeMetadata,
    buildClientPodcastFeedJson,
    buildPodcast2ChaptersJson,
    buildPodcastRssXml,
    validateIsoDate,
    validateTagPrefix,
    validateTagGrouping
} = require('./lib/podcast-github-release.js');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ANALYSIS_INPUT = path.join(PROJECT_ROOT, 'data', 'current', 'deep-analysis-result.json');
const DEFAULT_EPISODES_DIR = path.join(PROJECT_ROOT, 'data', 'runtime', 'daily-podcast');
const PYTHON_RUNTIME_SH = path.join(__dirname, 'python-runtime.sh');
const INDEXTTS_SYNTH_PY = path.join(__dirname, 'indextts_synth.py');

const SYNTH_ALLOWED_ENV_KEYS = Object.freeze([
    'PD_INDEXTTS_MODEL_DIR',
    'PD_INDEXTTS_CFG_PATH',
    'PD_INDEXTTS_VOICE_PROMPT',
    'PD_INDEXTTS_COHOST_VOICE_PROMPT',
    'PD_INDEXTTS_ENDPOINT',
    'PD_INDEXTTS_API_KEY',
    'PD_INDEXTTS_MODEL',
    'PD_INDEXTTS_ALLOW_LOCAL_ENDPOINT'
]);

const GH_ALLOWED_ENV_KEYS = Object.freeze([
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_HOST',
    'GH_CONFIG_DIR',
    'XDG_CONFIG_HOME',
    'SSH_AUTH_SOCK',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy'
]);

const CHECK_ENV_TIMEOUT_MS = 30000;
const DEFAULT_SYNTH_TIMEOUT_MS = 1800000; // 30 min for long local GPU/CPU TTS runs

/**
 * Construct a strictly allowlisted child process environment.
 * NEVER spreads raw process.env or arbitrary caller env objects.
 */
function pickAllowedChildEnv(sourceEnv = process.env, extraAllowedKeys = []) {
    const out = {};
    const allowlist = new Set([
        ...CHILD_ENV_PASSTHROUGH_KEYS,
        'CODEX_SANDBOX',
        ...extraAllowedKeys
    ]);
    const src = sourceEnv && typeof sourceEnv === 'object' ? sourceEnv : {};
    for (const key of allowlist) {
        if (Object.prototype.hasOwnProperty.call(src, key) && src[key] !== undefined) {
            out[key] = String(src[key]);
        }
    }
    return out;
}

function writeFileAtomic(targetPath, content) {
    const resolved = path.resolve(targetPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const tmp = `${resolved}.tmp.${process.pid}.${crypto.randomUUID()}`;
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
    let fd;
    try {
        fd = fs.openSync(tmp, flags, 0o600);
        const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
        let offset = 0;
        while (offset < bytes.length) {
            offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
        }
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        if (process.platform !== 'win32') {
            fs.chmodSync(tmp, 0o600);
        }
        fs.renameSync(tmp, resolved);
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch (_) { /* ignore */ }
        }
        try { fs.unlinkSync(tmp); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
    }
}

function parseCliArgs(argv) {
    const opts = {
        date: null,
        input: DEFAULT_ANALYSIS_INPUT,
        outDir: null,
        metadataOut: null,
        rssOut: null,
        clientFeedOut: null,
        chaptersOut: null,
        episodesDir: null,
        cacheDir: null,
        backend: 'indextts2-python',
        device: 'auto',
        modelDir: null,
        cfgPath: null,
        voicePrompt: null,
        cohostVoicePrompt: null,
        emoAlpha: 0.75,
        endpoint: null,
        httpMode: 'auto',
        httpModel: null,
        allowLocalEndpoint: false,
        format: 'mp3',
        maxHighlights: DEFAULT_MAX_HIGHLIGHTS,
        includeCohost: true,
        repo: null,
        tagPrefix: null,
        tagGrouping: null,
        blogBaseUrl: process.env.PAPER_DIGEST_BLOG_URL || DEFAULT_BLOG_BASE_URL,
        feedUrl: null,
        chaptersBaseUrl: null,
        publishedAt: null,
        mockSecondsPerChunk: null,
        dryRun: false,
        localOnly: false,
        checkEnv: false,
        help: false
    };

    const args = Array.from(argv || []);
    const requireValue = (flag, idx) => {
        if (idx + 1 >= args.length) {
            throw new Error(`Missing value for CLI flag ${flag}`);
        }
        return args[idx + 1];
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        switch (arg) {
            case '--help':
            case '-h':
                opts.help = true;
                break;
            case '--check-env':
                opts.checkEnv = true;
                break;
            case '--dry-run':
                opts.dryRun = true;
                break;
            case '--local-only':
                opts.localOnly = true;
                break;
            case '--allow-local-endpoint':
                opts.allowLocalEndpoint = true;
                break;
            case '--single-host':
                opts.includeCohost = false;
                break;
            case '--date':
                opts.date = requireValue(arg, i++);
                break;
            case '--input':
                opts.input = requireValue(arg, i++);
                break;
            case '--out-dir':
                opts.outDir = requireValue(arg, i++);
                break;
            case '--metadata-out':
                opts.metadataOut = requireValue(arg, i++);
                break;
            case '--rss-out':
                opts.rssOut = requireValue(arg, i++);
                break;
            case '--client-feed-out':
                opts.clientFeedOut = requireValue(arg, i++);
                break;
            case '--chapters-out':
                opts.chaptersOut = requireValue(arg, i++);
                break;
            case '--episodes-dir':
                opts.episodesDir = requireValue(arg, i++);
                break;
            case '--portal-repo':
                opts.portalRepo = requireValue(arg, i++);
                break;
            case '--cache-dir':
                opts.cacheDir = requireValue(arg, i++);
                break;
            case '--backend':
                opts.backend = requireValue(arg, i++);
                break;
            case '--device':
                opts.device = requireValue(arg, i++);
                break;
            case '--model-dir':
                opts.modelDir = requireValue(arg, i++);
                break;
            case '--cfg-path':
                opts.cfgPath = requireValue(arg, i++);
                break;
            case '--voice-prompt':
                opts.voicePrompt = requireValue(arg, i++);
                break;
            case '--cohost-voice-prompt':
                opts.cohostVoicePrompt = requireValue(arg, i++);
                break;
            case '--emo-alpha': {
                const rawVal = requireValue(arg, i++);
                const parsed = Number.parseFloat(rawVal);
                if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1.5) {
                    throw new Error(`Invalid --emo-alpha "${rawVal}"; expected finite number in [0, 1.5]`);
                }
                opts.emoAlpha = parsed;
                break;
            }
            case '--endpoint':
                opts.endpoint = requireValue(arg, i++);
                break;
            case '--http-mode':
                opts.httpMode = requireValue(arg, i++);
                break;
            case '--http-model':
                opts.httpModel = requireValue(arg, i++);
                break;
            case '--format':
                opts.format = requireValue(arg, i++);
                break;
            case '--max-highlights': {
                const rawVal = requireValue(arg, i++);
                const parsed = Number.parseInt(rawVal, 10);
                if (!Number.isInteger(parsed) || String(parsed) !== rawVal.trim() || parsed < 1 || parsed > 10) {
                    throw new Error(`Invalid --max-highlights "${rawVal}"; expected integer in [1, 10]`);
                }
                opts.maxHighlights = parsed;
                break;
            }
            case '--repo':
                opts.repo = requireValue(arg, i++);
                break;
            case '--tag-prefix':
                opts.tagPrefix = requireValue(arg, i++);
                break;
            case '--tag-grouping':
                opts.tagGrouping = requireValue(arg, i++);
                break;
            case '--blog-base-url':
                opts.blogBaseUrl = requireValue(arg, i++);
                break;
            case '--feed-url':
                opts.feedUrl = requireValue(arg, i++);
                break;
            case '--chapters-base-url':
                opts.chaptersBaseUrl = requireValue(arg, i++);
                break;
            case '--published-at':
                opts.publishedAt = requireValue(arg, i++);
                break;
            case '--mock-seconds-per-chunk': {
                const rawVal = requireValue(arg, i++);
                const parsed = Number.parseFloat(rawVal);
                if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 60) {
                    throw new Error(`Invalid --mock-seconds-per-chunk "${rawVal}"; expected finite number in (0, 60]`);
                }
                opts.mockSecondsPerChunk = parsed;
                break;
            }
            default:
                if (arg.startsWith('-')) {
                    throw new Error(`Unknown CLI flag: ${arg}`);
                }
                if (!opts.date && /^\d{4}-\d{2}-\d{2}$/.test(arg)) {
                    opts.date = arg;
                } else {
                    throw new Error(`Unexpected positional argument: ${arg}`);
                }
                break;
        }
    }
    return opts;
}

function formatUsage() {
    return [
        'Usage: node scripts/publish-daily-podcast.js [options]',
        '',
        'Options:',
        '  --date YYYY-MM-DD            Target digest date (inferred from input JSON if omitted)',
        '  --input <path>               Path to deep-analysis-result.json',
        '  --out-dir <dir>              Directory for generated podcast artifacts',
        '  --metadata-out <path>        Override path for episode metadata JSON',
        '  --rss-out <path>             Override path for Podcast 2.0 RSS XML',
        '  --client-feed-out <path>     Override path for Wave 14.5 client feed JSON (paper-daily-podcast-feed)',
        '  --episodes-dir <dir>         Directory of prior episode JSONs to merge into feeds (default: data/runtime/daily-podcast)',
        '  --portal-repo <dir>          Optional Hugo portal repo to sync static/feeds/podcast.xml, data/podcast-episodes.json, and static/client/podcast/feed.json',
        '  --backend <mode>             indextts2-python | indextts-http | silent-mock',
        '  --voice-prompt <wav>         Host reference WAV for IndexTTS-2.5 / 2.0',
        '  --cohost-voice-prompt <wav>  Optional cohost reference WAV',
        '  --repo <owner/repo>          GitHub Releases host repo (default: nanless/audio-research-portal)',
        '  --tag-prefix <prefix>        Release tag prefix (default: podcast)',
        '  --tag-grouping <mode>        monthly (podcast-YYYY-MM) | daily (podcast-YYYY-MM-DD)',
        '  --dry-run                    Synthesize & write metadata/feeds without uploading via gh',
        '  --local-only                 Local build only (skip GitHub Releases upload)',
        '  --check-env                  Check Python, PyTorch device, IndexTTS, and ffmpeg',
        '  --help                       Show this help text'
    ].join('\n');
}

function buildSynthCommandArgs({ scriptPath, outputAudioPath, manifestPath, cacheDir, options }) {
    const emoAlpha = options.emoAlpha === undefined ? 0.75 : Number(options.emoAlpha);
    if (!Number.isFinite(emoAlpha) || emoAlpha < 0 || emoAlpha > 1.5) {
        throw new Error(`Invalid emoAlpha: ${options.emoAlpha}`);
    }
    const args = [
        PYTHON_RUNTIME_SH,
        INDEXTTS_SYNTH_PY,
        '--script', scriptPath,
        '--output', outputAudioPath,
        '--manifest-out', manifestPath,
        '--backend', options.backend || 'indextts2-python',
        '--device', options.device || 'auto',
        '--emo-alpha', String(emoAlpha),
        '--format', options.format || 'mp3'
    ];
    if (cacheDir) args.push('--cache-dir', cacheDir);
    if (options.modelDir) args.push('--model-dir', options.modelDir);
    if (options.cfgPath) args.push('--cfg-path', options.cfgPath);
    if (options.voicePrompt) args.push('--voice-prompt', options.voicePrompt);
    if (options.cohostVoicePrompt) args.push('--cohost-voice-prompt', options.cohostVoicePrompt);
    if (options.endpoint) args.push('--endpoint', options.endpoint);
    if (options.httpMode) args.push('--http-mode', options.httpMode);
    if (options.httpModel) args.push('--http-model', options.httpModel);
    if (options.allowLocalEndpoint) args.push('--allow-local-endpoint');
    if (options.mockSecondsPerChunk !== null && options.mockSecondsPerChunk !== undefined
        && Number.isFinite(Number(options.mockSecondsPerChunk))) {
        args.push('--mock-seconds-per-chunk', String(options.mockSecondsPerChunk));
    }
    return args;
}

/**
 * Recursively load prior episode metadata JSON files from episodesDir (supporting both
 * `<dateStr>/*.episode.json` subdirectories and flat `*.json` layouts), skipping currentDate
 * and deduplicating by date in deterministic sorted relative-path order.
 */
function loadExistingEpisodes(episodesDir, currentDate) {
    if (!episodesDir || !fs.existsSync(episodesDir)) return [];
    const rootDir = path.resolve(episodesDir);
    const jsonFiles = [];
    const walk = (dir, depth) => {
        if (depth > 4) return;
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            if (entry.name.startsWith('.')) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath, depth + 1);
            } else if (entry.isFile() && entry.name.endsWith('.json')) {
                const rel = path.relative(rootDir, fullPath).split(path.sep).join('/');
                jsonFiles.push({ rel, fullPath });
            }
        }
    };
    walk(rootDir, 0);
    jsonFiles.sort((a, b) => a.rel.localeCompare(b.rel, 'en'));
    const byDate = new Map();
    for (const { fullPath } of jsonFiles) {
        try {
            const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
            if (parsed
                && (parsed.contract === 'daily-podcast-episode' || parsed.contract === 'daily-podcast-episode-v1')
                && typeof parsed.date === 'string'
                && parsed.date !== currentDate
                && (!parsed.publishStatus || parsed.publishStatus === 'published')) {
                byDate.set(parsed.date, parsed);
            }
        } catch {
            // Skip unrelated non-episode JSON files in episodesDir
        }
    }
    return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date, 'en'));
}

function buildChaptersReleaseUrl({ repo, tag, chaptersFileName }) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.chapters\.json$/.test(String(chaptersFileName || ''))) {
        throw new Error(`Invalid chapters asset filename: "${chaptersFileName}"`);
    }
    return `https://github.com/${repo}/releases/download/${tag}/${chaptersFileName}`;
}

function isSameGitHubReleaseChaptersBase(chaptersBaseUrl, repo, tag) {
    if (!chaptersBaseUrl) return true;
    try {
        const parsed = new URL(String(chaptersBaseUrl).trim());
        const expectedPath = `/${repo}/releases/download/${tag}`.replace(/\/+$/, '');
        return parsed.protocol === 'https:'
            && parsed.hostname.toLowerCase() === 'github.com'
            && !parsed.port
            && !parsed.search
            && !parsed.hash
            && !parsed.username
            && !parsed.password
            && parsed.pathname.replace(/\/+$/, '') === expectedPath;
    } catch {
        return false;
    }
}

function assertNotSymlinkPath(targetPath) {
    try {
        if (fs.lstatSync(targetPath).isSymbolicLink()) {
            throw new Error(`Refusing to write through symlink: ${targetPath}`);
        }
    } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
    }
}

function syncPodcastToPortalRepo({ portalRepo, rssXml, clientFeed }) {
    const resolvedPortal = path.resolve(String(portalRepo || ''));
    if (!fs.existsSync(resolvedPortal) || !fs.statSync(resolvedPortal).isDirectory()) {
        throw new Error(`Portal repository directory does not exist: ${resolvedPortal}`);
    }
    const rssTarget = path.join(resolvedPortal, 'static', 'feeds', 'podcast.xml');
    const dataEpisodesTarget = path.join(resolvedPortal, 'data', 'podcast-episodes.json');
    const clientFeedTarget = path.join(resolvedPortal, 'static', 'client', 'podcast', 'feed.json');
    const feedJsonText = `${JSON.stringify(clientFeed, null, 2)}\n`;
    for (const target of [rssTarget, dataEpisodesTarget, clientFeedTarget]) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        assertNotSymlinkPath(target);
    }
    writeFileAtomic(rssTarget, rssXml);
    writeFileAtomic(dataEpisodesTarget, feedJsonText);
    writeFileAtomic(clientFeedTarget, feedJsonText);
    return {
        portalRepo: resolvedPortal,
        rssPath: rssTarget,
        dataEpisodesPath: dataEpisodesTarget,
        clientFeedPath: clientFeedTarget
    };
}

function runCheckEnv({ execFileSyncFn = childProcess.execFileSync, env = process.env } = {}) {
    const childEnv = pickAllowedChildEnv(env, [
        'PD_INDEXTTS_MODEL_DIR',
        'PD_INDEXTTS_CFG_PATH',
        'PD_INDEXTTS_ENDPOINT'
    ]);
    const stdout = execFileSyncFn('bash', [PYTHON_RUNTIME_SH, INDEXTTS_SYNTH_PY, '--check-env'], {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        shell: false,
        timeout: CHECK_ENV_TIMEOUT_MS,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    return JSON.parse(String(stdout).trim());
}

/**
 * End-to-end daily podcast orchestrator (importable for unit & integration tests).
 */
function runDailyPodcastPipeline(options = {}, deps = {}) {
    const execFileSyncFn = deps.execFileSyncFn || childProcess.execFileSync;
    const ghExecFileSyncFn = deps.ghExecFileSyncFn || execFileSyncFn;
    const env = deps.env || process.env;

    const inputPath = path.resolve(options.input || DEFAULT_ANALYSIS_INPUT);
    if (!fs.existsSync(inputPath)) {
        throw new Error(`Analysis input JSON not found: ${inputPath}`);
    }
    const analysisData = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

    const blogBaseUrl = options.blogBaseUrl || env.PAPER_DIGEST_BLOG_URL || DEFAULT_BLOG_BASE_URL;
    const siteRoot = `${String(blogBaseUrl).replace(/\/posts\/?$/, '').replace(/\/+$/, '')}/`;

    const script = buildDailyPodcastScript(analysisData, {
        date: options.date || undefined,
        maxHighlights: options.maxHighlights ?? DEFAULT_MAX_HIGHLIGHTS,
        includeCohost: options.includeCohost !== false,
        blogBaseUrl,
        roundup: options.roundup
    });

    const dateStr = validateIsoDate(script.date);
    const tagPrefix = validateTagPrefix(
        options.tagPrefix || env.PD_PODCAST_RELEASE_TAG_PREFIX || DEFAULT_RELEASE_TAG_PREFIX
    );
    const tagGrouping = validateTagGrouping(
        options.tagGrouping || env.PD_PODCAST_RELEASE_TAG_GROUPING || DEFAULT_TAG_GROUPING
    );

    const outDir = path.resolve(
        options.outDir || path.join(PROJECT_ROOT, 'data', 'runtime', 'daily-podcast', dateStr)
    );
    fs.mkdirSync(outDir, { recursive: true });

    const scriptPath = path.join(outDir, `${tagPrefix}-${dateStr}.script.json`);
    const audioBaseExt = options.format === 'wav' ? 'wav' : 'mp3';
    const targetAudioPath = path.join(outDir, `${tagPrefix}-${dateStr}.${audioBaseExt}`);
    const audioManifestPath = path.join(outDir, `${tagPrefix}-${dateStr}.audio-manifest.json`);
    const cacheDir = options.cacheDir ? path.resolve(options.cacheDir) : path.join(outDir, '.indextts-cache');

    writeFileAtomic(scriptPath, `${JSON.stringify(script, null, 2)}\n`);

    const synthArgs = buildSynthCommandArgs({
        scriptPath,
        outputAudioPath: targetAudioPath,
        manifestPath: audioManifestPath,
        cacheDir,
        options
    });
    const synthEnv = pickAllowedChildEnv(env, SYNTH_ALLOWED_ENV_KEYS);
    execFileSyncFn('bash', synthArgs, {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        shell: false,
        timeout: options.synthTimeoutMs || DEFAULT_SYNTH_TIMEOUT_MS,
        env: synthEnv,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    if (!fs.existsSync(audioManifestPath)) {
        throw new Error(`IndexTTS synthesizer did not write audio manifest: ${audioManifestPath}`);
    }
    const audioManifest = JSON.parse(fs.readFileSync(audioManifestPath, 'utf8'));
    const requestedFormat = audioBaseExt;
    if (requestedFormat === 'mp3' && audioManifest.format !== 'mp3') {
        throw new Error(
            `Requested MP3 podcast output but synthesizer produced "${audioManifest.format || 'unknown'}" `
            + '(ffmpeg may be missing or failed). Pass --format wav explicitly only for WAV-only runs.'
        );
    }

    const chaptersFileName = `${tagPrefix}-${dateStr}.chapters.json`;

    const topThemesLabel = (script.topThemes || [])
        .slice(0, 3)
        .map(item => `${item.theme}(${item.count})`)
        .join('、');
    const description = topThemesLabel
        ? `${dateStr} 共深度分析 ${script.paperCount} 篇语音/音乐/音频论文，热点方向：${topThemesLabel}。`
        : `${dateStr} 共深度分析 ${script.paperCount} 篇语音/音乐/音频论文。`;
    const publishedAt = options.publishedAt || `${dateStr}T08:00:00+08:00`;
    const feedGeneratedAt = options.generatedAt || publishedAt;
    const requestedRepo = options.repo || env.PD_PODCAST_GITHUB_REPO || DEFAULT_PODCAST_GITHUB_REPO;

    // Load prior episodes and pre-validate both today's episode metadata and full RSS XML
    // BEFORE uploading to GitHub Releases so corrupt local/prior metadata fails cleanly
    // without stranding a remote release asset.
    const effectiveEpisodesDir = options.episodesDir === undefined ? DEFAULT_EPISODES_DIR : options.episodesDir;
    const priorEpisodes = loadExistingEpisodes(effectiveEpisodesDir, dateStr);
    const previewRepo = resolvePodcastGitHubRepo({ repo: requestedRepo, env });
    const previewTag = buildReleaseTag(dateStr, { tagPrefix, tagGrouping, env });
    const previewAssetName = validateAssetFileName(
        audioManifest.audioPath ? path.basename(path.resolve(String(audioManifest.audioPath))) : '',
        { date: dateStr, tagPrefix, allowedExtensions: requestedFormat === 'wav' ? ['mp3', 'wav'] : ['mp3'] }
    );
    const previewAudioUrl = buildReleaseDownloadUrl({
        repo: previewRepo,
        tag: previewTag,
        assetFileName: previewAssetName
    });
    const previewChaptersUrl = options.chaptersBaseUrl
        ? `${String(options.chaptersBaseUrl).replace(/\/+$/, '')}/${chaptersFileName}`
        : (!options.localOnly ? buildChaptersReleaseUrl({ repo: previewRepo, tag: previewTag, chaptersFileName }) : null);
    const preflightMetadata = buildPodcastEpisodeMetadata({
        date: dateStr,
        title: script.title,
        description,
        audioUrl: previewAudioUrl,
        audioBytes: audioManifest.audioBytes,
        audioSha256: audioManifest.audioSha256,
        durationSeconds: audioManifest.durationSeconds,
        mimeType: audioManifest.mimeType,
        ttsEngine: audioManifest.ttsEngine,
        chapters: audioManifest.chapters,
        episodePageUrl: script.digestUrl,
        chaptersUrl: previewChaptersUrl,
        publishedAt,
        releaseTag: previewTag,
        githubRepo: previewRepo,
        scriptSha256: script.scriptSha256,
        publishStatus: 'dry-run'
    });
    if (requestedFormat === 'mp3') {
        buildClientPodcastFeedJson([preflightMetadata], {
            generatedAt: feedGeneratedAt,
            skipIncompatible: false
        });
    }
    buildPodcastRssXml([preflightMetadata, ...priorEpisodes], {
        feedUrl: options.feedUrl || `${siteRoot}feeds/podcast.xml`,
        link: siteRoot
    });

    const ghEnv = pickAllowedChildEnv(env, GH_ALLOWED_ENV_KEYS);
    const releaseResult = publishPodcastToGitHubRelease({
        date: dateStr,
        assetPath: audioManifest.audioPath,
        expectedSha256: audioManifest.audioSha256,
        repo: requestedRepo,
        tagPrefix,
        tagGrouping,
        allowWav: requestedFormat === 'wav',
        dryRun: options.dryRun === true,
        localOnly: options.localOnly === true,
        cwd: PROJECT_ROOT,
        env,
        ghEnv,
        execFileSyncFn: ghExecFileSyncFn
    });

    const chaptersUrl = options.chaptersBaseUrl
        ? `${String(options.chaptersBaseUrl).replace(/\/+$/, '')}/${chaptersFileName}`
        : (!options.localOnly
            ? buildChaptersReleaseUrl({ repo: releaseResult.repo, tag: releaseResult.tag, chaptersFileName })
            : null);

    const episodeMetadata = buildPodcastEpisodeMetadata({
        date: dateStr,
        title: script.title,
        description,
        audioUrl: releaseResult.audioUrl,
        audioBytes: audioManifest.audioBytes,
        audioSha256: audioManifest.audioSha256,
        durationSeconds: audioManifest.durationSeconds,
        mimeType: audioManifest.mimeType,
        ttsEngine: audioManifest.ttsEngine,
        chapters: audioManifest.chapters,
        episodePageUrl: script.digestUrl,
        chaptersUrl,
        publishedAt,
        releaseTag: releaseResult.tag,
        githubRepo: releaseResult.repo,
        scriptSha256: script.scriptSha256,
        publishStatus: releaseResult.published ? 'published' : releaseResult.action
    });

    const chaptersJson = buildPodcast2ChaptersJson(episodeMetadata);
    const chaptersPath = path.resolve(options.chaptersOut || path.join(outDir, chaptersFileName));
    const metadataPath = path.resolve(options.metadataOut || path.join(outDir, `${tagPrefix}-${dateStr}.episode.json`));
    const rssPath = path.resolve(options.rssOut || path.join(outDir, 'podcast.xml'));
    const clientFeedPath = path.resolve(options.clientFeedOut || path.join(outDir, 'podcast-feed.json'));

    writeFileAtomic(chaptersPath, `${JSON.stringify(chaptersJson, null, 2)}\n`);
    let chaptersUploaded = false;
    const shouldUploadChaptersToRelease = releaseResult.published
        && !options.dryRun
        && !options.localOnly
        && isSameGitHubReleaseChaptersBase(options.chaptersBaseUrl, releaseResult.repo, releaseResult.tag);
    if (shouldUploadChaptersToRelease) {
        let uploadPath = chaptersPath;
        let stageDir = null;
        try {
            if (path.basename(chaptersPath) !== chaptersFileName) {
                stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'podcast-chapters-stage-'));
                if (process.platform !== 'win32') {
                    fs.chmodSync(stageDir, 0o700);
                }
                uploadPath = path.join(stageDir, chaptersFileName);
                fs.copyFileSync(chaptersPath, uploadPath);
                if (process.platform !== 'win32') {
                    fs.chmodSync(uploadPath, 0o400);
                }
            }
            ghExecFileSyncFn('gh', [
                'release', 'upload',
                '--repo', releaseResult.repo,
                '--clobber',
                '--',
                releaseResult.tag,
                uploadPath
            ], {
                cwd: PROJECT_ROOT,
                encoding: 'utf8',
                shell: false,
                timeout: 120000,
                env: ghEnv,
                stdio: ['ignore', 'pipe', 'pipe']
            });
            chaptersUploaded = true;
        } finally {
            if (stageDir) {
                fs.rmSync(stageDir, { recursive: true, force: true });
            }
        }
    }
    writeFileAtomic(metadataPath, `${JSON.stringify(episodeMetadata, null, 2)}\n`);

    const allEpisodes = [episodeMetadata, ...priorEpisodes];
    const rssXml = buildPodcastRssXml(allEpisodes, {
        feedUrl: options.feedUrl || `${siteRoot}feeds/podcast.xml`,
        link: siteRoot
    });
    writeFileAtomic(rssPath, rssXml);

    if (requestedFormat === 'mp3') {
        buildClientPodcastFeedJson([episodeMetadata], {
            generatedAt: feedGeneratedAt,
            skipIncompatible: false
        });
    }
    const clientFeed = buildClientPodcastFeedJson(allEpisodes, {
        generatedAt: feedGeneratedAt,
        skipIncompatible: true
    });
    if (requestedFormat === 'mp3'
        && !clientFeed.episodes.some(ep => ep && ep.date === dateStr)) {
        throw new Error(`Today's MP3 episode (${dateStr}) is missing from generated podcast-feed.json`);
    }
    writeFileAtomic(clientFeedPath, `${JSON.stringify(clientFeed, null, 2)}\n`);

    const portalSync = (options.portalRepo && !options.dryRun && !options.localOnly)
        ? syncPodcastToPortalRepo({ portalRepo: options.portalRepo, rssXml, clientFeed })
        : null;

    return {
        date: dateStr,
        scriptPath,
        audioPath: audioManifest.audioPath,
        audioManifestPath,
        chaptersPath,
        chaptersUploaded,
        metadataPath,
        rssPath,
        clientFeedPath,
        ...(portalSync ? { portalSync } : {}),
        script,
        audioManifest,
        releaseResult,
        episodeMetadata,
        clientFeed,
        episodeCountInFeed: allEpisodes.length
    };
}

function main(argv = process.argv.slice(2)) {
    const opts = parseCliArgs(argv);
    if (opts.help) {
        console.log(formatUsage());
        return 0;
    }
    if (opts.checkEnv) {
        const info = runCheckEnv();
        console.log(JSON.stringify(info, null, 2));
        return 0;
    }
    const result = runDailyPodcastPipeline(opts);
    console.log(JSON.stringify({
        date: result.date,
        scriptSha256: result.script.scriptSha256,
        audioPath: result.audioPath,
        audioBytes: result.audioManifest.audioBytes,
        audioSha256: result.audioManifest.audioSha256,
        durationSeconds: result.audioManifest.durationSeconds,
        publishStatus: result.episodeMetadata.publishStatus,
        releaseTag: result.releaseResult.tag,
        githubRepo: result.releaseResult.repo,
        audioUrl: result.episodeMetadata.audioUrl,
        metadataPath: result.metadataPath,
        rssPath: result.rssPath,
        clientFeedPath: result.clientFeedPath,
        chaptersPath: result.chaptersPath,
        chaptersUrl: result.episodeMetadata.chaptersUrl,
        chaptersUploaded: result.chaptersUploaded,
        ...(result.portalSync ? { portalSync: result.portalSync } : {})
    }, null, 2));
    return 0;
}

if (require.main === module) {
    requireExternalRuntime('publish-daily-podcast.js');
    loadProjectEnv();
    try {
        process.exitCode = main();
    } catch (err) {
        console.error(`[publish-daily-podcast] ${err.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    SYNTH_ALLOWED_ENV_KEYS,
    GH_ALLOWED_ENV_KEYS,
    pickAllowedChildEnv,
    parseCliArgs,
    formatUsage,
    buildSynthCommandArgs,
    loadExistingEpisodes,
    DEFAULT_EPISODES_DIR,
    isSameGitHubReleaseChaptersBase,
    syncPodcastToPortalRepo,
    runCheckEnv,
    runDailyPodcastPipeline,
    main
};
