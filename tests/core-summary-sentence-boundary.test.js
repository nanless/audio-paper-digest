'use strict';
// 2026-11-14 用户要求把核心摘要的句数上限从 9 放宽到 12：推理型模型稳定落在
// 10–12 句，旧的 6–9 会把正常输出判失败。下限 6、上限 12 与字数 320–600 一起
// 保留下来的边界必须有回归测试：10 句、12 句通过，13 句拒绝。
// 本文件测 Node 侧 validateCoreSummarySemanticContract；Python 侧同口径用例见
// tests/python/test_core_summary_sentence_boundary.py。
const assert = require('node:assert/strict');
const test = require('node:test');
const { validateCoreSummarySemanticContract } = require('../scripts/analysis-contract.js');
const { validAnalysisText } = require('./valid-analysis-fixture.js');

const sentenceCount = text => (String(text).match(/[。！？!?]/g) || []).length;

// 从仓库共用的合法分析正文里取出核心摘要（7 句、333 字的基线），再追加
// 短句补到目标句数；追加内容不改变任务、方法链、定量结果与边界等既有要素。
function summaryWithSentenceCount(count) {
    const base = /## 核心摘要\n([\s\S]*?)(?=\n## )/.exec(validAnalysisText())[1].trim();
    assert.equal(sentenceCount(base), 7, '基线核心摘要的句数变了，请同步更新本用例');
    const summary = base + '补充说明。'.repeat(count - 7);
    assert.equal(sentenceCount(summary), count);
    return summary;
}

const issueOf = summary => validateCoreSummarySemanticContract(`## 核心摘要\n${summary}`);

test('10 句核心摘要通过当前 6–12 句合同', () => {
    const summary = summaryWithSentenceCount(10);
    assert.equal(issueOf(summary), null);
});

test('12 句核心摘要仍在上限内，必须通过', () => {
    const summary = summaryWithSentenceCount(12);
    assert.equal(issueOf(summary), null);
});

test('13 句核心摘要超限，必须拒绝并指名句数边界', () => {
    const issue = issueOf(summaryWithSentenceCount(13));
    assert.match(issue, /句数必须为 6–12/);
    assert.match(issue, /当前 13/);
});
