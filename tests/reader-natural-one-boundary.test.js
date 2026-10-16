'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const utils = require('../scripts/utils');
const savedLoadEnv = utils.loadEnvFile;
// 本测试只执行纯文本检查和排版，不依赖个人 .env 或请求任何网络。
utils.loadEnvFile = () => {
    process.env.PAPER_ANALYZER_API_KEY = 'test-placeholder';
    process.env.PAPER_ANALYZER_MODEL = 'test-model';
    process.env.PAPER_ANALYZER_ENDPOINT = 'https://example.invalid';
};
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const quality = require('../scripts/editorial-quality');
const deep = require('../scripts/deep-analyzer');
utils.loadEnvFile = savedLoadEnv;

function numericIssues(text) {
    return quality.validateEditorialQuality({ '核心摘要': text }).issues
        .filter(issue => issue.code === 'quantitative_chinese_numeral');
}

test('一致、一般、一定和统一是自然词，不能拆成参数数字', () => {
    for (const text of [
        '参考表示与源表示维度一致后才能做配对打分。',
        '窗口一般保持固定，所比较表示保持一致。',
        '阈值一定要在验证集上选择。',
        '网络将不同表示统一到相同空间。'
    ]) {
        const issues = numericIssues(text);
        assert.deepEqual(issues, [], text);
        assert.equal(deep.normalizeReaderProseFormatting(text, issues), text);
    }
});

test('真实参数数值继续完整诊断和转换，不能回退成数词前缀', () => {
    for (const [text, value] of [
        ['表示维度一百二十八，之后交给分类器。', '128'],
        ['通道数两，之后合并信号。', '2'],
        ['阈值一百，之后固定不变。', '100']
    ]) {
        const issues = numericIssues(text);
        assert.equal(issues.length, 1, text);
        const result = deep.normalizeReaderProseFormatting(text, issues);
        assert.ok(result.includes(value), result);
        assert.ok(!result.includes('128 八'), result);
    }
});

test('旧诊断误截自然词时也保留原句，不能再次生成维度1致', () => {
    for (const [text, match] of [
        ['参考表示与源表示维度一致后才能做配对打分。', '维度一'],
        ['窗口一般保持固定。', '窗口一'],
        ['阈值一定要保持固定。', '阈值一']
    ]) {
        assert.equal(deep.normalizeReaderProseFormatting(text, [{
            code: 'quantitative_chinese_numeral', match, reason: 'technical_parameter'
        }]), text);
    }
});

test('排版还原的任务和条件指代不再被数量检查重新拒绝', () => {
    for (const text of [
        '推理时也不告诉模型当前是哪 1 个任务。',
        '下1个任务换另一个系统，流程重复。',
        '另 1 个条件是把英语子集扩到多语言。',
        '临床验证部分是另 1 个条件，它只用70例英语样本。',
        '只报告准确率。下一个任务重新训练。'
    ]) {
        const formatted = deep.normalizeReaderProseFormatting(text);
        assert.deepEqual(quality.findQuantitativeChineseNumerals(formatted)
            .filter(issue => /^一个(?:任务|条件)$/.test(issue.match)), [], formatted);
    }
    for (const prefix of '上下这另哪') for (const noun of ['任务', '条件']) {
        const text = `${prefix}一个${noun}需要重新说明。`;
        assert.deepEqual(quality.findQuantitativeChineseNumerals(text), [], text);
        assert.equal(deep.isAllowedReaderNarrativeNumeralIssue({
            code: 'quantitative_chinese_numeral', match: `一个${noun}`, index: 1
        }, text), true, text);
    }
});

test('数量限定和同句其他科学数值继续检查，指代不能豁免整句', () => {
    for (const text of [
        '模型只在一个任务上评测。', '共有一个条件。', '比较了两个条件的结果。',
        '实验只在这一个任务上评测。', '仅有下一个条件可用。',
        '只在经过严格控制和充分验证的这一个任务上评测。',
        '下一个任务包含一千个样本。', '另一个条件提升百分之三。',
        '这一个任务训练一轮。', '哪一个条件的阈值为三。', 'batch为一。'
    ]) {
        const issues = numericIssues(text);
        assert.ok(issues.length, text);
        for (const issue of issues) {
            assert.equal(quality.isDiscourseTaskConditionNumeral(text, issue.index, issue.match), false, text);
            if (/^一个(?:任务|条件)$/.test(issue.match)) {
                assert.equal(deep.isAllowedReaderNarrativeNumeralIssue(issue, text), false, text);
            }
        }
    }
    for (const [text, index, surface] of [
        ['一个任务完成。', 0, '一个任务'], ['下一个任务完成。', 0, '一个任务'],
        ['下一个任务完成。', 2, '一个任务'], ['下一秒开始。', 1, '一秒']
    ]) assert.equal(quality.isDiscourseTaskConditionNumeral(text, index, surface), false, text);
});
