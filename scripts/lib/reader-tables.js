'use strict';

const READER_TABLE_SELECTION_CONTRACT = 'reader-table-selection-v2';
const READER_TABLE_ELIGIBILITY_CONTRACT = 'reader-table-eligibility-v1';
const READER_RESULT_COVERAGE_CONTRACT = 'reader-result-table-coverage-v1';
const sha256 = value => /^[a-f0-9]{64}$/.test(String(value || ''));
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');

// Shared with the final Reader paste gate: selection must not promise exact
// source-cell replay when later display cleanup would change those bytes.
function hasExplicitRepeatedScientificMeasurement(cell, context = {}, duplicate = null) {
    const text = String(cell || '');
    const scientific = '[+-]?\\d+(?:\\.\\d+)?[eE][+-]?\\d+';
    const list = new RegExp(`${scientific}(?:\\s*[、,，;；/]\\s*${scientific})+`, 'g');
    const repeated = [...text.matchAll(list)].some(match => {
        const values = match[0].match(new RegExp(scientific, 'g')) || [];
        const duplicateOverlaps = !duplicate || duplicate.index < match.index + match[0].length
            && match.index < duplicate.index + duplicate.length;
        return duplicateOverlaps
            && new Set(values.map(value => value.toLowerCase())).size < values.length;
    });
    if (!repeated) return false;
    const localLabels = /(?:^|[，,；;])\s*(?:s\s*\d+|stage\s*\d+|第?\s*\d+\s*阶段)\s*(?:学习率|lr)?/i.test(text);
    const rowContext = [context.header?.[context.columnIndex], ...(context.row || []).filter(value => value !== cell)]
        .map(value => String(value || '')).join(' ');
    // Repeated learning rates are meaningful when the row/column explicitly
    // says they belong to staged training. This exception is deliberately
    // limited to delimited scientific-notation lists; concatenated extraction
    // shadows such as 2.222.22 or 5e-55e-5 remain rejected.
    return localLabels || /(?:训练|阶段|stage|课程).*(?:学习率|learning rate|\blr\b)|(?:学习率|learning rate|\blr\b).*(?:训练|阶段|stage|课程)/i.test(rowContext);
}

function hasExplicitRepeatedDatasetSplitScale(cell, context = {}) {
    const compact = String(cell || '').replace(/\s+/g, '');
    const scalar = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?[kKmMgG]?';
    const unit = '(?:clips?|videos?|samples?|items?|examples?|utterances?|recordings?|files?|segments?|pairs?|cases?|条|个|段|样本|视频|片段|文件|对)';
    const list = new RegExp(`^(${scalar})[/、，;；](${scalar})[/、，;；](${scalar})(?:${unit})?$`, 'i');
    const match = list.exec(compact);
    if (!match || new Set(match.slice(1, 4).map(value => value.toLowerCase())).size === 3) {
        return false;
    }
    const rowContext = [context.header?.[context.columnIndex], ...(context.row || [])
        .filter(value => value !== cell)].map(value => String(value || '')).join(' ');
    const explicitThreeWaySplit = /(?:train(?:ing)?|训练)\s*[/、，;；]\s*(?:val(?:id(?:ation|ating)?)?|dev|验证)\s*[/、，;；]\s*(?:test(?:ing)?|测试)/i.test(rowContext);
    const explicitDatasetSplit = /(?:dataset|data|数据集?|语料)(?:\s*(?:set))?\s*(?:split|partition|划分|拆分)|(?:数据|语料)(?:集)?划分/i.test(rowContext);
    // Only a complete three-value list can use this exception. Concatenated
    // extraction shadows, a fourth repeated value, or a duplicated whole cell
    // cannot match the anchored surface even when the row mentions a split.
    return explicitThreeWaySplit || explicitDatasetSplit;
}

function findReaderTablePasteDuplication(cell, context = {}) {
    const text = String(cell || '');
    const compact = text.replace(/\s+/g, '');
    if (text.includes('±') && text.includes('\\pm')) return '同一单元格同时出现 ± 与 \\pm';
    if (text.includes('×') && text.includes('\\times')) return '同一单元格同时出现 × 与 \\times';
    if (text.includes('%') && text.includes('\\%')) return '同一单元格同时出现 % 与 \\%';
    if (/\\bf\b|\\text\{|\\mathrm|SIUnitSymbolMicro/.test(text)) {
        return '单元格残留 LaTeX 命令（\\bf/\\text/\\mathrm 等），应改写成纯文本';
    }
    if (text.includes('{=}')) return '单元格残留 TeX 关系符写法 {=}，应改写成 =';
    const doubledSpans = [...compact.matchAll(/(.{3,}?)\1/g)];
    for (const doubled of doubledSpans) {
        if (!/[\d\\=]/.test(doubled[1])) continue;
        if (hasExplicitRepeatedScientificMeasurement(compact, context,
            { index: doubled.index, length: doubled[0].length })) continue;
        if (hasExplicitRepeatedDatasetSplitScale(compact, context)) continue;
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

// A conservative source-only trigger, not a scientific classifier. Do not
// infer an experiment from an author table or a table of training settings.
function readerResultTableRequirement(artifacts) {
    const sourceTableOrdinals = (Array.isArray(artifacts?.tables) ? artifacts.tables : []).filter(table => {
        if (!Number.isInteger(table?.ordinal) || table.ordinal < 1
            || table.recoveryStatus !== 'complete' || !sha256(table.sourceDomSha256)) return false;
        const caption = String(table.caption || '');
        if (!/\b(?:results?|performance|comparisons?|benchmarks?)\b|实验结果|主结果|性能比较/i.test(caption)
            || /\b(?:authors?|affiliations?|hyperparameters?|configuration|settings|setup)\b|dataset statistics|data statistics|作者|机构|超参数|训练配置/i.test(caption)) return false;
        const rows = Array.isArray(table.matrix) ? table.matrix.filter(Array.isArray) : [];
        return rows.length >= 2 && rows.flat().filter(cell => typeof cell === 'string' && /\d/.test(cell)).length >= 4;
    }).map(table => table.ordinal);
    return { contract: READER_RESULT_COVERAGE_CONTRACT,
        minimumResultTables: sourceTableOrdinals.length ? 1 : 0, sourceTableOrdinals };
}

function effectiveReaderTableRows(table) {
    const declaredHeaders = Array.isArray(table?.headerRows) ? [...table.headerRows] : [];
    const declaredBodies = Array.isArray(table?.bodyRows) ? [...table.bodyRows] : [];
    const matrix = table?.matrix;
    const cells = table?.cells;
    const width = matrix?.[0]?.length;
    const unchanged = { headerRows: declaredHeaders, bodyRows: declaredBodies, inferred: false };
    if (!Array.isArray(matrix) || matrix.length < 4 || !Number.isInteger(width) || width < 3
        || matrix.some(row => !Array.isArray(row) || row.length !== width)
        || !Array.isArray(cells)) return unchanged;
    const dataRows = Array.from({ length: matrix.length - 2 }, (_, index) => index + 2);
    // Compatibility for the old parser's exact row-header contagion shape:
    // the top grouped header is explicit, its second tier is the sole declared
    // body row, and every later model/value row was marked header merely
    // because its first cell used <th>.  Require both DOM spans and an
    // unambiguous label-plus-numeric matrix before deriving effective roles.
    if (declaredBodies.length !== 1 || declaredBodies[0] !== 1
        || declaredHeaders.length !== dataRows.length + 1
        || !declaredHeaders.includes(0)
        || dataRows.some(row => !declaredHeaders.includes(row))) return unchanged;
    const topCells = cells.filter(cell => cell?.row === 0);
    const secondTierCells = cells.filter(cell => cell?.row === 1);
    const inherited = topCells.filter(cell => cell?.header === true && Number(cell.rowspan || 1) > 1);
    if (!topCells.length || !topCells.every(cell => cell?.header === true)
        || inherited.length !== 1 || Number(inherited[0].rowspan) !== 2
        || !topCells.some(cell => cell?.header === true && Number(cell.colspan || 1) > 1)
        || secondTierCells.length !== width - 1
        || secondTierCells.some(cell => cell?.header !== false || cell?.column < 1)
        || matrix[0][inherited[0].column] !== matrix[1][inherited[0].column]) return unchanged;
    const headerLabel = value => /^\d+(?:\s*[-–]\s*\d+)?$/.test(String(value || '').trim());
    const numericValue = value => /^[+\-\u2212]?\d+(?:\.\d+)?%?$/.test(String(value || '').trim());
    if (matrix[1].slice(1).some(value => !headerLabel(value))
        || dataRows.some(row => !/[A-Za-z\u3400-\u9fff]/.test(String(matrix[row][0] || ''))
            || matrix[row].slice(1).some(value => !numericValue(value)))) return unchanged;
    return { headerRows: [0, 1], bodyRows: dataRows, inferred: true,
        inferenceContract: 'grouped-span-row-header-contagion-v1' };
}

function validateReaderResultTableCoverage(sections, artifacts) {
    const requirement = readerResultTableRequirement(artifacts);
    if (!requirement.minimumResultTables) return requirement;
    const { extractMarkdownTables } = require('../analysis-contract.js');
    const results = sections.filter(section => ['result', 'ablation'].includes(section?.kind));
    const numericResultTables = results.flatMap(section => extractMarkdownTables(String(section.body || '')))
        .filter(table => (String(table.markdown || '').match(/\d+/g) || []).length >= 4);
    if (!numericResultTables.length) {
        throw new Error('读者文章主结果表覆盖不足：原论文 TABLE_'
            + requirement.sourceTableOrdinals.join('/TABLE_')
            + ' 明确提供定量结果；result/ablation 小节必须含至少一张可核对的数字结果表。'
            + '不能只用数据集表和配置表凑数量。保留可运行策略、必要基线与比较条件，'
            + '必要时将一张配置表改为结果表并同步正文和 tableBindings，配置事实保留在文字中。');
    }
    return { ...requirement, numericResultTables: numericResultTables.length };
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
        const headers = effectiveReaderTableRows(table).headerRows;
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

// Selection rows are model-authored coordinates, but the source explicitly
// identifies header rows.  Two mistakes are therefore safe to repair without
// inventing a cell: move the sole selected header to the front, or prepend the
// sole declared header when the model selected data rows only.  Multiple
// possible headers remain ambiguous and must go through a bounded local repair.
function canonicalizeReaderSelectionRows(sourceRows, headerRows) {
    if (!Array.isArray(sourceRows) || !Array.isArray(headerRows)) return sourceRows;
    const headers = new Set(headerRows); const selectedHeaders = sourceRows.filter(row => headers.has(row));
    if (selectedHeaders.length === 1) {
        return [selectedHeaders[0], ...sourceRows.filter(row => row !== selectedHeaders[0])];
    }
    if (selectedHeaders.length === 0 && headerRows.length === 1) return [headerRows[0], ...sourceRows];
    return sourceRows;
}

function effectiveReaderTableHeaderRows(table) {
    const matrix = table?.matrix;
    const cells = table?.cells;
    if (Array.isArray(matrix) && matrix.length > 0 && Array.isArray(cells)) {
        const derived = matrix.map((_row, row) => row).filter(row => (
            matrix[row].every((_text, column) => {
                const covering = cells.filter(cell => Number.isInteger(cell?.row)
                    && Number.isInteger(cell?.column)
                    && row >= cell.row && row < cell.row + Number(cell.rowspan || 1)
                    && column >= cell.column && column < cell.column + Number(cell.colspan || 1));
                return covering.length === 1 && covering[0].header === true;
            })
        ));
        if (derived.length > 0) {
            // LaTeXML commonly renders the highlighted winning method as a
            // complete <th> row (for example "Ours" followed by bold metric
            // values).  It is still a data row.  Older sealed v4 artifacts
            // also promoted every cell in a row when only its row label was a
            // <th>.  Keep the first real header, but do not misclassify this
            // narrow, source-visible method-label pattern as a second header.
            const hasLaterBodyRow = matrix.some((_row, row) => row > derived[0]
                && !derived.includes(row));
            const semantic = derived.filter((row, index) => !(index > 0 && hasLaterBodyRow
                && /^(?:ours?|proposed|baseline|reference|ground\s*truth)\b/i
                    .test(String(matrix[row]?.[0] || '').trim())
                && (matrix[row].slice(1).filter(value => /\d/.test(String(value))).length
                    >= Math.max(1, Math.ceil((matrix[row].length - 1) * 0.6)))));
            if (semantic.length > 0) return semantic;
        }
    }
    return Array.isArray(table?.headerRows) ? table.headerRows : [];
}

function renderReaderTableSelection(binding, artifacts) {
    const label = `读者文章 tableBindings[${Number(binding?.tableIndex) - 1}] selection`;
    if (!exactKeys(binding, ['tableIndex', 'selection']) || !Number.isInteger(binding.tableIndex) || binding.tableIndex < 1
        || !exactKeys(binding.selection, ['sourceTableOrdinal', 'sourceRows', 'sourceColumns'])) {
        throw new Error(`${label} 字段非法或混合手写数据`);
    }
    const { sourceTableOrdinal, sourceRows: requestedSourceRows, sourceColumns } = binding.selection;
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
    for (const [values, limit, minimum] of [[requestedSourceRows, table.matrix.length, 2], [sourceColumns, width, 2]]) {
        if (!Array.isArray(values) || values.length < minimum || new Set(values).size !== values.length
            || values.some(index => !Number.isInteger(index) || index < 0 || index >= limit)) {
            throw new Error(`${label} 行列重复、越界或数量不足`);
        }
    }
    const effectiveRows = effectiveReaderTableRows(table);
    const headerRows = effectiveRows.inferred
        ? effectiveRows.headerRows : effectiveReaderTableHeaderRows(table);
    const sourceRows = canonicalizeReaderSelectionRows(requestedSourceRows, headerRows);
    if (!headerRows.includes(sourceRows[0])
        || sourceRows.slice(1).some(row => headerRows.includes(row))) {
        throw new Error(`${label} 第一行必须是原表头，其余行必须是数据行；`
            + `sourceTableOrdinal=${sourceTableOrdinal}，有效表头行=${JSON.stringify(headerRows)}，`
            + `当前选择行=${JSON.stringify(requestedSourceRows)}。只修改本 binding 的 sourceRows，不能改写正文或原表。`);
    }
    const cellBindings = [];
    const matrix = sourceRows.map((sourceRow, renderedRow) => sourceColumns.map((sourceColumn, renderedColumn) => {
        const cells = (table.cells || []).filter(cell => Number.isInteger(cell.row) && Number.isInteger(cell.column)
            && sourceRow >= cell.row && sourceRow < cell.row + Number(cell.rowspan || 1)
            && sourceColumn >= cell.column && sourceColumn < cell.column + Number(cell.colspan || 1));
        const cell = cells[0];
        const text = table.matrix[sourceRow][sourceColumn];
        if (cells.length !== 1 || !sha256(cell?.sourceDomSha256) || cell.text !== text
            || (renderedRow === 0 && !headerRows.includes(sourceRow))) {
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

function repairUniqueReaderTableSelectionHeader(binding, artifacts) {
    if (!binding || !Object.prototype.hasOwnProperty.call(binding, 'selection')) return binding;
    const selection = binding.selection;
    const table = (artifacts?.tables || []).find(item => (
        item && item.ordinal === (selection && selection.sourceTableOrdinal)
    ));
    if (!table || !Array.isArray(selection && selection.sourceRows)) {
        return binding;
    }
    const effectiveHeaderRows = effectiveReaderTableHeaderRows(table);
    const selectedHeaders = selection.sourceRows.filter(row => effectiveHeaderRows.includes(row));
    const dataRows = selection.sourceRows.filter(row => !effectiveHeaderRows.includes(row));
    if (dataRows.length === 0 || selectedHeaders.length > 1) return binding;
    const headerCandidates = selectedHeaders.length === 1
        ? selectedHeaders
        : effectiveHeaderRows.length === 1 ? effectiveHeaderRows : [];
    if (headerCandidates.length !== 1) return binding;
    const repaired = {
        ...binding,
        selection: { ...selection, sourceRows: [headerCandidates[0], ...dataRows] }
    };
    try {
        renderReaderTableSelection(repaired, artifacts);
        return repaired;
    } catch (_error) {
        return binding;
    }
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
    const tableBindings = bindings.map((declaredBinding, index) => {
        const binding = repairUniqueReaderTableSelectionHeader(declaredBinding, artifacts);
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
    READER_RESULT_COVERAGE_CONTRACT, readerResultTableRequirement, validateReaderResultTableCoverage,
    hasExplicitRepeatedScientificMeasurement, findReaderTablePasteDuplication, assessReaderTableSelectionEligibility,
    effectiveReaderTableRows, effectiveReaderTableHeaderRows, canonicalizeReaderSelectionRows,
    renderReaderTableSelection, repairUniqueReaderTableSelectionHeader,
    compileReaderTableSelections };
