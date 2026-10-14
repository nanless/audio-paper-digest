'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReaderSourceDisplayArtifacts: normalize } = require('../scripts/lib/reader-source-display');

test('公共来源显示投影只合并逐字一致且明确TeX注解的副本', () => {
    for (const [input, expected] of [
        ['K=1K{=}1', 'K=1'], ['F0F_{0}', 'F0'],
        ['15.9%15.9\\%', '15.9%'], ['.1 ± .02 .1\\pm .02', '.1 ± .02'],
        ['1,0241{,}024', '1,024'], ['[1.2, 3.4][1.2{}{,}3.4{}]', '[1.2, 3.4]'],
        ['ΔSI\\Delta_{\\mathrm{SI}}', 'ΔSI']
    ]) assert.equal(normalize(input), expected, input);
});

test('裸重复、错值注解与公式续尾原样保留，不猜半值、方向或单位', () => {
    for (const input of ['130130', '0.10.1', 'K=1K=1', '64', 'F0F_{1}',
        '15.9%15.8\\%', 'K=1K{=}2', '.1 ± .02 .1\\pm .03',
        'ΔSI\\Delta_{\\mathrm{SI}}_x', '↑\\downarrow', '[1.2, 3.4][1.2{}{,}3.5{}]'])
        assert.equal(normalize(input), input, input);
});

test('公共投影是确定性的纯显示操作，二次投影不再改变已规范内容', () => {
    const values = ['普通表头 WER (%)', 'K=1K{=}1', '0.10.1', '15.9%15.9\\%', '130130'];
    const before = structuredClone(values);
    for (const value of values) assert.equal(normalize(normalize(value)), normalize(value));
    assert.deepEqual(values, before);
});
