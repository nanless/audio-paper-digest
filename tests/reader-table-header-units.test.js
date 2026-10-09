'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function bind(sourceText, header = 'WER (%)', cell = '1.2') {
    const body = {
        version: 1,
        source: 'direct_conference_pdf_text',
        sourceKind: 'conference_pdf',
        tables: [],
        formulas: [],
        figures: [],
        flattenedTextSha256: sha(sourceText)
    };
    return deep.bindApiReaderSourceEvidence(
        `| Method | ${header} |\n|---|---|\n| A | ${cell} |`,
        [{
            tableIndex: 1,
            sourceType: 'source_quotes',
            sourceTableOrdinal: null,
            cellBindings: [],
            sourceQuotes: [sourceText]
        }],
        [],
        {
            sourceText,
            structuredArtifacts: { ...body, payloadSha256: deep.stableFingerprint(body) }
        }
    );
}

test('来源比率不能借列头变成百分数，同值异单位或其他指标单位也不能借用', () => {
    for (const source of [
        'The WER error-to-reference-word ratio is 1.2 for A.',
        'A has WER ratio 1.2 and CER (%) is 12.',
        'A has WER ratio 1.2. OtherWER (%) is reported separately.',
        'The runtime is 1.2 s for method A.',
        'A has WER ratio 1.2 and CER is 1.2%.',
        'A has WER ratio 1.2. WER (%) of method B is 8.',
        'WER (%) is not reported and CER (%) is 1.2 for A.',
        'WER (%) of B is unavailable while WER ratio of A is 1.2.'
    ]) {
        assert.throws(() => bind(source), /列头单位/);
    }
    assert.throws(
        () => bind('The latency is 1.2 s for method A.', 'Latency (ms)'),
        /列头单位/
    );
    assert.throws(
        () => bind('A has latency 1.2 s and overhead 1.2 ms.', 'Latency (ms)'),
        /列头单位/
    );
});

test('逐值明确单位或同一引文的原指标单位列头均能支持原值，不重写表格', () => {
    for (const source of [
        'The WER (%) of method A is 1.2.',
        '该方法的WER（％）为1.2，在原文中逐字列出。'
    ]) {
        const result = bind(source);
        assert.match(result.article, /WER \(%\)/);
        assert.match(result.article, /\| A \| 1\.2 \|/);
    }
    assert.doesNotThrow(() => bind('The latency (ms) is 1.2 for method A.', 'Latency (ms)'));
    assert.doesNotThrow(() => bind('The WER (%) of method A is 1.2.', 'WER（％）↓'));
    assert.doesNotThrow(() => bind('The WER is 1.2% for method A.', 'WER (%)', '1.2%'));
    assert.doesNotThrow(() => bind(
        'The signal level is -38.1 [right column text] dB in the source.',
        'Level (dB)',
        '-38.1 dB'
    ));
    assert.throws(() => bind(
        'The signal level is -38.1 [right column text] dB in the source.',
        'Level (ms)',
        '-38.1 dB'
    ), /列头单位/);
    assert.throws(
        () => bind('The latency is 1.2 s for method A.', 'Latency (ms)', '1.2 s'),
        /列头单位/
    );
});

test('重新签过输出哈希的旧表头单位错误也不能被完成判断接受', () => {
    const engine = require('../scripts/analysis-engine');
    const paper = require('./valid-analysis-fixture').validLegacyApiAnalysisPaper('2601.12345');
    const correct = bind('The WER (%) of method A is 1.2.');
    paper.apiReaderArticle += '\n\n' + correct.article;
    paper.apiReaderPlan.tableBindings = [correct.tableBindings[0]];
    const stage = paper.analysisManifest.stages.apiReaderArticle;

    function seal() {
        const plan = paper.apiReaderPlan;
        plan.sourceBindingsSha256 = deep.stableFingerprint({
            tableBindings: plan.tableBindings,
            formulaBindings: plan.formulaBindings
        });
        paper.apiReaderArticleSha256 = sha(paper.apiReaderArticle);
        paper.apiReaderPlanSha256 = deep.stableFingerprint(plan);
        Object.assign(stage, {
            tableBindingCount: plan.tableBindings.length,
            articleSha256: paper.apiReaderArticleSha256,
            planSha256: paper.apiReaderPlanSha256,
            sourceBindingsSha256: plan.sourceBindingsSha256
        });
    }

    seal();
    assert.equal(engine.hasValidApiReaderV3Records(paper), true);
    const quote = 'The WER error-to-reference-word ratio is 1.2 for A.';
    paper.apiReaderPlan.tableBindings[0].sourceQuotes = [{
        quote,
        sourceQuoteSha256: sha(quote)
    }];
    seal();
    assert.equal(engine.hasValidApiReaderV3Records(paper), false);
});
