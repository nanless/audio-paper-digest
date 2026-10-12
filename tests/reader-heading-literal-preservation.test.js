'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { restoreReaderSectionHeadings, demoteReaderBodySectionHeadings } = require('../scripts/deep-analyzer');

test('代码和引用中的三级标题不消耗正式小节的恢复位置', () => {
    const protectedContent = '```markdown\n### 代码中的标题\n```\n\n~~~\n### 第二个代码标题\n~~~\n\n    ### 缩进代码\n\t### 制表符代码\n\n> 原文引述开始\n引用续行正文\n> ### 带引用符标题\n\n';
    const article = `### 旧标题一\n\n正文一。\n\n${protectedContent}### 旧标题二\n\n正文二。`;
    const expected = `### 新正式标题一\n\n正文一。\n\n${protectedContent}### 新正式标题二\n\n正文二。`;
    assert.equal(restoreReaderSectionHeadings(article, [{ heading: '新正式标题一' }, { heading: '新正式标题二' }]), expected);
});

test('普通标题恢复与正文子标题降级仍使用同一保护规则', () => {
    const body = '### 正文子标题\n正文。\n\n```\n### 代码标题\n```';
    assert.equal(demoteReaderBodySectionHeadings(body), '#### 正文子标题\n正文。\n\n```\n### 代码标题\n```');
    const article = '### 第一节\n\n正文。\n\n### 第二节\n\n另一段。';
    assert.equal(restoreReaderSectionHeadings(article, [{ heading: '已核第一节' }, { heading: '已核第二节' }]),
        '### 已核第一节\n\n正文。\n\n### 已核第二节\n\n另一段。');
});


test('无引用符的 ATX 标题结束引用，真实新小节仍恢复到正确位置', () => {
    const article = '### 旧第一节\n\n> 引用段落\n### 旧第二节\n\n后续正文。';
    assert.equal(restoreReaderSectionHeadings(article, [{ heading: '正式第一节' }, { heading: '正式第二节' }]),
        '### 正式第一节\n\n> 引用段落\n### 正式第二节\n\n后续正文。');
    assert.equal(demoteReaderBodySectionHeadings('> 引用段落\n### 真实子标题\n正文。'),
        '> 引用段落\n#### 真实子标题\n正文。');
    assert.equal(demoteReaderBodySectionHeadings('> ### 引用中的标题\n> 原文。'),
        '> ### 引用中的标题\n> 原文。');
});
