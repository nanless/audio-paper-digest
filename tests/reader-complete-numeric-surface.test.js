const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReaderProseFormatting } = require('../scripts/deep-analyzer');
const { findQuantitativeChineseNumerals } = require('../scripts/editorial-quality');
function repair(text) {
    const spaced = normalizeReaderProseFormatting(text);
    const issues = findQuantitativeChineseNumerals(spaced)
        .map(issue => ({ ...issue, code: 'quantitative_chinese_numeral' }));
    return normalizeReaderProseFormatting(spaced, issues);
}
describe('按完整数值处理当前付费稿中的中文数字', () => {
    it('二十六分不能只诊断最后六分，分数与小数也不拆开', () => {
        const input = '离线与在线在 Slakh 自身上差二十六分，但域外差值在一分以内。';
        const issues = findQuantitativeChineseNumerals(input);
        assert.ok(issues.some(issue => issue.match === '二十六分'));
        assert.ok(!issues.some(issue => issue.match === '六分'));
        assert.equal(repair(input), '离线与在线在 Slakh 自身上差 26 分，但域外差值在一分以内。');
        assert.equal(repair('提高零点七六分，比例为六分之一。'), '提高 0.76 分，比例为六分之一。');
        assert.equal(repair('比例为百分之六分之一。'), '比例为百分之六分之一。');
    });
    it('同一是指代，后接完整三十条不与末尾一合并；其他数字边界仍保护', () => {
        assert.equal(repair('效用用同一三十条的语料级字错率。'), '效用用同一 30 条的语料级字错率。');
        for (const text of ['一三十条', '十三十条', '1三十条']) {
            const spaced = normalizeReaderProseFormatting(text);
            assert.equal(normalizeReaderProseFormatting(spaced,
                [{ code: 'quantitative_chinese_numeral', match: '三十条' }]), spaced);
        }
    });
    it('百万和千万整体精确移小数点，串列与负号保留', () => {
        assert.equal(repair('约需0.39百万、0.79百万与150.8百万参数。'),
            '约需 390,000、790,000 与 150,800,000 参数。');
        assert.equal(repair('5.5百万参数与2.3千万参数。'), '5,500,000 参数与 23,000,000 参数。');
        assert.equal(repair('-0.00000001百万参数。'), '-0.01 参数。');
        const text = '1.234567890123百万参数。';
        assert.equal(repair(text), '1,234,567.890123 参数。');
        assert.equal(repair(repair(text)), repair(text));
    });
    it('分数、科学记号、版本号、引文、公式、链接不能借量级诊断改写', () => {
        for (const text of ['1/2百万参数', '1e3百万参数', 'v2百万参数', '1.2.5百万参数']) {
            assert.equal(repair(text), normalizeReaderProseFormatting(text));
        }
        const literal = '`同一三十条，5.5百万参数`\n\n“二十六分”\n\n\\(5.5百万参数\\)\n\nhttps://example.com/5.5百万参数';
        assert.equal(repair(literal), literal);
    });
});
