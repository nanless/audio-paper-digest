'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReaderDraftOrder } = require('../scripts/lib/reader-draft-order');
const { compileReaderTableSelections } = require('../scripts/lib/reader-tables');
function createTableSample() {
    const matrix = [['Model', 'WER (%)', 'Time (ms)'], ['Base', '12%', '1 ms'], ['Ours', '10%', '2 ms']];
    const table = { ordinal: 1, recoveryStatus: 'complete', sourceDomSha256: 'a'.repeat(64), matrix,
        headerRows: [0], bodyRows: [1, 2], cells: matrix.flatMap((row, r) => row.map((text, c) => ({
            row: r, column: c, text, header: r === 0, rowspan: 1, colspan: 1, sourceDomSha256: 'b'.repeat(64)
        }))) };
    const markdown = '| Model | WER (%) | Time (ms) |\n| --- | --- | --- |\n| Base | 12% | 1 ms |\n| Ours | 10% | 2 ms |';
    return { draft: { sections: [
        { kind: 'result', heading: '比较', body: `表前问题。\n\n${markdown}\n\n表后解释。` },
        { kind: 'background', heading: '背景', body: '保持背景。' }
    ], tableBindings: [{ tableIndex: 1, selection: { sourceTableOrdinal: 1,
        sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2] } }] }, structuredArtifacts: { tables: [table] }, markdown };
}
const normalize = sample => normalizeReaderDraftOrder(sample.draft, sample);
test('唯一逐格原DOM匹配的现成表回到selection 表格生成程序，保留正文上下文和全部值单位', () => {
    const sample = createTableSample(), frozen = JSON.stringify(sample);
    const result = normalize(sample).draft;
    assert.equal(result.sections[1].body, '表前问题。\n\n[[TABLE_1]]\n\n表后解释。');
    const compiled = compileReaderTableSelections(result.sections, result.tableBindings, sample.structuredArtifacts);
    assert.equal(compiled.sections[1].body, sample.draft.sections[0].body);
    assert.equal(JSON.stringify(sample), frozen);
});
for (const [name, alter] of Object.entries({
    '错一格': s => { s.draft.sections[0].body = s.draft.sections[0].body.replace('12%', '13%'); },
    '错单位': s => { s.draft.sections[0].body = s.draft.sections[0].body.replace('1 ms', '1 s'); },
    '错表头': s => { s.draft.sections[0].body = s.draft.sections[0].body.replace('WER (%)', 'CER (%)'); },
    '数据乱序': s => { s.draft.sections[0].body = s.draft.sections[0].body.replace('| Base | 12% | 1 ms |\n| Ours | 10% | 2 ms |', '| Ours | 10% | 2 ms |\n| Base | 12% | 1 ms |'); },
    '重复表': s => { s.draft.sections[0].body += '\n\n' + s.markdown; },
    '多声明争用': s => { s.draft.tableBindings.push({ ...structuredClone(s.draft.tableBindings[0]), tableIndex: 2 }); },
    '缺原DOM': s => { s.structuredArtifacts.tables[0].cells.pop(); },
    '重原DOM': s => { s.structuredArtifacts.tables[0].cells.push({ ...s.structuredArtifacts.tables[0].cells[0] }); },
    '坏原SHA': s => { s.structuredArtifacts.tables[0].cells[0].sourceDomSha256 = ''; },
    '原表重复身份': s => { s.structuredArtifacts.tables.push(structuredClone(s.structuredArtifacts.tables[0])); },
    '越界选择': s => { s.draft.tableBindings[0].selection.sourceRows.push(3); },
    '字段越权': s => { s.draft.tableBindings[0].sourceQuotes = []; },
    '隐于代码': s => { s.draft.sections[0].body = '```\n' + s.markdown + '\n```'; },
    '隐于引用': s => { s.draft.sections[0].body = s.markdown.split('\n').map(line => '> ' + line).join('\n'); }
})) test(`现成选区恢复拒绝${name}`, () => { const sample = createTableSample(); alter(sample); assert.throws(() => normalize(sample)); });
