'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const contract = require('../scripts/analysis-contract');
const { stripDefinedGeometryNumerals } = require('../scripts/lib/core-symbolic-source-numerals');
const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname,
    'fixtures/core-defined-symbolic-source-20261102.json.gz'))));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

test('真实理论来源的定义、下标和构造例不充当实验测量', () => {
    assert.equal(sha(fixture.sourceText), fixture.sourceTextSha256);
    for (const response of fixture.paidResponses) assert.equal(sha(response.rawResponse), response.outputTextSha256);
    assert.equal(contract.classifySourceQuantitativeEvidence(fixture.sourceText), false);
    assert.equal(contract.validateCoreSummarySemanticContract(fixture.paidResponses[0].rawResponse,
        { sourceText: fixture.sourceText }), null);
    // Later paid replies omitted the required absence statement. A source
    // classification fix must not silently make those replies acceptable.
    for (const response of fixture.paidResponses.slice(1)) assert.match(
        contract.validateCoreSummarySemanticContract(response.rawResponse, { sourceText: fixture.sourceText }),
        /原文无可核定量结果时必须明确写/);
});

test('同一理论来源新增实际性能结果仍要求完整定量结论', () => {
    const observed = 'In our evaluation on the MUSIC test dataset, our method F1 improves from 0.80 to 0.90 compared with the baseline.';
    for (const source of [fixture.sourceText + '\n' + observed, observed + '\n' + fixture.sourceText]) {
        assert.equal(contract.classifySourceQuantitativeEvidence(source), true);
        assert.match(contract.validateCoreSummarySemanticContract(fixture.paidResponses[0].rawResponse,
            { sourceText: source }), /已有证据包含关键定量结果/);
    }
});

test('只剥去确定类型的编号，实测值、符号取值和指标名不被抹掉', () => {
    const measured = 'Definition 13 gives a transformation class \\mathcal{F} with F_{1}; our measured F1 accuracy improves from 80% to 90% on the test dataset.';
    const view = stripDefinedGeometryNumerals(measured);
    assert.match(view, /F1 accuracy improves from 80% to 90%/);
    assert.equal(contract.classifySourceQuantitativeEvidence(measured), true);
    const settings = 'Given a pattern and transformation class, we define \\sigma_{3} in {1,-1}, and measured compression ratio improves from 1.2 to 1.8 on the test dataset.';
    assert.match(stripDefinedGeometryNumerals(settings), /\{1,-1\}/);
    assert.match(stripDefinedGeometryNumerals(settings), /1\.2 to 1\.8/);
    assert.equal(contract.classifySourceQuantitativeEvidence(settings), true);
    const plain = 'Our measured F1 is 0.90 on the held-out test dataset, compared with baseline 0.80.';
    assert.equal(stripDefinedGeometryNumerals(plain), plain);
    assert.equal(contract.classifySourceQuantitativeEvidence(plain), true);
    for (const observed of [
        'Given a pattern \\mathcal{P}, we define a transformation class; our measured accuracy improves from (80) to (90) on the test dataset.',
        'Given a pattern \\mathcal{P}, we define a transformation class; measured latency is (12) ms compared with baseline (20) ms on the test dataset.',
        'Given a pattern \\mathcal{P}, we define a transformation class; our measured latency is \\,(12) ms compared with baseline \\,(20) ms on the test dataset.'
    ]) {
        assert.match(stripDefinedGeometryNumerals(observed), /\([0-9]+\)/);
        assert.equal(contract.classifySourceQuantitativeEvidence(observed), true);
    }
    const texUnits = 'Our measured latency is 12. \\mathrm{ms}, compared with baseline 20. \\mathrm{ms} on the test dataset.';
    assert.equal(stripDefinedGeometryNumerals(texUnits), texUnits);
    assert.equal(contract.classifySourceQuantitativeEvidence(texUnits), true);
});

test('Suppose 构造不借用相邻评测词，真实观测转折仍保留', () => {
    assert.equal(contract.classifySourceQuantitativeEvidence(
        'Suppose our method accuracy improves from 80% to 90% on the test dataset.'), false);
    assert.equal(contract.classifySourceQuantitativeEvidence(
        'Suppose a transformation class is given; but in our actual evaluation our model measured accuracy of 90% compared with the baseline 80% on the test dataset.'), true);
});
