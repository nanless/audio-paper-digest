'use strict';
// 2026-11-09 日更的真实失败：selection 编译出来的 artifact 表单元格里带原文的
// LaTeX 注解（例如 FDPANNs\mathrm{\textbf{FD}_{...}}↓）。逐格校验要求渲染值等于
// 原 cell，但粘贴残留清理又把这些注解当模型残留删掉，于是合法的原表永远绑不上。
// 这些测试锁定：原表逐格绑定的格子不被清理；模型手写格子仍照旧拒绝；数值、单位
// 或四舍五入只要有一样不同，逐格校验仍然失败。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
    bindApiReaderSourceEvidence,
    normalizeApiReaderTablePasteArtifacts,
    validateApiReaderTablePasteDuplication
} = require('../scripts/deep-analyzer.js');
const {
    renderReaderTableSelection,
    findReaderTablePasteDuplication
} = require('../scripts/lib/reader-tables.js');

// 这里刻意用与原可见列头不是同一值的注解：同值双写现在由选择/完整表共用的
// 显示投影折叠（见 reader-source-display 的 projectReaderCellTexDisplay），
// 本测试继续锁定“合格原表里的不同值注解原样绑定、不被粘贴残留清理改写”。
const LATEX_HEADER = String.raw`FD\mathrm{FD_{norm}}`;
const SOURCE_TEXT = 'Synthetic source text for the Reader artifact table binding test.';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sortKeys = value => Array.isArray(value)
    ? value.map(sortKeys)
    : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]))
        : value;

function syntheticArtifacts(headerCell = 'FD↓') {
    const domSha = 'c'.repeat(64);
    const matrix = [
        ['Method', headerCell, 'KL↓'],
        ['A', '1.0', '2.0'],
        ['B', '3.0', '4.0']
    ];
    const cells = matrix.flatMap((row, rowIndex) => row.map((text, column) => ({
        row: rowIndex, column, header: rowIndex === 0, rowspan: 1, colspan: 1,
        text, sourceDomSha256: domSha
    })));
    const table = {
        ordinal: 1, label: 'TABLE_1', caption: 'Results', sourceDomSha256: domSha,
        headerRows: [0], bodyRows: [1, 2], cells, matrix, recoveryStatus: 'complete'
    };
    const body = {
        version: 1,
        parserVersion: 'arxiv-html-dom-v4',
        sourceKind: 'arxiv_html',
        sourceId: '2609.00001v1',
        paperId: '2609.00001v1',
        sourceHtmlSha256: 'd'.repeat(64),
        tables: [table],
        formulas: [],
        figures: [],
        references: [],
        health: {
            status: 'complete',
            detected: { tables: 1, formulas: 0, figures: 0, references: 0, bibliographies: 0 },
            recovered: { tables: 1, formulas: 0, figures: 0, references: 0 },
            truncated: false,
            issues: []
        },
        flattenedTextSha256: sha(SOURCE_TEXT)
    };
    return { ...body, payloadSha256: sha(JSON.stringify(sortKeys(body))) };
}

function compiledTable(artifacts) {
    const rendered = renderReaderTableSelection({
        tableIndex: 1,
        selection: { sourceTableOrdinal: 1, sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2] }
    }, artifacts);
    const binding = rendered.binding.cellBindings.find(item => (
        item.sourceRow === 2 && item.sourceColumn === 1
    ));
    return { rendered, binding };
}

function replaceRenderedCell(markdown, renderedRow, renderedColumn, value) {
    const lines = markdown.split('\n');
    const cells = lines[renderedRow].split('|');
    cells[renderedColumn + 1] = ` ${value} `;
    lines[renderedRow] = cells.join('|');
    return lines.join('\n');
}

function bind(article, binding, artifacts) {
    return bindApiReaderSourceEvidence(article, [binding], [], {
        structuredArtifacts: artifacts, sourceText: SOURCE_TEXT
    });
}

test('原表表头单元格里的 LaTeX 注解按原样绑定，不被粘贴残留清理改写', () => {
    const artifacts = syntheticArtifacts(LATEX_HEADER);
    const { rendered } = compiledTable(artifacts);
    const article = `### 结果如何比较？\n\n${rendered.markdown}`;

    assert.equal(normalizeApiReaderTablePasteArtifacts(article, [rendered.binding]), article);
    // 没有绑定时同一张表会被当成模型残留清理，说明下面的通过不是靠放宽规则。
    assert.notEqual(normalizeApiReaderTablePasteArtifacts(article), article);
    assert.doesNotThrow(() => validateApiReaderTablePasteDuplication(
        article, { tableBindings: [rendered.binding] }
    ));
    assert.throws(() => validateApiReaderTablePasteDuplication(article, {}), /粘连复写/);
    const bound = bind(article, rendered.binding, artifacts);
    const boundCell = bound.tableBindings[0].cellBindings.find(item => (
        item.sourceRow === 0 && item.sourceColumn === 1
    ));
    assert.equal(boundCell.renderedText, LATEX_HEADER);
    assert.equal(boundCell.sourceText, LATEX_HEADER);
});

test('模型手写的 LaTeX 残留仍按粘贴残留拒绝', () => {
    assert.match(findReaderTablePasteDuplication(LATEX_HEADER), /残留 LaTeX 命令/);
    assert.equal(findReaderTablePasteDuplication(LATEX_HEADER, { verifiedSourceCell: true }), null);
});

test('不同数值、不同单位或四舍五入后的渲染值仍被逐格校验拒绝', () => {
    const artifacts = syntheticArtifacts();
    const { rendered, binding } = compiledTable(artifacts);
    const cases = ['1.1', '1.0 ms', '2'];
    for (const wrong of cases) {
        const article = `### 结果如何比较？\n\n${replaceRenderedCell(
            rendered.markdown, binding.renderedRow, binding.renderedColumn, wrong
        )}`;
        assert.throws(() => bind(article, rendered.binding, artifacts),
            /渲染单元格与原始 cell 不一致/, wrong);
    }
});
