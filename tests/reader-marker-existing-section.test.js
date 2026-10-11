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

function createConceptBridgeSample() {
    return {
        sections: [
            { kind: 'result', heading: '第一结果', body: '第一结果的事实保持原样。' },
            { kind: 'result', heading: '第二结果', body: '结果数值12.4%。[[CONCEPT_BRIDGE_1]]原解释保持。' }
        ],
        conceptBridges: [{
            terms: ['编码器任务强度', '域重采样'],
            sectionKind: 'result',
            marker: '[[CONCEPT_BRIDGE_1]]',
            explanation: '两个组件分别提供表示与数据分配，本次修复只隔开已有标记，不改这段原说明。'
        }]
    };
}

test('唯一组合解释标记位于第二个同类章节时只在原处插空行', () => {
    const sample = createConceptBridgeSample();
    const original = structuredClone(sample);
    deep.normalizeDeclaredReaderMarkerParagraphs(sample);
    assert.deepEqual(sample.sections[0], original.sections[0]);
    assert.equal(sample.sections[1].body, '结果数值12.4%。\n\n[[CONCEPT_BRIDGE_1]]\n\n原解释保持。');
    assert.equal(sample.sections[1].body.replaceAll('\n', ''), original.sections[1].body);
    assert.deepEqual(sample.conceptBridges, original.conceptBridges);
});

test('组合解释标记重复或属于另一章节时不取得唯一定位修复', () => {
    for (const scenario of ['重复', '错误章节', '不存在章节']) {
        const sample = createConceptBridgeSample();
        if (scenario === '重复') sample.sections[0].body += '[[CONCEPT_BRIDGE_1]]';
        if (scenario === '错误章节') sample.sections[1].kind = 'training';
        if (scenario === '不存在章节') sample.conceptBridges[0].sectionKind = 'ablation';
        const original = structuredClone(sample);
        deep.normalizeDeclaredReaderMarkerParagraphs(sample);
        assert.deepEqual(sample.sections[1], original.sections[1]);
        assert.deepEqual(sample.conceptBridges, original.conceptBridges);
    }
});

test('组合解释标记在反引号、代码围栏或转义文本中不能转成正文独段', () => {
    for (const body of ['`[[CONCEPT_BRIDGE_1]]`', '```text\n[[CONCEPT_BRIDGE_1]]\n```', '\\[[CONCEPT_BRIDGE_1]]']) {
        const sample = createConceptBridgeSample();
        sample.sections[1].body = body;
        const original = structuredClone(sample);
        deep.normalizeDeclaredReaderMarkerParagraphs(sample);
        assert.deepEqual(sample, original);
    }
});


test('引用行和缩进代码中的组合解释标记不能抽成正文授权', () => {
    for (const body of [
        '> [[CONCEPT_BRIDGE_1]]',
        '> 引文[[CONCEPT_BRIDGE_1]]原文',
        '    [[CONCEPT_BRIDGE_1]]',
        '\t原代码[[CONCEPT_BRIDGE_1]]'
    ]) {
        const sample = createConceptBridgeSample();
        sample.sections[1].body = body;
        const original = structuredClone(sample);
        deep.normalizeDeclaredReaderMarkerParagraphs(sample);
        assert.deepEqual(sample, original);
    }
});


test('引用续行、表格单元格和HTML链接字面内容不能提升为组合标记', () => {
    for (const body of [
        '> 原文引用\n[[CONCEPT_BRIDGE_1]]',
        '> 原文引用\n下一行[[CONCEPT_BRIDGE_1]]仍是引文',
        '|说明|内容|\n|---|---|\n|原文|[[CONCEPT_BRIDGE_1]]|',
        '<!-- [[CONCEPT_BRIDGE_1]] -->',
        '<!-- 原注释\n\n[[CONCEPT_BRIDGE_1]]\n-->',
        '<code>[[CONCEPT_BRIDGE_1]]</code>',
        '<code>\n\n[[CONCEPT_BRIDGE_1]]\n\n</code>',
        '<pre>\n\n原代码[[CONCEPT_BRIDGE_1]]\n\n</pre>',
        '[说明[[CONCEPT_BRIDGE_1]]](https://example.com)'
    ]) {
        const sample = createConceptBridgeSample();
        sample.sections[1].body = body;
        const original = structuredClone(sample);
        deep.normalizeDeclaredReaderMarkerParagraphs(sample);
        assert.deepEqual(sample, original);
    }
    const sample = createConceptBridgeSample();
    sample.sections[1].body = '> 原引用结束。\n\n普通正文[[CONCEPT_BRIDGE_1]]正常解释。';
    deep.normalizeDeclaredReaderMarkerParagraphs(sample);
    assert.equal(sample.sections[1].body, '> 原引用结束。\n\n普通正文\n\n[[CONCEPT_BRIDGE_1]]\n\n正常解释。');
});
