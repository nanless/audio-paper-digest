'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { restoreReaderSelectedTableBytes } = require('../scripts/deep-analyzer');
const { buildRepairTargets, collectDraftIssues } = require('../scripts/lib/reader-repair');
const { extractMarkdownTables } = require('../scripts/analysis-contract');

// 2611.07210 的真实形态：模型在结果表前新增了一张数据集表，但没有重编号，
// artifact_table 的 tableIndex=1 指向了 3 列的配置表，而原表是 5 列。
function sourceTable() {
    const matrix = [
        ['', 'Peak Signal-to-Noise Ratio ↑', 'Peak Signal-to-Noise Ratio ↑', 'Peak Signal-to-Noise Ratio ↑', 'Peak Signal-to-Noise Ratio ↑'],
        ['Regression Config', 'RAVE', 'M2L', 'SAO', 'FlowDec'],
        ['No Fourier features', '27.516', '29.774', '21.697', '23.530'],
        ['Fourier features', '41.369', '40.368', '32.069', '32.566']
    ];
    const cells = matrix.flatMap((row, rowIndex) => row.map((text, column) => ({
        row: rowIndex, column, rowspan: 1, colspan: 1,
        header: rowIndex < 2, text, sourceDomSha256: 'a'.repeat(64)
    })));
    return { ordinal: 2, recoveryStatus: 'complete', matrix, headerRows: [0, 1],
        bodyRows: [2, 3], cells, sourceDomSha256: 'b'.repeat(64) };
}
function bindingFor(table) {
    return { tableIndex: 1, sourceType: 'artifact_table', sourceTableOrdinal: 2,
        cellBindings: table.matrix.flatMap((row, sourceRow) => row.map((_text, sourceColumn) => ({
            renderedRow: sourceRow, renderedColumn: sourceColumn, sourceRow, sourceColumn
        }))), sourceQuotes: [] };
}
const datasetTable = '| 素材组 | 内容与来源 | 训练与测试切分 |\n| --- | --- | --- |\n'
    + '| 鼓组 | MUSDB18 非混合鼓轨 | 每段 5 秒单独训练 |\n'
    + '| 弦乐 | AAM 弓弦与吉他 | 同上 |\n'
    + '| 人声 | VCTK 朗读语音 | 同上 |';
const resultTable = [
    '|  | Peak Signal-to-Noise Ratio ↑ | Peak Signal-to-Noise Ratio ↑ | Peak Signal-to-Noise Ratio ↑ | Peak Signal-to-Noise Ratio ↑ |',
    '| --- | --- | --- | --- | --- |',
    '| Regression Config | RAVE | M2L | SAO | FlowDec |',
    '| No Fourier features | 27.516 | 29.774 | 21.697 | 23.530 |',
    '| Fourier features | 41.369 | 40.368 | 32.069 | 32.566 |'
].join('\n');
const restore = (article, binding, table = sourceTable()) => restoreReaderSelectedTableBytes(
    article, [binding], { tables: [table] });
const thrown = fn => {
    try { fn(); } catch (error) { return error; }
    throw new Error('预期抛出错误，但没有抛出');
};

test('tableIndex 指向错误的正文表时点名绑定、两张表的尺寸和正确表号', () => {
    const table = sourceTable();
    const error = thrown(() => restore(`${datasetTable}\n\n${resultTable}`, bindingFor(table)));
    const message = String(error.message);
    assert.match(message, /读者文章表格绑定表号错位（cell 坐标无法重放）/);
    assert.match(message, /tableBindings\[0\]（sourceTableOrdinal=2）/);
    assert.match(message, /4行×5列 的原表/);
    assert.match(message, /正文第1张 Markdown 表是 4行×3列（表头：素材组 \/ 内容与来源 \/ 训练与测试切分）/);
    assert.match(message, /正文第2张表是 4行×5列，与原表尺寸一致/);
    assert.match(message, /请把 tableBindings\[0\]\.tableIndex 改为 2/);
    assert.match(message, /正文当前有 2 张 Markdown 表但只有 1 条 tableBindings/);
    assert.match(message, /每张正文表都要有来源记录/);
    assert.match(message, /保留原比较条件、数字、单位与结果/);
});

test('tableIndex 正确且逐格一致时仍按原DOM字节重放', () => {
    const table = sourceTable();
    const article = `前面一段说明。\n\n${resultTable}\n\n后面一段解释。`;
    const restored = restore(article, bindingFor(table));
    assert.equal(restored, article);
    assert.equal(extractMarkdownTables(restored)[0].markdown, resultTable);
});

test('同尺寸但正文表被改写时按原DOM字节恢复，不保留模型改写的数字', () => {
    const table = sourceTable();
    const altered = resultTable.replace('27.516', '99.999');
    const restored = restore(altered, bindingFor(table));
    assert.doesNotMatch(restored, /99\.999/);
    assert.match(restored, /27\.516/);
    assert.equal(extractMarkdownTables(restored)[0].markdown, resultTable);
});

test('重复的 rendered 坐标点名具体 cellBindings 项而不是笼统报错', () => {
    const table = sourceTable();
    const binding = bindingFor(table);
    binding.cellBindings[3] = { ...binding.cellBindings[2] };
    const error = thrown(() => restore(resultTable, binding));
    assert.match(String(error.message), /tableBindings\[0\]\.cellBindings\[3\]/);
    assert.match(String(error.message), /renderedRow=0、renderedColumn=2 与前面的坐标重复/);
});

test('越界的原表坐标点名 sourceRow/sourceColumn', () => {
    const table = sourceTable();
    const binding = bindingFor(table);
    binding.cellBindings[5] = { renderedRow: 1, renderedColumn: 1, sourceRow: 99, sourceColumn: 1 };
    const error = thrown(() => restore(resultTable, binding));
    assert.match(String(error.message), /tableBindings\[0\]\.cellBindings\[5\]/);
    assert.match(String(error.message), /sourceRow=99、sourceColumn=1 不在原表 DOM 单元格内/);
});

test('漏绑一格时点名缺的正文行列与表尺寸', () => {
    const table = sourceTable();
    const binding = bindingFor(table);
    binding.cellBindings.pop();
    const error = thrown(() => restore(resultTable, binding));
    assert.match(String(error.message), /cellBindings 不完整/);
    assert.match(String(error.message), /renderedRow=3、renderedColumn=4/);
    assert.match(String(error.message), /4行×5列/);
});

test('表号错位的修复授权整组 tableBindings 与全部正文表，而不是只改报错的那一条', () => {
    const table = sourceTable();
    const draft = {
        sections: [
            { kind: 'experiment_setup', heading: '数据协议怎样限定实验结论？', body: `${datasetTable}\n\n三类素材分别覆盖鼓、弦乐与人声。` },
            { kind: 'result', heading: '结果表说明映射精度提升多少？', body: `${resultTable}\n\n该比较显示傅里叶特征明显提高峰值信噪比。` }
        ],
        tableBindings: [bindingFor(table)],
        conceptBridges: [], figurePlacements: [], formulaBindings: []
    };
    const error = thrown(() => restore(`${datasetTable}\n\n${resultTable}`, bindingFor(table)));
    const issues = collectDraftIssues(draft, error, {});
    assert.ok(issues.some(issue => issue.diagnosticOnly !== true
        && /tableBindings\[0\].*正文第1张 Markdown 表是 4行×3列/.test(String(issue.message))));
    const targets = buildRepairTargets(draft, issues, {});
    assert.equal(targets[0].path, '/tableBindings');
    assert.ok(targets.some(target => target.path === '/sections/0/body'));
    assert.ok(targets.some(target => target.path === '/sections/1/body'));
    assert.ok(targets.length <= 8);
});
