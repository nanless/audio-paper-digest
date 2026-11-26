#!/usr/bin/env node
'use strict';

/**
 * Safe lossless compaction CLI for data/current/papers.json.
 *
 * Defaults to --dry-run (strictly zero filesystem writes, including zero log files).
 * Pass --write to verify archive proofs outside the lock, acquire the papers.json
 * file lock, validate schema/waivers/current batch, write a verified pre-compaction
 * gzip backup + manifest, atomically compact papers.json, run post-write zero-key-loss
 * & schema verification, and emit a compaction receipt.
 */

const { requireExternalRuntime } = require('./env-loader.js');
if (require.main === module) {
    requireExternalRuntime('compact-papers-ledger.js', { enforceWorkspaceRole: true });
}

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const Config = require('./config.js');
const {
    getBeijingISOString,
    getBeijingCompactTimestamp,
    writeFileAtomic,
    normalizedId
} = require('./utils.js');
const {
    withFileLockSync,
    LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY
} = require('./analysis-engine.js');
const {
    PAPERS_LEDGER_STRIP_ON_WRITE_FIELDS,
    PAPERS_BACKUP_CONTRACT,
    PAPERS_BACKUP_MAX_RAW_BYTES,
    normalizeCompatibleBatchDate,
    validatePapersDatabaseSchema,
    serializePapersDatabase
} = require('./digest-status.js');

const COMPACTION_PROFILES = Object.freeze(['ledger', 'safe-blobs']);
const DEFAULT_PROFILE = 'ledger';
const DEFAULT_RETAIN_DAYS = 14;
const COMPACTION_RECEIPT_CONTRACT = 'papers-ledger-compaction-receipt-v1';

const ALLOWED_DIGEST_STATUSES = new Set(['seen', 'pending_analysis', 'analyzed', 'analysis_failed']);
const ALLOWED_ANALYSIS_ATTEMPT_STATUSES = new Set(['analyzed', 'analysis_failed']);

const VERIFIED_ARCHIVED_BLOB_FIELDS = Object.freeze([
    'analysis',
    'parsed',
    'apiReaderArticle',
    'analysisManifest',
    'imageManifest'
]);

const LEDGER_HISTORICAL_TOP_LEVEL_FIELDS = Object.freeze([
    'abstract',
    'summary',
    'hf_ai_summary',
    'hf_ai_keywords'
]);

const LEDGER_HISTORICAL_DIGEST_STATUS_FIELDS = Object.freeze([
    'filterRawResponse',
    'filterReason',
    'filterPromptHash',
    'filterParseSource',
    'filterModel',
    'filterDecidedAt'
]);

const DATE_DIR_RE = /^20\d{2}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const ARCHIVE_MIN_ANALYSIS_CHARS = 500;
const ARCHIVE_MIN_HEADINGS = 2;
const ARCHIVE_NON_TERMINAL_STAGE_STATUSES = new Set([
    'pending',
    'transient_failure',
    'invalid_output',
    'contract_rejected'
]);

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256Buffer(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function stringSha256(value) {
    return sha256Buffer(Buffer.from(value, 'utf8'));
}

function canonicalizeValue(value) {
    if (Array.isArray(value)) return value.map(canonicalizeValue);
    if (value && typeof value === 'object') {
        const sorted = {};
        for (const key of Object.keys(value).sort()) {
            if (value[key] !== undefined) sorted[key] = canonicalizeValue(value[key]);
        }
        return sorted;
    }
    return value;
}

function canonicalSha256(value) {
    return sha256Buffer(Buffer.from(JSON.stringify(canonicalizeValue(value)), 'utf8'));
}

function estimateJsonFieldBytes(fieldName, value) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return 0;
    return Buffer.byteLength(JSON.stringify(fieldName), 'utf8') + 1 + Buffer.byteLength(serialized, 'utf8');
}

function parseCalendarDateUtcMs(dateStr) {
    if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
    const [year, month, day] = dateStr.split('-').map(Number);
    const ms = Date.UTC(year, month - 1, day);
    const date = new Date(ms);
    if (date.getUTCFullYear() !== year
        || date.getUTCMonth() !== month - 1
        || date.getUTCDate() !== day) {
        return null;
    }
    return ms;
}

function diffCalendarDays(earlierDate, referenceDate) {
    const earlierMs = parseCalendarDateUtcMs(earlierDate);
    const refMs = parseCalendarDateUtcMs(referenceDate);
    if (earlierMs === null || refMs === null) return null;
    return Math.floor((refMs - earlierMs) / DAY_MS);
}

function resolveReferenceDate(referenceDateOption, fallbackIso) {
    if (referenceDateOption !== undefined) {
        const normalized = normalizeCompatibleBatchDate(referenceDateOption);
        if (!normalized) {
            throw new Error(`referenceDate 日期格式无效，必须是合法 YYYY-MM-DD（收到 ${JSON.stringify(referenceDateOption)}）`);
        }
        return normalized;
    }
    return fallbackIso.slice(0, 10);
}

function isLeakedMergeAttemptMetadata(paper) {
    return isPlainObject(paper)
        && paper.digestStatus?.status === 'analyzed'
        && paper.digestStatus?.latestAttemptStatus === 'analyzed'
        && !paper.digestStatus?.error
        && paper.latestAnalysisAttemptError === '分析未完成';
}

function getMostRecentPaperDate(paper) {
    if (!isPlainObject(paper)) return '';
    const rawCandidates = [
        paper.digestStatus?.batchDate,
        paper.digestStatus?.updatedAt,
        paper.digestStatus?.filterDecidedAt,
        ...(isLeakedMergeAttemptMetadata(paper) ? [] : [paper.latestAnalysisAttemptAt]),
        paper.batchDate,
        paper.fetchBatchDate,
        paper.fetchedAt,
        paper.timestamp
    ];
    let latest = '';
    for (const raw of rawCandidates) {
        if (raw === undefined || raw === null) continue;
        if (typeof raw === 'string' && raw.trim() === '') continue;
        const normalized = normalizeCompatibleBatchDate(raw);
        if (!normalized) {
            // Fail-closed: any malformed non-empty date marks the paper as unknownDate -> protected.
            return '';
        }
        if (!latest || normalized > latest) {
            latest = normalized;
        }
    }
    return latest;
}

/**
 * Pure in-memory validator mirroring scripts/validate-data-files.js:validatePapersDatabase
 * without importing validate-data-files.js (which triggers setupScriptLogging on load).
 */
function validatePapersDatabaseRecords(data, label = 'papers.json') {
    const issues = [];
    const add = message => issues.push(`${label}: ${message}`);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        add('根对象必须是 { papers, lastUpdated }');
        return issues;
    }
    if (!data.papers || typeof data.papers !== 'object' || Array.isArray(data.papers)) {
        add('papers 必须是对象映射');
        return issues;
    }

    const seenIds = new Map();
    for (const [key, paper] of Object.entries(data.papers)) {
        if (!paper || typeof paper !== 'object' || Array.isArray(paper)) {
            add(`${key} 不是论文对象`);
            continue;
        }
        const paperId = normalizedId(paper);
        const keyId = normalizedId(key);
        if (paperId && keyId && paperId !== keyId) {
            add(`${key} 的对象 key 与论文 ID 冲突: ${paperId}`);
        }
        const id = paperId || keyId;
        if (!id) add(`${key} 缺少可识别 ID`);
        if (id && seenIds.has(id)) {
            add(`${key} 与 ${seenIds.get(id)} 归一化为重复 ID: ${id}`);
        } else if (id) {
            seenIds.set(id, key);
        }
        const status = paper.digestStatus?.status;
        if (status && !ALLOWED_DIGEST_STATUSES.has(status)) {
            add(`${key} digestStatus.status 非法: ${status}`);
        }
        const latestAttemptStatus = paper.digestStatus?.latestAttemptStatus;
        if (latestAttemptStatus && !ALLOWED_ANALYSIS_ATTEMPT_STATUSES.has(latestAttemptStatus)) {
            add(`${key} digestStatus.latestAttemptStatus 非法: ${latestAttemptStatus}`);
        }
        const error = paper.digestStatus?.error;
        if (error !== undefined && error !== null && typeof error !== 'string') {
            add(`${key} digestStatus.error 必须是字符串或 null`);
        }
    }
    return issues;
}

function extractPaperList(parsed, label) {
    if (Array.isArray(parsed)) return parsed;
    if (isPlainObject(parsed) && Array.isArray(parsed.papers)) return parsed.papers;
    throw new Error(`${label} 结构无效：缺少 papers 数组`);
}

function extractArtifactBatchDate(parsed) {
    if (!isPlainObject(parsed)) return '';
    return normalizeCompatibleBatchDate(parsed.batchDate)
        || normalizeCompatibleBatchDate(parsed.timestamp)
        || '';
}

function readRegularFileStrict(filePath, label) {
    const flags = fs.constants.O_RDONLY
        | (fs.constants.O_NOFOLLOW || 0)
        | (fs.constants.O_NONBLOCK || 0);
    let fd;
    try {
        fd = fs.openSync(filePath, flags);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) {
            throw new Error(`${label} 必须是普通非符号链接文件: ${filePath}`);
        }
        return fs.readFileSync(fd);
    } catch (error) {
        if (error && (error.code === 'ELOOP' || error.code === 'EMLINK')) {
            throw new Error(`${label} 必须是普通非符号链接文件: ${filePath}`);
        }
        throw error;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

function readJsonStrictFile(filePath, label) {
    const raw = readRegularFileStrict(filePath, label);
    let parsed;
    try {
        parsed = JSON.parse(raw.toString('utf8'));
    } catch (error) {
        throw new Error(`${label} JSON 无法解析 (${filePath}): ${error.message}`);
    }
    return { raw, parsed };
}

function normalizePlatformRootSymlink(resolvedPath) {
    if (process.platform !== 'darwin') return resolvedPath;
    for (const [alias, real] of [['/var', '/private/var'], ['/tmp', '/private/tmp']]) {
        if (resolvedPath === alias || resolvedPath.startsWith(`${alias}/`)) {
            try {
                if (fs.lstatSync(alias).isSymbolicLink() && fs.realpathSync(alias) === real) {
                    return `${real}${resolvedPath.slice(alias.length)}`;
                }
            } catch (_) {
                // ignore if alias does not exist
            }
        }
    }
    return resolvedPath;
}

function ensureSafeDirectoryChain(targetDir, label) {
    const absolute = normalizePlatformRootSymlink(path.resolve(targetDir));
    const root = path.parse(absolute).root;
    const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
    let current = root;
    for (const part of parts) {
        current = path.join(current, part);
        const existing = fs.lstatSync(current, { throwIfNoEntry: false });
        if (existing) {
            if (!existing.isDirectory() || existing.isSymbolicLink()) {
                throw new Error(`${label} 路径包含符号链接或非目录祖先: ${current}`);
            }
            continue;
        }
        fs.mkdirSync(current, { mode: 0o700 });
        const created = fs.lstatSync(current);
        if (!created.isDirectory() || created.isSymbolicLink()) {
            throw new Error(`${label} 创建后的目录不是普通非符号链接目录: ${current}`);
        }
    }
    return absolute;
}

function checkActiveWaiverGuard({
    currentDir,
    papersSha256,
    deepBatchDate = '',
    filteredBatchDate = '',
    currentDeepSha256 = '',
    currentFilteredSha256 = ''
}) {
    const waiverDir = path.join(currentDir, 'analysis-waivers');
    const dirStat = fs.lstatSync(waiverDir, { throwIfNoEntry: false });
    if (!dirStat) return { ok: true, checkedWaiverFiles: [] };
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
        throw new Error(`分析豁免目录必须是普通非符号链接目录，已中止压缩: ${waiverDir}`);
    }

    const activeDates = new Set([deepBatchDate, filteredBatchDate].filter(Boolean));
    const entries = fs.readdirSync(waiverDir, { withFileTypes: true })
        .filter(entry => entry.name.endsWith('.json'))
        .sort((a, b) => a.name.localeCompare(b.name));

    const checked = [];
    for (const entry of entries) {
        const waiverFile = path.join(waiverDir, entry.name);
        checked.push(waiverFile);
        const { parsed: waiver } = readJsonStrictFile(waiverFile, `分析豁免文件 (${entry.name})`);
        if (!isPlainObject(waiver)) {
            throw new Error(`活动分析豁免文件格式无效，已中止压缩: ${waiverFile}`);
        }
        const fileDate = entry.name.slice(0, -'.json'.length);
        const waiverBatchDate = normalizeCompatibleBatchDate(waiver.batchDate);
        const source = isPlainObject(waiver.source) ? waiver.source : {};

        const reasons = [];
        if (activeDates.has(fileDate) || (waiverBatchDate && activeDates.has(waiverBatchDate))) {
            reasons.push(`匹配当前活动批次日期 (${waiverBatchDate || fileDate})`);
        }
        if (papersSha256 && typeof source.papersDatabaseSha256 === 'string' && source.papersDatabaseSha256 === papersSha256) {
            reasons.push(`source.papersDatabaseSha256=${source.papersDatabaseSha256} 绑定当前 papers.json`);
        }
        if (currentDeepSha256 && typeof source.deepAnalysisResultSha256 === 'string' && source.deepAnalysisResultSha256 === currentDeepSha256) {
            reasons.push(`source.deepAnalysisResultSha256=${source.deepAnalysisResultSha256} 绑定当前 deep-analysis-result.json`);
        }
        if (currentFilteredSha256 && typeof source.filteredPapersSha256 === 'string' && source.filteredPapersSha256 === currentFilteredSha256) {
            reasons.push(`source.filteredPapersSha256=${source.filteredPapersSha256} 绑定当前 filtered-papers.json`);
        }

        if (reasons.length > 0) {
            throw new Error(
                `检测到活动分析豁免 ${waiverFile}（${reasons.join('；')}）；`
                + '禁止压缩以免破坏豁免校验（零写入已中止）'
            );
        }
    }
    return { ok: true, checkedWaiverFiles: checked };
}

function buildArchiveRecordProof(paper, archiveDate) {
    if (!isPlainObject(paper)) return null;
    if (Boolean(paper.error)) return null;
    if (paper.digestStatus?.status === 'analysis_failed') return null;
    if (paper.digestStatus?.latestAttemptStatus === 'analysis_failed') return null;
    if (Boolean(paper.latestAnalysisAttemptError)) return null;
    if (typeof paper.analysisCheckpoint === 'string' && paper.analysisCheckpoint.trim().length > 0) return null;
    const stages = paper.analysisManifest?.stages;
    if (isPlainObject(stages)) {
        for (const [stage, state] of Object.entries(stages)) {
            if (stage !== 'apiReaderTableAudit'
                && isPlainObject(state)
                && ARCHIVE_NON_TERMINAL_STAGE_STATUSES.has(state.status)) {
                return null;
            }
        }
    }
    if (typeof paper.analysis !== 'string') return null;
    const trimmed = paper.analysis.trim();
    if (trimmed.length < ARCHIVE_MIN_ANALYSIS_CHARS) return null;
    const headingMatches = trimmed.match(/^#{1,3}\s+\S/gm);
    if (!headingMatches || headingMatches.length < ARCHIVE_MIN_HEADINGS) return null;

    return {
        archiveDate,
        analysisSha256: stringSha256(paper.analysis),
        apiReaderArticleSha256: typeof paper.apiReaderArticle === 'string' && paper.apiReaderArticle.trim().length > 0
            ? stringSha256(paper.apiReaderArticle)
            : null,
        parsedSha256: paper.parsed !== undefined && paper.parsed !== null
            ? canonicalSha256(paper.parsed)
            : null,
        analysisManifestSha256: paper.analysisManifest !== undefined && paper.analysisManifest !== null
            ? canonicalSha256(paper.analysisManifest)
            : null,
        imageManifestSha256: paper.imageManifest !== undefined && paper.imageManifest !== null
            ? canonicalSha256(paper.imageManifest)
            : null
    };
}

function matchesVerifiedArchiveProof(originalPaper, proofs) {
    if (!Array.isArray(proofs) || proofs.length === 0) return false;
    const hasAnalysis = typeof originalPaper.analysis === 'string' && originalPaper.analysis.trim().length > 0;
    const hasApiReader = typeof originalPaper.apiReaderArticle === 'string' && originalPaper.apiReaderArticle.trim().length > 0;
    const hasParsed = originalPaper.parsed !== undefined && originalPaper.parsed !== null;
    const hasManifest = originalPaper.analysisManifest !== undefined && originalPaper.analysisManifest !== null;
    const hasImageManifest = originalPaper.imageManifest !== undefined && originalPaper.imageManifest !== null;

    const analysisSha = hasAnalysis ? stringSha256(originalPaper.analysis) : null;
    const apiReaderSha = hasApiReader ? stringSha256(originalPaper.apiReaderArticle) : null;
    const parsedSha = hasParsed ? canonicalSha256(originalPaper.parsed) : null;
    const manifestSha = hasManifest ? canonicalSha256(originalPaper.analysisManifest) : null;
    const imageManifestSha = hasImageManifest ? canonicalSha256(originalPaper.imageManifest) : null;

    return proofs.some(proof => {
        if (hasAnalysis && proof.analysisSha256 !== analysisSha) return false;
        if (hasApiReader && proof.apiReaderArticleSha256 !== apiReaderSha) return false;
        if (hasParsed && proof.parsedSha256 !== parsedSha) return false;
        if (hasManifest && proof.analysisManifestSha256 !== manifestSha) return false;
        if (hasImageManifest && proof.imageManifestSha256 !== imageManifestSha) return false;
        return true;
    });
}

function scanVerifiedArchiveProofs(archiveDir) {
    const verifiedArchivedProofs = new Map();
    const unreadableArchiveFiles = [];
    let scannedArchiveDirs = 0;
    let validArchiveFiles = 0;

    if (archiveDir && fs.existsSync(archiveDir)) {
        const archiveStat = fs.lstatSync(archiveDir);
        if (!archiveStat.isDirectory() || archiveStat.isSymbolicLink()) {
            throw new Error(`archive 目录必须是普通非符号链接目录: ${archiveDir}`);
        }
        const entries = fs.readdirSync(archiveDir, { withFileTypes: true })
            .filter(entry => !entry.isSymbolicLink() && entry.isDirectory()
                && DATE_DIR_RE.test(entry.name)
                && normalizeCompatibleBatchDate(entry.name) === entry.name)
            .sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of entries) {
            scannedArchiveDirs += 1;
            const archiveFile = path.join(archiveDir, entry.name, 'deep-analysis-result.json');
            if (!fs.existsSync(archiveFile)) continue;
            try {
                const { parsed } = readJsonStrictFile(archiveFile, `archive/${entry.name}/deep-analysis-result.json`);
                const papers = extractPaperList(parsed, `archive/${entry.name}/deep-analysis-result.json`);
                validArchiveFiles += 1;
                for (const paper of papers) {
                    const id = normalizedId(paper);
                    if (!id) continue;
                    const proof = buildArchiveRecordProof(paper, entry.name);
                    if (!proof) continue;
                    let list = verifiedArchivedProofs.get(id);
                    if (!list) {
                        list = [];
                        verifiedArchivedProofs.set(id, list);
                    }
                    list.push(proof);
                }
            } catch (error) {
                // Fail-closed: corrupt archive files never grant verified-archived eligibility.
                unreadableArchiveFiles.push({ file: archiveFile, error: error.message });
            }
        }
    }

    return {
        archiveDir: archiveDir ? path.resolve(archiveDir) : null,
        verifiedArchivedProofs,
        scannedArchiveDirs,
        validArchiveFiles,
        unreadableArchiveFiles
    };
}

function collectCurrentBatchContext(currentDir) {
    const currentDeepIds = new Set();
    const currentFilteredIds = new Set();
    const activeCurrentIds = new Set();
    let deepBatchDate = '';
    let filteredBatchDate = '';
    let currentDeepSha256 = '';
    let currentFilteredSha256 = '';

    const currentDeepPath = path.join(currentDir, 'deep-analysis-result.json');
    if (fs.existsSync(currentDeepPath)) {
        const { raw, parsed } = readJsonStrictFile(currentDeepPath, 'current/deep-analysis-result.json');
        currentDeepSha256 = sha256Buffer(raw);
        deepBatchDate = extractArtifactBatchDate(parsed);
        for (const paper of extractPaperList(parsed, 'current/deep-analysis-result.json')) {
            const id = normalizedId(paper);
            if (id) {
                currentDeepIds.add(id);
                activeCurrentIds.add(id);
            }
        }
    }

    const currentFilteredPath = path.join(currentDir, 'filtered-papers.json');
    if (fs.existsSync(currentFilteredPath)) {
        const { raw, parsed } = readJsonStrictFile(currentFilteredPath, 'current/filtered-papers.json');
        currentFilteredSha256 = sha256Buffer(raw);
        filteredBatchDate = extractArtifactBatchDate(parsed);
        for (const paper of extractPaperList(parsed, 'current/filtered-papers.json')) {
            const id = normalizedId(paper);
            if (id) {
                currentFilteredIds.add(id);
                activeCurrentIds.add(id);
            }
        }
    }

    return {
        currentDir: path.resolve(currentDir),
        deepBatchDate,
        filteredBatchDate,
        currentDeepSha256,
        currentFilteredSha256,
        currentDeepIds,
        currentFilteredIds,
        activeCurrentIds
    };
}

function collectArchiveVerificationContext({ currentDir, archiveDir }) {
    const currentContext = collectCurrentBatchContext(currentDir);
    const archiveScan = scanVerifiedArchiveProofs(archiveDir);
    return {
        ...archiveScan,
        ...currentContext
    };
}

function hasAnyHeavyAnalysisBlob(paper) {
    if (!isPlainObject(paper)) return false;
    return VERIFIED_ARCHIVED_BLOB_FIELDS.some(field =>
        Object.prototype.hasOwnProperty.call(paper, field) && paper[field] !== null && paper[field] !== undefined
    );
}

function recordFieldRemoval(breakdownMap, fieldKey, value) {
    const bytes = estimateJsonFieldBytes(fieldKey.includes('.') ? fieldKey.split('.').pop() : fieldKey, value);
    const entry = breakdownMap.get(fieldKey) || { count: 0, bytesSaved: 0 };
    entry.count += 1;
    entry.bytesSaved += bytes;
    breakdownMap.set(fieldKey, entry);
}

function planPapersLedgerCompaction(beforeData, options = {}) {
    const profile = options.profile || DEFAULT_PROFILE;
    if (!COMPACTION_PROFILES.includes(profile)) {
        throw new Error(`不支持的压缩 profile: ${profile}（仅允许 ${COMPACTION_PROFILES.join(' | ')}）`);
    }
    const retainDays = options.retainDays ?? DEFAULT_RETAIN_DAYS;
    if (!Number.isSafeInteger(retainDays) || retainDays < 1) {
        throw new Error(`--retain-days 必须是 >= 1 的整数（收到 ${retainDays}）`);
    }
    const nowIso = options.nowIso || getBeijingISOString();
    const referenceDate = resolveReferenceDate(options.referenceDate, nowIso);
    const activeCurrentIds = options.activeCurrentIds instanceof Set ? options.activeCurrentIds : new Set();
    const verifiedArchivedProofs = options.verifiedArchivedProofs instanceof Map
        ? options.verifiedArchivedProofs
        : new Map();

    validatePapersDatabaseSchema(beforeData);
    const preIssues = validatePapersDatabaseRecords(beforeData);
    if (preIssues.length > 0) {
        throw new Error(`输入 papers.json 未通过数据文件校验，已中止压缩:\n  - ${preIssues.join('\n  - ')}`);
    }

    const beforePapers = beforeData.papers;
    const compactedPapers = {};
    const fieldBreakdownMap = new Map();

    const protectedBreakdown = {
        inCurrent: 0,
        withinRetainDays: 0,
        unknownDate: 0,
        pendingOrFailed: 0,
        hasRecoveryState: 0,
        unarchivedAnalyzed: 0
    };

    let totalPapers = 0;
    let touchedPapers = 0;
    let protectedCount = 0;
    let blobCompactedPapers = 0;
    let ledgerCompactedPapers = 0;

    for (const [key, originalPaper] of Object.entries(beforePapers)) {
        totalPapers += 1;
        const nextPaper = { ...originalPaper };
        const normId = normalizedId(originalPaper) || normalizedId(key);
        const status = originalPaper.digestStatus?.status || null;
        const latestAttemptStatus = originalPaper.digestStatus?.latestAttemptStatus || null;

        const inCurrent = Boolean(normId && activeCurrentIds.has(normId));
        const isPendingOrFailed = status === 'pending_analysis'
            || status === 'analysis_failed'
            || latestAttemptStatus === 'analysis_failed';
        const hasActiveCheckpoint = typeof originalPaper.analysisCheckpoint === 'string'
            && originalPaper.analysisCheckpoint.trim().length > 0;
        const hasRecoveryState = hasActiveCheckpoint
            || Boolean(originalPaper.analysisStageCheckpoints)
            || Boolean(originalPaper.analysisFactReviewObligation);
        const effectiveDate = getMostRecentPaperDate(originalPaper);
        const ageDays = effectiveDate ? diffCalendarDays(effectiveDate, referenceDate) : null;
        const unknownDate = ageDays === null;
        const withinRetainDays = !unknownDate && ageDays <= retainDays;
        const isArchived = Boolean(normId && matchesVerifiedArchiveProof(originalPaper, verifiedArchivedProofs.get(normId)));
        const hasHeavyBlobs = hasAnyHeavyAnalysisBlob(originalPaper);
        const unarchivedAnalyzed = !isArchived && (status === 'analyzed' || hasHeavyBlobs);

        const isProtected = inCurrent
            || unknownDate
            || withinRetainDays
            || isPendingOrFailed
            || hasRecoveryState
            || unarchivedAnalyzed;
        if (isProtected) {
            protectedCount += 1;
            if (inCurrent) protectedBreakdown.inCurrent += 1;
            if (withinRetainDays) protectedBreakdown.withinRetainDays += 1;
            if (unknownDate) protectedBreakdown.unknownDate += 1;
            if (isPendingOrFailed) protectedBreakdown.pendingOrFailed += 1;
            if (hasRecoveryState) protectedBreakdown.hasRecoveryState += 1;
            if (unarchivedAnalyzed) protectedBreakdown.unarchivedAnalyzed += 1;
        }

        let paperTouched = false;

        // 1. Always strip write-time ephemeral fields (both profiles).
        for (const field of PAPERS_LEDGER_STRIP_ON_WRITE_FIELDS) {
            if (Object.prototype.hasOwnProperty.call(nextPaper, field)) {
                recordFieldRemoval(fieldBreakdownMap, field, nextPaper[field]);
                delete nextPaper[field];
                paperTouched = true;
            }
        }

        // 2. Strip analysisRecoveryImageManifest (and leaked pre-14.6A merge attempt metadata)
        // when NOT needed by active failed-reanalysis / recovery.
        const needsRecoveryManifest = inCurrent || isPendingOrFailed || hasRecoveryState;
        if (!needsRecoveryManifest && Object.prototype.hasOwnProperty.call(nextPaper, 'analysisRecoveryImageManifest')) {
            recordFieldRemoval(fieldBreakdownMap, 'analysisRecoveryImageManifest', nextPaper.analysisRecoveryImageManifest);
            delete nextPaper.analysisRecoveryImageManifest;
            paperTouched = true;
        }
        if (!needsRecoveryManifest && isLeakedMergeAttemptMetadata(originalPaper)) {
            for (const leakedField of ['latestAnalysisAttemptError', 'latestAnalysisAttemptAt']) {
                if (Object.prototype.hasOwnProperty.call(nextPaper, leakedField)) {
                    recordFieldRemoval(fieldBreakdownMap, leakedField, nextPaper[leakedField]);
                    delete nextPaper[leakedField];
                    paperTouched = true;
                }
            }
        }

        // 3. Deduplicate summary === abstract (both profiles).
        if (Object.prototype.hasOwnProperty.call(nextPaper, 'summary')
            && typeof nextPaper.summary === 'string'
            && nextPaper.summary === nextPaper.abstract) {
            recordFieldRemoval(fieldBreakdownMap, 'summary (duplicate)', nextPaper.summary);
            delete nextPaper.summary;
            paperTouched = true;
        }

        // 4. Strip heavy analysis blobs ONLY from cryptographically verified-archived historical papers.
        const eligibleForArchivedBlobStrip = !inCurrent
            && !isPendingOrFailed
            && !hasRecoveryState
            && !unknownDate
            && !withinRetainDays
            && isArchived;
        if (eligibleForArchivedBlobStrip) {
            let strippedBlob = false;
            for (const field of VERIFIED_ARCHIVED_BLOB_FIELDS) {
                if (Object.prototype.hasOwnProperty.call(nextPaper, field)) {
                    recordFieldRemoval(fieldBreakdownMap, field, nextPaper[field]);
                    delete nextPaper[field];
                    strippedBlob = true;
                    paperTouched = true;
                }
            }
            if (strippedBlob) blobCompactedPapers += 1;
        }

        // 5. Ledger-only historical metadata trimming.
        const eligibleForLedgerTrim = profile === 'ledger'
            && !inCurrent
            && !isPendingOrFailed
            && !hasRecoveryState
            && !unknownDate
            && !withinRetainDays
            && !unarchivedAnalyzed;
        if (eligibleForLedgerTrim) {
            let trimmedLedger = false;
            for (const field of LEDGER_HISTORICAL_TOP_LEVEL_FIELDS) {
                if (Object.prototype.hasOwnProperty.call(nextPaper, field)) {
                    recordFieldRemoval(fieldBreakdownMap, field, nextPaper[field]);
                    delete nextPaper[field];
                    trimmedLedger = true;
                    paperTouched = true;
                }
            }
            if (isPlainObject(nextPaper.digestStatus)) {
                const nextDigestStatus = { ...nextPaper.digestStatus };
                let digestStatusChanged = false;
                for (const subField of LEDGER_HISTORICAL_DIGEST_STATUS_FIELDS) {
                    if (Object.prototype.hasOwnProperty.call(nextDigestStatus, subField)) {
                        recordFieldRemoval(fieldBreakdownMap, `digestStatus.${subField}`, nextDigestStatus[subField]);
                        delete nextDigestStatus[subField];
                        digestStatusChanged = true;
                        trimmedLedger = true;
                        paperTouched = true;
                    }
                }
                if (digestStatusChanged) {
                    nextPaper.digestStatus = nextDigestStatus;
                }
            }
            if (trimmedLedger) ledgerCompactedPapers += 1;
        }

        if (paperTouched) touchedPapers += 1;
        compactedPapers[key] = nextPaper;
    }

    const beforeGeneration = Number.isInteger(beforeData.generation) ? beforeData.generation : 0;
    const afterData = {
        ...beforeData,
        papers: compactedPapers,
        generation: beforeGeneration + 1,
        lastUpdated: nowIso
    };

    const beforeKeys = Object.keys(beforePapers);
    const afterKeys = Object.keys(afterData.papers);
    if (afterKeys.length !== beforeKeys.length) {
        throw new Error(`压缩计划发生论文数量变化: ${beforeKeys.length} -> ${afterKeys.length}`);
    }
    const afterKeySet = new Set(afterKeys);
    for (const key of beforeKeys) {
        if (!afterKeySet.has(key)) {
            throw new Error(`压缩计划缺失论文 key: ${key}`);
        }
    }

    validatePapersDatabaseSchema(afterData);
    const afterPlanIssues = validatePapersDatabaseRecords(afterData);
    if (afterPlanIssues.length > 0) {
        throw new Error(`压缩后计划未通过数据校验:\n  - ${afterPlanIssues.join('\n  - ')}`);
    }

    const beforeSerialized = options.beforeRawBuffer
        ? options.beforeRawBuffer
        : Buffer.from(serializePapersDatabase(beforeData), 'utf8');
    const beforeSha256 = sha256Buffer(beforeSerialized);
    const afterSerializedString = serializePapersDatabase(afterData);
    const afterSerialized = Buffer.from(afterSerializedString, 'utf8');
    const beforeBytes = beforeSerialized.length;
    const candidateAfterBytes = afterSerialized.length;
    const noOp = touchedPapers === 0 && candidateAfterBytes >= beforeBytes;

    const effectiveAfterBytes = noOp ? beforeBytes : candidateAfterBytes;
    const effectiveAfterSha256 = noOp ? beforeSha256 : sha256Buffer(afterSerialized);
    const effectiveAfterGeneration = noOp ? beforeGeneration : afterData.generation;
    const savingsBytes = noOp ? 0 : beforeBytes - effectiveAfterBytes;
    const savingsPercent = noOp || beforeBytes === 0
        ? 0
        : Number(((savingsBytes / beforeBytes) * 100).toFixed(2));

    const fieldBreakdown = Object.fromEntries(
        [...fieldBreakdownMap.entries()]
            .sort((a, b) => b[1].bytesSaved - a[1].bytesSaved || a[0].localeCompare(b[0]))
    );

    const report = {
        profile,
        retainDays,
        referenceDate,
        noOp,
        before: {
            bytes: beforeBytes,
            sha256: beforeSha256,
            paperCount: beforeKeys.length,
            generation: beforeGeneration
        },
        after: {
            bytes: effectiveAfterBytes,
            sha256: effectiveAfterSha256,
            paperCount: afterKeys.length,
            generation: effectiveAfterGeneration
        },
        savings: {
            bytes: savingsBytes,
            percent: savingsPercent
        },
        counts: {
            totalPapers,
            touchedPapers,
            untouchedPapers: totalPapers - touchedPapers,
            blobCompactedPapers,
            ledgerCompactedPapers,
            protectedCount,
            protectedBreakdown
        },
        fieldBreakdown
    };

    return { compactedDatabase: afterData, afterSerializedString, afterSerialized, noOp, report };
}

function writeVerifiedPreCompactionBackup(papersFile, beforeRawBuffer, receiptDir, options = {}) {
    const targetDir = ensureSafeDirectoryChain(receiptDir, 'receipt/backup 目录');

    const sourceSha256 = sha256Buffer(beforeRawBuffer);
    const compactTs = options.compactTimestamp || getBeijingCompactTimestamp();
    const createdAt = options.createdAt || getBeijingISOString();
    const uniqueSuffix = crypto.randomBytes(4).toString('hex');
    const backupName = `papers-pre-compact-${compactTs}-${sourceSha256.slice(0, 12)}-${uniqueSuffix}.json.gz`;
    const backupPath = path.join(targetDir, backupName);
    const manifestPath = `${backupPath}.manifest.json`;

    const compressedBuffer = zlib.gzipSync(beforeRawBuffer, { level: zlib.constants.Z_BEST_SPEED });
    const compressedSha256 = sha256Buffer(compressedBuffer);
    const maxOutputLength = Math.min(PAPERS_BACKUP_MAX_RAW_BYTES, beforeRawBuffer.length + 1);

    try {
        writeFileAtomic(backupPath, compressedBuffer, { mode: 0o600 });
        if (options.hooks?.afterBackupWrite) {
            options.hooks.afterBackupWrite({ backupPath, manifestPath });
        }

        const writtenCompressed = readRegularFileStrict(backupPath, '压缩前备份文件');
        if (writtenCompressed.length !== compressedBuffer.length
            || sha256Buffer(writtenCompressed) !== compressedSha256) {
            throw new Error(`压缩前备份的压缩字节校验失败: ${backupPath}`);
        }
        const recovered = zlib.gunzipSync(writtenCompressed, { maxOutputLength });
        if (recovered.length !== beforeRawBuffer.length
            || sha256Buffer(recovered) !== sourceSha256) {
            throw new Error(`压缩前备份解压还原校验失败: ${backupPath}`);
        }

        const manifest = {
            contract: PAPERS_BACKUP_CONTRACT,
            createdAt,
            sourceFile: path.basename(papersFile),
            backupFile: backupName,
            sourceBytes: beforeRawBuffer.length,
            sourceSha256,
            compressedBytes: compressedBuffer.length,
            compressedSha256,
            compression: 'gzip'
        };
        if (options.hooks?.beforeManifestWrite) {
            options.hooks.beforeManifestWrite({ backupPath, manifestPath, manifest });
        }
        writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

        const { parsed: verifiedManifest } = readJsonStrictFile(manifestPath, '压缩前备份清单');
        if (verifiedManifest.contract !== PAPERS_BACKUP_CONTRACT
            || verifiedManifest.sourceSha256 !== sourceSha256
            || verifiedManifest.compressedSha256 !== compressedSha256
            || verifiedManifest.backupFile !== backupName) {
            throw new Error(`压缩前备份清单回读校验失败: ${manifestPath}`);
        }

        return {
            backupPath,
            manifestPath,
            sourceBytes: beforeRawBuffer.length,
            sourceSha256,
            compressedBytes: compressedBuffer.length,
            compressedSha256
        };
    } catch (error) {
        try { fs.rmSync(manifestPath, { force: true }); } catch (_) { /* ignore cleanup failure */ }
        try { fs.rmSync(backupPath, { force: true }); } catch (_) { /* ignore cleanup failure */ }
        throw error;
    }
}

function resolveCompactionPaths(options = {}) {
    const hasExplicitPapersFile = Boolean(options.papersFile);
    const hasExplicitCurrentDir = Boolean(options.currentDir);

    let papersFile;
    let currentDir;
    if (hasExplicitPapersFile && hasExplicitCurrentDir) {
        papersFile = path.resolve(options.papersFile);
        currentDir = path.resolve(options.currentDir);
    } else if (hasExplicitPapersFile) {
        papersFile = path.resolve(options.papersFile);
        currentDir = path.dirname(papersFile);
    } else if (hasExplicitCurrentDir) {
        currentDir = path.resolve(options.currentDir);
        papersFile = path.join(currentDir, 'papers.json');
    } else {
        papersFile = path.resolve(Config.FILES.papers);
        currentDir = path.resolve(Config.CURRENT_DIR);
    }

    const archiveDir = path.resolve(options.archiveDir || Config.ARCHIVE_DIR);
    const receiptDir = path.resolve(
        options.receiptDir || path.join(Config.DATA_DIR, 'runtime', 'papers-compaction')
    );

    return { papersFile, currentDir, archiveDir, receiptDir };
}

function compactPapersLedger(options = {}) {
    const write = options.write === true;
    const profile = options.profile || DEFAULT_PROFILE;
    const retainDays = options.retainDays ?? DEFAULT_RETAIN_DAYS;
    if (!COMPACTION_PROFILES.includes(profile)) {
        throw new Error(`不支持的压缩 profile: ${profile}（仅允许 ${COMPACTION_PROFILES.join(' | ')}）`);
    }
    if (!Number.isSafeInteger(retainDays) || retainDays < 1) {
        throw new Error(`--retain-days 必须是 >= 1 的整数（收到 ${retainDays}）`);
    }
    const nowIso = options.nowIso || getBeijingISOString();
    const referenceDate = resolveReferenceDate(options.referenceDate, nowIso);

    const { papersFile, currentDir, archiveDir, receiptDir } = resolveCompactionPaths(options);

    // Scan immutable data/archive/ BEFORE acquiring papers.json.lock to keep lock hold minimal.
    const archiveScan = scanVerifiedArchiveProofs(archiveDir);

    const execute = () => {
        if (!fs.existsSync(papersFile)) {
            throw new Error(`目标论文库文件不存在: ${papersFile}`);
        }

        // Gate 2: Input database schema validation (strict O_NOFOLLOW single read + pure in-memory checks).
        const { raw: beforeRawBuffer, parsed: beforeData } = readJsonStrictFile(papersFile, 'papers.json');
        const beforeSha256 = sha256Buffer(beforeRawBuffer);
        validatePapersDatabaseSchema(beforeData);
        const preValidationIssues = validatePapersDatabaseRecords(beforeData, path.basename(papersFile));
        if (preValidationIssues.length > 0) {
            throw new Error(`输入 papers.json 未通过数据文件校验，已中止压缩:\n  - ${preValidationIssues.join('\n  - ')}`);
        }

        // Gate 4 (current batch discovery inside lock): exact current/ IDs & file SHAs.
        const currentContext = collectCurrentBatchContext(currentDir);

        // Gate 3: Full-directory fail-closed active waiver guard.
        const waiverGuard = checkActiveWaiverGuard({
            currentDir,
            papersSha256: beforeSha256,
            deepBatchDate: currentContext.deepBatchDate,
            filteredBatchDate: currentContext.filteredBatchDate,
            currentDeepSha256: currentContext.currentDeepSha256,
            currentFilteredSha256: currentContext.currentFilteredSha256
        });

        const { compactedDatabase, afterSerializedString, afterSerialized, noOp, report } = planPapersLedgerCompaction(
            beforeData,
            {
                profile,
                retainDays,
                referenceDate,
                nowIso,
                beforeRawBuffer,
                activeCurrentIds: currentContext.activeCurrentIds,
                verifiedArchivedProofs: archiveScan.verifiedArchivedProofs
            }
        );

        const fullReport = {
            contract: COMPACTION_RECEIPT_CONTRACT,
            mode: write ? 'write' : 'dry-run',
            compactedAt: nowIso,
            papersFile,
            currentDir,
            archiveDir,
            receiptDir,
            ...report,
            waiverGuard,
            archiveVerification: {
                archiveDir: archiveScan.archiveDir,
                deepBatchDate: currentContext.deepBatchDate || null,
                filteredBatchDate: currentContext.filteredBatchDate || null,
                scannedArchiveDirs: archiveScan.scannedArchiveDirs,
                validArchiveFiles: archiveScan.validArchiveFiles,
                unreadableArchiveFiles: archiveScan.unreadableArchiveFiles,
                verifiedArchivedCount: archiveScan.verifiedArchivedProofs.size,
                currentDeepCount: currentContext.currentDeepIds.size,
                currentFilteredCount: currentContext.currentFilteredIds.size,
                activeCurrentCount: currentContext.activeCurrentIds.size
            },
            backup: null,
            receiptPath: null
        };

        if (!write || noOp) {
            return fullReport;
        }

        // Gate 5: Mandatory pre-compaction verified gzip backup + manifest BEFORE writing papers.json.
        const compactTs = getBeijingCompactTimestamp();
        const backup = writeVerifiedPreCompactionBackup(papersFile, beforeRawBuffer, receiptDir, {
            compactTimestamp: compactTs,
            createdAt: nowIso,
            hooks: options.backupHooks
        });
        fullReport.backup = backup;

        // Gate 6: Atomic write + zero-key-loss post-check + post-write schema validation + receipt.
        writeFileAtomic(papersFile, afterSerializedString, { mode: 0o600 });

        const writtenRaw = readRegularFileStrict(papersFile, '压缩后 papers.json');
        const writtenSha256 = sha256Buffer(writtenRaw);
        if (writtenSha256 !== fullReport.after.sha256 || writtenRaw.length !== afterSerialized.length) {
            throw new Error(`压缩后回读校验失败：SHA-256 或字节数不匹配 (${papersFile})`);
        }
        const writtenData = JSON.parse(writtenRaw.toString('utf8'));
        validatePapersDatabaseSchema(writtenData);
        const postValidationIssues = validatePapersDatabaseRecords(writtenData, path.basename(papersFile));
        if (postValidationIssues.length > 0) {
            throw new Error(`压缩后 papers.json 未通过数据文件校验:\n  - ${postValidationIssues.join('\n  - ')}`);
        }
        const beforeCount = Object.keys(beforeData.papers).length;
        const afterCount = Object.keys(writtenData.papers).length;
        if (afterCount !== beforeCount) {
            throw new Error(`压缩后论文数量不一致: before=${beforeCount}, after=${afterCount}`);
        }
        if (writtenData.generation !== compactedDatabase.generation) {
            throw new Error(`压缩后 generation 不一致: expected=${compactedDatabase.generation}, actual=${writtenData.generation}`);
        }

        const safeReceiptDir = ensureSafeDirectoryChain(receiptDir, 'receipt 目录');
        const receiptName = `papers-compaction-receipt-${compactTs}-${writtenSha256.slice(0, 12)}-${crypto.randomBytes(4).toString('hex')}.json`;
        const receiptPath = path.join(safeReceiptDir, receiptName);
        fullReport.receiptPath = receiptPath;
        writeFileAtomic(receiptPath, `${JSON.stringify(fullReport, null, 2)}\n`, { mode: 0o600 });

        return fullReport;
    };

    // Gate 1: Acquire papers.json file lock for --write; strictly zero writes for --dry-run.
    if (write) {
        return withFileLockSync(papersFile, execute, {
            recoveryPolicy: LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY
        });
    }
    return execute();
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatCompactionReportText(report) {
    const noOpNote = report.noOp ? ' [no-op: 无变更，未重写/未生成备份]' : '';
    const lines = [
        `papers.json 压缩报告 [${report.mode}]${noOpNote} (profile=${report.profile}, retainDays=${report.retainDays}, referenceDate=${report.referenceDate})`,
        `目标文件: ${report.papersFile}`,
        `体积变化: ${report.before.bytes} B (${formatBytes(report.before.bytes)}) -> ${report.after.bytes} B (${formatBytes(report.after.bytes)}) | 节省 ${report.savings.bytes} B (${report.savings.percent}%)`,
        `论文条数: ${report.before.paperCount} -> ${report.after.paperCount}（零丢键） | generation: ${report.before.generation} -> ${report.after.generation}`,
        `受保护条数: ${report.counts.protectedCount} (current=${report.counts.protectedBreakdown.inCurrent}, retainDays=${report.counts.protectedBreakdown.withinRetainDays}, unknownDate=${report.counts.protectedBreakdown.unknownDate}, pendingOrFailed=${report.counts.protectedBreakdown.pendingOrFailed}, recoveryState=${report.counts.protectedBreakdown.hasRecoveryState}, unarchivedAnalyzed=${report.counts.protectedBreakdown.unarchivedAnalyzed})`,
        `归档核验: 扫描 ${report.archiveVerification.scannedArchiveDirs} 个日期目录，有效 ${report.archiveVerification.validArchiveFiles} 个，确认已归档有效分析 ${report.archiveVerification.verifiedArchivedCount} 篇，当前活跃批次 ${report.archiveVerification.activeCurrentCount} 篇`,
        `变更统计: 修改 ${report.counts.touchedPapers} 篇，未改动 ${report.counts.untouchedPapers} 篇（归档正文瘦身 ${report.counts.blobCompactedPapers} 篇，台账历史瘦身 ${report.counts.ledgerCompactedPapers} 篇）`
    ];
    const fieldEntries = Object.entries(report.fieldBreakdown || {});
    if (fieldEntries.length > 0) {
        lines.push('按字段节省明细:');
        for (const [field, stats] of fieldEntries) {
            lines.push(`  - ${field}: ${stats.count} 条, ~${stats.bytesSaved} B (${formatBytes(stats.bytesSaved)})`);
        }
    } else {
        lines.push('按字段节省明细: 无可清理字段');
    }
    if (report.backup) {
        lines.push(`压缩前备份: ${report.backup.backupPath} (compressed=${report.backup.compressedBytes} B, sourceSha256=${report.backup.sourceSha256})`);
    }
    if (report.receiptPath) {
        lines.push(`压缩回执: ${report.receiptPath}`);
    }
    return lines.join('\n');
}

function parseCompactPapersArgs(argv = []) {
    const options = {
        write: false,
        dryRun: true,
        profile: DEFAULT_PROFILE,
        retainDays: DEFAULT_RETAIN_DAYS,
        json: false,
        help: false
    };
    let explicitDryRun = false;
    let explicitWrite = false;
    const seenValueFlags = new Set();

    const readFlagValue = (flag, inlineValue, argvList, index) => {
        if (seenValueFlags.has(flag)) {
            throw new Error(`参数不得重复: ${flag}`);
        }
        seenValueFlags.add(flag);
        if (inlineValue !== undefined) {
            if (!inlineValue) throw new Error(`参数缺少取值: ${flag}`);
            return { value: inlineValue, nextIndex: index };
        }
        const next = argvList[index + 1];
        if (next === undefined || next.startsWith('--')) {
            throw new Error(`参数缺少取值: ${flag}`);
        }
        return { value: next, nextIndex: index + 1 };
    };

    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        const eqIdx = token.indexOf('=');
        const flag = eqIdx > 0 ? token.slice(0, eqIdx) : token;
        const inlineValue = eqIdx > 0 ? token.slice(eqIdx + 1) : undefined;

        if (flag === '--help' || flag === '-h') {
            options.help = true;
            continue;
        }
        if (flag === '--dry-run') {
            if (inlineValue !== undefined) throw new Error('--dry-run 不接受参数值');
            explicitDryRun = true;
            continue;
        }
        if (flag === '--write') {
            if (inlineValue !== undefined) throw new Error('--write 不接受参数值');
            explicitWrite = true;
            continue;
        }
        if (flag === '--json') {
            if (inlineValue !== undefined) throw new Error('--json 不接受参数值');
            options.json = true;
            continue;
        }
        if (flag === '--profile') {
            const { value, nextIndex } = readFlagValue(flag, inlineValue, argv, i);
            i = nextIndex;
            if (!COMPACTION_PROFILES.includes(value)) {
                throw new Error(`--profile 必须是 ${COMPACTION_PROFILES.join(' 或 ')}（收到 ${value}）`);
            }
            options.profile = value;
            continue;
        }
        if (flag === '--retain-days') {
            const { value, nextIndex } = readFlagValue(flag, inlineValue, argv, i);
            i = nextIndex;
            if (!/^\d+$/.test(value)) {
                throw new Error(`--retain-days 必须是 >= 1 的整数（收到 ${value}）`);
            }
            const parsed = Number(value);
            if (!Number.isSafeInteger(parsed) || parsed < 1) {
                throw new Error(`--retain-days 必须是 >= 1 的整数（收到 ${value}）`);
            }
            options.retainDays = parsed;
            continue;
        }
        if (flag === '--papers-file') {
            const { value, nextIndex } = readFlagValue(flag, inlineValue, argv, i);
            i = nextIndex;
            options.papersFile = value;
            continue;
        }
        if (flag === '--current-dir') {
            const { value, nextIndex } = readFlagValue(flag, inlineValue, argv, i);
            i = nextIndex;
            options.currentDir = value;
            continue;
        }
        if (flag === '--archive-dir') {
            const { value, nextIndex } = readFlagValue(flag, inlineValue, argv, i);
            i = nextIndex;
            options.archiveDir = value;
            continue;
        }
        if (flag === '--receipt-dir') {
            const { value, nextIndex } = readFlagValue(flag, inlineValue, argv, i);
            i = nextIndex;
            options.receiptDir = value;
            continue;
        }
        throw new Error(`未知参数: ${token}`);
    }

    if (explicitDryRun && explicitWrite) {
        throw new Error('不能同时指定 --dry-run 和 --write');
    }
    options.write = explicitWrite;
    options.dryRun = !explicitWrite;
    return options;
}

function usageText() {
    return [
        '用法: node scripts/compact-papers-ledger.js [--dry-run | --write] [--profile ledger|safe-blobs] [--retain-days N] [--papers-file PATH] [--current-dir DIR] [--archive-dir DIR] [--receipt-dir DIR] [--json]',
        '',
        '默认 --dry-run（严格只读，不产生任何写入）。',
        '  --profile safe-blobs  清理写入期临时字段、非活动恢复图清单、重复 summary，并仅清理经密码学哈希核验已归档的历史论文分析大字段',
        '  --profile ledger      包含 safe-blobs 全部清理，并对超过 --retain-days 的非活动历史条目精简 abstract/summary/hf_ai_* 与筛选冗长字段（默认）',
        '  --retain-days N       保护最近 N 天内的论文（默认 14，最小 1）'
    ].join('\n');
}

function main(argv = process.argv.slice(2)) {
    const options = parseCompactPapersArgs(argv);
    if (options.help) {
        console.log(usageText());
        return null;
    }
    const report = compactPapersLedger(options);
    if (options.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        console.log(formatCompactionReportText(report));
    }
    return report;
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`[compact-papers-ledger] ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    COMPACTION_PROFILES,
    DEFAULT_PROFILE,
    DEFAULT_RETAIN_DAYS,
    COMPACTION_RECEIPT_CONTRACT,
    VERIFIED_ARCHIVED_BLOB_FIELDS,
    LEDGER_HISTORICAL_TOP_LEVEL_FIELDS,
    LEDGER_HISTORICAL_DIGEST_STATUS_FIELDS,
    validatePapersDatabaseRecords,
    buildArchiveRecordProof,
    matchesVerifiedArchiveProof,
    scanVerifiedArchiveProofs,
    collectCurrentBatchContext,
    collectArchiveVerificationContext,
    checkActiveWaiverGuard,
    isLeakedMergeAttemptMetadata,
    getMostRecentPaperDate,
    parseCompactPapersArgs,
    planPapersLedgerCompaction,
    writeVerifiedPreCompactionBackup,
    compactPapersLedger,
    formatCompactionReportText,
    main
};
