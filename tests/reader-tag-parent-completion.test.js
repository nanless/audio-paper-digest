'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const base = path.resolve('data/runtime/daily-20261016-full/triage/final-completion-20261017');
const previewFile = path.join(base, 'b/three-review-failures-public-attempt3/2610.21941-public-preview-paper.json');
const inputsFile = path.join(base, 'execution/three-review-failures-inputs-v3.json');
const actualAvailable = fs.existsSync(previewFile) && fs.existsSync(inputsFile);
const read = file => JSON.parse(fs.readFileSync(file));

test('真实Teacher标签父包与已保存Reader子稿：冷完成、严格负例和新子包预览', { skip: !actualAvailable }, async t => {
    for (const module of ['node:http', 'node:https']) t.mock.method(require(module), 'request', () => assert.fail('no network'));
    const utils = require('../scripts/utils');
    t.mock.method(utils, 'requestLlmJson', () => assert.fail('no model request'));
    const daily = require('../scripts/lib/daily-fresh-source-plan'), facts = require('../scripts/lib/daily-fact-review');
    const saved = require('../scripts/lib/saved-fact-feedback'), pending = require('../scripts/lib/pending-fact-feedback');
    const completed = require('../scripts/lib/completed-bound-fact-feedback'), engine = require('../scripts/analysis-engine');
    const inputs = read(inputsFile), entry = inputs.entries.find(row => row.paperId === '2610.21941');
    const beforeFile = path.join(base, 'execution/three-reviewed-signed-actual-execution/formal-before.json');
    const data = read(beforeFile), plan = daily.requireDailyFreshSourceRecoveryPlan(data, { papers: data.papers });
    const paper = read(previewFile), feedback = read(entry.feedbackFile);
    const source = daily.readDailyFreshSource(plan, paper);
    assert.equal(source.freshSourceDescriptor.sourceSha256, feedback.sourceFiles['source.txt']);
    const parentProof = paper.analysisManifest.stages.tagSelection.factReview;
    const parentFile = path.join(daily.factFeedbackDirectory(plan), parentProof.feedbackSha256 + '.json');
    const childFile = path.join(daily.factFeedbackDirectory(plan), paper.analysisManifest.stages.apiReaderArticle.factReview.feedbackSha256 + '.json');
    const parent = read(parentFile), actualFormal = require('../scripts/config').FILES.deepAnalysisResult;
    const formalBytes = fs.readFileSync(actualFormal), original = JSON.stringify(paper);
    const feeDir = path.resolve('data/runtime/llm-usage');
    const fees = () => fs.readdirSync(feeDir).filter(n => n.endsWith('.json')).sort().map(n =>
        [n, crypto.createHash('sha256').update(fs.readFileSync(path.join(feeDir, n))).digest('hex')]);
    const originalFees = fees();
    await t.test('真实四源/原tag父/已保存子稿与真正pending全部通过，且不清除义务', () => {
        const value = structuredClone(paper); value.analysisFactReviewObligation = facts.proofFor(feedback);
        const recovered = saved.readSavedFeedback(value, plan);
        assert.equal(recovered.savedParentStage, 'tagSelection');
        assert.deepEqual(recovered.feedback, parent); assert.deepEqual(recovered.readerFeedback, feedback);
        assert.equal(saved.completedReaderUpstream(value, plan), true);
        assert.equal(completed.hasCompletedBoundFactFeedbackStages(value, feedback, plan), true);
        assert.equal(pending.completed(value, plan), true);
        assert.deepEqual(value.analysisFactReviewObligation, facts.proofFor(feedback));
    });
    await t.test('缺失原父文件不能由当前子包或ALS补造', t => {
        const exists = fs.existsSync; t.mock.method(fs, 'existsSync', file => String(file) === parentFile ? false : exists(file));
        assert.equal(saved.readSavedFeedback(paper, plan), null);
        assert.equal(completed.hasCompletedBoundFactFeedbackStages(paper, feedback, plan), false);
    });
    await t.test('多父、伪tag阶段、非tag阶段冒用父证明均拒绝', () => {
        for (const mutate of [
            p => { p.analysisManifest.stages.coreSummaryRepair.factReview = parentProof; },
            p => { p.analysisManifest.stages.tagSelection.status = 'failed'; },
            p => { p.analysisManifest.stages.tagSelection.registrySha256 = '0'.repeat(64); },
            p => { p.analysisManifest.stages.revision.factReview = parentProof; },
            p => { p.fullStageReanalysis = { currentFeedbackProof: parentProof }; }
        ]) {
            const value = structuredClone(paper); mutate(value);
            assert.equal(completed.hasCompletedBoundFactFeedbackStages(value, feedback, plan), false);
        }
    });
    await t.test('原tag错误或Reader错误原句仍存在即拒绝', () => {
        const oldTag = structuredClone(paper); oldTag.analysis += '\n' + parent.rejectedTagClaims[0];
        assert.throws(() => saved.readSavedFeedback(oldTag, plan), /核心摘要正文绑定已过期/);
        const oldReader = structuredClone(paper); oldReader.apiReaderArticle += '\n' + feedback.rejectedReaderClaims[0];
        assert.equal(completed.hasCompletedBoundFactFeedbackStages(oldReader, feedback, plan), false);
    });
    await t.test('假四源与错误子包身份仍拒绝', () => {
        const bad = structuredClone(feedback); bad.sourceFiles['source.pdf'] = '0'.repeat(64);
        assert.throws(() => completed.hasCompletedBoundFactFeedbackStages(paper, bad, plan), /来源SHA已过期/);
        const value = structuredClone(paper); value.analysisManifest.stages.apiReaderArticle.factReview = parentProof;
        assert.equal(completed.hasCompletedBoundFactFeedbackStages(value, feedback, plan), false);
    });
    await t.test('普通已验证Reader作用域仍不能补造未保存子包', async t => {
        const exists = fs.existsSync; t.mock.method(fs, 'existsSync', file => String(file) === childFile ? false : exists(file));
        assert.equal(saved.readSavedFeedback(paper, plan), null);
        const bound = facts.validateFeedback(feedback, plan, paper), parentBound = facts.validateFeedback(parent, plan, paper);
        await engine.withPaperAnalysisLock(paper, () => facts.withFactReview(parentBound, () =>
            facts.withReaderFactReview(bound, paper, () => {
                assert.equal(saved.readSavedFeedback(paper, plan), null);
                assert.equal(completed.hasCompletedBoundFactFeedbackStages(paper, feedback, plan), false);
                const wrongPaper = structuredClone(paper); wrongPaper.arxivId = '2610.00001v1';
                assert.equal(saved.readSavedFeedback(wrongPaper, plan), null);
            })));
        assert.equal(saved.readSavedFeedback(paper, plan), null);
    });
    await t.test('真实完整三篇公共prepare和Teacher preview执行事实义务门槛', async t => {
        const signed = require('../scripts/lib/daily-reader-signed-correction'), fresh = require('../scripts/lib/fresh-analysis-context');
        const feedbacks = new Map(inputs.entries.map(e => [e.paperId, read(e.feedbackFile)]));
        const ids = inputs.entries.map(e => e.paperId), handle = await signed.prepare(inputs.manifestFile, plan, data.papers, feedbacks, ids);
        const parentPaper = data.papers.find(p => p.arxivId.startsWith('2610.21941'));
        const run = () => daily.withDailyFreshAnalysisContext(plan, () => engine.withPaperAnalysisLock(parentPaper, () =>
            fresh.withFreshPaperContext(parentPaper, () => daily.withDailyFreshPaperSource(plan, structuredClone(parentPaper), () =>
                signed.preview(handle, structuredClone(parentPaper)), { fetchFigure: () => assert.fail('no image fetch') }))));
        const result = await run(); assert.equal(result.apiReaderArticleSha256, paper.apiReaderArticleSha256);
        assert.equal(result.analysisFactReviewObligation, undefined, 'preview cannot install a duty');
        const exists = fs.existsSync;
        t.mock.method(fs, 'existsSync', file => String(file) === childFile ? false : exists(file));
        assert.equal(signed.readOnlyPreviewFeedback(paper.analysisManifest.stages.apiReaderArticle.factReview), null);
        const unsavedPreview = await run();
        assert.equal(unsavedPreview.apiReaderArticleSha256, paper.apiReaderArticleSha256);
        assert.equal(signed.readOnlyPreviewFeedback(paper.analysisManifest.stages.apiReaderArticle.factReview), null);
        const check = completed.hasCompletedBoundFactFeedbackStages;
        let checks = 0; t.mock.method(completed, 'hasCompletedBoundFactFeedbackStages', (...args) => { checks++; return check(...args); });
        await run(); assert.equal(checks, 1, 'preview now checks the actual completion predicate');
        t.mock.method(completed, 'hasCompletedBoundFactFeedbackStages', () => false);
        await assert.rejects(run(), /当前来源绑定的事实反馈尚未完成/);
    });
    assert.equal(JSON.stringify(paper), original);
    assert.deepEqual(fs.readFileSync(actualFormal), formalBytes);
    assert.deepEqual(fees(), originalFees);
});
