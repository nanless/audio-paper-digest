'use strict';
// Literal PDF tables are a distinct source capability, never a synthesized DOM.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { isDeepStrictEqual } = require('node:util');
const scope = new AsyncLocalStorage();
const CONTRACT = 'reader-authenticated-pdf-table-evidence-v1';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const stable = value => require('./reader-repair').hashDraft(value);
const text = value => String(value ?? '').normalize('NFKC').replace(/[*`↑↓]/gu, '').replace(/\s+/gu, ' ').trim();
const compact = value => text(value).replace(/\s+/gu, '');
const SHA = /^[a-f0-9]{64}$/u;
// Canonical Roman numerals only; a caption-like word or IIII is not a table ID.
const TABLE_NUMBER = '(?:\\d+|(?=[MDCLXVI])M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3}))';
const TABLE_CAPTION = new RegExp('^Table\\s+' + TABLE_NUMBER + '\\s*[:.]', 'iu');
const NEXT_CAPTION = new RegExp('^(?:Table|Figure)\\s+' + TABLE_NUMBER + '\\s*[:.]', 'iu');
const PERCENT_CAPTION = new RegExp('^Table\\s+' + TABLE_NUMBER + '\\s*[:.]\\s*Results\\s*\\[%\\]', 'iu');
function numeric(value) {
    const input = compact(value).replace(/−/gu, '-');
    if (/^[-–—]$/u.test(input)) return '-';
    // 支持显著性 p 值不等式形式（如 <.0001 / <0.001 / <=0.05 / >0.99）
    const ineq = /^(<=|>=|<|>)([+-]?(?:\d+(?:\.\d+)?|\.\d+))$/u.exec(input);
    if (ineq) {
        const rawNum = ineq[2].startsWith('.') ? '0' + ineq[2] : ineq[2];
        const [integer, decimal = ''] = rawNum.replace(/^\+/u, '').split('.');
        const fraction = decimal.replace(/0+$/u, '');
        return ineq[1] + integer.replace(/^(-?)0+(?=\d)/u, '$1') + (fraction ? '.' + fraction : '');
    }
    if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:±(?:\d+(?:\.\d+)?|\.\d+))?$/u.test(input)) return null;
    return input.split('±').map(part => {
        const normalized = part.startsWith('.') ? '0' + part : part;
        const [integer, decimal = ''] = normalized.replace(/^\+/u, '').split('.');
        const fraction = decimal.replace(/0+$/u, '');
        return integer.replace(/^(-?)0+(?=\d)/u, '$1') + (fraction ? '.' + fraction : '');
    }).join('±');
}
const _ZH_SI_UNIT_MAP = Object.freeze({
    '毫秒': 'ms', '秒': 's', '小时': 'h', '赫兹': 'hz',
    '千赫兹': 'khz', '兆赫兹': 'mhz', '分贝': 'db', '百分比': '%'
});
function declaration(value) {
    const surface = text(value);
    const match = /^([A-Za-z][A-Za-z0-9 ._-]{0,63}?)\s*(?:\(\s*(%|dB|ms|s|h|Hz|kHz|MHz|GB|MB|KB|pp)\s*\)|\[\s*(%|dB|ms|s|h|Hz|kHz|MHz|GB|MB|KB|pp)\s*\]|\s+(%))$/iu.exec(surface);
    if (match) return { metric: compact(match[1]), unit: (match[2] || match[3] || match[4]).toLowerCase() };
    const zhMatch = /^([A-Za-z][A-Za-z0-9 ._-]{0,63}?)\s*(?:\(\s*(毫秒|秒|小时|赫兹|千赫兹|兆赫兹|分贝|百分比)\s*\)|\[\s*(毫秒|秒|小时|赫兹|千赫兹|兆赫兹|分贝|百分比)\s*\])$/u.exec(surface);
    if (zhMatch) return { metric: compact(zhMatch[1]), unit: _ZH_SI_UNIT_MAP[zhMatch[2] || zhMatch[3]] };
    return null;
}
function opaqueColumn(value) {
    // Retain every original column position. An unrecognized unit is opaque,
    // never a unit assertion; its metric still participates in ambiguity checks.
    const match = /^([A-Za-z][A-Za-z0-9 ._@<>=/+:-]{0,95}?)(?:\s*(?:\([^()\r\n]{1,32}\)|\[[^\[\]\r\n]{1,32}\]))?$/u.exec(text(value));
    return match ? { metric: compact(match[1]), unit: null } : null;
}
function literalLines(raw) {
    return [...raw.matchAll(/[^\r\n]+/gu)].map(match => ({ value: text(match[0]),
        start: match.index, end: match.index + match[0].length })).filter(line => line.value);
}
function exactQuotes(quotes, sourceText) {
    if (!Array.isArray(quotes)) return [];
    return quotes.flatMap(item => {
        const quote = typeof item === 'string' ? item : item?.quote;
        return typeof quote === 'string' && quote.length >= 12 && quote.length <= 4000
            && sourceText.includes(quote) && (typeof item === 'string' || item.sourceQuoteSha256 === sha(quote)) ? [quote] : [];
    });
}
function hasSequence(values, wanted) {
    return values.some((_value, index) => wanted.every((value, offset) => values[index + offset] === value));
}

// Pure structural matching is deliberately insufficient to mint a capability.
// The caller below still verifies the continuous quote against the real PDF.
function matchLiteralTable(table, quotes, document, sourceText, reasons = []) {
    if (!Array.isArray(table?.header) || table.header.length < 2 || table.header.length > 16
        || !Array.isArray(table.rows) || !table.rows.length || table.rows.length > 64
        || table.rows.some(row => !Array.isArray(row) || row.length !== table.header.length
            || row.some(value => typeof value !== 'string'))) return null;
    const wanted = table.header.flatMap((header, column) => {
        const unit = declaration(header); return column > 0 && unit ? [{ column, ...unit }] : [];
    });
    if (!wanted.length || new Set(wanted.map(value => value.metric)).size !== wanted.length) return null;
    const originalQuotes = exactQuotes(quotes, sourceText);
    if (!originalQuotes.length || !require('./reader-sealed-pdf-quote-evidence').isQuote(document) || !document.available
        || typeof document.rawFullText !== 'string') return null;
    const lines = literalLines(document.rawFullText), candidates = [];
    const captions = lines.map((line, index) => TABLE_CAPTION.test(line.value) ? index : -1).filter(index => index >= 0);
    const scanWindow = (captionIndex, firstMin, limit, bottomCaption) => {
        for (let first = firstMin; first + 2 < limit; first++) {
            if (bottomCaption) {
                if (lines[captionIndex].start - lines[first].start > 6000 || numeric(lines[first].value) !== null) continue;
            } else if (lines[first].start - lines[captionIndex].start > 6000 || numeric(lines[first].value) !== null) {
                continue;
            }
            let width = 0;
            while (first + 1 + width < limit && numeric(lines[first + 1 + width].value) !== null) width++;
            if (width < 1 || width > 15) continue;
            if (bottomCaption ? (first - width < firstMin - 1) : (first - width <= captionIndex)) continue;
            const headers = lines.slice(first - width, first).map(line => line.value);
            const explicit = headers.map(declaration);
            const caption = bottomCaption
                ? lines[captionIndex].value
                : lines.slice(captionIndex, first - width).map(line => line.value).join(' ');
            const percentCaption = PERCENT_CAPTION.test(caption);
            const captionColumns = percentCaption && headers.every(header => /^[A-Za-z][A-Za-z0-9 ._-]{0,63}$/u.test(header))
                ? headers.map(metric => ({ metric: compact(metric), unit: '%' })) : null;
            const sourceColumns = headers.map((header, index) => explicit[index] || captionColumns?.[index] || opaqueColumn(header));
            if (sourceColumns.some(column => !column)) continue;
            const mixedUnits = sourceColumns.some(column => column.unit === null);
            const metricCounts = new Map();
            for (const col of sourceColumns) {
                metricCounts.set(col.metric, (metricCounts.get(col.metric) || 0) + 1);
            }
            const duplicatedWanted = wanted.some(w => (metricCounts.get(w.metric) || 0) > 1);
            if (duplicatedWanted) {
                reasons.push('原PDF同一表存在重复指标列（例如多个K分组），当前列分组不能唯一逐字映射；保留原分组表头，不猜列位置。');
                continue;
            }
            const columns = wanted.map(column => ({ ...column, sourceColumn: sourceColumns.findIndex(value =>
                value.metric === column.metric && value.unit === column.unit) }));
            if (columns.some(column => column.sourceColumn < 0)) {
                reasons.push('渲染指标/单位未逐字对应原列：' + columns.filter(column => column.sourceColumn < 0)
                    .map(column => `${column.metric}(${column.unit})`).join('、') + '；原列为：'
                    + headers.join(' | ') + '。不要翻译、缩写指标名，中文解释放表外。');
                continue;
            }
            const sourceRows = [];
            let cursor = first;
            while (cursor + width < limit && sourceRows.length < 64) {
                const label = lines[cursor];
                if (numeric(label.value) !== null || label.value.length > 200) break;
                const cells = lines.slice(cursor + 1, cursor + 1 + width);
                if (cells.length !== width || cells.some(cell => numeric(cell.value) === null)) break;
                sourceRows.push({ label: label.value, cells: cells.map(cell => cell.value), end: cells.at(-1).end,
                    quote: document.rawFullText.slice(label.start, cells.at(-1).end).replace(/\s+/gu, ' ').trim() });
                cursor += width + 1;
            }
            if (sourceRows.length < 2) continue;
            // Bottom-caption tables must abut the caption line directly with zero intervening text.
            if (bottomCaption && cursor !== captionIndex) continue;
            const repeatedLabels = mixedUnits && new Set(sourceRows.map(row => compact(row.label))).size !== sourceRows.length;
            let conditionColumns = null;
            if (repeatedLabels) {
                const conditions = headers.flatMap((header, sourceColumn) => text(header) === 'Dim'
                    ? [{ sourceColumn, header: text(header) }] : []);
                const complete = table.header.length === width + 1 && headers.every((header, index) =>
                    compact(header) === compact(table.header[index + 1]));
                const identities = sourceRows.map(row => JSON.stringify([compact(row.label),
                    ...conditions.map(column => numeric(row.cells[column.sourceColumn]))]));
                if (!conditions.length || !complete || new Set(identities).size !== sourceRows.length) {
                    reasons.push('原PDF混合单位表存在重复行名，原分组身份不能唯一逐字映射；保留完整分组，不凭数字猜行。');
                    continue;
                }
                conditionColumns = conditions;
            }
            let quoteStart = lines[captionIndex].start;
            let quoteEnd = sourceRows.at(-1).end;
            if (bottomCaption) {
                const labelHeaderIndex = first - width - 1;
                const headerStart = labelHeaderIndex >= Math.max(0, firstMin - 1)
                    && compact(lines[labelHeaderIndex].value) === compact(table.header[0])
                    ? labelHeaderIndex : (first - width);
                quoteStart = lines[headerStart].start;
                quoteEnd = lines[captionIndex].end;
            }
            const quote = document.rawFullText.slice(quoteStart, quoteEnd).replace(/\s+/gu, ' ').trim();
            if (quote.length < 12 || quote.length > 4000 || document.normalizedFullText.split(quote).length !== 2) continue;
            const rowQuotes = originalQuotes.filter(value => {
                const normalized = value.replace(/\s+/gu, ' ').trim();
                if (document.normalizedFullText.split(normalized).length === 2) {
                    if (quote.includes(normalized)) return true;
                    if (bottomCaption && normalized.includes(quote)) {
                        const before = normalized.slice(0, normalized.indexOf(quote));
                        return !/(?:^|\s)(?:Table|Figure)\s+(?:\d+|[MDCLXVI]+)\s*[:.]/iu.test(before);
                    }
                    return false;
                }
                // Bottom-caption PDF tables with multi-column super-headers (e.g. "Method / Style Accuracy / Style Consistency / Top-1 %")
                // may have the row-label column header reordered relative to super-headers between the reading-order extractor and raw fitz text.
                // Require the exact rest of the quote to match the unique fitz table+caption verbatim, and require the same row-label header to exist
                // within the 4 lines directly above the column headers in fitz.
                if (bottomCaption && normalized.includes(quote)) {
                    const startIdx = normalized.indexOf(quote);
                    const before = normalized.slice(0, startIdx).trim();
                    const after = normalized.slice(startIdx + quote.length).trim();
                    if (!after && before && compact(before) === compact(table.header[0])) {
                        const priorLines = lines.slice(Math.max(0, first - width - 4), first - width);
                        if (priorLines.some(line => compact(line.value) === compact(table.header[0]))) {
                            return true;
                        }
                    }
                }
                return false;
            });
            const mapped = table.rows.map((row, index) => {
                const matches = sourceRows.map((original, sourceRow) => ({ original, sourceRow }))
                    .filter(({ original }) => compact(original.label) === compact(row[0])
                        && (!conditionColumns || conditionColumns.every(column =>
                            numeric(row[column.sourceColumn + 1]) !== null
                            && numeric(row[column.sourceColumn + 1]) === numeric(original.cells[column.sourceColumn])))
                        && (!conditionColumns || original.cells.every((value, index) =>
                            numeric(row[index + 1]) === numeric(value)))
                        && columns.every(column => numeric(row[column.column]) !== null
                            && numeric(row[column.column]) !== '-' && numeric(row[column.column]) === numeric(original.cells[column.sourceColumn])));
                if (matches.length !== 1) {
                    reasons.push(`渲染行名 ${JSON.stringify(row[0])} 与原PDF行名/完整数值没有唯一逐字对应；原行名：`
                        + sourceRows.slice(0,8).map(value => value.label).join(' | ') + '。不要截短方法名或省略括号条件。');
                    return null;
                }
                const { original, sourceRow } = matches[0];
                const numbers = columns.flatMap(column => require('../deep-analyzer').readerNumericTokens(row[column.column]));
                if (!rowQuotes.some(quote => mixedUnits
                    ? quote.replace(/\s+/gu, ' ').trim().includes(original.quote)
                        && document.normalizedFullText.split(original.quote).length === 2
                    : compact(quote).includes(compact(original.label))
                        && hasSequence(require('../deep-analyzer').readerNumericTokens(quote), numbers))) return null;
                return { row: index + 1, sourceRow: sourceRow + 1, rowLabel: original.label,
                    ...(conditionColumns ? { conditionIdentity: { contract: 'reader-pdf-explicit-dimension-row-v1',
                        columns: conditionColumns.map(column => ({ column: column.sourceColumn + 1,
                            sourceColumn: column.sourceColumn + 1, header: column.header,
                            value: original.cells[column.sourceColumn] })) } } : {}),
                    values: columns.map(column => ({ column: column.column, sourceColumn: column.sourceColumn + 1,
                        value: row[column.column], sourceValue: original.cells[column.sourceColumn], unit: column.unit })) };
            });
            if (mapped.some(value => value === null)) continue;
            candidates.push({ quote, columns, rows: mapped });
        }
    };
    for (const captionIndex of captions) {
        const next = lines.findIndex((line,index) => index > captionIndex && NEXT_CAPTION.test(line.value));
        const limit = next < 0 ? lines.length : next;
        scanWindow(captionIndex, captionIndex + 2, limit, false);
        let prev = -1;
        for (let i = captionIndex - 1; i >= Math.max(0, captionIndex - 160); i--) {
            if (NEXT_CAPTION.test(lines[i].value)) { prev = i; break; }
        }
        const bottomMin = Math.max(prev + 2, captionIndex - 160);
        if (captionIndex - bottomMin >= 3) scanWindow(captionIndex, bottomMin, captionIndex, true);
    }
    return candidates.length === 1 ? candidates[0] : null;
}

function pdfQuotes(source, quotes) {
    require('../env-loader').requireExternalRuntime('reader-authenticated-pdf-table-evidence');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'authenticated-pdf-table-')); let fd;
    try {
        fs.chmodSync(directory, 0o700);
        const filename = path.join(directory, 'input.json');
        fs.writeFileSync(filename, JSON.stringify({ pdfBase64: source.pdf.toString('base64'), pdfSha256: source.pdfSha256, quotes }), { mode: 0o600 });
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        return JSON.parse(require('./reader-pdf-extraction-scope').runAuthenticatedPdfQuoteExtractor(fd));
    } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(directory, { recursive: true, force: true }); }
}
function hierarchicalTable(source, table, quotes, document) {
    const boundQuotes = exactQuotes(quotes, source.sourceText);
    if (!boundQuotes.length) return null;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'authenticated-pdf-hierarchy-')); let fd;
    try {
        fs.chmodSync(directory, 0o700);
        const filename = path.join(directory, 'input.json');
        const view = { markdown: table.markdown, header: table.header, rows: table.rows };
        fs.writeFileSync(filename, JSON.stringify({ pdfBase64: source.pdf.toString('base64'),
            pdfSha256: source.pdfSha256, table: view, quotes: boundQuotes }), { mode: 0o600 });
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const result = JSON.parse(require('./reader-pdf-extraction-scope').runAuthenticatedPdfHierarchicalTableExtractor(fd));
        if (result.contract !== 'reader-authenticated-pdf-hierarchical-table-v1' || result.eligible !== true) return null;
        const evidence = result.evidence;
        if (evidence?.contract !== result.contract || evidence.pdfSha256 !== source.pdfSha256
            || evidence.rawFullTextSha256 !== document.rawFullTextSha256
            || evidence.renderedTableSha256 !== sha(table.markdown)
            || !Array.isArray(evidence.columns) || !Array.isArray(evidence.rows)
            || !evidence.grid?.captionEvidence?.quote) throw new Error('Authenticated PDF hierarchy response drifted');
        return { quote: evidence.grid.captionEvidence.quote, columns: evidence.columns, rows: evidence.rows,
            hierarchicalPdfTableEvidence: evidence };
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
function sourceBoundary(callback) {
    try { return callback(); }
    catch (cause) {
        const error = new Error('Authenticated PDF source verification failed: ' + String(cause?.message || cause), { cause });
        error.code = isSourceFailure(cause) && cause.code ? cause.code : 'READER_AUTHENTICATED_PDF_SOURCE_INTEGRITY';
        error.scope = 'run'; error.retryable = false;
        throw error;
    }
}
function withVerifiedSource(handle, callback) {
    const read = require('./conference-source-context').readerPdfSourceForContext;
    const source = typeof read === 'function' ? sourceBoundary(() => read(handle)) : null;
    if (!source || typeof callback !== 'function' || !Buffer.isBuffer(source.pdf)
        || typeof source.sourceText !== 'string' || sha(source.pdf) !== source.pdfSha256
        || ![source.pdfSha256, source.sourceSnapshotSha256, source.structuredArtifactsSha256].every(value => SHA.test(value || ''))
        || !source.sourceIdentity || typeof source.assertUnchanged !== 'function') throw new Error('PDF table evidence requires authenticated source authority');
    const active = scope.getStore();
    if (active?.handle === handle && isDeepStrictEqual(active.source.sourceIdentity, source.sourceIdentity))
        return require('./reader-authenticated-pdf-footnote-evidence').withVerifiedSource(handle, callback);
    const state = { handle, source, sourceTextSha256: sha(source.sourceText), cache: new Map(), document: null };
    return require('./reader-pdf-extraction-scope').withPdfExtractionScope(() => scope.run(state,
        () => require('./reader-authenticated-pdf-footnote-evidence').withVerifiedSource(handle, callback)));
}
function withoutVerifiedSource(callback) {
    return scope.run(null, () => require('./reader-authenticated-pdf-footnote-evidence').withoutVerifiedSource(callback));
}
function derive(table, quotes) {
    const active = scope.getStore(); if (!active) return null;
    if (!table?.header?.some((value, column) => column > 0 && declaration(value))) return null;
    sourceBoundary(() => require('../env-loader').requireExternalRuntime('reader-authenticated-pdf-table-evidence'));
    sourceBoundary(() => active.source.assertUnchanged());
    const key = stable({ table, quotes });
    if (active.cache.has(key)) return structuredClone(active.cache.get(key));
    if (!active.document) {
        const result = sourceBoundary(() => pdfQuotes(active.source, []));
        if (result.document?.pdfSha256 !== active.source.pdfSha256
            || sha(result.document.rawFullText) !== result.document.rawFullTextSha256
            || sha(result.document.normalizedFullText) !== result.document.normalizedFullTextSha256) sourceBoundary(() => { throw new Error('Authenticated PDF text projection drifted'); });
        active.document = result.document;
    }
    const reasons = [];
    // Keep the original successful path and its proof bytes unchanged. A failed
    // flat match may only gain units through a complete real-PDF hierarchy.
    const match = matchLiteralTable(table, quotes, active.document, active.source.sourceText, reasons)
        || sourceBoundary(() => hierarchicalTable(active.source, table, quotes, active.document));
    if (match?.hierarchicalPdfTableEvidence) reasons.length = 0;
    active.reasons ||= new Map(); active.reasons.set(key, [...new Set(reasons)].slice(0,3));
    if (!match) { active.cache.set(key, null); return null; }
    const response = sourceBoundary(() => pdfQuotes(active.source, [match.quote]));
    if (!isDeepStrictEqual(response.document, active.document)) sourceBoundary(() => { throw new Error('Authenticated PDF quotation changed'); });
    const quote = response.results?.[0];
    if (!quote?.eligible || quote.evidence.pdfSha256 !== active.source.pdfSha256 || quote.evidence.quote !== match.quote) return null;
    const body = { contract: CONTRACT, paperId: active.source.paperId,
        sourceIdentity: active.source.sourceIdentity, sourceSnapshotSha256: active.source.sourceSnapshotSha256,
        sourceTextSha256: active.sourceTextSha256, structuredArtifactsSha256: active.source.structuredArtifactsSha256,
        pdfSha256: active.source.pdfSha256, renderedTableSha256: sha(table.markdown),
        columns: match.columns, rows: match.rows, pdfQuoteEvidence: quote.evidence,
        ...(match.hierarchicalPdfTableEvidence ? { hierarchicalPdfTableEvidence: match.hierarchicalPdfTableEvidence } : {}) };
    const proof = { ...body, evidenceSha256: stable(body) };
    sourceBoundary(() => active.source.assertUnchanged()); active.cache.set(key, proof);
    return structuredClone(proof);
}
function coverage(table, quotes) {
    const proof = derive(table, quotes);
    return proof ? proof.rows.flatMap(row => row.values.flatMap(cell =>
        require('../deep-analyzer').readerNumericTokens(cell.value).map(value => ({ row: row.row, column: cell.column, value, unit: cell.unit })))) : [];
}
function diagnostics(table, quotes) {
    const active = scope.getStore(); if (!active) return [];
    derive(table, quotes);
    const unmapped = (table?.header || []).filter(value => /[([]\s*(?:%|dB|ms|s|h|Hz|kHz|MHz|GB|MB|KB|pp)\s*[)\]]/iu.test(text(value))
        && !declaration(value));
    return [...(active.reasons?.get(stable({ table, quotes })) || []), ...(unmapped.length
        ? ['当前表头未提供原文英文指标的逐字对应：' + unmapped.join(' | ') + '；保留原列名与原单位，中文解释放表外，不能从别处借单位。'] : [])].slice(0,4);
}
function isSourceFailure(error) {
    return error?.scope === 'run' || ['CONFERENCE_SOURCE_CONTEXT_INTEGRITY',
        'CONFERENCE_EXTRACTION_RECEIPT_INTEGRITY', 'HISTORICAL_DIRECT_REWRITE_SOURCE_INTEGRITY',
        'READER_AUTHENTICATED_PDF_SOURCE_INTEGRITY'].includes(error?.code)
        || Boolean(require('./conference-process-recovery').findStorageFailure(error));
}
function assertEvidence(table, quotes, proof) {
    if (!scope.getStore()) throw new Error('Saved PDF table evidence lacks authenticated source scope');
    const actual = derive(table, quotes);
    if (!actual || !isDeepStrictEqual(actual, proof)) throw new Error('Saved PDF table evidence differs from original source, table or quote');
    return true;
}
function withSavedPaper(paper, callback) {
    const marked = (paper?.apiReaderPlan?.tableBindings || []).filter(binding => binding.authenticatedPdfTableEvidence !== undefined);
    if (!marked.length) return callback();
    const active = scope.getStore();
    if (!active || paper.sourceSha256 !== active.sourceTextSha256
        || (paper.directPaperId || paper.id || `arxiv:${paper.arxivId}`) !== active.source.paperId) throw new Error('Saved PDF table paper/source identity differs');
    const tables = require('../analysis-contract').extractMarkdownTables(paper.apiReaderArticle);
    for (const binding of marked) {
        if (binding.sourceType !== 'source_quotes' || !tables[binding.tableIndex - 1]) throw new Error('PDF table proof requires its exact source_quotes table');
        assertEvidence(tables[binding.tableIndex - 1], binding.sourceQuotes, binding.authenticatedPdfTableEvidence);
    }
    return callback();
}
module.exports = { CONTRACT, withVerifiedSource, withoutVerifiedSource, derive, coverage, diagnostics, isSourceFailure,
    assertEvidence, withSavedPaper, matchLiteralTable };
