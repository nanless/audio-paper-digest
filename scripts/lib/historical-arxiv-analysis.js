'use strict';

// A narrow bridge from a live, production-authorized arXiv source handle to
// the existing fresh-analysis engine. It creates an isolated canonical run;
// it never reads or writes the daily canonical analysis.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const authorityApi = require('./paper-source-authority.js');
const arxivApi = require('./arxiv-source-authority.js');
const fresh = require('./fresh-rewrite-run.js');

const BASELINE_CONTRACT = 'historical-arxiv-authority-baseline-v1';
const METADATA_CONTRACT = 'historical-raw-metadata-proof-v1';
const GENERATED_FIELD_RE = /^(?:analysis(?:$|Checkpoint|Manifest|Stage|Recovery)|parsed$|apiReader|freshRewrite|freshSource|imageManifest$)/;
const SHA_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function fail(message) {
    const error = new Error(`Historical arXiv analysis rejected: ${message}`);
    error.code = 'HISTORICAL_ARXIV_ANALYSIS_INTEGRITY';
    error.retryable = false;
    throw error;
}

function writeExact(filename, bytes) {
    const payload = Buffer.from(bytes);
    let fd;
    try {
        fd = fs.openSync(filename,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, payload); fs.fsyncSync(fd);
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = fs.readFileSync(filename);
        if (!existing.equals(payload)) fail(`refuses to overwrite different bytes: ${path.basename(filename)}`);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    return sha256(payload);
}
const writeJsonExact = (filename, value) => writeExact(filename, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));

function normalizedMetadata(metadata, expectedId) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('raw metadata object is required');
    if (Object.keys(metadata).some(key => GENERATED_FIELD_RE.test(key))) fail('old analysis/Reader/checkpoint fields are forbidden');
    const unexpected = Object.keys(metadata).filter(key => !fresh.ORIGINAL_METADATA_FIELDS.includes(key));
    if (unexpected.length) fail(`raw metadata contains non-source fields: ${unexpected.join(', ')}`);
    const clean = fresh.metadataOnly(metadata);
    if (fresh.paperId(clean) !== expectedId) fail('raw metadata belongs to another paper');
    return clean;
}

function normalizedMetadataProof(proof, paper) {
    const acceptedContracts = new Set([METADATA_CONTRACT, require('./arxiv-metadata-source.js').CONTRACT]);
    if (!proof || !acceptedContracts.has(proof.contract) || proof.paperId !== `arxiv:${fresh.paperId(paper)}`
        || !SHA_RE.test(String(proof.fileSha256 || '')) || !SHA_RE.test(String(proof.recordSha256 || ''))
        || proof.recordSha256 !== fresh.stableHash(paper)
        || typeof proof.sourceName !== 'string' || !proof.sourceName) fail('raw metadata proof is invalid');
    return structuredClone(proof);
}

function prepareHistoricalArxivRun({ authorityHandle, metadata, metadataProof, metadataArtifact = null, date, rootDir,
    runId = crypto.randomUUID(), now = new Date().toISOString() } = {}) {
    const parsedDate = new Date(`${date}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))
        || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
        fail('date must be a valid YYYY-MM-DD');
    }
    if (!UUID_RE.test(String(runId || ''))) fail('runId must be a UUID v4');
    const replayed = authorityApi.replayAuthorityHandle(authorityHandle, { requireProduction: true });
    const authority = authorityApi.authorityHandleSnapshot(replayed);
    if (authority.authority.evidenceKind !== 'arxiv-official-fulltext'
        || authority.productionAuthorized !== true) fail('live official arXiv authority is required');
    const id = authority.authority.identity.arxivId;
    const paper = normalizedMetadata(metadata, id);
    const proof = normalizedMetadataProof(metadataProof, paper);
    const sourceDetails = arxivApi.readLiveProductionSourceDetails(authorityHandle);
    const sourceSha256 = sha256(Buffer.from(sourceDetails.text, 'utf8'));
    const structuredArtifactsSha256 = sourceDetails.structuredArtifacts?.payloadSha256;
    if (sourceSha256 !== authority.fulltextSha256 || !SHA_RE.test(String(structuredArtifactsSha256 || ''))
        || sourceDetails.structuredArtifacts.flattenedTextSha256 !== sourceSha256) {
        fail('live source details do not bind the authority/source artifact hashes');
    }

    const absoluteRoot = fresh.assertSafeDirectory(rootDir, true);
    const runDir = path.join(absoluteRoot, runId);
    if (fs.existsSync(path.join(runDir, 'run.json'))) {
        const loaded = fresh.loadRun(runId, { rootDir: absoluteRoot });
        if (loaded.run.date !== date || fresh.paperId(loaded.inputs.papers[0]) !== id
            || loaded.run.paperIds.length !== 1 || loaded.run.baseline.contract !== BASELINE_CONTRACT
            || loaded.run.baseline.authorityFileSha256 !== authority.authorityFileSha256
            || loaded.run.baseline.authoritySha256 !== authority.authority.authoritySha256
            || fresh.stableHash(loaded.inputs.papers[0]) !== fresh.stableHash(paper)) {
            fail('existing runId belongs to different source, metadata, date, or paper set');
        }
        return { runId, runDir, paperId: `arxiv:${id}`, status: 'recovered',
            canonicalPath: path.join(runDir, 'analysis.json') };
    }
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const sourceDir = path.join(runDir, 'sources', id);
    fs.mkdirSync(sourceDir, { recursive: true, mode: 0o700 });
    try {
        const inputs = { version: 1, contract: fresh.INPUT_CONTRACT, runId, date, papers: [paper] };
        const inputsSha256 = writeJsonExact(path.join(runDir, 'inputs.json'), inputs);
        writeJsonExact(path.join(runDir, 'analysis.json'), { version: 1,
            contract: fresh.ANALYSIS_CONTRACT, runId, batchDate: date, status: 'pending', generation: 0,
            papers: [paper] });
        const sourceBytes = Buffer.from(JSON.stringify(sourceDetails));
        const descriptor = { version: 1, contract: 'fresh-source-cache-v1', runId, paperId: id,
            sourceSha256, structuredArtifactsSha256, sourceSnapshotSha256: sha256(sourceBytes) };
        writeExact(path.join(sourceDir, 'source.txt'), Buffer.from(sourceDetails.text, 'utf8'));
        writeExact(path.join(sourceDir, 'artifacts.json'), Buffer.from(JSON.stringify(sourceDetails.structuredArtifacts)));
        writeExact(path.join(sourceDir, 'source-details.json'), sourceBytes);
        writeExact(path.join(sourceDir, 'source.json'), Buffer.from(JSON.stringify(descriptor)));
        if (metadataArtifact !== null) {
            const artifact = Buffer.from(metadataArtifact);
            if (sha256(artifact) !== proof.fileSha256) fail('official metadata artifact SHA does not match its proof');
            writeExact(path.join(runDir, `metadata-${id}.atom.xml`), artifact);
        }
        const sourceExpectations = { [id]: { sourceId: sourceDetails.sourceId, sourceSha256,
            structuredArtifactsSha256, authoritySha256: authority.authority.authoritySha256,
            authorityFileSha256: authority.authorityFileSha256,
            authoritySourceSnapshotSha256: authority.sourceSnapshotSha256 } };
        const baseline = { version: 1, contract: BASELINE_CONTRACT, paperId: `arxiv:${id}`,
            authorityName: authority.authorityName, authorityFileSha256: authority.authorityFileSha256,
            authoritySha256: authority.authority.authoritySha256,
            authoritySourceSnapshotSha256: authority.sourceSnapshotSha256,
            fulltextSha256: authority.fulltextSha256, metadata: proof };
        const run = { version: 1, contract: fresh.RUN_CONTRACT, freshnessContract: fresh.FRESHNESS_CONTRACT,
            runId, date, createdAt: new Date(now).toISOString(), paperIds: [id],
            paperSetSha256: fresh.stableHash([id]), inputsSha256, baseline, sourceExpectations,
            metadataSources: { historicalRawMetadata: proof }, sourceRecords: { [id]: descriptor },
            status: 'sources_ready', generation: 0,
            diagnostics: { analysisInvocations: 0, outerAnalysisEntries: {} } };
        run.identitySha256 = fresh.stableHash({ version: run.version, contract: run.contract, runId: run.runId,
            date: run.date, paperIds: run.paperIds, paperSetSha256: run.paperSetSha256,
            inputsSha256: run.inputsSha256, baseline: run.baseline,
            sourceExpectations: run.sourceExpectations, metadataSources: run.metadataSources });
        writeJsonExact(path.join(runDir, 'run.json'), run);
        fresh.loadRun(runId, { rootDir: absoluteRoot });
        return { runId, runDir, paperId: `arxiv:${id}`, status: 'sources_ready',
            canonicalPath: path.join(runDir, 'analysis.json') };
    } catch (error) {
        throw new Error(`Historical arXiv run retained for inspection at ${runDir}: ${error.message}`, { cause: error });
    }
}

function recoverHistoricalArxivRun({ runId, date, arxivId, rootDir } = {}) {
    if (!UUID_RE.test(String(runId || '')) || !/^\d{4}\.\d{4,5}$/.test(String(arxivId || ''))) fail('valid runId and arxivId are required');
    const runDir = path.join(path.resolve(rootDir), runId);
    if (!fs.existsSync(path.join(runDir, 'run.json'))) return null;
    const loaded = fresh.loadRun(runId, { rootDir: path.resolve(rootDir) });
    if (loaded.run.date !== date || loaded.run.paperIds.length !== 1 || loaded.run.paperIds[0] !== arxivId
        || loaded.run.baseline.contract !== BASELINE_CONTRACT
        || loaded.run.baseline.paperId !== `arxiv:${arxivId}`) fail('existing runId belongs to another historical analysis');
    normalizedMetadataProof(loaded.run.baseline.metadata, loaded.inputs.papers[0]);
    if (loaded.run.baseline.metadata.contract === require('./arxiv-metadata-source.js').CONTRACT) {
        const filename = path.join(runDir, `metadata-${arxivId}.atom.xml`);
        let bytes; let fd;
        try { fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); bytes = fs.readFileSync(fd); }
        catch (error) { fail(`official metadata artifact cannot be replayed: ${error.message}`); }
        finally { if (fd !== undefined) fs.closeSync(fd); }
        if (sha256(bytes) !== loaded.run.baseline.metadata.fileSha256) fail('official metadata artifact SHA drifted');
    }
    return { runId, runDir, paperId: `arxiv:${arxivId}`, status: loaded.run.status,
        canonicalPath: path.join(runDir, 'analysis.json'), recovered: true };
}

module.exports = { BASELINE_CONTRACT, METADATA_CONTRACT, prepareHistoricalArxivRun,
    recoverHistoricalArxivRun, normalizedMetadata, normalizedMetadataProof };
