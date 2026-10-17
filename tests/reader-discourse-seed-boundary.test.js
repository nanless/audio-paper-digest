'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const stop = require('../scripts/lib/analysis-stop-control');
const quality = require('../scripts/editorial-quality');
const deep = require('../scripts/deep-analyzer');

const numericIssues = text => quality.findQuantitativeChineseNumerals(text);
const seedIssues = text => numericIssues(text).filter(issue => /随机种子/u.test(issue.match));

test('真实保存稿的另1个随机种子经正常排版后不再产生数量诊断闭环', () => stop.withModelRequestsForbidden(() => {
    // chen26l 原付费候选的既有句子；只测试纯排版与文风检查，不冒称整篇资格通过。
    const saved = '需要补的验证至少有三项：一是报告保留量变化曲线，说明最佳点是否稳定；二是报告排序器分数与最终翻译增益的关系，避免只看单点；三是在另 1 个随机种子或另一份挖掘切分上重复，确认提升不是切分运气。';
    const formatted = deep.normalizeReaderProseFormatting(saved);
    assert.ok(formatted.includes('另一个随机种子'), formatted);
    assert.deepEqual(seedIssues(formatted), []);
    const index = formatted.indexOf('一个随机种子');
    assert.equal(quality.isDiscourseTaskConditionNumeral(formatted, index, '一个随机种子'), true);
    assert.equal(deep.isAllowedReaderNarrativeNumeralIssue({
        code: 'quantitative_chinese_numeral', match: '一个随机种子', index
    }, formatted), true);
}));

test('随机种子指代复用既有完整surface与index约束', () => stop.withModelRequestsForbidden(() => {
    for (const prefix of '上下这另哪') {
        const text = `${prefix}一个随机种子上的结果需要复核。`;
        assert.deepEqual(seedIssues(text), [], text);
        assert.equal(quality.isDiscourseTaskConditionNumeral(text, 1, '一个随机种子'), true, text);
        for (const index of [0, 2, -1]) {
            assert.equal(quality.isDiscourseTaskConditionNumeral(text, index, '一个随机种子'), false, text);
        }
        assert.equal(quality.isDiscourseTaskConditionNumeral(text, 1, '一个随机'), false, text);
    }
    assert.deepEqual(seedIssues('只报告准确率。另一个随机种子上重复。'), []);
}));

test('真实随机种子计数及同句数量限定不借指代获豁免', () => stop.withModelRequestsForbidden(() => {
    for (const text of [
        '实验只用一个随机种子。', '实验仅用一个随机种子。',
        '至少一个随机种子通过测试。', '至多一个随机种子通过测试。',
        '共有一个随机种子。', '共计一个随机种子。',
        '比较了两个随机种子的结果。', '固定三个随机种子。'
    ]) {
        assert.ok(seedIssues(text).length, text);
    }
    for (const limiter of ['只', '仅', '至少', '至多', '恰好', '共有', '共计', '总共', '总计', '一共', '剩余']) {
        const text = `${limiter}在经过严格控制和验证的这一个随机种子上评测。`;
        const index = text.indexOf('一个随机种子');
        assert.equal(quality.isDiscourseTaskConditionNumeral(text, index, '一个随机种子'), false, text);
        assert.ok(seedIssues(text).length, text);
        assert.equal(deep.isAllowedReaderNarrativeNumeralIssue({
            code: 'quantitative_chinese_numeral', match: '一个随机种子', index
        }, text), false, text);
    }
}));

test('只屏蔽指代跨度，其他种子数量与训练计数保持原偏移和诊断', () => stop.withModelRequestsForbidden(() => {
    const text = '在另一个随机种子上重复，并增加三个随机种子与一千个样本，训练三轮。';
    const issues = numericIssues(text);
    assert.ok(issues.some(issue => /三个随机种子/u.test(issue.match)), JSON.stringify(issues));
    assert.ok(issues.some(issue => /一千/u.test(issue.match)), JSON.stringify(issues));
    const rounds = issues.find(issue => /三轮/u.test(issue.match));
    assert.ok(rounds, JSON.stringify(issues));
    assert.equal(rounds.index, text.indexOf('三轮'));
    assert.ok(!issues.some(issue => issue.match === '一个随机种子'));
}));
