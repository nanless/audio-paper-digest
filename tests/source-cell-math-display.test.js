'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { strictSourceCellMathDisplay } = require('../scripts/lib/source-cell-math-display');
const cases = require('./fixtures/source-cell-math-display-cases.json').cases;
const sources = require('./fixtures/source-cell-math-display-source-tables.json').sources;
const display = require('../scripts/lib/reader-table-pdf-evidence');
const tables = require('../scripts/lib/reader-tables');
const sha = x => crypto.createHash('sha256').update(x).digest('hex');

test('真实封存单元格和构造正反例严格 whole-cell 同值，保留精度和原字节', () => {
    assert.equal(cases.filter(c => c.kind === 'real-sealed-source').length, 16);
    for (const c of cases) {
        const proof = strictSourceCellMathDisplay(c.input);
        if (c.displayText === null) { assert.equal(proof, null, c.input); continue; }
        assert.equal(proof.displayText, c.displayText, c.input);
        assert.equal(proof.sourceText, c.input);
        assert.equal(proof.sourceTextSha256, sha(c.input));
        assert.equal(proof.contract, 'source-cell-math-display-v1');
        if (c.proofKind) assert.equal(proof.kind, c.proofKind);
        if (c.kind === 'real-sealed-source') {
            const source = sources.find(s => s.paperId === c.paperId);
            assert.equal(source.runtimeSha256, c.runtimeSha256);
            const cell = source.tables.find(t => t.ordinal === c.tableOrdinal).cells
                .find(cell => cell.row === c.row && cell.column === c.column);
            assert.equal(cell.text, c.input); assert.equal(cell.sourceDomSha256, c.sourceDomSha256);
        }
    }
});

test('真实 MIDI 完整表按原 DOM 显示全部 15/42/27 格，旧原字绑定兼容且不修改来源', () => {
    const artifacts = { tables: structuredClone(sources.find(s => s.paperId === '2610.20967').tables) };
    const frozen = JSON.stringify(artifacts);
    for (const [i, table] of artifacts.tables.entries()) {
        assert.equal(tables.assessReaderCompleteTableEligibility(table).eligible, true);
        const out = tables.renderReaderCompleteTable({ tableIndex: i + 1,
            completeTable: { sourceTableOrdinal: table.ordinal } }, artifacts);
        assert.equal(out.binding.cellBindings.length, [15, 42, 27][i]);
        assert.equal(out.markdown.split('\n').length, table.matrix.length + 1);
        for (const cell of table.cells) {
            const projected = strictSourceCellMathDisplay(cell.text)?.displayText ?? cell.text;
            assert.equal(display.displayCell(table, cell.row, cell.column), projected);
            assert.equal(display.displayCellMatches(table, cell.row, cell.column, projected), true);
            assert.equal(display.displayCellMatches(table, cell.row, cell.column, cell.text), true);
            assert.equal(display.displayCellMatches(table, cell.row, cell.column, projected + '99'), false);
        }
    }
    assert.equal(JSON.stringify(artifacts), frozen);
});

test('新显示必须绑定唯一同坐标 DOM 单元格和真实 matrix；不能借邻格或残缺身份', () => {
    const original = sources[0].tables[0];
    const expected = strictSourceCellMathDisplay(original.matrix[1][1]).displayText;
    for (const mutate of [t => { t.cells.push(structuredClone(t.cells.find(c => c.row === 1 && c.column === 1))); },
        t => { t.cells.find(c => c.row === 1 && c.column === 1).sourceDomSha256 = ''; },
        t => { t.sourceDomSha256 = ''; }, t => { t.matrix[1][1] = '0.999'; }]) {
        const bad = structuredClone(original); mutate(bad);
        assert.equal(display.displayCellMatches(bad, 1, 1, expected), false);
    }
    assert.equal(display.displayCellMatches(original, 1, 2, expected), false);
});

function readerSample() {
    const base = require('./reader-signed-draft-fixture').fixture({ noFigures: true });
    const deep = require('../scripts/deep-analyzer');
    const artifacts = structuredClone(base.sourceDetails.structuredArtifacts);
    artifacts.tables = structuredClone(sources[0].tables.filter(t => [1, 3].includes(t.ordinal)));
    delete artifacts.payloadSha256;
    const bound = deep.bindStructuredArtifactsToText(artifacts, base.sourceDetails.text);
    for (const [i, kind] of ['result', 'ablation'].entries()) {
        const section = base.draft.sections.find(s => s.kind === kind);
        const topic = ['教师模型', '对齐层级'][i];
        const explanation = i === 0
            ? '教师比较说明不同表示来源会改变生成音乐的分布距离和文本一致性，两项指标分别观察输出质量的不同侧面，因此不能根据某一个结果替代所有任务条件下的结论。'
            : '对齐层级比较显示中间特征所在的深度也是实验变量，两个评价指标同时给出均值与不确定性，但这些测量只覆盖当前架构和数据，其他规模仍需要新的受控证据。';
        section.body += `\n\n针对${topic}的比较，这里完整保留同一来源的实验对象与所有数值，比较问题是不同设置下指标是否沿相同方向变化。\n\n[[TABLE_${i + 3}]]\n\n${explanation}`;
    }
    base.draft.tableBindings.push(...[1, 3].map((ordinal, i) => ({ tableIndex: i + 3,
        completeTable: { sourceTableOrdinal: ordinal } })));
    return { base, artifacts: bound, options: { requiredVersion: 3, requireIntegratedTables: true,
        minimumIntegratedTables: 2, requireSourceBindings: true,
        structuredArtifacts: bound, sourceText: base.sourceDetails.text } };
}

test('正常完整 Reader parser 保留真实原表全部行格、来源原文/DOM SHA，冷态资格仍通过', () => {
    const deep = require('../scripts/deep-analyzer');
    const { base, artifacts, options } = readerSample();
    const before = JSON.stringify({ artifacts, draft: base.draft });
    const result = deep.parseApiReaderArticleResult(JSON.stringify(base.draft), options);
    assert.deepEqual(result.plan.tableBindings.slice(2).map(b => b.cellBindings.length), [15, 27]);
    for (const binding of result.plan.tableBindings.slice(2)) for (const cell of binding.cellBindings) {
        const source = artifacts.tables.find(t => t.ordinal === binding.sourceTableOrdinal).cells
            .find(c => c.row === cell.sourceRow && c.column === cell.sourceColumn);
        assert.equal(cell.sourceText, source.text); assert.equal(cell.sourceDomSha256, source.sourceDomSha256);
        assert.equal(cell.renderedText, require('../scripts/lib/reader-source-display').normalizeReaderSourceDisplayArtifacts(
            strictSourceCellMathDisplay(source.text)?.displayText ?? source.text));
    }
    assert.equal(JSON.stringify({ artifacts, draft: base.draft }), before);
    const paper = base.paper, stage = paper.analysisManifest.stages.apiReaderArticle;
    paper.apiReaderArticle = result.article; paper.apiReaderPlan = result.plan;
    Object.assign(stage, { qualityMetrics: result.qualityMetrics, tableBindingCount: 4,
        structuredArtifactsSha256: artifacts.payloadSha256 });
    paper.freshRewriteProvenance.structuredArtifactsSha256 = artifacts.payloadSha256;
    paper.analysisManifest.freshRewriteProvenance.structuredArtifactsSha256 = artifacts.payloadSha256;
    paper.analysisManifest.sourceAcquisition.structuredArtifactsSha256 = artifacts.payloadSha256;
    require('./reader-signed-draft-fixture').sign(paper);
    assert.equal(require('../scripts/analysis-engine').hasValidApiReaderV3Records(structuredClone(paper)), true);
    const wrong = structuredClone(paper);
    wrong.apiReaderPlan.tableBindings[2].cellBindings.find(c => c.sourceRow === 1 && c.sourceColumn === 1).sourceText
        = String.raw`0.5117±0.0042¯\underline{0.5118\pm 0.0042}`;
    assert.throws(() => require('./reader-signed-draft-fixture').sign(wrong));
});
