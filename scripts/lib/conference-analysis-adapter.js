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
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
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
    const optionalUrl = (value, label) => {
        if (value === undefined || value === null || value === '') return null;
        let parsed;
        try { parsed = new URL(String(value)); } catch { throw new Error(`conference source metadata ${label} is not a URL`); }
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
            throw new Error(`conference source metadata ${label} must be a credential-free HTTPS URL without a fragment`);
        }
        return parsed.toString();
    };
    const officialRecordUrl = optionalUrl(metadata.recordUrl, 'recordUrl');
    const officialPdfUrl = optionalUrl(metadata.pdfUrl, 'pdfUrl');
    const doi = metadata.doi === undefined || metadata.doi === null || metadata.doi === ''
        ? null : String(metadata.doi).trim();
    if (doi !== null && (!doi || doi.length > 500 || /[\u0000-\u001f\u007f\s]/u.test(doi))) {
        throw new Error('conference source metadata DOI is malformed');
    }
    const track = metadata.track === undefined || metadata.track === null || metadata.track === ''
        ? null : String(metadata.track).trim();
    if (track !== null && (!track || track.length > 500 || /[\u0000-\u001f\u007f]/u.test(track))) {
        throw new Error('conference source metadata track is malformed');
    }
    const conferencePublication = officialRecordUrl && officialPdfUrl ? {
        contract: 'conference-official-publication-v1', recordUrl: officialRecordUrl, pdfUrl: officialPdfUrl
    } : null;
    return { id: source.paperId, conferencePaperId: source.paperId, title, authors,
        categories: [`conference:${source.conference.id}`], abstract: String(metadata.abstract || '').trim(),
        source: 'conference', conference: clone(source.conference), externalId: clone(identity.externalId),
        officialRecordUrl, officialPdfUrl, conferencePublication, doi, conferenceTrack: track };
}

function buildReplayableReaderArtifacts(source) {
    const raw = source.structuredArtifacts;
    const sourceDom = value => stableHash(value);
    // 旧版已保存并核验的 PDF 结构化提取记录里的 `tex` 可能含启发式矩阵和纯文本。
    // 原样保留它们，绝不要把内容提升为 DOM 单元格或原始 LaTeX。
    // 哈希只证明字节，不证明提取正确。
    const tables = [];
    const formulas = [];
    const figures = (raw.figures || []).filter(figure => figure.asset && figure.recoveryStatus === 'complete').map(figure => {
        const images = figure.asset ? [{ kind: 'inline_pdf',
            url: `conference-pdf-figure://${encodeURIComponent(source.paperId)}/${figure.ordinal}`,
            alt: figure.caption || `Figure ${figure.ordinal}`,
            mediaType: String(figure.asset.mediaType || '').toLowerCase(),
            rasterDownloadEligible: false, asset: clone(figure.asset) }] : [];
        const originalNumber = /pdf:figure:(\d+):page:/.exec(figure.sourceRef)?.[1] || figure.ordinal;
        return { ordinal: figure.ordinal, label: `Figure ${originalNumber}`,
            caption: figure.caption, images,
            sourceDomSha256: sourceDom({ kind: 'pdf-figure', sourceRef: figure.sourceRef,
                caption: figure.caption, assetSha256: figure.asset?.sha256 || null }),
            recoveryStatus: figure.recoveryStatus };
    });
    const body = { version: 1, parserVersion: 'conference-pdf-structure-v2-visual-only-math-tables',
        sourceKind: 'conference_pdf', sourceId: source.paperId, paperId: source.paperId,
        sourceHtmlSha256: source.sourceBinding.pdfSha256,
        tables, formulas, figures, references: [],
        health: { status: 'ready', detected: { tables: raw.tables.length,
            formulas: raw.formulas.length, figures: raw.figures.length, references: 0,
            bibliographies: 0 }, recovered: { tables: tables.length,
            formulas: formulas.length, figures: figures.length, references: 0 },
            truncated: false, issues: [] }, flattenedTextSha256: sha256(source.text) };
    return { ...body, payloadSha256: stableHash(body) };
}

function sourceDetails(source) {
    if (source.structuredArtifacts.profile === contextApi.REPLAYABLE_PROFILE) {
        const structuredArtifacts = buildReplayableReaderArtifacts(source);
        return { text: source.text, source: 'conference_pdf_text', sourceId: source.paperId,
            imageInfos: [], htmlAvailability: 'not_applicable', htmlAttempts: 0,
            warnings: ['PDF 表格仅可引用原文或复核原页；文字层公式不是原始 TeX，不提供可发布结构化表格或公式。'], structuredArtifacts,
            conferenceCapabilities: { fullText: 'full', tables: 'unavailable',
                formulas: 'unavailable', figures: 'available' } };
    }
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
    if (details?.conferenceCapabilities?.fullText === 'full') {
        if (details.source !== 'conference_pdf_text' || details.sourceId !== paperId
            || typeof details.text !== 'string' || details.text.length < contextApi.MIN_TEXT_CHARS
            || !Array.isArray(details.imageInfos) || details.imageInfos.length
            || details.htmlAvailability !== 'not_applicable' || details.htmlAttempts !== 0
            || !Array.isArray(details.warnings)
            || stableHash(details.conferenceCapabilities) !== stableHash({ fullText: 'full',
                tables: 'unavailable', formulas: 'unavailable', figures: 'available' })) {
            throw new Error('conference structured source details are invalid');
        }
        const artifacts = details.structuredArtifacts;
        const required = ['version', 'parserVersion', 'sourceKind', 'sourceId', 'paperId',
            'sourceHtmlSha256', 'tables', 'formulas', 'figures', 'references', 'health',
            'flattenedTextSha256', 'payloadSha256'];
        if (!artifacts || Object.keys(artifacts).sort().join('\0') !== required.sort().join('\0')
            || artifacts.version !== 1 || artifacts.parserVersion !== 'conference-pdf-structure-v2-visual-only-math-tables'
            || artifacts.sourceKind !== 'conference_pdf' || artifacts.sourceId !== paperId
            || artifacts.paperId !== paperId || !/^[a-f0-9]{64}$/.test(artifacts.sourceHtmlSha256)
            || artifacts.flattenedTextSha256 !== sha256(details.text)
            || !Array.isArray(artifacts.tables) || !Array.isArray(artifacts.formulas)
            || artifacts.tables.length || artifacts.formulas.length
            || !Array.isArray(artifacts.figures) || !Array.isArray(artifacts.references)
            || artifacts.references.length
            || !artifacts.health || artifacts.health.status !== 'ready'
            || artifacts.payloadSha256 !== stableHash(Object.fromEntries(
                Object.entries(artifacts).filter(([key]) => key !== 'payloadSha256')))) {
            throw new Error('conference structured artifacts are invalid');
        }
        return details;
    }
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
    return replayed;
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
function conferencePaperLockOptions(engine) {
    if (typeof engine?.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY !== 'symbol') {
        throw new Error('conference analysis engine lacks the local-dead lock recovery policy');
    }
    return { recoveryPolicy: engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY };
}
async function sealCompletedRunLocked({ analysisRoot, executionId, engine, expectedAnalysisSha256 = null } = {}) {
    const before = loadConferenceAnalysis({ analysisRoot, executionId });
    if (expectedAnalysisSha256 !== null && before.analysisFileSha256 !== expectedAnalysisSha256) {
        throw new Error('conference analysis changed before acquiring completion lock');
    }
    return engine.withPaperAnalysisLock({ id: before.run.paperId }, () => {
        let locked = loadConferenceAnalysis({ analysisRoot, executionId });
        if (locked.analysisFileSha256 !== before.analysisFileSha256) {
            throw new Error('conference analysis changed while waiting for completion lock');
        }
        if (locked.analysis.status === 'complete' && locked.analysis.stats?.analysisStatus !== 'complete') {
            if (locked.run.status === 'complete') {
                const runBody = { ...locked.run, status: 'partial', updatedAt: new Date().toISOString() };
                delete runBody.analysisSha256; delete runBody.completionReceipt; delete runBody.runSha256;
                replaceJson(path.join(locked.directory, 'run.json'),
                    { ...runBody, runSha256: stableHash(runBody) }, locked.runFileSha256);
                locked = loadConferenceAnalysis({ analysisRoot, executionId });
            }
            const normalized = { ...locked.analysis,
                stats: { ...(locked.analysis.stats && !Array.isArray(locked.analysis.stats)
                    ? locked.analysis.stats : {}), analysisStatus: 'complete' } };
            replaceJson(path.join(locked.directory, 'analysis.json'), normalized, locked.analysisFileSha256);
            locked = loadConferenceAnalysis({ analysisRoot, executionId });
        }
        if (locked.run.status === 'complete') return locked.run;
        return sealCompletedRun(locked);
    }, conferencePaperLockOptions(engine));
}
async function analyzeConference({ analysisRoot, executionId, concurrency = 1, planHandle, sourceRoot } = {}, overrides = {}) {
    const engine = overrides.engine || require('../analysis-engine.js');
    const loaded = loadConferenceAnalysis({ analysisRoot, executionId });
    const readerPdfSourceHandle = verifyPlanAuthority(loaded, planHandle, sourceRoot);
    const analysisFile = path.join(loaded.directory, 'analysis.json');
    if (loaded.analysis.status === 'complete') {
        if (!require('./model-text-sanitization.js').canReuseModelTextInputs(
            loaded.analysis.papers[0], loaded.source.sourceDetails)) {
            fail('旧会议模型输入清洗可能损坏 Unicode 字符，必须按已核验来源重新分析后再复用');
        }
        if (!require('./reader-author-source.js').canReuseReaderAuthorInputs(loaded.analysis.papers[0], loaded.source.sourceDetails)) {
            fail('旧会议作者来源未通过封存全文重放，请先刷新作者或 Reader 后再复用');
        }
        const run = loaded.run.status === 'complete' && loaded.analysis.stats?.analysisStatus === 'complete'
            ? loaded.run : await sealCompletedRunLocked({
            analysisRoot, executionId, engine, expectedAnalysisSha256: loaded.analysisFileSha256 });
        return { executionId, paperId: loaded.run.paperId, status: 'complete', canonicalPath: analysisFile,
            analysisSha256: run.analysisSha256, productionAuthorized: true, recovered: true };
    }
    let finalPaper = loaded.analysis.papers[0];
    await analysisContext.withConferenceAnalysisSource({ executionId, executionDir: loaded.directory, paperId: loaded.run.paperId,
        readerPdfSourceHandle, sourceDetails: loaded.source.sourceDetails,
        ...(overrides.readerRetryEpoch !== undefined
            ? { readerRetryEpoch: overrides.readerRetryEpoch } : {}) }, () => engine.analyzeBatch([finalPaper], {
        concurrency, maxRetries: overrides.maxRetries ?? 2, checkpointFilePath: analysisFile, saveInterval: 0,
        preparePaperLocked: () => {
            const current = readJson(analysisFile); const paper = current.papers[0];
            const successful = typeof engine.isSuccessfulAnalysisRecord === 'function'
                ? engine.isSuccessfulAnalysisRecord(paper) : current.status === 'complete';
            return { paper, skip: successful };
        },
        onPaperResultLocked: async (_paper, result) => {
            finalPaper = result.result || { ..._paper, error: result.error || 'conference analysis failed' };
            const currentRecord = readJsonRecord(analysisFile); const current = currentRecord.value;
            const status = result.success ? 'complete' : 'partial';
            const next = { ...current, status,
                stats: { ...(current.stats && !Array.isArray(current.stats) ? current.stats : {}), analysisStatus: status },
                ...(result.success ? { completedAt: new Date().toISOString() } : {}), papers: [finalPaper] };
            if (!result.success) delete next.completedAt;
            replaceJson(analysisFile, next, currentRecord.sha256);
            // 这个回调仍在规范论文锁下运行。在这里就把结果写下来，
            // 免得批次后处理路径在本进程里重新申请同一把锁，自己等自己。
            if (result.success) {
                const completed = loadConferenceAnalysis({ analysisRoot, executionId });
                sealCompletedRun(completed);
            }
        },
        paperLockOptions: conferencePaperLockOptions(engine)
    }));
    const current = readJson(analysisFile); const status = current.status === 'complete' ? 'complete' : 'partial';
    let run;
    if (status === 'complete') {
        const completed = loadConferenceAnalysis({ analysisRoot, executionId });
        run = completed.run.status === 'complete' && completed.analysis.stats?.analysisStatus === 'complete'
            ? completed.run
            : await sealCompletedRunLocked({ analysisRoot, executionId, engine,
                expectedAnalysisSha256: readJsonRecord(analysisFile).sha256 });
    }
    else {
        const runBody = { ...loaded.run, status, updatedAt: new Date().toISOString() };
        delete runBody.runSha256; run = { ...runBody, runSha256: stableHash(runBody) };
        replaceJson(path.join(loaded.directory, 'run.json'), run, loaded.runFileSha256);
    }
    return { executionId, paperId: loaded.run.paperId, status, canonicalPath: analysisFile,
        ...(status === 'complete' ? { analysisSha256: run.analysisSha256, productionAuthorized: true } : {}) };
}

const READER_REVISION_CONTRACT = 'conference-reader-source-revision-v1';
const RECOVERY_WINDOW_CONTRACT = 'conference-reader-recovery-window-v1';
let fullRevisionActive = 0;
const fullRevisionWaiters = [];
async function withNormalAnalysisSlot(callback) {
    const limit = Math.max(1, Math.min(3, require('../config').ANALYSIS_CONFIG.concurrency || 3));
    while (fullRevisionActive >= limit) await new Promise(resolve => fullRevisionWaiters.push(resolve));
    fullRevisionActive += 1;
    try {
        require('./analysis-stop-control').assertMayStartRequest();
        return await callback();
    }
    catch (error) {
        if (require('./conference-process-recovery').classifyFailure(error, new Date().toISOString()).systemic) {
            require('./analysis-stop-control').requestAnalysisStop(error.code || 'service_failure');
        }
        throw error;
    }
    finally { fullRevisionActive -= 1; fullRevisionWaiters.shift()?.(); }
}
function readerRevisionExecutionId(parentExecutionId, parentAnalysisFileSha256) {
    const value = sha256(`${READER_REVISION_CONTRACT}\0${parentExecutionId}\0${parentAnalysisFileSha256}`);
    return `${value.slice(0,8)}-${value.slice(8,12)}-4${value.slice(13,16)}-a${value.slice(17,20)}-${value.slice(20,32)}`;
}
function readerResourceRevisionMode(paper, identity) {
    const deep = require('../deep-analyzer'), { parseAnalysis } = require('../utils');
    const before = parseAnalysis(paper.analysis);
    const after = parseAnalysis(deep.applyApiReaderResourceAvailability(paper.analysis, identity));
    return ['hasCode', 'hasModel', 'hasDataset'].some(field => before[field] !== after[field])
        ? 'scoring-and-reader' : 'reader-only';
}
function readReaderResourcePreflight(loaded, expectedFileSha256) {
    const record = readJsonRecord(path.join(loaded.directory, 'reader-resource-preflight.json'));
    if (record.sha256 !== expectedFileSha256) throw new Error('会议资源预检文件 SHA 改变');
    const identity = require('../deep-analyzer').replayVerifiedReaderResourceIdentity(
        record.value, loaded.source.sourceDetails.text);
    const demos = loaded.analysis.papers[0]?.analysisManifest?.stages?.demoLinkScan?.discoveredLinks || [];
    if (identity.resources.some(resource => resource.origin === 'validated_demo' && !demos.includes(resource.originalUrl))) {
        throw new Error('会议资源预检 Demo 不属于原已核验发现记录');
    }
    return identity;
}
function revisionQualificationError(paper, rules, engine, label) {
    const diagnostics = typeof engine.getApiReaderV3RecordDiagnostics === 'function'
        ? engine.getApiReaderV3RecordDiagnostics(paper, {
            legacyConferenceResourceBindings: true, conferencePublicationEvidence: true }) : [];
    const upstream = typeof engine.getConferenceReaderRefreshUpstreamReason === 'function'
        ? engine.getConferenceReaderRefreshUpstreamReason(paper, { tagRules: rules }) : null;
    const reason = upstream || diagnostics.map(item => `${item.check}: ${item.message}`).join('; ')
        || paper.latestAnalysisAttemptError || '未完成事实反馈义务、最新失败或完整发布资格未通过。';
    return Object.assign(new Error(`${label}：${reason}`), {
        code: 'CONFERENCE_READER_REVISION_QUALIFICATION_FAILED', readerQualificationDiagnostics: diagnostics });
}
async function inspectLoadedReaderRevisionCompletion(loaded, { planHandle, sourceRoot }, { engine, deep }) {
    const readerPdfSourceHandle = verifyPlanAuthority(loaded, planHandle, sourceRoot);
    const paper = loaded.analysis.papers[0], parentPaper = loaded.parent.analysis.papers[0];
    const progress = loaded.analysis.readerRevisionProgress;
    if (!progress || !Number.isSafeInteger(progress.attempts) || progress.attempts < 0
        || progress.attempts > loaded.revision.maxAttempts || !Array.isArray(progress.failures)) {
        throw Object.assign(new Error('保存的会议 Reader 修订轮次或失败历史损坏'), { retryable: false });
    }
    if (progress.attempts < 1
        || paper.analysisManifest?.stages?.apiReaderArticle?.status !== 'complete'
        || typeof deep.inspectSavedConferenceReaderCompletion !== 'function') {
        return { eligible: false, reason: '没有本子任务已完成 Reader 的可重放付费签发证明。' };
    }
    const inspect = async () => {
        const proof = await deep.inspectSavedConferenceReaderCompletion(paper, {
            executionId: loaded.run.executionId, executionDir: loaded.directory,
            parentPaper, revision: loaded.revision });
        if (!proof) return { eligible: false, reason: '保存稿未与本子任务支持的真实付费候选闭合链对应。' };
        if (loaded.revision.mode !== 'normal-analysis') {
            for (const name of ['primaryAnalysis', 'coreSummaryRepair', 'tagSelection', 'taxonomySeal']) {
                if (stableHash(paper.analysisManifest?.stages?.[name] || null)
                    !== stableHash(parentPaper.analysisManifest?.stages?.[name] || null)) {
                    throw Object.assign(new Error(`保存的 Reader 子稿改动受保护原阶段：${name}`), { retryable: false });
                }
            }
        }
        const rules = require('./conference-postprocess').readOriginalTagProof(paper).rules;
        if (!engine.isSuccessfulAnalysisRecordForReadOnlyConferencePublication(paper, { tagRules: rules })) {
            const error = revisionQualificationError(paper, rules, engine, '保存的付费 Reader 未通过正常整篇资格');
            return { eligible: false, reason: error.message, diagnostics: error.readerQualificationDiagnostics };
        }
        // An issuance proof is useful only for this exact immutable read. Never
        // approve a parent/source or canonical record changed during replay.
        const after = loadConferenceReaderRevision({ analysisRoot: path.dirname(loaded.directory),
            executionId: loaded.run.executionId });
        if (after.analysisFileSha256 !== loaded.analysisFileSha256
            || after.runFileSha256 !== loaded.runFileSha256
            || after.sourceFileSha256 !== loaded.sourceFileSha256) throw new Error('付费 Reader 冷核期间子稿或来源发生变化');
        return { eligible: true, proof, analysisSha256: loaded.analysisFileSha256,
            articleSha256: paper.apiReaderArticleSha256, attempts: progress.attempts };
    };
    return analysisContext.withConferenceAnalysisSource({ executionId: loaded.run.executionId,
        readerPdfSourceHandle, executionDir: loaded.directory, paperId: loaded.run.paperId, sourceDetails: loaded.source.sourceDetails }, () =>
        loaded.recoveryWindow
            ? require('./conference-reader-recovery-window').withConferenceReaderGrantReadOnly(
                loaded.recoveryWindow.grantHandle, { paperId: loaded.run.paperId, executionId: loaded.run.executionId,
                    executionDir: loaded.directory, readerPdfSourceHandle }, inspect)
            : inspect());
}
async function inspectConferenceReaderRevisionCompletion({ analysisRoot, executionId, planHandle, sourceRoot } = {}, overrides = {}) {
    const loaded = loadConferenceReaderRevision({ analysisRoot, executionId });
    return inspectLoadedReaderRevisionCompletion(loaded, { planHandle, sourceRoot }, {
        engine: overrides.engine || require('../analysis-engine'), deep: overrides.deep || require('../deep-analyzer') });
}
function readerScoringCheckpoint(paper, loaded, engine, rules) {
    const stage = paper.analysisManifest?.stages?.scoringAudit;
    require('../deep-analyzer').replayVerifiedReaderResourceIdentity(paper.apiReaderResources, loaded.source.sourceDetails.text);
    if (engine.getConferenceReaderRefreshUpstreamReason(paper, { tagRules: rules })
        || stage?.auditSha256 !== stableHash(stage?.audit)
        || paper.sourceSha256 !== sha256(loaded.source.sourceDetails.text)
        || paper.analysisManifest?.sourceAcquisition?.sourceSha256 !== paper.sourceSha256) {
        throw new Error('会议新评分检查点未通过正常上游、来源与评分审计核验');
    }
    return { revisionSha256: loaded.revision.revisionSha256, sourceSha256: paper.sourceSha256,
        resourceIdentitySha256: paper.apiReaderResources.identitySha256,
        analysisSha256: sha256(paper.analysis), scoringStageSha256: stableHash(stage) };
}
function loadConferenceReaderRevision({ analysisRoot, executionId } = {}) {
    const loaded = loadConferenceAnalysis({ analysisRoot, executionId });
    const record = readJsonRecord(path.join(loaded.directory, 'reader-revision.json'));
    const { revisionSha256, ...body } = record.value;
    if (body.contract === RECOVERY_WINDOW_CONTRACT) return loadGrantedConferenceRecoveryRecord({ analysisRoot, executionId }, loaded, record);
    if (body.contract !== READER_REVISION_CONTRACT || body.version !== 1
        || !['reader-only', 'scoring-and-reader', 'normal-analysis'].includes(body.mode)
        || !Number.isSafeInteger(body.maxAttempts) || body.maxAttempts < 1 || body.maxAttempts > 3
        || revisionSha256 !== stableHash(body) || body.executionId !== executionId
        || readerRevisionExecutionId(body.parentExecutionId, body.parentAnalysisFileSha256) !== executionId
        || body.paperId !== loaded.run.paperId || body.sourceSnapshotSha256 !== loaded.run.sourceSnapshotSha256) {
        throw new Error('会议 Reader revision 身份或 SHA 不一致');
    }
    const parent = loadConferenceAnalysis({ analysisRoot, executionId: body.parentExecutionId });
    if (parent.run.status !== 'complete' || parent.analysis.status !== 'complete'
        || parent.analysisFileSha256 !== body.parentAnalysisFileSha256
        || parent.runFileSha256 !== body.parentRunFileSha256
        || parent.run.paperId !== body.paperId || parent.run.sourceSnapshotSha256 !== body.sourceSnapshotSha256
        || parent.sourceFileSha256 !== loaded.sourceFileSha256) {
        throw new Error('会议 Reader revision 原完成稿、原来源或原凭证发生变化');
    }
    const resourcePreflight = body.mode === 'normal-analysis' ? null
        : readReaderResourcePreflight({ ...loaded, analysis: parent.analysis }, body.resourcePreflightFileSha256);
    if (resourcePreflight && readerResourceRevisionMode(parent.analysis.papers[0], resourcePreflight) !== body.mode) {
        throw new Error('会议资源预检与原稿三项资源字段的固定恢复模式不一致');
    }
    return { ...loaded, revision: record.value, parent, resourcePreflight };
}
async function refreshConferenceReader({ analysisRoot, parentExecutionId, planHandle, sourceRoot,
    maxAttempts = 3, reusePaidCoreDiagnostics = false } = {}, overrides = {}) {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new Error('会议 revision 总轮预算必须为1至3');
    const engine = overrides.engine || require('../analysis-engine');
    const deep = overrides.deep || require('../deep-analyzer');
    const parent = loadConferenceAnalysis({ analysisRoot, executionId: parentExecutionId });
    const parentReaderPdfSourceHandle = verifyPlanAuthority(parent, planHandle, sourceRoot);
    if (parent.run.status !== 'complete' || parent.analysis.status !== 'complete') {
        throw Object.assign(new Error('会议 Reader revision 只接受完整签名父稿'), { retryable: false });
    }
    let original, upstreamIssue;
    try {
        original = require('./conference-postprocess').readOriginalTagProof(parent.analysis.papers[0]);
        upstreamIssue = analysisContext.withConferenceAnalysisSource({ executionId: parent.run.executionId,
            executionDir: parent.directory, paperId: parent.run.paperId, sourceDetails: parent.source.sourceDetails,
            readerPdfSourceHandle: parentReaderPdfSourceHandle }, () =>
            engine.getConferenceReaderRefreshUpstreamReason(parent.analysis.papers[0], { tagRules: original.rules }));
    } catch (error) { upstreamIssue = error.message; }
    const fullAnalysis = Boolean(upstreamIssue) || !require('./model-text-sanitization').canReuseModelTextInputs(
        parent.analysis.papers[0], parent.source.sourceDetails);
    const executionId = readerRevisionExecutionId(parentExecutionId, parent.analysisFileSha256);
    return engine.withPaperAnalysisLock({ id: parent.run.paperId }, async () => {
        const lockedParent = loadConferenceAnalysis({ analysisRoot, executionId: parentExecutionId });
        if (lockedParent.analysisFileSha256 !== parent.analysisFileSha256
            || lockedParent.runFileSha256 !== parent.runFileSha256) throw new Error('会议 Reader 父稿等待锁期间改变');
        prepareConferenceAnalysis({ analysisRoot, executionId, planHandle, sourceRoot, paperId: parent.run.paperId });
        let loaded = loadConferenceAnalysis({ analysisRoot, executionId });
        let readerPdfSourceHandle = verifyPlanAuthority(loaded, planHandle, sourceRoot);
        const filename = path.join(loaded.directory, 'reader-revision.json');
        const seeded = { ...loaded.analysis, status: 'partial', generation: 1,
            papers: [clone(parent.analysis.papers[0])], readerRevisionProgress: { attempts: 0, failures: [] } };
        if (!fs.existsSync(filename)) {
            if (loaded.analysis.status !== 'pending') throw new Error('会议 Reader revision 缺少原身份凭证');
            let resourcePreflightFileSha256, mode = 'normal-analysis';
            if (!fullAnalysis) {
                const preflightFile = path.join(loaded.directory, 'reader-resource-preflight.json');
                if (!fs.existsSync(preflightFile)) {
                    const identity = await analysisContext.withConferenceAnalysisSource({ executionId,
                        readerPdfSourceHandle, executionDir: loaded.directory, paperId: parent.run.paperId, sourceDetails: loaded.source.sourceDetails }, () =>
                        deep.buildApiReaderResourceIdentity(parent.analysis.papers[0].analysis,
                            loaded.source.sourceDetails.text, parent.analysis.papers[0].analysisManifest?.stages?.demoLinkScan,
                            { paper: parent.analysis.papers[0], structuredArtifacts: loaded.source.sourceDetails.structuredArtifacts }));
                    // The normal builder's response is replayed before it can
                    // become this child's immutable resource/mode authority.
                    require('../deep-analyzer').replayVerifiedReaderResourceIdentity(identity, loaded.source.sourceDetails.text);
                    writeJson(preflightFile, identity);
                }
                resourcePreflightFileSha256 = readJsonRecord(preflightFile).sha256;
                const identity = readReaderResourcePreflight({ ...loaded,
                    analysis: parent.analysis }, resourcePreflightFileSha256);
                mode = readerResourceRevisionMode(parent.analysis.papers[0], identity);
            }
            const body = { contract: READER_REVISION_CONTRACT, version: 1, executionId,
                parentExecutionId, parentAnalysisFileSha256: parent.analysisFileSha256,
                parentRunFileSha256: parent.runFileSha256, paperId: parent.run.paperId,
                sourceSnapshotSha256: parent.run.sourceSnapshotSha256,
                mode,
                ...(resourcePreflightFileSha256 ? { resourcePreflightFileSha256 } : {}),
                maxAttempts,
                seededAnalysisSha256: sha256(jsonBytes(seeded)) };
            writeJson(filename, { ...body, revisionSha256: stableHash(body) });
        }
        loaded = loadConferenceReaderRevision({ analysisRoot, executionId });
        if (loaded.revision.maxAttempts !== maxAttempts) throw new Error('会议 revision 原付费轮预算不能改变');
        if (loaded.analysis.status === 'pending') {
            if (sha256(jsonBytes(seeded)) !== loaded.revision.seededAnalysisSha256) throw new Error('会议 Reader revision 初始父稿不一致');
            replaceJson(path.join(loaded.directory, 'analysis.json'), seeded, loaded.analysisFileSha256);
            loaded = loadConferenceReaderRevision({ analysisRoot, executionId });
        }
        return continueConferenceRevision({ loaded, parent, planHandle, sourceRoot, analysisRoot,
            executionId, fullAnalysis, original, maxAttempts, reusePaidCoreDiagnostics }, { engine, deep, ...overrides });
    }, conferencePaperLockOptions(engine)).catch(error => {
        // Resource preflight precedes the paid-attempt block, but a provider or
        // storage failure must stop the same shared request scope immediately.
        if (require('./conference-process-recovery').classifyFailure(error, new Date().toISOString()).systemic) {
            require('./analysis-stop-control').requestAnalysisStop(error.code || 'service_failure');
        }
        throw error;
    });
}

function recoveryWindowError(message) {
    return Object.assign(new Error(message), { code: 'CONFERENCE_RECOVERY_GRANT_INTEGRITY', scope: 'run', retryable: false });
}

function grantedRecoveryExecutionId(grantId, failedExecutionId, failedAnalysisFileSha256) {
    return require('./conference-recovery-grant').grantedRecoveryExecutionId(grantId, failedExecutionId, failedAnalysisFileSha256);
}
function assertGrantedMember(authority, failed) {
    const member = authority.member;
    if (member?.paperId !== failed.run.paperId || member.childExecutionId !== failed.run.executionId
        || member.parentExecutionId !== failed.parent.run.executionId
        || member.sourceSnapshotSha256 !== failed.run.sourceSnapshotSha256
        || member.sourceTextSha256 !== sha256(failed.source.sourceDetails.text)) throw recoveryWindowError('新增会议恢复授权与原失败成员或来源不一致');
    const entries = authority.files || member.files || Object.entries(member.recordCAS || {}).map(([file, hash]) => ({ path: file, sha256: hash }));
    const expected = new Map(entries.map(entry => [path.resolve(__dirname, '../..', entry.path), entry.sha256]));
    for (const directory of [failed.directory, failed.parent.directory]) {
        for (const name of ['analysis.json', 'run.json', 'source.json', ...(directory === failed.directory ? ['reader-revision.json'] : [])]) {
            const filename = path.join(directory, name);
            if (expected.get(filename) !== readJsonRecord(filename).sha256) throw recoveryWindowError('新增会议恢复原父子稿 CAS 不一致：' + name);
        }
    }
    authority.assertUnchanged();
    if (Boolean(failed.recoveryWindow) !== Boolean(authority.continuation)
        || authority.continuation && (failed.revision.grantId !== authority.continuation.grantId
            || failed.revision.grantSha256 !== authority.continuation.grantSha256)) {
        throw recoveryWindowError('只有显式延续许可能接受最新已登记失败窗口');
    }
}
function grantedRecoveryMode(failed) {
    const paper = failed.analysis.papers[0];
    const invalidCore = require('../analysis-contract').validateCoreSummarySemanticContract(paper.analysis,
        { sourceText: failed.source.sourceDetails.text });
    return invalidCore || !require('./model-text-sanitization').canReuseModelTextInputs(paper, failed.source.sourceDetails)
        || paper.analysisManifest?.stages?.primaryAnalysis?.status !== 'complete'
        || !['complete', 'not_needed'].includes(paper.analysisManifest?.stages?.coreSummaryRepair?.status)
        || failed.revision.mode === 'normal-analysis' ? 'normal-analysis' : failed.revision.mode;
}
function assertGrantedCoreProtection(paper, failed) {
    const original = failed.analysis.papers[0], contract = require('../analysis-contract');
    if (contract.hashAnalysisWithMaskedCoreSummary(paper.analysisCheckpoint)
        !== contract.hashAnalysisWithMaskedCoreSummary(original.analysisCheckpoint)) {
        throw recoveryWindowError('原付费核心重放改变了其余十二节');
    }
    for (const name of ['primaryAnalysis', 'openSourceScan', 'demoLinkScan', 'revision', 'tableRepair',
        'methodRepair', 'structureRepair', 'tagSelection', 'taxonomySeal']) {
        if (stableHash(paper.analysisManifest?.stages?.[name] || null) !== stableHash(original.analysisManifest?.stages?.[name] || null)) {
            throw recoveryWindowError('原付费核心重放改变了非核心上游阶段：' + name);
        }
    }
}
function missingOldCoreDiagnostic(error, failed) {
    if (error?.code !== 'READER_DIAGNOSTIC_FAILED') return false;
    if (String(error.message).endsWith('当前完整摘要身份没有唯一最新的原付费响应')) return true;
    const directory = path.join(failed.directory, 'analysis-repair-attempts', `conference-${sha256(failed.run.paperId)}`, 'request-diagnostics');
    for (let cause = error.cause; cause; cause = cause.cause) {
        if (cause.code === 'ENOENT' && typeof cause.path === 'string'
            && (cause.path === directory || path.dirname(cause.path) === directory)) return true;
    }
    return false;
}

function validateGrantedRecoverySeed(record, failed, authority) {
    const seed = record.value, paper = seed.paper;
    if (seed.contract !== 'conference-recovery-seed-v1' || seed.grantId !== authority.grantId
        || seed.failedAnalysisFileSha256 !== failed.analysisFileSha256 || paper?.id !== failed.run.paperId) {
        throw recoveryWindowError('新增会议恢复初始检查点未绑定原失败稿');
    }
    if (seed.paidCoreReplay) {
        assertGrantedCoreProtection(paper, failed);
        const stage = paper.analysisManifest?.stages?.coreSummaryRepair, proof = stage?.paidDiagnosticReplay;
        if (!proof || !['complete', 'not_needed'].includes(stage.status) || proof.id !== seed.paidCoreReplay
            || stage.outputAnalysisSha256 !== sha256(paper.analysisCheckpoint)
            || require('../analysis-contract').validateCoreSummarySemanticContract(paper.analysisCheckpoint,
                { sourceText: failed.source.sourceDetails.text })) throw recoveryWindowError('原付费核心检查点未通过完整语义或正文绑定');
        const directory = path.join(failed.directory, 'analysis-repair-attempts', `conference-${sha256(failed.run.paperId)}`, 'request-diagnostics');
        const records = Object.fromEntries(['request', 'response', 'disposition'].map(kind => {
            const value = readJsonRecord(path.join(directory, `${proof.id}.${kind}.json`));
            if (value.sha256 !== proof[kind]) throw recoveryWindowError('原付费核心诊断字节已变化');
            return [kind, value];
        }));
        const identity = records.request.value.identity;
        const saved = require('./reader-request-diagnostics').readCoreSummaryDiagnostic(path.dirname(directory), proof.id, identity);
        const rawSummary = String(saved.response.rawResponse).trim().match(/^##\s*核心摘要[：:\s]*\n([\s\S]+)$/);
        if (identity?.sourceIdentity?.executionId !== failed.run.executionId || identity.paperId !== failed.run.paperId
            || identity.sourceTextSha256 !== sha256(failed.source.sourceDetails.text)
            || identity.inputAnalysisSha256 !== stage.inputAnalysisSha256 || identity.evidenceSha256 !== stage.evidenceSha256
            || identity.stageFingerprint !== stage.fingerprint
            || require('../analysis-contract').hashAnalysisWithMaskedCoreSummary(saved.request.inputAnalysis)
                !== require('../analysis-contract').hashAnalysisWithMaskedCoreSummary(paper.analysisCheckpoint) || !rawSummary
            || require('../deep-analyzer').extractSectionByTitle(paper.analysisCheckpoint, '核心摘要').trim() !== rawSummary[1].trim()) {
            throw recoveryWindowError('原付费核心检查点与真实原响应或来源身份不一致');
        }
    } else if (stableHash(paper) !== stableHash(failed.analysis.papers[0])) {
        throw recoveryWindowError('未复用付费核心时初始稿不能改变原失败稿');
    }
    return seed;
}
async function prepareGrantedRecoverySeed(failed, authority, withFailedSource, deep) {
    const original = clone(failed.analysis.papers[0]);
    const result = { contract: 'conference-recovery-seed-v1', grantId: authority.grantId,
        failedAnalysisFileSha256: failed.analysisFileSha256, paper: original, paidCoreReplay: null };
    if (original.analysisManifest?.stages?.coreSummaryRepair?.status !== 'contract_rejected'
        || !String(original.analysisCheckpoint || '').trim()) return result;
    let captured = null;
    const candidate = clone(original), stopAtCore = new Error('GRANTED_CORE_CHECKPOINT_CAPTURED');
    candidate[Symbol.for('audio-paper-digest.analysisCheckpointCallback')] = paper => {
        const stage = paper.analysisManifest?.stages?.coreSummaryRepair;
        if (!['complete', 'not_needed'].includes(stage?.status) || !stage.paidDiagnosticReplay?.id) return;
        assertGrantedCoreProtection(paper, failed);
        captured = clone(paper); throw stopAtCore;
    };
    try {
        await require('./analysis-stop-control').withModelRequestsForbidden(() => withFailedSource(() =>
            deep.analyzePaperDeep(candidate, { replayLatestCoreSummaryDiagnostic: true })));
    } catch (error) {
        if (error !== stopAtCore) {
            const stop = require('./analysis-stop-control');
            const missing = missingOldCoreDiagnostic(error, failed);
            const allowed = error.code === stop.MODEL_REQUESTS_FORBIDDEN || error.code === 'CONTRACT_REJECTED' || missing;
            if (!allowed || (!missing && require('./conference-process-recovery').classifyFailure(error,
                new Date().toISOString()).systemic)) throw error;
            result.coreReplayFailure = { code: error.code || null, message: error.message };
        }
    }
    authority.assertUnchanged();
    if (captured) {
        captured.analysis = captured.analysisCheckpoint;
        captured.parsed = require('../utils').parseAnalysis(captured.analysis);
        result.paper = captured;
        result.paidCoreReplay = captured.analysisManifest.stages.coreSummaryRepair.paidDiagnosticReplay.id;
    }
    return result;
}

function loadGrantedConferenceRecovery({ analysisRoot, executionId } = {}) {
    const loaded = loadConferenceAnalysis({ analysisRoot, executionId });
    const record = readJsonRecord(path.join(loaded.directory, 'reader-revision.json'));
    return loadGrantedConferenceRecoveryRecord({ analysisRoot, executionId }, loaded, record);
}
function loadGrantedConferenceRecoveryRecord({ analysisRoot, executionId }, loaded, record) {
    const { revisionSha256, ...body } = record.value;
    if (body.contract !== RECOVERY_WINDOW_CONTRACT || body.version !== 1 || body.executionId !== executionId
        || revisionSha256 !== stableHash(body) || body.paperId !== loaded.run.paperId
        || body.originalMemberPaperId !== body.paperId || body.sourceSnapshotSha256 !== loaded.run.sourceSnapshotSha256
        || !['normal-analysis', 'reader-only', 'scoring-and-reader'].includes(body.mode) || body.maxAttempts !== 3
        || !['failedAnalysisFileSha256', 'failedRunFileSha256', 'failedSourceFileSha256', 'failedRevisionFileSha256',
            'parentAnalysisFileSha256', 'parentRunFileSha256', 'seededAnalysisSha256', 'grantSha256', 'recoverySeedFileSha256'].every(key => /^[a-f0-9]{64}$/.test(body[key] || ''))
        || grantedRecoveryExecutionId(body.grantId, body.failedExecutionId, body.failedAnalysisFileSha256) !== executionId) {
        throw recoveryWindowError('新增会议恢复窗口身份或 SHA 不一致');
    }
    const grants = require('./conference-recovery-grant');
    const grantHandle = grants.reopenRecoveryGrantForWindow({ analysisRoot, windowRecord: record.value });
    const authority = grants.readRecoveryGrantMember(grantHandle, body.paperId);
    const failed = loadConferenceReaderRevision({ analysisRoot, executionId: body.failedExecutionId });
    assertGrantedMember(authority, failed);
    if (stableHash(body.continuation || null) !== stableHash(authority.continuation || null)) {
        throw recoveryWindowError('追加窗口没有保留同一前许可及原材料树');
    }
    if (body.mode !== grantedRecoveryMode(failed)) throw recoveryWindowError('新增会议恢复窗口模式与原失败上游范围不一致');
    if (authority.grantId !== body.grantId || authority.grantSha256 !== body.grantSha256
        || authority.expectedExecutionId !== executionId || path.resolve(authority.analysisRoot) !== path.resolve(analysisRoot)
        || authority.limits.maxRounds !== body.maxAttempts || authority.limits.readerContentResponses !== 6
        || authority.limits.readerFullResponses !== 2
        || failed.analysisFileSha256 !== body.failedAnalysisFileSha256 || failed.runFileSha256 !== body.failedRunFileSha256
        || failed.sourceFileSha256 !== body.failedSourceFileSha256
        || readJsonRecord(path.join(failed.directory, 'reader-revision.json')).sha256 !== body.failedRevisionFileSha256
        || failed.parent.run.executionId !== body.parentExecutionId || failed.parent.analysisFileSha256 !== body.parentAnalysisFileSha256
        || failed.parent.runFileSha256 !== body.parentRunFileSha256 || failed.sourceFileSha256 !== loaded.sourceFileSha256) {
        throw recoveryWindowError('新增会议恢复窗口未绑定真实原父子稿、授权或封存来源');
    }
    const seedRecord = readJsonRecord(path.join(loaded.directory, 'recovery-seed.json'));
    if (seedRecord.sha256 !== body.recoverySeedFileSha256) throw recoveryWindowError('新增会议恢复封存检查点 SHA 不一致');
    validateGrantedRecoverySeed(seedRecord, failed, authority);
    const resourcePreflight = body.mode === 'normal-analysis' ? null
        : readReaderResourcePreflight({ ...loaded, analysis: failed.analysis }, body.resourcePreflightFileSha256);
    return { ...loaded, revision: record.value, parent: failed.parent, resourcePreflight,
        recoveryWindow: { grantHandle, authority, failed } };
}
async function refreshConferenceGrantedRecovery({ analysisRoot, parentExecutionId, failedExecutionId,
    planHandle, sourceRoot, grantHandle, reusePaidCoreDiagnostics = true } = {}, overrides = {}) {
    const engine = overrides.engine || require('../analysis-engine'), deep = overrides.deep || require('../deep-analyzer');
    const failed = loadConferenceReaderRevision({ analysisRoot, executionId: failedExecutionId });
    if (failed.parent.run.executionId !== parentExecutionId || failed.analysis.status !== 'partial') {
        throw recoveryWindowError('新增会议恢复只接受授权清单的原失败子稿与原完成父稿');
    }
    const grants = require('./conference-recovery-grant'), authority = grants.readRecoveryGrantMember(grantHandle, failed.run.paperId);
    assertGrantedMember(authority, failed);
    const executionId = grantedRecoveryExecutionId(authority.grantId, failedExecutionId, failed.analysisFileSha256);
    if (authority.expectedExecutionId !== executionId || path.resolve(authority.analysisRoot) !== path.resolve(analysisRoot)
        || authority.limits.maxRounds !== 3 || authority.limits.readerContentResponses !== 6 || authority.limits.readerFullResponses !== 2) {
        throw recoveryWindowError('新增会议恢复的执行身份或获准限次不一致');
    }
    const failedPdf = verifyPlanAuthority(failed, planHandle, sourceRoot);
    const withFailedSource = callback => analysisContext.withConferenceAnalysisSource({ executionId: failedExecutionId,
        executionDir: failed.directory, paperId: failed.run.paperId, sourceDetails: failed.source.sourceDetails,
        readerPdfSourceHandle: failedPdf }, callback);
    if (failed.recoveryWindow) {
        // Authenticate the predecessor's complete independent ledger in its
        // own real source scope before preparing any new child or model work.
        // Its old counters, pending/final responses and history are never moved
        // into the new ledger or changed to grant fresh attempts.
        withFailedSource(() => require('./conference-reader-recovery-window').withConferenceReaderGrantReadOnly(
            failed.recoveryWindow.grantHandle, { executionId: failedExecutionId,
                executionDir: failed.directory, paperId: failed.run.paperId, readerPdfSourceHandle: failedPdf }, () => {}));
    }
    const mode = withFailedSource(() => grantedRecoveryMode(failed));
    // Full analysis repairs incomplete classification too. Its original rules
    // come from the CAS-bound completed parent, not the unfinished child. The
    // repaired paper still has to prove its own tags before completion below.
    const original = require('./conference-postprocess').readOriginalTagProof(
        mode === 'normal-analysis' ? failed.parent.analysis.papers[0] : failed.analysis.papers[0]);
    const oldScoring = failed.analysis.readerRevisionProgress?.scoringCheckpoint;
    if (oldScoring && stableHash(oldScoring) !== stableHash(withFailedSource(() =>
        readerScoringCheckpoint(failed.analysis.papers[0], failed, engine, original.rules)))) {
        throw recoveryWindowError('新增会议恢复不能复用失配的原评分检查点');
    }
    return engine.withPaperAnalysisLock({ id: failed.run.paperId }, async () => {
        assertGrantedMember(authority, failed);
        prepareConferenceAnalysis({ analysisRoot, executionId, planHandle, sourceRoot, paperId: failed.run.paperId });
        let loaded = loadConferenceAnalysis({ analysisRoot, executionId });
        const revisionFile = path.join(loaded.directory, 'reader-revision.json');
        const seedFile = path.join(loaded.directory, 'recovery-seed.json');
        if (!fs.existsSync(seedFile)) writeJson(seedFile,
            await prepareGrantedRecoverySeed(failed, authority, withFailedSource, deep));
        const seedRecord = readJsonRecord(seedFile);
        const seed = validateGrantedRecoverySeed(seedRecord, failed, authority);
        if (!fs.existsSync(revisionFile)) {
            if (loaded.analysis.status !== 'pending') throw recoveryWindowError('新增会议恢复缺少不可变窗口凭证');
            const seeded = { ...loaded.analysis, status: 'partial', generation: 1,
                papers: [clone(seed.paper)], readerRevisionProgress: { attempts: 0, failures: [] } };
            let resourcePreflightFileSha256;
            if (mode !== 'normal-analysis') {
                const previous = readJsonRecord(path.join(failed.directory, 'reader-resource-preflight.json'));
                resourcePreflightFileSha256 = writeBytesAtomic(path.join(loaded.directory, 'reader-resource-preflight.json'), previous.bytes);
            }
            const body = { contract: RECOVERY_WINDOW_CONTRACT, version: 1, executionId, paperId: failed.run.paperId,
                sourceSnapshotSha256: failed.run.sourceSnapshotSha256, parentExecutionId,
                parentAnalysisFileSha256: failed.parent.analysisFileSha256, parentRunFileSha256: failed.parent.runFileSha256,
                failedExecutionId, failedAnalysisFileSha256: failed.analysisFileSha256, failedRunFileSha256: failed.runFileSha256,
                failedSourceFileSha256: failed.sourceFileSha256,
                failedRevisionFileSha256: readJsonRecord(path.join(failed.directory, 'reader-revision.json')).sha256,
                grantId: authority.grantId, grantSha256: authority.grantSha256, originalMemberPaperId: failed.run.paperId,
                ...(authority.continuation ? { continuation: clone(authority.continuation) } : {}),
                mode, maxAttempts: 3, recoverySeedFileSha256: seedRecord.sha256, seededAnalysisSha256: sha256(jsonBytes(seeded)),
                ...(resourcePreflightFileSha256 ? { resourcePreflightFileSha256 } : {}) };
            writeJson(revisionFile, { ...body, revisionSha256: stableHash(body) });
        }
        loaded = loadGrantedConferenceRecovery({ analysisRoot, executionId });
        if (loaded.revision.mode !== mode) throw recoveryWindowError('新增会议恢复不能在重入时切换固定模式');
        if (loaded.analysis.status === 'pending') {
            const seeded = { ...loaded.analysis, status: 'partial', generation: 1,
                papers: [clone(seed.paper)], readerRevisionProgress: { attempts: 0, failures: [] } };
            if (sha256(jsonBytes(seeded)) !== loaded.revision.seededAnalysisSha256) throw recoveryWindowError('新增会议恢复初始失败稿 SHA 不一致');
            replaceJson(path.join(loaded.directory, 'analysis.json'), seeded, loaded.analysisFileSha256);
            loaded = loadGrantedConferenceRecovery({ analysisRoot, executionId });
        }
        if (oldScoring && mode !== 'normal-analysis' && !loaded.analysis.readerRevisionProgress.scoringCheckpoint) {
            if (loaded.analysis.readerRevisionProgress.attempts !== 0) throw recoveryWindowError('新增会议恢复评分检查点在请求后缺失');
            const sourceHandle = verifyPlanAuthority(loaded, planHandle, sourceRoot);
            const checkpoint = analysisContext.withConferenceAnalysisSource({ executionId, executionDir: loaded.directory,
                paperId: loaded.run.paperId, sourceDetails: loaded.source.sourceDetails, readerPdfSourceHandle: sourceHandle }, () =>
                readerScoringCheckpoint(loaded.analysis.papers[0], loaded, engine, original.rules));
            replaceJson(path.join(loaded.directory, 'analysis.json'), { ...loaded.analysis, generation: loaded.analysis.generation + 1,
                readerRevisionProgress: { ...loaded.analysis.readerRevisionProgress, scoringCheckpoint: checkpoint,
                    inheritedScoringCheckpoint: { executionId: failedExecutionId, checkpoint: clone(oldScoring) } } }, loaded.analysisFileSha256);
            loaded = loadGrantedConferenceRecovery({ analysisRoot, executionId });
        }
        // The immutable old seed does not cover later paid summaries in this
        // new window. Resume those through the same source-bound strict replay.
        const result = await continueConferenceRevision({ loaded, parent: failed.parent, planHandle, sourceRoot, analysisRoot,
            executionId, fullAnalysis: mode === 'normal-analysis', original, maxAttempts: 3, reusePaidCoreDiagnostics,
            grant: { grantHandle, authority } }, { ...overrides, engine, deep });
        authority.assertUnchanged(); return result;
    }, conferencePaperLockOptions(engine));
}

async function continueConferenceRevision({ loaded, parent, planHandle, sourceRoot, analysisRoot,
    executionId, fullAnalysis, original, maxAttempts, reusePaidCoreDiagnostics, grant = null }, overrides) {
    const engine = overrides.engine, deep = overrides.deep;
    let readerPdfSourceHandle;
    const assertGrantUnchanged = () => grant?.authority.assertUnchanged();
        readerPdfSourceHandle = verifyPlanAuthority(loaded, planHandle, sourceRoot);
        const withGrant = callback => grant
            ? require('./conference-reader-recovery-window').withConferenceReaderGrant(grant.grantHandle,
                { paperId: loaded.run.paperId, executionId, executionDir: loaded.directory, readerPdfSourceHandle }, callback)
            : callback();
        const withVerifiedSource = callback => {
            // Re-read real plan-bound source files before granting either scope.
            readerPdfSourceHandle = verifyPlanAuthority(loaded, planHandle, sourceRoot);
            return analysisContext.withConferenceAnalysisSource({ executionId,
                readerPdfSourceHandle, executionDir: loaded.directory, paperId: loaded.run.paperId,
                sourceDetails: loaded.source.sourceDetails }, () => withGrant(callback));
        };
        if (loaded.analysis.status === 'complete') {
            const rules = require('./conference-postprocess').readOriginalTagProof(loaded.analysis.papers[0]).rules;
            withVerifiedSource(() => {
                if (!engine.isSuccessfulAnalysisRecordForReadOnlyConferencePublication(loaded.analysis.papers[0], { tagRules: rules })) {
                    throw Object.assign(revisionQualificationError(loaded.analysis.papers[0], rules, engine,
                        '已保存会议 Reader revision 未通过完整资格'), { retryable: false });
                }
            });
            if (loaded.run.status !== 'complete') sealCompletedRun(loaded);
            return { executionId, paperId: parent.run.paperId, status: 'complete', revision: loaded.revision,
                analysisSha256: loaded.analysisFileSha256 };
        }
        const savedCompletion = await inspectLoadedReaderRevisionCompletion(loaded, { planHandle, sourceRoot }, { engine, deep });
        if (savedCompletion.eligible) {
            // Source, paid issuance, full qualification and protected upstream
            // have all replayed before any attempt increment or model request.
            const next = { ...loaded.analysis, status: 'complete', completedAt: new Date().toISOString(),
                generation: loaded.analysis.generation + 1,
                stats: { ...(loaded.analysis.stats || {}), analysisStatus: 'complete' } };
            assertGrantUnchanged();
            replaceJson(path.join(loaded.directory, 'analysis.json'), next, loaded.analysisFileSha256);
            const completed = loadConferenceReaderRevision({ analysisRoot, executionId });
            sealCompletedRun(completed);
            return { executionId, paperId: parent.run.paperId, status: 'complete', revision: loaded.revision,
                analysisSha256: completed.analysisFileSha256, recoveredSavedReader: true };
        }
        const progress = loaded.analysis.readerRevisionProgress;
        if (!progress || !Number.isSafeInteger(progress.attempts) || progress.attempts < 0
            || progress.attempts > loaded.revision.maxAttempts || !Array.isArray(progress.failures)) {
            throw Object.assign(new Error('保存的会议 Reader 修订轮次或失败历史损坏'), { retryable: false });
        }
        if (progress.attempts > 0 && loaded.revision.mode !== 'normal-analysis'
            && (loaded.revision.mode === 'reader-only' || progress.scoringCheckpoint)) {
            // Only the existing paid candidate may run in the helper's private
            // no-model scope. This does not authorize another outer attempt.
            const replay = overrides.replayActiveReaderCandidate
                || require('./conference-reader-active-candidate-replay').replayActiveConferenceReaderCandidate;
            const recovered = await withVerifiedSource(() => replay({ loaded, planHandle, sourceRoot }, { engine, deep }));
            if (recovered.eligible) {
                if (!recovered.paper || !recovered.proof
                    || typeof recovered.assertUnchanged !== 'function') throw new Error('活动付费 Reader 恢复缺少原字节证明');
                const paper = recovered.paper;
                const protectedStages = ['primaryAnalysis', 'coreSummaryRepair', 'tagSelection', 'taxonomySeal',
                    ...(loaded.revision.mode === 'reader-only' ? ['scoringAudit'] : [])];
                for (const name of protectedStages) {
                    if (stableHash(paper.analysisManifest?.stages?.[name] || null)
                        !== stableHash(parent.analysis.papers[0].analysisManifest?.stages?.[name] || null)) {
                        throw Object.assign(new Error(`活动付费 Reader 恢复改动受保护原阶段：${name}`), { retryable: false });
                    }
                }
                const rules = require('./conference-postprocess').readOriginalTagProof(paper).rules;
                withVerifiedSource(() => {
                    if (!engine.isSuccessfulAnalysisRecordForReadOnlyConferencePublication(paper, { tagRules: rules })) {
                        throw Object.assign(revisionQualificationError(paper, rules, engine,
                            '活动付费 Reader 恢复未通过正常整篇资格'), { retryable: false });
                    }
                    if (progress.scoringCheckpoint
                        && stableHash(progress.scoringCheckpoint) !== stableHash(readerScoringCheckpoint(paper, loaded, engine, rules))) {
                        throw Object.assign(new Error('活动付费 Reader 恢复改变已完成评分检查点'), { retryable: false });
                    }
                });
                recovered.assertUnchanged();
                const unchanged = loadConferenceReaderRevision({ analysisRoot, executionId });
                if (unchanged.analysisFileSha256 !== loaded.analysisFileSha256
                    || unchanged.runFileSha256 !== loaded.runFileSha256
                    || unchanged.sourceFileSha256 !== loaded.sourceFileSha256) throw new Error('活动付费 Reader 恢复保存前原子稿或来源改变');
                const next = { ...loaded.analysis, papers: [paper], status: 'complete', completedAt: new Date().toISOString(),
                    generation: loaded.analysis.generation + 1, readerRevisionRecovery: clone(recovered.proof),
                    stats: { ...(loaded.analysis.stats || {}), analysisStatus: 'complete' } };
                assertGrantUnchanged();
                replaceJson(path.join(loaded.directory, 'analysis.json'), next, loaded.analysisFileSha256);
                const completed = loadConferenceReaderRevision({ analysisRoot, executionId });
                sealCompletedRun(completed);
                return { executionId, paperId: parent.run.paperId, status: 'complete', revision: loaded.revision,
                    analysisSha256: completed.analysisFileSha256, recoveredActivePaidReader: true };
            }
        }
        if (fullAnalysis && loaded.revision.mode !== 'normal-analysis') {
            // An existing fixed Reader mode cannot repair a newly rejected
            // core or old Unicode input. Preserve its paid history and mode;
            // pending scoring remains the scoring-and-reader mode's job.
            withVerifiedSource(() => {
                const savedPaper = loaded.analysis.papers[0];
                const source = analysisContext.getConferenceAnalysisSource(savedPaper);
                const sourceText = source?.text;
                let reason;
                if (typeof sourceText !== 'string'
                    || sha256(sourceText) !== savedPaper.sourceSha256
                    || savedPaper.analysisManifest?.sourceAcquisition?.sourceSha256 !== savedPaper.sourceSha256) {
                    reason = '子稿与认证封存全文的 SHA 不一致。';
                } else {
                    reason = require('../analysis-contract').validateCoreSummarySemanticContract(
                        savedPaper.analysis, { sourceText });
                    if (!reason && !require('./model-text-sanitization').canReuseModelTextInputs(savedPaper, source)) {
                        reason = '旧 Unicode 模型输入需要完整重新分析。';
                    }
                }
                if (reason) throw Object.assign(new Error(`会议原固定 Reader 修订模式无权修复当前上游：${reason}`), {
                    code: 'CONFERENCE_READER_REVISION_UPSTREAM_REQUIRES_ANALYSIS',
                    category: 'integrity', scope: 'paper', retryable: false, executionId
                });
            });
        }
        // A fully authenticated retired latest paid draft is a local-tail case,
        // not permission to reset its candidate counter or a run-level fee fault.
        // Missing/invalid provenance still raises the original integrity error.
        if (grant && loaded.revision.mode === 'reader-only'
            && path.resolve(analysisRoot) === path.resolve(require('../config').FILES.conferenceAnalysisDir)) {
            const retired = require('./conference-reader-resolved-origin');
            const origin = withVerifiedSource(() => retired.inspectLatestResolvedPaidReader({
                analysisRoot, executionId, planHandle, sourceRoot
            }));
            if (origin) retired.assertDeferredLocalCorrection(origin);
        }
        if (progress.attempts >= maxAttempts) throw Object.assign(new Error('会议 Reader revision 原付费预算已耗尽'),
            { code: 'CONFERENCE_READER_REVISION_BUDGET_EXHAUSTED', retryable: false });
        let paper = clone(loaded.analysis.papers[0]);
        const savedScoring = progress.scoringCheckpoint;
        if (savedScoring && (loaded.revision.mode !== 'scoring-and-reader'
            || stableHash(savedScoring) !== stableHash(withVerifiedSource(() =>
                readerScoringCheckpoint(paper, loaded, engine, original.rules))))) {
            throw Object.assign(new Error('会议新评分检查点的资源、正文或原修订 SHA 改变'), { retryable: false });
        }
        if (loaded.revision.mode === 'scoring-and-reader' && !savedScoring
            && progress.failures.length > 0) {
            // A failed refresh may still carry its parent's complete audit.
            // Only this revision's saved scoring checkpoint can prove the new
            // scoring finished. Even a transport failure can follow already
            // rejected content; without its durable consumption record an outer
            // retry cannot assume that all three content attempts remain.
            throw Object.assign(new Error('会议新评分未完成且已保存失败，缺少可重放的新评分消费记录，不能用旧评分或外层余额重新请求评分'), {
                code: 'CONFERENCE_READER_REVISION_SCORING_RECOVERY_BLOCKED',
                category: 'integrity', scope: 'paper', retryable: false, executionId
            });
        }
        const stageRequests = require('./analysis-stage-request-guard');
        const retainedBlockedStages = Object.hasOwn(progress, 'blockedAuxiliaryModelStages')
            ? progress.blockedAuxiliaryModelStages : [];
        if (!Array.isArray(retainedBlockedStages)
            || retainedBlockedStages.some(name => !stageRequests.AUXILIARY_STAGES.includes(name))
            || new Set(retainedBlockedStages).size !== retainedBlockedStages.length
            || (progress.attempts === 0 || loaded.revision.mode !== 'normal-analysis') && retainedBlockedStages.length) {
            throw Object.assign(new Error('会议原失败阶段的请求禁令记录无效'), { retryable: false });
        }
        const failedStages = loaded.revision.mode === 'normal-analysis' && progress.attempts > 0
            ? [...new Set([...retainedBlockedStages,
                ...stageRequests.failedAuxiliaryStages(loaded.analysis.papers[0].analysisManifest)])].sort() : [];
        if (loaded.resourcePreflight && !savedScoring) paper.apiReaderResources = clone(loaded.resourcePreflight);
        let current = { ...loaded.analysis, generation: loaded.analysis.generation + 1,
            readerRevisionProgress: { ...progress, attempts: progress.attempts + 1,
                ...(loaded.revision.mode === 'normal-analysis' ? { blockedAuxiliaryModelStages: failedStages } : {}) } };
        const analysisFile = path.join(loaded.directory, 'analysis.json');
        replaceJson(analysisFile, current, loaded.analysisFileSha256);
        try {
            paper = await analysisContext.withConferenceAnalysisSource({ executionId, executionDir: loaded.directory,
                readerPdfSourceHandle, paperId: parent.run.paperId, sourceDetails: loaded.source.sourceDetails, readerRetryEpoch: 1 }, () => withGrant(() =>
                loaded.revision.mode === 'normal-analysis'
                    ? withNormalAnalysisSlot(async () => {
                        const reuseCore = reusePaidCoreDiagnostics === true && progress.attempts > 0
                            && paper.analysisManifest?.stages?.coreSummaryRepair?.status === 'contract_rejected';
                        const outcome = await stageRequests.withStageModelRequestsForbidden(failedStages,
                            () => engine.analyzePaperWithRetry(paper, { maxRetries: 0,
                        ...(reuseCore ? { analyzeFn: current => deep.analyzePaperDeep(current,
                            { replayLatestCoreSummaryDiagnostic: true }) } : {}),
                        onCheckpoint: checkpoint => {
                            const saved = readJsonRecord(analysisFile);
                            replaceJson(analysisFile, { ...saved.value, papers: [checkpoint],
                                generation: saved.value.generation + 1 }, saved.sha256);
                        } }));
                            if (!outcome.success) {
                                paper = outcome.result || paper;
                                const error = Object.assign(new Error(String(outcome.error || '会议正常分析恢复失败')), {
                                    code: outcome.code || paper.latestAnalysisAttemptErrorCode,
                                    scope: outcome.scope || paper.latestAnalysisAttemptErrorScope || paper.errorScope,
                                    retryable: outcome.retryable ?? paper.latestAnalysisAttemptRetryable,
                                    category: outcome.category || paper.latestAnalysisAttemptErrorCategory || paper.errorCategory,
                                    status: outcome.status || paper.latestAnalysisAttemptErrorStatus || paper.errorStatus });
                                if (require('./conference-process-recovery').classifyFailure(error,
                                    new Date().toISOString()).systemic) {
                                    require('./analysis-stop-control').requestAnalysisStop(error.code || 'service_failure');
                                }
                                throw error;
                            }
                            return outcome.result;
                        })
                    : loaded.revision.mode === 'scoring-and-reader' && !savedScoring
                        ? deep.refreshApiScoringAndReaderFromSource(paper, loaded.source.sourceDetails, {
                            onScoringComplete: async scored => {
                                for (const name of ['primaryAnalysis', 'coreSummaryRepair', 'tagSelection', 'taxonomySeal']) {
                                    if (stableHash(scored.analysisManifest?.stages?.[name] || null)
                                        !== stableHash(parent.analysis.papers[0].analysisManifest?.stages?.[name] || null)) {
                                        throw Object.assign(new Error(`评分刷新改动受保护原阶段：${name}`), { retryable: false });
                                    }
                                }
                                const checkpoint = readerScoringCheckpoint(scored, loaded, engine, original.rules);
                                const saved = readJsonRecord(analysisFile);
                                replaceJson(analysisFile, { ...saved.value, papers: [scored], generation: saved.value.generation + 1,
                                    readerRevisionProgress: { ...saved.value.readerRevisionProgress,
                                        scoringCheckpoint: checkpoint } }, saved.sha256);
                            }
                        })
                        : deep.refreshApiReaderArticleFromSource(paper, loaded.source.sourceDetails,
                            { resumeSavedSourceReader: true })));
            // Core and classification may never be rewritten by a Reader revision.
            for (const name of ['primaryAnalysis', 'coreSummaryRepair', 'tagSelection', 'taxonomySeal']) {
                if (loaded.revision.mode !== 'normal-analysis' && stableHash(paper.analysisManifest?.stages?.[name] || null)
                    !== stableHash(parent.analysis.papers[0].analysisManifest?.stages?.[name] || null)) {
                    throw Object.assign(new Error(`Reader revision 改动了受保护原阶段：${name}`), { retryable: false });
                }
            }
            const rules = require('./conference-postprocess').readOriginalTagProof(paper).rules;
            withVerifiedSource(() => {
                if (!engine.isSuccessfulAnalysisRecordForReadOnlyConferencePublication(paper, { tagRules: rules })) {
                    throw revisionQualificationError(paper, rules, engine, '会议 Reader revision 未通过正常整篇资格');
                }
            });
            current = readJsonRecord(analysisFile);
            const next = { ...current.value, papers: [paper], status: 'complete', completedAt: new Date().toISOString(),
                generation: current.value.generation + 1, stats: { ...(current.value.stats || {}), analysisStatus: 'complete' } };
            assertGrantUnchanged();
            replaceJson(analysisFile, next, current.sha256);
            const completed = loadConferenceReaderRevision({ analysisRoot, executionId });
            // Consume the paid candidate only after its exact canonical bytes
            // have survived the locked CAS, as in the ordinary batch saver.
            if (typeof deep.commitDeferredReaderCandidateIfSaved === 'function') {
                deep.commitDeferredReaderCandidateIfSaved(paper, completed.analysis.papers[0]);
            }
            sealCompletedRun(completed);
            return { executionId, paperId: parent.run.paperId, status: 'complete', revision: loaded.revision,
                analysisSha256: completed.analysisFileSha256 };
        } catch (error) {
            if (require('./conference-process-recovery').classifyFailure(error, new Date().toISOString()).systemic) {
                require('./analysis-stop-control').requestAnalysisStop(error.code || 'service_failure');
            }
            current = readJsonRecord(analysisFile);
            if (current.value.status !== 'complete') {
                const failure = require('./conference-process-recovery').classifyFailure(error, new Date().toISOString());
                replaceJson(analysisFile, { ...current.value, status: 'partial', papers: [paper],
                    generation: current.value.generation + 1,
                    readerRevisionProgress: { ...current.value.readerRevisionProgress,
                        failures: [...current.value.readerRevisionProgress.failures, failure] } }, current.sha256);
            }
            error.executionId = executionId; throw error;
        }

}

module.exports = { RUN_CONTRACT, ANALYSIS_CONTRACT, SOURCE_CONTRACT, PREPARE_INTENT_CONTRACT, VERSION, UUID_RE,
    stableHash, normalizedPaper, sourceDetails, validatePersistedSourceDetails,
    readJsonRecord, writeBytesAtomic, replaceJson, prepareArtifacts, prepareConferenceAnalysis, loadConferenceAnalysis, verifyPlanAuthority,
    sealCompletedRun, sealCompletedRunLocked, analyzeConference,
    READER_REVISION_CONTRACT, RECOVERY_WINDOW_CONTRACT, readerRevisionExecutionId, loadConferenceReaderRevision,
    grantedRecoveryExecutionId, loadGrantedConferenceRecovery, refreshConferenceGrantedRecovery,
    inspectConferenceReaderRevisionCompletion, refreshConferenceReader };
