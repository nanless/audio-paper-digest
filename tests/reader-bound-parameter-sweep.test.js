'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findMissingComparisonUnits, maskBoundParameterSweeps } = require('../scripts/editorial-quality');

// Actual saved draft/source observations: additional64-round2-shared-diagnosis/
// two-actual-cases.json (3fbfdf5a…). These are grammar tests, not source approval.
const actual = '建议从α为1开始，在CORAAL、Earnings22与TED-LIUM上分别扫0.5到2.0，记录词错误率、生成总词元数、吞吐与实时率，并保留重复循环的文本例子。';
test('显式初始化绑定跨逗号的参数扫描，只屏蔽三个设置数值', () => {
    for (const text of [actual, actual.replaceAll('α', ' α ').replace('为1', '为 1 '),
        '推荐从λ=1开始，在训练集与验证集上扫描0.25至2，记录准确率的变化。',
        '建议从ε为1e-2开始，在验证基准上扫1e-3到2e-2，记录WER变化。']) {
        assert.deepEqual(findMissingComparisonUnits(text), [], text);
    }
});
test('参数扫描不能吞掉真指标、变量切换或不完整数值', () => {
    for (const text of [
        '词错误率从1升到2。',
        '建议从α为1开始，词错误率从0.5降到2.0。',
        actual.replace('记录词错误率', '词错误率从1升到2，记录词错误率'),
        '建议从α为1开始，在WER上分别扫0.5到2.0，记录词错误率。',
        '建议从α为1开始，在另设β的基准上分别扫0.5到2.0，记录词错误率。',
        '建议从α为1开始，在阈值切换的基准上分别扫0.5到2.0，记录词错误率。',
        'α为1，准确率从80到90。'
    ]) assert.ok(findMissingComparisonUnits(text).length, text);
    assert.deepEqual(findMissingComparisonUnits(actual.replace('记录词错误率', '词错误率从1%升到2%，记录词错误率')), []);
    // The existing sentence splitter may treat malformed dots as punctuation;
    // independently assert that this new role mask never consumes a prefix.
    for (const text of [actual.replace('0.5到2.0', '0.5到2.0.3'),
        actual.replace('为1开始', '为1.2.3开始'), actual.replace('0.5到2.0', '0.5到2.0e')]) {
        assert.equal(maskBoundParameterSweeps(text), text);
    }
});
