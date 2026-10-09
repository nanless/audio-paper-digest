'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const deep = require('../scripts/deep-analyzer.js');

function figure(id, ordinal, name, caption) {
    return { ordinal, label: `Figure ${ordinal}:`, caption,
        sourceDomSha256: String(ordinal).repeat(64), recoveryStatus: 'complete',
        images: [{ kind: 'external_url', mediaType: name.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
            url: `https://arxiv.org/html/${id}v1/${name}` }] };
}
function reader(ordinals) {
    return { article: `### 结果核对\n\n${ordinals.map(n => `[[FIGURE_${n}]]`).join('\n\n')}`,
        plan: { sections: [{ kind: 'result', heading: '结果核对' }],
            figurePlacements: ordinals.map(n => ({ figureOrdinal: n, targetKind: 'result', marker: `[[FIGURE_${n}]]` })) } };
}

test('同名图像不得覆盖封存 DOM 的图号和图注，也不得引入未提供的公式事实', () => {
    const id = '2609.15067', artifacts = { tables: [], formulas: [], figures: [
        figure(id, 1, 'overview.png', 'Figure 1: Source-backed overview of a listening test.'),
        figure(id, 2, 'method.png', 'Figure 2: Source-backed trial protocol.')
    ] };
    const before = structuredClone(artifacts);
    const inventory = deep.getApiReaderFigureInventory(artifacts, id);
    assert.deepEqual(inventory.map(item => [item.ordinal, item.caption, item.url]),
        artifacts.figures.map(item => [item.ordinal, item.caption, item.images[0].url]));
    const evidence = deep.buildApiReaderArtifactEvidence(artifacts, id);
    const rendered = deep.injectApiReaderFigures(reader([1, 2]), artifacts, id);
    assert.match(evidence, /Source-backed overview/);
    assert.match(rendered.article, /Source-backed trial protocol/);
    assert.doesNotMatch(evidence + rendered.article, /FormulaBank|N\(C,I\)|Controlled procedural|Overview of the study/);
    assert.deepEqual(artifacts, before);
});

test('仅凭旧 URL 不得声称四语料、曲线或图注与像素错配', () => {
    const id = '2609.27195', artifacts = { figures: [figure(id, 3, 'fig4_placement_ratio_readable.svg',
        'Figure 3: A source-captioned placement ratio experiment.')] };
    const rendered = deep.injectApiReaderFigures(reader([3]), artifacts, id);
    assert.match(rendered.article, /source-captioned placement ratio experiment/);
    assert.doesNotMatch(rendered.article, /四个语料|信噪比|语音帧漂移|像素错配|实际像素对应/);
    assert.equal(rendered.figures[0].assetSha256, undefined);
    const old = `### 结果核对\n\n![旧图说明](${rendered.figures[0].url})\n\n*论文图 3。四个语料随信噪比变化，像素错配。*`;
    const refreshed = deep.rewriteApiReaderFigureNarratives(old, rendered.figures);
    assert.match(refreshed, /source-captioned placement ratio experiment/);
    assert.doesNotMatch(refreshed, /四个语料|信噪比|像素错配/);
});

test('已有精确图像 SHA 的核验说明继续保留，不匹配时回到原图注', () => {
    const known = { ordinal: 1, label: 'Figure 1:', caption: 'Figure 1: Source caption.',
        url: 'https://arxiv.org/html/2609.34337v1/framework.svg',
        assetSha256: 'f2dc8c1f63fa0141176bf5bf826166b7411d352bba29bd8ec203e72e08b077f3' };
    const article = `![旧说明](${known.url})\n\n*论文图 1。旧说明。*`;
    assert.match(deep.rewriteApiReaderFigureNarratives(article, [known]), /UniAdapt|冻结因果编码器/);
    const changed = deep.rewriteApiReaderFigureNarratives(article, [{ ...known, assetSha256: '0'.repeat(64) }]);
    assert.match(changed, /Source caption/);
    assert.doesNotMatch(changed, /UniAdapt|冻结因果编码器/);
});
