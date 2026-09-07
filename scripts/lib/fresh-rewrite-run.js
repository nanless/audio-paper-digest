'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const RUN_CONTRACT = 'fresh-rewrite-run-v1';
const INPUT_CONTRACT = 'fresh-rewrite-inputs-v1';
const ANALYSIS_CONTRACT = 'fresh-rewrite-analysis-v1';
const FRESHNESS_CONTRACT = 'fresh-source-analysis-v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const SEALED_RECOVERY_CAPABILITIES = new WeakMap();
const ORIGINAL_METADATA_FIELDS = Object.freeze([
    'arxivId', 'paper_id', 'title', 'authors', 'categories', 'abstract', 'source', 'sources', 'fetchedAt'
]);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
function stableHash(value) {
    const normalize = item => Array.isArray(item) ? item.map(normalize)
        : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])])) : item;
    return sha256(JSON.stringify(normalize(value)));
}

function mintSealedRecoveryCapabilities(loaded, selectedIds, sourceRecords) {
    const analysisFileSha256 = loaded.analysisFileSha256;
    if (loaded.run.status !== 'complete' || loaded.analysis.status !== 'complete'
        || loaded.run.analysisSha256 !== analysisFileSha256) return new Map();
    const capabilities = new Map();
    for (const paper of loaded.analysis.papers) {
        const id = paperId(paper);
        if (!selectedIds.includes(id)) continue;
        const descriptor = sourceRecords[id];
        assertFreshProvenance(paper, loaded.run, descriptor);
        const handle = Object.freeze(Object.create(null));
        SEALED_RECOVERY_CAPABILITIES.set(handle, {
            runId: loaded.run.runId,
            paperId: id,
            recordSha256: stableHash(paper),
            analysisFileSha256,
            sourceSha256: descriptor.sourceSha256,
            structuredArtifactsSha256: descriptor.structuredArtifactsSha256,
            sourceSnapshotSha256: descriptor.sourceSnapshotSha256,
            consumed: false
        });
        capabilities.set(id, handle);
    }
    return capabilities;
}

function sealedRecoveryCapabilitySnapshot(handle, options = {}) {
    const state = handle && SEALED_RECOVERY_CAPABILITIES.get(handle);
    if (!state || state.consumed && options.allowConsumed !== true) return null;
    const { consumed, ...snapshot } = state;
    return { ...snapshot, consumed };
}

function consumeSealedRecoveryCapability(handle, expected = {}) {
    const state = handle && SEALED_RECOVERY_CAPABILITIES.get(handle);
    if (!state || state.consumed) return false;
    for (const [field, value] of Object.entries(expected)) {
        if (state[field] !== value) return false;
    }
    state.consumed = true;
    return true;
}

function paperId(paper) {
    const value = typeof paper === 'string' ? paper : paper?.arxivId || paper?.paper_id || paper?.id;
    const match = String(value || '').match(/^(\d{4}\.\d{4,5})(?:v\d+)?$/);
    if (!match) throw new Error('Fresh rewrite requires a normalized modern arXiv paper ID');
    return match[1];
}

function validDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
        && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
        && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function validateAnalysisIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length
        || ids.some(id => typeof id !== 'string' || !/^\d{4}\.\d{4,5}$/.test(id))) {
        throw new Error('--ids requires a non-empty, duplicate-free list of normalized arXiv IDs');
    }
    return ids;
}

function parseRewriteArgs(args) {
    const action = args[0];
    if (!['prepare', 'sources', 'analyze', 'status', 'promote', 'patch', 'signed-patch'].includes(action)) {
        throw new Error('Use prepare --date DATE, sources|analyze|status|promote --run-id UUID, or patch --run-id UUID --patch NAME.json');
    }
    const options = { action };
    const seen = new Set();
    for (let index = 1; index < args.length; index++) {
        const flag = args[index];
        if (!['--date', '--run-id', '--concurrency', '--refresh-reader-diagnostics', '--patch', '--ids'].includes(flag) || seen.has(flag)) {
            throw new Error(`Unknown or repeated fresh rewrite argument: ${flag}`);
        }
        seen.add(flag);
        if (flag === '--refresh-reader-diagnostics') {
            if (action !== 'analyze') throw new Error('Only analyze accepts --refresh-reader-diagnostics');
            options.refreshReaderDiagnostics = true;
            continue;
        }
        const value = args[++index];
        if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
        if (flag === '--date') options.date = value;
        else if (flag === '--run-id') options.runId = value;
        else if (flag === '--patch') options.patchFile = value;
        else if (flag === '--ids') {
            if (action !== 'analyze') throw new Error('Only analyze accepts --ids');
            options.ids = validateAnalysisIds(value.split(','));
        }
        else {
            if (!/^[1-5]$/.test(value)) throw new Error('--concurrency must be an integer from 1 to 5');
            options.concurrency = Number(value);
        }
    }
    if (action === 'prepare') {
        if (!validDate(options.date) || options.runId || options.concurrency) throw new Error('prepare only accepts --date YYYY-MM-DD');
    } else {
        if (!UUID_RE.test(options.runId || '') || options.date) throw new Error(`${action} requires --run-id UUID and cannot change the date`);
        if (options.concurrency && !['sources', 'analyze'].includes(action)) throw new Error(`${action} does not accept --concurrency`);
    }
    if (['patch', 'signed-patch'].includes(action)) {
        require('./reader-operator-patch.js').patchPath('/unused-run', options.patchFile);
    } else if (options.patchFile) throw new Error('Only patch or signed-patch accepts --patch');
    return options;
}

function assertSafeDirectory(directory, create = false) {
    if (!path.isAbsolute(directory)) throw new Error('Fresh rewrite root must be absolute');
    const absolute = path.resolve(directory);
    let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        let stat;
        try { stat = fs.lstatSync(cursor); }
        catch (error) {
            if (error.code !== 'ENOENT' || !create) throw error;
            fs.mkdirSync(cursor, { mode: 0o700 });
            stat = fs.lstatSync(cursor);
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe fresh rewrite directory: ${cursor}`);
    }
    return absolute;
}

function runDirectory(rootDir, runId) {
    if (!UUID_RE.test(runId || '')) throw new Error('Invalid fresh rewrite run ID');
    return path.join(path.resolve(rootDir), runId);
}

function readRegularJson(filename) {
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) throw new Error(`Unsafe fresh rewrite file: ${filename}`);
        const bytes = fs.readFileSync(fd);
        return { value: JSON.parse(bytes.toString('utf8')), sha256: sha256(bytes) };
    } finally { fs.closeSync(fd); }
}

function writeImmutableJson(filename, value) {
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    return sha256(bytes);
}
function metadataOnly(paper) {
    const id = paperId(paper);
    if (typeof paper.title !== 'string' || !paper.title.trim()
        || typeof paper.abstract !== 'string' || !paper.abstract.trim()) {
        throw new Error(`${id} requires original title and abstract in raw candidates`);
    }
    const clean = { arxivId: id, paper_id: id };
    for (const key of ORIGINAL_METADATA_FIELDS.filter(key => !['arxivId', 'paper_id'].includes(key))) {
        const value = paper[key];
        if (value === undefined) continue;
        if (typeof value === 'string') clean[key] = value;
        else if (['authors', 'categories', 'sources'].includes(key) && Array.isArray(value)
            && value.every(item => typeof item === 'string')) clean[key] = value.slice();
        else throw new Error(`${id} original metadata field ${key} is malformed`);
    }
    return clean;
}

function sortedIds(papers) {
    if (!Array.isArray(papers) || papers.length === 0) throw new Error('Fresh rewrite paper set must be non-empty');
    const ids = papers.map(paperId);
    if (new Set(ids).size !== ids.length) throw new Error('Fresh rewrite paper set contains duplicate IDs');
    return ids.sort();
}

function identityHash(run) {
    return stableHash({ version: run.version, contract: run.contract, runId: run.runId, date: run.date,
        paperIds: run.paperIds, paperSetSha256: run.paperSetSha256, inputsSha256: run.inputsSha256,
        baseline: run.baseline, sourceExpectations: run.sourceExpectations, metadataSources: run.metadataSources });
}

function dependencies(overrides = {}) {
    const Config = require('../config.js');
    const engine = require('../analysis-engine.js');
    return {
        rootDir: Config.FILES.freshRewriteRunsDir, files: Config.FILES,
        defaultAnalysisConcurrency: Config.ANALYSIS_CONFIG.concurrency,
        maxRetries: Config.ANALYSIS_CONFIG.maxRetries,
        readFreshSource: (...args) => require('./fresh-analysis-context.js').readFreshSource(...args),
        resolveFreshSource: (...args) => require('./fresh-analysis-context.js').resolveFreshSource(...args),
        withFreshAnalysisContext: (...args) => require('./fresh-analysis-context.js').withFreshAnalysisContext(...args),
        prepareBaseline: (...args) => require('./fresh-rewrite-publication.js').prepareBaseline(...args),
        promoteRun: (...args) => require('./fresh-rewrite-publication.js').promoteRun(...args),
        validateData: files => require('../validate-data-files.js').validateCurrentDataFiles(files),
        analyzeBatch: engine.analyzeBatch, updateJsonFileLocked: engine.updateJsonFileLocked,
        mergePapersById: engine.mergePapersById, isSuccessfulAnalysisRecord: engine.isSuccessfulAnalysisRecord,
        withFileLock: engine.withFileLock,
        now: () => new Date().toISOString(), uuid: () => crypto.randomUUID(), ...overrides
    };
}

function assertSourceExpectations(expectations, ids) {
    if (!expectations || stableHash(Object.keys(expectations).sort()) !== stableHash(ids)) {
        throw new Error('Fresh rewrite source expectations do not cover the exact paper set');
    }
    for (const id of ids) {
        if (!SHA_RE.test(expectations[id]?.sourceSha256 || '') || !SHA_RE.test(expectations[id]?.structuredArtifactsSha256 || '')) {
            throw new Error(`${id} lacks verified source/artifact SHA for a fresh rewrite`);
        }
    }
}

function assertAnalysisEnvelope(analysis, run, inputs) {
    if (!analysis || analysis.contract !== ANALYSIS_CONTRACT || analysis.runId !== run.runId
        || analysis.batchDate !== run.date || stableHash(sortedIds(analysis.papers)) !== run.paperSetSha256) {
        throw new Error('Fresh rewrite analysis envelope has a different run/date/paper set');
    }
    const originals = new Map(inputs.papers.map(paper => [paperId(paper), paper]));
    for (const paper of analysis.papers) {
        const id = paperId(paper);
        if (stableHash(metadataOnly(paper)) !== stableHash(originals.get(id))) throw new Error(`${id} original metadata drifted inside fresh rewrite`);
        const hasGeneratedText = Boolean(paper.analysis || paper.analysisCheckpoint || paper.apiReaderArticle || paper.apiReaderPlan
            || Object.values(paper.analysisStageCheckpoints || {}).some(Boolean));
        if (hasGeneratedText) assertFreshProvenance(paper, run);
    }
}

function assertFreshProvenance(paper, run, descriptor = null) {
    const id = paperId(paper);
    const provenance = paper.freshRewriteProvenance;
    const expected = run.sourceExpectations[id];
    if (!provenance || provenance.contract !== FRESHNESS_CONTRACT || provenance.runId !== run.runId
        || provenance.sourceOnly !== true || provenance.oldGeneratedTextIncluded !== false
        || provenance.sourceSha256 !== expected.sourceSha256
        || provenance.structuredArtifactsSha256 !== expected.structuredArtifactsSha256
        || !SHA_RE.test(provenance.sourceSnapshotSha256 || '')
        || stableHash(paper.analysisManifest?.freshRewriteProvenance || null) !== stableHash(provenance)
        || (descriptor && provenance.sourceSnapshotSha256 !== descriptor.sourceSnapshotSha256)) {
        throw new Error(`${id} generated text is not bound to this fresh run and source snapshot`);
    }
    return true;
}

function loadRun(runId, deps) {
    assertSafeDirectory(deps.rootDir);
    const runDir = assertSafeDirectory(runDirectory(deps.rootDir, runId));
    const run = readRegularJson(path.join(runDir, 'run.json')).value;
    if (run?.version !== 1 || run.contract !== RUN_CONTRACT || run.runId !== runId || !validDate(run.date)
        || !Array.isArray(run.paperIds) || stableHash(sortedIds(run.paperIds)) !== run.paperSetSha256
        || run.identitySha256 !== identityHash(run)) throw new Error('Fresh rewrite run identity is invalid or drifted');
    assertSourceExpectations(run.sourceExpectations, run.paperIds);
    const inputFile = readRegularJson(path.join(runDir, 'inputs.json'));
    const inputs = inputFile.value;
    if (inputFile.sha256 !== run.inputsSha256 || inputs?.contract !== INPUT_CONTRACT || inputs.runId !== runId
        || inputs.date !== run.date || stableHash(sortedIds(inputs.papers)) !== run.paperSetSha256) {
        throw new Error('Fresh rewrite original input bytes or identity changed');
    }
    for (const paper of inputs.papers) {
        if (Object.keys(paper).some(key => !ORIGINAL_METADATA_FIELDS.includes(key))) throw new Error('Fresh rewrite inputs contain non-original fields');
        metadataOnly(paper);
    }
    const analysisFile = readRegularJson(path.join(runDir, 'analysis.json'));
    const analysis = analysisFile.value;
    assertAnalysisEnvelope(analysis, run, inputs);
    return { runDir, run, inputs, analysis, analysisFileSha256: analysisFile.sha256 };
}

async function prepareRewrite(options, overrides = {}) {
    if (!validDate(options.date)) throw new Error('Fresh rewrite prepare requires a valid date');
    const deps = dependencies(overrides);
    const issues = deps.validateData(deps.files);
    if (issues.length) throw new Error(`Current data must pass read-only validation before prepare: ${issues.join('; ')}`);
    const filteredFile = readRegularJson(deps.files.filteredPapers);
    const rawFile = readRegularJson(deps.files.rawCandidates);
    const canonicalFile = readRegularJson(deps.files.deepAnalysisResult);
    const filtered = filteredFile.value;
    const raw = rawFile.value;
    const canonical = canonicalFile.value;
    if (filtered?.status !== 'complete' || filtered.batchDate !== options.date || raw?.batchDate !== options.date
        || canonical?.batchDate !== options.date) throw new Error('Fresh rewrite date does not match raw/filtered/canonical batch');
    const ids = sortedIds(filtered.papers);
    if (stableHash(sortedIds(canonical.papers)) !== stableHash(ids)) throw new Error('Fresh rewrite canonical and filtered sets differ');
    sortedIds(raw.papers);
    const rawById = new Map(raw.papers.map(paper => [paperId(paper), paper]));
    const papers = ids.map(id => {
        if (!rawById.has(id)) throw new Error(`${id} selected paper is absent from original raw candidates`);
        return metadataOnly(rawById.get(id));
    });
    const runId = deps.uuid();
    assertSafeDirectory(deps.rootDir, true);
    const runDir = runDirectory(deps.rootDir, runId);
    fs.mkdirSync(runDir, { mode: 0o700 });
    try {
        const baseline = await deps.prepareBaseline({ runDir, date: options.date, paperIds: ids });
        if (baseline.canonicalSha256 !== canonicalFile.sha256
            || readRegularJson(deps.files.deepAnalysisResult).sha256 !== canonicalFile.sha256
            || readRegularJson(deps.files.filteredPapers).sha256 !== filteredFile.sha256
            || readRegularJson(deps.files.rawCandidates).sha256 !== rawFile.sha256) {
            throw new Error('Original raw/filtered/canonical bytes changed while preparing the fresh baseline');
        }
        assertSourceExpectations(baseline.sourceExpectations, ids);
        const inputs = { version: 1, contract: INPUT_CONTRACT, runId, date: options.date, papers };
        const inputsSha256 = writeImmutableJson(path.join(runDir, 'inputs.json'), inputs);
        writeImmutableJson(path.join(runDir, 'analysis.json'), { version: 1, contract: ANALYSIS_CONTRACT,
            runId, batchDate: options.date, status: 'pending', generation: 0, papers });
        const run = { version: 1, contract: RUN_CONTRACT, freshnessContract: FRESHNESS_CONTRACT,
            runId, date: options.date, createdAt: deps.now(), paperIds: ids, paperSetSha256: stableHash(ids),
            inputsSha256, baseline, sourceExpectations: baseline.sourceExpectations, status: 'prepared', generation: 0,
            diagnostics: { analysisInvocations: 0, outerAnalysisEntries: {} } };
        run.metadataSources = { rawCandidatesSha256: rawFile.sha256, filteredPapersSha256: filteredFile.sha256 };
        run.identitySha256 = identityHash(run);
        writeImmutableJson(path.join(runDir, 'run.json'), run);
        return { runId, date: run.date, status: run.status, paperCount: ids.length, runDir };
    } catch (error) {
        throw new Error(`Fresh rewrite prepare failed; isolated directory retained for inspection: ${runDir}: ${error.message}`, { cause: error });
    }
}

function sourceState(loaded, deps) {
    const records = {};
    const missing = [];
    for (const paper of loaded.inputs.papers) {
        const id = paperId(paper);
        const details = deps.readFreshSource(loaded.runDir, paper, loaded.run);
        if (!details) {
            if (loaded.run.sourceRecords?.[id]) throw new Error(`${id} accepted source cache is missing; refusing an implicit replacement fetch`);
            missing.push(id); continue;
        }
        const descriptor = details.freshSourceDescriptor;
        if (!descriptor || !SHA_RE.test(descriptor.sourceSnapshotSha256 || '')) throw new Error(`${id} source cache lacks a verified snapshot descriptor`);
        if (loaded.run.sourceRecords?.[id] && stableHash(loaded.run.sourceRecords[id]) !== stableHash(descriptor)) {
            throw new Error(`${id} source cache changed after being accepted into the fresh run`);
        }
        records[id] = descriptor;
    }
    return { records, missing };
}

function updateRun(loaded, changes, deps) {
    return deps.updateJsonFileLocked(path.join(loaded.runDir, 'run.json'), current => {
        if (current.identitySha256 !== loaded.run.identitySha256 || identityHash(current) !== current.identitySha256) {
            throw new Error('Fresh run identity changed while a phase was active');
        }
        return { ...current, ...(typeof changes === 'function' ? changes(current) : changes), updatedAt: deps.now() };
    });
}

async function withRunOperation(runId, deps, callback) {
    const initial = loadRun(runId, deps);
    return deps.withFileLock(path.join(initial.runDir, '.operation'), async () => {
        const loaded = loadRun(runId, deps);
        return callback(loaded);
    });
}

async function collectRewriteSources(options, overrides = {}) {
    const deps = dependencies(overrides);
    return withRunOperation(options.runId, deps, async loaded => {
        if (loaded.run.status === 'promoted') throw new Error('Promoted fresh run is immutable');
        const existing = sourceState(loaded, deps);
        if (existing.missing.length === 0) {
            const status = loaded.run.analysisStartedAt ? loaded.run.status : 'sources_ready';
            updateRun(loaded, { status, sourceRecords: existing.records, sourceFailures: [] }, deps);
            return { runId: loaded.run.runId, status, complete: loaded.run.paperIds.length,
                total: loaded.run.paperIds.length, failures: [], exitCode: 0 };
        }
        const byId = new Map(loaded.inputs.papers.map(paper => [paperId(paper), paper]));
        const records = { ...existing.records };
        const failures = [];
        updateRun(loaded, { status: 'sourcing' }, deps);
        let cursor = 0;
        const worker = async () => {
            while (cursor < existing.missing.length) {
                const id = existing.missing[cursor++];
                try {
                    const details = await deps.resolveFreshSource(loaded.runDir, byId.get(id), loaded.run);
                    if (!SHA_RE.test(details?.freshSourceDescriptor?.sourceSnapshotSha256 || '')) throw new Error('Source resolver returned no verified descriptor');
                    records[id] = details.freshSourceDescriptor;
                    updateRun(loaded, { sourceRecords: { ...records } }, deps);
                } catch (error) { failures.push({ paperId: id, error: String(error.message).slice(0, 1000) }); }
            }
        };
        await Promise.all(Array.from({ length: Math.min(options.concurrency || 1, existing.missing.length) }, worker));
        const status = failures.length ? 'sources_partial' : 'sources_ready';
        updateRun(loaded, { status, sourceRecords: records, sourceFailures: failures }, deps);
        return { runId: loaded.run.runId, status, complete: Object.keys(records).length,
            total: loaded.run.paperIds.length, failures, exitCode: failures.length ? 1 : 0 };
    });
}

async function analyzeRewrite(options, overrides = {}) {
    // `overrides` is an internal trusted test seam, never CLI/JSON input.  An
    // opaque production recovery capability must be rooted in the complete
    // default dependency chain; replacing even one dependency disables minting.
    const productionCapabilityPath = Object.keys(overrides).length === 0;
    const deps = dependencies(overrides);
    return withRunOperation(options.runId, deps, async loaded => {
        if (loaded.run.status === 'promoted') throw new Error('Promoted fresh run is immutable');
        const selectedIds = options.ids === undefined ? loaded.run.paperIds.slice() : validateAnalysisIds(options.ids).slice();
        if (selectedIds.some(id => !loaded.run.paperIds.includes(id))) {
            throw new Error('--ids contains a paper outside the fixed fresh run paper set');
        }
        const selectedSet = new Set(selectedIds);
        const selectedPapers = loaded.analysis.papers.filter(paper => selectedSet.has(paperId(paper)));
        const sources = sourceState(loaded, deps);
        if (sources.missing.length) throw new Error(`Run sources phase first; missing ${sources.missing.length} verified sources`);
        const sealedRecoveryCapabilities = productionCapabilityPath
            ? mintSealedRecoveryCapabilities(loaded, selectedIds, sources.records)
            : new Map();
        const analysisPath = path.join(loaded.runDir, 'analysis.json');
        const complete = paper => {
            if (!deps.isSuccessfulAnalysisRecord(paper)) return false;
            assertFreshProvenance(paper, loaded.run, sources.records[paperId(paper)]);
            return true;
        };
        let fatal = null;
        try {
            await deps.withFreshAnalysisContext({ runId: loaded.run.runId, runDir: loaded.runDir,
                sourceExpectations: loaded.run.sourceExpectations,
                sealedRecoveryCapabilities,
                refreshReaderDiagnostics: options.refreshReaderDiagnostics === true
            }, () => {
                updateRun(loaded, current => ({ status: 'analyzing',
                    analysisStartedAt: current.analysisStartedAt || deps.now(),
                    diagnostics: { ...(current.diagnostics || {}),
                        analysisInvocations: (current.diagnostics?.analysisInvocations || 0) + 1 } }), deps);
                return deps.analyzeBatch(selectedPapers, {
                concurrency: options.concurrency || deps.defaultAnalysisConcurrency,
                maxRetries: deps.maxRetries, checkpointFilePath: analysisPath, saveInterval: 0,
                onAttempt: (attempt, maxRetries, paper) => {
                    // This is audit telemetry, not a new content/transport
                    // budget. Engine retry semantics remain unchanged.
                    try {
                        updateRun(loaded, current => {
                            const id = paperId(paper);
                            const entries = current.diagnostics?.outerAnalysisEntries || {};
                            const previous = entries[id] || { count: 0 };
                            if (!Number.isSafeInteger(previous.count) || previous.count < 0
                                || previous.count >= Number.MAX_SAFE_INTEGER) throw new Error('Outer-attempt diagnostic count is invalid');
                            return { diagnostics: { ...(current.diagnostics || {}), outerAnalysisEntries: {
                                ...entries, [id]: { count: previous.count + 1, firstAt: previous.firstAt || deps.now(),
                                    lastAt: deps.now(), lastInvocationAttempt: attempt + 1, maxRetriesPerInvocation: maxRetries }
                            } } };
                        }, deps);
                    } catch (error) {
                        console.error(`[fresh-rewrite] Outer-attempt diagnostic unavailable for ${paperId(paper)}: ${error.message}`);
                    }
                },
                preparePaperLocked: paper => {
                    const current = readRegularJson(analysisPath).value;
                    assertAnalysisEnvelope(current, loaded.run, loaded.inputs);
                    const latest = current.papers.find(item => paperId(item) === paperId(paper));
                    if (!latest) throw new Error('Fresh run paper disappeared while waiting for its analysis lock');
                    return { paper: { ...latest }, skip: complete(latest) };
                },
                onPaperResultLocked: async (paper, result) => {
                    const attempted = result.result || { ...paper, analysis: null, parsed: null, error: result.error || 'Fresh analysis failed' };
                    if (attempted.analysis || attempted.analysisCheckpoint || attempted.apiReaderArticle) assertFreshProvenance(attempted, loaded.run, sources.records[paperId(paper)]);
                    deps.updateJsonFileLocked(analysisPath, current => {
                        assertAnalysisEnvelope(current, loaded.run, loaded.inputs);
                        const papers = deps.mergePapersById(current.papers, [attempted], { preserveSuccessfulAnalysis: true });
                        return { ...current, papers, status: 'running', updatedAt: deps.now() };
                    });
                }
                });
            });
        } catch (error) { fatal = error; }
        const final = deps.updateJsonFileLocked(analysisPath, current => {
            assertAnalysisEnvelope(current, loaded.run, loaded.inputs);
            const successful = current.papers.filter(complete).length;
            return { ...current, status: successful === loaded.run.paperIds.length && !fatal ? 'complete' : 'partial',
                stats: { ...current.stats, freshSuccess: successful, freshRemaining: loaded.run.paperIds.length - successful },
                updatedAt: deps.now() };
        });
        const status = final.status === 'complete' ? 'complete' : 'analysis_partial';
        updateRun(loaded, { status, analysisSha256: readRegularJson(analysisPath).sha256,
            ...(fatal ? { latestError: String(fatal.message).slice(0, 1000) } : { latestError: null }) }, deps);
        if (fatal) throw fatal;
        return { runId: loaded.run.runId, status, complete: final.stats.freshSuccess,
            total: loaded.run.paperIds.length, ...(options.ids === undefined ? {} : { selectedPaperIds: selectedIds.slice() }),
            exitCode: status === 'complete' ? 0 : 1 };
    });
}

function rewriteStatus(options, overrides = {}) {
    const deps = dependencies(overrides);
    const loaded = loadRun(options.runId, deps);
    const sources = sourceState(loaded, deps);
    const successful = loaded.analysis.papers.filter(paper => {
        if (!deps.isSuccessfulAnalysisRecord(paper)) return false;
        assertFreshProvenance(paper, loaded.run, sources.records[paperId(paper)]);
        return true;
    }).map(paperId);
    return { runId: loaded.run.runId, date: loaded.run.date, status: loaded.run.status,
        paperCount: loaded.run.paperIds.length, sourcesComplete: Object.keys(sources.records).length,
        sourceMissingIds: sources.missing, analysisComplete: successful.length,
        analysisRemainingIds: loaded.run.paperIds.filter(id => !successful.includes(id)),
        diagnostics: loaded.run.diagnostics || {},
        promoted: loaded.run.status === 'promoted' };
}

async function promoteRewrite(options, overrides = {}) {
    const deps = dependencies(overrides);
    return withRunOperation(options.runId, deps, async loaded => {
        const sources = sourceState(loaded, deps);
        if (sources.missing.length || loaded.analysis.status !== 'complete') throw new Error('Fresh rewrite promotion requires all sources and analysis to be complete');
        if (loaded.analysis.papers.some(paper => paper.readerFactReview?.status === 'pending')) {
            throw new Error('Operator revised Reader still requires explicit fact review');
        }
        for (const paper of loaded.analysis.papers) {
            if (!deps.isSuccessfulAnalysisRecord(paper)) throw new Error(`${paperId(paper)} is not a complete analysis`);
            assertFreshProvenance(paper, loaded.run, sources.records[paperId(paper)]);
        }
        if (loaded.run.analysisSha256 !== readRegularJson(path.join(loaded.runDir, 'analysis.json')).sha256) throw new Error('Fresh analysis bytes changed after completion');
        const promoted = await deps.promoteRun({ runDir: loaded.runDir, run: loaded.run, analysis: loaded.analysis });
        updateRun(loaded, { status: 'promoted', promotion: promoted }, deps);
        return { runId: loaded.run.runId, ...promoted };
    });
}

async function patchRewrite(options, overrides = {}) {
    const deps = dependencies(overrides);
    return withRunOperation(options.runId, deps, async loaded => {
        if (loaded.run.status === 'promoted') throw new Error('Promoted fresh run is immutable');
        return require('./reader-operator-patch.js').applyOperatorPatch({ loaded, patchFile: options.patchFile }, {
            rootDir: deps.rootDir, readFreshSource: deps.readFreshSource, now: deps.now, ...overrides.operatorPatchDependencies,
            isSuccessfulAnalysisRecord: deps.isSuccessfulAnalysisRecord,
            readCurrentPaper: (_runDir, id) => loadRun(options.runId, deps).analysis.papers
                .find(item => paperId(item) === id),
            withPaperAnalysisLock: async (paper, callback) => {
                const lock = overrides.withPaperAnalysisLock || require('../analysis-engine.js').withPaperAnalysisLock;
                // Helper reads the current record inside this lock and checks
                // signed-revision scratch versus source-only mode itself.
                return lock(paper, callback);
            }
        });
    });
}

async function signedPatchRewrite(options, overrides = {}) {
    const deps = dependencies(overrides);
    return withRunOperation(options.runId, deps, async loaded => {
        if (loaded.run.status === 'promoted') throw new Error('Promoted fresh run is immutable');
        return require('./reader-signed-operator.js').applySignedReaderOperator({ loaded, patchFile: options.patchFile }, {
            rootDir: deps.rootDir, readFreshSource: deps.readFreshSource, now: deps.now,
            updateJsonFileLocked: deps.updateJsonFileLocked,
            withPaperAnalysisLock: overrides.withPaperAnalysisLock || require('../analysis-engine.js').withPaperAnalysisLock,
            reload: () => loadRun(options.runId, deps),
            updateRun: changes => updateRun(loaded, changes, deps),
            ...(overrides.signedOperatorFaultHooks || {})
        });
    });
}

async function acceptSignedReaderFactReview(request, overrides = {}) {
    const deps = dependencies(overrides);
    return withRunOperation(request.runId, deps, async loaded => {
        return require('./reader-signed-operator.js').acceptSignedReaderFactReview({ loaded, request }, {
            rootDir: deps.rootDir, readFreshSource: deps.readFreshSource, now: deps.now,
            updateJsonFileLocked: deps.updateJsonFileLocked, isSuccessfulAnalysisRecord: deps.isSuccessfulAnalysisRecord,
            withPaperAnalysisLock: overrides.withPaperAnalysisLock || require('../analysis-engine.js').withPaperAnalysisLock,
            reload: () => loadRun(request.runId, deps), updateRun: changes => updateRun(loaded, changes, deps),
            ...(overrides.signedOperatorFaultHooks || {})
        });
    });
}

module.exports = { RUN_CONTRACT, INPUT_CONTRACT, ANALYSIS_CONTRACT, FRESHNESS_CONTRACT, ORIGINAL_METADATA_FIELDS,
    stableHash, sha256, paperId, parseRewriteArgs, metadataOnly, assertSafeDirectory, readRegularJson,
    writeImmutableJson, assertAnalysisEnvelope, assertFreshProvenance, loadRun,
    sealedRecoveryCapabilitySnapshot, consumeSealedRecoveryCapability,
    prepareRewrite, collectRewriteSources, analyzeRewrite, rewriteStatus, promoteRewrite, patchRewrite, signedPatchRewrite,
    acceptSignedReaderFactReview };
