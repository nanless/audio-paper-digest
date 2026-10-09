'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fresh = require('../scripts/lib/fresh-analysis-context.js');
const recovery = require('../scripts/lib/conference-process-recovery.js');
const now = '2026-10-10T00:00:00.000Z';

function actualFreshFailure() {
    try {
        fresh.withFreshAnalysisContext({ runId: 'invalid-run-id', runDir: '/synthetic-only' }, () => {});
    } catch (error) {
        return error;
    }
    assert.fail('无效 runId 应由真实来源入口拒绝');
}

test('真实来源入口的完整性错误按稳定错误码分类，不依赖诊断语言', () => {
    const error = actualFreshFailure();
    assert.equal(error.code, 'FRESH_ANALYSIS_INTEGRITY');
    assert.equal(error.retryable, false);
    const before = { message: error.message, code: error.code, retryable: error.retryable };
    const failure = recovery.classifyFailure(error, now);
    assert.equal(failure.category, 'integrity');
    assert.equal(failure.code, error.code);
    assert.equal(failure.retryable, false);
    assert.equal(failure.systemic, false);
    assert.deepEqual({ message: error.message, code: error.code, retryable: error.retryable }, before);
});

test('相似未知错误码、认证和传输错误仍按原规则分类', () => {
    const unknown = Object.assign(new Error('普通单篇失败'), { code: 'FRESH_OTHER_INTEGRITY' });
    assert.equal(recovery.classifyFailure(unknown, now).category, 'paper');
    const auth = recovery.classifyFailure(new Error('HTTP 401 Unauthorized'), now);
    assert.equal(auth.category, 'authentication');
    assert.equal(auth.systemic, true);
    assert.equal(auth.retryable, false);
    const transport = recovery.classifyFailure(new Error('HTTP 503 upstream'), now);
    assert.equal(transport.category, 'transport');
    assert.equal(transport.systemic, true);
    assert.equal(transport.retryable, true);
});
