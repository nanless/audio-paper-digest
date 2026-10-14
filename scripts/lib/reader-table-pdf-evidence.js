'use strict';
// The existing projection keeps priority and its bytes. Independent PDF-origin
// grids have a distinct binding field and are available only after sealed replay.
const { AsyncLocalStorage } = require('node:async_hooks');
const { isDeepStrictEqual } = require('node:util');
const path = require('node:path');
const legacy = require('./reader-pdf-cell-evidence');
const grid = require('./reader-sealed-pdf-table-evidence');
const saved = new AsyncLocalStorage();
function sealedEvidence(table) {
    if (legacy.evidence(table)) return null;
    const actual = grid.evidence(table);
    if (actual) return actual;
    const context = saved.getStore(), proof = context?.proofs.get(table?.ordinal);
    return context?.artifacts.tables.includes(table) && proof
        && proof.sourceTableDomSha256 === table.sourceDomSha256 ? structuredClone(proof) : null;
}
function evidence(table) { return legacy.evidence(table) || sealedEvidence(table); }
function displayCell(table, row, column) {
    const proof = sealedEvidence(table);
    return proof ? proof.displayMatrix[row]?.[column] : legacy.displayCell(table, row, column);
}
function displayMatrix(table) { return (table?.matrix || []).map((row, r) => row.map((_cell, c) => displayCell(table, r, c))); }
function displayCellMatches(table, row, column, text, normalize = value => value) {
    return sealedEvidence(table) ? normalize(text) === normalize(displayCell(table, row, column))
        : legacy.displayCellMatches(table, row, column, text, normalize);
}
function bindingEvidence(table) {
    const old = legacy.evidence(table), exact = old ? null : sealedEvidence(table);
    return old ? { pdfCellConfirmation: old } : exact ? { sealedPdfTableEvidence: exact } : {};
}
function withArtifacts(artifacts, paperId, callback) {
    return legacy.withArtifacts(artifacts, paperId, () => {
        const needsGrid = Array.isArray(artifacts?.tables) && artifacts.tables.some(table => !legacy.evidence(table)
            && !require('./reader-tables').assessReaderCompleteTableEligibility(table).eligible);
        const actualPaperId = paperId || artifacts?.paperId || require('./fresh-analysis-context').getFreshAnalysisContext()?.paperId;
        const canonical = /^(?:arxiv:)?\d{4}\.\d{4,5}(?:v[1-9]\d*)?$/.test(String(actualPaperId || ''));
        return needsGrid && canonical ? grid.withArtifacts(artifacts, actualPaperId, callback) : callback();
    });
}
function withSavedPaper(paper, callback) {
    const bindings = paper?.apiReaderPlan?.tableBindings || [];
    if (!bindings.some(binding => binding.sealedPdfTableEvidence !== undefined)) return legacy.withSavedPaper(paper, callback);
    const provenance = paper.freshRewriteProvenance, acquisition = paper.analysisManifest?.sourceAcquisition;
    if (!provenance || !isDeepStrictEqual(provenance, paper.analysisManifest?.freshRewriteProvenance)
        || provenance.contract !== 'fresh-source-analysis-v1'
        || !/^[a-f0-9-]{36}$/.test(provenance.runId || '')) throw new Error('Sealed PDF grid lacks the actual daily source provenance');
    const fresh = require('./fresh-analysis-context'), Config = require('../config');
    const runDir = path.join(Config.FILES.dailyFreshSourceRunsDir, provenance.runId);
    const run = require('./reader-proof-read-scope').readReaderProofJson(path.join(runDir, 'run.json')).value;
    if (run.contract !== fresh.DAILY_SOURCE_RUN_CONTRACT) throw new Error('Sealed PDF grid run contract differs');
    const source = fresh.readFreshSource(runDir, paper, { runId: run.runId, sourceExpectations: run.sourceExpectations });
    const descriptor = source.freshSourceDescriptor;
    if (source.source !== 'html' || paper.sourceSha256 !== descriptor.sourceSha256
        || acquisition?.sourceSha256 !== descriptor.sourceSha256
        || acquisition.structuredArtifactsSha256 !== descriptor.structuredArtifactsSha256
        || ['runId', 'sourceSha256', 'structuredArtifactsSha256', 'sourceSnapshotSha256', 'sourceGeneration', 'sourceManifestSha256']
            .some(key => provenance[key] !== descriptor[key])
        || paper.apiReaderPlan.structuredSourcePayload !== require('../deep-analyzer').readerStructuredSourcePayload(source.structuredArtifacts))
        throw new Error('Sealed PDF grid saved HTML payload or four-source descriptor differs');
    const results = grid.deriveBundle({ rootDir: path.join(runDir, 'sources'), arxivId: descriptor.paperId,
        generation: descriptor.sourceGeneration, sourceManifestSha256: descriptor.sourceManifestSha256,
        sourceSnapshotSha256: descriptor.sourceSnapshotSha256 });
    const proofs = new Map(results.filter(result => result.eligible).map(result => [result.sourceTableOrdinal, result.evidence]));
    for (const binding of bindings.filter(binding => binding.sealedPdfTableEvidence !== undefined)) {
        const candidates = source.structuredArtifacts.tables.filter(table => table.ordinal === binding.sourceTableOrdinal);
        const table = candidates[0], proof = proofs.get(binding.sourceTableOrdinal);
        const seen = new Set();
        const completeCells = table && Array.isArray(binding.cellBindings) && binding.cellBindings.every(cell => {
            const key = `${cell.sourceRow}:${cell.sourceColumn}`;
            const original = table.cells.filter(value => value.row === cell.sourceRow && value.column === cell.sourceColumn);
            if (!Number.isSafeInteger(cell.sourceRow) || !Number.isSafeInteger(cell.sourceColumn)
                || cell.sourceRow < 0 || cell.sourceRow >= table.matrix.length
                || cell.sourceColumn < 0 || cell.sourceColumn >= table.matrix[0].length
                || seen.has(key) || original.length !== 1 || original[0].text !== cell.sourceText
                || original[0].sourceDomSha256 !== cell.sourceDomSha256) return false;
            seen.add(key); return cell.renderedRow === cell.sourceRow && cell.renderedColumn === cell.sourceColumn;
        });
        if (binding.sourceType !== 'artifact_table' || binding.pdfCellConfirmation !== undefined || candidates.length !== 1 || !proof
            || !isDeepStrictEqual(proof, binding.sealedPdfTableEvidence) || binding.sourceTableDomSha256 !== table.sourceDomSha256
            || !Array.isArray(binding.cellBindings) || binding.cellBindings.length !== table.matrix.length * table.matrix[0].length
            || !completeCells || seen.size !== table.matrix.length * table.matrix[0].length)
            throw new Error('Sealed PDF grid must replay the exact complete table, source and PDF-origin proof');
    }
    return saved.run({ artifacts: source.structuredArtifacts, proofs }, () => legacy.withSavedPaper(paper, callback));
}
function savedCellMatches(binding, cell, displayed) {
    if (!binding?.sealedPdfTableEvidence) return legacy.savedCellMatches(binding, cell, displayed);
    const context = saved.getStore(), proof = context?.proofs.get(binding.sourceTableOrdinal);
    if (!proof || binding.pdfCellConfirmation !== undefined || !isDeepStrictEqual(proof, binding.sealedPdfTableEvidence)) return false;
    const tables = context.artifacts.tables.filter(table => table.ordinal === binding.sourceTableOrdinal);
    if (tables.length !== 1) return false;
    const originals = tables[0].cells.filter(item => item.row === cell.sourceRow && item.column === cell.sourceColumn);
    return originals.length === 1 && originals[0].sourceDomSha256 === cell.sourceDomSha256 && originals[0].text === cell.sourceText
        && cell.sourceRow === cell.renderedRow && cell.sourceColumn === cell.renderedColumn
        && require('../deep-analyzer').normalizeReaderSourceCell(displayed)
            === require('../deep-analyzer').normalizeReaderSourceCell(proof.displayMatrix[cell.sourceRow]?.[cell.sourceColumn]);
}
function appendSourceOriginNotes(article, bindings) {
    const lines = String(article).split('\n'), tables = require('../analysis-contract').extractMarkdownTables(article);
    const note = '本表数值与单位依据论文 PDF。';
    for (const binding of bindings.filter(binding => binding.sealedPdfTableEvidence
        || (Array.isArray(binding.sealedPdfQuoteEvidence) && binding.sealedPdfQuoteEvidence.length)).reverse()) {
        const table = tables[binding.tableIndex - 1];
        if (!table) throw new Error('PDF-origin table note cannot locate its complete displayed table');
        let start = table.endLine + 1;
        while (start < lines.length && !lines[start].trim()) start++;
        if (start >= lines.length || /^(?:###|\|)/.test(lines[start].trim())) continue;
        let end = start;
        while (end < lines.length && lines[end].trim() && !/^(?:###|\|)/.test(lines[end].trim())) end++;
        const after = lines.slice(table.endLine + 1).join('\n').split(/\n\s*\n/).map(value => value.trim()).filter(Boolean);
        const explanation = [];
        for (const paragraph of after.slice(0, 3)) { if (/^(?:###|\|)/.test(paragraph)) break; explanation.push(paragraph); }
        // The note cannot make an insufficient model explanation pass.
        if ((explanation.join('\n\n').match(/[\u3400-\u9fff]/g) || []).length < 25) continue;
        if (!lines.slice(start, end).join('\n').includes(note)) lines[end - 1] += note;
    }
    return lines.join('\n');
}
module.exports = { evidence, sealedEvidence, bindingEvidence, displayCell, displayMatrix, displayCellMatches,
    withArtifacts, withSavedPaper, savedCellMatches, appendSourceOriginNotes };
