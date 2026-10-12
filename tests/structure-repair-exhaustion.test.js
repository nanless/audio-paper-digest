'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const deep = require('../scripts/deep-analyzer');
const engine = require('../scripts/analysis-engine');
const { validAnalysisText } = require('./valid-analysis-fixture');
const sourceText = 'Experiment results on the public test set compare baseline WER 12.4% versus our WER 9.8%.';
const incompleteAnalysis = validAnalysisText();
const completeAnalysis = incompleteAnalysis.replace('## 毒舌点评\n', '## 论文评价\n');

test('两次结构内容修复耗尽后不重新整篇付费，原文保持', async () => {
    let responses = 0;
    const result = await engine.analyzePaperWithRetry({ arxivId: '2610.90021', title: '结构修复耗尽样例' }, {
        maxRetries: 2, retryDelayMs: 0,
        analyzeFn: paper => deep.repairMissingAnalysisSections(paper, incompleteAnalysis, sourceText, null, {
            requireCurrentEvaluationTitle: true,
            callModelFn: async messages => {
                responses += 1;
                assert.ok(messages[0].content.includes('论文评价'));
                return incompleteAnalysis;
            }
        })
    });
    assert.equal(result.success, false);
    assert.equal(responses, 2);
    assert.equal(result.result.latestAnalysisAttemptRetryable, false);
    assert.match(result.error, /最终结构修复失败/);
});

test('结构修复传输失败仍正常重试，不冒充内容耗尽', async () => {
    let calls = 0;
    const result = await engine.analyzePaperWithRetry({ arxivId: '2610.90022', title: '结构请求传输失败样例' }, {
        maxRetries: 2, retryDelayMs: 0,
        analyzeFn: paper => deep.repairMissingAnalysisSections(paper, incompleteAnalysis, sourceText, null, {
            requireCurrentEvaluationTitle: true,
            callModelFn: async () => {
                calls += 1;
                throw Object.assign(new Error('合成DNS失败'), { code: 'ENOTFOUND', retryable: true });
            }
        })
    });
    assert.equal(result.success, false);
    assert.equal(calls, 3);
    assert.equal(result.result.latestAnalysisAttemptRetryable, true);
});

test('第二次结构修复达到原有严格要求仍正常返回', async () => {
    let calls = 0;
    const result = await deep.repairMissingAnalysisSections({ arxivId: '2610.90023', title: '结构修复成功样例' }, incompleteAnalysis, sourceText, null, {
        requireCurrentEvaluationTitle: true,
        callModelFn: async () => { calls += 1; return calls === 1 ? incompleteAnalysis : completeAnalysis; }
    });
    assert.equal(calls, 2);
    assert.match(result, /^## 论文评价$/m);
    assert.deepEqual(deep.getRepairableAnalysisStructureIssues(result, { sourceText, requireCurrentEvaluationTitle: true }), []);
});
