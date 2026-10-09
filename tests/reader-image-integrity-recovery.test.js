'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createCanvas } = require('@napi-rs/canvas');
const reader = require('../scripts/deep-analyzer.js');
const engine = require('../scripts/analysis-engine.js');
const recovery = require('../scripts/lib/conference-process-recovery.js');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// 图片及论文编号仅为本地测试资料；分析替身只调用真实图片检查，不请求模型。
test('Reader 图片来源拒绝后不重复分析，保存的错误码恢复后仍禁止自动重试', async () => {
    const canvas = createCanvas(2, 2);
    canvas.getContext('2d').fillRect(0, 0, 2, 2);
    const png = canvas.toBuffer('image/png');
    const inputs = [
        { base64: '' },
        { base64: 'Zh==' },
        { rawBytes: Buffer.alloc(0) },
        { rawBytes: png, assetSha256: '0'.repeat(64) }
    ];
    for (const input of inputs) {
        let attempts = 0;
        const result = await engine.analyzePaperWithRetry({ arxivId: '2610.99998' }, {
            maxRetries: 2, retryDelayMs: 0,
            analyzeFn: async () => {
                attempts += 1;
                return reader.preflightReaderModelImages([{ inputId: 'figure:synthetic', ...input }]);
            }
        });
        assert.equal(attempts, 1);
        assert.equal(result.success, false);
        const saved = result.result;
        assert.equal(saved.latestAnalysisAttemptErrorCode, 'READER_IMAGE_SOURCE_INTEGRITY');
        assert.equal(saved.latestAnalysisAttemptRetryable, false);
        // 与会议逐篇入口一样，从保存字段重建错误，交给实际恢复分类器。
        const error = Object.assign(new Error(saved.latestAnalysisAttemptError), {
            code: saved.latestAnalysisAttemptErrorCode,
            retryable: saved.latestAnalysisAttemptRetryable
        });
        const failure = recovery.classifyFailure(error, '2026-10-10T00:00:00.000Z');
        assert.equal(failure.category, 'integrity');
        assert.equal(failure.retryable, false);
        assert.equal(failure.systemic, false);
        assert.equal(recovery.eligible({ status: 'partial', attempts: 1, lastFailure: failure }, failure.at), false);
    }
    const good = await reader.prepareApiReaderModelImagePayload({ rawBytes: png, assetSha256: sha(png) });
    assert.equal(good.sourceSha256, sha(png));
    const excluded = await reader.preflightReaderModelImages([{ inputId: 'figure:bad-decode', rawBytes: Buffer.from('not an image') }]);
    assert.equal(excluded.ready.length, 0);
    assert.equal(excluded.rejected.length, 1);
    assert.equal(excluded.rejected[0].reason, 'decode-or-dimension-limit');
});

test('图片来源专用分类不吞掉未知码和临时传输错误', async () => {
    const unknown = recovery.classifyFailure(Object.assign(new Error('普通失败'), { code: 'READER_IMAGE_OTHER_INTEGRITY' }), 'now');
    assert.equal(unknown.category, 'paper');
    let attempts = 0;
    const result = await engine.analyzePaperWithRetry({ arxivId: '2610.99998' }, {
        maxRetries: 2, retryDelayMs: 0,
        analyzeFn: async () => { attempts += 1; throw Object.assign(new Error('HTTP 503'), { code: 'ETIMEDOUT' }); }
    });
    assert.equal(attempts, 3);
    assert.equal(result.result.latestAnalysisAttemptRetryable, true);
    const failure = recovery.classifyFailure(Object.assign(new Error('HTTP 503'), { code: 'HTTP_503' }), 'now');
    assert.equal(failure.category, 'transport');
    assert.equal(failure.retryable, true);
    assert.equal(recovery.classifyFailure(new Error('HTTP 401'), 'now').category, 'authentication');
});

// 这份合成记录由修复前的真实图片检查、分析重试和恢复分类入口生成；保留原错误及可重试标记。
test('旧图片来源失败记录禁止自动重试，明确授权和预算限制仍生效', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const filename = path.join(__dirname, 'fixtures/reader-image-old-retryable-failure.json');
    const bytes = fs.readFileSync(filename);
    const item = JSON.parse(bytes);
    assert.equal(item.lastFailure.code, 'READER_IMAGE_SOURCE_INTEGRITY');
    assert.equal(item.lastFailure.category, 'paper');
    assert.equal(item.lastFailure.retryable, true);
    assert.equal(recovery.eligible(item, item.lastFailure.at), false);
    assert.equal(recovery.eligible({ ...item, retryAuthorizedAtAttempt: item.attempts }, item.lastFailure.at), true);
    assert.equal(recovery.eligible({ ...item, attempts: recovery.MAX_ATTEMPTS,
        retryAuthorizedAtAttempt: recovery.MAX_ATTEMPTS }, item.lastFailure.at), false);
    assert.equal(recovery.eligible({ ...item, lastFailure: { ...item.lastFailure,
        code: 'READER_IMAGE_OTHER_INTEGRITY' } }, item.lastFailure.at), true);
    assert.deepEqual(fs.readFileSync(filename), bytes);
});
