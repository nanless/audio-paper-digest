'use strict';

// Repair hints only. These candidates neither authorize a source binding nor
// normalize the rendered article. The full source gate remains authoritative.
const READER_SOURCE_DIAGNOSTICS_VERSION = 'reader-source-diagnostics-v2';
const clean = value => String(value ?? '').normalize('NFKC').replace(/[\u2212]/g, '-').trim();
const identity = value => clean(value).toLowerCase().replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ').replace(/[（(][%％][）)]|[%％↑↓]/g, '').trim();
const anchor = value => {
    const text = identity(value);
    return /[a-z]{3}|[\u3400-\u9fff]{2}/i.test(text) ? text : '';
};
const sameLabel = (a, b) => Boolean(anchor(a) && anchor(a) === anchor(b));
const sha = value => /^[a-f0-9]{64}$/.test(String(value || ''));

function readerNumericSpellingGuidance() {
    return '数字格式：source_quotes 的数值必须与完整原文单位写在同一格（如171 ms、96.4%）；独立单位列不能替代。'
        + '若原表单位仅写在表头、数据格为裸值，应保留原表头单位与裸格，不能逐格追加%。'
        + '保留来源千分位逗号和小数精度，不自行四舍五入；sourceQuotes必须保留原文换行/空白。'
        + '只补quotes不能修复正文数字/单位拼写错误；仍须通过完整来源门禁。';
}

function scalar(value) {
    const text = clean(value).replace(/[*`]/g, '');
    const match = /^([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(\s*[%a-zA-Zµμ°/]+)?$/.exec(text);
    if (!match) return null;
    return { raw: text, number: Number(match[1].replace(/,/g, '')), digits: match[1],
        unit: (match[2] || '').trim(), decimals: (match[1].split('.')[1] || '').length };
}

function describeDifference(rendered, source, headers = []) {
    const left = scalar(rendered);
    const right = scalar(source);
    if (clean(rendered) === clean(source)) return 'exact_surface';
    if (!left || !right) return 'source_spelling_differs';
    if (left.number === right.number) {
        if (left.unit !== right.unit) {
            if ([left.unit, right.unit].every(unit => ['', '%'].includes(unit))) {
                return headers.some(header => /[%％]/.test(header.text))
                    ? 'percent_in_source_header' : 'percent_position_differs';
            }
            return 'unit_spelling_differs';
        }
        if (left.digits.includes(',') !== right.digits.includes(',')) return 'thousands_separator_differs';
        return 'decimal_spelling_differs';
    }
    if (left.unit === right.unit && left.decimals < right.decimals
        && Number(right.number.toFixed(left.decimals)) === left.number) return 'possible_rounding';
    return 'different_source_value';
}

function tableCell(table, row, column) {
    const cells = (table.cells || []).filter(cell => Number.isInteger(cell?.row)
        && Number.isInteger(cell?.column) && row >= cell.row
        && row < cell.row + Number(cell.rowspan || 1) && column >= cell.column
        && column < cell.column + Number(cell.colspan || 1));
    return cells.length === 1 && sha(cells[0].sourceDomSha256) ? cells[0] : null;
}

function headersFor(table, column) {
    return (table.headerRows || []).filter(Number.isInteger).flatMap(row => {
        const cell = tableCell(table, row, column);
        return cell ? [{ row, column, text: cell.text }] : [];
    });
}

function sourceContexts(sourceText, candidate) {
    const lines = String(sourceText || '').split('\n');
    const labels = candidate.rowContext.filter(cell => cell.column !== candidate.sourceColumn)
        .map(cell => anchor(cell.text)).filter(Boolean);
    if (!labels.length) return [];
    const result = [];
    for (let index = 0; index < lines.length && result.length < 2; index += 1) {
        // Never offer a bibliography entry merely because it contains the same
        // number/model name. Restrict to a short row-local exact source window.
        if (/^\s*(?:references|bibliography)\s*$/i.test(lines[index])) break;
        if (/^\s*\[\d+\]/.test(lines[index])) continue;
        if (!labels.some(label => identity(lines[index]).includes(label))) continue;
        const end = Math.min(lines.length, index + Math.min(candidate.rowContext.length + 2, 12));
        const quote = lines.slice(index, end).join('\n');
        if (quote.length > 1200 || !quote.includes(candidate.text)) continue;
        result.push({ quote, lineStart: index + 1, lineEnd: end, basis: 'source_row_label_and_cell_surface' });
    }
    return result;
}

function candidateAt(table, row, column, renderedText, basis) {
    const cell = tableCell(table, row, column);
    if (!cell || typeof cell.text !== 'string') return null;
    const rowContext = (table.matrix?.[row] || []).map((text, columnIndex) => ({ column: columnIndex, text }));
    const columnHeaders = headersFor(table, column);
    return { sourceTableOrdinal: table.ordinal, sourceRow: row, sourceColumn: column,
        domRow: cell.row, domColumn: cell.column, text: cell.text, sourceDomSha256: cell.sourceDomSha256,
        rowContext, columnHeaders, matchBasis: basis,
        difference: describeDifference(renderedText, cell.text, columnHeaders) };
}

function locateDeclaredQuote(source, declared) {
    // Whitespace folding locates a candidate only; return the original slice,
    // never the folded text. Ambiguous occurrences cannot establish a location.
    const needle = declared.replace(/\s+/g, ' ').trim();
    let folded = '';
    const starts = [];
    const ends = [];
    for (let offset = 0; offset < source.length;) {
        const start = offset;
        if (/\s/.test(source[offset])) {
            while (offset < source.length && /\s/.test(source[offset])) offset += 1;
            folded += ' ';
        } else {
            folded += source[offset];
            offset += 1;
        }
        starts.push(start);
        ends.push(offset);
    }
    const index = folded.indexOf(needle);
    if (!needle || index < 0 || folded.indexOf(needle, index + 1) >= 0) return null;
    const offset = starts[index];
    const quote = source.slice(offset, ends[index + needle.length - 1]);
    return { quote, offset, whitespaceRecovered: quote !== declared };
}

function tableLevelContexts(tables, renderedRows) {
    const ignored = new Set(['method', 'model', 'system', 'baseline', 'proposed', 'unit', 'none',
        'table', 'results', 'accuracy', 'mean', 'std', 'avg', 'downarrow', 'uparrow']);
    const englishAnchors = value => [...clean(value).matchAll(/[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*/g)]
        .map(match => match[0].toLowerCase()).filter(word => word.length >= 3 && !ignored.has(word));
    const rendered = new Set(renderedRows.flat().flatMap(englishAnchors));
    return tables.flatMap(table => {
        const available = new Set(table.matrix.flat().flatMap(englishAnchors));
        const sharedAnchors = [...rendered].filter(word => available.has(word));
        if (sharedAnchors.length < 2) return [];
        let chars = 0;
        const rows = [];
        for (const [row, values] of table.matrix.entries()) {
            if (rows.length >= 14 || !Array.isArray(values) || values.length > 12
                || values.some((text, column) => typeof text !== 'string'
                    || tableCell(table, row, column)?.text !== text)) continue;
            const size = JSON.stringify(values).length;
            if (size > 1800 - chars) continue;
            chars += size;
            rows.push({ row, cells: values.slice() });
        }
        if (!rows.length) return [];
        return [{ sourceTableOrdinal: table.ordinal, caption: String(table.caption || '').slice(0, 400),
            sourceDomSha256: table.sourceDomSha256, sharedAnchors, rows,
            sourceDeclaredHeaderRows: [...(table.headerRows || [])],
            omittedRows: table.matrix.length - rows.length, rowCorrespondenceConfirmed: false,
            matchBasis: 'at_least_two_english_table_anchors_only' }];
    }).slice(0, 2);
}

function declaredQuoteCandidates(binding, renderedText, sourceText, missingTokens = []) {
    const source = String(sourceText || '');
    const result = [];
    const renderedTokens = [...String(renderedText).matchAll(/[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*[%a-zA-Z]*/g)]
        .map(match => scalar(match[0])).filter(Boolean);
    // Canonical missing tokens may discard trailing zeroes. Never replace a
    // scalar cell's actual precision with that lossy canonical spelling.
    const failedSurfaces = scalar(renderedText) ? [] : missingTokens.filter(token => scalar(token)
        && renderedTokens.some(surface => surface.number === scalar(token).number && surface.unit === scalar(token).unit));
    for (const declared of binding?.sourceQuotes || []) {
        if (typeof declared !== 'string' || declared.length < 12 || declared.length > 1200
            || !/[a-zA-Z]{3,}/.test(declared)
            || /(?:^|\n)\s*(?:\[\d+\]|references\b|bibliography\b)|\bdoi\b|arxiv:/i.test(declared)) continue;
        const located = locateDeclaredQuote(source, declared);
        if (!located || located.quote.length > 1600) continue;
        const { quote, offset, whitespaceRecovered } = located;
        // Only the model's explicitly declared source sentence is considered.
        // Require an attached unit; a naked citation number is never a candidate.
        for (const match of quote.matchAll(/[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:%|ms\b|s\b|Hz\b|kHz\b|dB\b)/g)) {
            const compared = [renderedText, ...failedSurfaces].map(surface =>
                ({ surface, difference: describeDifference(surface, match[0]) })).find(item =>
                ['percent_position_differs', 'thousands_separator_differs', 'decimal_spelling_differs',
                    'possible_rounding', 'unit_spelling_differs'].includes(item.difference));
            if (!compared) continue;
            const { difference, surface } = compared;
            if (result.some(item => item.quote === quote && item.text === match[0])) continue;
            result.push({ quote, text: match[0], difference, matchBasis: 'declared_exact_quote_surface_candidate',
                comparedRenderedToken: surface, whitespaceRecovered,
                lineStart: source.slice(0, offset).split('\n').length,
                lineEnd: source.slice(0, offset + quote.length).split('\n').length });
            if (result.length >= 2) return result;
        }
    }
    return result;
}

function diagnoseReaderTableSource({ binding, bindingIndex, sectionIndex, renderedRows,
    failures, structuredArtifacts, sourceText }) {
    const tables = (structuredArtifacts?.tables || []).filter(table => table?.recoveryStatus === 'complete'
        && sha(table.sourceDomSha256) && Array.isArray(table.matrix));
    const tableContexts = tableLevelContexts(tables, renderedRows);
    return (failures || []).slice(0, 6).flatMap(failure => {
        const row = failure.renderedRow;
        const column = failure.renderedColumn;
        const text = renderedRows?.[row]?.[column];
        if (!Number.isInteger(row) || !Number.isInteger(column) || typeof text !== 'string') return [];
        const candidates = [];
        const mapping = binding?.cellBindings?.find(cell => cell.renderedRow === row && cell.renderedColumn === column);
        if (mapping && Number.isInteger(binding.sourceTableOrdinal)) {
            const table = tables.find(item => item.ordinal === binding.sourceTableOrdinal);
            if (table) candidates.push(candidateAt(table, mapping.sourceRow, mapping.sourceColumn, text, 'declared_dom_coordinate'));
        } else {
            // Do not look up values globally. Even an identical number is not
            // evidence without a matching row label and/or explicit column role.
            for (const table of tables) {
                for (let sourceRow = 0; sourceRow < table.matrix.length; sourceRow += 1) {
                    if ((table.headerRows || []).includes(sourceRow)) continue;
                    const sourceValues = table.matrix[sourceRow];
                    if (!Array.isArray(sourceValues)) continue;
                    const rowMatches = renderedRows[row].some((value, index) => index !== column
                        && sourceValues.some(source => sameLabel(value, source)));
                    if (!rowMatches) continue;
                    for (let sourceColumn = 0; sourceColumn < sourceValues.length; sourceColumn += 1) {
                        const columnMatches = headersFor(table, sourceColumn)
                            .some(header => sameLabel(renderedRows[0]?.[column], header.text));
                        const difference = describeDifference(text, sourceValues[sourceColumn], headersFor(table, sourceColumn));
                        // A numeric near-match alone can only refine a known row,
                        // never discover one; retain ambiguity instead of guessing.
                        if (!columnMatches && !['percent_in_source_header', 'percent_position_differs',
                            'thousands_separator_differs', 'decimal_spelling_differs', 'possible_rounding',
                            'unit_spelling_differs', 'exact_surface'].includes(difference)) continue;
                        if (!columnMatches && (!scalar(text) || !scalar(sourceValues[sourceColumn]))) continue;
                        candidates.push(candidateAt(table, sourceRow, sourceColumn, text,
                            columnMatches ? 'row_label_and_column_header' : 'row_label_and_numeric_surface_candidate'));
                    }
                }
            }
        }
        const found = candidates.filter(Boolean).sort((a, b) =>
            Number(b.matchBasis === 'row_label_and_column_header') - Number(a.matchBasis === 'row_label_and_column_header')).slice(0, 4);
        const path = `/sections/${sectionIndex}/body`;
        const bindingPath = `/tableBindings/${bindingIndex}`;
        const sourceQuotes = found.flatMap(candidate => sourceContexts(sourceText, candidate)).slice(0, 3);
        const quoteCandidates = declaredQuoteCandidates(binding, text, sourceText, failure.missingTokens || []);
        const guidance = '候选仅用于核对，不是已验证绑定或唯一答案。必须同时核对正文单元格、表头和来源单位/拼写；'
            + '百分号仅放独立列或仅补sourceQuotes不能修复正文裸值与来源百分数不一致。'
            + readerNumericSpellingGuidance() + '不要自动换算或借文献编号补证据。';
        const summary = found.length ? found.map(candidate => `TABLE_${candidate.sourceTableOrdinal}`
            + `[${candidate.sourceRow},${candidate.sourceColumn}]=${JSON.stringify(candidate.text)}`
            + ` (${candidate.difference}; ${candidate.matchBasis}) 行=${JSON.stringify(candidate.rowContext)}`
            + ` 列头=${JSON.stringify(candidate.columnHeaders)}`).join('；')
            : '未找到有行列语义锚点的原表候选；不得仅按同值数字搜索替代证据，请核对原文对应实验。';
        const quoteHint = sourceQuotes.length ? ` 原文候选上下文 L${sourceQuotes[0].lineStart}`
            + `–${sourceQuotes[0].lineEnd}: ${JSON.stringify(sourceQuotes[0].quote)}` : '';
        const declaredHint = quoteCandidates.map(candidate => ` 当前绑定的逐字原句候选 L${candidate.lineStart}`
            + `–${candidate.lineEnd}: ${JSON.stringify(candidate.quote)}；原写法=${JSON.stringify(candidate.text)}`
            + ` (${candidate.difference}${candidate.whitespaceRecovered ? '; 原声明空白被改写，须复制此原始字节' : ''})；`
            + '该句是否对应本行实验仍须人工/模型核对').join('');
        // Attach the bounded table context once, not six times for six cells.
        const contextHint = failure === failures[0] && !found.length && tableContexts.length
            ? ` 候选原表上下文（至少两个英文系统/指标锚点；逐行对应未确认，不授予selection资格）：${JSON.stringify(tableContexts)}。`
                + '请自行核对原样表头单位及数据格；确认原表把%放表头后，应同时修正文表头和裸值写法，不能只加quotes；'
                + '不要把其他原表本已带%的数据格也去掉单位，不强制改用artifact_table。' : '';
        return [{ code: 'reader_source_cell_diagnostic', diagnosticOnly: true, path, bindingPath,
            renderedCell: { row, column, text }, candidates: found, sourceQuotes, quoteCandidates,
            ...(contextHint ? { tableContexts } : {}),
            message: `${bindingPath} ${path} rendered row=${row},column=${column} text=${JSON.stringify(text)}；`
                + summary + quoteHint + declaredHint + contextHint + '。' + guidance }];
    });
}

function buildReaderSourceDiagnostics({ draft, sourceText, structuredArtifacts, parserError }) {
    const message = String(parserError?.message || parserError || '');
    if (!draft || !/关键数字缺少|渲染单元格与原始 cell 不一致/.test(message)) return [];
    const bindingIndex = Number(/tableBindings\[(\d+)\]/.exec(message)?.[1]);
    if (!Number.isInteger(bindingIndex)) return [];
    const { locateReaderDraftTables } = require('./reader-draft-order.js');
    const location = locateReaderDraftTables(draft).find(item => item.bindingIndex === bindingIndex);
    if (!location?.table) return [];
    const failures = [...message.matchAll(/row=(\d+),column=(\d+)([^；\n]*)/g)]
        .map(match => ({ renderedRow: Number(match[1]), renderedColumn: Number(match[2]),
            missingTokens: (/\bmissing=([+\-0-9a-z%.]+(?:,[+\-0-9a-z%.]+)*)/i.exec(match[3])?.[1] || '')
                .split(',').map(token => token.replace(/\.$/, '')).filter(Boolean) }));
    if (!failures.length) {
        const cell = /渲染单元格与原始 cell 不一致:\s*(\d+):(\d+)/.exec(message);
        if (cell) failures.push({ renderedRow: Number(cell[1]), renderedColumn: Number(cell[2]) });
    }
    return diagnoseReaderTableSource({ binding: draft.tableBindings?.[bindingIndex], bindingIndex,
        sectionIndex: location.sectionIndex, renderedRows: [location.table.header, ...location.table.rows],
        failures, structuredArtifacts, sourceText });
}

module.exports = { READER_SOURCE_DIAGNOSTICS_VERSION, describeDifference, diagnoseReaderTableSource,
    buildReaderSourceDiagnostics, readerNumericSpellingGuidance };
