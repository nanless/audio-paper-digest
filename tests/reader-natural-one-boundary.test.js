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
