'use strict';
// 2026-11-16 审计：`injectApiReaderFigures` 收到论文原图像素却看到空
// figurePlacements 时必须内容级报错，不能退回「按序号猜小节、裸插图片」。
// 裸插会绕开「图前导读 + 图后解释 + focusPoints」的整套要求，读者最终只看到
// 一张没有说明的图。本文件固定三条边界：空计划 + 有图 → 报错；有合法计划 →
// 正常装配；完全没有图 → 空计划仍可正常返回。
const assert = require('node:assert/strict');
const test = require('node:test');
const deep = require('../scripts/deep-analyzer.js');

const paperId = '2609.15067';
const figureUrl = `https://arxiv.org/html/${paperId}v1/overview.png`;

function artifacts() {
    return {
        figures: [{
            ordinal: 1,
            label: 'Figure 1:',
            caption: 'Figure 1: An overview of the evidence model.',
            sourceDomSha256: 'a'.repeat(64),
            recoveryStatus: 'complete',
            images: [{ kind: 'external_url', mediaType: 'image/png', url: figureUrl }]
        }],
        tables: [],
        formulas: [],
        payloadSha256: 'b'.repeat(64)
    };
}

function readerResult(figurePlacements) {
    return {
        article: '### 来源核对\n\n[[FIGURE_1]]',
        plan: { sections: [{ kind: 'result', heading: '来源核对' }], figurePlacements }
    };
}

test('收到原图但没有 figurePlacements 时不能裸插，必须内容级报错', () => {
    assert.throws(
        () => deep.injectApiReaderFigures(readerResult([]), artifacts(), paperId),
        /收到了论文原图像素，但 figurePlacements 为空/
    );
});

test('声明了小节、标记与观察点后正常装配图片和看图路径', () => {
    const placement = {
        figureOrdinal: 1,
        targetKind: 'result',
        marker: '[[FIGURE_1]]',
        focusPoints: ['先确认输入表示与输出目标之间的路径', '再比较各模块之间的连接方向']
    };
    const result = deep.injectApiReaderFigures(readerResult([placement]), artifacts(), paperId);
    assert.equal(result.figures.length, 1);
    assert.equal(result.figures[0].ordinal, 1);
    assert.match(result.article, new RegExp(`!\\[[^\\]]*\\]\\(${figureUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
    assert.match(result.article, /> \*\*看图路径：\*\* 1\. 先确认输入表示与输出目标之间的路径；2\. 再比较各模块之间的连接方向/);
    assert.match(result.article, /\*论文图 1。/);
    assert.doesNotMatch(result.article, /\[\[FIGURE_1\]\]/);
});

test('完全没有可用原图时，空 figurePlacements 仍可正常返回空图集', () => {
    const result = deep.injectApiReaderFigures(
        { article: '### 来源核对\n\n正文没有图。', plan: { sections: [{ kind: 'result', heading: '来源核对' }], figurePlacements: [] } },
        { figures: [], tables: [], formulas: [] },
        paperId
    );
    assert.deepEqual(result.figures, []);
});
