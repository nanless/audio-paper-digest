'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findQuantitativeChineseNumerals } = require('../scripts/editorial-quality');
const { normalizeReaderProseFormatting } = require('../scripts/deep-analyzer');
const issues = text => findQuantitativeChineseNumerals(text).map(value => ({ ...value, code: 'quantitative_chinese_numeral' }));
const format = text => normalizeReaderProseFormatting(text, issues(text));

test('真实稿件共用成单位的范围整体转换，不从原论文猜测缺失精度', () => {
    const text = '早期下降近七到八成，总体下降五到六成。';
    assert.deepEqual(issues(text).map(x => x.match), ['七到八成', '五到六成']);
    assert.equal(format(text), '早期下降近 70% 到 80%，总体下降 50% 到 60%。');
    assert.doesNotMatch(format(text), /68|56|63/);
    assert.equal(format(format(text)), format(text));
});

test('两端成单位和区间分隔符保持数值，单比例仍能转换', () => {
    for (const separator of ['到', '至', '–', '—', '-']) {
        const result = format(`范围五成${separator}六成，另有八成。`);
        assert.match(result, /50%/);
        assert.match(result, /60%/);
        assert.match(result, /80%/);
        assert.ok(result.includes(separator));
    }
});

test('旧问题只指出末端时不能部分替换范围，较长数词和保护区保留', () => {
    const stale = [{ code: 'quantitative_chinese_numeral', match: '八成' }];
    assert.equal(normalizeReaderProseFormatting('另有八成，早期近七到八成。', stale), '另有 80%，早期近七到八成。');
    assert.equal(normalizeReaderProseFormatting('另有七成，范围七成到八成。',
        [{ code: 'quantitative_chinese_numeral', match: '七成' }]), '另有 70%，范围七成到八成。');
    assert.equal(format('七到八成半；十七到八成；七八成。'), '七到八成半；十七到八成；七八成。');
    const protectedText = '`七到八成`\n\n“七到八成”\n\n$七到八成$\n\n> 原文：七到八成\n\nhttps://example.com/七到八成';
    assert.equal(format(protectedText), protectedText);
});
