'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const realFile = process.env.PD_CURRENT_BATCH_CORRECTION_REAL_FILE;
const realSha256 = process.env.PD_CURRENT_BATCH_CORRECTION_REAL_SHA256;
const realManifest = process.env.PD_CURRENT_BATCH_CORRECTION_REAL_MANIFEST;
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const daily = require('../scripts/lib/daily-fresh-source-plan');
const facts = require('../scripts/lib/daily-fact-review');
const saved = require('../scripts/lib/saved-fact-feedback');
const engine = require('../scripts/analysis-engine');
const signed = require('../scripts/lib/daily-reader-signed-correction');
const stop = require('../scripts/lib/analysis-stop-control');
const codec = require('../scripts/lib/protocol-codec');

function ordinary() {
    const parent = { arxivId: '2611.26409v1', analysis: 'unchanged original analysis',
        apiReaderArticle: '图1是架构图。', apiReaderArticleSha256: 'a'.repeat(64),
        apiReaderPlanSha256: 'b'.repeat(64), analysisManifest: { stages: { apiReaderArticle: {} } } };
    const feedback = { readerFeedback: '图1是能力图。', rejectedReaderClaims: ['图1是架构图。'],
        coreFeedback: '', rejectedCoreClaims: [], sourceFiles: {} };
    const record = { ...codec.recordHeader(signed.FACT_CONTRACT, signed.FACT_CONTRACT), paperId: '2611.26409',
        runId: 'test-run', batchDate: '2026-11-20', parentPaper: structuredClone(parent),
        parentPaperSha256: daily.stableHash(parent), parentArticleSha256: parent.apiReaderArticleSha256,
        parentPlanSha256: parent.apiReaderPlanSha256, feedbackSha256: daily.stableHash(feedback), sourceFiles: {} };
    return { parent, feedback, record, plan: { runId: 'test-run', batchDate: '2026-11-20' } };
}
function fixture(t) {
    t.mock.method(saved, 'readSavedFeedback', () => null);
    t.mock.method(saved, 'completedReaderUpstream', () => true);
    t.mock.method(engine, 'isSuccessfulAnalysisRecord', () => {
        assert.throws(() => stop.assertMayStartRequest(), error => error.code === stop.MODEL_REQUESTS_FORBIDDEN);
        return true;
    });
    return ordinary();
}
test('ordinary current-batch parent retains the full parent checks with model requests forbidden', t => {
    const x = fixture(t);
    assert.doesNotThrow(() => signed.authenticateCurrentBatchCorrectionParent(x.record, x.parent, x.plan, x.feedback));
    const changed = structuredClone(x.parent); changed.analysis += 'changed';
    assert.throws(() => signed.authenticateCurrentBatchCorrectionParent(x.record, changed, x.plan, x.feedback), /CAS/);
    t.mock.method(saved, 'completedReaderUpstream', () => false);
    assert.throws(() => signed.authenticateCurrentBatchCorrectionParent(x.record, x.parent, x.plan, x.feedback), /真实已完成/);
});
test('missing, malformed, mixed or pending feedback declarations never become ordinary parents', t => {
    const x = fixture(t);
    for (const mutate of [
        p => { p.analysisManifest.stages.apiReaderArticle.factReview = null; },
        p => { p.analysisManifest.stages.apiReaderArticle.factReview = {}; },
        p => { p.analysisManifest.stages.apiReaderArticle.scoringFactReview = null; },
        p => { p.analysisManifest.stages.apiReaderArticle.scoringFactReview = {}; },
        p => { p.analysisManifest.stages.apiReaderArticle.factReview = { feedbackSha256: 'a' }; p.analysisManifest.stages.other = { factReview: { feedbackSha256: 'b' } }; },
        p => { p.analysisFactReviewObligation = null; },
        p => { p.fullStageReanalysis = { currentFeedbackProof: null }; }
    ]) {
        const bad = structuredClone(x.parent); mutate(bad);
        assert.throws(() => signed.authenticateCurrentBatchCorrectionParent(x.record, bad, x.plan, x.feedback), /声明缺失或损坏/);
    }
    t.mock.method(saved, 'readSavedFeedback', () => { throw Error('damaged original packet'); });
    assert.throws(() => signed.authenticateCurrentBatchCorrectionParent(x.record, x.parent, x.plan, x.feedback), /damaged original packet/);
});
test('the original single-core-feedback branch remains authenticated and mixed feedback stays rejected', t => {
    const x = ordinary(), old = { feedback: { coreFeedback: 'old core correction', readerFeedback: '' }, paper: x.parent };
    t.mock.method(saved, 'readSavedFeedback', () => old);
    t.mock.method(saved, 'completedReaderUpstream', () => true);
    t.mock.method(engine, 'isSuccessfulAnalysisRecord', () => true);
    let reads = 0;
    t.mock.method(facts, 'validateFeedback', (feedback, plan, parent) => {
        assert.equal(feedback, old.feedback); assert.equal(plan, x.plan); assert.equal(parent, x.parent); return old;
    });
    t.mock.method(facts, 'withReadOnlySavedFactReview', (bound, callback) => { assert.equal(bound, old); reads++; return callback(); });
    signed.authenticateCurrentBatchCorrectionParent(x.record, x.parent, x.plan, x.feedback);
    assert.equal(reads, 1);
    old.readerFeedback = { readerFeedback: 'mixed child' };
    assert.throws(() => signed.authenticateCurrentBatchCorrectionParent(x.record, x.parent, x.plan, x.feedback), /单一已保存核心反馈/);
});

test('single saved reader-only parent is authenticated only when child inherits all prior Reader constraints', t => {
    const x = ordinary();
    const oldReader = {
        coreFeedback: '', rejectedCoreClaims: [],
        readerFeedback: '旧Reader约束。', rejectedReaderClaims: ['旧错句'], sourceQuotes: ['verbatim quote']
    };
    const old = { feedback: oldReader, paper: x.parent };
    t.mock.method(saved, 'readSavedFeedback', () => old);
    t.mock.method(saved, 'completedReaderUpstream', () => true);
    t.mock.method(engine, 'isSuccessfulAnalysisRecord', () => true);
    let reads = 0;
    t.mock.method(facts, 'validateFeedback', () => old);
    t.mock.method(facts, 'withReadOnlySavedFactReview', (bound, callback) => { assert.equal(bound, old); reads++; return callback(); });

    // 正例：子反馈完整继承旧Reader反馈、错误句列表和来源引文
    const inheritedChild = {
        ...x.feedback,
        readerFeedback: '旧Reader约束。\n补充修正图1。',
        rejectedReaderClaims: ['旧错句', '图1是架构图。'],
        sourceQuotes: ['verbatim quote']
    };
    const inheritedRecord = { ...x.record, feedbackSha256: daily.stableHash(inheritedChild) };
    signed.authenticateCurrentBatchCorrectionParent(inheritedRecord, x.parent, x.plan, inheritedChild);
    assert.equal(reads, 1);

    // 负例：子反馈遗漏旧Reader约束时必须拒绝
    assert.throws(() => signed.authenticateCurrentBatchCorrectionParent(x.record, x.parent, x.plan, x.feedback),
        /新Reader反馈遗漏旧Reader事实约束/);
});

test('SHA-bound real WeMM correction previews through the full current-batch cold replay without writes',
    { skip: !realFile }, async t => {
        const bytes = fs.readFileSync(realFile);
        assert.equal(facts.sha(bytes), realSha256);
        const data = JSON.parse(bytes), paper = data.papers.find(p => p.arxivId === '2611.26409v1');
        assert.ok(paper); assert.equal(saved.hasSavedProof(paper), false);
        const before = daily.stableHash(paper), plan = daily.readDailyFreshSourcePlan(data.dailyFreshSourceRun);
        const manifest = realManifest;
        const directory = path.dirname(manifest), feedback = facts.readFeedback(path.join(directory, 'feedback.json'));
        const deny = () => { throw Error('REAL_CURRENT_BATCH_REPLAY_NETWORK_FORBIDDEN'); };
        t.mock.method(require('node:net').Socket.prototype, 'connect', deny);
        t.mock.method(require('node:tls'), 'connect', deny);
        for (const name of ['node:http', 'node:https']) for (const method of ['request', 'get']) t.mock.method(require(name), method, deny);
        t.mock.method(globalThis, 'fetch', deny);
        const feedbackDirectory = daily.factFeedbackDirectory(plan);
        const oldPackets = fs.existsSync(feedbackDirectory) ? fs.readdirSync(feedbackDirectory).sort() : [];
        const fresh = require('../scripts/lib/fresh-analysis-context');
        await daily.withDailyFreshAnalysisContext(plan, () => engine.withPaperAnalysisLock(paper, () =>
            daily.withDailyFreshPaperSource(plan, paper, () => fresh.withFreshPaperContext(paper, () => {
                const bound = facts.validateFeedback(feedback, plan, paper);
                return facts.withReaderFactReview(bound, paper, () => {
                    const child = facts.current('2611.26409');
                    assert.ok(child?.readerOnly);
                    facts.withReadOnlyOrdinaryReaderParent(paper, () => {
                        assert.equal(facts.current('2611.26409'), null);
                        assert.throws(() => stop.assertMayStartRequest(), error => error.code === stop.MODEL_REQUESTS_FORBIDDEN);
                    });
                    assert.equal(facts.current('2611.26409'), child);
                    assert.throws(() => facts.withReadOnlyOrdinaryReaderParent(paper, () => { throw Error('parent callback failure'); }), /parent callback failure/);
                    assert.equal(facts.current('2611.26409'), child);
                    assert.throws(() => facts.validateRepairedClaims('apiReaderArticle', paper.apiReaderArticle, paper.arxivId), /错误的原句/);
                    assert.throws(() => facts.withReadOnlyOrdinaryReaderParent(paper, async () => {}), /同步范围/);
                    assert.throws(() => facts.withReadOnlyOrdinaryReaderParent(paper, () => Promise.resolve()), /异步边界/);
                    for (const [object, method, replacement] of [
                        [engine, 'paperAnalysisLockHeld', () => false],
                        [fresh, 'isDailyFreshSourceScope', () => false],
                        [require('../scripts/lib/model-text-sanitization'), 'currentModelInputSource', () => null]
                    ]) {
                        const mocked = t.mock.method(object, method, replacement);
                        try { assert.throws(() => facts.withReadOnlyOrdinaryReaderParent(paper, () => assert.fail('invalid scope callback'))); }
                        finally { mocked.mock.restore(); }
                        assert.equal(facts.current('2611.26409'), child);
                    }
                    const wrong = structuredClone(paper); wrong.arxivId = '2611.00000v1';
                    assert.throws(() => facts.withReadOnlyOrdinaryReaderParent(wrong, () => assert.fail('foreign paper callback')));
                    const malformed = structuredClone(paper); malformed.analysisFactReviewObligation = null;
                    assert.throws(() => facts.withReadOnlyOrdinaryReaderParent(malformed, () => assert.fail('malformed parent callback')));
                });
            }), { fetchFigure: deny })));
        const qualify = engine.hasValidIntegratedApiReaderRecords, rejectedChecks = [];
        t.mock.method(engine, 'hasValidIntegratedApiReaderRecords', (candidate, options = {}) => {
            const diagnostics = [];
            const valid = qualify(candidate, { ...options, diagnostics });
            if (!valid && candidate.arxivId === paper.arxivId) rejectedChecks.push(...diagnostics);
            return valid;
        });
        const result = await stop.withModelRequestsForbidden(async () => {
            const handle = await signed.prepare(manifest, plan, data.papers, new Map([['2611.26409', feedback]]), ['2611.26409']);
            return daily.withDailyFreshAnalysisContext(plan, () => engine.withPaperAnalysisLock(paper, () =>
                daily.withDailyFreshPaperSource(plan, paper, () => require('../scripts/lib/fresh-analysis-context')
                    .withFreshPaperContext(paper, () => signed.preview(handle, paper)), { fetchFigure: deny })));
        }).catch(error => { error.message += '\nActual qualification diagnostics: ' + JSON.stringify(rejectedChecks); throw error; });
        assert.equal(result.apiReaderFigures.length, 2);
        assert.equal(result.apiReaderPlan.tableBindings.length, 4);
        assert.equal(result.apiReaderPlan.formulaBindings.length, 0);
        assert.equal(result.apiReaderArticle.includes(feedback.rejectedReaderClaims[0]), false);
        assert.equal(result.analysisManifest.stages.apiReaderArticle.attempts, paper.analysisManifest.stages.apiReaderArticle.attempts);
        assert.equal(result.analysisManifest.stages.apiReaderArticle.fullAttempts, paper.analysisManifest.stages.apiReaderArticle.fullAttempts);
        assert.equal(daily.stableHash(paper), before);
        assert.deepEqual(fs.readFileSync(realFile), bytes);
        assert.deepEqual(fs.existsSync(feedbackDirectory) ? fs.readdirSync(feedbackDirectory).sort() : [], oldPackets);
        // A separate cold read has neither an active child scope nor a paper
        // lock. The exact real new packet is read from this private run folder;
        // the production fact-feedback directory is never written by the test.
        const privatePacket = path.join(directory, facts.proofFor(feedback).feedbackSha256 + '.json');
        fs.writeFileSync(privatePacket, fs.readFileSync(path.join(directory, 'feedback.json')), { mode: 0o600 });
        const privateDirectory = t.mock.method(daily, 'factFeedbackDirectory', () => directory);
        try {
            assert.equal(facts.current('2611.26409'), null);
            assert.equal(engine.paperAnalysisLockHeld(result), false);
            const diagnostics = [];
            assert.equal(engine.hasValidIntegratedApiReaderRecords(result, { diagnostics }), true, JSON.stringify(diagnostics));
            const wrong = structuredClone(result);
            wrong.analysisManifest.stages.apiReaderArticle.operatorProvenance.parentPaperSha256 = '0'.repeat(64);
            assert.equal(engine.hasValidIntegratedApiReaderRecords(wrong), false);
        } finally { privateDirectory.mock.restore(); }
        assert.deepEqual(fs.existsSync(feedbackDirectory) ? fs.readdirSync(feedbackDirectory).sort() : [], oldPackets);
        fs.writeFileSync(path.join(directory, 'preview-paper.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
        fs.writeFileSync(path.join(directory, 'preflight.json'), JSON.stringify({ prepared: true, previewPassed: true,
            independentColdQualificationPassed: true, scopeNegativeChecksPassed: true,
            formalSha256: facts.sha(bytes), formalUnchanged: true, originalPacketsUnchanged: true,
            figures: result.apiReaderFigures.length, tables: result.apiReaderPlan.tableBindings.length,
            formulas: result.apiReaderPlan.formulaBindings.length, attempts: result.analysisManifest.stages.apiReaderArticle.attempts,
            fullAttempts: result.analysisManifest.stages.apiReaderArticle.fullAttempts }, null, 2) + '\n', { mode: 0o600 });
    });
