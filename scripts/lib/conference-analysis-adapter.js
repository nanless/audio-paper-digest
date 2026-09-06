'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const contextApi = require('./conference-source-context.js');
const analysisContext = require('./conference-analysis-context.js');
const identityApi = require('./paper-identity.js');

const RUN_CONTRACT = 'conference-analysis-execution-v1';
const ANALYSIS_CONTRACT = 'conference-analysis-canonical-v1';
const SOURCE_CONTRACT = 'conference-analysis-source-v1';
const VERSION = 1;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
const stableHash = value => sha256(JSON.stringify(canonical(value)));
function safeRoot(root, create = false) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('conferenceAnalysisDir must be absolute');
    const absolute = path.resolve(root); let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part); let stat;
        try { stat = fs.lstatSync(cursor); } catch (error) {
            if (error.code !== 'ENOENT' || !create) throw error;
            fs.mkdirSync(cursor, { mode: 0o700 }); stat = fs.lstatSync(cursor);
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe conference analysis directory: ${cursor}`);
    }
    return absolute;
}
function readJsonRecord(filename) {
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) throw new Error('unsafe conference analysis file');
        const bytes = fs.readFileSync(fd); if (bytes.length !== stat.size) throw new Error('conference analysis file changed while reading');
        const named = fs.lstatSync(filename);
        if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1
            || named.dev !== stat.dev || named.ino !== stat.ino || named.size !== stat.size) {
            throw new Error('conference analysis pathname changed while reading');
        }
        return { value: JSON.parse(bytes.toString('utf8')), bytes, sha256: sha256(bytes) };
    }
    finally { fs.closeSync(fd); }
}
function readJson(filename) { return readJsonRecord(filename).value; }
function syncDirectory(directory) {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeJson(filename, value) {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`); let fd;
    try { fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    syncDirectory(path.dirname(filename));
    return sha256(bytes);
}
function replaceJson(filename, value, expectedSha256 = null) {
    if (expectedSha256 !== null && readJsonRecord(filename).sha256 !== expectedSha256) {
        throw new Error(`conference analysis CAS failed for ${path.basename(filename)}`);
    }
    const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
    try { writeJson(temporary, value); fs.renameSync(temporary, filename); syncDirectory(path.dirname(filename)); }
    finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function normalizedPaper(source) {
    const identity = identityApi.normalizeIdentity({ contract: identityApi.CONTRACT, kind: 'conference',
        canonicalId: source.paperId, arxivId: null,
        conference: { slug: source.conference.id.replace(/-\d{4}$/, ''), year: source.conference.year },
        externalId: { scheme: source.identity.type, value: source.identity.value },
        source: { status: 'unavailable', url: null }, citation: null });
    if (identity.canonicalId !== source.paperId) throw new Error('conference source canonical paperId drifted');
    const metadata = source.metadata;
    const title = String(metadata.title || metadata.paper_title || '').trim();
    if (!title) throw new Error('conference source metadata has no title');
    const rawAuthors = metadata.authors || metadata.author || [];
    const authors = Array.isArray(rawAuthors) ? rawAuthors.map(String)
        : typeof rawAuthors === 'string' ? rawAuthors.split(/\s*;\s*/).filter(Boolean) : [];
    return { id: source.paperId, conferencePaperId: source.paperId, title, authors,
        categories: [`conference:${source.conference.id}`], abstract: String(metadata.abstract || '').trim(),
        source: 'conference', conference: clone(source.conference), externalId: clone(identity.externalId) };
}
function sourceDetails(source) {
    if (source.structuredArtifacts.profile !== contextApi.WEAK_PROFILE
        || source.tableAvailability.available !== false || source.formulaAvailability.available !== false
        || source.figureAvailability.available !== false
        || source.structuredArtifacts.tables.length || source.structuredArtifacts.formulas.length
        || source.structuredArtifacts.figures.length) {
        throw new Error('pilot accepts weak PDF text only with table/formula/figure unavailable');
    }
    const artifactsBody = { version: 1, source: 'conference_pdf_weak_text', tables: [], formulas: [], figures: [],
        flattenedTextSha256: sha256(source.text), capabilityProfile: 'weak-text-only-v1' };
    return { text: source.text, source: 'conference_pdf_text', sourceId: source.paperId,
        imageInfos: [], htmlAvailability: 'not_applicable', htmlAttempts: 0,
        warnings: ['会议 PDF 仅提供弱结构纯文本；表格、公式与 Figure 均不可用，不得据此重建。'],
        structuredArtifacts: { ...artifactsBody, payloadSha256: sha256(JSON.stringify(artifactsBody)) },
        conferenceCapabilities: { fullText: 'weak', tables: 'unavailable', formulas: 'unavailable', figures: 'unavailable' } };
}
function validatePersistedSourceDetails(details, paperId) {
    if (!details || details.source !== 'conference_pdf_text' || details.sourceId !== paperId
        || typeof details.text !== 'string' || details.text.length < contextApi.MIN_TEXT_CHARS
        || !Array.isArray(details.imageInfos) || details.imageInfos.length
        || details.htmlAvailability !== 'not_applicable' || details.htmlAttempts !== 0
        || !Array.isArray(details.warnings) || !details.warnings.length
        || stableHash(details.conferenceCapabilities) !== stableHash({ fullText: 'weak', tables: 'unavailable',
            formulas: 'unavailable', figures: 'unavailable' })) throw new Error('conference weak-text source details are invalid');
    const artifacts = details.structuredArtifacts;
    if (!artifacts || artifacts.source !== 'conference_pdf_weak_text'
        || artifacts.capabilityProfile !== 'weak-text-only-v1' || artifacts.flattenedTextSha256 !== sha256(details.text)
        || !Array.isArray(artifacts.tables) || artifacts.tables.length
        || !Array.isArray(artifacts.formulas) || artifacts.formulas.length
        || !Array.isArray(artifacts.figures) || artifacts.figures.length) throw new Error('conference unavailable artifacts are invalid');
    const body = clone(artifacts); delete body.payloadSha256;
    if (artifacts.payloadSha256 !== sha256(JSON.stringify(body))) throw new Error('conference unavailable artifact SHA drifted');
    return details;
}
function executionDirectory(root, executionId) {
    if (!UUID_RE.test(String(executionId || ''))) throw new Error('analysis executionId must be UUID v4');
    return path.join(safeRoot(root), executionId);
}
function prepareConferenceAnalysis({ planHandle, paperId, sourceRoot, analysisRoot,
    executionId = crypto.randomUUID(), now = new Date().toISOString() } = {}) {
    const source = contextApi.buildConferenceSourceContext({ planHandle, paperId, sourceRoot });
    const details = sourceDetails(source); const paper = normalizedPaper(source);
    const root = safeRoot(analysisRoot, true); const directory = path.join(root, executionId);
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const loaded = loadConferenceAnalysis({ analysisRoot, executionId });
        if (loaded.run.paperId !== paperId || loaded.run.sourceSnapshotSha256 !== source.sourceSnapshotSha256) {
            throw new Error('existing conference analysis execution belongs to different source evidence');
        }
        return { executionId, paperId, status: loaded.run.status, directory, recovered: true };
    }
    const sourceBody = { contract: SOURCE_CONTRACT, version: VERSION, paperId, sourceSnapshotSha256: source.sourceSnapshotSha256,
        observationBindingSha256: source.observationBindingSha256, sourceDetails: details };
    const sourceRecord = { ...sourceBody, recordSha256: stableHash(sourceBody) };
    const sourceFileSha256 = writeJson(path.join(directory, 'source.json'), sourceRecord);
    const analysis = { contract: ANALYSIS_CONTRACT, version: VERSION, executionId, paperId,
        status: 'pending', generation: 0, papers: [paper] };
    writeJson(path.join(directory, 'analysis.json'), analysis);
    const runBody = { contract: RUN_CONTRACT, version: VERSION, executionId, paperId,
        conference: clone(source.conference), createdAt: new Date(now).toISOString(), status: 'source_ready',
        sourceSnapshotSha256: source.sourceSnapshotSha256, observationBindingSha256: source.observationBindingSha256,
        sourceRecordSha256: sourceRecord.recordSha256, sourceFileSha256,
        capabilities: clone(details.conferenceCapabilities) };
    const run = { ...runBody, runSha256: stableHash(runBody) }; writeJson(path.join(directory, 'run.json'), run);
    loadConferenceAnalysis({ analysisRoot, executionId });
    return { executionId, paperId, status: 'source_ready', directory, recovered: false };
}
function loadConferenceAnalysis({ analysisRoot, executionId } = {}) {
    const directory = executionDirectory(analysisRoot, executionId);
    const runRecord = readJsonRecord(path.join(directory, 'run.json'));
    const sourceRecord = readJsonRecord(path.join(directory, 'source.json'));
    const analysisRecord = readJsonRecord(path.join(directory, 'analysis.json'));
    const run = runRecord.value; const source = sourceRecord.value; const analysis = analysisRecord.value;
    const runBody = clone(run); delete runBody.runSha256;
    const sourceBody = clone(source); delete sourceBody.recordSha256;
    const analysisFileSha256 = analysisRecord.sha256;
    if (run.contract !== RUN_CONTRACT || run.version !== VERSION || run.executionId !== executionId
        || run.runSha256 !== stableHash(runBody) || source.contract !== SOURCE_CONTRACT
        || source.recordSha256 !== stableHash(sourceBody) || source.paperId !== run.paperId
        || source.sourceSnapshotSha256 !== run.sourceSnapshotSha256
        || analysis.contract !== ANALYSIS_CONTRACT || analysis.executionId !== executionId
        || analysis.paperId !== run.paperId || !Array.isArray(analysis.papers) || analysis.papers.length !== 1
        || analysis.papers[0].id !== run.paperId || analysis.papers[0].arxivId || analysis.papers[0].paper_id) {
        throw new Error('conference analysis execution evidence drifted');
    }
    validatePersistedSourceDetails(source.sourceDetails, run.paperId);
    const completionPending = analysis.status === 'complete' && run.status !== 'complete';
    if (run.status === 'complete') {
        const receipt = run.completionReceipt; const receiptBody = receipt && clone(receipt); if (receiptBody) delete receiptBody.receiptSha256;
        if (analysis.status !== 'complete' || run.analysisSha256 !== analysisFileSha256
            || !receipt || receipt.analysisSha256 !== analysisFileSha256 || receipt.executionId !== executionId
            || receipt.paperId !== run.paperId || receipt.sourceSnapshotSha256 !== run.sourceSnapshotSha256
            || receipt.receiptSha256 !== stableHash(receiptBody)) throw new Error('conference complete run does not bind canonical analysis bytes');
    } else if (run.analysisSha256 !== undefined || run.completionReceipt !== undefined) {
        throw new Error('incomplete conference run cannot carry completion proof');
    }
    return { directory, run, source, analysis, analysisFileSha256,
        runFileSha256: runRecord.sha256, sourceFileSha256: sourceRecord.sha256, completionPending };
}
function verifyPlanAuthority(loaded, planHandle, sourceRoot) {
    if (!planHandle || typeof sourceRoot !== 'string') throw new Error('live plan authority and sourceRoot are required');
    const replayed = contextApi.buildConferenceSourceContext({ planHandle, paperId: loaded.run.paperId, sourceRoot });
    const details = sourceDetails(replayed);
    if (replayed.sourceSnapshotSha256 !== loaded.run.sourceSnapshotSha256
        || replayed.observationBindingSha256 !== loaded.run.observationBindingSha256
        || stableHash(details) !== stableHash(loaded.source.sourceDetails)) {
        throw new Error('live conference plan authority differs from analysis source evidence');
    }
    return true;
}
function sealCompletedRun(loaded) {
    const analysisFile = path.join(loaded.directory, 'analysis.json');
    const analysisRecord = readJsonRecord(analysisFile); const analysis = analysisRecord.value;
    const analysisSha256 = analysisRecord.sha256;
    if (analysisSha256 !== loaded.analysisFileSha256) throw new Error('conference analysis changed before completion seal');
    if (analysis.status !== 'complete' || typeof analysis.completedAt !== 'string'
        || Number.isNaN(Date.parse(analysis.completedAt)) || new Date(analysis.completedAt).toISOString() !== analysis.completedAt) {
        throw new Error('cannot seal incomplete conference canonical analysis');
    }
    const receiptBody = { contract: 'conference-analysis-completion-receipt-v1', version: VERSION,
        executionId: loaded.run.executionId, paperId: loaded.run.paperId,
        sourceSnapshotSha256: loaded.run.sourceSnapshotSha256, analysisSha256, completedAt: analysis.completedAt };
    const completionReceipt = { ...receiptBody, receiptSha256: stableHash(receiptBody) };
    const runBody = { ...loaded.run, status: 'complete', analysisSha256, completionReceipt, updatedAt: analysis.completedAt };
    delete runBody.runSha256; const run = { ...runBody, runSha256: stableHash(runBody) };
    replaceJson(path.join(loaded.directory, 'run.json'), run, loaded.runFileSha256); return run;
}
async function sealCompletedRunLocked({ analysisRoot, executionId, engine, expectedAnalysisSha256 = null } = {}) {
    const before = loadConferenceAnalysis({ analysisRoot, executionId });
    if (expectedAnalysisSha256 !== null && before.analysisFileSha256 !== expectedAnalysisSha256) {
        throw new Error('conference analysis changed before acquiring completion lock');
    }
    return engine.withPaperAnalysisLock({ id: before.run.paperId }, () => {
        const locked = loadConferenceAnalysis({ analysisRoot, executionId });
        if (locked.analysisFileSha256 !== before.analysisFileSha256) {
            throw new Error('conference analysis changed while waiting for completion lock');
        }
        if (locked.run.status === 'complete') return locked.run;
        return sealCompletedRun(locked);
    });
}
async function analyzeConference({ analysisRoot, executionId, concurrency = 1, planHandle, sourceRoot } = {}, overrides = {}) {
    const engine = overrides.engine || require('../analysis-engine.js');
    const loaded = loadConferenceAnalysis({ analysisRoot, executionId });
    verifyPlanAuthority(loaded, planHandle, sourceRoot);
    const analysisFile = path.join(loaded.directory, 'analysis.json');
    if (loaded.analysis.status === 'complete') {
        const run = loaded.run.status === 'complete' ? loaded.run : await sealCompletedRunLocked({
            analysisRoot, executionId, engine, expectedAnalysisSha256: loaded.analysisFileSha256 });
        return { executionId, paperId: loaded.run.paperId, status: 'complete', canonicalPath: analysisFile,
            analysisSha256: run.analysisSha256, productionAuthorized: true, recovered: true };
    }
    let finalPaper = loaded.analysis.papers[0];
    await analysisContext.withConferenceAnalysisSource({ executionId, executionDir: loaded.directory, paperId: loaded.run.paperId,
        sourceDetails: loaded.source.sourceDetails }, () => engine.analyzeBatch([finalPaper], {
        concurrency, maxRetries: overrides.maxRetries ?? 2, checkpointFilePath: analysisFile, saveInterval: 0,
        preparePaperLocked: () => {
            const current = readJson(analysisFile); const paper = current.papers[0];
            const successful = typeof engine.isSuccessfulAnalysisRecord === 'function'
                ? engine.isSuccessfulAnalysisRecord(paper) : current.status === 'complete';
            return { paper, skip: successful };
        },
        onPaperResultLocked: async (_paper, result) => {
            finalPaper = result.result || { ..._paper, error: result.error || 'conference analysis failed' };
            const currentRecord = readJsonRecord(analysisFile); const current = currentRecord.value; replaceJson(analysisFile,
                { ...current, status: result.success ? 'complete' : 'partial',
                    ...(result.success ? { completedAt: new Date().toISOString() } : {}), papers: [finalPaper] }, currentRecord.sha256);
        }
    }));
    const current = readJson(analysisFile); const status = current.status === 'complete' ? 'complete' : 'partial';
    let run;
    if (status === 'complete') run = await sealCompletedRunLocked({ analysisRoot, executionId, engine,
        expectedAnalysisSha256: readJsonRecord(analysisFile).sha256 });
    else {
        const runBody = { ...loaded.run, status, updatedAt: new Date().toISOString() };
        delete runBody.runSha256; run = { ...runBody, runSha256: stableHash(runBody) };
        replaceJson(path.join(loaded.directory, 'run.json'), run, loaded.runFileSha256);
    }
    return { executionId, paperId: loaded.run.paperId, status, canonicalPath: analysisFile,
        ...(status === 'complete' ? { analysisSha256: run.analysisSha256, productionAuthorized: true } : {}) };
}

module.exports = { RUN_CONTRACT, ANALYSIS_CONTRACT, SOURCE_CONTRACT, VERSION, UUID_RE,
    stableHash, normalizedPaper, sourceDetails, validatePersistedSourceDetails,
    readJsonRecord, prepareConferenceAnalysis, loadConferenceAnalysis, verifyPlanAuthority,
    sealCompletedRun, sealCompletedRunLocked, analyzeConference };
