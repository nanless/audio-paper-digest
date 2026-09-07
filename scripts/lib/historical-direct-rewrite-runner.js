'use strict';

// Execution half of the historical direct-rewrite plan.  Planning deliberately
// stops at source pointers; this module is the only path that turns one of
// those pointers into a source-only analysis/Reader execution.  It never
// reads a historical post, data/current, a crosswalk, or a legacy analysis.

const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PDFParse } = require('pdf-parse');
const conferenceLocalSources = require('./historical-conference-local-sources.js');
const planApi = require('./historical-direct-rewrite-plan.js');
const freshArxiv = require('./fresh-arxiv-rewrite-source.js');
const directContext = require('./direct-rewrite-analysis-context.js');
const directPages = require('./historical-direct-page-staging.js');
const execFileAsync = promisify(execFile);

const CONTRACT = 'historical-direct-rewrite-execution-v1';
const REGISTRY_CONTRACT = 'historical-direct-rewrite-execution-registry-v1';
const STAGING_CONTRACT = 'historical-direct-rewrite-staging-v1';
const PRIOR_PREPRINT_VERSION_RELATION = 'author-prior-preprint-with-different-title';
const PRIOR_PREPRINT_PAPER_ID = 'conference:icml:2026:openreview-forum-id:n1mAjfRDZ6';
const SHA = /^[a-f0-9]{64}$/;
const STATES = new Set(['pending', 'sourcing', 'source_ready', 'analyzing', 'analysis_partial', 'analysis_complete', 'staged', 'failed']);
const TRANSITIONS = new Map([
    ['pending', new Set(['sourcing', 'failed'])],
    ['sourcing', new Set(['source_ready', 'failed'])],
    ['source_ready', new Set(['analyzing', 'failed'])],
    ['analyzing', new Set(['analysis_partial', 'analysis_complete', 'failed'])],
    ['analysis_partial', new Set(['sourcing', 'analyzing', 'failed'])],
    ['analysis_complete', new Set(['staged', 'analyzing', 'failed'])],
    // A staged packet is immutable, but it is not safe to accept as
    // recovered after its retained source has drifted.  Preserve the packet
    // for diagnosis and make the latest execution state failed so a later
    // retry cannot silently treat it as current.
    ['staged', new Set(['failed'])],
    ['failed', new Set(['sourcing', 'analyzing'])]
]);

class HistoricalDirectRewriteRunnerError extends Error {
    constructor(message) { super(`Historical direct rewrite execution rejected: ${message}`); this.code = 'HISTORICAL_DIRECT_REWRITE_EXECUTION_INTEGRITY'; }
}
const fail = message => { throw new HistoricalDirectRewriteRunnerError(message); };
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
const stableHash = value => sha256(JSON.stringify(canonical(value)));

function safeDirectory(value, create = false, label = 'directory') {
    if (typeof value !== 'string' || !path.isAbsolute(value)) fail(`${label} must be an absolute path`);
    const absolute = path.resolve(value); let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part); let stat;
        try { stat = fs.lstatSync(cursor); }
        catch (error) { if (error.code !== 'ENOENT' || !create) throw error; fs.mkdirSync(cursor, { mode: 0o700 }); stat = fs.lstatSync(cursor); }
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`unsafe ${label}: ${cursor}`);
    }
    return absolute;
}

function readRegular(filename, maximum = 64 * 1024 * 1024) {
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size > maximum) fail(`unsafe file: ${filename}`);
        const bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd);
        if (bytes.length !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
            fail(`file changed while read: ${filename}`);
        }
        return { bytes, sha256: sha256(bytes) };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function writeAtomic(filename, value) {
    const directory = safeDirectory(path.dirname(filename), true, 'output directory');
    const bytes = Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`, 'utf8');
    const temporary = path.join(directory, `.${path.basename(filename)}.${crypto.randomUUID()}.tmp`);
    let fd;
    try {
        fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        fs.renameSync(temporary, filename);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return sha256(bytes);
}

function checkedArxivGeneration(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 999999999) fail('arXiv source generation is invalid');
    return value;
}
function registryName(plan, arxivGeneration = 1) {
    return `${plan.planSha256}.arxiv-generation-${String(checkedArxivGeneration(arxivGeneration)).padStart(6, '0')}.json`;
}
function registryPath(registryRoot, plan, arxivGeneration = 1) {
    if (typeof registryRoot !== 'string' || !path.isAbsolute(registryRoot)) fail('registry root must be an absolute path');
    return path.join(path.resolve(registryRoot), registryName(plan, arxivGeneration));
}
function defaultPauseFilePath(registryRoot, plan, arxivGeneration = 1) {
    return `${registryPath(registryRoot, plan, arxivGeneration)}.pause`;
}
function operationLockTarget(registryRoot, plan, arxivGeneration = 1) {
    return `${registryPath(registryRoot, plan, arxivGeneration)}.direct-run-operation`;
}
function pauseFileRequested(filename, plan, generation) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail('pause file must be an absolute path');
    const entry = fs.lstatSync(filename, { throwIfNoEntry: false });
    if (!entry) return false;
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) fail('pause file must be a single-link regular file');
    const loaded = require('./historical-conference-page-projections.js').readStableJson(filename, 'direct rewrite pause request');
    const value = loaded.value; const expectedKeys = ['contract', 'version', 'planSha256', 'generation', 'requestedAt', 'requestSha256'];
    if (!value || Object.keys(value).sort().join('\0') !== expectedKeys.sort().join('\0')
        || value.contract !== 'historical-direct-rewrite-pause-request-v1' || value.version !== 1
        || value.planSha256 !== plan.planSha256 || value.generation !== generation
        || new Date(value.requestedAt).toISOString() !== value.requestedAt) fail('pause request is not bound to this plan/generation');
    const body = { ...value }; delete body.requestSha256;
    if (value.requestSha256 !== stableHash(body)) fail('pause request SHA drifted');
    return true;
}
function selectDirectItems(plan, options = {}, registry = null) {
    const normalized = planApi.normalizePlan(plan); const queue = options.queue || 'all';
    if (!['all', 'arxiv', 'conference'].includes(queue)) fail('queue is invalid');
    const requestedPaperIds = options.paperIds ?? [];
    if (!Array.isArray(requestedPaperIds) || requestedPaperIds.some(id => typeof id !== 'string' || !id)
        || new Set(requestedPaperIds).size !== requestedPaperIds.length) fail('paperIds must be a unique non-empty string array');
    if (options.maxPapers !== undefined && options.maxPapers !== null
        && options.limit !== undefined && options.limit !== null) fail('maxPapers and limit cannot both be supplied');
    const maxPapers = options.maxPapers ?? options.limit ?? null;
    if (maxPapers !== null && (!Number.isSafeInteger(maxPapers) || maxPapers < 1 || maxPapers > 999999999)) {
        fail('maxPapers must be a positive safe integer');
    }
    const available = normalized.queue.filter(item => queue === 'all'
        || (queue === 'arxiv' ? item.route.kind === 'arxiv-fresh-fetch' : item.route.kind === 'conference-local-pdf'));
    const availableIds = new Set(available.map(item => item.paperId));
    const unknownPaperIds = requestedPaperIds.filter(id => !availableIds.has(id));
    if (unknownPaperIds.length) fail(`paper IDs are unknown or outside queue=${queue}: ${unknownPaperIds.join(', ')}`);
    const requested = new Set(requestedPaperIds);
    const scoped = requested.size ? available.filter(item => requested.has(item.paperId)) : available;
    const completed = registry === null ? new Set() : new Set(normalizeRegistry(registry, normalized).entries
        .filter(entry => entry.status === 'staged').map(entry => entry.paperId));
    // A bounded implicit batch must advance on resume instead of repeatedly
    // selecting the same already-staged prefix. Explicit IDs remain replayable
    // so an operator can deliberately re-verify their sealed artifacts.
    const candidates = maxPapers !== null && requested.size === 0
        ? scoped.filter(item => !completed.has(item.paperId)) : scoped;
    const items = maxPapers === null ? candidates : candidates.slice(0, maxPapers);
    return { items, selection: { queue, requestedPaperIds: requestedPaperIds.slice().sort(), maxPapers,
        availableCount: available.length, scopedCount: scoped.length,
        skippedCompletedCount: scoped.length - candidates.length, selectedCount: items.length,
        selectedPaperIds: items.map(item => item.paperId) } };
}
function initialRegistry(plan, now) {
    const entries = plan.queue.map(item => ({ paperId: item.paperId, runId: item.runId, route: item.route.kind,
        projectionSha256: item.projectionSha256, status: 'pending', source: null, analysis: null, staging: null,
        attempts: 0, latestError: null, updatedAt: now })).sort((a, b) => a.paperId.localeCompare(b.paperId));
    const body = { contract: REGISTRY_CONTRACT, version: 1, planSha256: plan.planSha256, createdAt: now, entries };
    return { ...body, registrySha256: stableHash(body) };
}
function normalizeRegistry(value, plan) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.contract !== REGISTRY_CONTRACT || value.version !== 1
        || value.planSha256 !== plan.planSha256 || !Array.isArray(value.entries) || !SHA.test(String(value.registrySha256 || ''))) {
        fail('registry envelope is invalid');
    }
    const body = { ...value }; delete body.registrySha256;
    if (stableHash(body) !== value.registrySha256) fail('registry SHA drifted');
    const expected = new Map(plan.queue.map(item => [item.paperId, item]));
    if (value.entries.length !== expected.size) fail('registry does not cover the full plan');
    const ids = new Set();
    const entries = value.entries.map(entry => {
        const item = expected.get(entry?.paperId);
        if (!item || ids.has(entry.paperId) || entry.runId !== item.runId || entry.route !== item.route.kind
            || entry.projectionSha256 !== item.projectionSha256 || !STATES.has(entry.status)
            || !Number.isSafeInteger(entry.attempts) || entry.attempts < 0) fail('registry entry drifted from plan');
        ids.add(entry.paperId); return clone(entry);
    }).sort((a, b) => a.paperId.localeCompare(b.paperId));
    return { ...clone(value), entries };
}
function loadOrCreateRegistry({ registryRoot, plan, now, arxivGeneration = 1 }) {
    const filename = path.join(safeDirectory(registryRoot, true, 'registry root'), registryName(plan, arxivGeneration));
    if (!fs.existsSync(filename)) {
        const registry = initialRegistry(plan, now); writeAtomic(filename, registry); return { filename, registry, created: true };
    }
    const loaded = JSON.parse(readRegular(filename).bytes.toString('utf8'));
    return { filename, registry: normalizeRegistry(loaded, plan), created: false };
}
function transition(registry, plan, paperId, status, changes, now) {
    const current = normalizeRegistry(registry, plan); const index = current.entries.findIndex(item => item.paperId === paperId);
    if (index < 0 || !STATES.has(status)) fail('unknown registry transition');
    const before = current.entries[index];
    if (before.status !== status && !TRANSITIONS.get(before.status)?.has(status)) {
        fail(`${paperId} cannot transition ${before.status} -> ${status}`);
    }
    const entries = current.entries.slice(); entries[index] = { ...before, ...clone(changes || {}), status, updatedAt: now };
    const body = { contract: REGISTRY_CONTRACT, version: 1, planSha256: current.planSha256, createdAt: current.createdAt, entries };
    return { ...body, registrySha256: stableHash(body) };
}

function structuredArtifactsSha(details) {
    const value = details?.structuredArtifacts?.payloadSha256;
    if (!SHA.test(String(value || ''))) fail('source structured-artifact SHA is missing');
    return value;
}
function compactSourceDescriptor(route, source, item = null) {
    if (route === 'arxiv-fresh-fetch') {
        const details = source.runtimeDetails || fallbackArxivDetails(source);
        const sourceManifestSha256 = source.sourceManifestSha256 || sha256(Buffer.from(JSON.stringify(source.manifest)));
        const sourceBinding = planApi.normalizeFreshArxivSourceBinding(item, { contract: planApi.FRESH_ARXIV_SOURCE_CONTRACT,
            paperId: source.paperId, arxivId: source.arxivId, generation: source.generation,
            textSha256: source.manifest.text.responseSha256, pdfSha256: source.manifest.pdf.responseSha256, sourceManifestSha256 });
        return { kind: route, paperId: source.paperId, generation: source.generation,
            sourceId: details.sourceId, textSha256: source.manifest.text.responseSha256,
            structuredArtifactsSha256: structuredArtifactsSha(details), pdfSha256: source.manifest.pdf.responseSha256, sourceManifestSha256,
            sourceBinding, sourceRunIdentitySha256: planApi.directSourceRunIdentity(item, sourceBinding),
            sourceSnapshotSha256: sourceSnapshotSha(details) };
    }
    return { kind: route, paperId: source.paperId, sourceId: source.sourceDetails.sourceId, pdfSha256: source.pdfSha256,
        textSha256: sha256(Buffer.from(source.sourceDetails.text, 'utf8')),
        structuredArtifactsSha256: structuredArtifactsSha(source.sourceDetails),
        sourceSnapshotSha256: sourceSnapshotSha(source.sourceDetails) };
}
function sourceSnapshotSha(details) { return stableHash({ paperId: details.paperId, source: details.source, sourceId: details.sourceId,
    textSha256: sha256(Buffer.from(details.text, 'utf8')), structuredArtifacts: details.structuredArtifacts }); }
function fallbackArxivDetails(source) {
    const text = source.text; const body = { version: 1, source: 'fresh_arxiv_text_without_layout', tables: [], formulas: [], figures: [],
        flattenedTextSha256: sha256(Buffer.from(text, 'utf8')) };
    return { paperId: `arxiv:${source.arxivId}`, source: source.manifest.text.source, sourceId: source.manifest.text.sourceId,
        text, imageInfos: [], structuredArtifacts: { ...body, payloadSha256: sha256(JSON.stringify(body)) },
        htmlAvailability: 'not_replayed', htmlAttempts: 0, warnings: ['恢复 generation 时没有保留图像索引；本次 Reader 不接收 Figure 像素。'] };
}
function directPaper(item, sourceDetails = {}) {
    // Do not carry catalog source pointers, page titles, historical prose, old
    // analysis, metadata, or prior Reader fields across this boundary.
    const title = typeof sourceDetails.title === 'string' ? sourceDetails.title.replace(/\s+/g, ' ').trim() : '';
    if (item.route.kind === 'arxiv-fresh-fetch') return { directPaperId: item.paperId, arxivId: item.route.arxivId, ...(title ? { title } : {}) };
    return { directPaperId: item.paperId, id: item.paperId, ...(title ? { title } : {}) };
}

function titleFromConferenceMetadata(source, item) {
    const metadata = readRegular(source.metadata.absolutePath, 64 * 1024 * 1024);
    if (metadata.sha256 !== source.metadata.sha256) fail(`${item.paperId} conference metadata changed after planning`);
    let value;
    try { value = JSON.parse(metadata.bytes.toString('utf8')); }
    catch { fail(`${item.paperId} conference metadata is invalid JSON`); }
    const posterBinding = source.metadata.posterBinding;
    const isIcmlPoster = source.sourceSet === 'workspace-icml-official-poster-2026' && posterBinding;
    const records = Array.isArray(value) ? value : Array.isArray(value?.papers) ? value.papers
        : Array.isArray(value?.items) ? value.items : isIcmlPoster && Array.isArray(value?.results) ? value.results : null;
    const record = records?.[source.metadata.recordIndex];
    if (isIcmlPoster && (String(record?.id) !== posterBinding.posterId
        || record?.paper_url !== posterBinding.openreviewUrl
        || record?.virtualsite_url !== `/virtual/2026/poster/${posterBinding.posterId}`)) {
        fail(`${item.paperId} ICML poster metadata identity drifted`);
    }
    const rawTitle = isIcmlPoster ? record?.name : record?.title;
    const title = typeof rawTitle === 'string' ? rawTitle.replace(/\s+/g, ' ').trim() : '';
    if (!title || title.length > 2000) fail(`${item.paperId} retained conference metadata title is unavailable`);
    return title;
}

function priorPreprintAnalysisDisclosure(source, item) {
    const acquisition = source?.pdf?.acquisition;
    if (acquisition?.versionRelation !== PRIOR_PREPRINT_VERSION_RELATION) return null;
    if (item?.paperId !== PRIOR_PREPRINT_PAPER_ID) {
        fail(`${item?.paperId || 'unknown paper'} cross-version prior preprint is not the reviewed exception`);
    }
    const sourceTitle = typeof acquisition.sourceTitle === 'string'
        ? acquisition.sourceTitle.replace(/\s+/g, ' ').trim() : '';
    const sourceDoi = typeof acquisition.sourceDoi === 'string'
        ? acquisition.sourceDoi.replace(/\s+/g, ' ').trim() : '';
    if (!sourceTitle || !sourceDoi) {
        fail(`${item.paperId} cross-version prior preprint lacks its source title or DOI`);
    }
    const warning = '本次分析使用可访问的作者早期预印本，不是会议 camera-ready 定稿；标题、内容、实验结果和结论可能与会议最终版本不同。';
    return {
        versionRelation: PRIOR_PREPRINT_VERSION_RELATION,
        sourceTitle,
        sourceDoi,
        warning,
        analysisInputNotice: [
            '【来源版本警告】',
            warning,
            `实际分析来源标题：${sourceTitle}`,
            `实际分析来源 DOI：${sourceDoi}`,
            '以下正文来自该早期预印本，只能据此分析，不得声称已核对会议 camera-ready 版本。'
        ].join('\n')
    };
}

async function extractConferenceSource(item, dependencies = {}) {
    let source = item.route.writerInputs[0];
    if (!source) fail(`${item.paperId} has no local conference PDF`);
    try { source = conferenceLocalSources.validateSource(source, item.paperId); }
    catch (error) { fail(`${item.paperId} local conference source binding is invalid: ${error.message}`); }
    const priorPreprint = priorPreprintAnalysisDisclosure(source, item);
    const pdf = readRegular(source.pdf.absolutePath, 512 * 1024 * 1024);
    if (pdf.sha256 !== source.pdf.sha256 || pdf.bytes.subarray(0, 5).toString('ascii') !== '%PDF-') fail(`${item.paperId} PDF changed after planning`);
    const extractPdfText = dependencies.extractPdfText || (async bytes => {
        const parser = new PDFParse({ data: bytes });
        try { const result = await parser.getText(); return String(result?.text || ''); }
        finally { await parser.destroy().catch(() => {}); }
    });
    const extractedText = String(await extractPdfText(pdf.bytes) || '').replace(/\r\n?/g, '\n').trim();
    if (extractedText.length < 100) fail(`${item.paperId} local PDF text is unusably short`);
    // Put the identity warning in the actual text consumed by every primary,
    // repair, scoring, and Reader request. Merely retaining it as manifest
    // metadata would not prevent a model from mistaking these bytes for the
    // differently titled conference camera-ready paper.
    const text = priorPreprint ? `${priorPreprint.analysisInputNotice}\n\n${extractedText}` : extractedText;
    const artifactsBody = { version: 1, source: 'direct_conference_pdf_text', tables: [], formulas: [], figures: [],
        flattenedTextSha256: sha256(Buffer.from(text, 'utf8')) };
    return { paperId: item.paperId, pdfSha256: pdf.sha256, sourceTitle: titleFromConferenceMetadata(source, item), sourceDetails: { paperId: item.paperId,
        source: 'conference_pdf_text', sourceId: item.paperId, text, imageInfos: [],
        structuredArtifacts: { ...artifactsBody, payloadSha256: sha256(JSON.stringify(artifactsBody)) },
        htmlAvailability: 'not_applicable', htmlAttempts: 0,
        ...(priorPreprint ? { sourceTitle: priorPreprint.sourceTitle, sourceDoi: priorPreprint.sourceDoi,
            versionRelation: priorPreprint.versionRelation, sourceVersionWarning: priorPreprint.warning } : {}),
        warnings: [
            ...(priorPreprint ? [priorPreprint.warning] : []),
            '会议本地 PDF 的图像只在本次 Reader 临时物化，不写入 runtime。'
        ] } };
}

async function ephemeralArxivMaterializer(arxivId, figures, dependencies = {}) {
    return freshArxiv.withEphemeralArxivFigures({ arxivId, figures, sourceRoot: dependencies.freshArxivSourceRoot,
        temporaryRoot: dependencies.temporaryRoot, persistentRoots: dependencies.persistentRoots || [] }, async temporary => temporary.figures.map(item => {
        const bytes = readRegular(item.tempPath, 32 * 1024 * 1024).bytes;
        return { ...figures.find(figure => figure.ordinal === item.ordinal), rawBytes: bytes,
            assetSha256: sha256(bytes), assetMediaType: item.mediaType };
    }), { fetchFigure: dependencies.fetchFigure });
}

// The legacy image downloader reads and writes data/current/image-cache. Direct
// runs instead use this callback for dual-model image input. It returns only
// in-memory base64 and is backed by the same OS-temporary lifecycle as Reader
// figures, so no primary-analysis request can touch the legacy cache.
async function ephemeralArxivPrimaryImageDownloader(arxivId, imageUrl, dependencies = {}) {
    return freshArxiv.withEphemeralArxivFigures({ arxivId, figures: [{ ordinal: 1, url: imageUrl }],
        sourceRoot: dependencies.freshArxivSourceRoot, temporaryRoot: dependencies.temporaryRoot,
        persistentRoots: dependencies.persistentRoots || [] }, async temporary => {
        const item = temporary.figures[0];
        const bytes = readRegular(item.tempPath, 32 * 1024 * 1024).bytes;
        return { base64: bytes.toString('base64'), mime: item.mediaType, sha256: sha256(bytes), cacheHit: false };
    }, { fetchFigure: dependencies.fetchFigure });
}

// PDFs can be rendered by a caller-provided extractor.  The default returns no
// layout figures because a PDF text extraction alone does not make an image
// URL safe to publish.  If an extractor is supplied, it receives an OS-temp
// directory and its bytes must be consumed before this function returns.
async function withEphemeralConferenceFigures(source, callback, dependencies = {}) {
    const root = path.resolve(dependencies.temporaryRoot || os.tmpdir());
    const persistentRoots = (dependencies.persistentRoots || []).filter(Boolean).map(value => path.resolve(value));
    if (persistentRoots.some(base => root === base || root.startsWith(`${base}${path.sep}`))) {
        fail('conference temporary figures cannot use a persistent runtime directory');
    }
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const directory = fs.mkdtempSync(path.join(root, 'historical-conference-figures-'));
    try {
        const materialize = dependencies.materializeConferenceFigures || renderConferencePdfPages;
        const figures = await materialize({ pdfPath: source.pdfPath, directory });
        return await callback(Array.isArray(figures) ? figures : fail('conference figure extractor must return an array'));
    } finally { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 2 }); }
}

async function renderConferencePdfPages({ pdfPath, directory }) {
    if (typeof pdfPath !== 'string' || !path.isAbsolute(pdfPath) || !path.resolve(pdfPath).endsWith('.pdf')) {
        fail('conference PDF renderer needs an absolute PDF path');
    }
    const prefix = path.join(directory, 'page');
    try {
        await execFileAsync('pdftoppm', ['-png', '-f', '1', '-l', '4', '-r', '144', pdfPath, prefix], {
            cwd: directory, timeout: 120000, maxBuffer: 1024 * 1024
        });
    } catch (error) {
        fail(`conference PDF temporary figure rendering failed: ${String(error?.message || error).slice(0, 500)}`);
    }
    const names = fs.readdirSync(directory).filter(name => /^page-\d+\.png$/.test(name)).sort();
    if (!names.length) fail('conference PDF renderer produced no temporary pages');
    return names.map((name, index) => {
        const rawBytes = readRegular(path.join(directory, name), 32 * 1024 * 1024).bytes;
        return { ordinal: index + 1, caption: `PDF 第 ${index + 1} 页`, rawBytes,
            assetSha256: sha256(rawBytes), mediaType: 'image/png' };
    });
}

function analysisAttemptDirectory(dependencies = {}) {
    const root = path.resolve(dependencies.temporaryRoot || os.tmpdir());
    const persistentRoots = (dependencies.persistentRoots || []).filter(Boolean).map(value => path.resolve(value));
    if (persistentRoots.some(base => root === base || root.startsWith(`${base}${path.sep}`))) {
        fail('analysis checkpoints cannot use a persistent runtime directory');
    }
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    return fs.mkdtempSync(path.join(root, 'historical-direct-analysis-'));
}

async function defaultAnalyze({ item, sourceDetails, sourceDescriptor, executionDirectory, dependencies }) {
    const engine = dependencies.engine || require('../analysis-engine.js');
    const sourcePaper = item.route.kind === 'conference-local-pdf'
        ? { ...sourceDetails, title: titleFromConferenceMetadata(item.route.writerInputs[0], item) } : sourceDetails;
    const paper = directPaper(item, sourcePaper); const attemptDirectory = analysisAttemptDirectory(dependencies);
    const analysisPath = path.join(attemptDirectory, 'analysis.json');
    const readerAttemptsDir = path.join(executionDirectory, 'reader-attempts');
    let result = paper;
    const runEngine = async () => engine.analyzeBatch([paper], {
        concurrency: 1, maxRetries: dependencies.maxRetries ?? 2, checkpointFilePath: analysisPath, saveInterval: 0,
        preparePaperLocked: () => ({ paper, skip: false }),
        onPaperResultLocked: async (_paper, event) => { result = event.result || { ...paper, error: event.error || 'analysis failed' }; }
    });
    try {
        const active = directContext.getDirectRewriteAnalysisContext();
        if (active) {
            // runDirectRewrite owns the outer scope so conference PDF page pixels
            // remain available all the way through Reader generation. Re-entering
            // AsyncLocalStorage here used to shadow them with an empty context.
            if (active.paperId !== item.paperId || active.readerAttemptsDir !== readerAttemptsDir
                || active.sourceSnapshotSha256 !== sourceDescriptor.sourceSnapshotSha256) {
                fail('default analysis was called under another direct source scope');
            }
            await runEngine();
        } else {
            const materializeReaderFigures = async (figures, id) => item.route.kind === 'arxiv-fresh-fetch'
                ? ephemeralArxivMaterializer(id, figures, dependencies)
                : [];
            const downloadPrimaryImage = item.route.kind === 'arxiv-fresh-fetch'
                ? (url => ephemeralArxivPrimaryImageDownloader(item.route.arxivId, url, dependencies)) : undefined;
            await directContext.withDirectRewriteAnalysisSource({ paperId: item.paperId, route: item.route.kind,
                sourceDetails, sourceSnapshotSha256: sourceDescriptor.sourceSnapshotSha256, readerAttemptsDir,
                materializeReaderFigures, downloadPrimaryImage }, runEngine);
        }
        directContext.assertNoPersistentFigureFields(result);
        return result;
    } finally {
        fs.rmSync(attemptDirectory, { recursive: true, force: true, maxRetries: 2 });
    }
}

async function bounded(items, concurrency, callback, shouldPause = () => false) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) fail('concurrency must be between 1 and 8');
    let cursor = 0; let paused = false;
    const worker = async () => {
        const values = [];
        while (cursor < items.length) {
            if (await shouldPause()) { paused = true; break; }
            // Another worker may have advanced the shared cursor while this
            // worker awaited the pause check. Re-check before claiming work so
            // a short final batch never dispatches an undefined item.
            if (cursor >= items.length) break;
            const item = items[cursor++];
            values.push(await callback(item));
        }
        return values;
    };
    const groups = await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return { values: groups.flat(), paused };
}

function executionDirectory(root, item, sourceDescriptor) {
    return path.join(safeDirectory(root, true, 'execution root'), item.runId,
        item.route.kind === 'arxiv-fresh-fetch' ? sourceDescriptor.sourceRunIdentitySha256 : 'conference-local');
}
function directProvenanceFor(item, sourceDescriptor) {
    if (!sourceDescriptor || sourceDescriptor.paperId !== item.paperId
        || !SHA.test(String(sourceDescriptor.textSha256 || ''))
        || !SHA.test(String(sourceDescriptor.structuredArtifactsSha256 || ''))
        || !SHA.test(String(sourceDescriptor.sourceSnapshotSha256 || ''))) {
        fail(`${item.paperId} source descriptor is incomplete for final review`);
    }
    return { contract: directContext.PROVENANCE_CONTRACT, runId: item.runId,
        sourceSha256: sourceDescriptor.textSha256,
        structuredArtifactsSha256: sourceDescriptor.structuredArtifactsSha256,
        sourceSnapshotSha256: sourceDescriptor.sourceSnapshotSha256,
        ...(item.route.kind === 'arxiv-fresh-fetch' ? { sourceGeneration: sourceDescriptor.generation,
            sourceManifestSha256: sourceDescriptor.sourceManifestSha256 } : {}),
        sourceOnly: true, oldGeneratedTextIncluded: false };
}

function assertDirectAnalysisReadyForStaging({ item, sourceDescriptor, analysis }) {
    if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)
        || analysis.directPaperId !== item.paperId) {
        fail(`${item.paperId} analysis is not bound to the direct execution identity`);
    }
    directContext.assertNoPersistentFigureFields(analysis);
    const engine = require('../analysis-engine.js');
    if (!engine.isSuccessfulAnalysisRecord(analysis)) {
        fail(`${item.paperId} analysis is incomplete or failed; refusing staging`);
    }
    if (!engine.apiReaderV3BindsCanonical(analysis)) {
        fail(`${item.paperId} API Reader/provenance is incomplete; refusing staging`);
    }
    const expected = directProvenanceFor(item, sourceDescriptor);
    if (!analysis.freshRewriteProvenance || !analysis.analysisManifest?.freshRewriteProvenance
        || stableHash(analysis.freshRewriteProvenance) !== stableHash(expected)
        || stableHash(analysis.analysisManifest.freshRewriteProvenance) !== stableHash(expected)
        || analysis.sourceSha256 !== expected.sourceSha256
        || analysis.analysisManifest?.sourceAcquisition?.sourceSha256 !== expected.sourceSha256
        || analysis.analysisManifest?.sourceAcquisition?.structuredArtifactsSha256 !== expected.structuredArtifactsSha256
        || analysis.analysisManifest?.sourceAcquisition?.fullTextAvailable !== true) {
        fail(`${item.paperId} analysis provenance is not sealed to this direct source`);
    }
    return expected;
}

function stageDirectExecution({ plan, registry, item, sourceDescriptor, analysis, stagingRoot, dependencies = {} }) {
    assertDirectAnalysisReadyForStaging({ item, sourceDescriptor, analysis });
    const analysisRecordSha256 = stableHash(analysis);
    const analysisBytes = Buffer.from(`${JSON.stringify(canonical(analysis), null, 2)}\n`, 'utf8');
    const artifact = { paperId: item.paperId, runId: item.runId, route: item.route.kind,
        analysisFileSha256: sha256(analysisBytes), analysisRecordSha256,
        sourceSnapshotSha256: sourceDescriptor.sourceSnapshotSha256,
        ...(item.route.kind === 'arxiv-fresh-fetch' ? { sourceGeneration: sourceDescriptor.generation,
            sourceManifestSha256: sourceDescriptor.sourceManifestSha256, sourceTextSha256: sourceDescriptor.textSha256,
            sourcePdfSha256: sourceDescriptor.pdfSha256, sourceRunIdentitySha256: sourceDescriptor.sourceRunIdentitySha256 } : {}) };
    const stageRegistry = planApi.buildRegistry(plan, item.route.kind === 'arxiv-fresh-fetch'
        ? { sourceBindings: [sourceDescriptor.sourceBinding] } : {});
    const binding = planApi.directStagingBinding({ plan, registry: stageRegistry, paperId: item.paperId, analysisArtifact: artifact });
    directContext.assertNoPersistentFigureFields(binding);
    const directory = path.join(safeDirectory(stagingRoot, true, 'staging root'), item.runId,
        item.route.kind === 'arxiv-fresh-fetch' ? sourceDescriptor.sourceRunIdentitySha256 : 'conference-local');
    safeDirectory(directory, true, 'direct staging directory');
    const body = { contract: STAGING_CONTRACT, version: 1, paperId: item.paperId, runId: item.runId,
        analysisArtifact: artifact, stagingBinding: binding, stagingBindingSha256: stableHash(binding) };
    const stagingInputSha256 = writeAtomic(path.join(directory, 'staging-input.json'), body);
    const pageManifest = directPages.stageDirectPages({ item, sourceDescriptor, artifact, analysis, directory,
        stagingInputSha256, stagingBindingSha256: body.stagingBindingSha256,
        dependencies: { ...dependencies, assertCompleteAnalysis: candidate =>
            assertDirectAnalysisReadyForStaging({ item, sourceDescriptor, analysis: candidate }) } });
    return { directory, stagingBindingSha256: body.stagingBindingSha256, analysisArtifact: artifact,
        pageStaging: directPages.receipt(pageManifest) };
}

function replayDirectPageStaging({ item, active, stagingRoot, executionRoot }) {
    const staging = active?.staging;
    if (!staging?.pageStaging || !staging.analysisArtifact || !active?.source || !active?.analysis) {
        fail(`${item.paperId} staged execution lacks a direct page staging receipt`);
    }
    const directory = path.join(safeDirectory(stagingRoot, false, 'staging root'), item.runId,
        item.route.kind === 'arxiv-fresh-fetch' ? active.source.sourceRunIdentitySha256 : 'conference-local');
    safeDirectory(directory, false, 'direct staging directory');
    if (path.resolve(staging.directory) !== directory) fail(`${item.paperId} staged page directory drifted`);
    const stagingInput = readRegular(path.join(directory, 'staging-input.json'));
    const body = JSON.parse(stagingInput.bytes.toString('utf8'));
    if (body?.stagingBindingSha256 !== staging.stagingBindingSha256
        || stableHash(body?.analysisArtifact) !== stableHash(staging.analysisArtifact)) {
        fail(`${item.paperId} staged page input drifted from the registry`);
    }
    const executionDirectory = path.join(safeDirectory(executionRoot, false, 'execution root'), item.runId,
        item.route.kind === 'arxiv-fresh-fetch' ? active.source.sourceRunIdentitySha256 : 'conference-local');
    if (path.resolve(active.analysis.directory) !== executionDirectory) fail(`${item.paperId} staged analysis directory drifted`);
    const storedAnalysis = readRegular(path.join(executionDirectory, 'analysis.json'));
    const analysis = JSON.parse(storedAnalysis.bytes.toString('utf8'));
    if (storedAnalysis.sha256 !== active.analysis.analysisFileSha256
        || stableHash(analysis) !== active.analysis.analysisRecordSha256
        || staging.analysisArtifact.analysisFileSha256 !== active.analysis.analysisFileSha256
        || staging.analysisArtifact.analysisRecordSha256 !== active.analysis.analysisRecordSha256) {
        fail(`${item.paperId} staged analysis bytes drifted`);
    }
    const manifest = directPages.validateManifest({
        value: JSON.parse(readRegular(path.join(directory, 'page-staging-manifest.json')).bytes.toString('utf8')),
        item, sourceDescriptor: active.source, artifact: staging.analysisArtifact, analysis,
        stagingInputSha256: stagingInput.sha256, stagingBindingSha256: body.stagingBindingSha256, directory,
        rendererImplementationSha256: staging.pageStaging.rendererImplementationSha256,
        assertCompleteAnalysis: candidate => assertDirectAnalysisReadyForStaging({ item, sourceDescriptor: active.source, analysis: candidate })
    });
    if (stableHash(directPages.receipt(manifest)) !== stableHash(staging.pageStaging)) {
        fail(`${item.paperId} staged page receipt drifted`);
    }
    return manifest;
}

async function sealedFailureHandoff({ root, plan, item, generation, error, observedAt, writeFailureHandoff }) {
    const written = await writeFailureHandoff({ root, plan, paperId: item.paperId, generation, error, observedAt });
    if (!written || typeof written !== 'object' || !['created', 'recovered'].includes(written.status)
        || typeof written.handoffName !== 'string' || !SHA.test(String(written.fileSha256 || ''))
        || !written.handoff) {
        fail(`${item.paperId} arXiv failure handoff writer returned an invalid receipt`);
    }
    const handoff = planApi.normalizeArxivFreshFailureHandoff(written.handoff);
    const expectedName = planApi.arxivFreshFailureHandoffName(handoff);
    if (written.handoffName !== expectedName || handoff.paperId !== item.paperId
        || handoff.arxivId !== item.route.arxivId || handoff.generation !== generation) {
        fail(`${item.paperId} arXiv failure handoff is not bound to the failed fresh source`);
    }
    const stored = planApi.readArxivFreshFailureHandoff({ root, handoffName: written.handoffName });
    if (stored.fileSha256 !== written.fileSha256 || stored.handoff.handoffSha256 !== handoff.handoffSha256) {
        fail(`${item.paperId} arXiv failure handoff bytes drifted before the failure was recorded`);
    }
    return { status: written.status, handoffName: written.handoffName, fileSha256: stored.fileSha256,
        handoffSha256: stored.handoff.handoffSha256 };
}

async function runDirectRewriteLocked({ options, plan, registryFile, pauseFile,
    lockTarget }, dependencies = {}) {
    const arxivGeneration = checkedArxivGeneration(options.arxivGeneration || 1);
    const now = (dependencies.now || (() => new Date().toISOString()))();
    let { filename, registry } = loadOrCreateRegistry({ registryRoot: options.registryRoot, plan, now, arxivGeneration });
    if (filename !== registryFile) fail('registry path changed after the direct-run operation lock was acquired');
    const { items: selected, selection } = selectDirectItems(plan, options, registry);
    const persist = () => { writeAtomic(registryFile, registry); };
    const capture = dependencies.captureFreshArxivRewriteSource || freshArxiv.captureFreshArxivRewriteSource;
    const analyze = dependencies.analyze || defaultAnalyze;
    const writeFailureHandoff = dependencies.writeArxivFreshFailureHandoff || planApi.writeArxivFreshFailureHandoff;
    if (typeof writeFailureHandoff !== 'function') fail('arXiv failure handoff writer is required');
    const runOne = async item => {
        let active = registry.entries.find(entry => entry.paperId === item.paperId);
        if (active.status === 'staged') {
            try {
                if (item.route.kind === 'arxiv-fresh-fetch') {
                    // A staged record is recoverable only from the same sealed
                    // generation.  The per-generation registry name prevents a
                    // new generation from selecting it; this replay check also
                    // catches a deleted or substituted source bundle.
                    const stored = freshArxiv.readFreshArxivRewriteSource({ rootDir: options.freshArxivSourceRoot,
                        arxivId: item.route.arxivId, generation: arxivGeneration });
                    if (active.source?.generation !== arxivGeneration
                        || active.source?.sourceManifestSha256 !== stored.sourceManifestSha256
                        || active.source?.textSha256 !== stored.manifest.text.responseSha256
                        || active.source?.pdfSha256 !== stored.manifest.pdf.responseSha256) {
                        fail(`${item.paperId} staged output belongs to a different sealed arXiv source generation`);
                    }
                }
                else {
                    // Replay both planned local bytes before treating the
                    // staged analysis as recoverable.  This rehashes metadata
                    // and every local PDF against the immutable plan values.
                    planApi.verifyConferenceWriterInputs(item);
                }
                replayDirectPageStaging({ item, active, stagingRoot: options.stagingRoot, executionRoot: options.executionRoot });
            } catch (error) {
                registry = transition(registry, plan, item.paperId, 'failed', {
                    latestError: String(error.message).slice(0, 2000)
                }, now); persist();
                return { paperId: item.paperId, status: 'failed', error: String(error.message) };
            }
            return { paperId: item.paperId, status: 'recovered' };
        }
        try {
            registry = transition(registry, plan, item.paperId, 'sourcing', { attempts: active.attempts + 1, latestError: null }, now); persist();
            let source, sourceDetails;
            if (item.route.kind === 'arxiv-fresh-fetch') {
                try {
                    source = await capture({ rootDir: options.freshArxivSourceRoot, arxivId: item.route.arxivId, generation: arxivGeneration });
                    if (!source || source.arxivId !== item.route.arxivId || !source.manifest
                        || source.generation !== arxivGeneration || !SHA.test(String(source.sourceManifestSha256 || ''))
                        || !SHA.test(String(source.manifest.text?.responseSha256 || ''))
                        || !SHA.test(String(source.manifest.pdf?.responseSha256 || ''))
                        || (!source.runtimeDetails && typeof source.text !== 'string')) {
                        fail(`${item.paperId} fresh arXiv capture mismatched the plan`);
                    }
                } catch (error) {
                    const handoff = await sealedFailureHandoff({ root: options.freshArxivFailureHandoffRoot, plan, item,
                        generation: arxivGeneration, error, observedAt: now, writeFailureHandoff });
                    active = registry.entries.find(entry => entry.paperId === item.paperId);
                    registry = transition(registry, plan, item.paperId, 'failed', {
                        latestError: String(error.message).slice(0, 2000), failureHandoff: handoff
                    }, now); persist();
                    return { paperId: item.paperId, status: 'handoff', handoff };
                }
                source.paperId = item.paperId; sourceDetails = source.runtimeDetails || fallbackArxivDetails(source);
            } else { source = await extractConferenceSource(item, dependencies); sourceDetails = source.sourceDetails; }
            const descriptor = compactSourceDescriptor(item.route.kind, source, item);
            registry = transition(registry, plan, item.paperId, 'source_ready', { source: descriptor }, now); persist();
            registry = transition(registry, plan, item.paperId, 'analyzing', {}, now); persist();
            const executionDir = executionDirectory(options.executionRoot, item, descriptor); safeDirectory(executionDir, true, 'paper execution directory');
            const executionDependencies = { ...dependencies, freshArxivSourceRoot: options.freshArxivSourceRoot,
                persistentRoots: [options.registryRoot, options.executionRoot, options.stagingRoot] };
            const readerAttemptsDir = path.join(executionDir, 'reader-attempts');
            const materializeReaderFigures = async (figures, id) => item.route.kind === 'arxiv-fresh-fetch'
                ? ephemeralArxivMaterializer(id, figures, executionDependencies)
                : [];
            const downloadPrimaryImage = item.route.kind === 'arxiv-fresh-fetch'
                ? (url => ephemeralArxivPrimaryImageDownloader(item.route.arxivId, url, executionDependencies)) : undefined;
            // Keep the source scope around injected test workers as well as the
            // production engine. That makes request-capture tests exercise the
            // same no-old-input boundary as a real model call. Conference PDF
            // page bytes are injected here and stay visible through all nested
            // analysis/Reader calls until the OS-temporary renderer cleans up.
            const invokeAnalysis = supplementaryReaderImages => directContext.withDirectRewriteAnalysisSource({ paperId: item.paperId,
                runId: item.runId, route: item.route.kind, sourceDetails: clone(sourceDetails),
                sourceSha256: descriptor.textSha256, structuredArtifactsSha256: descriptor.structuredArtifactsSha256,
                sourceSnapshotSha256: descriptor.sourceSnapshotSha256,
                ...(item.route.kind === 'arxiv-fresh-fetch' ? { sourceGeneration: descriptor.generation,
                    sourceManifestSha256: descriptor.sourceManifestSha256 } : {}),
                readerAttemptsDir, materializeReaderFigures, downloadPrimaryImage, supplementaryReaderImages }, () => analyze({ item,
                sourceDetails: clone(sourceDetails), sourceDescriptor: descriptor, executionDirectory: executionDir,
                dependencies: executionDependencies }));
            const analysis = item.route.kind === 'conference-local-pdf'
                ? await withEphemeralConferenceFigures({ pdfPath: item.route.writerInputs[0]?.pdf.absolutePath },
                    invokeAnalysis, executionDependencies)
                : await invokeAnalysis([]);
            // The final contract is checked before the durable analysis file
            // as well as inside stageDirectExecution. Failed/partial engine
            // results remain in the registry error only; no execution record
            // or staging input is allowed to outlive this attempt.
            assertDirectAnalysisReadyForStaging({ item, sourceDescriptor: descriptor, analysis });
            const analysisFile = path.join(executionDir, 'analysis.json');
            const analysisFileSha256 = writeAtomic(analysisFile, analysis);
            registry = transition(registry, plan, item.paperId, 'analysis_complete', { analysis: { directory: executionDir,
                analysisFileSha256, analysisRecordSha256: stableHash(analysis), sourceSnapshotSha256: descriptor.sourceSnapshotSha256 } }, now); persist();
            const staging = stageDirectExecution({ plan, registry, item, sourceDescriptor: descriptor, analysis,
                stagingRoot: options.stagingRoot, dependencies: executionDependencies });
            registry = transition(registry, plan, item.paperId, 'staged', { staging }, now); persist();
            return { paperId: item.paperId, status: 'staged' };
        } catch (error) {
            active = registry.entries.find(entry => entry.paperId === item.paperId);
            if (active && active.status !== 'staged' && TRANSITIONS.get(active.status)?.has('failed')) {
                registry = transition(registry, plan, item.paperId, 'failed', { latestError: String(error.message).slice(0, 2000) }, now); persist();
            }
            return { paperId: item.paperId, status: 'failed', error: String(error.message) };
        }
    };
    let completedThisRun = 0;
    const pauseRequested = async () => Boolean(await dependencies.shouldPause?.()) || pauseFileRequested(pauseFile, plan, arxivGeneration);
    const boundedResult = await bounded(selected, options.concurrency || 3, async item => {
        const result = await runOne(item); completedThisRun += 1;
        const current = normalizeRegistry(registry, plan); const counts = registryCounts(current);
        const event = { contract: 'historical-direct-rewrite-progress-v1', version: 1,
            planSha256: plan.planSha256, arxivGeneration, queue: selection.queue,
            selectedCount: selected.length, completedThisRun, remainingSelected: selected.length - completedThisRun,
            paperId: item.paperId, outcome: result.status, registrySha256: current.registrySha256,
            registryCounts: counts, pauseRequested: await pauseRequested() };
        if (dependencies.onProgress) await dependencies.onProgress(event);
        // A progress consumer may create the persistent pause marker.  Refresh
        // the same event object after the callback so in-process monitors and
        // tests observe the committed control state, while the CLI emission
        // still truthfully describes the state at emission time.
        event.pauseRequested = await pauseRequested();
        return result;
    }, pauseRequested);
    const results = boundedResult.values;
    const final = normalizeRegistry(registry, plan);
    const paused = boundedResult.paused || results.length < selected.length && await pauseRequested();
    const counts = registryCounts(final);
    return { status: paused ? 'paused' : results.some(item => ['failed', 'handoff'].includes(item.status)) ? 'partial' : 'complete',
        planSha256: plan.planSha256, arxivGeneration, selection, progress: { selected: selected.length, processed: results.length,
            remaining: selected.length - results.length }, pauseFile, operationLockTarget: lockTarget,
        operationLockPath: `${lockTarget}.lock`, registryFile,
        registrySha256: final.registrySha256, staged: final.entries.filter(item => item.status === 'staged').length,
        failed: final.entries.filter(item => item.status === 'failed').length, registryCounts: counts,
        results: results.sort((a, b) => a.paperId.localeCompare(b.paperId)) };
}

function registryCounts(registry) {
    const counts = Object.fromEntries([...STATES].sort().map(status => [status, 0]));
    for (const entry of registry.entries) counts[entry.status] += 1;
    return counts;
}

async function runDirectRewrite(options = {}, dependencies = {}) {
    const plan = planApi.normalizePlan(options.plan);
    const arxivGeneration = checkedArxivGeneration(options.arxivGeneration || 1);
    const hasRegistryRoot = typeof options.registryRoot === 'string' && path.isAbsolute(options.registryRoot);
    const registryFile = hasRegistryRoot ? registryPath(options.registryRoot, plan, arxivGeneration) : null;
    let existingRegistry = null;
    if (options.apply !== true && registryFile && fs.existsSync(registryFile)) {
        existingRegistry = normalizeRegistry(JSON.parse(readRegular(registryFile).bytes.toString('utf8')), plan);
    }
    const { items: selected, selection } = selectDirectItems(plan, options, existingRegistry);
    if (options.pauseFile !== undefined && options.pauseFile !== null
        && (typeof options.pauseFile !== 'string' || !path.isAbsolute(options.pauseFile))) fail('pauseFile must be absolute');
    const pauseFile = options.pauseFile || (hasRegistryRoot
        ? defaultPauseFilePath(options.registryRoot, plan, arxivGeneration) : null);
    const lockTarget = hasRegistryRoot ? operationLockTarget(options.registryRoot, plan, arxivGeneration) : null;
    if (options.apply !== true) return { status: 'dry-run', planSha256: plan.planSha256, arxivGeneration,
        paperCount: selected.length, paperIds: selected.map(item => item.paperId), selection, pauseFile, operationLockTarget: lockTarget,
        operationLockPath: lockTarget === null ? null : `${lockTarget}.lock` };
    for (const key of ['registryRoot', 'executionRoot', 'stagingRoot', 'freshArxivSourceRoot']) {
        if (typeof options[key] !== 'string' || !path.isAbsolute(options[key])) fail(`${key} is required`);
    }
    safeDirectory(options.registryRoot, true, 'registry root');
    if (typeof pauseFile !== 'string' || !path.isAbsolute(pauseFile)) fail('pauseFile is required');
    if (selected.some(item => item.route.kind === 'arxiv-fresh-fetch')
        && (typeof options.freshArxivFailureHandoffRoot !== 'string'
            || !path.isAbsolute(options.freshArxivFailureHandoffRoot))) {
        fail('freshArxivFailureHandoffRoot is required for arXiv direct rewrite');
    }
    const engine = require('../analysis-engine.js');
    const withOperationLock = dependencies.withOperationLock
        || ((target, callback, lockOptions) => engine.withFileLock(target, callback, lockOptions));
    return withOperationLock(lockTarget, () => runDirectRewriteLocked({ options, plan,
        registryFile, pauseFile, lockTarget }, dependencies), dependencies.lockOptions || {});
}

module.exports = { CONTRACT, REGISTRY_CONTRACT, STAGING_CONTRACT, HistoricalDirectRewriteRunnerError, stableHash,
    STATES, registryName, registryPath, defaultPauseFilePath, operationLockTarget, pauseFileRequested, selectDirectItems,
    initialRegistry, normalizeRegistry, loadOrCreateRegistry, transition, registryCounts, directPaper, fallbackArxivDetails,
    priorPreprintAnalysisDisclosure, extractConferenceSource, ephemeralArxivMaterializer, ephemeralArxivPrimaryImageDownloader,
    withEphemeralConferenceFigures, renderConferencePdfPages,
    directProvenanceFor, assertDirectAnalysisReadyForStaging, replayDirectPageStaging,
    stageDirectExecution, defaultAnalyze, sealedFailureHandoff, runDirectRewrite };
