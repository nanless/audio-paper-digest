'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function bind(sourceText, rendered = '-38.1 dB') {
    const body = { version: 1, source: 'direct_conference_pdf_text', sourceKind: 'conference_pdf',
        tables: [], formulas: [], figures: [], flattenedTextSha256: sha(sourceText) };
    return deep.bindApiReaderSourceEvidence('| 方法 | THD ↓ |\n|---|---|\n| 本文 | ' + rendered + ' |', [
        { tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: [sourceText] }
    ], [], { sourceText, structuredArtifacts: { ...body, payloadSha256: deep.stableFingerprint(body) }, sections: [] });
}
test('会议 Reader 不能从另一正数或长数尾部给负数借单位', () => {
    for (const quote of [
        'The scalar is -38.1. Another measure is 138.1 dB.',
        'The scalar is -38.1. Another measure is 38.1 dB.',
        'The scalar is -38.1. Another measure is -138.1 dB.',
        'The scalar is -38.1. Another measure is 0.38.1 dB.'
    ]) {
        assert.equal(deep.readerSourceQuoteCoversNumericToken('-38.1db', quote, true), false, quote);
        assert.throws(() => bind(quote), /关键数字缺少 exact quote\/cell 证据/, quote);
    }
});
test('会议 Reader 不能从另一负数给正数借单位', () => {
    const source = 'The scalar is 38.1. Another measure is -38.1 dB.';
    assert.equal(deep.readerSourceQuoteCoversNumericToken('38.1db', source, true), false);
    assert.throws(() => bind(source, '38.1 dB'), /关键数字缺少 exact quote\/cell 证据/);
});
test('原文同值同符号的近邻单位保留 PDF 换栏、引文编号和小数格式兼容', () => {
    for (const source of [
        'The total THD is -38.1 with intervening column text\ndB.',
        'The total THD is −38.10 MUSHRA [18] explanation before\ndB.',
        'The total THD is -38.1 dB under the measured protocol.'
    ]) {
        assert.equal(deep.readerSourceQuoteCoversNumericToken('-38.1db', source, true), true, source);
        assert.equal(bind(source).tableBindings.length, 1);
    }
    const split = 'The total THD is -38.1 with intervening column text dB.';
    assert.equal(deep.readerSourceQuoteCoversNumericToken('-38.1db', split, false), false);
    assert.throws(() => bind('The total THD is -38.1 and competing measurement 2 before dB.'),
        /关键数字缺少 exact quote\/cell 证据/);
});

test('旧 Reader 的完整自洽 SHA 不能保留错误单位关联，原有效拆栏引文仍可复用', () => {
    const engine = require('../scripts/analysis-engine');
    const { validLegacyApiAnalysisPaper } = require('./valid-analysis-fixture');
    const paper = validLegacyApiAnalysisPaper('2601.12345');
    assert.equal(engine.hasValidApiReaderV3Records(paper), true);
    const table = '| 方法 | THD ↓ |\n|---|---|\n| 本文 | -38.1 dB |';
    paper.apiReaderArticle += '\n\n' + table;
    function seal(quote) {
        const plan = paper.apiReaderPlan, stage = paper.analysisManifest.stages.apiReaderArticle;
        plan.tableBindings = [{ tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null,
            renderedTableSha256: sha(table), cellBindings: [], sourceQuotes: [{ quote, sourceQuoteSha256: sha(quote) }] }];
        plan.sourceBindingsSha256 = deep.stableFingerprint({ tableBindings: plan.tableBindings, formulaBindings: [] });
        paper.apiReaderPlanSha256 = deep.stableFingerprint(plan);
        paper.apiReaderArticleSha256 = sha(paper.apiReaderArticle);
        Object.assign(stage, { planSha256: paper.apiReaderPlanSha256, articleSha256: paper.apiReaderArticleSha256,
            sourceBindingsSha256: plan.sourceBindingsSha256, tableBindingCount: 1 });
    }
    seal('The total THD is -38.1 with intervening column text dB.');
    assert.equal(engine.hasValidApiReaderV3Records(paper), true);
    seal('The scalar is -38.1. Another measure is 138.1 dB.');
    assert.equal(engine.hasValidApiReaderV3Records(paper), false);
});


test('拆开单位须是完整单位词，不能借英文词尾、较长单位或跨过全角测量值', () => {
    for (const [token, source] of [
        ['38.1s', 'The scalar is 38.1 and these are the results.'],
        ['38.1hz', 'The scalar is 38.1 and the unit is kHz.'],
        ['38.1hz', 'The scalar is 38.1 and the unit is ｋHz.'],
        ['38.1hz', 'The scalar is 38.1 and the unit is Hzｅｘｔ.'],
        ['38.1db', 'The scalar is 38.1 and another measurement is ２ dB.']
    ]) assert.equal(deep.readerSourceQuoteCoversNumericToken(token, source, true), false, source);
});
