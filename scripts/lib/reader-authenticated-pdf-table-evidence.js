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
function numeric(value) {
    const input = compact(value).replace(/−/gu, '-');
    if (/^[-–—]$/u.test(input)) return '-';
    if (!/^[+-]?\d+(?:\.\d+)?(?:±\d+(?:\.\d+)?)?$/u.test(input)) return null;
    return input.split('±').map(part => {
        const [integer, decimal = ''] = part.replace(/^\+/u, '').split('.');
        const fraction = decimal.replace(/0+$/u, '');
        return integer.replace(/^(-?)0+(?=\d)/u, '$1') + (fraction ? '.' + fraction : '');
    }).join('±');
}
function declaration(value) {
    const match = /^([A-Za-z][A-Za-z0-9 ._-]{0,63}?)\s*(?:\(\s*(%|dB|ms|s|h|Hz|kHz|MHz|GB|MB|KB|pp)\s*\)|\[\s*(%|dB|ms|s|h|Hz|kHz|MHz|GB|MB|KB|pp)\s*\])$/iu.exec(text(value));
    return match ? { metric: compact(match[1]), unit: (match[2] || match[3]).toLowerCase() } : null;
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
    if (!originalQuotes.length || document?.contract !== 'reader-sealed-pdf-quotes-v1' || !document.available
        || typeof document.rawFullText !== 'string') return null;
    const lines = literalLines(document.rawFullText), candidates = [];
    const captions = lines.map((line, index) => /^Table\s+\d+\s*[:.]/u.test(line.value) ? index : -1).filter(index => index >= 0);
    for (const captionIndex of captions) {
        const next = lines.findIndex((line,index) => index > captionIndex && /^(?:Table\s+\d+\s*[:.]|Figure\s+\d+\s*[:.])/u.test(line.value));
        const limit = next < 0 ? lines.length : next;
        for (let first = captionIndex + 2; first + 2 < limit; first++) {
            if (lines[first].start - lines[captionIndex].start > 6000 || numeric(lines[first].value) !== null) continue;
            let width = 0;
            while (first + 1 + width < limit && numeric(lines[first + 1 + width].value) !== null) width++;
            if (width < 1 || width > 15 || first - width <= captionIndex) continue;
            const headers = lines.slice(first - width, first).map(line => line.value);
            const explicit = headers.map(declaration);
            const caption = lines.slice(captionIndex, first - width).map(line => line.value).join(' ');
            const percentCaption = /^Table\s+\d+\s*[:.]\s*Results\s*\[%\]/u.test(caption);
            const sourceColumns = explicit.every(Boolean) ? explicit
                : percentCaption && headers.every(header => /^[A-Za-z][A-Za-z0-9 ._-]{0,63}$/u.test(header))
                    ? headers.map(metric => ({ metric: compact(metric), unit: '%' })) : null;
            if (!sourceColumns) continue;
            if (new Set(sourceColumns.map(value => value.metric)).size !== sourceColumns.length) {
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
                sourceRows.push({ label: label.value, cells: cells.map(cell => cell.value), end: cells.at(-1).end });
                cursor += width + 1;
            }
            if (sourceRows.length < 2) continue;
            const quote = document.rawFullText.slice(lines[captionIndex].start, sourceRows.at(-1).end).replace(/\s+/gu, ' ').trim();
            if (quote.length < 12 || quote.length > 4000 || document.normalizedFullText.split(quote).length !== 2) continue;
            const rowQuotes = originalQuotes.filter(value => {
                const normalized = value.replace(/\s+/gu, ' ').trim();
                return quote.includes(normalized) && document.normalizedFullText.split(normalized).length === 2;
            });
            const mapped = table.rows.map((row, index) => {
                const matches = sourceRows.map((original, sourceRow) => ({ original, sourceRow }))
                    .filter(({ original }) => compact(original.label) === compact(row[0])
                        && columns.every(column => numeric(row[column.column]) !== null
                            && numeric(row[column.column]) !== '-' && numeric(row[column.column]) === numeric(original.cells[column.sourceColumn])));
                if (matches.length !== 1) {
                    reasons.push(`渲染行名 ${JSON.stringify(row[0])} 与原PDF行名/完整数值没有唯一逐字对应；原行名：`
                        + sourceRows.slice(0,8).map(value => value.label).join(' | ') + '。不要截短方法名或省略括号条件。');
                    return null;
                }
                const { original, sourceRow } = matches[0];
                const numbers = columns.flatMap(column => require('../deep-analyzer').readerNumericTokens(row[column.column]));
                if (!rowQuotes.some(quote => compact(quote).includes(compact(original.label))
                    && hasSequence(require('../deep-analyzer').readerNumericTokens(quote), numbers))) return null;
                return { row: index + 1, sourceRow: sourceRow + 1, rowLabel: original.label,
                    values: columns.map(column => ({ column: column.column, sourceColumn: column.sourceColumn + 1,
                        value: row[column.column], sourceValue: original.cells[column.sourceColumn], unit: column.unit })) };
            });
            if (mapped.some(value => value === null)) continue;
            candidates.push({ quote, columns, rows: mapped });
        }
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
    if (active?.handle === handle && isDeepStrictEqual(active.source.sourceIdentity, source.sourceIdentity)) return callback();
    const state = { handle, source, sourceTextSha256: sha(source.sourceText), cache: new Map(), document: null };
    return require('./reader-pdf-extraction-scope').withPdfExtractionScope(() => scope.run(state, callback));
}
function withoutVerifiedSource(callback) { return scope.run(null, callback); }
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
    const match = matchLiteralTable(table, quotes, active.document, active.source.sourceText, reasons);
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
        columns: match.columns, rows: match.rows, pdfQuoteEvidence: quote.evidence };
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
