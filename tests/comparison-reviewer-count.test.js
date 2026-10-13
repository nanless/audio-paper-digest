'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findMissingComparisonUnits } = require('../scripts/editorial-quality');
const actual = '条目级上，本模型正确性与 3 位评分者准确率的相关性在各评测条件下都明显为正，而域微调模型只在单语对齐较好，跨配音接近零，这支持新模型在难度排序上更接近人类，但相关不等于因果，也不能承诺误判率或延迟会改善。';
test('真实相关性说明中的评分人数不冒充准确率结果值', () => {
    assert.deepEqual(findMissingComparisonUnits(actual), []);
    for (const role of ['评分者', '评审者', '受试者']) {
        assert.deepEqual(findMissingComparisonUnits(`3 位${role}认为本模型准确率更高。`), []);
    }
});
test('同句真实裸结果值、非人数及非整数仍须声明单位', () => {
    for (const text of [
        '3 位评分者认为模型准确率从80提高到90。',
        '3 位评审者给出的模型准确率提高到90，比基线更高。',
        '模型准确率从80位提高到90位。',
        '模型准确率从80位数提高到90位数。',
        '3.5 位评分者的准确率从80提高到90。'
    ]) assert.ok(findMissingComparisonUnits(text).length > 0, text);
    assert.deepEqual(findMissingComparisonUnits('3 位评分者认为模型准确率从80%提高到90%。'), []);
});
