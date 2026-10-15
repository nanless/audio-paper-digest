'use strict';
// Bare numeric units may inherit only from a unique, literal, flat DOM column.
const savedScope = new (require('node:async_hooks').AsyncLocalStorage)();
const { normalizeReaderSourceDisplayArtifacts: display } = require('./reader-source-display');
const text = value => display(String(value ?? '')).normalize('NFKC').replace(/[*_`]/g,'').replace(/\s+/g,' ').trim();
const compact = value => text(value).replace(/\s+/g,'');
const decimal = value => {
    let [integer, fraction = ''] = value.replace(/^\+/, '').split('.');
    const negative = integer.startsWith('-'); integer = integer.replace(/^-/, '').replace(/^0+(?=\d)/, '');
    fraction = fraction.replace(/0+$/, '');
    return (negative && (integer !== '0' || fraction) ? '-' : '') + integer + (fraction ? '.' + fraction : '');
};
function numericCell(value) {
    const match = /^([+-]?\d+(?:\.\d+)?)(?:±(\d+(?:\.\d+)?))?$/.exec(compact(value));
    return match ? [decimal(match[1]), ...(match[2] === undefined ? [] : [decimal(match[2])])] : null;
}
function coverageFromTables(rendered, quotes, tables) {
    const quoteStrings = (quotes || []).filter(item => typeof item === 'string').map(text);
    const headers = rendered?.header || [], rows = rendered?.rows || [], result = [];
    if (headers.length < 2 || !rows.length || rows.some(row => !Array.isArray(row) || row.length !== headers.length)) return [];
    for (let column = 1; column < headers.length; column++) {
        const header = compact(headers[column]).replace(/[↑↓]/g, '');
        if (!/^[A-Za-z][A-Za-z0-9 ._-]*\(%\)$/.test(header)) continue;
        const candidates = (tables || []).filter(table => {
            if (table.recoveryStatus !== 'complete' || !/^[a-f0-9]{64}$/.test(table.sourceDomSha256 || '')
                || !Array.isArray(table.matrix) || table.matrix.length < 2 || !Array.isArray(table.cells)
                || table.cells.some(cell => cell.rowspan !== 1 || cell.colspan !== 1 || !/^[a-f0-9]{64}$/.test(cell.sourceDomSha256 || ''))
                || table.matrix.some(row => !Array.isArray(row) || row.length !== headers.length)) return false;
            const caption = text(table.caption).split(/(?<=\.)\s/)[0];
            if (caption.length < 24 || !quoteStrings.some(quote => quote.includes(caption))) return false;
            return compact(table.matrix[0][0]) === compact(headers[0])
                && compact(table.matrix[0][column]) === compact(headers[column]);
        });
        if (candidates.length !== 1) continue;
        const source = candidates[0];
        if (source.matrix[0].filter(value => compact(value).replace(/[↑↓]/g,'') === header).length !== 1) continue;
        const headerCell = source.cells.filter(cell => cell.row === 0 && cell.column === column);
        if (headerCell.length !== 1 || compact(headerCell[0].text) !== compact(source.matrix[0][column])) continue;
        for (let row = 0; row < rows.length; row++) {
            const rowName = compact(rows[row][0]), renderedValues = numericCell(rows[row][column]);
            if (!rowName || !renderedValues) continue;
            const matches = source.matrix.slice(1).map((values,index) => ({values,sourceRow:index+1})).filter(item => compact(item.values[0]) === rowName);
            if (matches.length !== 1) continue;
            const item = matches[0], sourceValues = numericCell(item.values[column]);
            if (!sourceValues || JSON.stringify(sourceValues) !== JSON.stringify(renderedValues)) continue;
            const cells = source.cells.filter(cell => cell.row === item.sourceRow && (cell.column === 0 || cell.column === column));
            if (cells.length !== 2 || cells.some(cell => compact(cell.text) !== compact(item.values[cell.column]))) continue;
            for (const value of renderedValues) result.push({row:row+1,column,value,unit:'%',sourceTableOrdinal:source.ordinal,
                sourceRow:item.sourceRow,sourceColumn:column,rowName:text(item.values[0]),sourceTableDomSha256:source.sourceDomSha256,
                headerCellDomSha256:headerCell[0].sourceDomSha256,sourceCellDomSha256:cells.find(cell=>cell.column===column).sourceDomSha256});
        }
    }
    return result;
}
function coverage(rendered, quotes) {
    const context = savedScope.getStore() || require('./reader-sealed-pdf-quote-evidence').verifiedSourceContext();
    if (!context) return [];
    const strings = (quotes || []).flatMap(item => {
        const quote = typeof item === 'string' ? item : item?.quote;
        if (typeof quote !== 'string' || (typeof item !== 'string' && (typeof context.sourceText !== 'string' || !context.sourceText.includes(quote)
            || item.sourceQuoteSha256 !== require('node:crypto').createHash('sha256').update(quote).digest('hex')))
            || (context.sourceText !== undefined && !context.sourceText.includes(quote))) return [];
        return [quote];
    });
    return coverageFromTables(rendered, strings, context.artifacts.tables).map(item => ({...item,
        sourceManifestSha256:context.expectation.sourceManifestSha256,sourceSnapshotSha256:context.expectation.sourceSnapshotSha256}));
}

// Saved HTML-only quote tables must replay the same four-source capability.
// The cheap guard runs first; already-supported/no-unit tables read no source.
function withSavedPaper(paper, callback) {
    const active = savedScope.getStore();
    if (active?.paper === paper) return callback();
    const deep = require('../deep-analyzer'), plan = paper?.apiReaderPlan;
    if (!plan || typeof paper.apiReaderArticle !== 'string' || !Array.isArray(plan.tableBindings)) return callback();
    const tables = require('../analysis-contract').extractMarkdownTables(paper.apiReaderArticle);
    const possible = plan.tableBindings.some((binding,index) => binding.sourceType === 'source_quotes' && tables[index]
        && deep.readerTableHeaderUnitEvidenceFailures(tables[index], [...(binding.sourceQuotes || []), ...(binding.sealedPdfQuoteEvidence || [])])
            .some(issue => issue.unit === '%'));
    if (!possible) return callback();
    const fresh = require('./fresh-analysis-context'), provenance = paper.freshRewriteProvenance;
    if (provenance?.contract !== 'fresh-source-analysis-v1' || !/^[a-f0-9-]{36}$/.test(provenance.runId || '')) return callback();
    const runDir = require('node:path').join(require('../config').FILES.dailyFreshSourceRunsDir,provenance.runId);
    const runFile = require('node:path').join(runDir,'run.json');
    if (!require('node:fs').existsSync(runFile)) return callback();
    const run = require('./reader-proof-read-scope').readReaderProofJson(runFile).value;
    if (run.contract !== fresh.DAILY_SOURCE_RUN_CONTRACT || run.runId !== provenance.runId) return callback();
    if (!require('node:util').isDeepStrictEqual(provenance,paper.analysisManifest?.freshRewriteProvenance)) throw new Error('DOM column saved provenance differs');
    const source = fresh.readFreshSource(runDir,paper,{runId:run.runId,sourceExpectations:run.sourceExpectations});
    const d=source.freshSourceDescriptor, acquisition=paper.analysisManifest?.sourceAcquisition, stage=paper.analysisManifest?.stages?.apiReaderArticle;
    if (paper.sourceSha256 !== d.sourceSha256 || acquisition?.sourceSha256 !== d.sourceSha256
        || acquisition.structuredArtifactsSha256 !== d.structuredArtifactsSha256
        || stage?.structuredArtifactsSha256 !== d.structuredArtifactsSha256 || stage.sourceBindingsSourceTextSha256 !== d.sourceSha256
        || ['runId','sourceSha256','structuredArtifactsSha256','sourceSnapshotSha256','sourceGeneration','sourceManifestSha256'].some(key=>provenance[key]!==d[key])
        || plan.structuredSourcePayload !== deep.readerStructuredSourcePayload(source.structuredArtifacts)) throw new Error('DOM column saved source or payload differs');
    const context={paper,artifacts:source.structuredArtifacts,sourceText:source.text,
        expectation:{sourceManifestSha256:d.sourceManifestSha256,sourceSnapshotSha256:d.sourceSnapshotSha256}};
    return savedScope.run(context,callback);
}

module.exports = { coverage, coverageFromTables, withSavedPaper };
