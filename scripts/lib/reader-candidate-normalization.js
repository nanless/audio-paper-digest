'use strict';
const normalizationCodec = require('./protocol-codec');
// A deterministic draft preparation write, never a response, attempt or success.
// The original envelope and transition are immutable; all paid/budget/history
// fields come from the actual CAS parent, not from a caller's draft snapshot.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const repair = require('./reader-repair');
const { writeExact, readRegular } = require('./publication-file-primitives');
const CONTRACT = 'reader-candidate-normalization';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function failure(cause) {
    if (cause?.code === 'READER_NORMALIZATION_CAS_CHANGED') return cause;
    return Object.assign(new Error('Reader candidate normalization persistence failed: ' + cause.message, { cause }), {
        code: 'READER_NORMALIZATION_NOT_PERSISTED', scope: 'run', retryable: false });
}
function persist({ directory, identity, snapshot }) {
    let ownedEnvelopeSha256 = snapshot.expectedEnvelopeSha256;
    try {
        const checked = repair.readFailedCandidateEnvelope(directory, identity);
        if (!checked || checked.envelopeSha256 !== snapshot.expectedEnvelopeSha256) {
            throw Object.assign(new Error('Reader candidate normalization CAS changed'), { code: 'READER_NORMALIZATION_CAS_CHANGED', scope: 'run', retryable: false });
        }
        const filename = path.join(directory, repair.hashDraft(identity) + '.json');
        const parent = readRegular(filename);
        if (parent.sha256 !== checked.envelopeSha256) throw new Error('Parent envelope bytes changed');
        const payload = { ...checked.envelope.payload, draft: snapshot.draft,
            draftOrderMappings: snapshot.draftOrderMappings, issues: snapshot.issues };
        if (!repair.parseRecoveryDraft(payload.draft) || !Array.isArray(payload.issues)
            || !Array.isArray(payload.draftOrderMappings)) throw new Error('Normalization snapshot is not a failed draft');
        const archive = path.join(directory, 'normalizations'), prefix = checked.envelopeSha256 + '-' + repair.hashDraft(payload.draft);
        writeExact(path.join(archive, checked.envelopeSha256 + '.parent.json'), parent.bytes);
        const transition = { ...normalizationCodec.recordHeader(CONTRACT, CONTRACT), notLlmResponse: true, notSuccess: true,
            identitySha256: repair.hashDraft(identity), parentEnvelopeSha256: checked.envelopeSha256,
            beforeDraftSha256: repair.hashDraft(checked.envelope.payload.draft), afterDraftSha256: repair.hashDraft(payload.draft),
            beforePayloadSha256: checked.envelope.payloadSha256, afterPayloadSha256: repair.hashDraft(payload) };
        writeExact(path.join(archive, prefix + '.json'), Buffer.from(JSON.stringify(transition) + '\n'));
        repair.saveFailedCandidate(directory, identity, payload, { expectedEnvelopeSha256: checked.envelopeSha256 });
        const after = repair.readFailedCandidateEnvelope(directory, identity);
        if (!after || !isDeepStrictEqual(after.envelope.payload, payload)) throw new Error('Saved normalized candidate differs from CAS result');
        ownedEnvelopeSha256 = after.envelopeSha256;
        writeExact(path.join(archive, prefix + '.applied.json'), Buffer.from(JSON.stringify({ ...normalizationCodec.recordHeader(CONTRACT, CONTRACT),
            transitionSha256: sha(Buffer.from(JSON.stringify(transition) + '\n')), envelopeSha256: after.envelopeSha256 }) + '\n'));
        return after;
    } catch (cause) {
        const error = failure(cause);
        // A paid response may need its normal failure record after a disk
        // fault. That path may only save against the last parent we owned,
        // never against a newly observed or concurrently replaced envelope.
        if (error.code !== 'READER_NORMALIZATION_CAS_CHANGED') Object.defineProperty(error,
            'normalizationExpectedEnvelopeSha256', { value: ownedEnvelopeSha256 });
        throw error;
    }
}
function createWriter({ directory, identity, isActive }) {
    let pending = null;
    return {
        queue(snapshot) {
            // A newer normalization in the same active request supersedes only
            // the pending view; the physical parent must remain exactly fixed.
            if (pending && pending.expectedEnvelopeSha256 !== snapshot.expectedEnvelopeSha256) {
                throw failure(new Error('Pending normalization has another parent'));
            }
            pending = structuredClone(snapshot);
            if (!isActive()) return this.flush();
        },
        flush() {
            if (isActive()) throw failure(new Error('Active ordinal capability protects its parent'));
            if (!pending) return null;
            const result = persist({ directory, identity, snapshot: pending }); pending = null; return result;
        }
    };
}
module.exports = { CONTRACT, createWriter };
