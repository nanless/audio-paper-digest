'use strict';
const test = require('node:test');
const assert = require('node:assert');
const finish = require('../scripts/publish-finish');

test('视觉/封面清单使用复数目录路径', () => {
    const finish = require('../scripts/publish-finish');
    assert.strictEqual(finish.visualManifestPath('2099-01-02', '/tmp/x'), '/tmp/x/visual-summary-manifests/2099-01-02.json');
    assert.strictEqual(finish.coverManifestPath('2099-01-02', '/tmp/x'), '/tmp/x/digest-cover-manifests/2099-01-02.json');
});

test('豁免必须严格绑定版本/清单/发布 OID/视觉清单', () => {
    const base = { status: 'waived', version: 1, waivedAt: '2099-01-02T12:00:00+08:00', batchDate: '2099-01-02', requestedBy: 'user', reason: '视觉任务已取消并确认', generationManifestSha256: 'a'.repeat(64), publicationCommit: 'b'.repeat(40), remoteVerifiedOid: 'b'.repeat(40), visualManifestSha256: 'c'.repeat(64), coverManifestSha256: 'd'.repeat(64) };
    const ctx = { date: '2099-01-02', manifestSha: 'a'.repeat(64), receiptCommit: 'b'.repeat(40), visualSha: 'c'.repeat(64), coverSha: 'd'.repeat(64) };
    const finish = require('../scripts/publish-finish');
    assert.strictEqual(finish.validateWaiver(base, ctx), true);
    assert.strictEqual(finish.validateWaiver({ ...base, version: 99 }, ctx), false);
    assert.strictEqual(finish.validateWaiver({ ...base, remoteVerifiedOid: 'e'.repeat(40) }, ctx), false);
    assert.strictEqual(finish.validateWaiver({ ...base, reason: '短' }, ctx), false);
    assert.strictEqual(finish.validateWaiver({ ...base, visualManifestSha256: '' }, ctx), false);
});

test('收尾清单提示状态、网页核验与不生图恢复，不引导默认生图', () => {
    const lines = [];
    const original = console.log;
    console.log = line => lines.push(String(line));
    try { assert.strictEqual(finish.main(['--date', '2099-01-01']), 0); } finally { console.log = original; }
    const text = lines.join('\n');
    assert.match(text, /digest:status/);
    assert.match(text, /verify:web/);
    assert.doesNotMatch(text, /visual:post-publish/);
    assert.match(text, /digest:waive-visuals/);
    assert.match(text, /以后日更不再生图/);
    assert.doesNotMatch(text, /visual:prepare|交给生图工具|qa-attested/);
    assert.ok(!/image_gen|生图 API/.test(text));
});

test('缺日期返回 2', () => {
    assert.strictEqual(finish.main([]), 2);
});

// 新记录绑定真实审查凭证，不以已退役的图片任务充当发布证据。
test('不生图记录核对审查文件摘要、来源图片策略和完整格式', () => {
    const protocols = require('../scripts/lib/protocol-codec');
    const context = { publicationPolicy: protocols.record('daily-publication-policy', { generatedImages: false, sourceFigures: 'retained-and-source-verified' }), postPublishVisuals: 'not_requested', date: '2099-01-02', manifestSha: 'a'.repeat(64), receiptCommit: 'b'.repeat(40), receiptSha: 'c'.repeat(64) };
    const value = protocols.record('post-publish-visual-waiver', {
        batchDate: context.date, status: 'waived', requestedBy: 'user', reason: '用户持续要求日更不再生成图片',
        waivedAt: '2099-01-02T12:00:00+08:00', publicationCommit: context.receiptCommit,
        remoteVerifiedOid: context.receiptCommit, generationManifestSha256: context.manifestSha,
        reviewReceiptSha256: context.receiptSha, generatedImages: false, sourceFigures: 'retained-and-source-verified'
    });
    assert.equal(finish.validateWaiver(value, context), true);
    assert.equal(finish.validateWaiver(value, { ...context, publicationPolicy: undefined }), false);
    assert.equal(finish.validateWaiver(value, { ...context, postPublishVisuals: 'required' }), false);
    for (const changed of [{ reviewReceiptSha256: 'd'.repeat(64) }, { generatedImages: true },
        { sourceFigures: 'skip' }, { schemaFingerprint: '0'.repeat(64) }, { version: 1 }]) {
        assert.equal(finish.validateWaiver({ ...value, ...changed }, context), false);
    }
});
