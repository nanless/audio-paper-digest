'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const deep = require('../scripts/deep-analyzer');
const engine = require('../scripts/analysis-engine');
const { validAnalysisText } = require('./valid-analysis-fixture');
const original = validAnalysisText();
const paper = { arxivId: '2610.90089', title: '标签重试测试' };
const evidence = 'The paper classifies musical instruments with a CNN under low-resource conditions.';
const validSelection = JSON.stringify({ primaryTaskId: 'task.audio-classification', primaryMethodId: 'method.cnn',
    conceptIds: ['task.audio-classification', 'method.cnn', 'setting.low-resource'] });

test('两次标签内容修复被拒后，整篇层不再重新发起相同修复', async () => {
    let calls = 0;
    const result = await engine.analyzePaperWithRetry(paper, {
        maxRetries: 2, retryDelayMs: 0,
        analyzeFn: item => deep.repairTagSelection(item, original, evidence, '修正标签', {
            callModelFn: async () => { calls += 1; return '{}'; }
        })
    });
    assert.equal(result.success, false);
    assert.equal(calls, 2);
    assert.equal(result.result.latestAnalysisAttemptErrorCode, 'CONTRACT_REJECTED');
    assert.equal(result.result.latestAnalysisAttemptRetryable, false);
});

test('标签请求传输失败仍按既有整篇策略重试', async () => {
    let calls = 0;
    const result = await engine.analyzePaperWithRetry(paper, {
        maxRetries: 2, retryDelayMs: 0,
        analyzeFn: item => deep.repairTagSelection(item, original, evidence, '修正标签', {
            callModelFn: async () => {
                calls += 1;
                throw Object.assign(new Error('测试网络暂时不可用'), { code: 'ENOTFOUND', retryable: true });
            }
        })
    });
    assert.equal(result.success, false);
    assert.equal(calls, 3);
    assert.equal(result.result.latestAnalysisAttemptRetryable, true);
});

test('第二次标签修复通过原检查时正常返回，其他正文不变', async () => {
    let calls = 0;
    const result = await deep.repairTagSelection(paper, original, evidence, '修正标签', {
        callModelFn: async () => { calls += 1; return calls === 1 ? '{}' : validSelection; }
    });
    assert.equal(calls, 2);
    assert.equal(deep.parseAnalysis(result).tagValidation.valid, true);
    assert.equal(deep.maskClassificationFields(result), deep.maskClassificationFields(original));
});
