'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { auditTypeAwareScoringDetailed } = require('../scripts/deep-analyzer.js');
const { analyzePaperWithRetry } = require('../scripts/analysis-engine.js');
const { validAnalysisText } = require('./valid-analysis-fixture.js');

test('评分三次内容修复耗尽后不再由整篇重试重新请求', async () => {
    const requests = [];
    const result = await analyzePaperWithRetry({ arxivId: '2610.12248' }, {
        maxRetries: 2, retryDelayMs: 0,
        analyzeFn: () => auditTypeAwareScoringDetailed(validAnalysisText(), '', {
            callModelFn: async messages => { requests.push(messages); return '{}'; }
        })
    });
    assert.equal(requests.length, 3);
    assert.equal(result.success, false);
    assert.equal(result.result.latestAnalysisAttemptRetryable, false);
    assert.ok(result.error.length > 0);
    assert.notDeepEqual(requests[0], requests[1], '后续评分请求仍收到上一次内容错误');
});

test('评分请求发生网络故障时仍由原整篇策略重试', async () => {
    let requests = 0;
    const result = await analyzePaperWithRetry({ arxivId: '2610.12248' }, {
        maxRetries: 2, retryDelayMs: 0,
        analyzeFn: () => auditTypeAwareScoringDetailed(validAnalysisText(), '', {
            callModelFn: async () => {
                requests++;
                throw Object.assign(new Error('连接被远端关闭'), { code: 'ECONNRESET' });
            }
        })
    });
    assert.equal(requests, 3);
    assert.equal(result.result.latestAnalysisAttemptErrorCode, 'ECONNRESET');
    assert.equal(result.result.latestAnalysisAttemptRetryable, true);
});

test('网络重试恢复后仍只允许三次评分内容修复', async () => {
    let requests = 0;
    const result = await analyzePaperWithRetry({ arxivId: '2610.12248' }, {
        maxRetries: 2, retryDelayMs: 0,
        analyzeFn: () => auditTypeAwareScoringDetailed(validAnalysisText(), '', {
            callModelFn: async () => {
                requests++;
                if (requests === 1) throw Object.assign(new Error('连接暂时中断'), { code: 'ECONNRESET' });
                return '{}';
            }
        })
    });
    assert.equal(requests, 4);
    assert.equal(result.result.latestAnalysisAttemptRetryable, false);
    assert.notEqual(result.result.latestAnalysisAttemptErrorCode, 'ECONNRESET');
});
