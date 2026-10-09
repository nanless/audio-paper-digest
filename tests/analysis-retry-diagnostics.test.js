'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyzePaperWithRetry } = require('../scripts/analysis-engine.js');

for (const firstFailure of ['thrown', 'returned']) {
    for (const finalResponse of ['incomplete', 'missing']) {
        test(`第二次${finalResponse}不继承第一次${firstFailure}请求的诊断`, async () => {
            let calls = 0;
            const result = await analyzePaperWithRetry({ arxivId: '2610.00001' }, {
                maxRetries: 1,
                retryDelayMs: 0,
                analyzeFn: async () => {
                    calls++;
                    if (calls === 1) {
                        if (firstFailure === 'returned') {
                            return { error: '临时服务故障', errorCode: 'HTTP_503',
                                errorCategory: 'transport', errorStatus: 503,
                                errorScope: 'paper', errorRetryable: true };
                        }
                        throw Object.assign(new Error('临时服务故障'), {
                            code: 'HTTP_503', category: 'transport', status: 503,
                            scope: 'paper', retryable: true
                        });
                    }
                    return finalResponse === 'incomplete' ? { analysis: '缺少必要章节' } : null;
                }
            });
            assert.equal(calls, 2);
            assert.equal(result.success, false);
            assert.match(result.error, finalResponse === 'incomplete' ? /缺少必要章节/ : /无分析结果/);
            for (const field of ['latestAnalysisAttemptErrorCode', 'latestAnalysisAttemptErrorCategory',
                'latestAnalysisAttemptErrorStatus', 'latestAnalysisAttemptErrorScope']) {
                assert.equal(result.result[field], null, field);
            }
            assert.equal(result.result.latestAnalysisAttemptRetryable, true);
        });
    }
}

test('本次明确的运行级错误仍保留原始诊断并停止重试', async () => {
    let calls = 0;
    const result = await analyzePaperWithRetry({ arxivId: '2610.00002' }, {
        maxRetries: 3,
        retryDelayMs: 0,
        analyzeFn: async () => {
            calls++;
            if (calls === 1) throw Object.assign(new Error('临时服务故障'), { status: 503 });
            throw Object.assign(new Error('认证失败'), {
                code: 'AUTH_FAILED', category: 'authentication', status: 401,
                scope: 'run', retryable: false
            });
        }
    });
    assert.equal(calls, 2);
    assert.equal(result.error, '认证失败');
    assert.equal(result.result.latestAnalysisAttemptErrorCode, 'AUTH_FAILED');
    assert.equal(result.result.latestAnalysisAttemptErrorCategory, 'authentication');
    assert.equal(result.result.latestAnalysisAttemptErrorStatus, 401);
    assert.equal(result.result.latestAnalysisAttemptErrorScope, 'run');
    assert.equal(result.result.latestAnalysisAttemptRetryable, false);
});
