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
const PREPARE_INTENT_CONTRACT = 'conference-analysis-prepare-intent-v1';
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
function strictJson(bytes, label) {
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error(`${label} must be strict UTF-8 JSON`); }
    const stack = [];
    for (const match of source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const token = match[0], top = stack.at(-1);
        if (token === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
        else if (token === '[') stack.push({ object: false });
        else if (token === '}' || token === ']') stack.pop();
        else if (token === ',' && top?.object) top.expectKey = true;
        else if (token.startsWith('"') && top?.object && top.expectKey) {
            const key = JSON.parse(token); if (top.keys.has(key)) throw new Error(`${label} contains duplicate JSON key: ${key}`);
            top.keys.add(key); top.expectKey = false;
        }
    }
    try { return JSON.parse(source); } catch { throw new Error(`${label} must be valid JSON`); }
}
function exactKeys(value, keys, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\0') !== keys.slice().sort().join('\0')) throw new Error(`${label} schema is invalid`);
}
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
        return { value: strictJson(bytes, path.basename(filename)), bytes, sha256: sha256(bytes) };
    }
    finally { fs.closeSync(fd); }
}
function readJson(filename) { return readJsonRecord(filename).value; }
function syncDirectory(directory) {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
function writeBytesAtomic(filename, bytes, dependencies = {}) {
    const payload = Buffer.from(bytes); const io = dependencies.io || fs; const directory = safeRoot(path.dirname(filename), true);
    const temporary = path.join(directory, `.${path.basename(filename)}.${dependencies.randomUUID?.() || crypto.randomUUID()}.tmp`);
    let fd; let created = null; let published = false; let collided = false;
    try {
        fd = io.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        created = (io.fstatSync || fs.fstatSync)(fd, { bigint: true }); let offset = 0;
        while (offset < payload.length) {
            const written = io.writeSync(fd, payload, offset, payload.length - offset, offset);
            if (!Number.isSafeInteger(written) || written <= 0 || written > payload.length - offset) throw new Error(`short conference analysis write: ${path.basename(filename)}`);
            offset += written;
        }
        io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
        dependencies.afterWrite?.(path.basename(filename));
        try { (io.linkSync || fs.linkSync)(temporary, filename); published = true; }
        catch (error) { if (error.code !== 'EEXIST') throw error; collided = true; }
    } finally {
        if (fd !== undefined) io.closeSync(fd);
        if (created) {
            try { const named = fs.lstatSync(temporary, { bigint: true });
                if (!named.isFile() || named.isSymbolicLink() || named.dev !== created.dev || named.ino !== created.ino
                    || named.nlink !== (published ? 2n : 1n)) throw new Error(`conference analysis temporary identity drifted: ${path.basename(filename)}`);
                (io.unlinkSync || fs.unlinkSync)(temporary); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
    }
    const actual = readJsonRecord(filename).bytes;
    if (!actual.equals(payload)) throw new Error(`${collided ? 'refuses to overwrite different' : 'atomic write verification failed for'} conference analysis bytes: ${path.basename(filename)}`);
    syncDirectory(directory); return sha256(payload);
}
function writeJson(filename, value, dependencies = {}) {
    return writeBytesAtomic(filename, jsonBytes(value), dependencies);
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
function prepareArtifacts(source, details, paper, executionId, now) {
    const planAuthorityBinding = clone(source.productionAuthorization.binding);
    const sourceBody = { contract: SOURCE_CONTRACT, version: VERSION, paperId: source.paperId,
        sourceSnapshotSha256: source.sourceSnapshotSha256, observationBindingSha256: source.observationBindingSha256,
        planAuthorityBinding, sourceSnapshotBinding: clone(source.sourceSnapshotBinding),
        observationBinding: clone(source.observationBinding), sourceDetails: details };
    const sourceRecord = { ...sourceBody, recordSha256: stableHash(sourceBody) }; const sourceBytes = jsonBytes(sourceRecord);
    const analysis = { contract: ANALYSIS_CONTRACT, version: VERSION, executionId, paperId: source.paperId,
        status: 'pending', generation: 0, papers: [paper] }; const analysisBytes = jsonBytes(analysis);
    const intentBody = { contract: PREPARE_INTENT_CONTRACT, version: VERSION, executionId, paperId: source.paperId,
        sourceSnapshotSha256: source.sourceSnapshotSha256, observationBindingSha256: source.observationBindingSha256,
        planAuthorityBindingSha256: stableHash(planAuthorityBinding), sourceRecordSha256: sourceRecord.recordSha256,
        sourceFileSha256: sha256(sourceBytes), initialAnalysisFileSha256: sha256(analysisBytes) };
    const intent = { ...intentBody, intentSha256: stableHash(intentBody) }; const intentBytes = jsonBytes(intent);
    const runBody = { contract: RUN_CONTRACT, version: VERSION, executionId, paperId: source.paperId,
        conference: clone(source.conference), createdAt: new Date(now).toISOString(), status: 'source_ready',
        sourceSnapshotSha256: source.sourceSnapshotSha256, observationBindingSha256: source.observationBindingSha256,
        planAuthorityBindingSha256: stableHash(planAuthorityBinding), prepareIntentSha256: intent.intentSha256,
        prepareIntentFileSha256: sha256(intentBytes), sourceRecordSha256: sourceRecord.recordSha256,
        sourceFileSha256: sha256(sourceBytes), capabilities: clone(details.conferenceCapabilities) };
    const run = { ...runBody, runSha256: stableHash(runBody) };
    return { intent, intentBytes, sourceRecord, sourceBytes, analysis, analysisBytes, run, runBytes: jsonBytes(run) };
}
function exactExisting(filename, bytes, label) {
    if (!fs.existsSync(filename)) return false;
    if (!readJsonRecord(filename).bytes.equals(bytes)) throw new Error(`existing conference analysis ${label} differs from authenticated prepare intent`);
    return true;
}
function prepareConferenceAnalysis({ planHandle, paperId, sourceRoot, analysisRoot,
    executionId = crypto.randomUUID(), now = new Date().toISOString() } = {}, dependencies = {}) {
    if (!UUID_RE.test(String(executionId || ''))) throw new Error('analysis executionId must be UUID v4');
    const source = contextApi.buildConferenceSourceContext({ planHandle, paperId, sourceRoot });
    const details = sourceDetails(source); const paper = normalizedPaper(source);
    const prepared = prepareArtifacts(source, details, paper, executionId, now);
    const root = safeRoot(analysisRoot, true); const directory = path.join(root, executionId); let recovering = false;
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        recovering = true; safeRoot(directory);
        if (fs.existsSync(path.join(directory, 'run.json'))) {
            const loaded = loadConferenceAnalysis({ analysisRoot, executionId });
            verifyPlanAuthority(loaded, planHandle, sourceRoot);
            return { executionId, paperId, status: loaded.run.status, directory, recovered: true };
        }
        const entries = fs.readdirSync(directory).sort();
        if (entries.some(name => !['intent.json', 'source.json', 'analysis.json'].includes(name))) {
            throw new Error('existing conference analysis execution contains unknown recovery content');
        }
        if (entries.length && !entries.includes('intent.json')) {
            throw new Error('legacy conference analysis partial lacks prepare intent; create a new execution UUID');
        }
    }
    const intentFile = path.join(directory, 'intent.json');
    if (fs.existsSync(intentFile)) exactExisting(intentFile, prepared.intentBytes, 'intent');
    else { writeBytesAtomic(intentFile, prepared.intentBytes, dependencies); dependencies.afterPersist?.('intent.json'); }
    const sourceFile = path.join(directory, 'source.json'), analysisFile = path.join(directory, 'analysis.json');
    const sourceExists = exactExisting(sourceFile, prepared.sourceBytes, 'source');
    const analysisExists = exactExisting(analysisFile, prepared.analysisBytes, 'initial analysis');
    if (!sourceExists && analysisExists) throw new Error('conference analysis recovery order is invalid');
    if (!sourceExists) { writeBytesAtomic(sourceFile, prepared.sourceBytes, dependencies); dependencies.afterPersist?.('source.json'); }
    if (!analysisExists) { writeBytesAtomic(analysisFile, prepared.analysisBytes, dependencies); dependencies.afterPersist?.('analysis.json'); }
    writeBytesAtomic(path.join(directory, 'run.json'), prepared.runBytes, dependencies); dependencies.afterPersist?.('run.json');
    loadConferenceAnalysis({ analysisRoot, executionId });
    return { executionId, paperId, status: 'source_ready', directory, recovered: recovering };
}
function loadConferenceAnalysis({ analysisRoot, executionId } = {}) {
    const directory = executionDirectory(analysisRoot, executionId);
    const intentFile = path.join(directory, 'intent.json');
    if (!fs.existsSync(intentFile)) throw new Error('legacy conference analysis execution lacks prepare intent; create a new execution UUID');
    const intentRecord = readJsonRecord(intentFile); const intent = intentRecord.value;
    const runRecord = readJsonRecord(path.join(directory, 'run.json'));
    const sourceRecord = readJsonRecord(path.join(directory, 'source.json'));
    const analysisRecord = readJsonRecord(path.join(directory, 'analysis.json'));
    const run = runRecord.value; const source = sourceRecord.value; const analysis = analysisRecord.value;
    const runBody = clone(run); delete runBody.runSha256;
    const sourceBody = clone(source); delete sourceBody.recordSha256;
    const analysisFileSha256 = analysisRecord.sha256;
    const intentBody = clone(intent); delete intentBody.intentSha256;
    exactKeys(intent, ['contract', 'version', 'executionId', 'paperId', 'sourceSnapshotSha256',
        'observationBindingSha256', 'planAuthorityBindingSha256', 'sourceRecordSha256', 'sourceFileSha256',
        'initialAnalysisFileSha256', 'intentSha256'], 'conference analysis prepare intent');
    if (intent.contract !== PREPARE_INTENT_CONTRACT || intent.version !== VERSION || intent.executionId !== executionId
        || intent.intentSha256 !== stableHash(intentBody) || intentRecord.sha256 !== run.prepareIntentFileSha256
        || intent.intentSha256 !== run.prepareIntentSha256 || intent.paperId !== run.paperId
        || intent.sourceRecordSha256 !== source.recordSha256 || intent.sourceFileSha256 !== sourceRecord.sha256
        || intent.sourceSnapshotSha256 !== run.sourceSnapshotSha256
        || intent.observationBindingSha256 !== run.observationBindingSha256
        || intent.planAuthorityBindingSha256 !== run.planAuthorityBindingSha256
        || run.contract !== RUN_CONTRACT || run.version !== VERSION || run.executionId !== executionId
        || run.runSha256 !== stableHash(runBody) || source.contract !== SOURCE_CONTRACT
        || source.recordSha256 !== stableHash(sourceBody) || source.paperId !== run.paperId
        || run.sourceRecordSha256 !== source.recordSha256 || run.sourceFileSha256 !== sourceRecord.sha256
        || source.sourceSnapshotSha256 !== run.sourceSnapshotSha256
        || run.observationBindingSha256 !== source.observationBindingSha256
        || run.planAuthorityBindingSha256 !== stableHash(source.planAuthorityBinding)
        || stableHash(source.sourceSnapshotBinding) !== run.sourceSnapshotSha256
        || stableHash(source.observationBinding) !== run.observationBindingSha256
        || stableHash(source.sourceSnapshotBinding?.planAuthority) !== stableHash(source.planAuthorityBinding)
        || source.sourceSnapshotBinding?.paperId !== run.paperId
        || source.observationBinding?.sourceSnapshotSha256 !== run.sourceSnapshotSha256
        || (run.status === 'source_ready' && analysis.status === 'pending' && analysisFileSha256 !== intent.initialAnalysisFileSha256)
        || analysis.contract !== ANALYSIS_CONTRACT || analysis.executionId !== executionId
        || analysis.paperId !== run.paperId || !Array.isArray(analysis.papers) || analysis.papers.length !== 1
        || analysis.papers[0].id !== run.paperId || analysis.papers[0].arxivId || analysis.papers[0].paper_id) {
        throw new Error('conference analysis execution evidence drifted');
    }
    validatePersistedSourceDetails(source.sourceDetails, run.paperId);
    const sourceBinding = source.sourceSnapshotBinding?.sourceBinding;
    if (sourceBinding?.textSha256 !== sha256(source.sourceDetails.text)) {
        throw new Error('conference persisted sourceDetails do not bind the authenticated source snapshot');
    }
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
        || stableHash(replayed.productionAuthorization.binding) !== stableHash(loaded.source.planAuthorityBinding)
        || stableHash(replayed.sourceSnapshotBinding) !== stableHash(loaded.source.sourceSnapshotBinding)
        || stableHash(replayed.observationBinding) !== stableHash(loaded.source.observationBinding)
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

module.exports = { RUN_CONTRACT, ANALYSIS_CONTRACT, SOURCE_CONTRACT, PREPARE_INTENT_CONTRACT, VERSION, UUID_RE,
    stableHash, normalizedPaper, sourceDetails, validatePersistedSourceDetails,
    readJsonRecord, writeBytesAtomic, prepareArtifacts, prepareConferenceAnalysis, loadConferenceAnalysis, verifyPlanAuthority,
    sealCompletedRun, sealCompletedRunLocked, analyzeConference };
