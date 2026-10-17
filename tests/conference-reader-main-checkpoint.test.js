'use strict';
// Exercise the production private projection without exporting its authority.
// Source/context/scientific predicates are explicit doubles here; real sealed
// source replays are separate runtime evidence, not claimed by these unit tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const stable = require('../scripts/lib/fresh-rewrite-run').stableHash;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture() {
    const file = require.resolve('../scripts/lib/conference-reader-operator-correction');
    const source = fs.readFileSync(file, 'utf8');
    const start = source.indexOf("const MAIN_CHECKPOINT = '");
    const end = source.indexOf('function prepareReaderInput(', start);
    const sourceText = 'Original same-run conference source';
    const checkpoint = 'Exact original scoring checkpoint';
    const raw = { id: 'conference:test:paper', source: 'conference', sourceSha256: sha(sourceText),
        analysis: null, parsed: null, analysisCheckpoint: checkpoint,
        analysisStageCheckpoints: { scoringAudit: checkpoint },
        imageManifest: { totalFound: 0, candidates: [], downloaded: [], selected: [], downloadOutcomes: [] },
        errorCode: 'READER_REPAIR_NO_PROGRESS', error: 'Retained original Reader failure',
        analysisManifest: { sourceAcquisition: { sourceSha256: sha(sourceText) }, stages: {
            scoringAudit: { status: 'complete', outputAnalysisSha256: sha(checkpoint), attempts: 1 },
            apiReaderArticle: { status: 'invalid_output', attempts: 6, fullAttempts: 2 },
            imageDownload: { status: 'no_candidates', attempted: 0, downloaded: 0, outcomes: [] }
        } } };
    const pdf = Object.freeze({ fixtureOnly: true });
    const record = { paperId: raw.id, executionId: 'execution', sourceSha256: raw.sourceSha256 };
    const active = { loaded: { directory: '/fixture/execution', revision: { mode: 'normal-analysis' },
        source: { sourceDetails: { source: 'conference_pdf_text', sourceId: raw.id, text: sourceText, imageInfos: [] } } },
        pdf, beforePaper: raw, beforeRun: { executionId: 'execution' },
        beforeAnalysis: { readerRevisionProgress: { attempts: 2, failures: ['original'] } }, row: { record } };
    let scientificPass = true, calls = 0;
    const context = { paperId: raw.id, executionId: 'execution', executionDir: active.loaded.directory, readerPdfSourceHandle: pdf };
    const actualRequire = require('node:module').createRequire(file);
    const h = require('node:vm').runInNewContext(source.slice(start, end)
        + '\n({projectMainCheckpoint, CHECKPOINT_FAILURE_FIELDS})', {
        sha, clone: structuredClone,
        isDeepStrictEqual: (left, right) => isDeepStrictEqual(structuredClone(left), structuredClone(right)),
        fail: message => { throw new Error(message); },
        require(name) {
            if (name === './conference-analysis-context') return { getConferenceAnalysisContext: () => context };
            if (name === './conference-source-context') return { readerPdfSourceForContext: value => {
                assert.equal(value, pdf); return { assertUnchanged() {} };
            } };
            if (name === './completed-reader-upstream') return { completedReaderUpstream(view, suppliedSource) {
                calls++; assert.equal(view.analysis, checkpoint);
                assert.equal(suppliedSource, active.loaded.source.sourceDetails); return scientificPass;
            } };
            return actualRequire(name);
        }
    });
    function pin() {
        const p = active.beforePaper, stages = p.analysisManifest.stages;
        record.mainCheckpointRecovery = {
            contract: 'conference-reader-main-checkpoint-recovery-v1', rawAnalysisValue: null,
            rawPaperSha256: stable(p), analysisCheckpointSha256: sha(p.analysisCheckpoint),
            scoringCheckpointSha256: sha(p.analysisStageCheckpoints.scoringAudit),
            scoringOutputAnalysisSha256: stages.scoringAudit.outputAnalysisSha256,
            scoringStageSha256: stable(stages.scoringAudit), readerStageSha256: stable(stages.apiReaderArticle),
            originalFailureFieldsSha256: stable(Object.fromEntries(h.CHECKPOINT_FAILURE_FIELDS
                .filter(key => Object.hasOwn(p, key)).map(key => [key, p[key]]))),
            readerRevisionProgressSha256: stable(active.beforeAnalysis.readerRevisionProgress), missingImageSupplement: true
        };
    }
    pin();
    return { ...h, active, raw, record, context, pin, failScience() { scientificPass = false; }, calls: () => calls };
}
test('same-run complete scoring checkpoint projects only a view; raw failure and counters remain intact', () => {
    const f = fixture(), before = structuredClone(f.raw);
    const projected = f.projectMainCheckpoint(f.active);
    assert.equal(projected.analysis, f.raw.analysisStageCheckpoints.scoringAudit);
    assert.deepEqual(projected.parsed, require('../scripts/utils').parseAnalysis(projected.analysis));
    assert.equal(f.calls(), 1);
    assert.deepEqual(f.raw, before);
    const cold = { ...f.active, rawBeforePaper: undefined, beforePaper: structuredClone(before), cold: true };
    assert.deepEqual(f.projectMainCheckpoint(cold), projected);
    assert.deepEqual(cold.mainCheckpointRecovery, f.active.mainCheckpointRecovery);
});
test('projection cannot substitute for scientific qualification or repair another upstream stage', () => {
    const f = fixture(); f.failScience();
    assert.throws(() => f.projectMainCheckpoint(f.active), /科学上游/);
    assert.equal(f.raw.analysis, null); assert.equal(f.calls(), 1);
    assert.equal(f.active.mainCheckpointRecovery, undefined);
});
test('even a repinned record cannot admit missing, mixed, non-Reader or prefilled state', () => {
    const cases = [
        f => { f.active.beforeRun.executionId = 'other'; },
        f => { f.context.readerPdfSourceHandle = {}; },
        f => { f.active.loaded.source.sourceDetails.sourceId = 'other'; },
        f => { f.active.loaded.revision.mode = 'reader-refresh'; },
        f => { f.raw.analysisCheckpoint += 'changed'; },
        f => { f.raw.analysisManifest.stages.scoringAudit.status = 'invalid_output'; },
        f => { f.raw.analysisManifest.stages.scoringAudit.outputAnalysisSha256 = '0'.repeat(64); },
        f => { f.raw.analysisManifest.stages.apiReaderArticle.status = 'complete'; },
        f => { f.raw.errorCode = 'CORE_SUMMARY_INVALID'; },
        f => { f.raw.analysisManifest.stages.imageSupplement = { status: 'skipped' }; },
        f => { f.raw.imageManifest.candidates.push({}); },
        f => { f.raw.analysisManifest.stages.imageDownload.attempted = 1; },
        f => { f.active.loaded.source.sourceDetails.imageInfos.push({}); }
    ];
    for (const change of cases) {
        const f = fixture(); change(f); f.pin();
        assert.throws(() => f.projectMainCheckpoint(f.active));
        assert.equal(f.calls(), 0);
    }
});
test('old failure/revision CAS and nonempty main records cannot be silently repurposed', () => {
    for (const change of [f => { f.raw.error += 'changed'; },
        f => { f.active.beforeAnalysis.readerRevisionProgress.attempts++; },
        f => { f.record.mainCheckpointRecovery.scoringCheckpointSha256 = '0'.repeat(64); }]) {
        const f = fixture(); change(f);
        assert.throws(() => f.projectMainCheckpoint(f.active), /恢复声明/);
    }
    const f = fixture(); f.raw.analysis = 'Existing nonempty main';
    assert.throws(() => f.projectMainCheckpoint(f.active), /非空主文/);
    delete f.record.mainCheckpointRecovery;
    assert.equal(f.projectMainCheckpoint(f.active), f.raw);
    assert.equal(f.calls(), 0);
});
