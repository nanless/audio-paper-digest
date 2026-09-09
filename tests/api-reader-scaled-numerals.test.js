const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReaderEditorialSurface } = require('../scripts/deep-analyzer.js');
const { findQuantitativeChineseNumerals } = require('../scripts/editorial-quality.js');

function repair(text) {
    const spaced = normalizeReaderEditorialSurface(text);
    const issues = findQuantitativeChineseNumerals(spaced).map(issue => ({
        code: 'quantitative_chinese_numeral', ...issue
    }));
    return normalizeReaderEditorialSurface(spaced, issues);
}

describe('Reader 明确量级是完整数值，不是可单独替换的后缀', () => {
    it('03231/04085与2512.09066真实量级句不把万拆为独立10000', () => {
        assert.equal(repair('论文回顾了从50词到超过12.5万词、词错率降到2.5%的进展。'),
            '论文回顾了从 50 词到超过 125,000 词、词错率降到 2.5% 的进展。');
        assert.equal(repair('批大小10，训练24万步，学习率初值0.0003。'),
            '批大小 10，训练 240,000 步，学习率初值 0.0003。');
        assert.equal(repair('真实候选扩充约45万对，另有3万问答对与1.5亿实例。'),
            '真实候选扩充约 450,000 对，另有 30,000 问答对与 150,000,000 实例。');
        assert.equal(repair('数据集含6.8万小时与2.4万行。'),
            '数据集含 68,000 小时与 24,000 行。');
        assert.equal(repair('词与字符特征各最多5万维。'),
            '词与字符特征各最多 50,000 维。');
    });

    it('04102完整参数规模与范围逐端精确换算，保留范围连接符', () => {
        assert.equal(repair('基础模型200亿参数，子集为10亿–40亿参数。'),
            '基础模型 20,000,000,000 参数，子集为 1,000,000,000–4,000,000,000 参数。');
    });

    it('有无空格、小数点与符号不改变精确量级，且无浮点舍入', () => {
        for (const raw of ['12.5万词', '12.5 万词', '12.5 万 词']) {
            assert.equal(repair(raw), '125,000 词');
        }
        assert.equal(repair('0.00001万词'), '0.1 词');
        assert.equal(repair('1.234567890123万词'), '12,345.67890123 词');
        assert.equal(repair('-1.25万词'), '-12,500 词');
        assert.equal(repair('12.5万亿词'), '12,500,000,000,000 词');
        assert.equal(normalizeReaderEditorialSurface('规模为1万。',
            [{ code: 'quantitative_chinese_numeral', match: '1万' }]), '规模为 10,000。');
    });

    it('不可确定的复合量级/分数/科学记号/数字碎片不局部乘或换后缀', () => {
        for (const raw of ['5.5百万参数', '1/2万词', '1 / 2万词',
                           '1e3万词', 'v2万词', '1.2.5万词']) {
            const spaced = normalizeReaderEditorialSurface(raw);
            assert.equal(repair(raw), spaced, raw);
        }
    });

    it('代码/公式/逐字引文/URL不改，阿拉伯数字近邻不影响非量级术语', () => {
        const literal = '`12.5万词与45万对`\n\n\\(24万步与45万对\\)\n\n> 原文：12.5万词与45万对\n\n“200亿参数与45万对”\n\nhttps://example.com/45万对';
        assert.equal(repair(literal), literal);
        assert.equal(repair('三分之一倍频程与3.5倍收益。'), '三分之一倍频程与 3.5 倍收益。');
        assert.equal(repair('成功率为百分之九十五，失败率为百分之五。'),
            '成功率为 95%，失败率为 5%。');
        assert.equal(repair('保留比例为四分之一。'), '保留比例为 1/4。');
        assert.equal(repair('宽度采用半宽与四分之一宽。'), '宽度采用 1/2 宽与 1/4 宽。');
        assert.equal(repair('至少一半样本命中，准确率达到五成。'),
            '至少 1/2 样本命中，准确率达到 50%。');
        assert.equal(repair('这里有四个条件与十个样本。'),
            '这里有 4 个条件与 10 个样本。');
        assert.equal(
            repair('失真从6.004（dB）降到4.632（dB），得分从0.758（分数）降到0.109（分数）。'),
            '失真从 6.004 dB 降到 4.632 dB，得分从 0.758 分降到 0.109 分。'
        );
        assert.equal(repair('完整模型更稳定，但'), '完整模型更稳定。');
        const once = repair('训练24万步，词表12.5万词。');
        assert.equal(repair(once), once);
    });
});
