'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    findQuantitativeChineseNumerals,
    findMissingComparisonUnits
} = require('../scripts/editorial-quality');

test('指代类别与已有完整名称枚举保留自然中文', () => {
    for (const text of [
        '触发后要输出哪一个类别。',
        '针对某一个类别。',
        '看干净、可逆3、heldout3三组的柱高。'
    ]) {
        assert.deepEqual(findQuantitativeChineseNumerals(text), [], text);
    }
});

test('未完整枚举的精确数量及同句结果值不被豁免', () => {
    for (const text of [
        '测试有三组。',
        '看干净、损坏三组的柱高。',
        '输入共有一个类别。',
        '哪一个类别达到百分之九十九。'
    ]) {
        assert.ok(findQuantitativeChineseNumerals(text).length > 0, text);
    }
    assert.ok(findMissingComparisonUnits(
        '在干净、可逆3、heldout3三组中，准确率从80提高到90。'
    ).length > 0);
});
