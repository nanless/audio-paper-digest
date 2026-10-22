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
    const base = { status: 'waived', version: 1, batchDate: '2099-01-02', requestedBy: 'user', reason: '视觉任务已取消并确认', generationManifestSha256: 'a'.repeat(64), publicationCommit: 'b'.repeat(40), remoteVerifiedOid: 'b'.repeat(40), visualManifestSha256: 'c'.repeat(64), coverManifestSha256: 'd'.repeat(64) };
    const ctx = { date: '2099-01-02', manifestSha: 'a'.repeat(64), receiptCommit: 'b'.repeat(40), visualSha: 'c'.repeat(64), coverSha: 'd'.repeat(64) };
    const finish = require('../scripts/publish-finish');
    assert.strictEqual(finish.validateWaiver(base, ctx), true);
    assert.strictEqual(finish.validateWaiver({ ...base, version: 99 }, ctx), false);
    assert.strictEqual(finish.validateWaiver({ ...base, remoteVerifiedOid: 'e'.repeat(40) }, ctx), false);
    assert.strictEqual(finish.validateWaiver({ ...base, reason: '短' }, ctx), false);
    assert.strictEqual(finish.validateWaiver({ ...base, visualManifestSha256: '' }, ctx), false);
});

test('收尾清单提示 digest:status、verify:web 与视觉步骤', () => {
    const lines = [];
    const original = console.log;
    console.log = line => lines.push(String(line));
    try { assert.strictEqual(finish.main(['--date', '2099-01-01']), 0); } finally { console.log = original; }
    const text = lines.join('\n');
    assert.match(text, /digest:status/);
    assert.match(text, /verify:web/);
    assert.match(text, /visual:prepare/);
    assert.ok(!/image_gen|生图 API/.test(text));
});

test('缺日期返回 2', () => {
    assert.strictEqual(finish.main([]), 2);
});
