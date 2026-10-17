'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../scripts/lib/workflow-error-policy.js');
const conference = require('../scripts/lib/conference-process-recovery.js');
const now = '2026-10-17T00:00:00.000Z';

test('conference compatibility exports are the same shared policy functions', () => {
    assert.equal(conference.findStorageFailure, policy.findStorageFailure);
    assert.equal(conference.classifyFailure, policy.classifyFailure);
    assert.equal(conference.MAX_ATTEMPTS, 3);
    assert.equal(conference.RETRY_COOLDOWN_MS, 15 * 60 * 1000);
});

test('shared classification preserves paper, typed run, legacy bilingual and integrity decisions', () => {
    const cases = [
        [new Error('普通正文未通过'), 'paper', false, true],
        [new Error('正文包含代理项字符'), 'paper', false, true],
        [Object.assign(new Error('模型当前不可用'), { scope: 'run' }), 'run', true, false],
        [Object.assign(new Error('optional demo unavailable'), { code: 'DEMO_TRANSIENT_FAILURE' }), 'paper', false, true],
        [Object.assign(new Error('network exhausted'), { code: 'ECONNRESET', retryable: false }), 'paper', false, false],
        [new Error('HTTP 503 upstream'), 'transport', true, true],
        [new Error('代理连接失败'), 'transport', true, true],
        [new Error('authentication failed'), 'authentication', true, false],
        [new Error('认证失败'), 'authentication', true, false],
        [Object.assign(new Error('quota exhausted'), { code: 'LLM_ACCOUNT_POOL_EXHAUSTED' }), 'quota', true, false],
        [Object.assign(new Error('receipt rejected'), { code: 'CONFERENCE_EXTRACTION_RECEIPT_INTEGRITY' }), 'integrity', false, false],
        [Object.assign(new Error('tags pending'), { code: 'CONFERENCE_TAG_REVIEW_REQUIRED' }), 'tag_review', false, false]
    ];
    for (const [error, category, systemic, retryable] of cases) {
        const actual = policy.classifyFailure(error, now);
        assert.deepEqual(Object.keys(actual).sort(), ['at', 'category', 'code', 'message', 'retryable', 'systemic']);
        assert.equal(actual.category, category, error.message);
        assert.equal(actual.systemic, systemic, error.message);
        assert.equal(actual.retryable, retryable, error.message);
        assert.deepEqual(actual, conference.classifyFailure(error, now));
    }
});

test('storage classification traverses aggregate and cause cycles without matching prose', () => {
    const storage = Object.assign(new Error('disk failed'), { code: 'ENOSPC' });
    const wrapper = new AggregateError([new Error('other'), { errorDetails: storage }], 'batch failed');
    wrapper.cause = wrapper;
    assert.equal(policy.findStorageFailure(wrapper), storage);
    assert.deepEqual(policy.classifyFailure(wrapper, now), {
        category: 'storage', code: 'ENOSPC', message: 'batch failed', systemic: true, retryable: false, at: now
    });
    const prose = new Error('论文举例提到 ENOSPC'); prose.cause = prose;
    assert.equal(policy.findStorageFailure(prose), null);
    assert.equal(policy.classifyFailure(prose, now).systemic, false);
});

test('analysis failure projection keeps all engine typed fields and does not mutate the record', () => {
    const record = Object.freeze({ latestAnalysisAttemptError: '模型当前不可用',
        latestAnalysisAttemptErrorCode: 'MODEL_SERVICE_UNAVAILABLE', latestAnalysisAttemptRetryable: false,
        latestAnalysisAttemptErrorCategory: 'request', latestAnalysisAttemptErrorStatus: 503,
        latestAnalysisAttemptErrorScope: 'run', apiReaderAttempts: 6, oldFullAttempts: 2 });
    const error = policy.analysisFailureFromRecord(record, 'fallback');
    assert.equal(error.message, record.latestAnalysisAttemptError);
    assert.deepEqual(Object.fromEntries(Object.entries(error)), {
        code: 'MODEL_SERVICE_UNAVAILABLE', retryable: false, category: 'request', status: 503, scope: 'run'
    });
    assert.equal(policy.classifyFailure(error, now).systemic, true);
    assert.equal(policy.classifyFailure(error, now).retryable, false);
    assert.equal(record.apiReaderAttempts, 6); assert.equal(record.oldFullAttempts, 2);
});

test('missing typed fields never create run scope, a status, or retry authority', () => {
    const error = policy.analysisFailureFromRecord({ error: '普通正文拒稿', errorScope: 'run' }, 'fallback');
    assert.equal(error.message, '普通正文拒稿');
    assert.deepEqual(Object.keys(error), []);
    assert.equal(policy.classifyFailure(error, now).systemic, false);
    assert.equal(policy.analysisFailureFromRecord({}, 'fallback').message, 'fallback');
});

test('shared policy keeps the existing sanitized persisted failure shape', () => {
    const error = Object.assign(new Error('HTTP 401 https://user:pass@example.test/path Authorization=secret sk-secret'),
        { code: 'MODEL_HTTP_NON_RETRYABLE', scope: 'run', status: 401 });
    const actual = policy.classifyFailure(error, now);
    assert.equal(actual.category, 'authentication');
    assert.doesNotMatch(actual.message, /user:pass|example\.test|secret/);
    assert.equal(Object.hasOwn(actual, 'status'), false, 'do not rewrite legacy receipt schemas');
});
