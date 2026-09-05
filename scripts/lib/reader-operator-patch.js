'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const repair = require('./reader-repair.js');
const { READER_SOURCE_CONTENT_MODE, READER_SIGNED_REVISION_CONTENT_MODE } = require('./reader-contract.js');
const CONTRACT = 'reader-operator-patch-v1';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const isSha = value => /^[a-f0-9]{64}$/.test(String(value || ''));
const same = (a, b) => repair.hashDraft(a) === repair.hashDraft(b);
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');

function readPrivate(filename) {
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 20 * 1024 * 1024) {
            throw new Error('Operator patch requires a regular single-link 0600 file within the run');
        }
        const bytes = fs.readFileSync(fd);
        return { bytes, sha256: sha(bytes), value: JSON.parse(bytes.toString('utf8')) };
    } finally { fs.closeSync(fd); }
}

function syncDirectory(directory) {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function installImmutable(filename, bytes) {
    try {
        const existing = readPrivate(filename);
        if (!existing.bytes.equals(bytes)) throw new Error('Operator patch immutable audit bytes changed');
        return;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${crypto.randomUUID()}.tmp`);
    let fd;
    try {
        fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        // Caller holds the run and paper locks. Existing committed audit files
        // are checked above and never intentionally overwritten.
        fs.renameSync(temporary, filename);
        syncDirectory(path.dirname(filename));
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
}

function patchPath(runDir, name) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.json$/.test(name)) {
        throw new Error('--patch must name a JSON file directly inside this run/patches directory');
    }
    return path.join(runDir, 'patches', name);
}

function validateRequest(value, run) {
    if (!exactKeys(value, ['paperId', 'candidateIdentitySha256', 'sourceSha256', 'reason', 'patch'])
        || !/^\d{4}\.\d{4,5}$/.test(value.paperId || '') || !run.paperIds.includes(value.paperId)
        || !isSha(value.candidateIdentitySha256) || !isSha(value.sourceSha256)
        || value.sourceSha256 !== run.sourceExpectations[value.paperId]?.sourceSha256
        || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 2000) {
        throw new Error('Invalid operator patch envelope or run/source scope');
    }
    if (!Array.isArray(value.patch?.replacements) || value.patch.replacements.length < 1 || value.patch.replacements.length > 8) {
        throw new Error('Operator patch requires one to eight existing-node replacements');
    }
    return value;
}

function parserOptions(details, identity, payload, deps) {
    const descriptor = details?.freshSourceDescriptor;
    const fresh = identity.freshAnalysis;
    if (!descriptor || identity.paperId !== descriptor.paperId || identity.sourceSha256 !== descriptor.sourceSha256
        || fresh?.contract !== 'fresh-source-analysis-v1' || fresh.runId !== descriptor.runId
        || fresh.paperId !== descriptor.paperId || fresh.sourceSha256 !== descriptor.sourceSha256
        || fresh.structuredArtifactsSha256 !== descriptor.structuredArtifactsSha256
        || fresh.sourceSnapshotSha256 !== descriptor.sourceSnapshotSha256
        || fresh.sourceOnly !== true || fresh.oldGeneratedTextIncluded !== false
        || ![READER_SOURCE_CONTENT_MODE, READER_SIGNED_REVISION_CONTENT_MODE].includes(identity.contentMode)
        || sha(details.text || '') !== descriptor.sourceSha256
        || details.structuredArtifacts?.payloadSha256 !== descriptor.structuredArtifactsSha256) {
        throw new Error('Operator patch candidate is not bound to the current fresh source snapshot');
    }
    const images = payload.imageEvidence;
    if (!Array.isArray(images) || new Set(images.map(image => image?.ordinal)).size !== images.length
        || images.some(image => !Number.isInteger(image?.ordinal) || !isSha(image.sha256)
            || !(details.structuredArtifacts.figures || []).some(figure => figure.ordinal === image.ordinal
                && (figure.images || []).some(source => source.url === image.url && source.url)))) {
        throw new Error('Operator patch image evidence is missing or outside the original source');
    }
    const evidence = deps.buildApiReaderEvidenceContext('', details.text, details.structuredArtifacts, identity.paperId);
    const availableTableCount = [...String(evidence).matchAll(/^TABLE_(\d+):/gm)].length;
    const minimumIntegratedTables = require('./reader-contract.js').readerRequirements({ version: 3, availableTableCount }).minimumTables;
    return { requiredVersion: 3, requireIntegratedTables: true, minimumIntegratedTables,
        availableFigureOrdinals: images.map(image => image.ordinal), requireSourceBindings: true,
        allowDeterministicQuoteRepair: true, structuredArtifacts: details.structuredArtifacts, sourceText: details.text };
}

function dependencies(overrides) {
    return { rootDir: require('../config.js').FILES.freshRewriteRunsDir,
        readFreshSource: (...args) => require('./fresh-analysis-context.js').readFreshSource(...args),
        withPaperAnalysisLock: (...args) => require('../analysis-engine.js').withPaperAnalysisLock(...args),
        isSuccessfulAnalysisRecord: (...args) => require('../analysis-engine.js').isSuccessfulAnalysisRecord(...args),
        readCurrentPaper: (runDir, paperId) => readPrivate(path.join(runDir, 'analysis.json')).value.papers
            .find(paper => (paper.arxivId || paper.paper_id) === paperId),
        parseApiReaderArticleResult: (...args) => require('../deep-analyzer.js').parseApiReaderArticleResult(...args),
        buildApiReaderEvidenceContext: (...args) => require('../deep-analyzer.js').buildApiReaderEvidenceContext(...args),
        now: () => new Date().toISOString(), ...overrides };
}

function validateScratchParent(current, identity, details, run, deps) {
    const { apiReaderV3BindsCanonical } = require('../analysis-engine.js');
    if (!current || (current.arxivId || current.paper_id) !== identity.paperId) {
        throw new Error('Operator patch requires the current same-run analysis record');
    }
    if (identity.contentMode === READER_SOURCE_CONTENT_MODE) {
        if (apiReaderV3BindsCanonical(current) || deps.isSuccessfulAnalysisRecord(current)) {
            throw new Error('Source-only operator patch cannot edit a successful analysis or signed Reader');
        }
        return;
    }
    // This only permits editing failed scratch. The signed-revision service
    // must still recompute the parent + feedback input identity before it can
    // consume the candidate; a valid current parent is not a revision receipt.
    if (current.latestAnalysisAttemptError || !apiReaderV3BindsCanonical(current)) {
        throw new Error('Signed-revision operator patch requires a valid signed parent Reader');
    }
    require('./fresh-rewrite-run.js').assertFreshProvenance(current, run, details.freshSourceDescriptor);
    if (current.sourceSha256 !== identity.sourceSha256
        || current.analysisManifest.sourceAcquisition.structuredArtifactsSha256
            !== details.freshSourceDescriptor.structuredArtifactsSha256) {
        throw new Error('Signed-revision parent Reader has a different source or artifact snapshot');
    }
}

async function applyOperatorPatch({ loaded, patchFile }, overrides = {}) {
    require('../env-loader.js').requireExternalRuntime('reader-operator-patch.js');
    const deps = dependencies(overrides);
    const { assertSafeDirectory, stableHash } = require('./fresh-rewrite-run.js');
    const { runDir, run, inputs } = loaded;
    if (run.status === 'promoted') throw new Error('Promoted fresh run is immutable');
    if (path.resolve(runDir) !== path.join(path.resolve(deps.rootDir), run.runId)) {
        throw new Error('Operator patch must use the configured fresh run root');
    }
    assertSafeDirectory(path.join(runDir, 'patches'));
    const filename = patchPath(runDir, patchFile);
    const requestFile = readPrivate(filename);
    const request = validateRequest(requestFile.value, run);
    const paper = inputs.papers.find(item => (item.arxivId || item.paper_id) === request.paperId);
    if (!paper) throw new Error('Operator patch paper is absent from original run inputs');
    return deps.withPaperAnalysisLock(paper, async () => {
        const details = deps.readFreshSource(runDir, paper, run);
        if (!details) throw new Error('Operator patch requires the verified original source cache');
        const directory = assertSafeDirectory(path.join(runDir, 'reader-attempts'));
        const candidateFile = path.join(directory, `${request.candidateIdentitySha256}.json`);
        const before = readPrivate(candidateFile);
        const identity = before.value.identity;
        if (repair.hashDraft(identity) !== request.candidateIdentitySha256 || identity.paperId !== request.paperId
            || identity.freshAnalysis?.runId !== run.runId
            || identity.freshAnalysis?.inputSetSha256 !== stableHash(run.paperIds.slice().sort())) {
            throw new Error('Operator patch candidate identity or run paper-set mismatch');
        }
        const payload = repair.loadFailedCandidate(directory, identity);
        if (!payload?.draft || !same(payload, before.value.payload)) throw new Error('Operator patch needs an unchanged active failed draft');
        // Hash-only filenames are active; resolved/migrated audit files are not.
        for (const name of fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
            if (name === path.basename(candidateFile)) continue;
            if (readPrivate(path.join(directory, name)).value.identity?.paperId === request.paperId) {
                throw new Error('Operator patch has multiple active candidates for this paper');
            }
        }
        const options = parserOptions(details, identity, payload, deps);
        validateScratchParent(deps.readCurrentPaper(runDir, request.paperId), identity, details, run, deps);
        const archiveDir = path.join(runDir, 'patches', 'operator-archive', requestFile.sha256);
        if (payload.operatorPatches !== undefined && !Array.isArray(payload.operatorPatches)) {
            throw new Error('Operator patch audit history is malformed');
        }
        const auditEntry = (payload.operatorPatches || []).find(entry => entry.patchFileSha256 === requestFile.sha256);
        if (auditEntry) {
            assertSafeDirectory(archiveDir);
            const intent = readPrivate(path.join(archiveDir, 'intent.json')).value;
            if (!same(intent.audit, auditEntry) || intent.afterPayloadSha256 !== repair.hashDraft(payload)
                || auditEntry.afterDraftSha256 !== repair.hashDraft(payload.draft)
                || readPrivate(path.join(archiveDir, 'before.json')).sha256 !== auditEntry.oldEnvelopeSha256
                || readPrivate(path.join(archiveDir, 'patch.json')).sha256 !== requestFile.sha256) {
                throw new Error('Operator patch replay audit or current draft drifted');
            }
            deps.parseApiReaderArticleResult(JSON.stringify(payload.draft), options);
            return { runId: run.runId, paperId: request.paperId, status: 'failed', operatorPatchApplied: true,
                alreadyApplied: true, draftSha256: auditEntry.afterDraftSha256, patchFileSha256: requestFile.sha256 };
        }
        const allowedPaths = request.patch.replacements.map(item => item?.path).filter(pointer =>
            /^\/(?:readerTitle|oneSentenceThesis)$|^\/(?:sections|conceptBridges|figurePlacements|tableBindings|formulaBindings)\/(?:0|[1-9]\d*)(?:\/body)?$/.test(pointer || ''));
        const draft = repair.applyReaderPatch(payload.draft, request.patch, allowedPaths,
            { availableFigureOrdinals: options.availableFigureOrdinals });
        if (!repair.parseRepairableDraft(draft) || repair.hashDraft(draft) === repair.hashDraft(payload.draft)) {
            throw new Error('Operator patch must change an existing valid draft node');
        }
        // Production parser is the only acceptance gate. Its returned article
        // is deliberately discarded: this operation cannot issue success proof.
        deps.parseApiReaderArticleResult(JSON.stringify(draft), options);
        const audit = { contract: CONTRACT, runId: run.runId, paperId: request.paperId,
            candidateIdentitySha256: request.candidateIdentitySha256, patchFileSha256: requestFile.sha256,
            sourceSha256: request.sourceSha256, reason: request.reason,
            beforeDraftSha256: repair.hashDraft(payload.draft), afterDraftSha256: repair.hashDraft(draft),
            oldPayloadSha256: before.value.payloadSha256, oldEnvelopeSha256: before.sha256,
            archive: path.relative(runDir, archiveDir), appliedAt: deps.now() };
        let intent;
        try {
            assertSafeDirectory(archiveDir);
            intent = readPrivate(path.join(archiveDir, 'intent.json')).value;
            if (!same({ ...intent.audit, appliedAt: audit.appliedAt }, audit)) throw new Error('Operator patch pending intent drifted');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const committedAudit = intent?.audit || audit;
        const updated = { ...payload, draft, rawDraft: JSON.stringify(draft), status: 'failed',
            operatorPatches: [...(payload.operatorPatches || []), committedAudit] };
        const expectedIntent = { contract: CONTRACT, audit: committedAudit, afterPayloadSha256: repair.hashDraft(updated) };
        if (intent && !same(intent, expectedIntent)) throw new Error('Operator patch pending payload changed');
        if (Buffer.byteLength(JSON.stringify({ version: repair.REPAIR_VERSION, identity,
            payload: updated, payloadSha256: repair.hashDraft(updated) })) > 20 * 1024 * 1024) {
            throw new Error('Operator patch exceeds the Reader candidate size budget');
        }
        // No candidate/audit writes occur before the complete parser succeeds.
        assertSafeDirectory(archiveDir, true);
        installImmutable(path.join(archiveDir, 'before.json'), before.bytes);
        installImmutable(path.join(archiveDir, 'patch.json'), requestFile.bytes);
        installImmutable(path.join(archiveDir, 'intent.json'), Buffer.from(JSON.stringify(expectedIntent)));
        syncDirectory(path.dirname(archiveDir));
        syncDirectory(path.join(runDir, 'patches'));
        if (deps.afterArchive) await deps.afterArchive();
        if (readPrivate(candidateFile).sha256 !== before.sha256 || readPrivate(filename).sha256 !== requestFile.sha256) {
            throw new Error('Operator patch candidate/request bytes changed before save');
        }
        repair.saveFailedCandidate(directory, identity, updated);
        syncDirectory(directory);
        if (deps.afterSave) await deps.afterSave();
        const saved = repair.loadFailedCandidate(directory, identity);
        if (!same(saved, updated)) throw new Error('Operator patch save did not replay');
        return { runId: run.runId, paperId: request.paperId, status: 'failed', operatorPatchApplied: true,
            alreadyApplied: false, draftSha256: committedAudit.afterDraftSha256, patchFileSha256: requestFile.sha256,
            archive: committedAudit.archive };
    });
}

module.exports = { CONTRACT, applyOperatorPatch, patchPath, readerOperatorParserOptions: parserOptions };
