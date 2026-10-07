'use strict';

// 默认 API 日更先筛选论文，然后在任何一篇进入深度分析之前，把官方 arXiv
// HTML/PDF 来源对核验后保存下来。这套流程与历史发布运行、data/current 都分开：
// 日更来源包是可以重新核对的证据，不是能随批次检查点一起轮换掉的缓存。

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Config = require('../config.js');
const { normalizedId } = require('../utils.js');
const fresh = require('./fresh-analysis-context.js');
const arxivSource = require('./fresh-arxiv-rewrite-source.js');
const direct = require('./direct-rewrite-analysis-context.js');

const CONTRACT = fresh.DAILY_SOURCE_RUN_CONTRACT;
const VERSION = 1;
const SOURCE_GENERATION = 1;
const REFERENCE_CONTRACT = 'daily-fresh-source-reference-v1';
const REFERENCE_VERSION = 1;
const ARXIV_ID = /^\d{4}\.\d{4,5}$/;
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

class DailyFreshSourcePlanError extends Error {
    constructor(message) {
        super(`Daily fresh source plan rejected: ${message}`);
        this.code = 'DAILY_FRESH_SOURCE_PLAN_INTEGRITY';
        this.retryable = false;
    }
}
const fail = message => { throw new DailyFreshSourcePlanError(message); };
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
        : value;
const stableHash = value => sha256(JSON.stringify(canonical(value)));

function validDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
        && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function safeDirectory(value, create = false, label = 'directory') {
    if (typeof value !== 'string' || !path.isAbsolute(value)) fail(`${label} must be an absolute path`);
    const absolute = path.resolve(value); let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part); let stat;
        try { stat = fs.lstatSync(cursor); }
        catch (error) {
            if (error.code !== 'ENOENT' || !create) throw error;
            fs.mkdirSync(cursor, { mode: 0o700 }); stat = fs.lstatSync(cursor);
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} is unsafe: ${cursor}`);
    }
    return absolute;
}

function readPrivateBytes(filename, label, maximum = 4 * 1024 * 1024) {
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum
            || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)) fail(`${label} is unsafe or oversized`);
        return fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
}

function readPrivateJson(filename, label) {
    try {
        return JSON.parse(readPrivateBytes(filename, label).toString('utf8'));
    } catch (error) {
        if (error instanceof DailyFreshSourcePlanError) throw error;
        fail(`${label} is invalid JSON: ${error.message}`);
    }
}

function writePrivateAtomic(filename, value) {
    const bytes = Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`, 'utf8');
    const directory = safeDirectory(path.dirname(filename), true, 'daily source run directory');
    if (fs.existsSync(filename)) {
        const existing = fs.readFileSync(filename);
        if (!existing.equals(bytes) || (fs.lstatSync(filename).mode & 0o777) !== 0o600) {
            fail(`daily source run manifest differs: ${filename}`);
        }
        return;
    }
    const temporary = path.join(directory, `.${path.basename(filename)}.${crypto.randomUUID()}.tmp`);
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    try { fs.linkSync(temporary, filename); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = fs.readFileSync(filename);
        if (!existing.equals(bytes)) throw error;
    } finally { fs.unlinkSync(temporary); }
}

function uuidFromHash(value) {
    const bytes = Buffer.from(sha256(value).slice(0, 32), 'hex');
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sourceIds(papers) {
    if (!Array.isArray(papers)) fail('papers must be an array');
    const ids = papers.map(paper => normalizedId(paper));
    if (ids.some(id => !ARXIV_ID.test(id))) fail('daily selected paper lacks a normalized arXiv identity');
    if (new Set(ids).size !== ids.length) fail('daily selected paper set has duplicate arXiv identities');
    return ids.sort();
}

function sourceRunDirectory(rootDir, runId) {
    return path.join(safeDirectory(rootDir, true, 'daily source root'), runId);
}

function createDailyFreshSourcePlan({ batchDate, batchId, papers, rootDir = Config.FILES.dailyFreshSourceRunsDir } = {}) {
    if (!validDate(batchDate)) fail('batchDate is invalid');
    if (typeof batchId !== 'string' || !batchId.trim() || batchId.length > 200) fail('batchId is invalid');
    const paperIds = sourceIds(papers);
    const sourceSetSha256 = stableHash({ batchDate, batchId, paperIds, sourceGeneration: SOURCE_GENERATION });
    const runId = uuidFromHash(`${CONTRACT}\0${sourceSetSha256}`);
    const runDir = sourceRunDirectory(rootDir, runId);
    const sourceExpectations = Object.fromEntries(paperIds.map(id => [id, {
        sourceMode: fresh.BUNDLE_SOURCE_MODE, sourceGeneration: SOURCE_GENERATION
    }]));
    const manifest = { contract: CONTRACT, version: VERSION, runId, batchDate, batchId, paperIds,
        sourceSetSha256, sourceExpectations };
    writePrivateAtomic(path.join(runDir, 'run.json'), manifest);
    // 用深度分析将要使用的那个严格来源上下文检查器，重新读取已保存的字节。
    // 这样在发出任何来源请求或模型调用之前，就能挡住被改动或不属于本次运行的来源。
    const stored = readPrivateJson(path.join(runDir, 'run.json'), 'daily source run manifest');
    if (stableHash(stored) !== stableHash(manifest)) fail('daily source run manifest drifted');
    return { ...clone(manifest), runDir, sourcesDir: path.join(runDir, 'sources'),
        readerAttemptsDir: path.join(runDir, 'reader-attempts') };
}

function dailyFreshSourceReference(plan) {
    if (!plan || plan.contract !== CONTRACT || plan.version !== VERSION || !validDate(plan.batchDate)
        || typeof plan.batchId !== 'string' || !SHA.test(String(plan.sourceSetSha256 || ''))
        || !Array.isArray(plan.paperIds) || !plan.paperIds.length || typeof plan.runId !== 'string' || !plan.runId) {
        fail('daily source plan cannot produce a reference');
    }
    const manifestFile = path.join(plan.runDir, 'run.json');
    const bytes = readPrivateBytes(manifestFile, 'daily source run manifest');
    const stored = readPrivateJson(manifestFile, 'daily source run manifest');
    if (stableHash(stored) !== stableHash({ contract: CONTRACT, version: VERSION, runId: plan.runId,
        batchDate: plan.batchDate, batchId: plan.batchId, paperIds: plan.paperIds,
        sourceSetSha256: plan.sourceSetSha256, sourceExpectations: plan.sourceExpectations })) {
        fail('daily source run manifest drifted before reference creation');
    }
    return Object.freeze({ contract: REFERENCE_CONTRACT, version: REFERENCE_VERSION, runId: plan.runId,
        batchDate: plan.batchDate, batchId: plan.batchId, sourceGeneration: SOURCE_GENERATION,
        sourceSetSha256: plan.sourceSetSha256, runManifestSha256: sha256(bytes) });
}

function readDailyFreshSourcePlan(reference, { rootDir = Config.FILES.dailyFreshSourceRunsDir } = {}) {
    const keys = ['batchDate', 'batchId', 'contract', 'runId', 'runManifestSha256', 'sourceGeneration',
        'sourceSetSha256', 'version'];
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)
        || Object.keys(reference).sort().join('\0') !== keys.join('\0')
        || reference.contract !== REFERENCE_CONTRACT || reference.version !== REFERENCE_VERSION
        || !UUID.test(String(reference.runId || '')) || !validDate(reference.batchDate)
        || typeof reference.batchId !== 'string' || !reference.batchId
        || reference.sourceGeneration !== SOURCE_GENERATION || !SHA.test(String(reference.sourceSetSha256 || ''))
        || !SHA.test(String(reference.runManifestSha256 || ''))) {
        fail('daily source reference is invalid');
    }
    const root = safeDirectory(rootDir, false, 'daily source root');
    const runDir = path.join(root, reference.runId); safeDirectory(runDir, false, 'daily source run directory');
    const manifestFile = path.join(runDir, 'run.json');
    const bytes = readPrivateBytes(manifestFile, 'daily source run manifest');
    if (sha256(bytes) !== reference.runManifestSha256) fail('daily source run manifest SHA drifted');
    const manifest = readPrivateJson(manifestFile, 'daily source run manifest');
    const plan = { ...manifest, runDir, sourcesDir: path.join(runDir, 'sources'),
        readerAttemptsDir: path.join(runDir, 'reader-attempts') };
    const replayed = dailyFreshSourceReference(plan);
    if (stableHash(replayed) !== stableHash(reference)) fail('daily source reference does not match sealed run');
    return plan;
}

function analysisIdentity(plan) {
    return { runId: plan.runId, runDir: plan.runDir, sourceExpectations: clone(plan.sourceExpectations),
        refreshReaderDiagnostics: false };
}

function bounded(items, concurrency, callback) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) fail('concurrency must be between 1 and 8');
    let cursor = 0;
    const worker = async () => {
        const results = [];
        while (cursor < items.length) results.push(await callback(items[cursor++]));
        return results;
    };
    return Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, worker)).then(groups => groups.flat());
}

async function captureDailyFreshSources(plan, options = {}) {
    if (!plan || plan.contract !== CONTRACT || plan.version !== VERSION || !Array.isArray(plan.paperIds)) fail('daily source plan is invalid');
    const capture = options.capture || arxivSource.captureFreshArxivRewriteSource;
    if (typeof capture !== 'function') fail('source capture function is required');
    const concurrency = options.concurrency || Config.ANALYSIS_CONFIG.concurrency;
    const identity = analysisIdentity(plan);
    const results = await bounded(plan.paperIds, concurrency, async arxivId => {
        const captured = await capture({ rootDir: plan.sourcesDir, arxivId, generation: SOURCE_GENERATION });
        if (!captured || captured.arxivId !== arxivId || captured.generation !== SOURCE_GENERATION
            || !SHA.test(String(captured.sourceManifestSha256 || ''))
            || !SHA.test(String(captured.manifest?.text?.responseSha256 || ''))
            || !SHA.test(String(captured.manifest?.pdf?.responseSha256 || ''))) {
            fail(`${arxivId} source capture did not return a sealed PDF/TXT manifest`);
        }
        const details = fresh.readFreshSource(plan.runDir, { arxivId }, identity);
        if (!details || details.freshSourceDescriptor?.sourceGeneration !== SOURCE_GENERATION
            || details.freshSourceDescriptor?.sourceManifestSha256 !== captured.sourceManifestSha256) {
            fail(`${arxivId} sealed source cannot be replayed after capture`);
        }
        return { arxivId, status: captured.status, sourceManifestSha256: captured.sourceManifestSha256,
            sourceSha256: details.freshSourceDescriptor.sourceSha256 };
    });
    return results.sort((left, right) => left.arxivId.localeCompare(right.arxivId));
}

function readDailyFreshSource(plan, paper) {
    const id = normalizedId(paper);
    if (!plan.paperIds.includes(id)) fail('paper is outside this daily source plan');
    const details = fresh.readFreshSource(plan.runDir, { arxivId: id }, analysisIdentity(plan));
    if (!details) fail(`${id} source is not sealed before analysis`);
    return details;
}

function isPaperBoundToPlan(paper, plan) {
    try {
        const details = readDailyFreshSource(plan, paper);
        const proof = paper?.freshRewriteProvenance;
        const versionMatches = details.sourceVersion
            ? Object.hasOwn(paper || {}, 'sourceVersion')
                && stableHash(paper.sourceVersion) === stableHash(details.sourceVersion)
                && proof?.sourceVersionIdentitySha256 === details.sourceVersion.identitySha256
            : !Object.hasOwn(paper || {}, 'sourceVersion')
                && !Object.hasOwn(proof || {}, 'sourceVersionIdentitySha256');
        return Boolean(proof && proof.contract === fresh.CONTRACT && proof.runId === plan.runId
            && versionMatches
            && proof.sourceGeneration === SOURCE_GENERATION
            && proof.sourceManifestSha256 === details.freshSourceDescriptor.sourceManifestSha256
            && proof.sourceSha256 === details.freshSourceDescriptor.sourceSha256
            && proof.sourceSnapshotSha256 === details.freshSourceDescriptor.sourceSnapshotSha256
            && stableHash(paper?.analysisManifest?.freshRewriteProvenance) === stableHash(proof)
            && paper?.sourceSha256 === proof.sourceSha256
            && paper?.analysisManifest?.sourceAcquisition?.sourceSha256 === proof.sourceSha256);
    } catch { return false; }
}

// 恢复命令有意不创建来源运行，也不调用 captureDailyFreshSources()。恢复只能使用
// 日更抓取阶段在分析开始前保存的那一组 PDF/TXT generation。把这个检查放在这里，
// deep-only、reanalyze、batch 和 Reader 刷新就共用同一个「当前来源包是否可用」的
// 判定，判定不通过就停下。
function requireDailyFreshSourceRecoveryPlan(payload, { papers = null, label = 'daily recovery' } = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        fail(`${label} requires a canonical daily object envelope`);
    }
    const rows = papers === null ? payload.papers : papers;
    if (!Array.isArray(rows) || rows.length === 0) {
        fail(`${label} requires non-empty canonical papers`);
    }
    const reference = payload.dailyFreshSourceRun;
    if (!reference) fail(`${label} requires current dailyFreshSourceRun`);
    const plan = readDailyFreshSourcePlan(reference);
    if (payload.batchDate !== plan.batchDate) {
        fail(`${label} batchDate differs from the sealed daily source run`);
    }
    const ids = rows.map(normalizedId);
    if (ids.some(id => !ARXIV_ID.test(id)) || new Set(ids).size !== ids.length
        || ids.length !== plan.paperIds.length
        || ids.slice().sort().join('\0') !== plan.paperIds.join('\0')) {
        fail(`${label} papers do not exactly match the sealed daily source run`);
    }
    // 在改动任何状态、调用模型或处理图片之前，先把每个 generation 读一遍。
    // readDailyFreshSource 会重新核对 manifest、TXT、PDF 和 runtime 元数据；
    // 文件缺失、内容被改或包不完整都会被拒绝。
    for (const paper of rows) readDailyFreshSource(plan, paper);
    return plan;
}

const GENERATED_FIELDS = Object.freeze([
    'analysis', 'parsed', 'analysisManifest', 'analysisCheckpoint', 'analysisStageCheckpoints',
    'apiReaderArticle', 'apiReaderArticleSha256', 'apiReaderPlan', 'apiReaderFigures', 'apiReaderResources',
    'imageManifest', 'freshRewriteProvenance', 'sourceSha256', 'sourceTextChars', 'sourceWarnings',
    'analysisSource', 'sourceId', 'sourceVersion', 'usedTextSha256', 'structuredArtifactsSha256', 'fullTextAvailable',
    'fullText', 'pdfText',
    // 这些值是图片恢复过程生成的状态，不是来源元数据。留着它们，新一轮已保存的
    // 日更来源运行就可能在看本次新抓的 HTML 之前，先从上一轮当前分析里挑出一个 URL。
    'analysisRecoveryImageManifest', 'imageUrls', 'selectedImageUrls', 'allImageUrls'
]);

function prepareDailyPaper(paper, plan) {
    if (isPaperBoundToPlan(paper, plan)) return clone(paper);
    const clean = clone(paper);
    for (const field of GENERATED_FIELDS) delete clean[field];
    return clean;
}

async function ephemeralReaderFigures(arxivId, figures, plan, options = {}) {
    const materialized = [];
    for (const figure of figures) {
        try {
            const cached = options.figureCache instanceof Map
                ? options.figureCache.get(figure.url) : null;
            if (cached) {
                const bytes = Buffer.from(cached.base64, 'base64');
                if (sha256(bytes) !== cached.sha256
                    || !/^image\/(?:png|jpeg|webp|svg\+xml)$/.test(String(cached.mime || ''))) {
                    fail(`daily Reader Figure ${figure.ordinal} invocation cache drift`);
                }
                materialized.push({
                    ...figure,
                    rawBytes: bytes,
                    assetSha256: cached.sha256,
                    assetMediaType: cached.mime
                });
                continue;
            }
            let current;
            let lastError;
            const maxAttempts = Number.isInteger(options.figureMaxAttempts)
                ? Math.max(1, Math.min(3, options.figureMaxAttempts)) : 3;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    current = await arxivSource.withEphemeralArxivFigures({ arxivId, figures: [figure],
                        sourceRoot: plan.sourcesDir, temporaryRoot: options.temporaryRoot || os.tmpdir(),
                        persistentRoots: [plan.runDir] }, async temporary => temporary.figures.map(item => {
                        const bytes = fs.readFileSync(item.tempPath);
                        return { ...figure, rawBytes: bytes, assetSha256: sha256(bytes),
                            assetMediaType: item.mediaType };
                    }), { fetchFigure: options.fetchFigure });
                    break;
                } catch (error) {
                    lastError = error;
                    const transient = error?.name === 'AbortError'
                        || /(?:timeout|timed out|fetch failed|ECONNRESET|EAI_AGAIN|socket)/i
                            .test(String(error?.message || ''));
                    if (!transient || attempt === maxAttempts) throw error;
                    console.log(`    [deep] ⚠️  论文图 ${figure.ordinal} 临时下载失败，重试 ${attempt + 1}/${maxAttempts}`);
                }
            }
            if (!current) throw lastError || new Error(`论文图 ${figure.ordinal} 下载未产生结果`);
            if (options.figureCache instanceof Map) {
                for (const item of current) {
                    options.figureCache.set(item.url, {
                        base64: item.rawBytes.toString('base64'),
                        mime: item.assetMediaType,
                        sha256: item.assetSha256
                    });
                }
            }
            materialized.push(...current);
        } catch (error) {
            // 沿用权威的 Reader 分类结果，包括返回 404 的官方 Figure。其他来源图片
            // 仍然可用；网络抖动和服务器故障依然会在这里中止。
            const permanentFigureError = require('../deep-analyzer.js')
                .isPermanentApiReaderFigureFailure(error);
            if (!permanentFigureError) throw error;
            console.log(`    [deep] ⚠️  跳过不可用的论文图 ${figure.ordinal}: ${error.message}`);
        }
    }
    return materialized;
}

async function ephemeralPrimaryImage(arxivId, url, plan, options = {}) {
    return arxivSource.withEphemeralArxivFigures({ arxivId, figures: [{ ordinal: 1, url }], sourceRoot: plan.sourcesDir,
        temporaryRoot: options.temporaryRoot || os.tmpdir(), persistentRoots: [plan.runDir] }, async temporary => {
        const item = temporary.figures[0]; const bytes = fs.readFileSync(item.tempPath);
        return { base64: bytes.toString('base64'), mime: item.mediaType, sha256: sha256(bytes), cacheHit: false };
    }, { fetchFigure: options.fetchFigure });
}

async function withDailyFreshPaperSource(plan, paper, callback, options = {}) {
    if (typeof callback !== 'function') fail('daily recovery callback is required');
    const id = normalizedId(paper);
    const sourceDetails = readDailyFreshSource(plan, paper);
    const sourceVersion = sourceDetails.sourceVersion ? clone(sourceDetails.sourceVersion) : null;
    if (sourceVersion) paper.sourceVersion = clone(sourceVersion);
    else delete paper.sourceVersion;
    const figureCache = new Map();
    const result = await direct.withDirectRewriteAnalysisSource({ paperId: `arxiv:${id}`,
        route: 'arxiv-fresh-fetch', sourceDetails, runId: plan.runId,
        sourceSha256: sourceDetails.freshSourceDescriptor.sourceSha256,
        structuredArtifactsSha256: sourceDetails.freshSourceDescriptor.structuredArtifactsSha256,
        sourceGeneration: sourceDetails.freshSourceDescriptor.sourceGeneration,
        sourceManifestSha256: sourceDetails.freshSourceDescriptor.sourceManifestSha256,
        sourceSnapshotSha256: sourceDetails.freshSourceDescriptor.sourceSnapshotSha256,
        ...(sourceVersion ? {
            sourceVersionIdentitySha256: sourceVersion.identitySha256
        } : {}),
        readerAttemptsDir: plan.readerAttemptsDir,
        materializeReaderFigures: (figures, requestedId) => ephemeralReaderFigures(
            requestedId, figures, plan, { ...options, figureCache }
        ),
        downloadPrimaryImage: async url => {
            const image = await ephemeralPrimaryImage(id, url, plan, options);
            figureCache.set(url, image);
            return image;
        } },
    () => callback(sourceDetails));
    const output = result && typeof result === 'object' && !Array.isArray(result) ? { ...result } : result;
    if (output && typeof output === 'object' && !Array.isArray(output)) {
        if (sourceVersion) output.sourceVersion = clone(sourceVersion);
        else delete output.sourceVersion;
    }
    direct.assertNoPersistentFigureFields(output);
    return output;
}

function createDailyAnalyzeFn(plan, options = {}) {
    const analyze = options.analyze || require('../deep-analyzer.js').analyzePaperDeep;
    if (typeof analyze !== 'function') fail('daily analyzer is required');
    return async paper => {
        const result = await withDailyFreshPaperSource(plan, paper, () => analyze(paper), options);
        // 直改上下文会在输出跨过引擎持久化边界之前剥掉字节和路径字段。这条断言要紧挨着
        // 日更集成放，这样以后改动分析器时，默认流程不会悄悄重建 data/current 下的图片缓存。
        return result;
    };
}

function withDailyFreshAnalysisContext(plan, callback) {
    return fresh.withFreshAnalysisContext(analysisIdentity(plan), callback);
}

module.exports = { CONTRACT, VERSION, SOURCE_GENERATION, REFERENCE_CONTRACT, REFERENCE_VERSION, DailyFreshSourcePlanError, stableHash,
    createDailyFreshSourcePlan, captureDailyFreshSources, readDailyFreshSource, isPaperBoundToPlan,
    prepareDailyPaper, createDailyAnalyzeFn, withDailyFreshAnalysisContext,
    dailyFreshSourceReference, readDailyFreshSourcePlan, requireDailyFreshSourceRecoveryPlan,
    withDailyFreshPaperSource, ephemeralReaderFigures, ephemeralPrimaryImage };
