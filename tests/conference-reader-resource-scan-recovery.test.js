'use strict';
// Private projection unit tests. Context/scientific predicates are explicit
// doubles; these tests do not issue source capabilities or publication proofs.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const stable = require('../scripts/lib/fresh-rewrite-run').stableHash;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture(mode = 'scoring-and-reader') {
    const file = require.resolve('../scripts/lib/conference-reader-operator-correction');
    const code = fs.readFileSync(file, 'utf8');
    const start = code.indexOf('function projectReaderResourceScan('), end = code.indexOf('function projectMainCheckpoint(', start);
    const text = 'Original sealed conference source', sourceSha256 = sha(text);
    const resources = { identitySha256: 'b'.repeat(64), fixtureOnly: true };
    const scan = { status: 'complete', resourceEvidenceContract: 'api-reader-resource-identity-v1', resourceEvidenceSha256: 'a'.repeat(64), unchangedEvidence: 'original' };
    const parent = { id: 'conference:test:paper', source: 'conference', sourceSha256,
        analysis: 'Exact scored main', parsed: { score: 7 }, apiReaderResources: structuredClone(resources),
        analysisManifest: { sourceAcquisition: { sourceSha256 }, stages: {
            openSourceScan: scan, primaryAnalysis: { status: 'complete' }, scoringAudit: { status: 'complete', attempts: 2 },
            taxonomySeal: { status: 'complete' } } } };
    const raw = structuredClone(parent), pdf = Object.freeze({ fixtureOnly: true });
    const revision = { mode, revisionSha256: 'c'.repeat(64), resourcePreflightFileSha256: 'd'.repeat(64) };
    const active = { loaded: { directory: '/fixture/child', revision, resourcePreflight: resources,
        source: { sourceDetails: { source: 'conference_pdf_text', sourceId: raw.id, text } },
        parent: { run: { status: 'complete', executionId: 'parent' }, analysis: { status: 'complete', papers: [parent] },
            analysisFileSha256: 'e'.repeat(64), runFileSha256: 'f'.repeat(64) } },
        pdf, row: { record: { paperId: raw.id, executionId: 'child', sourceSha256 } },
        beforeRun: { executionId: 'child' }, beforeAnalysis: { readerRevisionProgress: {} }, candidate: { identity: { paperId: raw.id } } };
    if (mode === 'scoring-and-reader') active.beforeAnalysis.readerRevisionProgress.scoringCheckpoint = {
        revisionSha256: revision.revisionSha256, sourceSha256, resourceIdentitySha256: resources.identitySha256,
        analysisSha256: sha(raw.analysis), scoringStageSha256: stable(raw.analysisManifest.stages.scoringAudit) };
    const context = { paperId: raw.id, executionId: 'child', executionDir: active.loaded.directory, readerPdfSourceHandle: pdf };
    const preflight = { sha256: revision.resourcePreflightFileSha256, value: structuredClone(resources) };
    let reason = null, sourceOkay = true, replayCount = 0, gateCount = 0;
    const project = require('node:vm').runInNewContext(code.slice(start, end) + '\nprojectReaderResourceScan', {
        path, sha, checkpointStable: stable, hash: stable, clone: structuredClone,
        isDeepStrictEqual: (a, b) => isDeepStrictEqual(structuredClone(a), structuredClone(b)),
        fail: message => { throw Error(message); }, read: name => { assert.equal(name, '/fixture/child/reader-resource-preflight.json'); return preflight; },
        require(name) {
            if (name === './conference-analysis-context') return { getConferenceAnalysisContext: () => context };
            if (name === '../deep-analyzer') return { replayVerifiedReaderResourceIdentity(value, supplied) { replayCount++; assert.deepEqual(value, raw.apiReaderResources); assert.equal(supplied, text); } };
            if (name === './conference-source-context') return { readerPdfSourceForContext: value => { assert.equal(value, pdf); return { assertUnchanged() { if (!sourceOkay) throw Error('source drift'); } }; } };
            if (name === './conference-postprocess') return { readOriginalTagProof: () => ({ rules: { fixture: true } }) };
            if (name === '../analysis-engine') return { getConferenceReaderRefreshUpstreamReason(view) { gateCount++; assert.equal(view.analysisManifest.stages.openSourceScan.resourceEvidenceSha256, resources.identitySha256); return reason; }, scoringAuditBindsFinalAnalysis: () => true, scoringStabilityIsResolved: () => true };
            throw Error('Unexpected dependency ' + name);
        }
    });
    return { active, raw, parent, context, preflight, resources, project,
        failScience() { reason = 'invalid science'; }, driftSource() { sourceOkay = false; }, counts: () => ({ replayCount, gateCount }) };
}
test('same authenticated preflight restores only the inherited scan SHA in hot/cold views', () => {
    for (const mode of ['reader-only', 'scoring-and-reader']) {
        const f = fixture(mode), before = structuredClone(f.raw), view = f.project(f.active, f.raw);
        const expected = structuredClone(before); expected.analysisManifest.stages.openSourceScan.resourceEvidenceSha256 = f.resources.identitySha256;
        assert.deepEqual(view, expected); assert.deepEqual(f.raw, before);
        assert.equal(f.active.resourceScanRecovery.rawPaperSha256, stable(before));
        assert.equal(f.active.resourceScanRecovery.restoredPaperSha256, stable(view));
        assert.equal(f.active.resourceScanRecovery.newApiRequests, 0);
        const cold = { ...f.active, resourceScanRecovery: undefined, cold: true };
        assert.deepEqual(f.project(cold, structuredClone(before)), view);
        assert.deepEqual(cold.resourceScanRecovery, f.active.resourceScanRecovery);
    }
});
test('wrong source/parent/preflight/checkpoint and arbitrary scan changes remain blocked', () => {
    for (const mutate of [
        f => { f.context.readerPdfSourceHandle = {}; }, f => { f.raw.sourceSha256 = '0'.repeat(64); },
        f => { f.active.loaded.parent.run.status = 'running'; }, f => { f.raw.analysisManifest.stages.openSourceScan.unchangedEvidence = 'changed'; },
        f => { f.preflight.sha256 = '0'.repeat(64); }, f => { f.preflight.value.fixtureOnly = false; },
        f => { f.raw.apiReaderResources.identitySha256 = '0'.repeat(64); },
        f => { f.active.beforeAnalysis.readerRevisionProgress.scoringCheckpoint.analysisSha256 = '0'.repeat(64); },
        f => { f.active.beforeAnalysis.readerRevisionProgress.scoringCheckpoint.scoringStageSha256 = '0'.repeat(64); },
        f => { f.active.loaded.revision.mode = 'normal-analysis'; }, f => { f.active.candidate = null; }, f => f.failScience(), f => f.driftSource()
    ]) { const f = fixture(); mutate(f); const bytes = JSON.stringify(f.raw); assert.throws(() => f.project(f.active, f.raw)); assert.equal(JSON.stringify(f.raw), bytes); }
});
test('reader-only cannot project a changed main, score, taxonomy or pretend scoring checkpoint', () => {
    for (const mutate of [f => { f.raw.analysis += 'changed'; }, f => { f.raw.parsed.score++; },
        f => { f.raw.analysisManifest.stages.scoringAudit.attempts++; }, f => { f.raw.analysisManifest.stages.taxonomySeal.status = 'invalid'; },
        f => { f.raw.analysisManifest.stages.methodRepair = { status: 'complete' }; },
        f => { f.raw.analysisStageCheckpoints = { structureRepair: 'changed checkpoint' }; },
        f => { f.active.beforeAnalysis.readerRevisionProgress.scoringCheckpoint = {}; }]) {
        const f = fixture('reader-only'); mutate(f); assert.throws(() => f.project(f.active, f.raw));
    }
});
test('an already matching attachment is a no-op and grants no recovery provenance', () => {
    const f = fixture(); f.raw.analysisManifest.stages.openSourceScan.resourceEvidenceSha256 = f.resources.identitySha256;
    assert.equal(f.project(f.active, f.raw), f.raw); assert.equal(f.active.resourceScanRecovery, null);
    assert.deepEqual(f.counts(), { replayCount: 0, gateCount: 0 });
});
