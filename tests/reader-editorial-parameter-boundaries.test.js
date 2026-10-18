'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const quality = require('../scripts/editorial-quality');
const fixture = require('./fixtures/reader-editorial-parameter-boundary-real-paid.json');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const row = name => fixture.rows.find(item => item.name === name);

test('真实已付稿与原来源片段字节固定，规则检查不修改稿件或来源', () => {
    const before = JSON.stringify(fixture);
    for (const record of fixture.rows) {
        assert.equal(sha(record.text), record.textSha256);
        assert.equal(sha(record.sourceQuote), record.sourceQuoteSha256);
    }
    assert.match(row('wu').sourceQuote, /components K ∈\{5, 10, 15, 20, 25, 30, 35, 40, 45, 50\}/u);
    assert.match(row('song').sourceQuote, /ARTT: Augmented Reverberant-Target Training/u);
    assert.match(row('halmai').sourceQuote, /networks originally trained on all 100 hours of the English data/u);
    quality.findMissingComparisonUnits(row('wu').text);
    quality.findQuantitativeChineseNumerals(row('halmai').text);
    quality.findTechnicalTermAdhesions(row('song').text);
    assert.equal(JSON.stringify(fixture), before);
});

test('真实分量数K增长区间是模型设置，不借相邻EER描述变成百分比数值', () => {
    for (const text of [
        row('wu').text,
        row('wu').originalSavedIssues[0].message.split('comparison_unit_missing:')[1],
        row('wu').text.replace('K从5增加到50', 'K 从 8 增加到 64'),
        row('wu').text.slice(0, -1) + '，准确率从80%提高到90%。'
    ]) assert.deepEqual(quality.findMissingComparisonUnits(text), [], text);
});

test('分量数范围只遮住其完整设置，其他裸指标、未命名或不完整的数值不借此放行', () => {
    for (const text of [
        row('wu').text.slice(0, -1) + '，准确率从80提高到90。',
        row('wu').text.replace('分量数K从5增加到50', '等错误率EER从5增加到50'),
        row('wu').text.replace('分量数K从5增加到50', 'K从5增加到50'),
        row('wu').text.replace('K从5增加到50', 'K从5.5增加到50'),
        row('wu').text.replace('K从5增加到50', 'K从-5增加到50')
    ]) assert.ok(quality.findMissingComparisonUnits(text).length, text);
});

test('明确限定只研究一个语言迁移方向仍是精确计数，不扩大方向泛指豁免', () => {
    assert.ok(quality.findQuantitativeChineseNumerals(row('halmai').text)
        .some(issue => issue.match === '一个方向'));
    assert.ok(!quality.findQuantitativeChineseNumerals(row('halmai').text.replace('一个方向', '1 个方向'))
        .some(issue => issue.match === '一个方向'));
});

test('真实标题ARTT的仍是术语粘连，不增加论文缩写白名单', () => {
    assert.ok(quality.findTechnicalTermAdhesions(row('song').text)
        .some(issue => issue.match === 'ARTT的'));
    assert.deepEqual(quality.findTechnicalTermAdhesions(row('song').text.replace('ARTT的', 'ARTT 的')), []);
});
