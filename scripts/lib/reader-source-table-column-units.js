'use strict';
// Bare numeric units require source-bound original DOM columns and unique paths.
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
// This separate branch proves a merged DOM grid in full before selecting any
// column. Caption units never apply without the literal metric/header path.
function captionText(value) {
    return text(value).replace(/\(ρ×(\d+(?:\.\d+)?)\\rho\\times\s*\1\)/g,
        (_whole, number) => `(\\rho\\times ${number})`);
}
function sourceSpanGrid(table) {
    const matrix = table?.matrix, cells = table?.cells;
    if (table?.recoveryStatus !== 'complete' || !Number.isSafeInteger(table.ordinal) || table.ordinal < 1
        || !/^[a-f0-9]{64}$/.test(table.sourceDomSha256 || '') || !Array.isArray(matrix)
        || matrix.length < 3 || matrix.length > 65 || !Array.isArray(matrix[0])
        || matrix[0].length < 3 || matrix[0].length > 16 || !Array.isArray(cells) || cells.length > matrix.length * matrix[0].length
        || matrix.some(row => !Array.isArray(row) || row.length !== matrix[0].length || row.some(v => typeof v !== 'string'))) return null;
    const grid = matrix.map(row => row.map(() => null));
    for (const cell of cells) {
        if (!cell || !['row','column','rowspan','colspan'].every(key => Number.isSafeInteger(cell[key]))
            || cell.row < 0 || cell.column < 0 || cell.rowspan < 1 || cell.colspan < 1
            || cell.row + cell.rowspan > matrix.length || cell.column + cell.colspan > matrix[0].length
            || typeof cell.text !== 'string' || !/^[a-f0-9]{64}$/.test(cell.sourceDomSha256 || '')) return null;
        for (let r = cell.row; r < cell.row + cell.rowspan; r++) for (let c = cell.column; c < cell.column + cell.colspan; c++) {
            if (grid[r][c] || matrix[r][c] !== cell.text) return null;
            grid[r][c] = cell;
        }
    }
    if (grid.some(row => row.some(cell => !cell))) return null;
    return grid;
}
function mergedGrid(table) {
    const grid = sourceSpanGrid(table);
    if (!grid) return null;
    const cells = table.cells, first = grid[0][0], height = first.rowspan;
    if (first.row !== 0 || first.column !== 0 || first.colspan !== 1 || first.header !== true || text(first.text) !== 'Method'
        || height < 2 || height > 4 || height >= grid.length) return null;
    if (cells.some(cell => cell.row < height && cell.row + cell.rowspan > height)) return null;
    const paths = grid[0].map((_value, column) => [...new Set(grid.slice(0,height).map(row => row[column]))]);
    return { grid, height, paths };
}

// A body condition band owns the whole physical row. It cannot provide a
// metric/unit, hide a partial span, or disambiguate repeated method names by
// their result values. The original grid and every owning cell remain bound.
function fullWidthBodyBands(table) {
    const grid = sourceSpanGrid(table);
    if (!grid || grid[0].some(cell => cell.row !== 0 || cell.rowspan !== 1 || cell.colspan !== 1)) return null;
    const width = grid[0].length, bands = [];
    for (let row = 1; row < grid.length; row++) {
        const cells = [...new Set(grid[row])];
        if (cells.length === 1 && cells[0].row === row && cells[0].column === 0
            && cells[0].rowspan === 1 && cells[0].colspan === width && text(cells[0].text)) {
            // A trailing/adjacent band has no data scope and is not a complete
            // condition group. Ordinary rows must be physically 1 x 1 below it.
            if (row + 1 >= grid.length || new Set(grid[row + 1]).size === 1) return null;
            bands.push(cells[0]);
        } else if (cells.length !== width || cells.some((cell, column) => cell.row !== row
            || cell.column !== column || cell.rowspan !== 1 || cell.colspan !== 1)) return null;
    }
    return bands.length ? { grid, bands } : null;
}
// An explicit Accuracy (%) parent applies only to its exact split leaf and
// Model+Optimizer row. This does not infer percentages from result magnitudes.
function mergedHeaderPercentCoverage(rendered, quotes, tables) {
    const headers = rendered?.header || [], rows = rendered?.rows || [], result = [];
    if (headers.length < 3 || !rows.length || rows.some(row => !Array.isArray(row) || row.length !== headers.length)
        || !['Model', '模型'].includes(text(headers[0]))
        || !['Optimizer', '优化器'].includes(text(headers[1]))) return result;
    const quoteStrings = (quotes || []).filter(value => typeof value === 'string').map(text);
    const leafName = value => compact(text(value).replace(/^Δ\\Delta(?=\s|$)/, 'Δ'));
    const rowName = (value, markdown = false) => {
        let raw = display(String(value ?? '')).normalize('NFKC').replace(/\s+/g, ' ').trim();
        if (markdown) for (const wrapper of ['**', '__', '`', '*', '_']) {
            if (raw.length > wrapper.length * 2 && raw.startsWith(wrapper) && raw.endsWith(wrapper)) {
                raw = raw.slice(wrapper.length, -wrapper.length).trim(); break;
            }
        }
        return raw;
    };
    for (let column = 2; column < headers.length; column++) {
        const match = /^(.+?)\s+Accuracy\s*\(%\)$/.exec(text(headers[column]));
        if (!match || headers.filter(value => compact(value) === compact(headers[column])).length !== 1) continue;
        const candidates = [];
        for (const table of tables || []) {
            const grid = sourceSpanGrid(table), caption = text(table?.caption || '').split(/(?<=\.)\s/)[0];
            if (!grid || grid.length < 3 || grid[0].length < 3 || caption.length < 24
                || !quoteStrings.some(quote => quote.includes(caption))) continue;
            const model = grid[0][0], optimizer = grid[0][1], parent = grid[0][2];
            if (model.row !== 0 || model.column !== 0 || model.rowspan !== 2 || model.colspan !== 1 || model.header !== true
                || text(model.text) !== 'Model' || optimizer.row !== 0 || optimizer.column !== 1
                || optimizer.rowspan !== 2 || optimizer.colspan !== 1 || optimizer.header !== true
                || text(optimizer.text) !== 'Optimizer' || parent.row !== 0 || parent.column !== 2
                || parent.rowspan !== 1 || parent.colspan !== grid[0].length - 2 || parent.header !== true
                || text(parent.text) !== 'Accuracy (%)' || grid[0].slice(2).some(cell => cell !== parent)) continue;
            const leaves = grid[1].slice(2);
            if (leaves.some((cell, index) => cell.row !== 1 || cell.column !== index + 2 || cell.rowspan !== 1
                || cell.colspan !== 1 || cell.header !== true || !text(cell.text))) continue;
            // Bind the complete rendered header to one DOM table before any
            // per-column proof. Separate tables cannot donate split leaves.
            if (headers.length !== grid[0].length || headers.slice(2).some((header, index) => {
                const wanted = leafName(text(header).replace(/\s+Accuracy\s*\(%\)$/, ''));
                return leafName(leaves[index].text) !== wanted
                    || leaves.filter(cell => leafName(cell.text) === wanted).length !== 1;
            })) continue;
            if (rows.some(values => !rowName(values[0], true) || !rowName(values[1], true)
                || grid.slice(2).filter(cells => rowName(cells[0].text) === rowName(values[0], true)
                    && rowName(cells[1].text) === rowName(values[1], true)).length !== 1)) continue;
            const matching = leaves.filter(cell => compact(cell.text) === compact(match[1]));
            if (matching.length !== 1) continue;
            candidates.push({ table, grid, leaf: matching[0], parent });
        }
        if (candidates.length !== 1) continue;
        const { table, grid, leaf, parent } = candidates[0];
        const sourceRows = grid.slice(2).map((cells, index) => ({ cells, sourceRow: index + 2 }));
        for (const [row, values] of rows.entries()) {
            const numbers = numericCell(values[column]);
            if (!numbers || !rowName(values[0], true) || !rowName(values[1], true)) continue;
            const matching = sourceRows.filter(({ cells }) => rowName(cells[0].text) === rowName(values[0], true)
                && rowName(cells[1].text) === rowName(values[1], true));
            if (matching.length !== 1) continue;
            const { cells, sourceRow } = matching[0], model = cells[0], optimizer = cells[1], cell = cells[leaf.column];
            const originalNumbers = numericCell(cell.text);
            if (model.column !== 0 || model.colspan !== 1 || optimizer.row !== sourceRow || optimizer.column !== 1
                || optimizer.rowspan !== 1 || optimizer.colspan !== 1 || cell.row !== sourceRow
                || cell.column !== leaf.column || cell.rowspan !== 1 || cell.colspan !== 1
                || !originalNumbers || JSON.stringify(originalNumbers) !== JSON.stringify(numbers)) continue;
            for (const value of numbers) result.push({ row: row + 1, column, value, unit: '%',
                sourceTableOrdinal: table.ordinal, sourceRow, sourceColumn: leaf.column,
                sourceTableDomSha256: table.sourceDomSha256, sourceCellDomSha256: cell.sourceDomSha256,
                headerCellDomSha256: leaf.sourceDomSha256,
                headerPathCellDomSha256: [parent.sourceDomSha256, leaf.sourceDomSha256],
                sourceRowIdentityCellDomSha256: [model.sourceDomSha256, optimizer.sourceDomSha256] });
        }
    }
    return result;
}
function mergedCaptionPercentCoverage(rendered, quotes, tables) {
    const headers = rendered?.header || [], rows = rendered?.rows || [], result = [];
    if (headers.length < 2 || !rows.length || rows.some(row => !Array.isArray(row) || row.length !== headers.length)) return result;
    const quoteStrings = (quotes || []).filter(value => typeof value === 'string').map(captionText);
    for (let column = 1; column < headers.length; column++) {
        const match = /^(.+?)\s*\(%\)$/.exec(text(headers[column]).replace(/[↑↓]/g,''));
        if (!match || headers.filter(value => compact(value) === compact(headers[column])).length !== 1) continue;
        const wanted = compact(match[1]), candidates = [];
        for (const table of tables || []) {
            const expanded = mergedGrid(table), caption = captionText(table?.caption || '');
            if (!expanded || caption.length < 24 || !quoteStrings.some(quote => quote.includes(caption))
                || compact(headers[0]) !== compact(expanded.grid[0][0].text)) continue;
            const declarations = [...caption.matchAll(/\(([A-Za-z][A-Za-z0-9 ._-]{0,63}?),\s*([^()]{1,16})\)/g)]
                .map(value => ({ metric:compact(value[1].replace(/\.$/,'')), unit:value[2].trim() }));
            for (let sourceColumn = 1; sourceColumn < expanded.paths.length; sourceColumn++) {
                const path = expanded.paths[sourceColumn], leaf = path.at(-1);
                if (path.length < 2 || leaf.row !== expanded.height - 1 || leaf.rowspan !== 1 || leaf.colspan !== 1
                    || path.some(cell => !text(cell.text)) || path.map(cell => compact(cell.text)).join('') !== wanted) continue;
                const metric = compact(leaf.text), declaration = declarations.filter(value => value.metric === metric);
                if (declaration.length !== 1 || declaration[0].unit !== '%'
                    || expanded.paths.filter(p => p.map(cell => compact(cell.text)).join('') === wanted).length !== 1) continue;
                candidates.push({ table, expanded, sourceColumn, leaf, path });
            }
        }
        if (candidates.length !== 1) continue;
        const { table, expanded, sourceColumn, leaf, path } = candidates[0];
        for (let row = 0; row < rows.length; row++) {
            const rowName = text(rows[row][0]), values = numericCell(rows[row][column]);
            if (!rowName || !values) continue;
            const matches = expanded.grid.slice(expanded.height).map((cells,index) => ({cells,sourceRow:index+expanded.height}))
                .filter(item => text(item.cells[0].text) === rowName);
            if (matches.length !== 1) continue;
            const {cells,sourceRow} = matches[0], label = cells[0], cell = cells[sourceColumn];
            if ([label,cell].some(value => value.row !== sourceRow || value.rowspan !== 1 || value.colspan !== 1)
                || cell.column !== sourceColumn || compact(cell.text) !== compact(rows[row][column])) continue;
            for (const value of values) result.push({row:row+1,column,value,unit:'%',sourceTableOrdinal:table.ordinal,
                sourceRow,sourceColumn,rowName,sourceTableDomSha256:table.sourceDomSha256,
                headerCellDomSha256:leaf.sourceDomSha256,headerPathCellDomSha256:path.map(value => value.sourceDomSha256),
                sourceCellDomSha256:cell.sourceDomSha256});
        }
    }
    return result;
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
                || table.cells.some(cell => !/^[a-f0-9]{64}$/.test(cell.sourceDomSha256 || ''))
                || (table.cells.some(cell => cell.rowspan !== 1 || cell.colspan !== 1) && !fullWidthBodyBands(table))
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
                headerCellDomSha256:headerCell[0].sourceDomSha256,sourceCellDomSha256:cells.find(cell=>cell.column===column).sourceDomSha256,
                ...(source.cells.some(cell => cell.colspan !== 1) ? { bodyBandDomSha256s:
                    fullWidthBodyBands(source).bands.map(cell => cell.sourceDomSha256) } : {})});
        }
    }
    return [...result, ...mergedCaptionPercentCoverage(rendered, quotes, tables),
        ...mergedHeaderPercentCoverage(rendered, quotes, tables)];
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
