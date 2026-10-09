'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer.js');
const { fixture } = require('./reader-signed-draft-fixture.js');
const { extractMarkdownTables } = require('../scripts/analysis-contract.js');
const { collectDraftIssues } = require('../scripts/lib/reader-repair.js');
const { validateReaderResultTableCoverage } = require('../scripts/lib/reader-tables.js');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const metadataTable = [
    '| 数据集 | 年份 | 训练样本 | 测试样本 | 数据划分 | 说明 |',
    '|---|---|---|---|---|---|',
    '| A | 2024 | 1000 | 200 | 固定 | 仅数据统计 |',
    '| B | 2025 | 3000 | 400 | 固定 | 仅数据统计 |'
].join('\n');

function readerWithResultTable(markdown) {
    const original = fixture({ noFigures: true });
    const result = original.draft.sections.find(section => section.kind === 'result');
    const oldTable = extractMarkdownTables(result.body)[0].markdown;
    result.body = result.body.replace(oldTable, markdown);
    const sourceText = original.sourceDetails.text
        + ' Dataset A was released in 2024 and has 1000 training samples and 200 test samples.'
        + ' Dataset B was released in 2025 and has 3000 training samples and 400 test samples.'
        + ' Measured WER is 20% for A and 18% for B; CER is 10% for A and 9% for B.';
    original.draft.tableBindings[1].sourceQuotes = [sourceText];
    const matrix = [['Method', 'WER (%)', 'CER (%)'], ['A', '20', '10'], ['B', '18', '9']];
    const sourceTable = {
        ordinal: 1,
        caption: 'Main experimental results',
        recoveryStatus: 'complete',
        sourceDomSha256: sha('main result table'),
        headerRows: [0],
        matrix,
        cells: matrix.flatMap((row, rowIndex) => row.map((text, column) => ({
            row: rowIndex,
            column,
            rowspan: 1,
            colspan: 1,
            header: rowIndex === 0,
            text,
            sourceDomSha256: sha(`cell ${rowIndex}:${column}`)
        })))
    };
    const artifacts = deep.bindStructuredArtifactsToText({
        ...original.sourceDetails.structuredArtifacts,
        tables: [sourceTable]
    }, sourceText);
    return { draft: original.draft, artifacts, sourceText };
}

function parse({ draft, artifacts, sourceText }) {
    return deep.parseApiReaderArticleResult(JSON.stringify(draft), {
        requiredVersion: 3,
        requireIntegratedTables: true,
        minimumIntegratedTables: 2,
        availableFigureOrdinals: [],
        requireSourceBindings: true,
        structuredArtifacts: artifacts,
        sourceText
    });
}

test('真实 Reader 解析拒绝用逐字来源支持的数据统计表冒充主结果', () => {
    const input = readerWithResultTable(metadataTable);
    assert.throws(() => parse(input), /主结果表覆盖不足/);
    const issues = collectDraftIssues(input.draft, null, {
        sourceText: input.sourceText,
        structuredArtifacts: input.artifacts
    });
    assert.ok(issues.some(issue => issue.code === 'reader_result_table_missing'));
});

test('年份和样本数不能补足结果数量，交错列中的真实指标仍可通过完整解析', () => {
    const input = readerWithResultTable([
        '| Method | Year | WER (%) | Samples | CER (%) | 条件 |',
        '|---|---|---|---|---|---|',
        '| A | 2024 | 20% | 1000 | 10% | 固定 |',
        '| B | 2025 | 18% | 3000 | 9% | 固定 |'
    ].join('\n'));
    assert.doesNotThrow(() => parse(input));
    const insufficient = readerWithResultTable([
        '| Method | Year | WER (%) | Samples | 条件 | 说明 |',
        '|---|---|---|---|---|---|',
        '| A | 2024 | 20% | 1000 | 固定 | 同一协议 |',
        '| B | 2025 | 18% | 3000 | 固定 | 同一协议 |'
    ].join('\n'));
    assert.throws(() => parse(insufficient), /主结果表覆盖不足/);
});

test('转置的真实指标比较可用，训练配置行和一个单元格里的数字串不能充数', () => {
    const input = readerWithResultTable(metadataTable);
    for (const body of [
        '| Metric | Baseline | Proposed |\n|---|---|---|\n| WER | 20% | 18% |\n| CER | 10% | 9% |',
        '| Model | OVRL | SIG |\n|---|---|---|\n| A | 3.09 | 3.50 |\n| B | 3.14 | 3.48 |',
        '| Model | Latency | Ratio |\n|---|---|---|\n| A | 20ms | 1.2 ± 0.1 |\n| B | <18 ms | 9e-1 |',
        '| Model | OVRL | SIG |\n|---|---|---|\n| A | 1–2 | 2-3 |\n| B | 3—4 | 4.1–5.2 |'
    ]) {
        assert.equal(validateReaderResultTableCoverage([{ kind: 'result', body }], input.artifacts).numericResultTables, 1);
    }
    for (const body of [
        '| 配置 | A | B |\n|---|---|---|\n| 学习率 | 0.001 | 0.002 |\n| 批量大小 | 64 | 128 |',
        '| Model | Notes |\n|---|---|\n| A | 2024 2025 2026 2027 |',
        '| Metric | A |\n|---|---|\n| F1 | 0.8 |\n| F2 | 0.9 |',
        '| Metric | Baseline | Proposed |\n|---|---|---|\n| WER | model-v1 | model-v2 |\n| CER | model-v3 | model-v4 |',
        '| Method | Dataset size | Number of samples |\n|---|---|---|\n| A | 100 | 200 |\n| B | 300 | 400 |'
    ]) {
        assert.throws(() => validateReaderResultTableCoverage([{ kind: 'ablation', body }], input.artifacts), /主结果表覆盖不足/);
    }
});
