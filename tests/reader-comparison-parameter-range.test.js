'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findMissingComparisonUnits } = require('../scripts/editorial-quality');

test('参数区间端点不冒充附近的比例准确率结果', () => {
    const text = '(c) 图显示 λ 在 0 到 2 之间准确率保持较高，λ=1 时达到峰值（CREMA-D 0.8589、Sarcasm 0.8547），越过 λ=2 的虚线后准确率明显下降。';
    assert.deepEqual(findMissingComparisonUnits(text), []);
    assert.deepEqual(findMissingComparisonUnits('ε 在 0 到 2 之间，准确率从 0.8 提高到 0.9，ε=2 时下降。'), []);
});

test('同句的实际百分量级结果仍须有单位，未声明区间不屏蔽变量数', () => {
    for (const text of [
        '准确率从 20 提高到 30。',
        'λ 在 0 到 2 之间，准确率从 20 提高到 30，λ=1 时较高。',
        'ε 在 0 到 2 之间，准确率从 20 提高到 30，ε=2 时下降。',
        '准确率 λ=20 高于 10。',
        'λ 在 0 到 2 之间，测得准确率 λ=20 高于另一组 λ=10。',
        'ε 在 0 到 2 之间，测得准确率 ε=20 高于另一组 ε=10。',
        'λ=2 附近准确率从 20 提高到 30。'
    ]) {
        assert.ok(findMissingComparisonUnits(text).length > 0, text);
    }
    assert.deepEqual(findMissingComparisonUnits('λ 在 0 到 2 之间，准确率从 20% 提高到 30%，λ=1 时较高。'), []);
});
