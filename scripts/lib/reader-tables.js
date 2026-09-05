'use strict';

const READER_TABLE_SELECTION_CONTRACT = 'reader-table-selection-v2';
const READER_TABLE_ELIGIBILITY_CONTRACT = 'reader-table-eligibility-v1';
const sha256 = value => /^[a-f0-9]{64}$/.test(String(value || ''));
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');

// Shared with the final Reader paste gate: selection must not promise exact
// source-cell replay when later display cleanup would change those bytes.
function findReaderTablePasteDuplication(cell) {
    const text = String(cell || '');
    const compact = text.replace(/\s+/g, '');
    if (text.includes('±') && text.includes('\\pm')) return '同一单元格同时出现 ± 与 \\pm';
    if (text.includes('×') && text.includes('\\times')) return '同一单元格同时出现 × 与 \\times';
    if (text.includes('%') && text.includes('\\%')) return '同一单元格同时出现 % 与 \\%';
    if (/\\bf\b|\\text\{|\\mathrm|SIUnitSymbolMicro/.test(text)) {
        return '单元格残留 LaTeX 命令（\\bf/\\text/\\mathrm 等），应改写成纯文本';
    }
    if (text.includes('{=}')) return '单元格残留 TeX 关系符写法 {=}，应改写成 =';
    const doubled = compact.match(/(.{3,})\1/);
    if (doubled && /[\d\\=]/.test(doubled[1])) {
        return `单元格存在原文粘连复写“${doubled[0].slice(0, 40)}”，只保留其中一份`;
    }
    if (/([A-Za-z]+)(\d*)\1_\{[^}]*\}/.test(compact)) {
        return '单元格存在纯文本与 TeX 下标双写（如 S1S_{1}），只保留其中一份干净写法';
    }
    return null;
}

function unsafeMarkdownCell(text) {
    return /[|\r\n]/.test(text) || /\[\[|<\/?[A-Za-z!]|!?\[[^\]]*\]\(/.test(text)
        || /^\s*:?-{3,}:?\s*$/.test(text);
}

function assessReaderTableSelectionEligibility(table) {
    const reasons = [];
    const add = (code, detail = {}) => reasons.push({ code, ...detail });
    const matrix = table?.matrix;
    const width = matrix?.[0]?.length;
    if (table?.recoveryStatus !== 'complete' || !sha256(table?.sourceDomSha256)) add('source_identity_unavailable');
    if (!Array.isArray(matrix) || !matrix.length || !Number.isInteger(width) || width < 1
        || matrix.some(row => !Array.isArray(row) || row.length !== width
            || Array.from(row).some(cell => typeof cell !== 'string'))) {
        add('invalid_source_matrix');
    } else {
        if (width < 2 || matrix.length < 2) add('insufficient_dimensions');
        const headers = table.headerRows;
        if (!Array.isArray(headers) || headers.length === 0 || new Set(headers).size !== headers.length
            || headers.some(row => !Number.isInteger(row) || row < 0 || row >= matrix.length)) {
            add('header_identity_unavailable');
        } else {
            if (!matrix.some((_row, index) => !headers.includes(index))) add('no_explicit_data_rows');
            for (const row of headers) {
                for (const [column, text] of matrix[row].entries()) {
                    if (!text.trim()) add('empty_source_header', { row, column });
                }
            }
        }
        for (const [row, cells] of matrix.entries()) {
            for (const [column, text] of cells.entries()) {
                if (findReaderTablePasteDuplication(text)) add('source_display_cleanup_required', { row, column });
                if (/\\[A-Za-z]+/.test(text)) add('unresolved_source_tex', { row, column });
                if (unsafeMarkdownCell(text)) add('unsafe_markdown_cell', { row, column });
            }
        }
    }
    return { contract: READER_TABLE_ELIGIBILITY_CONTRACT, eligible: reasons.length === 0,
        reasonCodes: [...new Set(reasons.map(reason => reason.code))],
        reasonCount: reasons.length, examples: reasons.slice(0, 8),
        ...(!reasons.length ? {} : { action: 'Do not use selection. Use source_quotes only with exact full-text quotes and the existing numeric/unit gate; do not invent header names or normalize source evidence.' }) };
}

function renderReaderTableSelection(binding, artifacts) {
    const label = `读者文章 tableBindings[${Number(binding?.tableIndex) - 1}] selection`;
    if (!exactKeys(binding, ['tableIndex', 'selection']) || !Number.isInteger(binding.tableIndex) || binding.tableIndex < 1
        || !exactKeys(binding.selection, ['sourceTableOrdinal', 'sourceRows', 'sourceColumns'])) {
        throw new Error(`${label} 字段非法或混合手写数据`);
    }
    const { sourceTableOrdinal, sourceRows, sourceColumns } = binding.selection;
    const tables = (artifacts?.tables || []).filter(table => table?.ordinal === sourceTableOrdinal);
    const table = tables[0];
    if (!Number.isInteger(sourceTableOrdinal) || tables.length !== 1 || table.recoveryStatus !== 'complete'
        || !sha256(table.sourceDomSha256) || !Array.isArray(table.matrix) || !table.matrix.length) {
        throw new Error(`${label} 原表身份或恢复状态非法`);
    }
    const width = table.matrix[0]?.length;
    if (!Number.isInteger(width) || width < 1 || table.matrix.some(row => !Array.isArray(row)
        || row.length !== width || Array.from(row).some(cell => typeof cell !== 'string'))) {
        throw new Error(`${label} 原表不是完整矩形字符串矩阵`);
    }
    const eligibility = assessReaderTableSelectionEligibility(table);
    if (!eligibility.eligible) {
        throw new Error(`${label} selection eligible=false: ${eligibility.reasonCodes.join(', ')}。`
            + '原表不能逐字安全渲染为 Markdown；仅可使用有完整逐字证据的 source_quotes 路线，不得编造表头或改写来源。');
    }
    for (const [values, limit, minimum] of [[sourceRows, table.matrix.length, 2], [sourceColumns, width, 2]]) {
        if (!Array.isArray(values) || values.length < minimum || new Set(values).size !== values.length
            || values.some(index => !Number.isInteger(index) || index < 0 || index >= limit)) {
            throw new Error(`${label} 行列重复、越界或数量不足`);
        }
    }
    if (!Array.isArray(table.headerRows) || !table.headerRows.includes(sourceRows[0])
        || sourceRows.slice(1).some(row => table.headerRows.includes(row))) {
        throw new Error(`${label} 第一行必须是原表头，其余行必须是数据行`);
    }
    const cellBindings = [];
    const matrix = sourceRows.map((sourceRow, renderedRow) => sourceColumns.map((sourceColumn, renderedColumn) => {
        const cells = (table.cells || []).filter(cell => Number.isInteger(cell.row) && Number.isInteger(cell.column)
            && sourceRow >= cell.row && sourceRow < cell.row + Number(cell.rowspan || 1)
            && sourceColumn >= cell.column && sourceColumn < cell.column + Number(cell.colspan || 1));
        const cell = cells[0];
        const text = table.matrix[sourceRow][sourceColumn];
        if (cells.length !== 1 || !sha256(cell?.sourceDomSha256) || cell.text !== text
            || (renderedRow === 0 && cell.header !== true)) {
            throw new Error(`${label} row=${sourceRow},column=${sourceColumn} 不能唯一重放到原始 DOM cell`);
        }
        // Escaping or rewriting arbitrary source markup changes the cell's
        // identity. Such a table stays on the existing explicitly bound path.
        if (unsafeMarkdownCell(text)) {
            throw new Error(`${label} row=${sourceRow},column=${sourceColumn} 含不能逐字安全渲染的 Markdown`);
        }
        cellBindings.push({ renderedRow, renderedColumn, sourceRow, sourceColumn });
        return text;
    }));
    const row = cells => `| ${cells.join(' | ')} |`;
    return {
        markdown: [row(matrix[0]), row(matrix[0].map(() => '---')), ...matrix.slice(1).map(row)].join('\n'),
        binding: { tableIndex: binding.tableIndex, sourceType: 'artifact_table', sourceTableOrdinal,
            cellBindings, sourceQuotes: [] }
    };
}

function compileReaderTableSelections(sections, bindings, artifacts) {
    if (!Array.isArray(sections) || !Array.isArray(bindings)) {
        if (Array.isArray(sections) && sections.some(section => /\[\[TABLE_[^\]]*\]\]/.test(String(section?.body || '')))) {
            throw new Error('读者文章存在未绑定的 TABLE marker');
        }
        return { sections, tableBindings: bindings, selectionTableIndexes: [] };
    }
    const copiedSections = sections.map(section => ({ ...section }));
    const selectionTableIndexes = [];
    const tableBindings = bindings.map((binding, index) => {
        if (!binding || !Object.prototype.hasOwnProperty.call(binding, 'selection')) return binding;
        if (binding.tableIndex !== index + 1) throw new Error(`读者文章 tableBindings[${index}] selection tableIndex 必须按正文顺序递增`);
        const marker = `[[TABLE_${binding.tableIndex}]]`;
        const matchingSections = copiedSections.filter(section => typeof section.body === 'string' && section.body.includes(marker));
        if (matchingSections.length !== 1 || matchingSections[0].body.split(marker).length !== 2
            || !matchingSections[0].body.split(/\n\s*\n/).some(block => block.trim() === marker)) {
            throw new Error(`读者文章 tableBindings[${index}] ${marker} 必须在一个小节中唯一独占一段`);
        }
        const joinedBody = copiedSections.map(section => section.body || '').join('\n\n');
        const prefix = joinedBody.slice(0, joinedBody.indexOf(marker));
        const priorTables = require('../analysis-contract.js').extractMarkdownTables(prefix).length
            + [...prefix.matchAll(/\[\[TABLE_\d+\]\]/g)].length;
        if (priorTables + 1 !== binding.tableIndex) {
            throw new Error(`读者文章 tableBindings[${index}] ${marker} 与实际正文表格顺序不一致`);
        }
        const rendered = renderReaderTableSelection(binding, artifacts);
        matchingSections[0].body = matchingSections[0].body.replace(marker, rendered.markdown);
        selectionTableIndexes.push(binding.tableIndex);
        return rendered.binding;
    });
    if (copiedSections.some(section => /\[\[TABLE_[^\]]*\]\]/.test(String(section.body || '')))) {
        throw new Error('读者文章存在未绑定的 TABLE marker');
    }
    return { sections: copiedSections, tableBindings, selectionTableIndexes };
}

module.exports = { READER_TABLE_SELECTION_CONTRACT, READER_TABLE_ELIGIBILITY_CONTRACT,
    findReaderTablePasteDuplication, assessReaderTableSelectionEligibility,
    renderReaderTableSelection, compileReaderTableSelections };
