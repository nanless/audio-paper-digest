'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const engine = require('../scripts/analysis-engine');
const { validLegacyApiAnalysisPaper } = require('./valid-analysis-fixture');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const table = value => `| Split | Utterances |\n| --- | --- |\n| Training | ${value} |`;

function bind(value, sourceText) {
    const article = table(value);
    const artifactBody = {
        version: 1,
        source: 'direct_conference_pdf_text',
        sourceKind: 'conference_pdf',
        tables: [],
        formulas: [],
        figures: [],
        flattenedTextSha256: sha(sourceText)
    };
    return deep.bindApiReaderSourceEvidence(article, [{
        tableIndex: 1,
        sourceType: 'source_quotes',
        sourceTableOrdinal: null,
        cellBindings: [],
        sourceQuotes: [sourceText]
    }], [], {
        sourceText,
        structuredArtifacts: { ...artifactBody, payloadSha256: deep.stableFingerprint(artifactBody) }
    });
}

function oldPaper(value, quote) {
    const paper = validLegacyApiAnalysisPaper('2601.12345');
    const plan = paper.apiReaderPlan;
    const stage = paper.analysisManifest.stages.apiReaderArticle;
    paper.apiReaderArticle += '\n\n' + table(value);
    plan.tableBindings = [{
        tableIndex: 1,
        sourceType: 'source_quotes',
        sourceTableOrdinal: null,
        cellBindings: [],
        renderedTableSha256: sha(table(value)),
        sourceQuotes: [{ quote, sourceQuoteSha256: sha(quote) }]
    }];
    plan.sourceBindingsSha256 = deep.stableFingerprint({ tableBindings: plan.tableBindings, formulaBindings: [] });
    paper.apiReaderArticleSha256 = sha(paper.apiReaderArticle);
    paper.apiReaderPlanSha256 = deep.stableFingerprint(plan);
    Object.assign(stage, {
        articleSha256: paper.apiReaderArticleSha256,
        planSha256: paper.apiReaderPlanSha256,
        sourceBindingsSha256: plan.sourceBindingsSha256,
        tableBindingCount: 1
    });
    return paper;
}

test('真实来源绑定保留合法重复整数，即使同段另有半值也不改写原表', () => {
    for (const value of ['130130', '6868', '40964096', '2020', '1212']) {
        const source = `Training uses ${value} utterances. The development split has 130 utterances.`;
        assert.equal(bind(value, source).article, table(value));
        assert.equal(engine.hasValidApiReaderV3Records(oldPaper(value, source)), true);
    }
});

test('纯数字重复不能证明半值，旧自洽 Reader 绑定也须拒绝', () => {
    for (const [sourceValue, rendered] of [
        ['130130', '130'],
        ['6868', '68'],
        ['40964096', '4096'],
        ['500,000500,000', '500,000'],
        ['3.093.09 dB', '3.09 dB'],
        ['20202020 s', '2020 s'],
        ['.119.119', '.119'],
        ['０.１５0.15', '0.15'],
        ['0.15０．１５', '0.15'],
        ['+0.15+0.15 dB', '+0.15 dB'],
        ['−5.6-5.6 dB', '-5.6 dB']
    ]) {
        const source = `Training reports ${sourceValue} under the controlled protocol.`;
        assert.throws(() => bind(rendered, source), /关键数字缺少 exact quote\/cell 证据/);
        assert.equal(engine.hasValidApiReaderV3Records(oldPaper(rendered, source)), false, sourceValue);
        assert.equal(engine.isSuccessfulAnalysisRecord(oldPaper(rendered, source)), false, sourceValue);
    }
});

test('明确 TeX 数值单位双写仍按逐字原句绑定，错值错单位仍拒绝', () => {
    const source = 'Observed latency was μ=4,852\\mu=4{,}852 ms under the controlled protocol.';
    assert.equal(bind('4,852 ms', source).article, table('4,852 ms'));
    assert.equal(engine.hasValidApiReaderV3Records(oldPaper('4,852 ms', source)), true);
    assert.throws(() => bind('4,852 s', source), /关键数字缺少 exact quote\/cell 证据/);
    assert.throws(() => bind('4,851 ms', source), /关键数字缺少 exact quote\/cell 证据/);
});

function oldCellPaper(rendered, sourceValue) {
    const paper = oldPaper(rendered, `Training reports ${rendered} under the controlled protocol.`);
    const binding = paper.apiReaderPlan.tableBindings[0];
    binding.sourceType = 'artifact_table';
    binding.sourceTableOrdinal = 1;
    binding.sourceTableDomSha256 = sha('original table');
    binding.sourceQuotes = [];
    binding.cellBindings = [['Split', 'Utterances'], ['Training', rendered]].flatMap((row, r) => (
        row.map((text, c) => ({
            renderedRow: r, renderedColumn: c, sourceRow: r, sourceColumn: c,
            renderedText: text, sourceText: r === 1 && c === 1 ? sourceValue : text,
            sourceDomSha256: sha(`original cell ${r}:${c}`)
        }))
    ));
    const plan = paper.apiReaderPlan;
    plan.sourceBindingsSha256 = deep.stableFingerprint({ tableBindings: plan.tableBindings, formulaBindings: [] });
    paper.apiReaderPlanSha256 = deep.stableFingerprint(plan);
    Object.assign(paper.analysisManifest.stages.apiReaderArticle, {
        planSha256: paper.apiReaderPlanSha256,
        sourceBindingsSha256: plan.sourceBindingsSha256
    });
    return paper;
}

test('旧 DOM 绑定也重核实际单元格，不能以自 SHA 认可裸符号或数值折半', () => {
    for (const [rendered, source] of [['130', '130130'], ['−22.9', '−22.9-22.9'], ['+20%', '++20%']]) {
        assert.equal(engine.hasValidApiReaderV3Records(oldCellPaper(rendered, source)), false);
        assert.equal(engine.hasValidApiReaderV3Records(oldCellPaper(source, source)), true);
        assert.match(deep.normalizeApiReaderTablePasteArtifacts(table(source)), new RegExp(
            source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        ));
    }
});

test('独立前导小数及有空格、逗号或范围分隔的量值仍能逐句绑定', () => {
    for (const [rendered, source] of [
        ['.119', 'The measured ratio is .119 under the controlled protocol.'],
        ['+0.15 dB', 'The two measurements are +0.15 and +0.15 dB under the protocol.'],
        ['+0.15 dB', 'The two measurements are +0.15, +0.15 dB under the protocol.'],
        ['1.2–1.4', 'The accepted interval is 1.2–1.4 under the controlled protocol.']
    ]) {
        assert.equal(bind(rendered, source).article, table(rendered));
    }
});
