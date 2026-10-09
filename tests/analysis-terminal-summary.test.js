const test = require('node:test');
const assert = require('node:assert/strict');
const { formatAnalysisStatus, formatAnalysisCount, formatAnalysisSources } = require('../scripts/lib/analysis-terminal-summary.js');

test('终端明确区分分析完成、部分失败、失败和未知状态', () => {
    assert.deepEqual(['complete', 'partial_failed', 'failed', 'incomplete'].map(formatAnalysisStatus),
        ['完成', '部分失败', '失败', '未完成']);
    assert.equal(formatAnalysisStatus('deployed'), '未知状态（原值：deployed）');
    assert.equal(formatAnalysisStatus('__proto__'), '未知状态（原值：__proto__）');
});

test('缺失或无效计数不会在终端被写成零', () => {
    assert.equal(formatAnalysisCount(0), '0');
    assert.equal(formatAnalysisCount(7), '7');
    for (const value of [undefined, null, -1, NaN, '3', false]) {
        assert.equal(formatAnalysisCount(value), `未知（原值：${String(value)}）`);
    }
});

test('来源说明保留原计数、未知原值且不修改统计对象', () => {
    const sources = { html: 2, abstract: 0, future_source: 3, pdf: undefined };
    const original = structuredClone(sources);
    assert.equal(formatAnalysisSources(sources),
        '论文网页全文：2 篇 | 论文摘要：0 篇 | 未知来源（原值：future_source）：3 篇 | 论文 PDF 文本：未知（原值：undefined） 篇');
    assert.deepEqual(sources, original);
    assert.equal(formatAnalysisSources({}), '');
});
