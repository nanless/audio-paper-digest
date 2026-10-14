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
        || cell.renderedColumn !== cell.sourceColumn || cell.sourceColumn >= width
        || binding?.sourceTableDomSha256 !== table?.sourceDomSha256
        || !projection.fullWidthLabelRow(table, cell.sourceRow)) return false;
    const original = table.cells.find(value => value.row === cell.sourceRow);
    if (original.text !== cell.sourceText || original.sourceDomSha256 !== cell.sourceDomSha256
        || projection.displayCell(table, cell.sourceRow, cell.sourceColumn) !== '') return false;
    const rows = [renderedTable?.header, ...(renderedTable?.rows || [])], row = rows[cell.renderedRow];
    if (!Array.isArray(row) || row.length !== width || row[0] !== normalize(original.text)
        || row.slice(1).some(value => value !== '')) return false;
    const bindings = (binding.cellBindings || []).filter(value => value.renderedRow === cell.renderedRow);
    return bindings.length === width && bindings.every((value, index) => value.renderedColumn === index
        && value.sourceRow === cell.sourceRow && value.sourceColumn === index
        && value.sourceDomSha256 === original.sourceDomSha256 && value.sourceText === original.text
        && value.renderedText === row[index]);
}
function savedCellMatches(paper, binding, cell, displayed, renderedTable) {
    const artifacts = sealedArtifacts(paper);
    const tables = (artifacts?.tables || []).filter(table => table.ordinal === binding?.sourceTableOrdinal
        && table.sourceDomSha256 === binding?.sourceTableDomSha256);
    return tables.length === 1 && fullWidthLabelBlankMatches(tables[0], binding, cell, displayed, renderedTable);
}
module.exports = { withSavedPaper, fullWidthLabelBlankMatches, savedCellMatches };
