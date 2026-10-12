'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeIssueBoundReaderNumericTypography } = require('../scripts/deep-analyzer');
const { findNumericTypographyDefects } = require('../scripts/editorial-quality');

const reportedIssues = [{ code: 'numeric_typography', match: '106张' }];

test('上标指数的归一诊断只补量词空格并保留指数和值', () => {
    const testData = { sections: [{ body: 'EMA 半衰期为 10⁶张生成图，学习率为 3e-7。' }] };
    assert.equal(findNumericTypographyDefects('10⁶张')[0].match, '106张');
    assert.equal(normalizeIssueBoundReaderNumericTypography(testData, reportedIssues), true);
    assert.equal(testData.sections[0].body, 'EMA 半衰期为 10⁶ 张生成图，学习率为 3e-7。');
    assert.deepEqual(findNumericTypographyDefects('10⁶ 张'), []);
    assert.equal(normalizeIssueBoundReaderNumericTypography(testData, reportedIssues), false);
    const differentValue = { sections: [{ body: '保留 10⁵张和普通 106张。' }] };
    normalizeIssueBoundReaderNumericTypography(differentValue, reportedIssues);
    assert.equal(differentValue.sections[0].body, '保留 10⁵张和普通 106 张。');
});

test('没有匹配排版诊断时不改上标数字', () => {
    const testData = { sections: [{ body: 'EMA 半衰期为 10⁶张。' }] };
    assert.equal(normalizeIssueBoundReaderNumericTypography(testData, []), false);
    assert.equal(normalizeIssueBoundReaderNumericTypography(testData,
        [{ code: 'numeric_typography', match: '105张' }]), false);
    assert.equal(testData.sections[0].body, 'EMA 半衰期为 10⁶张。');
});

test('上标排版修复不改代码引文公式和来源表的原字节', () => {
    const protectedBodies = [
        '`10⁶张`', '```text\n10⁶张\n```', '~~~text\n10⁶张\n~~~',
        '    10⁶张', '> 原文 10⁶张', '> 原文引述\n10⁶张',
        '$10⁶张$', '\\(10⁶张\\)', '<code>10⁶张</code>', '<!-- 10⁶张 -->',
        '| 原文 | 数量 |\n| --- | --- |\n| 报告 | 10⁶张 |'
    ];
    for (const body of protectedBodies) {
        const testData = { sections: [{ body }] };
        assert.equal(normalizeIssueBoundReaderNumericTypography(testData, reportedIssues), false, body);
        assert.equal(testData.sections[0].body, body);
    }
});

test('同一行的普通数字和重复上标逐项定位并保护各自代码区域', () => {
    const samples = [
        ['普通 106张与指数 10⁶张', '普通 106 张与指数 10⁶ 张'],
        ['正文10⁶张，<code>10⁶张</code>', '正文10⁶ 张，<code>10⁶张</code>'],
        ['<code>10⁶张</code>，正文10⁶张', '<code>10⁶张</code>，正文10⁶ 张'],
        ['正文10⁶张，`10⁶张`，又10⁶张', '正文10⁶ 张，`10⁶张`，又10⁶ 张'],
        ['$10⁶张$，正文10⁶张，$10⁶张$', '$10⁶张$，正文10⁶ 张，$10⁶张$']
    ];
    for (const [body, expected] of samples) {
        const testData = { sections: [{ body }] };
        assert.equal(normalizeIssueBoundReaderNumericTypography(testData, reportedIssues), true, body);
        assert.equal(testData.sections[0].body, expected);
    }
});
