'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const deep = require('../scripts/deep-analyzer');
const article = '| Check | Count |\n| --- | --- |\n| Package | 31 |\n| Companion | 36 |';
const binding = quotes => ({ tableIndex: 1, sourceType: 'source_quotes',
    sourceTableOrdinal: null, cellBindings: [], sourceQuotes: quotes });
function bind(sourceText, quotes, options = {}) {
    return deep.bindApiReaderSourceEvidence(options.article || article, [binding(quotes)], [], {
        sourceText, structuredArtifacts: deep.bindStructuredArtifactsToText({ tables: [], formulas: [] }, sourceText),
        allowDeterministicQuoteRepair: true, ...options
    });
}

test('完整原引文不加入同数字的另一实验，开启正常剪列时也保持原绑定', () => {
    const quote = 'Package tests (31) and companion tests (36) passed under the pinned protocol.';
    const unrelated = 'Unrelated models scored 31 and 36 under another condition.';
    const source = quote + '\n' + unrelated;
    assert.deepEqual(deep.deriveExactTableSourceQuotes(article, source), [unrelated]);
    for (const pruning of [false, true]) {
        const quotes = [quote], before = JSON.stringify(quotes);
        const result = bind(source, quotes, { allowDeterministicUnsupportedClaimPruning: pruning });
        assert.equal(result.article, article);
        assert.deepEqual(result.tableBindings[0].sourceQuotes.map(item => item.quote), [quote]);
        assert.equal(JSON.stringify(quotes), before);
    }
});

test('原引文缺数字时仍正常补证，不把不完整绑定当作已经通过', () => {
    const first = 'The package test run produced 31 outputs under the pinned protocol.';
    const second = 'The companion test run produced 36 outputs under the same protocol.';
    const source = first + '\n' + second;
    assert.throws(() => bind(source, [first], { allowDeterministicQuoteRepair: false }), /exact quote\/cell/);
    assert.deepEqual(bind(source, [first]).tableBindings[0].sourceQuotes.map(item => item.quote), [first, second]);
});

test('来源没有缺失数字时仍拒绝，不能保留或补出假引文', () => {
    const source = 'The package test run produced 31 outputs under the pinned protocol.';
    for (const quotes of [[source], [source, 'The companion test run produced 36 outputs but this quote was invented.']]) {
        assert.throws(() => bind(source, quotes), /exact quote\/cell/);
    }
});

test('完整字面数字仍须对应同一单位，不能把毫秒保留为百分数或从其他指标借单位', () => {
    const measured = '| Method | WER (%) |\n| --- | --- |\n| Package | 31 |\n| Companion | 36 |';
    for (const source of [
        'The Package WER was 31 ms and the Companion WER was 36 ms under the pinned protocol.',
        'The Package WER was 31 and the Companion WER was 36; another metric had a 31% error.'
    ]) assert.throws(() => bind(source, [source], { article: measured }), /单位|exact quote\/cell/);
    const valid = 'The Package WER was 31% and the Companion WER was 36% under the pinned protocol.';
    assert.deepEqual(bind(valid, [valid], { article: measured.replace('| 31 |', '| 31% |').replace('| 36 |', '| 36% |') }).tableBindings[0].sourceQuotes.map(item => item.quote), [valid]);
});
