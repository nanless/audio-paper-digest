'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const quality = require('../scripts/editorial-quality');
test('实际语料句数与奖励配比不冒充词错误率', () => {
    const actual = [
        '指标仍是 OVRL、词错误率、相似度与语义分，300 句共享基础，原文报告完整在线推理策略优化在训练方法中四项最好，直接偏好优化与群组相对策略优化提升感知但恶化词错误率。',
        '奖励按 OVRL、词错误率、相似度、语义分 4:2:2:2 加权，偏好对按奖励差距成比例采样，有界复用 Tr 步后刷新缓冲并同步参考。'
    ];
    for (const text of actual) assert.deepEqual(quality.findMissingComparisonUnits(text), []);
    for (const text of [
        '300句评测中，准确率从80提高到90。',
        '奖励按词错误率与质量分4:2加权，准确率从80提高到90。',
        '词错误率从4降低到2。'
    ]) assert.ok(quality.findMissingComparisonUnits(text).length > 0, text);
    assert.deepEqual(quality.findMissingComparisonUnits('奖励按词错误率与质量分4:2加权，准确率从80%提高到90%。'), []);
});
test('近似时长保留原中文，精确测量值与百分比继续检查', () => {
    assert.deepEqual(quality.findQuantitativeChineseNumerals('偏语音评测也只到二三十分钟。'), []);
    for (const value of ['二百三十分钟', '二四十分钟', '二三十个百分点', '百分之九十九']) {
        assert.ok(quality.findQuantitativeChineseNumerals(value).length > 0, value);
    }
    const text = '偏语音评测也只到二三十分钟。';
    assert.equal(quality.normalizeIssueBoundReaderQuantitativeNumerals(text,
        [{code:'quantitative_chinese_numeral',match:'二三十分钟'}]), text);
});

test('具名提前量和中文距离门限不是附近的准确率结果', () => {
    for (const text of [
        '代价是同 1.5 秒提前量下维持话轮的准确率下降，因为提前看时抢话前的姿态调整与维持前的安静姿态难以区分，必须等到碰撞时刻的爆发才能确认维持。',
        '准确率统计误差小于 30 厘米的样本占比，数值越大越好。',
        '观察窗为 1.5 秒时，准确率下降。',
        '准确率统计误差小于30 cm的样本占比，数值越大越好。',
        '同1.5秒提前量下，准确率从80%提高到90%。'
    ]) assert.deepEqual(quality.findMissingComparisonUnits(text), [], text);
});

test('设置只遮本身，裸比较、结果位置的时间和伪单位仍拒绝', () => {
    for (const text of [
        '同 1.5 秒提前量下，准确率从80提高到90。',
        '观察窗为 1.5 秒时，准确率下降1.2。',
        '误差小于30厘米的样本占比是准确率，其结果从80提高到90。',
        '词错误率从1.92升到2.11。', '准确率从30米尔提高到40米尔。',
        '准确率下降1.5秒。', '准确率下降1.5秒提前量。',
        '准确率从2秒提前量提高到3秒提前量。'
    ]) assert.ok(quality.findMissingComparisonUnits(text).length, text);
});
