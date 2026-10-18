'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { findMissingComparisonUnits } = require('../scripts/editorial-quality');
const fixture = require('./fixtures/reader-posterior-sampling-count-real-paid.json');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const latest = fixture.records[1].sentence;

test('真实新旧付费句中的后验抽样次数保留原单位，不被误判为准确率变化', () => {
    const original = JSON.stringify(fixture);
    assert.equal(fixture.records.length, 2);
    assert.deepEqual(fixture.records.map(record => record.attempts), [3, 5]);
    for (const record of fixture.records) {
        assert.equal(sha(record.sentence), record.sentenceSha256);
        assert.equal(record.originalDiagnostic.reason, 'percentage_metric_delta_without_unit');
        assert.deepEqual(findMissingComparisonUnits(record.sentence), [], record.name);
    }
    for (const { quote, sha256 } of fixture.provenance.sourceQuotes) assert.equal(sha(quote), sha256);
    assert.ok(fixture.provenance.sourceQuotes.some(({ quote }) => /posterior draws was set to 8000/u.test(quote)));
    assert.ok(fixture.provenance.sourceQuotes.some(({ quote }) => /posterior draws was set to 12000/u.test(quote)));
    assert.equal(JSON.stringify(fixture), original);
});

test('后验计数按明确名称、整数、次和局部分隔符识别，不依赖固定数值', () => {
    for (const text of [
        latest.replace('8000', '6000').replace('12000', '9000'),
        latest.replaceAll('抽样次数设为', '采样次数设置为').replace('8000', '8,000').replace('12000', '12,000'),
        latest.replaceAll('次数设为', '次数为'),
        latest.slice(0, -1) + '，准确率从80%提高到90%。'
    ]) assert.deepEqual(findMissingComparisonUnits(text), [], text);
});

test('同句真实准确率和非对称比较仍须有单位，不因后验设置整句豁免', () => {
    for (const text of [
        latest.slice(0, -1) + '，准确率从80提高到90。',
        latest.slice(0, -1) + '，词错误率从18降至12。',
        '后验抽样次数设为8000次，WER为18对20%。',
        '准确率从80提高到90次。',
        '准确率模型减少8000次，另一准确率模型减少12000次。'
    ]) assert.ok(findMissingComparisonUnits(text).length, text);
});

test('缺少次、非整数和未明确绑定到后验抽样次数的数值不进入计数遮罩', () => {
    for (const text of [
        latest.replace('8000 次', '8000'),
        latest.replace('8000 次', '8000.5 次'),
        latest.replace('后验抽样次数设为 8000 次', '后验抽样次数设为 -8000 次'),
        latest.replace('后验抽样次数设为 8000 次', '准确率提高了 8000 次')
    ]) assert.ok(findMissingComparisonUnits(text).length, text);
});
