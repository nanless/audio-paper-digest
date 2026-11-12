'use strict';

// 系数 1 的裸科学量兜底：整行写了显式系数原子时不能再借出一个系数 1。
//
// b79362c7 给 projectScientificQuoteCoverage 加了“裸 10^-4 按系数 1 归一”的兜底，
// 注释写的前提是「Only scan this line when it has no explicit coefficient atom」，
// 但代码没有实现。于是这句散文
//   We use AdamW with learning rates of 1×10−4, 2×10−6, and 5×10−6 …
// 里的 `10−4`、`10−6` 尾巴被当成独立的系数 1 原子，反过来替表格里的
// `1×10⁻⁴`（系数 1）作证，少报一条 failure。2026-11-13 与发布端
// _api_reader_scientific_quote_projection 同批补上守卫（Python 侧由 py-publish 落）。
//
// 这里固定两个方向：越权借用必须拒绝；b79362c7 想修的“整行只有裸 10−4”仍要能覆盖，
// 否则守卫会把原本正确的稿子挡掉。
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const deep = require('../scripts/deep-analyzer');

const SCIENTIFIC_ISSUE = /科学量|exact quote\/cell/;

function table(values) {
    return ['| Setting | Value |', '| --- | --- |',
        ...values.map((value, index) => `| ${String.fromCharCode(65 + index)} | ${value} |`)].join('\n');
}

function bind(article, sourceText, quotes = [sourceText]) {
    return deep.bindApiReaderSourceEvidence(article, [{ tableIndex: 1, sourceType: 'source_quotes',
        sourceTableOrdinal: null, cellBindings: [], sourceQuotes: quotes }], [], {
        sourceText, structuredArtifacts: deep.bindStructuredArtifactsToText({ tables: [], formulas: [] }, sourceText),
        allowDeterministicQuoteRepair: false, allowDeterministicUnsupportedClaimPruning: false
    });
}

test('散文里的显式系数原子不能借出系数 1 的裸原子给表格', () => {
    const article = table(['1×10⁻⁴', '2×10⁻⁶', '5×10⁻⁶']);
    // 逐字来自 py-publish 定位的真实散文引文形态：三个显式系数写在同一句里。
    const prose = 'We use AdamW with learning rates of 1×10−4, 2×10−6, and 5×10−6 for the three settings.';
    assert.throws(() => bind(article, prose), SCIENTIFIC_ISSUE);
});

test('整行只有裸 10−4 时仍按系数 1 归一，守卫不误杀原本可覆盖的稿子', () => {
    const article = table(['1×10⁻⁴']);
    const quote = 'Original learning-rate settings are listed below.\n10−4\nEnd of original settings.';
    const result = bind(article, quote);
    assert.equal(result.article, article, '逐字保留原稿，不改写数值');
    assert.deepEqual(result.tableBindings[0].sourceQuotes.map(item => item.quote), [quote]);
});

test('显式系数与裸原子混在一行时按守卫拒绝，不退化成借一个原子', () => {
    // 同一行既有显式系数原子又有裸 10−5：守卫按整行跳过，宁可漏报也不外借。
    const article = table(['1×10⁻⁴']);
    const quote = 'Learning rate 1×10−4 and dropout 10−5 are used together.';
    assert.throws(() => bind(article, quote), SCIENTIFIC_ISSUE);
});

test('表格自身整格显式系数不受影响', () => {
    // 单元格是完整原子、引文也是完整行：守卫只在“整行不是完整原子”的分支生效。
    const article = table(['1×10⁻⁴']);
    const quote = 'Original settings.\n1×10−4\nEnd.';
    const result = bind(article, quote);
    assert.equal(result.article, article);
});
