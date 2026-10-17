'use strict';
// Synthetic control-flow and protected-field tests only. Scientific predicates
// are explicit doubles; these tests grant no source or publication capability.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');
function fixture() {
    const source = fs.readFileSync(require.resolve('../scripts/lib/conference-reader-operator-correction'), 'utf8');
    const fields = source.match(/const CHECKPOINT_FAILURE_FIELDS = Object\.freeze\((\[[\s\S]*?\])\);/u)[1];
    const start = source.indexOf('function assertReaderFailureProjection(');
    const end = source.indexOf('function assertOutput(', start);
    const raw = { id: 'conference:synthetic:paper', analysis: null, parsed: null,
        analysisCheckpoint: 'Exact scoring checkpoint', analysisStageCheckpoints: { scoringAudit: 'Exact scoring checkpoint' },
        error: 'Original Reader failure', errorCode: 'READER_REPAIR_NO_PROGRESS', errorScope: 'paper',
        latestAnalysisAttemptError: 'Original Reader failure', latestAnalysisAttemptErrorCode: 'READER_REPAIR_NO_PROGRESS',
        latestAnalysisAttemptErrorScope: 'paper', latestAnalysisAttemptErrorCategory: 'reader_recovery',
        latestAnalysisAttemptCustom: 'protected unknown field',
        digestStatus: { latestAttemptStatus: 'analysis_failed', unrelated: 'retained' },
        analysisManifest: { stages: { primaryAnalysis: { status: 'complete', attempts: 1 },
            scoringAudit: { status: 'complete', attempts: 2 }, apiReaderArticle: { status: 'invalid_output', attempts: 6, fullAttempts: 2 } } } };
    const projected = structuredClone(raw); projected.analysis = raw.analysisCheckpoint;
    const paper = structuredClone(projected); paper.apiReaderArticle = 'Synthetic newly returned Reader';
    paper.analysisManifest.stages.apiReaderArticle = { status: 'complete', attempts: 6, fullAttempts: 2 };
    const active = { rawBeforePaper: raw, beforePaper: projected, mainCheckpointRecovery: {}, cold: false };
    let current = active, lock = true, reader = true, complete = true, images = true;
    const events = [];
    let h;
    h = require('node:vm').runInNewContext(`const CHECKPOINT_FAILURE_FIELDS = Object.freeze(${fields});\n`
        + source.slice(start, end) + '\n({assertReaderFailureProjection, finalizeReaderFailure, protectedPaper})', {
        clone: structuredClone,
        isDeepStrictEqual: (a, b) => isDeepStrictEqual(structuredClone(a), structuredClone(b)),
        mutableReaderFields: new Set(['apiReaderArticle']), scope: { getStore: () => current },
        fail: message => { throw new Error(message); },
        assertOutput(value, result) {
            events.push('output'); h.assertReaderFailureProjection(value, result);
            assert.deepEqual(structuredClone(h.protectedPaper(result)), structuredClone(h.protectedPaper(value.beforePaper)));
        },
        assertCheckpointImageSupplement(_value, _paper, required) {
            events.push('images'); assert.equal(required, true); if (!images) throw new Error('Missing normal official-image closure');
        },
        require(name) {
            if (name === './conference-postprocess') return { readOriginalTagProof: () => ({ rules: { fixtureOnly: true } }) };
            assert.equal(name, '../analysis-engine');
            return { paperAnalysisLockHeld: () => lock,
                hasValidApiReaderV3Records(value) {
                    events.push('reader'); assert.equal(value, paper); return reader;
                },
                isSuccessfulAnalysisRecordForReadOnlyConferencePublication(value) {
                    events.push('complete-view');
                    assert.equal(value.latestAnalysisAttemptError, undefined);
                    assert.equal(value.error, undefined);
                    assert.equal(value.digestStatus.latestAttemptStatus, 'analyzed');
                    assert.equal(paper.latestAnalysisAttemptError, 'Original Reader failure', 'actual object has not yet been cleared');
                    assert.equal(value.analysis, raw.analysisCheckpoint);
                    return complete;
                } };
        }
    });
    return { ...h, raw, active, paper, events,
        set(values) { if ('scope' in values) current = values.scope; if ('lock' in values) lock = values.lock;
            if ('reader' in values) reader = values.reader; if ('complete' in values) complete = values.complete;
            if ('images' in values) images = values.images; } };
}
test('only a separately qualified clean view closes actual Reader failures; original package/history are unchanged', () => {
    const f = fixture(), before = structuredClone(f.raw);
    const checkpoints = structuredClone(f.paper.analysisStageCheckpoints);
    const stages = structuredClone(f.paper.analysisManifest.stages);
    assert.equal(f.finalizeReaderFailure(f.paper), f.paper);
    assert.deepEqual(f.events, ['output', 'images', 'reader', 'complete-view', 'output']);
    assert.equal(f.paper.latestAnalysisAttemptError, undefined); assert.equal(f.paper.error, undefined);
    assert.equal(f.paper.digestStatus.latestAttemptStatus, 'analyzed');
    assert.equal(f.paper.digestStatus.unrelated, 'retained');
    assert.equal(f.paper.latestAnalysisAttemptCustom, 'protected unknown field');
    assert.deepEqual(f.paper.analysisStageCheckpoints, checkpoints);
    assert.deepEqual(f.paper.analysisManifest.stages, stages);
    assert.deepEqual(f.raw, before); assert.equal(f.raw.analysis, null);
    assert.doesNotThrow(() => f.assertReaderFailureProjection({ ...f.active, cold: true }, f.paper));
});
test('Reader/image/full qualification failure leaves every original failure field on the actual object', () => {
    for (const values of [{ reader: false }, { images: false }, { complete: false }]) {
        const f = fixture(); f.set(values); const before = structuredClone(f.paper);
        assert.throws(() => f.finalizeReaderFailure(f.paper)); assert.deepEqual(f.paper, before);
    }
});
test('separate old error channels cannot hide nonReader, run-level or quota/integrity failures', () => {
    for (const mutate of [
        p => { p.errorCode = 'CORE_SUMMARY_INVALID'; },
        p => { p.latestAnalysisAttemptErrorCode = 'AUTH_FAILED'; },
        p => { p.errorScope = 'run'; }, p => { p.latestAnalysisAttemptErrorScope = 'run'; },
        p => { p.errorCategory = 'quota'; }, p => { p.latestAnalysisAttemptErrorCategory = 'integrity'; },
        p => { delete p.errorCode; delete p.latestAnalysisAttemptErrorCode; }
    ]) {
        const f = fixture(); mutate(f.raw); const before = structuredClone(f.paper);
        assert.throws(() => f.finalizeReaderFailure(f.paper), /非Reader或运行级/); assert.deepEqual(f.paper, before);
        assert.equal(f.events.length, 0);
    }
});
test('failure projection rejects new/changed fields, arbitrary digest changes and unknown attempt metadata edits', () => {
    for (const mutate of [
        p => { p.error = 'changed'; }, p => { p.errorCategory = 'new'; },
        p => { p.digestStatus.latestAttemptStatus = 'pending'; },
        p => { delete p.digestStatus; }, p => { p.digestStatus.unrelated = 'changed'; },
        p => { p.latestAnalysisAttemptCustom = 'changed'; }
    ]) {
        const f = fixture(); mutate(f.paper);
        assert.throws(() => f.finalizeReaderFailure(f.paper));
    }
});
test('a real hot scope and paper lock are required; cold or unscoped callers cannot clear anything', () => {
    for (const values of [{ scope: null }, { lock: false }]) {
        const f = fixture(); f.set(values); const before = structuredClone(f.paper);
        assert.throws(() => f.finalizeReaderFailure(f.paper), /真实热scope和论文锁/); assert.deepEqual(f.paper, before);
    }
    const f = fixture(); f.active.cold = true;
    assert.throws(() => f.finalizeReaderFailure(f.paper), /真实热scope和论文锁/);
});
