'use strict';
const realRecord = process.env.PD_READER_FACT_PRE_REQUEST_REAL_RECORD;
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const helper = require('../scripts/lib/reader-fact-pre-request-recovery');
const repair = require('../scripts/lib/reader-repair');
const claim = '宿主报告已加载其他插件';
const sentence = '如果任一比对失败、必需身份字段缺失、宿主报告已加载其他插件，或宿主没有声明确定性复位与参数回读能力，渲染不会开始。';
const proof = { paperId: '2610.20465', runId: 'e8fb670d-9d73-4a6e-92e0-abb7f7bee53d' };
function paid() { return { version: 'llm-usage-v1', kind: 'request', eventId: '11111111-1111-4111-8111-111111111111',
    ...proof, paperId: proof.paperId + 'v1', stage: 'apiReaderRepair', model: 'test-model', protocol: 'openai_responses',
    at: '2026-10-17T00:00:01.000Z', contentAttempt: 2, transportAttempt: 1,
    outcome: 'completed', transportStarted: true, statusCode: 200, outputTextSha256: 'a'.repeat(64),
    usage: { status: 'reported', totalTokens: 20 } }; }
function parent() { return { analysis: '原主文', apiReaderArticle: sentence,
    analysisManifest: { stages: { apiReaderArticle: { contentMode: 'reader-source-only-v1', attempts: 2,
        model: 'test-model', protocol: 'openai_responses', updatedAt: '2026-10-17T00:00:02.000Z' } } } }; }
function blocked() { return { ...paid(), eventId: '22222222-2222-4222-8222-222222222222',
    at: '2026-10-17T00:00:03.000Z', outcome: 'blocked_before_transport', transportStarted: false,
    statusCode: null, outputTextSha256: null, usage: { status: 'unavailable', inputTokens: null, outputTokens: null, totalTokens: null } }; }
test('真实旧短片段在普通调用与伪造options中仍不授权，完整句原规则保留', () => {
    const draft = { sections: [{ body: sentence }], conceptBridges: [] };
    assert.equal(claim.length, 11);
    assert.throws(() => repair.assertReaderFactLocalCoverage(draft, [claim]), /未获准位置/);
    assert.throws(() => repair.assertReaderFactLocalCoverage(draft, [claim], { verified: true }), /未获准位置/);
    assert.equal(helper.mapVerifiedShortClaim(claim, [{ path: '/sections/0/body', value: sentence, prose: sentence }]), null);
    assert.equal(repair.assertReaderFactLocalCoverage(draft, [sentence])[0].claim, sentence);
});
test('原paid最后响应与签名attempt一致，版本化paper身份比较但原事件不改', () => {
    const event = paid(), before = JSON.stringify(event);
    assert.equal(helper.validateUsage([event, blocked()], parent(), proof), event);
    assert.equal(JSON.stringify(event), before);
});
test('后续HTTP200、网络错误、unknown和paid计数/模型/时间错配均拒', () => {
    const later = blocked();
    for (const mutate of [
        e => Object.assign(e, { outcome: 'completed', transportStarted: true, statusCode: 200, outputTextSha256: 'b'.repeat(64), usage: { status: 'reported', totalTokens: 30 }, contentAttempt: 3 }),
        e => Object.assign(e, { outcome: 'network_error', transportStarted: true }),
        e => Object.assign(e, { outcome: 'unknown' }),
        e => { e.model = 'different'; }
    ]) { const event = structuredClone(later); mutate(event); assert.throws(() => helper.validateUsage([paid(), event], parent(), proof)); }
    for (const mutate of [e => { e.contentAttempt = 1; }, e => { e.model = 'different'; },
        e => { e.protocol = 'different'; }, e => { e.at = 'invalid'; }, e => { e.usage.totalTokens = 0; },
        e => { e.at = '2026-10-17T00:00:04.000Z'; }]) {
        const event = paid(); mutate(event); assert.throws(() => helper.validateUsage([event], parent(), proof));
    }
});
test('真实request_started形状未配terminal拒，同标签strictunsent配对可保留', () => {
    const end = blocked(), start = { ...end, kind: 'request_started', phase: 'authorized_before_transport',
        outcome: 'result_unknown', chargeState: 'unknown' };
    assert.throws(() => helper.validateUsage([paid(), start], parent(), proof), /unknown result/);
    assert.equal(helper.validateUsage([paid(), start, end], parent(), proof).contentAttempt, 2);
    const wrong = { ...end, contentAttempt: 99 };
    assert.throws(() => helper.validateUsage([paid(), start, wrong], parent(), proof), /unknown result/);
});
test('纯门槛constructed fixture不授opaque许可；父与当前仅允许已知失败和同pending', t => {
    const engine = require('../scripts/analysis-engine');
    const oldValid = engine.hasValidApiReaderV3Records, oldIncomplete = engine.getIncompleteAnalysisContentReason;
    engine.hasValidApiReaderV3Records = () => true; engine.getIncompleteAnalysisContentReason = () => null;
    t.after(() => { engine.hasValidApiReaderV3Records = oldValid; engine.getIncompleteAnalysisContentReason = oldIncomplete; });
    const original = parent(), current = { ...structuredClone(original), analysisFactReviewObligation: proof,
        latestAnalysisAttemptError: helper.SEED_ERROR, latestAnalysisAttemptAt: '2026-10-17T00:00:05.000Z', latestAnalysisAttemptRetryable: true };
    helper.validateState(original, current, proof);
    for (const mutate of [p => { p.analysis = '改主文'; }, p => { p.apiReaderArticle += '改句'; },
        p => { p.analysisManifest.stages.apiReaderArticle.attempts++; }, p => { p.analysisFactReviewObligation = {}; },
        p => { p.latestAnalysisAttemptError = '任意旧失败'; }, p => { p.latestAnalysisAttemptErrorCode = 'HTTP_ERROR'; },
        p => { p.analysisManifest.stages.apiReaderArticle.contentMode = 'reader-reviewed-revision-v1'; },
        p => { p.analysisStaleSnapshots = [{ contract: 'fake' }]; }]) {
        const changed = structuredClone(current); mutate(changed); assert.throws(() => helper.validateState(original, changed, proof));
    }
    assert.equal(helper.mapVerifiedShortClaim(claim, [{ path: '/sections/0/body', value: sentence, prose: sentence }]), null);
});

test('真实封存来源与失败当前包：同pending seed、normal快照、唯一句目标及九种误用均严格重验',
    { skip: !realRecord }, async () => {
        const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
        const engine = require('../scripts/analysis-engine'), daily = require('../scripts/lib/daily-fresh-source-plan');
        const facts = require('../scripts/lib/daily-fact-review'), fresh = require('../scripts/lib/fresh-analysis-context');
        const deep = require('../scripts/deep-analyzer'), saved = require('../scripts/lib/saved-fact-feedback');
        const file = require('../scripts/config').FILES.deepAnalysisResult;
        const bytes = fs.readFileSync(file), digest = value => crypto.createHash('sha256').update(value).digest('hex');
        const recordFile = path.resolve(realRecord);
        const record = JSON.parse(fs.readFileSync(recordFile)), data = JSON.parse(bytes);
        const paper = structuredClone(data.papers.find(p => p.arxivId.replace(/v\d+$/, '') === record.paperId));
        const plan = daily.requireDailyFreshSourceRecoveryPlan(data, { papers: data.papers });
        const feedback = facts.readFeedback(path.join(daily.factFeedbackDirectory(plan),
            paper.analysisFactReviewObligation.feedbackSha256 + '.json'));
        await require('../scripts/lib/analysis-stop-control').withModelRequestsForbidden(() =>
            helper.withVerifiedReaderFactPreRequestRecovery(recordFile, () => engine.withPaperAnalysisLock(paper, () =>
                daily.withDailyFreshAnalysisContext(plan, () => daily.withDailyFreshPaperSource(plan, paper, source =>
                    fresh.withFreshPaperContext(paper, () => {
                        const original = saved.readSavedFeedback(paper, plan);
                        const parentBound = facts.validateFeedback(original.feedback, plan, original.paper);
                        const childBound = facts.validateFeedback(feedback, plan, paper);
                        return facts.withFactReview(parentBound, () => facts.withReaderFactReview(childBound, paper, () => {
                            deep.captureStaleAnalysisSnapshot(paper, paper.analysisManifest, 'apiReaderArticle', childBound.proof.feedbackSha256);
                            const review = facts.reviewFeedback('apiReaderArticle', paper.arxivId);
                            assert.equal(deep.hasReviewedReaderFactLocalSeed(paper, source.text, review), true);
                            const seed = deep.prepareApiReaderRevisionSeed(paper, source.text, review, { readerFactLocalRevision: true });
                            const draft = require('../scripts/lib/signed-reader-recovery-draft').convert(seed);
                            const short = feedback.rejectedReaderClaims[0], issues = repair.assertReaderFactLocalCoverage(draft, [short]);
                            assert.equal(issues.length, 1); assert.equal(issues[0].originalClaim, short);
                            assert.ok(issues[0].claim.length >= 12); assert.equal(issues[0].path, '/sections/3/body');
                            const context = repair.buildRepairContext(draft, issues, '', '',
                                { readerFactLocalPaths: issues.map(i => i.path), readerFactLocalClaims: [short] });
                            assert.equal(repair.factLocalSentenceTargets(context).length, 1);
                            for (const modify of [d => { d.sections[4].body += short; },
                                d => { d.sections[3].body = `“${d.sections[3].body}”`; },
                                d => { d.readerTitle = short; },
                                d => { d.sections[4].body = d.sections[3].body; d.sections[3].body = '其他正确说明。'; },
                                d => { d.sections[3].body = '```\n' + d.sections[3].body + '\n```'; },
                                d => { d.sections[3].body = '> ' + d.sections[3].body; },
                                d => { d.sections[3].body = d.sections[3].body.replace(short, '$' + short + '$'); },
                                d => { d.sections[3].body = '| 标头 |\n| --- |\n| ' + short + ' |'; }]) {
                                const changed = structuredClone(draft); modify(changed);
                                assert.throws(() => repair.assertReaderFactLocalCoverage(changed, [short]));
                            }
                            facts.withFactReview(parentBound, () => assert.throws(() => repair.assertReaderFactLocalCoverage(draft, [short])));
                        }));
                    }), { fetchFigure: () => { throw new Error('real readonly regression forbids network'); } })))));
        assert.equal(digest(fs.readFileSync(file)), digest(bytes));
    });
