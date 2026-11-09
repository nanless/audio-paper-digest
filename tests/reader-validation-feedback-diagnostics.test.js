'use strict';

// 2026-11-09 日更 Reader 失败稿的修复反馈：反馈必须点名可执行的具体字段与来源，
// 不能只回显“结构非法”“格式头未登记”这类无法定位的结论。
const test = require('node:test');
const assert = require('node:assert/strict');
const deep = require('../scripts/deep-analyzer');
const repair = require('../scripts/lib/reader-repair');
const codec = require('../scripts/lib/protocol-codec');

test('格式头反馈点名当前登记的完整格式头，并要求重新生成而不是沿用旧稿头', () => {
    const feedback = deep.buildApiReaderValidationFeedback(new Error('读者文章格式头未登记或字段混用'));
    const header = codec.recordHeader('reader-draft', 'reader-draft');
    assert.ok(feedback.includes(JSON.stringify(header)), feedback);
    assert.match(feedback, /不要输出 version、schemaVersion、policyVersion/);
    assert.match(feedback, /上一版草稿的格式头若无效就不要沿用/);
    assert.match(feedback, /不能只改头部而沿用旧稿的无效结构/);
});

test('PDF 引文反馈要求逐字复制本次 PDF 原文，没有原文时删除 pdfSourceQuotes', () => {
    for (const message of [
        'PDF quotation is missing or ambiguous: [0] pdf_quote_not_unique:0',
        '读者文章 tableBindings[0] pdfSourceQuotes 必须在当前真实封存 PDF 作用域中，逐项核验为12–4000字符'
    ]) {
        const feedback = deep.buildApiReaderValidationFeedback(new Error(message));
        assert.match(feedback, /pdfSourceQuotes 只能逐字复制/, message);
        assert.match(feedback, /删除 pdfSourceQuotes/, message);
        assert.match(feedback, /重复数字/, message);
        assert.match(feedback, /不能把 HTML 全文/, message);
    }
});

test('source_quotes 结构反馈点名 ordinal 必须为 null 并给出封存 PDF 引文路径', () => {
    const feedback = deep.buildApiReaderValidationFeedback(new Error(
        '读者文章 tableBindings[0] 正文 quote 绑定结构非法（sourceTableOrdinal=1，source_quotes 必须为 null）'));
    assert.match(feedback, /sourceTableOrdinal 必须为 null/);
    assert.match(feedback, /pdfSourceQuotes/);
    assert.match(feedback, /不能同时保留原表序号/);
});

test('粘连复写反馈允许以封存 PDF 的单一值取代 MathJax 双写单元格', () => {
    const feedback = deep.buildApiReaderValidationFeedback(new Error(
        '读者文章第 3 张表粘连复写（数据行 1第 3 格“0.000.00”）：单元格存在疑似粘连复写“0.000.00”，'
        + '须核对完整原始值与绑定，不能仅按重复形状删减数字'));
    assert.match(feedback, /封存 PDF 原文对同一格只给出单一值/);
    assert.match(feedback, /双写形式只保留在引文里/);
    // 仍然禁止凭空猜半值。
    assert.match(feedback, /不得猜测半值/);
});

test('pdfSourceQuoteFailure 返回真实失败原因而不是静默的布尔值', () => {
    const scopeReason = repair.pdfSourceQuoteFailure({ sourceType: 'source_quotes',
        pdfSourceQuotes: ['A complete sentence of the sealed PDF.'] });
    assert.match(String(scopeReason), /verified source scope/);
    assert.equal(repair.pdfSourceQuoteFailure({ sourceType: 'source_quotes', pdfSourceQuotes: ['short'] }),
        '引文必须是 12–4000 字符的非空字符串数组');
    assert.equal(repair.pdfSourceQuoteFailure({ sourceType: 'source_quotes' }),
        '引文必须是 12–4000 字符的非空字符串数组');
});
