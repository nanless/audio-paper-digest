'use strict';
// Resolve signed table edits in the same ordered inline/placeholder stream as
// the normal Reader compiler. A placeholder never becomes an invented raw table.
const { isDeepStrictEqual } = require('node:util');
const crypto = require('node:crypto');
const extract = text => require('../analysis-contract').extractMarkdownTables(text);
const fail = message => { throw new Error(`签名Reader表范围拒绝：${message}`); };
function readerTableSlots(draft) {
    const slots = [];
    for (let sectionIndex = 0; sectionIndex < (draft.sections || []).length; sectionIndex++) {
        const body = draft.sections[sectionIndex].body;
        if (typeof body !== 'string') fail('正文节点不是原文本');
        const offsets = [0];
        for (let i = 0; i < body.length; i++) if (body[i] === '\n') offsets.push(i + 1);
        const section = extract(body).map(table => ({ kind: 'inline', table,
            offset: offsets[table.startLine], sectionPath: `/sections/${sectionIndex}/body` }));
        for (const match of body.matchAll(/^\[\[TABLE_([1-9]\d*)\]\]$/gm)) {
            section.push({ kind: 'marker', marker: match[0], markerIndex: Number(match[1]),
                offset: match.index, sectionPath: `/sections/${sectionIndex}/body` });
        }
        section.sort((a, b) => a.offset - b.offset);
        slots.push(...section);
    }
    for (let i = 0; i < slots.length; i++) {
        slots[i].tableIndex = i + 1;
        if (slots[i].kind === 'marker' && slots[i].markerIndex !== i + 1) fail('原表占位符与实际完整表序不一致');
    }
    return slots;
}
function renderBinding(binding, artifacts) {
    const tables = require('./reader-tables');
    if (binding?.selection) return tables.renderReaderTableSelection(binding, artifacts);
    if (binding?.completeTable) return tables.renderReaderCompleteTable(binding, artifacts);
    return null;
}
function resolveSignedOriginalTable(original, record, proof, source) {
    const before = original.tableBindings?.[Number(proof.path.split('/').at(-1))];
    if (!before || !Number.isSafeInteger(before.tableIndex) || before.tableIndex < 1) fail('原绑定缺少真实表序');
    const slots = readerTableSlots(original), slot = slots[before.tableIndex - 1];
    if (!slot || slot.sectionPath !== proof.sectionPath) fail('绑定与原正文表位置不一致');
    if (original.tableBindings.filter(b => b.tableIndex === before.tableIndex).length !== 1) fail('原绑定表序不唯一');
    if (slot.kind === 'inline') return { before, slot, table: slot.table };
    const rendered = renderBinding(before, source?.structuredArtifacts);
    const parent = record.parentPaper, parentTables = extract(parent?.apiReaderArticle || '');
    const parentBinding = parent?.apiReaderPlan?.tableBindings?.[before.tableIndex - 1];
    const table = parentTables[before.tableIndex - 1];
    const oldSources = (source?.structuredArtifacts?.tables || []).filter(t => t.ordinal === rendered?.binding.sourceTableOrdinal);
    const coordinates = list => (list || []).map(cell => [cell.renderedRow, cell.renderedColumn, cell.sourceRow, cell.sourceColumn]);
    if (!rendered || !table || parentTables.length !== slots.length
        || parentBinding?.tableIndex !== before.tableIndex
        || parentBinding.sourceType !== 'artifact_table'
        || parentBinding.sourceTableOrdinal !== rendered.binding.sourceTableOrdinal
        || oldSources.length !== 1 || parentBinding.sourceTableDomSha256 !== oldSources[0].sourceDomSha256
        || parentBinding.renderedTableSha256 !== crypto.createHash('sha256').update(table.markdown).digest('hex')
        || rendered.markdown !== table.markdown
        || !isDeepStrictEqual(coordinates(parentBinding.cellBindings), coordinates(rendered.binding.cellBindings))) {
        fail('原占位符必须由真实原绑定逐格重放到完整已签父表');
    }
    // This branch repairs omitted rows of the same source table; changing the
    // source of a marker without editing a literal rejected table is forbidden.
    if (proof.sourceTableOrdinal !== rendered.binding.sourceTableOrdinal) fail('占位符修正不能借用另一张来源表');
    const claim = record._tableFeedback?.rejectedReaderClaims?.[proof.claimIndex];
    if (typeof claim !== 'string' || !claim.includes(table.markdown)
        || !parent.apiReaderArticle.includes(claim)) fail('须逐字拒绝当前已编译原表');
    return { before, slot, table };
}
function signedTableReplacementMatches(binding, tableIndex, sourceTableOrdinal) {
    if (!binding || binding.tableIndex !== tableIndex) return false;
    if (binding.sourceType === 'artifact_table') return binding.sourceTableOrdinal === sourceTableOrdinal;
    if (binding.selection) return binding.selection.sourceTableOrdinal === sourceTableOrdinal;
    return Object.keys(binding).sort().join(',') === 'completeTable,tableIndex'
        && binding.completeTable && Object.keys(binding.completeTable).join(',') === 'sourceTableOrdinal'
        && binding.completeTable.sourceTableOrdinal === sourceTableOrdinal;
}
function renderSignedTableTarget(record, proof, source) {
    const binding = record.patch.replacements.find(r => r.path === proof.path)?.value;
    const rendered = renderBinding(binding, source.structuredArtifacts);
    if (rendered) return { tableIndex: binding.tableIndex, markdown: rendered.markdown, binding: rendered.binding };
    const slot = readerTableSlots(record.draft)[binding.tableIndex - 1];
    const sources = source.structuredArtifacts.tables.filter(t => t.ordinal === proof.sourceTableOrdinal
        && t.sourceDomSha256 === proof.sourceDomSha256);
    if (!slot || slot.kind !== 'inline' || sources.length !== 1
        || Object.keys(binding).sort().join(',') !== 'cellBindings,sourceQuotes,sourceTableOrdinal,sourceType,tableIndex'
        || binding.sourceType !== 'artifact_table' || !isDeepStrictEqual(binding.sourceQuotes, [])
        || !Array.isArray(binding.cellBindings)) fail('获准新表须为单一完整DOM的显式单元格绑定');
    const sourceTable = sources[0], matrix = [slot.table.header, ...slot.table.rows];
    const display = require('./reader-table-pdf-evidence').displayCell;
    const normalize = require('./reader-source-display').normalizeReaderSourceDisplayArtifacts;
    const rowMap = new Map(), columnMap = new Map(), seen = new Set();
    if (matrix.some(row => row.length !== matrix[0].length)
        || binding.cellBindings.length !== matrix.length * matrix[0].length) fail('新表必须逐格完整绑定');
    const renderedMatrix = matrix.map(row => row.map(() => null));
    for (const cell of binding.cellBindings) {
        if (Object.keys(cell).sort().join(',') !== 'renderedColumn,renderedRow,sourceColumn,sourceRow'
            || !Object.values(cell).every(v => Number.isSafeInteger(v) && v >= 0)
            || cell.renderedRow >= matrix.length || cell.renderedColumn >= matrix[0].length
            || typeof sourceTable.matrix?.[cell.sourceRow]?.[cell.sourceColumn] !== 'string') fail('单元格坐标或声明字段非法');
        const key = `${cell.renderedRow}:${cell.renderedColumn}`;
        if (seen.has(key)) fail('单元格重复绑定');
        seen.add(key);
        const sourceCells = sourceTable.cells.filter(s => s.row <= cell.sourceRow
            && s.row + s.rowspan > cell.sourceRow && s.column <= cell.sourceColumn
            && s.column + s.colspan > cell.sourceColumn);
        if (sourceCells.length !== 1 || !/^[a-f0-9]{64}$/.test(sourceCells[0].sourceDomSha256 || '')
            || sourceCells[0].text !== sourceTable.matrix[cell.sourceRow][cell.sourceColumn]) fail('原DOM单元格或跨格身份不唯一');
        if ((rowMap.has(cell.renderedRow) && rowMap.get(cell.renderedRow) !== cell.sourceRow)
            || (columnMap.has(cell.renderedColumn) && columnMap.get(cell.renderedColumn) !== cell.sourceColumn)) fail('不得把不同原行或原列拼成一个新行列');
        rowMap.set(cell.renderedRow, cell.sourceRow); columnMap.set(cell.renderedColumn, cell.sourceColumn);
        const text = normalize(display(sourceTable, cell.sourceRow, cell.sourceColumn));
        if (matrix[cell.renderedRow][cell.renderedColumn] !== text) fail('新单元格显示与正常来源显示不同');
        renderedMatrix[cell.renderedRow][cell.renderedColumn] = text;
    }
    for (const map of [rowMap, columnMap]) {
        const values = [...map.entries()].sort((a, b) => a[0] - b[0]).map(pair => pair[1]);
        if (values.some((v, i) => i && v <= values[i - 1])) fail('只能按原顺序选取同一DOM的行列');
    }
    const line = cells => `| ${cells.join(' | ')} |`;
    const markdown = [line(renderedMatrix[0]), line(renderedMatrix[0].map(() => '---')), ...renderedMatrix.slice(1).map(line)].join('\n');
    // The paid raw draft may retain a compact separator (|---|), while the
    // normal producer rebuilds it as | --- |. Replay that same producer only
    // after every original DOM cell and row/column mapping matched exactly.
    if (markdown !== require('../deep-analyzer').normalizeApiReaderTablePasteArtifacts(slot.table.markdown)) {
        fail('获准新表字节不同于逐格正常来源投影');
    }
    return { tableIndex: binding.tableIndex, markdown, binding };
}
module.exports = { readerTableSlots, resolveSignedOriginalTable, signedTableReplacementMatches, renderSignedTableTarget };
