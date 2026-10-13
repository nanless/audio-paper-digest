'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sourceProject = process.env.PD_MINIMAL_SOURCE_PROJECT;
const utils = require('../scripts/utils');
let observe;
utils.requestLlmJson = (...args) => { assert.ok(observe, '禁止真实模型网络'); return observe(...args); };
const deep = require('../scripts/deep-analyzer');
const fresh = require('../scripts/lib/fresh-analysis-context');
const daily = require('../scripts/lib/daily-fresh-source-plan');
const facts = require('../scripts/lib/daily-fact-review');
const engine = require('../scripts/analysis-engine');
for (const id of ['2610.07906', '2610.07466']) {
    test(`真实${id}公共生成请求展示不带完整DOM归档，仍保来源和完整稿身份`, { skip: !sourceProject }, async t => {
        const Config = require(sourceProject + '/scripts/config');
        Object.assign(require('../scripts/config').FILES, Config.FILES);
        const bytes = fs.readFileSync(Config.FILES.deepAnalysisResult);
        const data = JSON.parse(bytes);
        const plan = daily.requireDailyFreshSourceRecoveryPlan(data);
        const paper = data.papers.find(p => p.arxivId?.replace(/v\d+$/, '') === id);
        const source = daily.readDailyFreshSource(plan, paper);
        const feedback = facts.readFeedback(`/tmp/resume-round3-current-reader-feedback-r3/${id}.json`);
        const bound = facts.validateFeedback(feedback, plan, paper);
        const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-real-minimal-'));
        t.after(() => { observe = null; fs.rmSync(directory, { recursive: true, force: true }); });
        t.mock.method(fresh, 'freshReaderAttemptsDirectory', () => directory);
        let requests = 0;
        const stop = Object.assign(new Error('测试在真实请求边界停止'), { code: 'LLM_ACCOUNT_AUTH_ERROR', retryable: false, scope: 'run' });
        await daily.withDailyFreshAnalysisContext(plan, () => engine.withPaperAnalysisLock(paper, () =>
            facts.withReaderFactReview(bound, paper, () => fresh.withFreshPaperContext(paper, async () => {
                deep.captureStaleAnalysisSnapshot(paper, paper.analysisManifest, 'apiReaderArticle', bound.proof.feedbackSha256);
                const guidance = facts.reviewFeedback('apiReaderArticle', id);
                const seed = deep.prepareApiReaderRevisionSeed(paper, source.text, guidance);
                const display = require('../scripts/lib/signed-reader-recovery-draft').minimalDisplay(seed);
                const evidence = deep.buildApiReaderEvidenceContext(paper.analysis, source.text,
                    source.structuredArtifacts, paper.arxivId, null, paper.apiReaderResources, false);
                observe = async (_url, _endpoint, model, body) => {
                    requests++;
                    assert.equal(model, 'muse-spark-1.3-contributor');
                    const prompt = body.input[0].content.find(part => part.type === 'input_text').text;
                    assert.ok(prompt.includes(display.text));
                    assert.equal(prompt.includes(seed.initialDraft), false);
                    assert.ok(prompt.length < 240000, `${prompt.length}/240000`);
                    fs.writeFileSync(path.join('/tmp', `${id}-minimal-request-measure.json`),
                        JSON.stringify({ id, fullSeedChars: seed.initialDraft.length, displayChars: display.text.length,
                            evidenceChars: evidence.length, actualPromptChars: prompt.length,
                            sourceSha256: paper.sourceSha256, articleSha256: paper.apiReaderArticleSha256,
                            planSha256: paper.apiReaderPlanSha256, displayFields: display.fields }, null, 2));
                    throw stop;
                };
                await assert.rejects(deep.generateApiReaderArticleDetailed(paper, paper.analysis, evidence, {
                    sourceText: source.text, structuredArtifacts: source.structuredArtifacts,
                    readerResources: paper.apiReaderResources, reviewFeedback: guidance,
                    revisionSeed: seed, initialDraft: seed.initialDraft, signedRevisionMinimalDisplay: true,
                    readerMaterializeFigures: async () => []
                }), error => error.code === stop.code);
            }))));
        assert.equal(requests, 1);
        // 生产在并发保存，比较本测试读取的内存对象，不能断言整个正式文件没被生产更新。
        assert.equal(paper.analysis, JSON.parse(bytes).papers.find(p => p.arxivId === paper.arxivId).analysis);
    });
}
