'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const quality = require('../scripts/editorial-quality');
const fixture = require('./fixtures/reader-classification-unit-real-paid.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

test('真实已付Reader全文以原表、公式和图来源绑定完成公共解析，原字节不补词', () => {
    assert.equal(sha(fixture.rawDraft), fixture.provenance.rawDraftSha256);
    assert.equal(sha(fixture.options.sourceText), fixture.provenance.sourceTextSha256);
    assert.equal(sha(JSON.stringify(fixture.options.structuredArtifacts)), fixture.provenance.structuredArtifactsSha256);
    assert.equal(fixture.options.requireSourceBindings, true);
    assert.equal(fixture.options.requireIntegratedTables, true);
    assert.match(fixture.options.sourceText, /Table 3: Multi-horizon forecasting \(AUROC/);
    assert.match(fixture.options.sourceText, /\.604\/\.074\s+\.598\/\.074/);
    const parsed = require('../scripts/lib/analysis-stop-control').withModelRequestsForbidden(() =>
        require('../scripts/deep-analyzer').parseApiReaderArticleResult(fixture.rawDraft, fixture.options));
    assert.equal(parsed.plan.tableBindings.length, 3);
    assert.equal(parsed.plan.formulaBindings.length, 5);
    assert.equal(parsed.plan.figurePlacements.length, 1);
    assert.equal(sha(fixture.rawDraft), fixture.provenance.rawDraftSha256);
});

test('二分类、四分类、多分类的词内“分”不成为比较单位，否定语境也不拆词', () => {
    for (const text of [
        'AUROC风险模型0.604对二分类模型0.598。',
        'AUROC风险模型0.604对四分类模型0.598。',
        'AUROC风险模型0.604对多分类模型0.598。',
        '这不是二分类，而是四分类，AUROC风险模型0.604对二分类模型0.598。'
    ]) assert.deepEqual(quality.findMissingComparisonUnits(text), [], text);
});

test('真实分、二分钟与单侧缺单位仍严格拒绝，分类词或否定不豁免邻接真数值', () => {
    for (const text of [
        '得分为1对二分。',
        '耗时为1对二分钟。',
        'WER为18对20%。',
        '并非二分类问题，WER为18对20%。',
        '四分类模型的得分为2对四分。'
    ]) assert.ok(quality.findMissingComparisonUnits(text).length > 0, text);
    assert.deepEqual(quality.findMissingComparisonUnits('耗时为1分钟对二分钟。'), []);
    assert.deepEqual(quality.findMissingComparisonUnits('WER为18%对20%。'), []);
});

test('完整原稿中真正的单侧缺单位仍由公共解析拒绝', () => {
    const bad = fixture.rawDraft.replace('0.604对二分类模型0.598', '0.604对二分');
    assert.notEqual(bad, fixture.rawDraft);
    assert.throws(() => require('../scripts/deep-analyzer').parseApiReaderArticleResult(bad, fixture.options),
        /comparison_unit_missing/);
});
