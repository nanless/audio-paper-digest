'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findMissingComparisonUnits } = require('../scripts/editorial-quality');
const realSentence = '结果是深度从 2 加到 4 时失真、词错误率和预测分都大幅改善，因此选 4 为主配置。';
const rejects = text => assert.ok(findMissingComparisonUnits(text)
    .some(issue => issue.reason === 'percentage_metric_delta_without_unit'), text);

test('真实训练展开深度区间和同句匹配主配置不是错误率数值', () => {
    assert.deepEqual(findMissingComparisonUnits(realSentence), []);
    assert.deepEqual(findMissingComparisonUnits('训练展开深度从2增加到4，词错误率降低，因此选择4作为主配置。'), []);
    assert.deepEqual(findMissingComparisonUnits('深度从2到4时 WER 降低。'), []);
});

test('深度条件不能遮蔽同句缺单位的指标结果', () => {
    rejects('深度从2加到4，WER从7.05降低到3.7，因此选4为主配置。');
    rejects('深度从2加到4，CER从4.18降低到3.75，因此选4为主配置。');
    assert.deepEqual(findMissingComparisonUnits('深度从2加到4，WER从7.05%降低到3.7%，因此选4为主配置。'), []);
});

test('选择数字只能与同句唯一深度终点对应', () => {
    rejects(realSentence.replace('选 4', '选 8'));
    rejects('选4为主配置使词错误率降低。');
    rejects('深度从2到4时效果改善。选4为主配置使词错误率降低。');
    rejects('深度从2到4和深度从3到6均使WER降低，因此选4为主配置。');
});

test('负数小数和数字片段不能充作整数深度条件', () => {
    for (const range of ['-2加到4', '负2加到4', '− 2加到4', '2.5加到4',
        '2加到-4', '2加到负4', '2加到4.5', '二2加到4']) {
        rejects(`深度从${range}时词错误率降低，因此选4为主配置。`);
    }
    rejects('深度从2到4时WER降低，因此选4.5为主配置。');
});
