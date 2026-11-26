'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { schemaFingerprint } = require('./protocol-codec');

const PODCAST_EPISODE_METADATA_CONTRACT = 'daily-podcast-episode-v1';
const CLIENT_PODCAST_FEED_CONTRACT = 'paper-daily-podcast-feed';
const CLIENT_PODCAST_FEED_SCHEMA_FINGERPRINT = schemaFingerprint(CLIENT_PODCAST_FEED_CONTRACT);
const CLIENT_PODCAST_FEED_MAX_EPISODES = 120;
const CLIENT_PODCAST_FEED_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB

const DEFAULT_PODCAST_GITHUB_REPO = 'nanless/audio-research-portal';
const DEFAULT_RELEASE_TAG_PREFIX = 'podcast';
const DEFAULT_TAG_GROUPING = 'monthly';
const DEFAULT_MAX_AUDIO_BYTES = 40 * 1024 * 1024; // 40 MiB (aligned with Wave 14.5 clients)
const DEFAULT_TTS_ENGINE = 'indextts-2.5';
const DEFAULT_BLOG_BASE_URL = 'https://nanless.github.io/audio-research-portal/posts';
const DEFAULT_EXEC_TIMEOUT_MS = 120000;
const STREAM_CHUNK_BYTES = 64 * 1024;

const VALID_TAG_GROUPINGS = Object.freeze(['monthly', 'daily']);
const VALID_AUDIO_EXTENSIONS = Object.freeze(['mp3', 'wav', 'm4a']);

function validateIsoDate(dateStr) {
    if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        throw new Error(`Invalid episode date "${String(dateStr)}"; expected YYYY-MM-DD`);
    }
    const [year, month, day] = dateStr.split('-').map(p => Number.parseInt(p, 10));
    const dt = new Date(Date.UTC(year, month - 1, day));
    if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
        throw new Error(`Calendar date is invalid: "${dateStr}"`);
    }
    return dateStr;
}

function validateTagPrefix(prefix) {
    const raw = String(prefix || DEFAULT_RELEASE_TAG_PREFIX).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(raw) || raw.includes('..')) {
        throw new Error(`Invalid release tag prefix: "${raw}"`);
    }
    return raw;
}

function validateTagGrouping(grouping) {
    const raw = String(grouping || DEFAULT_TAG_GROUPING).trim().toLowerCase();
    if (!VALID_TAG_GROUPINGS.includes(raw)) {
        throw new Error(`Invalid release tag grouping "${raw}"; expected "monthly" or "daily"`);
    }
    return raw;
}

function validateReleaseTag(tag) {
    const raw = String(tag || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw) || raw.includes('..')) {
        throw new Error(`Invalid GitHub release tag: "${raw}"`);
    }
    return raw;
}

function buildReleaseTag(dateStr, options = {}) {
    const date = validateIsoDate(dateStr);
    const prefix = validateTagPrefix(
        options.tagPrefix
        || (options.env && options.env.PD_PODCAST_RELEASE_TAG_PREFIX)
        || DEFAULT_RELEASE_TAG_PREFIX
    );
    const grouping = validateTagGrouping(
        options.tagGrouping
        || (options.env && options.env.PD_PODCAST_RELEASE_TAG_GROUPING)
        || DEFAULT_TAG_GROUPING
    );
    const suffix = grouping === 'monthly' ? date.slice(0, 7) : date;
    return validateReleaseTag(`${prefix}-${suffix}`);
}

function validateRepoSlug(repoSlug) {
    const raw = String(repoSlug || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(raw)) {
        throw new Error(`Invalid GitHub repo slug: "${raw}"`);
    }
    const [owner, repo] = raw.split('/');
    if (owner === '.' || owner === '..' || repo === '.' || repo === '..' || raw.includes('..')) {
        throw new Error(`Invalid GitHub repo slug segments: "${raw}"`);
    }
    return raw;
}

function parseGitHubRepoFromRemoteUrl(remoteUrl) {
    const raw = String(remoteUrl || '').trim();
    if (!raw) {
        throw new Error('Git remote URL is empty');
    }
    let match = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(raw);
    if (!match) {
        match = /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(raw);
    }
    if (!match) {
        throw new Error(`Unsupported GitHub remote URL: "${raw}"`);
    }
    return validateRepoSlug(`${match[1]}/${match[2]}`);
}

function resolvePodcastGitHubRepo(options = {}) {
    const env = options.env || process.env;
    if (options.repo) {
        return validateRepoSlug(options.repo);
    }
    if (env && env.PD_PODCAST_GITHUB_REPO && String(env.PD_PODCAST_GITHUB_REPO).trim()) {
        return validateRepoSlug(env.PD_PODCAST_GITHUB_REPO);
    }
    if (options.detectFromGitRemote === true) {
        const execFn = options.execFileSyncFn || childProcess.execFileSync;
        const remoteName = String(options.remoteName || 'origin').trim();
        if (!/^[A-Za-z0-9._-]+$/.test(remoteName) || remoteName.startsWith('-')) {
            throw new Error(`Invalid git remote name: "${remoteName}"`);
        }
        const remoteUrl = String(
            execFn('git', ['remote', 'get-url', '--', remoteName], {
                cwd: options.cwd || process.cwd(),
                encoding: 'utf8',
                shell: false,
                timeout: options.timeoutMs || 30000,
                stdio: ['ignore', 'pipe', 'pipe']
            })
        ).trim();
        return parseGitHubRepoFromRemoteUrl(remoteUrl);
    }
    return validateRepoSlug(DEFAULT_PODCAST_GITHUB_REPO);
}

function validateAssetFileName(fileName, options = {}) {
    const raw = String(fileName || '').trim();
    if (!raw || raw !== path.basename(raw) || raw.includes('/') || raw.includes('\\')
        || raw.includes('..') || raw.includes('\0') || raw.includes('#') || raw.includes('%')
        || raw.startsWith('-')) {
        throw new Error(`Unsafe podcast asset filename: "${raw}"`);
    }
    const prefix = validateTagPrefix(options.tagPrefix || DEFAULT_RELEASE_TAG_PREFIX);
    const allowedExts = Array.isArray(options.allowedExtensions) && options.allowedExtensions.length > 0
        ? options.allowedExtensions.map(e => String(e).toLowerCase().replace(/^\./, ''))
        : ['mp3'];
    for (const ext of allowedExts) {
        if (!VALID_AUDIO_EXTENSIONS.includes(ext)) {
            throw new Error(`Unsupported audio extension in policy: "${ext}"`);
        }
    }
    const extGroup = allowedExts.join('|');
    if (options.date) {
        const date = validateIsoDate(options.date);
        const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`^${escapedPrefix}-${date}\\.(${extGroup})$`);
        if (!re.test(raw)) {
            throw new Error(
                `Podcast asset filename "${raw}" does not match expected pattern "${prefix}-${date}.(${extGroup})"`
            );
        }
    } else {
        const re = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\\.(${extGroup})$`);
        if (!re.test(raw)) {
            throw new Error(`Invalid podcast asset filename: "${raw}"`);
        }
    }
    return raw;
}

function buildReleaseDownloadUrl({ repo, tag, assetFileName }) {
    const validRepo = validateRepoSlug(repo);
    const validTag = validateReleaseTag(tag);
    const validAsset = validateAssetFileName(assetFileName, {
        allowedExtensions: VALID_AUDIO_EXTENSIONS
    });
    const url = `https://github.com/${validRepo}/releases/download/${validTag}/${validAsset}`;
    return verifyReleaseDownloadUrl(url, { repo: validRepo, tag: validTag, assetFileName: validAsset });
}

function verifyReleaseDownloadUrl(rawUrl, expected = {}) {
    const text = String(rawUrl || '');
    if (!text || /[\x00-\x1F\x7F]/.test(text)) {
        throw new Error(`Invalid GitHub Release download URL: contains control characters or is empty`);
    }
    if (!text.startsWith('https://github.com/') || text.includes('?') || text.includes('#')) {
        throw new Error(
            `GitHub Release download URL must start with https://github.com/ without explicit port/query/fragment: "${text}"`
        );
    }
    let parsed;
    try {
        parsed = new URL(text);
    } catch {
        throw new Error(`Invalid GitHub Release download URL: "${text}"`);
    }
    if (parsed.protocol !== 'https:'
        || parsed.hostname !== 'github.com'
        || parsed.port !== ''
        || parsed.search !== ''
        || parsed.hash !== ''
        || parsed.username
        || parsed.password) {
        throw new Error(
            `GitHub Release download URL must be clean https://github.com without port/query/fragment/credentials: "${text}"`
        );
    }
    if (parsed.pathname.includes('%') || parsed.pathname.includes('..')) {
        throw new Error(`GitHub Release download URL pathname must not contain percent-encoding or traversal: "${parsed.pathname}"`);
    }
    if (expected.repo && expected.tag && expected.assetFileName) {
        const expectedPath = `/${expected.repo}/releases/download/${expected.tag}/${expected.assetFileName}`;
        if (parsed.pathname !== expectedPath) {
            throw new Error(`GitHub Release URL path mismatch: got "${parsed.pathname}", expected "${expectedPath}"`);
        }
    } else {
        const extGroup = VALID_AUDIO_EXTENSIONS.join('|');
        const re = new RegExp(
            `^/[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*/releases/download/[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*\\.(?:${extGroup})$`
        );
        if (!re.test(parsed.pathname)) {
            throw new Error(`Unexpected GitHub Release URL structure or audio extension: "${parsed.pathname}"`);
        }
    }
    return parsed.toString();
}

/**
 * Open asset with O_RDONLY | O_NOFOLLOW, verify regular file & bounded size via fstatSync,
 * and stream-hash directly from the opened file descriptor (optionally writing an immutable staged copy).
 */
function readAndVerifyAudioAssetFd(assetPath, options = {}) {
    if (typeof assetPath !== 'string' || !assetPath.trim()) {
        throw new Error('Audio asset path is required');
    }
    const resolved = path.resolve(assetPath);
    if (resolved.includes('#') || resolved.includes('\0')) {
        throw new Error(`Audio asset path contains forbidden characters (# or NUL): ${resolved}`);
    }
    const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0
        ? options.maxBytes
        : DEFAULT_MAX_AUDIO_BYTES;
    const fileName = validateAssetFileName(path.basename(resolved), {
        date: options.date,
        tagPrefix: options.tagPrefix,
        allowedExtensions: options.allowedExtensions || ['mp3']
    });

    const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    let fd;
    try {
        fd = fs.openSync(resolved, openFlags);
    } catch (err) {
        throw new Error(`Failed to safely open audio asset (must exist and not be a symlink): ${resolved} (${err.message})`);
    }

    let stageFd = null;
    try {
        const st = fs.fstatSync(fd);
        if (!st.isFile()) {
            throw new Error(`Audio asset must be a regular file: ${resolved}`);
        }
        if (st.size <= 0) {
            throw new Error(`Audio asset is empty (0 bytes): ${resolved}`);
        }
        if (st.size > maxBytes) {
            throw new Error(`Audio asset exceeds max size guard (${st.size} > ${maxBytes} bytes): ${resolved}`);
        }

        if (options.stageTargetPath) {
            stageFd = fs.openSync(
                options.stageTargetPath,
                fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
                0o400
            );
        }

        const hash = crypto.createHash('sha256');
        const buf = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
        let totalRead = 0;
        for (;;) {
            const bytesRead = fs.readSync(fd, buf, 0, buf.length, null);
            if (bytesRead === 0) break;
            totalRead += bytesRead;
            if (totalRead > maxBytes) {
                throw new Error(`Audio asset grew past max size guard (${totalRead} > ${maxBytes} bytes): ${resolved}`);
            }
            const slice = buf.subarray(0, bytesRead);
            hash.update(slice);
            if (stageFd !== null) {
                let written = 0;
                while (written < bytesRead) {
                    const n = fs.writeSync(stageFd, slice, written, bytesRead - written);
                    if (n <= 0) {
                        throw new Error(`Short write while staging audio asset: ${options.stageTargetPath}`);
                    }
                    written += n;
                }
            }
        }

        if (totalRead !== st.size) {
            throw new Error(`Audio asset size changed concurrently during read (${totalRead} !== ${st.size}): ${resolved}`);
        }
        const sha256 = hash.digest('hex');
        if (options.expectedSha256) {
            const expected = String(options.expectedSha256).trim().toLowerCase();
            if (!/^[a-f0-9]{64}$/.test(expected)) {
                throw new Error(`Invalid expectedSha256 format: "${options.expectedSha256}"`);
            }
            if (sha256 !== expected) {
                throw new Error(`Audio asset SHA-256 mismatch: expected ${expected}, got ${sha256}`);
            }
        }
        return {
            filePath: resolved,
            stagedPath: options.stageTargetPath || null,
            fileName,
            audioBytes: totalRead,
            audioSha256: sha256
        };
    } finally {
        if (stageFd !== null) {
            try {
                fs.closeSync(stageFd);
            } catch {
                // ignore close errors during cleanup
            }
        }
        fs.closeSync(fd);
    }
}

function verifyAudioAsset(assetPath, options = {}) {
    return readAndVerifyAudioAssetFd(assetPath, options);
}

function isReleaseNotFoundError(err) {
    if (!err) return false;
    if (err.code === 'ENOENT') return false;
    const combined = `${err.message || ''}\n${err.stderr || ''}\n${err.stdout || ''}`.toLowerCase();
    // Never mistake missing gh binary, missing repo, or auth failure for a missing release tag
    if (combined.includes('command not found')
        || combined.includes('enoent')
        || combined.includes('repository not found')
        || combined.includes('could not resolve to a repository')
        || combined.includes('not logged into')
        || combined.includes('authentication')
        || combined.includes('http 401')
        || combined.includes('http 403')) {
        return false;
    }
    return combined.includes('release not found')
        || combined.includes('could not find release')
        || combined.includes('release with tag')
        || (combined.includes('http 404') && combined.includes('release'));
}

function buildGhReleaseCommands({ repo, tag, assetPath, title, notes }) {
    const validRepo = validateRepoSlug(repo);
    const validTag = validateReleaseTag(tag);
    const safeAsset = path.resolve(String(assetPath));
    if (safeAsset.includes('#') || safeAsset.includes('\0')) {
        throw new Error(`Unsafe asset path for gh release (contains # or NUL): "${safeAsset}"`);
    }
    const safeTitle = String(title || `Audio Paper Digest Podcast ${validTag}`).replace(/[\r\n\0]+/g, ' ').trim();
    const safeNotes = String(notes || `Daily Chinese audio podcast episodes for ${validTag}.`).replace(/\0/g, '').trim();

    return {
        viewArgs: ['release', 'view', '--repo', validRepo, '--json', 'tagName,url,assets', '--', validTag],
        uploadArgs: ['release', 'upload', '--repo', validRepo, '--clobber', '--', validTag, safeAsset],
        createArgs: [
            'release', 'create',
            '--repo', validRepo,
            `--title=${safeTitle}`,
            `--notes=${safeNotes}`,
            '--',
            validTag,
            safeAsset
        ]
    };
}

/**
 * Publish (or dry-run plan) a podcast audio file to GitHub Releases via `gh release`.
 * Uses `execFileSync('gh', args, { shell: false, timeout })` exclusively and uploads
 * from an immutable 0400 staged copy inside a 0700 temp directory to eliminate TOCTOU.
 */
function publishPodcastToGitHubRelease(options = {}) {
    const date = validateIsoDate(options.date);
    const env = options.env || process.env;
    const tagPrefix = validateTagPrefix(
        options.tagPrefix || env.PD_PODCAST_RELEASE_TAG_PREFIX || DEFAULT_RELEASE_TAG_PREFIX
    );
    const tagGrouping = validateTagGrouping(
        options.tagGrouping || env.PD_PODCAST_RELEASE_TAG_GROUPING || DEFAULT_TAG_GROUPING
    );
    const repo = resolvePodcastGitHubRepo({
        repo: options.repo,
        env,
        cwd: options.cwd,
        detectFromGitRemote: options.detectFromGitRemote === true,
        execFileSyncFn: options.execFileSyncFn
    });
    const tag = options.tag
        ? validateReleaseTag(options.tag)
        : buildReleaseTag(date, { tagPrefix, tagGrouping, env });

    const allowedExtensions = options.allowedExtensions
        || (options.allowWav === true ? ['mp3', 'wav'] : ['mp3']);

    const releaseTitle = options.releaseTitle || (
        tagGrouping === 'monthly'
            ? `音频研究日报播客 ${date.slice(0, 7)}`
            : `音频研究日报播客 ${date}`
    );

    if (options.dryRun === true || options.localOnly === true) {
        const verified = verifyAudioAsset(options.assetPath, {
            date,
            tagPrefix,
            expectedSha256: options.expectedSha256,
            maxBytes: options.maxBytes || DEFAULT_MAX_AUDIO_BYTES,
            allowedExtensions
        });
        const releaseNotes = options.releaseNotes || (
            `Audio Paper Digest daily Chinese podcast audio assets (${tag}).\n`
            + `Latest episode: ${date} — SHA-256: ${verified.audioSha256}`
        );
        const commands = buildGhReleaseCommands({
            repo,
            tag,
            assetPath: verified.filePath,
            title: releaseTitle,
            notes: releaseNotes
        });
        const audioUrl = buildReleaseDownloadUrl({
            repo,
            tag,
            assetFileName: verified.fileName
        });
        return {
            published: false,
            action: options.localOnly === true ? 'local-only' : 'dry-run',
            repo,
            tag,
            tagGrouping,
            assetFileName: verified.fileName,
            audioBytes: verified.audioBytes,
            audioSha256: verified.audioSha256,
            audioUrl,
            plannedCommands: commands
        };
    }

    // Real upload: stage immutable 0400 copy inside a 0700 temp directory to eliminate SHA-256 TOCTOU
    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-podcast-stage-'));
    try {
        fs.chmodSync(stageDir, 0o700);
        const assetFileName = validateAssetFileName(path.basename(path.resolve(String(options.assetPath || ''))), {
            date,
            tagPrefix,
            allowedExtensions
        });
        const stagedPath = path.join(stageDir, assetFileName);
        const verified = readAndVerifyAudioAssetFd(options.assetPath, {
            date,
            tagPrefix,
            expectedSha256: options.expectedSha256,
            maxBytes: options.maxBytes || DEFAULT_MAX_AUDIO_BYTES,
            allowedExtensions,
            stageTargetPath: stagedPath
        });

        const releaseNotes = options.releaseNotes || (
            `Audio Paper Digest daily Chinese podcast audio assets (${tag}).\n`
            + `Latest episode: ${date} — SHA-256: ${verified.audioSha256}`
        );
        const commands = buildGhReleaseCommands({
            repo,
            tag,
            assetPath: stagedPath,
            title: releaseTitle,
            notes: releaseNotes
        });
        const audioUrl = buildReleaseDownloadUrl({
            repo,
            tag,
            assetFileName: verified.fileName
        });

        const execFn = options.execFileSyncFn || childProcess.execFileSync;
        const execOpts = {
            cwd: options.cwd || process.cwd(),
            encoding: 'utf8',
            shell: false,
            timeout: options.timeoutMs || DEFAULT_EXEC_TIMEOUT_MS,
            stdio: ['ignore', 'pipe', 'pipe']
        };
        if (options.ghEnv) {
            execOpts.env = options.ghEnv;
        }

        let releaseExists = false;
        try {
            execFn('gh', commands.viewArgs, execOpts);
            releaseExists = true;
        } catch (err) {
            if (!isReleaseNotFoundError(err)) {
                throw new Error(`Failed checking GitHub release ${tag} in ${repo}: ${err.message}`);
            }
            releaseExists = false;
        }

        let action;
        if (releaseExists) {
            execFn('gh', commands.uploadArgs, execOpts);
            action = 'uploaded';
        } else {
            execFn('gh', commands.createArgs, execOpts);
            action = 'created';
        }

        return {
            published: true,
            action,
            repo,
            tag,
            tagGrouping,
            assetFileName: verified.fileName,
            audioBytes: verified.audioBytes,
            audioSha256: verified.audioSha256,
            audioUrl,
            plannedCommands: commands
        };
    } finally {
        fs.rmSync(stageDir, { recursive: true, force: true });
    }
}

function validateSafeHttpsUrl(rawUrl, fieldName, { allowHttp = false } = {}) {
    const text = String(rawUrl || '').trim();
    if (!text || /[\x00-\x1F\x7F]/.test(text)) {
        throw new Error(`Invalid URL for ${fieldName}: empty or contains control characters`);
    }
    let parsed;
    try {
        parsed = new URL(text);
    } catch {
        throw new Error(`Invalid URL for ${fieldName}: "${text}"`);
    }
    const okProtocol = parsed.protocol === 'https:' || (allowHttp && parsed.protocol === 'http:');
    if (!okProtocol || parsed.username || parsed.password) {
        throw new Error(`Unsafe URL for ${fieldName} (must be https without credentials): "${text}"`);
    }
    return parsed.toString();
}

function sanitizeChapters(chapters) {
    if (!Array.isArray(chapters)) return [];
    const out = [];
    for (let i = 0; i < chapters.length; i++) {
        const ch = chapters[i];
        if (!ch || typeof ch !== 'object') continue;
        const startSec = Number(ch.startSec ?? ch.startSeconds);
        const endSec = Number(ch.endSec ?? ch.endSeconds);
        if (!Number.isFinite(startSec) || startSec < 0) continue;
        const normalizedEnd = Number.isFinite(endSec) && endSec >= startSec ? endSec : startSec;
        const cleanTitle = String(ch.title || '').replace(/[\r\n\0]+/g, ' ').trim() || `章节 ${out.length + 1}`;
        out.push({
            index: out.length,
            title: cleanTitle,
            startSec: Number(startSec.toFixed(3)),
            endSec: Number(normalizedEnd.toFixed(3)),
            paperId: ch.paperId ? String(ch.paperId).trim() : null
        });
    }
    return out;
}

function validateTimestamp(rawTimestamp, fieldName = 'publishedAt') {
    const text = String(rawTimestamp || '').trim();
    if (!text || /[\x00-\x1F\x7F]/.test(text)) {
        throw new Error(`Invalid ${fieldName} timestamp: "${text}"`);
    }
    const isoMatch = /^(\d{4}-\d{2}-\d{2})(?:[T\s].*)?$/.exec(text);
    if (isoMatch) {
        validateIsoDate(isoMatch[1]);
    }
    const dt = new Date(text);
    if (Number.isNaN(dt.getTime())) {
        throw new Error(`Invalid ${fieldName} timestamp: "${text}"`);
    }
    const utcYear = dt.getUTCFullYear();
    if (utcYear < 1970 || utcYear > 9999) {
        throw new Error(`Out-of-range year (${utcYear}) in ${fieldName}: "${text}"`);
    }
    return text;
}

/**
 * Build slim per-episode JSON metadata conforming to `daily-podcast-episode-v1`.
 */
function buildPodcastEpisodeMetadata(input = {}) {
    const date = validateIsoDate(input.date);
    const audioUrl = verifyReleaseDownloadUrl(input.audioUrl);
    const audioBytes = Number(input.audioBytes ?? input.bytes);
    if (!Number.isInteger(audioBytes) || audioBytes <= 0) {
        throw new Error(`audioBytes must be a positive integer (received: ${input.audioBytes})`);
    }
    const audioSha256 = String(input.audioSha256 || input.sha256 || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(audioSha256)) {
        throw new Error(`Invalid audioSha256: "${input.audioSha256}"`);
    }
    const durationSeconds = Number(input.durationSeconds);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new Error(`durationSeconds must be positive (received: ${input.durationSeconds})`);
    }
    const mimeType = String(input.mimeType || 'audio/mpeg').trim().toLowerCase();
    if (!['audio/mpeg', 'audio/wav', 'audio/mp4'].includes(mimeType)) {
        throw new Error(`Unsupported podcast mimeType: "${mimeType}"`);
    }
    const episodePageUrl = validateSafeHttpsUrl(
        input.episodePageUrl || `${DEFAULT_BLOG_BASE_URL}/${date}/`,
        'episodePageUrl'
    );
    const chaptersUrl = input.chaptersUrl
        ? validateSafeHttpsUrl(input.chaptersUrl, 'chaptersUrl')
        : null;
    const publishedAt = validateTimestamp(
        input.publishedAt || `${date}T08:00:00+08:00`,
        'publishedAt'
    );

    const cleanTitle = String(input.title || '').replace(/[\r\n\0]+/g, ' ').trim()
        || `音频研究日报播客 ${date}`;
    const cleanDesc = String(input.description || input.summary || '').trim()
        || `${date} 语音、音乐与音频前沿论文每日中文播客导览。`;

    const metadata = {
        contract: PODCAST_EPISODE_METADATA_CONTRACT,
        date,
        title: cleanTitle,
        description: cleanDesc,
        audioUrl,
        audioBytes,
        audioSha256,
        durationSeconds: Number(durationSeconds.toFixed(3)),
        mimeType,
        ttsEngine: String(input.ttsEngine || DEFAULT_TTS_ENGINE).trim(),
        chapters: sanitizeChapters(input.chapters),
        episodePageUrl,
        publishedAt
    };
    if (chaptersUrl) metadata.chaptersUrl = chaptersUrl;
    if (input.releaseTag) metadata.releaseTag = validateReleaseTag(input.releaseTag);
    if (input.githubRepo) metadata.githubRepo = validateRepoSlug(input.githubRepo);
    if (input.scriptSha256) metadata.scriptSha256 = String(input.scriptSha256).trim().toLowerCase();
    if (input.publishStatus) metadata.publishStatus = String(input.publishStatus).trim();
    if (typeof input.explicit === 'boolean') metadata.explicit = input.explicit;

    return metadata;
}

const CLIENT_PODCAST_FEED_MAX_DURATION_SECONDS = 86400;

function validateClientFeedEpisodeInvariants(ep) {
    if (ep.mimeType !== 'audio/mpeg') {
        throw new Error(`Client podcast feed requires mimeType="audio/mpeg" (got "${ep.mimeType}" for ${ep.date})`);
    }
    if (!ep.audioUrl.endsWith('.mp3')) {
        throw new Error(`Client podcast feed requires .mp3 audioUrl (got "${ep.audioUrl}" for ${ep.date})`);
    }
    if (!Number.isInteger(ep.audioBytes) || ep.audioBytes < 1 || ep.audioBytes > DEFAULT_MAX_AUDIO_BYTES) {
        throw new Error(
            `Client podcast feed requires 1 <= audioBytes <= ${DEFAULT_MAX_AUDIO_BYTES} (got ${ep.audioBytes} for ${ep.date})`
        );
    }
    if (!Number.isFinite(ep.durationSeconds) || ep.durationSeconds <= 0
        || ep.durationSeconds > CLIENT_PODCAST_FEED_MAX_DURATION_SECONDS) {
        throw new Error(
            `Client podcast feed requires 0 < durationSeconds <= ${CLIENT_PODCAST_FEED_MAX_DURATION_SECONDS} (got ${ep.durationSeconds} for ${ep.date})`
        );
    }
    if (typeof ep.title !== 'string' || !ep.title.trim()) {
        throw new Error(`Client podcast feed requires non-empty episode title (for ${ep.date})`);
    }
    for (const ch of ep.chapters || []) {
        if (typeof ch.title !== 'string' || !ch.title.trim()) {
            throw new Error(`Client podcast feed requires non-empty chapter title (for ${ep.date})`);
        }
    }
}

/**
 * Build Wave 14.5 client feed JSON (`paper-daily-podcast-feed`),
 * enforcing strict MP3 / size / duration / non-empty title invariants,
 * capped at 120 episodes and 2 MiB UTF-8 serialized size.
 */
function buildClientPodcastFeedJson(episodes, options = {}) {
    if (!Array.isArray(episodes)) {
        throw new Error('episodes must be an array');
    }
    const skipIncompatible = options.skipIncompatible === true;
    const maxEpisodes = Number.isInteger(options.maxEpisodes) && options.maxEpisodes > 0
        ? Math.min(CLIENT_PODCAST_FEED_MAX_EPISODES, options.maxEpisodes)
        : CLIENT_PODCAST_FEED_MAX_EPISODES;
    const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0
        ? Math.min(CLIENT_PODCAST_FEED_MAX_BYTES, options.maxBytes)
        : CLIENT_PODCAST_FEED_MAX_BYTES;

    const compatible = [];
    for (const rawEp of episodes) {
        try {
            const ep = buildPodcastEpisodeMetadata(rawEp);
            validateClientFeedEpisodeInvariants(ep);
            compatible.push(ep);
        } catch (err) {
            if (!skipIncompatible) {
                throw err;
            }
        }
    }

    // Dedupe by date (preserving first occurrence when duplicates exist) then sort newest first
    const byDate = new Map();
    for (const ep of compatible) {
        if (!byDate.has(ep.date)) {
            byDate.set(ep.date, ep);
        }
    }
    const sorted = [...byDate.values()]
        .sort((a, b) => b.date.localeCompare(a.date, 'en'))
        .slice(0, maxEpisodes);

    const generatedAt = validateTimestamp(
        options.generatedAt
        || (sorted.length > 0 ? sorted[0].publishedAt : '2026-01-01T00:00:00Z'),
        'generatedAt'
    );

    const mapped = sorted.map(ep => {
        const paperIds = [];
        const seenPaper = new Set();
        const chapters = ep.chapters.map(ch => {
            if (ch.paperId && !seenPaper.has(ch.paperId)) {
                seenPaper.add(ch.paperId);
                paperIds.push(ch.paperId);
            }
            return {
                title: ch.title,
                startSeconds: ch.startSec,
                endSeconds: ch.endSec,
                paperId: ch.paperId || null
            };
        });
        return {
            id: `podcast-${ep.date}`,
            date: ep.date,
            title: ep.title,
            summary: ep.description,
            audioUrl: ep.audioUrl,
            bytes: ep.audioBytes,
            sha256: ep.audioSha256,
            durationSeconds: ep.durationSeconds,
            mimeType: ep.mimeType,
            chapters,
            paperIds
        };
    });

    // Enforce 2 MiB ceiling by trimming oldest episodes if needed
    const feed = {
        contract: CLIENT_PODCAST_FEED_CONTRACT,
        schemaFingerprint: CLIENT_PODCAST_FEED_SCHEMA_FINGERPRINT,
        generatedAt,
        episodes: mapped
    };
    while (Buffer.byteLength(`${JSON.stringify(feed, null, 2)}\n`, 'utf8') > maxBytes) {
        if (feed.episodes.length <= 1) {
            throw new Error(`Client podcast feed exceeds ${maxBytes} bytes limit even with 1 episode`);
        }
        feed.episodes.pop();
    }
    return feed;
}

/**
 * Build Podcasting 2.0 JSON Chapters payload (`application/json+chapters`).
 */
function buildPodcast2ChaptersJson(episode) {
    const chapters = sanitizeChapters(episode?.chapters || []).map(ch => {
        const entry = {
            startTime: Number(ch.startSec.toFixed(2)),
            title: ch.title
        };
        if (ch.paperId && /^[0-9]{4}\.[0-9]{4,5}(?:v\d+)?$/.test(ch.paperId)) {
            entry.url = `https://arxiv.org/abs/${ch.paperId}`;
        }
        return entry;
    });
    return {
        version: '1.2.0',
        title: String(episode?.title || ''),
        chapters
    };
}

/**
 * Strip lone UTF-16 surrogates while preserving valid surrogate pairs.
 */
function stripLoneSurrogates(str) {
    let out = '';
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code >= 0xD800 && code <= 0xDBFF) {
            if (i + 1 < str.length) {
                const next = str.charCodeAt(i + 1);
                if (next >= 0xDC00 && next <= 0xDFFF) {
                    out += str[i] + str[i + 1];
                    i += 1;
                    continue;
                }
            }
            // Lone high surrogate -> drop
            continue;
        }
        if (code >= 0xDC00 && code <= 0xDFFF) {
            // Lone low surrogate -> drop
            continue;
        }
        out += str[i];
    }
    return out;
}

/**
 * Strictly escape text for XML 1.0 element text & attribute values:
 * strips XML 1.0 illegal control chars, U+FFFE/U+FFFF non-characters, and lone
 * UTF-16 surrogates, then escapes &, <, >, ", ' to prevent XML/CDATA injection.
 */
function escapeXmlText(value) {
    const raw = stripLoneSurrogates(String(value === null || value === undefined ? '' : value));
    return raw
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\uFFFE\uFFFF]/g, '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function formatItunesDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const pad = n => String(n).padStart(2, '0');
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
}

function formatChapterTimestamp(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const pad = n => String(n).padStart(2, '0');
    return hrs > 0 ? `${pad(hrs)}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
}

function formatRfc2822Date(timestamp) {
    const validated = validateTimestamp(timestamp, 'RFC-2822 date');
    const dt = new Date(validated);
    return dt.toUTCString();
}

function formatEpisodeDescriptionWithChapters(ep) {
    const lines = [String(ep.description || '').trim()].filter(Boolean);
    const chapters = sanitizeChapters(ep.chapters || []);
    if (chapters.length > 0) {
        lines.push('');
        lines.push('章节时间轴:');
        for (const ch of chapters) {
            const paperTag = ch.paperId ? ` [${ch.paperId}]` : '';
            lines.push(`${formatChapterTimestamp(ch.startSec)} ${ch.title}${paperTag}`);
        }
    }
    return lines.join('\n');
}

/**
 * Generate a valid Podcast 2.0 / Apple Podcasts RSS 2.0 XML feed from episode metadata records.
 */
function buildPodcastRssXml(episodes, channelConfig = {}) {
    if (!Array.isArray(episodes)) {
        throw new Error('episodes must be an array');
    }

    const title = String(channelConfig.title || '音频研究工作台播客').trim();
    const link = validateSafeHttpsUrl(
        channelConfig.link || 'https://nanless.github.io/audio-research-portal/',
        'channelConfig.link'
    );
    const feedUrl = validateSafeHttpsUrl(
        channelConfig.feedUrl || 'https://nanless.github.io/audio-research-portal/podcast.xml',
        'channelConfig.feedUrl'
    );
    const description = String(
        channelConfig.description || '每日追踪 arXiv 与顶会语音、音乐与音频前沿论文的中文音频精讲。'
    ).trim();
    const language = String(channelConfig.language || 'zh-cn').trim();
    const author = String(channelConfig.author || 'Audio Research Workbench').trim();
    const category = String(channelConfig.category || 'Technology').trim();
    const channelExplicit = channelConfig.explicit === true ? 'true' : 'false';
    const imageUrl = channelConfig.imageUrl
        ? validateSafeHttpsUrl(channelConfig.imageUrl, 'channelConfig.imageUrl')
        : null;

    // Validate all episodes upfront before sorting or computing latestPubDate
    const validatedEpisodes = episodes.map(rawEp => buildPodcastEpisodeMetadata(rawEp));
    const sortedEpisodes = [...validatedEpisodes].sort((a, b) => {
        const dateCmp = b.date.localeCompare(a.date, 'en');
        if (dateCmp !== 0) return dateCmp;
        return a.title.localeCompare(b.title, 'zh-Hans-CN');
    });

    const latestPubDate = sortedEpisodes.length > 0
        ? formatRfc2822Date(sortedEpisodes[0].publishedAt)
        : formatRfc2822Date(channelConfig.lastBuildDate || '2026-01-01T00:00:00Z');

    const lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:atom="http://www.w3.org/2005/Atom">',
        '  <channel>',
        `    <title>${escapeXmlText(title)}</title>`,
        `    <link>${escapeXmlText(link)}</link>`,
        `    <atom:link href="${escapeXmlText(feedUrl)}" rel="self" type="application/rss+xml" />`,
        `    <language>${escapeXmlText(language)}</language>`,
        `    <description>${escapeXmlText(description)}</description>`,
        `    <lastBuildDate>${escapeXmlText(latestPubDate)}</lastBuildDate>`,
        `    <itunes:author>${escapeXmlText(author)}</itunes:author>`,
        `    <itunes:summary>${escapeXmlText(description)}</itunes:summary>`,
        `    <itunes:explicit>${channelExplicit}</itunes:explicit>`,
        `    <itunes:category text="${escapeXmlText(category)}" />`,
        '    <podcast:locked>no</podcast:locked>'
    ];
    if (imageUrl) {
        lines.push(`    <itunes:image href="${escapeXmlText(imageUrl)}" />`);
    }

    for (const ep of sortedEpisodes) {
        // Date-stable GUID prevents duplicate episodes in clients if audio is re-encoded
        const guid = `audio-paper-digest:podcast:${ep.date}`;
        const fullDesc = formatEpisodeDescriptionWithChapters(ep);
        const pubDate = formatRfc2822Date(ep.publishedAt);
        const duration = formatItunesDuration(ep.durationSeconds);
        const itemExplicit = typeof ep.explicit === 'boolean'
            ? (ep.explicit ? 'true' : 'false')
            : channelExplicit;

        lines.push('    <item>');
        lines.push(`      <title>${escapeXmlText(ep.title)}</title>`);
        lines.push(`      <link>${escapeXmlText(ep.episodePageUrl)}</link>`);
        lines.push(`      <guid isPermaLink="false">${escapeXmlText(guid)}</guid>`);
        lines.push(`      <pubDate>${escapeXmlText(pubDate)}</pubDate>`);
        lines.push(`      <description>${escapeXmlText(fullDesc)}</description>`);
        lines.push(`      <itunes:summary>${escapeXmlText(ep.description)}</itunes:summary>`);
        lines.push(`      <itunes:duration>${escapeXmlText(duration)}</itunes:duration>`);
        lines.push('      <itunes:episodeType>full</itunes:episodeType>');
        lines.push(`      <itunes:explicit>${itemExplicit}</itunes:explicit>`);
        lines.push(
            `      <enclosure url="${escapeXmlText(ep.audioUrl)}" length="${ep.audioBytes}" type="${escapeXmlText(ep.mimeType)}" />`
        );
        if (ep.chaptersUrl) {
            lines.push(
                `      <podcast:chapters url="${escapeXmlText(ep.chaptersUrl)}" type="application/json+chapters" />`
            );
        }
        lines.push('    </item>');
    }

    lines.push('  </channel>');
    lines.push('</rss>');
    return `${lines.join('\n')}\n`;
}

module.exports = {
    PODCAST_EPISODE_METADATA_CONTRACT,
    CLIENT_PODCAST_FEED_CONTRACT,
    CLIENT_PODCAST_FEED_SCHEMA_FINGERPRINT,
    CLIENT_PODCAST_FEED_MAX_EPISODES,
    CLIENT_PODCAST_FEED_MAX_BYTES,
    DEFAULT_PODCAST_GITHUB_REPO,
    DEFAULT_RELEASE_TAG_PREFIX,
    DEFAULT_TAG_GROUPING,
    DEFAULT_MAX_AUDIO_BYTES,
    DEFAULT_TTS_ENGINE,
    VALID_TAG_GROUPINGS,
    VALID_AUDIO_EXTENSIONS,
    validateIsoDate,
    validateTagPrefix,
    validateTagGrouping,
    validateReleaseTag,
    buildReleaseTag,
    validateRepoSlug,
    parseGitHubRepoFromRemoteUrl,
    resolvePodcastGitHubRepo,
    validateAssetFileName,
    buildReleaseDownloadUrl,
    verifyReleaseDownloadUrl,
    verifyAudioAsset,
    isReleaseNotFoundError,
    buildGhReleaseCommands,
    publishPodcastToGitHubRelease,
    buildPodcastEpisodeMetadata,
    buildClientPodcastFeedJson,
    buildPodcast2ChaptersJson,
    escapeXmlText,
    formatItunesDuration,
    formatChapterTimestamp,
    formatRfc2822Date,
    buildPodcastRssXml
};
