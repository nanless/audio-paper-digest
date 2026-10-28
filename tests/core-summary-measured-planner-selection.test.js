'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const crypto = require('node:crypto');
const fixture = require('./fixtures/core-measured-planner-selection-real.json');
const file = path.resolve(__dirname, '../scripts/analysis-contract.js');
const compiled = new Module(file, module);
compiled.filename = file;
compiled.paths = Module._nodeModulePaths(path.dirname(file));
compiled._compile(fs.readFileSync(file, 'utf8')
    + '\nmodule.exports.selection=sourceMeasuredPlannerSelection;'
    + 'module.exports.selectionResult=sourceBoundPlannerSelectionResult;'
    + 'module.exports.resultState=coreSummaryQuantitativeResultState;', file);
const q = compiled.exports;
const source = fixture.sourceExcerpt;
const claim = source.split('\n').find(line => line.startsWith('The frozen planner uniquely'));
const summary = fixture.paid[0].rawResponse;
const resultSentence = summary.split('。').find(sentence => sentence.startsWith('冻结后的规划器'));

test('three actual paid responses retain exact bytes and pass the complete core contract with an exact source excerpt', () => {
    assert.equal(crypto.createHash('sha256').update(source).digest('hex'), fixture.sourceExcerptSha256);
    assert.notEqual(fixture.sourceExcerptSha256, fixture.fullSourceSha256);
    assert.equal(q.classifySourceQuantitativeEvidence(source), true);
    assert.deepEqual(q.selection(source), { selected: '13', cases: '13', hardware: 'H100 NVL' });
    assert.deepEqual(q.selection(source.replaceAll('\n', '\r\n')), q.selection(source));
    for (const paid of fixture.paid) {
        assert.equal(crypto.createHash('sha256').update(paid.rawResponse).digest('hex'), paid.outputTextSha256);
        assert.equal(q.validateCoreSummarySemanticContract(paid.rawResponse, { sourceText: source }), null);
        assert.equal(q.resultState(paid.rawResponse, source).complete, true);
    }
    assert.ok(q.validateCoreSummarySemanticContract(fixture.oldUnavailableResponse, { sourceText: source }));
});

test('selection profile is measured count evidence, independent of paper identity and specific values', () => {
    const changed = claim.replaceAll('13/13', '7/9').replace('H100 NVL', 'A100 SXM');
    assert.deepEqual(q.selection(changed), { selected: '7', cases: '9', hardware: 'A100 SXM' });
    const result = '本文的规划器在已声明验证池9个模型与批量组合中7/9选中已测最快设计';
    assert.equal(q.selectionResult(result, '在A100 SXM上评测。' + result, changed), true);
    assert.equal(q.selection(claim.replace('13/13', '14/13')), null);
    assert.equal(q.selection(claim.replace('13/13', '0/13')), null);
});

test('unrelated hardware, calibration, batch counts and illustrative latency are not this outcome', () => {
    for (const text of [
        'We evaluate inference on H100 NVL at batch size 32. Kernel benchmarks took 4.6 GPU-minutes.',
        'Our planner has 13/13 parameters and runs for 15.9 GPU-minutes.',
        'An illustrative calculation shows the tradeoff. Suppose publication scores are 30.1ms and 28.2ms.',
        claim.replace('measured fastest design', 'proposed configuration'),
        claim.replace('held-out model-batch cases', 'training iterations'),
        claim.replace('This establishes selection accuracy', 'This defines a hyperparameter'),
        claim.replace('on H100 NVL', 'on unspecified hardware')
    ]) assert.equal(q.selection(text), null, text);
});

test('foreign attribution, predictions, negation, quotes and withdrawals cannot supply own observations', () => {
    for (const text of [
        'Previous work reports:\n' + claim,
        'These are hypothetical measurements.\n' + claim,
        'A third-party report:\n' + claim,
        'The following is quoted:\n' + claim,
        '```text\n' + claim + '\n```',
        '```text\nNeutral passage.\n' + claim + '\n```',
        '<blockquote>\nNeutral passage.\n' + claim + '\n</blockquote>',
        '```text\r\nNeutral passage.\r\n' + claim + '\r\n```',
        '“' + claim + '”',
        claim.replace('uniquely selected', 'did not uniquely select'),
        claim.replace('uniquely selected', 'would uniquely select'),
        claim + '\nThese results were not measured.',
        claim + ' These measurements are false.',
        claim + '\nThese claims were withdrawn.',
        claim + '\nThis experiment was withdrawn.',
        claim + '\nThis result was revoked.',
        'We did not measure these results.\n' + claim,
        'According to Smith:\n' + claim
    ]) assert.equal(q.selection(text), null, text);
});

test('Chinese outcome must preserve measured source ratio, pool, hardware and result role', () => {
    assert.equal(q.selectionResult(resultSentence, summary, source), true);
    for (const bad of [
        resultSentence.replace('13/13', '12/13'),
        resultSentence.replace('13个', '12个'),
        resultSentence.replace('13/13', '13/14'),
        resultSentence.replace('已测最快', '预测最快'),
        resultSentence.replace('已声明验证池', '训练集'),
        resultSentence.replace('冻结后的规划器', '其他论文的规划器'),
        '假设' + resultSentence, '据他人引用，' + resultSentence,
        resultSentence + '，但该结果并未观察到', '“' + resultSentence + '”'
    ]) assert.equal(q.selectionResult(bad, summary, source), false, bad);
    assert.equal(q.selectionResult(resultSentence, summary.replaceAll('H100 NVL', 'A100 SXM'), source), false);
    assert.equal(q.selectionResult(resultSentence, 'H100 NVL硬件说明。另一组硬件实验。' + resultSentence, source), false);
    for (const prefix of ['未在H100 NVL上评测。', 'H100 NVL仅是说明硬件名称的例子。', '在H100 NVL上只是一个假设例子。'])
        assert.equal(q.resultState(prefix + resultSentence, source).complete, false);
    assert.equal(q.selectionResult(resultSentence, summary, null), false);
    assert.equal(q.resultState(summary.replaceAll('13/13', '12/13'), source).complete, false);
    assert.equal(q.resultState('在H100 NVL上评测。\n' + resultSentence + '。\n该结果已撤回。', source).complete, false);
});
