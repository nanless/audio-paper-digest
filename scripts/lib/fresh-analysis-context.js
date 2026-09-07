'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const scope = new AsyncLocalStorage();
const CONTRACT = 'fresh-source-analysis-v1';
const CACHE_CONTRACT = 'fresh-source-cache-v1';
const BUNDLE_CACHE_CONTRACT = 'fresh-source-bundle-v2';
const BUNDLE_SOURCE_MODE = 'sealed-arxiv-bundle-v1';
const DAILY_SOURCE_RUN_CONTRACT = 'daily-fresh-source-run-v1';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const stable = value => {
    const normalize = item => Array.isArray(item) ? item.map(normalize)
        : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])])) : item;
    return sha(JSON.stringify(normalize(value)) ?? 'null');
};
const validSha = value => /^[a-f0-9]{64}$/.test(String(value || ''));

function isBundleExpectation(value) {
    return Boolean(value) && value.sourceMode === BUNDLE_SOURCE_MODE
        && Number.isSafeInteger(value.sourceGeneration) && value.sourceGeneration >= 1;
}

function fail(message) {
    const error = new Error(message);
    error.code = 'FRESH_ANALYSIS_INTEGRITY'; error.retryable = false;
    return error;
}

function paperId(paper) {
    const raw = typeof paper === 'string' ? paper : paper?.arxivId || paper?.paper_id || paper?.id;
    if (!/^\d{4}\.\d{4,5}(?:v\d+)?$/.test(String(raw || ''))) throw fail('Fresh source requires a normalized arXiv identity');
    return raw.replace(/v\d+$/, '');
}

function safeDirectory(directory, create = false) {
    const absolute = path.resolve(directory);
    let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        let stat;
        try { stat = fs.lstatSync(cursor); } catch (error) {
            if (error.code !== 'ENOENT' || !create) throw error;
            fs.mkdirSync(cursor, { mode: 0o700 }); stat = fs.lstatSync(cursor);
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail(`Unsafe fresh directory: ${cursor}`);
    }
    return absolute;
}

function readBytes(filename) {
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) throw fail('Unsafe or oversized fresh cache file');
        return fs.readFileSync(fd);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function readJson(filename) {
    try { return JSON.parse(readBytes(filename).toString('utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw error; throw fail(`Fresh JSON refused: ${error.message}`); }
}

function validateRun(runDir, identity) {
    const Config = require('../config.js');
    const runId = identity?.runId;
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(String(runId || ''))) {
        throw fail('Fresh runId must be a UUID');
    }
    const rewriteRoot = path.resolve(Config.FILES.freshRewriteRunsDir);
    const dailyRoot = path.resolve(Config.FILES.dailyFreshSourceRunsDir || '');
    const resolvedRunDir = path.resolve(runDir);
    const roots = [
        { root: rewriteRoot, contract: 'fresh-rewrite-run-v1' },
        { root: dailyRoot, contract: DAILY_SOURCE_RUN_CONTRACT }
    ].filter(item => item.root && item.root !== path.resolve('.'));
    const matchedRoot = roots.find(item => resolvedRunDir === path.join(item.root, runId));
    if (!matchedRoot) throw fail('Fresh runDir must be the configured root/runId directory');
    safeDirectory(resolvedRunDir);
    const run = readJson(path.join(resolvedRunDir, 'run.json'));
    if (run.runId !== runId || run.contract !== matchedRoot.contract || run.version !== 1) throw fail('Fresh run manifest identity mismatch');
    const expectations = identity?.sourceExpectations;
    if (!expectations || typeof expectations !== 'object' || Array.isArray(expectations)
        || stable(expectations) !== stable(run.sourceExpectations)) throw fail('Fresh source expectations differ from the run manifest');
    const ids = Object.keys(expectations);
    if (!ids.length || !Array.isArray(run.paperIds) || stable(ids.slice().sort()) !== stable(run.paperIds.slice().sort())) {
        throw fail('Fresh source expectations do not cover the exact run input set');
    }
    for (const id of ids) {
        const expectation = expectations[id];
        if (paperId(id) !== id || (!isBundleExpectation(expectation)
            && (!validSha(expectation?.sourceSha256) || !validSha(expectation?.structuredArtifactsSha256)))) {
            throw fail(`Fresh baseline lacks an exact source contract: ${id}`);
        }
        if (expectations[id].sourceId !== undefined && paperId(expectations[id].sourceId) !== id) {
            throw fail(`Fresh sourceId belongs to another paper: ${id}`);
        }
    }
    return { runId, runDir: resolvedRunDir, runContract: matchedRoot.contract, sourceExpectations: structuredClone(expectations),
        inputSetSha256: stable(ids.slice().sort()) };
}

function withFreshAnalysisContext(identity, callback) {
    const checked = validateRun(identity?.runDir, identity);
    if (identity.refreshReaderDiagnostics !== undefined && typeof identity.refreshReaderDiagnostics !== 'boolean') {
        throw fail('refreshReaderDiagnostics must be an explicit boolean');
    }
    for (const expectation of Object.values(checked.sourceExpectations)) Object.freeze(expectation);
    Object.freeze(checked.sourceExpectations);
    const capabilities = identity.sealedRecoveryCapabilities === undefined
        ? new Map() : identity.sealedRecoveryCapabilities;
    if (!(capabilities instanceof Map)
        || [...capabilities.entries()].some(([id, handle]) => {
            const snapshot = require('./fresh-rewrite-run.js')
                .sealedRecoveryCapabilitySnapshot(handle);
            const expected = checked.sourceExpectations[id];
            return !expected || snapshot?.runId !== checked.runId
                || snapshot.paperId !== id
                || (!isBundleExpectation(expected) && (snapshot.sourceSha256 !== expected.sourceSha256
                    || snapshot.structuredArtifactsSha256 !== expected.structuredArtifactsSha256))
                || (isBundleExpectation(expected) && (snapshot.sourceGeneration !== expected.sourceGeneration
                    || !validSha(snapshot.sourceManifestSha256)));
        })) throw fail('Fresh sealed recovery capabilities are invalid or forged');
    const { withLlmUsageContext } = require('./llm-usage.js');
    const context = Object.freeze({ ...checked,
        refreshReaderDiagnostics: identity.refreshReaderDiagnostics === true,
        sealedRecoveryCapabilities: new Map(capabilities),
        pendingSources: new Map() });
    return scope.run(context,
        () => withLlmUsageContext({ runId: checked.runId }, callback));
}

function getFreshAnalysisContext() { return scope.getStore() || null; }

// Daily source runs seal source.txt, source.pdf, source-runtime.json, and
// source-manifest.json. Figure bytes are intentionally materialized afresh
// for the active request, so failed Reader candidates need a separate
// ephemeral-pixel binding. Older fresh rewrite runs retain their existing
// candidate semantics.
function isDailyFreshSourceScope() {
    return getFreshAnalysisContext()?.runContract === DAILY_SOURCE_RUN_CONTRACT;
}

function getSealedRecoveryCapability(id = getFreshAnalysisContext()?.paperId) {
    const context = getFreshAnalysisContext();
    if (!context || !id) return null;
    return context.sealedRecoveryCapabilities.get(paperId(id)) || null;
}

function validateSource(details, id, expectation) {
    if (!details || typeof details !== 'object' || Array.isArray(details)
        || Object.keys(details).some(key => /^(?:analysis|parsed$|apiReader|freshRewrite|freshSource)/.test(key))) {
        throw fail('Fresh source cache cannot contain generated analysis, Reader, checkpoint or provenance fields');
    }
    const minimum = require('../config.js').ANALYSIS_CONFIG.fullTextMinCharsForFull;
    if (!['html', 'pdf'].includes(details.source) || typeof details.text !== 'string'
        || details.text.length <= minimum || paperId(details.sourceId) !== id
        || sha(details.text) !== expectation.sourceSha256) throw fail(`Fresh full-text source does not match baseline: ${id}`);
    const artifacts = details.structuredArtifacts;
    if (!artifacts || typeof artifacts !== 'object' || !Array.isArray(artifacts.tables) || !Array.isArray(artifacts.formulas)) {
        throw fail('Fresh source requires full structuredArtifacts, not a generated summary');
    }
    const { payloadSha256, ...body } = artifacts;
    if (!validSha(payloadSha256) || sha(JSON.stringify(body)) !== payloadSha256
        || payloadSha256 !== expectation.structuredArtifactsSha256
        || artifacts.flattenedTextSha256 !== expectation.sourceSha256) {
        throw fail(`Fresh structuredArtifacts/source SHA drift: ${id}`);
    }
    return details;
}

function sourceDirectory(context, id) { return path.join(context.runDir, 'sources', id); }

function bundleRoot(context) { return path.join(context.runDir, 'sources'); }

function detailsFromSealedBundle(stored) {
    // The sealed source bundle already validates its non-pixel runtime metadata
    // against the persisted PDF/TXT manifest. Replaying it preserves exact
    // table/formula bindings and figure discovery for daily Reader runs; it
    // never contains image bytes or a legacy data/current cache path.
    const runtime = stored.runtimeDetails;
    if (!runtime || runtime.paperId !== stored.manifest.paperId
        || runtime.text !== stored.text || runtime.source !== stored.manifest.text.source
        || runtime.sourceId !== stored.manifest.text.sourceId) {
        throw fail('Fresh sealed bundle runtime metadata drift');
    }
    const details = { text: runtime.text, source: runtime.source, sourceId: runtime.sourceId,
        imageInfos: structuredClone(runtime.imageInfos), structuredArtifacts: structuredClone(runtime.structuredArtifacts),
        readerAuthors: runtime.readerAuthors === null ? { authors: [] } : structuredClone(runtime.readerAuthors),
        htmlAvailability: runtime.htmlAvailability, htmlAttempts: runtime.htmlAttempts,
        warnings: runtime.warnings.map(String) };
    const sourceSnapshot = { sourceManifestSha256: stored.sourceManifestSha256,
        sourceGeneration: stored.generation, details };
    const descriptor = { version: 2, contract: BUNDLE_CACHE_CONTRACT, runId: null, paperId: stored.manifest.paperId.slice(6),
        sourceGeneration: stored.generation, sourceManifestSha256: stored.sourceManifestSha256,
        sourceSha256: stored.manifest.text.responseSha256,
        structuredArtifactsSha256: details.structuredArtifacts.payloadSha256 || '',
        sourceSnapshotSha256: sha(JSON.stringify(sourceSnapshot)) };
    return { ...details, freshSourceDescriptor: descriptor };
}

function readBundleFreshSource(checked, id, expectation) {
    const sourceApi = require('./fresh-arxiv-rewrite-source.js');
    const root = bundleRoot(checked);
    if (!sourceApi.generationExists(root, id, expectation.sourceGeneration)) return null;
    const stored = sourceApi.readFreshArxivRewriteSource({ rootDir: root, arxivId: id,
        generation: expectation.sourceGeneration });
    const source = detailsFromSealedBundle(stored);
    source.freshSourceDescriptor.runId = checked.runId;
    if (source.freshSourceDescriptor.paperId !== id
        || source.freshSourceDescriptor.sourceGeneration !== expectation.sourceGeneration
        || !validSha(source.freshSourceDescriptor.sourceManifestSha256)) {
        throw fail('Fresh sealed source bundle identity drift');
    }
    return source;
}

function readFreshSource(runDir, paper, identity) {
    const checked = validateRun(runDir, identity);
    const id = paperId(paper);
    const expectation = checked.sourceExpectations[id];
    if (!expectation) throw fail(`Paper is outside fresh run: ${id}`);
    if (isBundleExpectation(expectation)) return readBundleFreshSource(checked, id, expectation);
    const directory = sourceDirectory(checked, id);
    try { safeDirectory(directory); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    let descriptor;
    try { descriptor = readJson(path.join(directory, 'source.json')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (descriptor.contract !== CACHE_CONTRACT || descriptor.version !== 1 || descriptor.runId !== checked.runId
        || descriptor.paperId !== id || descriptor.sourceSha256 !== expectation.sourceSha256
        || descriptor.structuredArtifactsSha256 !== expectation.structuredArtifactsSha256
        || !validSha(descriptor.sourceSnapshotSha256)) throw fail('Fresh source descriptor identity drift');
    const bytes = readBytes(path.join(directory, 'source-details.json'));
    if (sha(bytes) !== descriptor.sourceSnapshotSha256) throw fail('Fresh source snapshot bytes changed');
    const details = validateSource(JSON.parse(bytes.toString('utf8')), id, expectation);
    if (sha(readBytes(path.join(directory, 'source.txt'))) !== expectation.sourceSha256
        || readBytes(path.join(directory, 'artifacts.json')).toString('utf8') !== JSON.stringify(details.structuredArtifacts)) {
        throw fail('Fresh source sidecar files do not replay their sourceDetails');
    }
    return { ...details, freshSourceDescriptor: descriptor };
}

function writeExact(directory, filename, bytes) {
    safeDirectory(directory, true);
    const target = path.join(directory, filename);
    try {
        const existing = readBytes(target);
        if (existing.equals(Buffer.from(bytes))) return;
        throw fail(`Fresh cache refuses to overwrite different bytes: ${filename}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = path.join(directory, `.${filename}.${crypto.randomUUID()}.tmp`);
    let fd;
    try {
        fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        safeDirectory(directory);
        // Exclusive link commits without replacing a concurrently created file.
        try { fs.linkSync(temporary, target); }
        catch (error) {
            if (error.code !== 'EEXIST' || !readBytes(target).equals(Buffer.from(bytes))) throw error;
        }
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
}

async function fetchFreshSource(arxivId, fetchOriginal) {
    const context = getFreshAnalysisContext();
    if (!context) return fetchOriginal(arxivId);
    const id = paperId(arxivId);
    const cached = readFreshSource(context.runDir, id, context);
    if (cached) return cached;
    if (context.pendingSources.has(id)) return structuredClone(await context.pendingSources.get(id));
    const pending = (async () => {
        const expectation = context.sourceExpectations[id];
        if (isBundleExpectation(expectation)) {
            const sourceApi = require('./fresh-arxiv-rewrite-source.js');
            await sourceApi.captureFreshArxivRewriteSource({ rootDir: bundleRoot(context), arxivId: id,
                generation: expectation.sourceGeneration });
            const sealed = readFreshSource(context.runDir, id, context);
            if (!sealed) throw fail('Fresh source bundle capture did not seal a readable source');
            return sealed;
        }
        const directory = sourceDirectory(context, id);
        let details;
        try {
            // A crash after source-details but before the commit marker can
            // complete locally, after verifying every original byte again.
            safeDirectory(directory);
            details = readJson(path.join(directory, 'source-details.json'));
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!details) details = await fetchOriginal(arxivId);
        validateSource(details, id, expectation);
        validateRun(context.runDir, context);
        const sourceSnapshot = JSON.stringify(details);
        const descriptor = { version: 1, contract: CACHE_CONTRACT, runId: context.runId, paperId: id,
            sourceSha256: expectation.sourceSha256, structuredArtifactsSha256: expectation.structuredArtifactsSha256,
            sourceSnapshotSha256: sha(sourceSnapshot) };
        writeExact(directory, 'source.txt', details.text);
        writeExact(directory, 'artifacts.json', JSON.stringify(details.structuredArtifacts));
        writeExact(directory, 'source-details.json', sourceSnapshot);
        writeExact(directory, 'source.json', JSON.stringify(descriptor));
        return readFreshSource(context.runDir, id, context);
    })();
    context.pendingSources.set(id, pending);
    try { return structuredClone(await pending); } finally { context.pendingSources.delete(id); }
}

function resolveFreshSource(runDir, paper, identity) {
    const id = paperId(paper);
    const requestedId = isBundleExpectation(identity?.sourceExpectations?.[id]) ? id : identity?.sourceExpectations?.[id]?.sourceId
        ?? (typeof paper === 'string' ? paper : paper.arxivId || paper.paper_id || paper.id);
    if (paperId(requestedId) !== id) throw fail(`Fresh sourceId belongs to another paper: ${id}`);
    return withFreshAnalysisContext({ ...identity, runDir }, () => require('../deep-analyzer.js').fetchArxivTextDetailed(requestedId));
}

function freshAnalysisIdentity(id = getFreshAnalysisContext()?.paperId) {
    const context = getFreshAnalysisContext();
    if (!context) return null;
    const base = { contract: CONTRACT, runId: context.runId, inputSetSha256: context.inputSetSha256 };
    if (!id) return base;
    const source = readFreshSource(context.runDir, id, context);
    if (!source) throw fail('Fresh stage cannot run before its original source cache is complete');
    return { ...base, paperId: paperId(id), ...provenanceFromSource(source) };
}

function provenanceFromSource(source) {
    const context = getFreshAnalysisContext();
    const descriptor = source?.freshSourceDescriptor;
    if (!context || descriptor?.runId !== context.runId) throw fail('Fresh provenance requires the current run source descriptor');
    return { contract: CONTRACT, runId: context.runId, sourceSha256: descriptor.sourceSha256,
        structuredArtifactsSha256: descriptor.structuredArtifactsSha256, sourceSnapshotSha256: descriptor.sourceSnapshotSha256,
        ...(descriptor.contract === BUNDLE_CACHE_CONTRACT ? { sourceGeneration: descriptor.sourceGeneration,
            sourceManifestSha256: descriptor.sourceManifestSha256 } : {}),
        sourceOnly: true, oldGeneratedTextIncluded: false };
}

function assertFreshPaper(paper) {
    const context = getFreshAnalysisContext();
    if (!context) return;
    const id = paperId(paper);
    if (!context.sourceExpectations[id]) throw fail(`Paper is outside fresh run: ${id}`);
    if (paper.fullText || paper.pdfText) throw fail('Fresh analysis must use this run source cache, not caller-provided text');
    const generated = Object.keys(paper).filter(key => /^(?:analysis(?:$|Checkpoint|Manifest|Stage|Recovery)|parsed$|apiReader|imageManifest$)/.test(key)
        && paper[key] !== undefined && paper[key] !== null && paper[key] !== '');
    if (!generated.length && !paper.freshRewriteProvenance) return;
    const source = readFreshSource(context.runDir, id, context);
    if (!source) throw fail('Fresh generated state has no original source cache');
    const expected = provenanceFromSource(source);
    if (stable(paper.freshRewriteProvenance) !== stable(expected)
        || (paper.analysisManifest && stable(paper.analysisManifest.freshRewriteProvenance) !== stable(expected))) {
        throw fail('Fresh analysis refuses another run or legacy generated analysis/Reader/checkpoints');
    }
}

function withFreshPaperContext(paper, callback) {
    const context = getFreshAnalysisContext();
    if (!context) return callback();
    assertFreshPaper(paper);
    return scope.run(Object.freeze({ ...context, paperId: paperId(paper) }), callback);
}

function attachFreshSourceProvenance(paper, manifest, source) {
    if (!getFreshAnalysisContext()) return;
    const proof = provenanceFromSource(source);
    paper.freshRewriteProvenance = proof;
    manifest.freshRewriteProvenance = structuredClone(proof);
}

function freshReaderAttemptsDirectory(requestedDirectory) {
    const context = getFreshAnalysisContext();
    if (!context) return requestedDirectory;
    const expected = path.join(context.runDir, 'reader-attempts');
    if (requestedDirectory && path.resolve(requestedDirectory) !== expected) throw fail('Fresh Reader candidates must stay inside the current run');
    return expected;
}

module.exports = { CONTRACT, CACHE_CONTRACT, BUNDLE_CACHE_CONTRACT, BUNDLE_SOURCE_MODE, DAILY_SOURCE_RUN_CONTRACT, isBundleExpectation,
    withFreshAnalysisContext, getFreshAnalysisContext, isDailyFreshSourceScope,
    getSealedRecoveryCapability,
    readFreshSource, resolveFreshSource, fetchFreshSource, freshAnalysisIdentity, assertFreshPaper,
    withFreshPaperContext, attachFreshSourceProvenance, freshReaderAttemptsDirectory };
