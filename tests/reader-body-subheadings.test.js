'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { demoteReaderBodySectionHeadings, injectApiReaderFigures } = require('../scripts/deep-analyzer');

test('正文三级子标题只降一级，所有文字、空白和图标记保持', () => {
    const body = '先解释问题。\n\n### 参数与条件\n正文。\n\n  ### 层依赖的解释\n\n[[FIGURE_2]]\n\n#### 已有四级标题\n结束。';
    const expected = '先解释问题。\n\n#### 参数与条件\n正文。\n\n  #### 层依赖的解释\n\n[[FIGURE_2]]\n\n#### 已有四级标题\n结束。';
    assert.equal(demoteReaderBodySectionHeadings(body), expected);
    assert.equal(demoteReaderBodySectionHeadings(expected), expected);
    assert.equal(demoteReaderBodySectionHeadings('正文没有子标题。'), '正文没有子标题。');
});

test('代码围栏、缩进代码与引用中的标题字节不改', () => {
    const protectedBody = '```markdown\n### 代码标题\n```\n\n~~~\n### 波浪围栏标题\n~~~\n\n    ### 缩进代码\n\t### 制表符代码\n\n> 引用开始\n### 引用续行\n> ### 引用标题\n\n普通正文。';
    assert.equal(demoteReaderBodySectionHeadings(protectedBody), protectedBody);
});

test('自定义正式小节标题仍按真实图标记定位，正文子标题不占章节位置', () => {
    const title = '层依赖如何影响最优表示的选择';
    const body = demoteReaderBodySectionHeadings('先交代比较条件。\n\n### 子问题的解释\n\n[[FIGURE_2]]\n\n保留来源图的结果说明。');
    const reader = { article: `### ${title}\n\n${body}`, plan: {
        sections: [{ kind: 'result', heading: title }],
        figurePlacements: [{ figureOrdinal: 2, targetKind: 'result', marker: '[[FIGURE_2]]' }]
    } };
    const artifacts = { figures: [{ ordinal: 2, caption: 'Original result figure', recoveryStatus: 'complete',
        sourceDomSha256: 'a'.repeat(64),
        images: [{ kind: 'external_url', url: 'https://arxiv.org/html/2610.90001/figure2.png' }] }] };
    const result = injectApiReaderFigures(reader, artifacts, '2610.90001v1');
    assert.equal(result.figures.length, 1);
    assert.match(result.article, /#### 子问题的解释/);
    assert.ok(!result.article.includes('[[FIGURE_2]]'));
});
