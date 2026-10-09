'use strict';

// 只是修复提示。这些候选既不能授权来源绑定，也不会把渲染后的正文规范化。
// 是否允许使用这些来源，仍由完整的来源核验决定。
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
    return '数字写法：source_quotes 表中的数值必须与原文中的完整单位写在同一格（如171 ms、96.4%）；独立的单位列不能替代同格单位。'
        + '若原表只在表头写单位，数据格不带单位，应保留原表头单位与原数据格，不能逐格追加%。'
        + '若原句采用“a vs. b/c dB”这样的写法，末尾单位覆盖整组数值，正文也须保留整组写法，不能拆成“a dB”。'
        + '保留来源中的千分位逗号和小数精度，不自行四舍五入；sourceQuotes 必须保留原文的换行和空白。'
        + '仅补充引文不能修正正文中的数字或单位；修改后的内容仍须通过完整来源检查。';
}

function scalar(value) {
    const text = clean(value).replace(/[*`]/g, '');
    const match = /^([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(\s*[%a-zA-Zµμ°/]+)?$/.exec(text);
    if (!match) return null;
    return { raw: text, number: Number(match[1].replace(/,/g, '')), digits: match[1],
        unit: (match[2] || '').trim(), decimals: (match[1].split('.')[1] || '').length };
}

function numericIdentities(value) {
    return [...clean(value).matchAll(
        /(?<![A-Za-z0-9_])[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![A-Za-z0-9_])/g
    )]
        .map(match => {
            const number = Number(match[0].replace(/,/g, ''));
            return Number.isFinite(number) ? String(number) : '';
        }).filter(Boolean);
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
        // 不要仅因为参考文献条目含相同的编号或模型名就把它拿出来。
        // 限定在一小段行内、精确匹配的来源窗口里。
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
    // 折叠空白只用来定位候选；返回原始切片，绝不返回折叠后的文本。
    // 出现位置有歧义时无法确定位置。
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

function tableLevelContexts(tables, renderedRows, failures = []) {
    const ignored = new Set(['method', 'model', 'system', 'baseline', 'proposed', 'unit', 'none',
        'table', 'results', 'accuracy', 'mean', 'std', 'avg', 'downarrow', 'uparrow']);
    const englishAnchors = value => [...clean(value).matchAll(/[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*/g)]
        .map(match => match[0].toLowerCase()).filter(word => word.length >= 3 && !ignored.has(word));
    const rendered = new Set(renderedRows.flat().flatMap(englishAnchors));
    const contexts = tables.flatMap(table => {
        const available = new Set(table.matrix.flat().flatMap(englishAnchors));
        const sharedAnchors = [...rendered].filter(word => available.has(word));
        if (sharedAnchors.length < 1) return [];
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
    });
    const strong = contexts.filter(context => context.sharedAnchors.length >= 2);
    if (strong.length) return strong.slice(0, 2);

    // 翻译过的行/列标签可能把除数据集名以外的所有来源锚点都藏起来。
    // 这种情况下，只有当失败的数字面和同一张渲染表格里另一个不同的数字面
    // 一起唯一确定一张完整 DOM 表格时，才给出表格。
    // 这仍然只是修复提示：它不会建立单元格映射，也不授权来源绑定。
    const failedNumbers = new Set((failures || []).flatMap(failure => (
        failure?.missingTokens || []
    )).flatMap(numericIdentities));
    const renderedNumbers = new Set(renderedRows.flat().flatMap(numericIdentities));
    if (!failedNumbers.size || renderedNumbers.size < 2) return [];
    const weak = contexts.filter(context => {
        const sourceNumbers = new Set(context.rows.flatMap(row => row.cells).flatMap(numericIdentities));
        const matched = [...renderedNumbers].filter(number => sourceNumbers.has(number));
        return context.sharedAnchors.length >= 1 && matched.length >= 2
            && [...failedNumbers].some(number => sourceNumbers.has(number));
    });
    if (weak.length !== 1) return [];
    return [{ ...weak[0], matchBasis:
        'one_english_anchor_plus_failed_and_sibling_numeric_surfaces_unique_dom_table' }];
}

function declaredQuoteCandidates(binding, renderedText, sourceText, missingTokens = []) {
    const source = String(sourceText || '');
    const result = [];
    const renderedTokens = [...String(renderedText).matchAll(/[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*[%a-zA-Z]*/g)]
        .map(match => scalar(match[0])).filter(Boolean);
    // 规范化后缺失的 token 可能丢掉末尾的零。绝不能用这种有损的规范写法
    // 替换标量单元格的实际精度。
    const failedSurfaces = scalar(renderedText) ? [] : missingTokens.filter(token => scalar(token)
        && renderedTokens.some(surface => surface.number === scalar(token).number && surface.unit === scalar(token).unit));
    for (const declared of binding?.sourceQuotes || []) {
        if (typeof declared !== 'string' || declared.length < 12 || declared.length > 1200
            || !/[a-zA-Z]{3,}/.test(declared)
            || /(?:^|\n)\s*(?:\[\d+\]|references\b|bibliography\b)|\bdoi\b|arxiv:/i.test(declared)) continue;
        const located = locateDeclaredQuote(source, declared);
        if (!located || located.quote.length > 1600) continue;
        const { quote, offset, whitespaceRecovered } = located;
        // 只考虑模型明确声明的来源句子。要求带单位；
        // 一个孤零零的引用编号永远不是候选。
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
    const tableContexts = tableLevelContexts(tables, renderedRows, failures);
    const sourceNumbers = new Set(numericIdentities(sourceText));
    const domNumbers = new Set(tables.flatMap(table => table.matrix.flat()).flatMap(numericIdentities));
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
            // 不要全局查找数值。即使数字相同，没有匹配的行标签或明确的列角色，
            // 也不构成证据。
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
                        // 只有数字近似匹配时，只能细化一个已知的行，不能发现新行；
                        // 保留歧义，不要猜。
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
        const failedNumbers = [...new Set((failure.missingTokens || []).flatMap(numericIdentities))];
        const unsupportedApproximateNumeric = /(?:约|大约|近似|估计|估读|分布中心)/u.test(text)
            && failedNumbers.length > 0
            && failedNumbers.every(number => !sourceNumbers.has(number) && !domNumbers.has(number));
        const guidance = '这些候选只供核对，不能据此认定来源已经确认，也不能假定其中只有一个正确答案。请同时核对正文单元格、表头，以及来源中的单位和写法；'
            + '仅把百分号放在独立列，或只补充 sourceQuotes，都不能修正正文裸值与来源百分数不一致的问题。'
            + readerNumericSpellingGuidance() + '不要自行换算数值，也不能把参考文献编号当作数字证据。';
        const summary = found.length ? found.map(candidate => `TABLE_${candidate.sourceTableOrdinal}`
            + `[${candidate.sourceRow},${candidate.sourceColumn}]=${JSON.stringify(candidate.text)}`
            + ` (${candidate.difference}; ${candidate.matchBasis}) 行=${JSON.stringify(candidate.rowContext)}`
            + ` 列头=${JSON.stringify(candidate.columnHeaders)}`).join('；')
            : '没有找到能通过行标签和列标题对应的原表候选。不能仅凭相同数字另找来源，请核对原文中对应的实验';
        const quoteHint = sourceQuotes.length ? `。 可供核对的原文片段 L${sourceQuotes[0].lineStart}`
            + `–${sourceQuotes[0].lineEnd}: ${JSON.stringify(sourceQuotes[0].quote)}` : '';
        const declaredHint = quoteCandidates.map(candidate => `。 当前来源记录中可供核对的原文引文 L${candidate.lineStart}`
            + `–${candidate.lineEnd}: ${JSON.stringify(candidate.quote)}；原写法=${JSON.stringify(candidate.text)}`
            + ` (${candidate.difference}${candidate.whitespaceRecovered ? '; 所提供引文中的空白已被改写，须复制这里的原始文本' : ''})；`
            + '这句话是否对应当前行的实验，仍须由人工或模型核对').join('');
        // 受限的表格上下文只附加一次，不要为六个单元格附六次。
        const weakUniqueContext = tableContexts.some(context => context.matchBasis
            === 'one_english_anchor_plus_failed_and_sibling_numeric_surfaces_unique_dom_table');
        const contextBasis = weakUniqueContext
            ? '一个英文名称与未通过检查的数字、另一不同数字共同定位了唯一的完整 DOM 表；仍只供核对'
            : '至少两个对应的英文系统或指标名称';
        const contextHint = failure === failures[0] && !found.length && tableContexts.length
            ? `。 以下原表内容只供核对（${contextBasis}）；各行与正文的对应关系尚未确认，不能据此使用 selection 或认定引文有效：${JSON.stringify(tableContexts)}。`
                + '请核对原表的表头单位和数据格。如果原表把 % 放在表头，应同时修正正文表头和不带单位的数据格，不能只补充引文；'
                + '不要删除其他原表数据格中已有的 %；这里也不要求一律改用 artifact_table' : '';
        const approximateHint = unsupportedApproximateNumeric
            ? '。 这些带“约”或“估计”措辞的数字没有出现在论文全文或任何完整原表中。若数值来自对图片的估读，'
                + '不能放进要求逐字原文引文或对应原表单元格证据的 Markdown 数字表；应删除这些数值行，或改成不含新数字的'
                + '“原文未逐项报告；图中仅显示定性趋势”，把像素支持的趋势留在表外的图片解释中。不得猜测替代值'
            : '';
        return [{ code: 'reader_source_cell_diagnostic', diagnosticOnly: true, path, bindingPath,
            renderedCell: { row, column, text }, candidates: found, sourceQuotes, quoteCandidates,
            ...(contextHint ? { tableContexts } : {}),
            ...(unsupportedApproximateNumeric ? { unsupportedApproximateNumeric: true } : {}),
            message: `${bindingPath} ${path} rendered row=${row},column=${column} text=${JSON.stringify(text)}；`
                + summary + quoteHint + declaredHint + contextHint + approximateHint + '。' + guidance }];
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
