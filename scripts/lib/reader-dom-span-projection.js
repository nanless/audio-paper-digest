'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { isDeepStrictEqual } = require('node:util');
const path = require('node:path');
const scope = new AsyncLocalStorage();
function withSavedPaper(paper, callback) { return scope.run({ paper, loaded: false, artifacts: null }, callback); }
function sealedArtifacts(paper) {
    const current = scope.getStore();
    if (!current || current.paper !== paper) return null;
    if (current.loaded) return current.artifacts;
    current.loaded = true;
    try {
        const fresh = require('./fresh-analysis-context');
        let source = require('./model-text-sanitization').currentModelInputSource(paper);
        const provenance = paper.freshRewriteProvenance;
        if (!provenance || !isDeepStrictEqual(provenance, paper.analysisManifest?.freshRewriteProvenance)) return null;
        if (!source) {
            const Config = require('../config');
            if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(provenance.runId || '')) return null;
            const runDir = path.join(Config.FILES.dailyFreshSourceRunsDir, provenance.runId);
            const run = require('./reader-proof-read-scope').readReaderProofJson(path.join(runDir, 'run.json')).value;
            if (run.contract !== fresh.DAILY_SOURCE_RUN_CONTRACT) return null;
            source = fresh.readFreshSource(runDir, paper, { runId: run.runId, sourceExpectations: run.sourceExpectations });
        }
        const descriptor = source?.freshSourceDescriptor, acquisition = paper.analysisManifest?.sourceAcquisition;
        if (!descriptor || source.source !== 'html' || !source.structuredArtifacts || paper.sourceSha256 !== descriptor.sourceSha256
            || acquisition?.sourceSha256 !== descriptor.sourceSha256
            || acquisition.structuredArtifactsSha256 !== descriptor.structuredArtifactsSha256
            || source.structuredArtifacts.flattenedTextSha256 !== descriptor.sourceSha256
            || ['runId', 'sourceSha256', 'structuredArtifactsSha256', 'sourceSnapshotSha256', 'sourceGeneration', 'sourceManifestSha256']
                .some(key => provenance[key] !== descriptor[key])) return null;
        current.artifacts = source.structuredArtifacts;
        return current.artifacts;
    } catch (_) { return null; }
}
function fullWidthLabelBlankMatches(table, binding, cell, displayed, renderedTable) {
    const projection = require('./reader-pdf-cell-evidence');
    const normalize = require('./reader-source-display').normalizeReaderSourceDisplayArtifacts;
    const width = table?.matrix?.[0]?.length;
    if (displayed !== '' || cell?.renderedText !== '' || binding?.pdfCellConfirmation
        || !Number.isSafeInteger(cell?.sourceRow) || cell.sourceRow < 0
        || !Number.isSafeInteger(cell?.sourceColumn) || cell.sourceColumn <= 0
        || !Number.isSafeInteger(cell?.renderedRow) || !Number.isSafeInteger(cell?.renderedColumn)
        || cell.sourceColumn >= width
        || binding?.sourceTableDomSha256 !== table?.sourceDomSha256
        || !projection.fullWidthLabelRow(table, cell.sourceRow)) return false;
    const original = table.cells.find(value => value.row === cell.sourceRow);
    if (original.text !== cell.sourceText || original.sourceDomSha256 !== cell.sourceDomSha256
        || projection.displayCell(table, cell.sourceRow, cell.sourceColumn) !== '') return false;
    const matchingCells = (binding.cellBindings || []).filter(value => value.renderedRow === cell.renderedRow
        && value.renderedColumn === cell.renderedColumn && value.sourceRow === cell.sourceRow
        && value.sourceColumn === cell.sourceColumn && value.sourceDomSha256 === cell.sourceDomSha256);
    if (matchingCells.length !== 1) return false;
    const rows = [renderedTable?.header, ...(renderedTable?.rows || [])], row = rows[cell.renderedRow];
    if (!Array.isArray(row) || row.length < 2 || row.length > width || row[0] !== normalize(original.text)
        || row.slice(1).some(value => value !== '')) return false;
    // 选择表可以取原表部分列或将分组行放在首行；由整张逐格绑定派生同一行列投影，
    // 不允许只凭某个空白格放行重复坐标、缺格或其它数值的删除。
    const selectedColumns = [], selectedRows = [], seen = new Set();
    if (!Array.isArray(binding.cellBindings) || binding.cellBindings.length !== rows.length * row.length
        || rows.some(values => !Array.isArray(values) || values.length !== row.length)) return false;
    for (const value of binding.cellBindings) {
        if (!Number.isSafeInteger(value.renderedRow) || value.renderedRow < 0 || value.renderedRow >= rows.length
            || !Number.isSafeInteger(value.renderedColumn) || value.renderedColumn < 0 || value.renderedColumn >= row.length
            || !Number.isSafeInteger(value.sourceRow) || value.sourceRow < 0 || value.sourceRow >= table.matrix.length
            || !Number.isSafeInteger(value.sourceColumn) || value.sourceColumn < 0 || value.sourceColumn >= width) return false;
        const key = `${value.renderedRow}:${value.renderedColumn}`;
        if (seen.has(key)) return false;
        seen.add(key);
        if (selectedRows[value.renderedRow] !== undefined && selectedRows[value.renderedRow] !== value.sourceRow
            || selectedColumns[value.renderedColumn] !== undefined && selectedColumns[value.renderedColumn] !== value.sourceColumn) return false;
        selectedRows[value.renderedRow] = value.sourceRow;
        selectedColumns[value.renderedColumn] = value.sourceColumn;
        const sources = table.cells.filter(source => value.sourceRow >= source.row
            && value.sourceRow < source.row + Number(source.rowspan || 1)
            && value.sourceColumn >= source.column && value.sourceColumn < source.column + Number(source.colspan || 1));
        const displayedValue = rows[value.renderedRow][value.renderedColumn];
        if (sources.length !== 1 || sources[0].text !== value.sourceText
            || sources[0].sourceDomSha256 !== value.sourceDomSha256
            || normalize(value.renderedText) !== normalize(displayedValue)
            || !projection.displayCellMatches(table, value.sourceRow, value.sourceColumn, displayedValue, normalize)) return false;
    }
    return selectedColumns[0] === 0 && new Set(selectedColumns).size === row.length
        && new Set(selectedRows).size === rows.length;
}
function savedCellMatches(paper, binding, cell, displayed, renderedTable) {
    if (!paper?.apiReaderPlan || typeof paper.apiReaderPlan !== 'object') return false;
    const planHash = require('../deep-analyzer').stableFingerprint(paper?.apiReaderPlan);
    if (paper?.apiReaderPlanSha256 !== planHash
        || paper?.analysisManifest?.stages?.apiReaderArticle?.planSha256 !== planHash) return false;
    const artifacts = sealedArtifacts(paper);
    const tables = (artifacts?.tables || []).filter(table => table.ordinal === binding?.sourceTableOrdinal
        && table.sourceDomSha256 === binding?.sourceTableDomSha256);
    return tables.length === 1 && fullWidthLabelBlankMatches(tables[0], binding, cell, displayed, renderedTable);
}
module.exports = { withSavedPaper, fullWidthLabelBlankMatches, savedCellMatches };
