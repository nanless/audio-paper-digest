'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const deep = require('../scripts/deep-analyzer');
function createArticle() {
    return { sections: [{ kind: 'ablation', heading: '第一条件', body: '第一条件的事实保持原样。' },
        { kind: 'ablation', heading: '第二条件', body: '导读512维。[[FIGURE_2]]解释λ与原文条件。' }],
        figurePlacements: [{ figureOrdinal: 2, marker: '[[FIGURE_2]]', targetKind: 'ablation' }] };
}
test('唯一已有图标记在第二个同类小节时只机械分段该处', () => {
    const article = createArticle();
    const before = structuredClone(article);
    deep.normalizeDeclaredReaderMarkerParagraphs(article);
    assert.deepEqual(article.sections[0], before.sections[0]);
    assert.equal(article.sections[1].body, '导读512维。\n\n[[FIGURE_2]]\n\n解释λ与原文条件。');
    assert.deepEqual(article.figurePlacements, before.figurePlacements);
    assert.equal(article.sections[1].body.replaceAll('\n', ''), before.sections[1].body);
});
test('重复标记不触发新的实际位置选择分支', () => {
    const article = createArticle();
    article.sections[0].body += '[[FIGURE_2]]';
    const before = structuredClone(article);
    deep.normalizeDeclaredReaderMarkerParagraphs(article);
    assert.deepEqual(article.sections[1], before.sections[1]);
    assert.deepEqual(article.figurePlacements, before.figurePlacements);
});
test('标记位于错误kind时不自动搬移或重签', () => {
    const article = createArticle();
    article.sections[1].kind = 'result';
    const before = structuredClone(article);
    deep.normalizeDeclaredReaderMarkerParagraphs(article);
    assert.deepEqual(article, before);
});
