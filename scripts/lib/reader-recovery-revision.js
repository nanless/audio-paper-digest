'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { getFreshAnalysisContext } = require('./fresh-analysis-context.js');
const { loadFailedCandidate, saveFailedCandidate, hashDraft, IMPLEMENTATION_ALLOWANCE_CONTRACT } = require('./reader-repair.js');
const { normalizeReaderDraftOrder } = require('./reader-draft-order.js');
const CONTRACT = 'reader-recovery-diagnostics-revision-v1';
const ALLOWED_FIELDS = Object.freeze(['repairImplementationSha256', 'tableCompilerSha256', 'draftOrderContract',
    'draftOrderImplementationSha256', 'sourceDiagnosticsImplementationSha256',
    'parserImplementationSha256', 'editorialImplementationSha256', 'mechanicalContractSha256']);
const implementationFields = ALLOWED_FIELDS.filter(field => field.endsWith('Sha256'));
const withoutRevisionFields = identity => Object.fromEntries(Object.entries(identity)
    .filter(([key]) => !ALLOWED_FIELDS.includes(key)));

function readEnvelope(filename) {
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 20 * 1024 * 1024 || (stat.mode & 0o777) !== 0o600) {
            throw new Error('Unsafe Reader recovery revision candidate');
        }
        const bytes = fs.readFileSync(fd);
        return { envelope: JSON.parse(bytes.toString('utf8')),
            envelopeSha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function finishRevisionArchives(directory, identity, payload) {
    for (const audit of payload.readerRecoveryRevisions || []) {
        if (audit.contract !== CONTRACT || audit.runId !== identity.freshAnalysis?.runId
            || audit.fromIdentitySha256 === hashDraft(identity)
            || !/^[a-f0-9]{64}$/.test(audit.fromIdentitySha256 || '')
            || !/^[a-f0-9]{64}$/.test(audit.oldPayloadSha256 || '')
            || !/^[a-f0-9]{64}$/.test(audit.oldEnvelopeSha256 || '')
            || !new RegExp(`^${audit.fromIdentitySha256}\\.migrated-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.json$`).test(audit.archivedName || '')) {
            throw new Error('Invalid Reader diagnostic revision archive audit');
        }
        const original = path.join(directory, `${audit.fromIdentitySha256}.json`);
        const archived = path.join(directory, audit.archivedName);
        const verify = filename => {
            const checked = readEnvelope(filename);
            if (checked.envelopeSha256 !== audit.oldEnvelopeSha256
                || hashDraft(checked.envelope.identity) !== audit.fromIdentitySha256
                || checked.envelope.payloadSha256 !== audit.oldPayloadSha256
                || hashDraft(checked.envelope.payload) !== audit.oldPayloadSha256) {
                throw new Error('Reader diagnostic revision archive/source bytes drifted');
            }
            return checked;
        };
        let archiveExists = false;
        try { fs.lstatSync(archived); archiveExists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (archiveExists) {
            verify(archived);
            try { fs.lstatSync(original); throw new Error('Reader diagnostic revision has duplicate unarchived evidence'); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        } else {
            // Install-new / rename-old is deliberately recoverable. An exact
            // new candidate is not ready until the old complete bytes are CAS
            // verified and the missing archival step has been completed.
            const checked = verify(original);
            if (hashDraft(loadFailedCandidate(directory, checked.envelope.identity)) !== audit.oldPayloadSha256) {
                throw new Error('Reader diagnostic revision old payload drifted before archive');
            }
            fs.renameSync(original, archived);
            verify(archived);
        }
    }
    return payload;
}

function loadReaderRecoveryRevision(directory, identity, options = {}) {
    const expectedPixels = options.pixelEvidenceSha256;
    if (expectedPixels !== undefined && !/^[a-f0-9]{64}$/.test(expectedPixels)) {
        throw new Error('Reader recovery pixel evidence identity is invalid');
    }
    const verifyPixels = payload => {
        if (expectedPixels !== undefined && hashDraft(payload?.imageEvidence || []) !== expectedPixels) {
            throw new Error('Reader failed candidate image evidence drifted; refusing to migrate pixel-dependent narration');
        }
    };
    const exact = loadFailedCandidate(directory, identity);
    if (exact) { verifyPixels(exact); return finishRevisionArchives(directory, identity, exact); }
    const context = getFreshAnalysisContext();
    if (context?.refreshReaderDiagnostics !== true) return null;
    if (path.resolve(directory) !== path.join(context.runDir, 'reader-attempts')
        || identity?.freshAnalysis?.runId !== context.runId
        || identity.freshAnalysis.paperId !== identity.paperId
        || identity.sourceSha256 !== context.sourceExpectations[identity.paperId]?.sourceSha256
        || identity.freshAnalysis.sourceSha256 !== identity.sourceSha256
        || identity.freshAnalysis.structuredArtifactsSha256 !== context.sourceExpectations[identity.paperId]?.structuredArtifactsSha256) {
        throw new Error('Reader diagnostic revision must remain in the exact fresh run/source scope');
    }
    let names;
    try { names = fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort(); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const compatible = [];
    for (const name of names) {
        const { envelope, envelopeSha256 } = readEnvelope(path.join(directory, name));
        if (!envelope?.identity || name !== `${hashDraft(envelope.identity)}.json`) {
            throw new Error('Corrupt Reader diagnostic revision identity/filename');
        }
        // The ordinary loader remains the authority for envelope, private file,
        // JSON safety, payload hash, root shape and persisted counter validation.
        const payload = loadFailedCandidate(directory, envelope.identity);
        if (!payload || hashDraft(payload) !== envelope.payloadSha256) {
            throw new Error('Reader diagnostic revision candidate changed during audit');
        }
        if (!isDeepStrictEqual(withoutRevisionFields(envelope.identity), withoutRevisionFields(identity))) continue;
        verifyPixels(payload);
        const changedFields = ALLOWED_FIELDS.filter(field => !isDeepStrictEqual(envelope.identity[field], identity[field]));
        if (changedFields.length) compatible.push({ identity: envelope.identity, payload, changedFields, name, envelopeSha256 });
    }
    if (compatible.length > 1) throw new Error('Ambiguous Reader diagnostic revision: multiple compatible candidates');
    if (!compatible.length) return null;
    const old = compatible[0];
    const updated = structuredClone(old.payload);
    if (updated.draft) {
        const normalized = normalizeReaderDraftOrder(updated.draft);
        updated.draft = normalized.draft;
        updated.rawDraft = JSON.stringify(updated.draft);
        if (normalized.mapping.changed) {
            updated.draftOrderMappings = [...(updated.draftOrderMappings || []), normalized.mapping];
        }
    }
    const diagnosticImplementationChanged = implementationFields.some(field => old.changedFields.includes(field));
    const archivedName = `${hashDraft(old.identity)}.migrated-${crypto.randomUUID()}.json`;
    const audit = { contract: CONTRACT, revisedAt: new Date().toISOString(),
        runId: context.runId, paperId: identity.paperId,
        fromIdentitySha256: hashDraft(old.identity), toIdentitySha256: hashDraft(identity),
        changedFields: old.changedFields, archivedName,
        oldPayloadSha256: hashDraft(old.payload), oldEnvelopeSha256: old.envelopeSha256,
        oldNoProgress: updated.noProgress, oldFailureSignature: updated.failureSignature,
        clearedNoProgress: diagnosticImplementationChanged,
        attempts: updated.attempts, fullAttempts: updated.fullAttempts,
        transportFailures: updated.transportFailures ?? 0,
        inputDraftSha256: old.payload.draft ? hashDraft(old.payload.draft) : null,
        outputDraftSha256: updated.draft ? hashDraft(updated.draft) : null };
    if (diagnosticImplementationChanged) {
        updated.noProgress = 0; updated.failureSignature = '';
        updated.validationFailureStreak = 0; updated.validationFailureSignature = '';
        // Preserve paid counters, but allow exactly one new local repair after
        // today's full parser discovers a gate introduced by the new code.
    }
    updated.readerRecoveryRevisions = [...(updated.readerRecoveryRevisions || []), audit];
    delete updated.implementationRepairAllowance;
    updated.implementationRepairAllowanceProof = diagnosticImplementationChanged
        ? implementationAllowanceProof(identity, audit) : null;
    // The normal per-paper lock surrounds the caller. Recheck anyway before
    // installing: never overwrite an exact newer candidate or stale budgets.
    const racedExact = loadFailedCandidate(directory, identity);
    if (racedExact) { verifyPixels(racedExact); return finishRevisionArchives(directory, identity, racedExact); }
    if (hashDraft(loadFailedCandidate(directory, old.identity)) !== hashDraft(old.payload)) {
        throw new Error('Reader diagnostic revision source changed before installation');
    }
    saveFailedCandidate(directory, identity, updated);
    finishRevisionArchives(directory, identity, updated);
    // Still a failed recovery input, never an accepted article or proof.
    return loadFailedCandidate(directory, identity);
}

module.exports = { CONTRACT, ALLOWED_FIELDS, loadReaderRecoveryRevision };
function implementationAllowanceProof(identity, audit) {
    const body = { contract: IMPLEMENTATION_ALLOWANCE_CONTRACT,
        fromIdentitySha256: audit.fromIdentitySha256, toIdentitySha256: hashDraft(identity),
        oldPayloadSha256: audit.oldPayloadSha256, revisionAuditSha256: hashDraft(audit),
        changedFields: audit.changedFields.filter(field => implementationFields.includes(field)).sort() };
    return { ...body, allowanceSha256: hashDraft(body) };
}
