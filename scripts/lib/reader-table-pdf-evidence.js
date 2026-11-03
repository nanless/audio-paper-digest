'use strict';
// The existing projection keeps priority and its bytes. Independent PDF-origin
// grids have a distinct binding field and are available only after sealed replay.
const { isFreshSourceProvenance } = require('./daily-source-format');
const { AsyncLocalStorage } = require('node:async_hooks');
const { isDeepStrictEqual } = require('node:util');
const path = require('node:path');
const legacy = require('./reader-pdf-cell-evidence');
const grid = require('./reader-sealed-pdf-table-evidence');
const saved = new AsyncLocalStorage();
const proofFormat = require('./reader-proof-format');
const SELECTION_FAMILY = 'reader-compiled-pdf-table-selection';
const SELECTION_CONTRACT = require('./protocol-codec').contract(SELECTION_FAMILY);
const stable = value => {
    const sort = item => Array.isArray(item) ? item.map(sort) : item && typeof item === 'object'
        ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])])) : item;
    return require('node:crypto').createHash('sha256').update(JSON.stringify(sort(value))).digest('hex');
};
function sealedEvidence(table) {
    if (legacy.evidence(table)) return null;
    const actual = grid.evidence(table);
    if (actual) return actual;
    const context = saved.getStore(), proof = context?.proofs.get(table?.ordinal);
    return context?.artifacts.tables.includes(table) && proof
        && proof.sourceTableDomSha256 === table.sourceDomSha256 ? structuredClone(proof) : null;
}
function evidence(table) { return legacy.evidence(table) || sealedEvidence(table); }
function sourceMathDisplay(table, row, column) {
    if (table?.recoveryStatus !== 'complete' || !/^[a-f0-9]{64}$/.test(table.sourceDomSha256 || '')) return null;
    const cells = (table.cells || []).filter(cell => Number.isInteger(cell?.row) && Number.isInteger(cell?.column)
        && row >= cell.row && row < cell.row + Number(cell.rowspan || 1)
        && column >= cell.column && column < cell.column + Number(cell.colspan || 1));
    const cell = cells[0];
    if (cells.length !== 1 || !/^[a-f0-9]{64}$/.test(cell.sourceDomSha256 || '')
        || table.matrix?.[row]?.[column] !== cell.text) return null;
    const proof = require('./source-cell-math-display').strictSourceCellMathDisplay(cell.text);
    // Nested powers are a publication view only: keep their canonical Reader
    // rendering unchanged so an old paid draft still replays byte for byte.
    return ['numeric-style-duplicate', 'scientific-notation-duplicate'].includes(proof?.kind) ? proof : null;
}
function displayCell(table, row, column) {
    const proof = sealedEvidence(table);
    if (proof) return proof.displayMatrix[row]?.[column];
    const original = legacy.displayCell(table, row, column);
    if (legacy.evidence(table)) return original;
    return sourceMathDisplay(table, row, column)?.displayText ?? original;
}
function displayMatrix(table) { return (table?.matrix || []).map((row, r) => row.map((_cell, c) => displayCell(table, r, c))); }
function displayCellMatches(table, row, column, text, normalize = value => value) {
    if (sealedEvidence(table)) return normalize(text) === normalize(displayCell(table, row, column));
    // Original signed bindings keep the old comparison first. A new display
    // may additionally prove exact whole-cell equivalence to this same DOM cell.
    if (legacy.displayCellMatches(table, row, column, text, normalize)) return true;
    if (legacy.evidence(table)) return false;
    const proof = sourceMathDisplay(table, row, column);
    return Boolean(proof && normalize(text) === normalize(proof.displayText));
}
function selectionProjection(table, binding, artifacts, proof, projectionHeader = proofFormat.header(SELECTION_FAMILY)) {
    const selection = require('./reader-tables').readCompiledReaderTableSelection(binding, artifacts);
    if (!selection || !proof || legacy.supported(table)
        || artifacts.tables.filter(item => item.ordinal === binding.sourceTableOrdinal).length !== 1
        || !artifacts.tables.includes(table) || binding.sourceTableOrdinal !== table.ordinal) return null;
    // An identity view already passed the historical complete-table protocol.
    // Preserve its exact saved bytes; only a genuine projection needs this new proof.
    if (selection.sourceRows.length === table.matrix.length
        && selection.sourceColumns.length === table.matrix[0].length
        && selection.sourceRows.every((row, index) => row === index)
        && selection.sourceColumns.every((column, index) => column === index)) return null;
    return { ...projectionHeader, tableIndex: binding.tableIndex,
        sourceTableOrdinal: table.ordinal, sourceTableDomSha256: table.sourceDomSha256,
        sourceTableSha256: proof.sourceTableSha256, pdfEvidenceSha256: proof.evidenceSha256,
        ...selection, cellBindingsSha256: stable(binding.cellBindings) };
}
function compiledSelectionEvidence(table, binding, artifacts) {
    return selectionProjection(table, binding, artifacts, sealedEvidence(table));
}
// Pure replay, not a source capability: both callers first authenticate the full
// four-source PDF grid. This never enrolls a serialized binding in a live scope.
function validateSavedSelectionBinding(binding, artifacts, proof) {
    const projectionHeader = proofFormat.readHeader(binding?.sealedPdfTableSelection, SELECTION_FAMILY);
    const candidates = artifacts?.tables?.filter(table => table.ordinal === binding.sourceTableOrdinal) || [];
    const table = candidates[0], selection = binding.sealedPdfTableSelection;
    if (binding.sourceType !== 'artifact_table' || binding.pdfCellConfirmation !== undefined
        || candidates.length !== 1 || !proof || !isDeepStrictEqual(proof, binding.sealedPdfTableEvidence)
        || binding.sourceTableDomSha256 !== table.sourceDomSha256) {
        throw new Error('Compiled PDF selection lacks its exact full source/grid identity');
    }
    const compiled = require('./reader-tables').renderReaderTableSelection({ tableIndex: binding.tableIndex,
        selection: { sourceTableOrdinal: binding.sourceTableOrdinal,
            sourceRows: selection?.sourceRows, sourceColumns: selection?.sourceColumns } }, artifacts);
    const expected = selectionProjection(table, compiled.binding, artifacts, proof, projectionHeader);
    if (!expected || !isDeepStrictEqual(expected, selection)
        || !Array.isArray(binding.cellBindings) || binding.cellBindings.length !== compiled.binding.cellBindings.length
        || binding.cellBindings.some((cell, index) => {
            const position = compiled.binding.cellBindings[index];
            const original = table.cells.filter(value => value.row === position.sourceRow
                && value.column === position.sourceColumn);
            return !cell || Object.keys(cell).sort().join(',')
                    !== 'renderedColumn,renderedRow,renderedText,sourceColumn,sourceDomSha256,sourceRow,sourceText'
                || typeof cell.renderedText !== 'string'
                || Object.keys(position).some(key => cell[key] !== position[key]) || original.length !== 1
                || cell.sourceText !== original[0].text || cell.sourceDomSha256 !== original[0].sourceDomSha256;
        })) {
        throw new Error('Compiled PDF selection cannot replay its original compiler coordinates');
    }
    return true;
}
function compiledSelectionDisplayMatches(table, binding, rows, artifacts) {
    const selection = compiledSelectionEvidence(table, binding, artifacts);
    if (!selection) return false;
    const { sourceRows, sourceColumns } = selection;
    return Array.isArray(rows) && rows.length === sourceRows.length
        && rows.every((row, r) => Array.isArray(row) && row.length === sourceColumns.length
            && row.every((text, c) => text === table.matrix[sourceRows[r]][sourceColumns[c]]
                || text === displayCell(table, sourceRows[r], sourceColumns[c])));
}
function bindingEvidence(table, binding, artifacts) {
    const old = legacy.evidence(table), exact = old ? null : sealedEvidence(table);
    const selection = exact && binding && artifacts ? compiledSelectionEvidence(table, binding, artifacts) : null;
    return old ? { pdfCellConfirmation: old } : exact ? { sealedPdfTableEvidence: exact,
        ...(selection ? { sealedPdfTableSelection: selection } : {}) } : {};
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
function assertSavedPairedDomBindings(paper) {
    const bindings = (paper?.apiReaderPlan?.tableBindings || []).filter(binding =>
        binding?.sourceType === 'artifact_table' && !binding.pdfCellConfirmation && !binding.sealedPdfTableEvidence);
    const provenance = paper?.freshRewriteProvenance;
    // Old ordinary/PDF views retain their route. Actual daily source identity,
    // rather than a removable cell marker, selects this reject-only replay.
    if (!bindings.length || !isFreshSourceProvenance(provenance)) return;
    const fresh = require('./fresh-analysis-context');
    if (!isDeepStrictEqual(provenance, paper.analysisManifest?.freshRewriteProvenance)
        || !/^[a-f0-9-]{36}$/.test(provenance.runId || '')) throw new Error('Paired DOM display lacks sealed daily identity');
    const runDir = path.join(require('../config').FILES.dailyFreshSourceRunsDir, provenance.runId);
    const runFile = path.join(runDir, 'run.json');
    // Non-daily historical routes keep their complete original verifier. This
    // is only a reject-only component; the daily plan gate still rejects a
    // missing/replaced run, and a present malformed/symlink run is never skipped.
    try { require('node:fs').lstatSync(runFile); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const run = require('./reader-proof-read-scope').readReaderProofJson(runFile).value;
    if (!fresh.isDailySourceRun(run)) throw new Error('Paired DOM display run contract differs');
    const source = fresh.readFreshSource(runDir, paper, { runId: run.runId, sourceExpectations: run.sourceExpectations });
    const hasPair = text => /[↑↓]\{\\(?:uparrow|downarrow)\}/.test(text)
        || /^[+−-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)[ \t]*±[ \t]*\\pm[ \t]*(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)[ \t]+(?:ms|s)[ \t]*$/.test(text);
    if (!source.structuredArtifacts.tables.some(table => table.cells.some(cell => hasPair(cell.text)))) return;
    const descriptor = source.freshSourceDescriptor, acquisition = paper.analysisManifest?.sourceAcquisition;
    if (paper.sourceSha256 !== descriptor.sourceSha256 || acquisition?.sourceSha256 !== descriptor.sourceSha256
        || acquisition.structuredArtifactsSha256 !== descriptor.structuredArtifactsSha256
        || ['runId', 'sourceSha256', 'structuredArtifactsSha256', 'sourceSnapshotSha256', 'sourceGeneration', 'sourceManifestSha256']
            .some(key => provenance[key] !== descriptor[key])
        || paper.apiReaderPlan.structuredSourcePayload !== require('../deep-analyzer').readerStructuredSourcePayload(source.structuredArtifacts))
        throw new Error('Paired DOM display four-source identity differs');
    const rendered = require('../analysis-contract').extractMarkdownTables(paper.apiReaderArticle || '');
    const normalize = require('./reader-source-display').normalizeReaderSourceDisplayArtifacts;
    for (const binding of bindings) {
        const originals = source.structuredArtifacts.tables.filter(table => table.ordinal === binding.sourceTableOrdinal);
        const table = originals[0], view = rendered[binding.tableIndex - 1], seen = new Set();
        const matrix = view && [view.header, ...view.rows];
        if (originals.length !== 1 || table.recoveryStatus !== 'complete'
            || binding.sourceTableDomSha256 !== table.sourceDomSha256 || binding.sourceQuotes?.length !== 0
            || !matrix || matrix.length !== table.matrix.length
            || matrix.some((row, index) => row.length !== table.matrix[index].length)
            || !Array.isArray(binding.cellBindings) || binding.cellBindings.length !== table.matrix.reduce((n, row) => n + row.length, 0)
            || binding.cellBindings.some(cell => {
                const r = cell.sourceRow, c = cell.sourceColumn, key = `${r}:${c}`;
                const owners = table.cells.filter(item => r >= item.row && r < item.row + item.rowspan
                    && c >= item.column && c < item.column + item.colspan);
                if (!Number.isSafeInteger(r) || !Number.isSafeInteger(c) || r < 0 || c < 0 || seen.has(key)
                    || cell.renderedRow !== r || cell.renderedColumn !== c || owners.length !== 1
                    || table.matrix[r]?.[c] !== owners[0].text || cell.sourceText !== owners[0].text
                    || cell.sourceDomSha256 !== owners[0].sourceDomSha256
                    || cell.renderedText !== normalize(owners[0].text) || matrix[r]?.[c] !== cell.renderedText) return true;
                seen.add(key); return false;
            })) throw new Error('Paired DOM display must retain every complete original cell, coordinate and literal value');
    }
}
function assertSavedScientificDomBindings(paper) {
    assertSavedPairedDomBindings(paper);
    const rendered = require('../analysis-contract').extractMarkdownTables(paper?.apiReaderArticle || '');
    const marked = (paper?.apiReaderPlan?.tableBindings || []).filter(binding =>
        binding?.sourceType === 'artifact_table' && !binding.pdfCellConfirmation && !binding.sealedPdfTableEvidence && (
        // Reject-only detection uses the actual displayed table. Folding here
        // grants nothing: original source bytes and coordinates are checked below.
        /[0-9.]×10[+−-]?[0-9]+/.test(String(rendered[binding.tableIndex - 1]?.markdown || '')
            .normalize('NFKC').replace(/[\s*_`]/g, ''))
        || (binding.cellBindings || []).some(cell => require('./source-cell-math-display')
            .strictSourceCellMathDisplay(cell.sourceText)?.kind === 'scientific-notation-duplicate'
            // The display-side trigger cannot be removed by replacing all raw
            // sourceText values with their already-rendered Unicode surfaces.
            || /^[+−-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)×10[⁺⁻]?[⁰¹²³⁴⁵⁶⁷⁸⁹]+$/.test(cell.renderedText || ''))));
    if (!marked.length) return;
    const provenance = paper.freshRewriteProvenance;
    if (!isFreshSourceProvenance(provenance)
        || !isDeepStrictEqual(provenance, paper.analysisManifest?.freshRewriteProvenance)
        || !/^[a-f0-9-]{36}$/.test(provenance.runId || '')) throw new Error('Scientific DOM display lacks the actual sealed source');
    const fresh = require('./fresh-analysis-context');
    const runDir = path.join(require('../config').FILES.dailyFreshSourceRunsDir, provenance.runId);
    const run = require('./reader-proof-read-scope').readReaderProofJson(path.join(runDir, 'run.json')).value;
    if (!fresh.isDailySourceRun(run)) throw new Error('Scientific DOM display run contract differs');
    const source = fresh.readFreshSource(runDir, paper, { runId: run.runId, sourceExpectations: run.sourceExpectations });
    const descriptor = source.freshSourceDescriptor, acquisition = paper.analysisManifest?.sourceAcquisition;
    if (paper.sourceSha256 !== descriptor.sourceSha256 || acquisition?.sourceSha256 !== descriptor.sourceSha256
        || acquisition.structuredArtifactsSha256 !== descriptor.structuredArtifactsSha256
        || ['runId', 'sourceSha256', 'structuredArtifactsSha256', 'sourceSnapshotSha256', 'sourceGeneration', 'sourceManifestSha256']
            .some(key => provenance[key] !== descriptor[key])
        || paper.apiReaderPlan.structuredSourcePayload !== require('../deep-analyzer').readerStructuredSourcePayload(source.structuredArtifacts))
        throw new Error('Scientific DOM display four-source identity differs');
    for (const binding of marked) {
        const tables = source.structuredArtifacts.tables.filter(table => table.ordinal === binding.sourceTableOrdinal);
        const table = tables[0], seen = new Set();
        if (binding.sourceType !== 'artifact_table' || tables.length !== 1 || table.recoveryStatus !== 'complete'
            || binding.sourceTableDomSha256 !== table.sourceDomSha256 || binding.sourceQuotes?.length !== 0
            || binding.cellBindings.length !== table.matrix.reduce((count, row) => count + row.length, 0)
            || binding.cellBindings.some(cell => {
                const key = `${cell.sourceRow}:${cell.sourceColumn}`;
                const originals = table.cells.filter(item => item.row === cell.sourceRow && item.column === cell.sourceColumn);
                if (!Number.isSafeInteger(cell.sourceRow) || !Number.isSafeInteger(cell.sourceColumn)
                    || cell.sourceRow < 0 || cell.sourceColumn < 0 || seen.has(key)
                    || cell.renderedRow !== cell.sourceRow || cell.renderedColumn !== cell.sourceColumn
                    || originals.length !== 1 || originals[0].rowspan !== 1 || originals[0].colspan !== 1
                    || table.matrix[cell.sourceRow]?.[cell.sourceColumn] !== cell.sourceText
                    || originals[0].text !== cell.sourceText || originals[0].sourceDomSha256 !== cell.sourceDomSha256) return true;
                seen.add(key); return false;
            })) throw new Error('Scientific DOM display must retain the exact complete original table and cell coordinates');
    }
}
function withSavedPaper(paper, callback) {
    return require('./reader-record-format').isIntegratedPlan(paper?.apiReaderPlan)
        ? proofFormat.withSavedPlanRepresentation(paper.apiReaderPlan, () => withSavedPaperInRepresentation(paper, callback))
        : withSavedPaperInRepresentation(paper, callback);
}
function withSavedPaperInRepresentation(paper, callback) {
    assertSavedScientificDomBindings(paper);
    const bindings = paper?.apiReaderPlan?.tableBindings || [];
    if (bindings.some(binding => binding.sealedPdfTableSelection !== undefined
        && (!binding.sealedPdfTableEvidence || binding.pdfCellConfirmation !== undefined))) {
        throw new Error('Compiled PDF selection requires its original independent full-grid evidence');
    }
    if (!bindings.some(binding => binding.sealedPdfTableEvidence !== undefined)) return legacy.withSavedPaper(paper, callback);
    const provenance = paper.freshRewriteProvenance, acquisition = paper.analysisManifest?.sourceAcquisition;
    if (!provenance || !isDeepStrictEqual(provenance, paper.analysisManifest?.freshRewriteProvenance)
        || !isFreshSourceProvenance(provenance)
        || !/^[a-f0-9-]{36}$/.test(provenance.runId || '')) throw new Error('Sealed PDF grid lacks the actual daily source provenance');
    const fresh = require('./fresh-analysis-context'), Config = require('../config');
    const runDir = path.join(Config.FILES.dailyFreshSourceRunsDir, provenance.runId);
    const run = require('./reader-proof-read-scope').readReaderProofJson(path.join(runDir, 'run.json')).value;
    if (!fresh.isDailySourceRun(run)) throw new Error('Sealed PDF grid run contract differs');
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
    return saved.run({ artifacts: source.structuredArtifacts, proofs, selectionBindings: new WeakMap() }, () => {
    for (const binding of bindings.filter(binding => binding.sealedPdfTableEvidence !== undefined)) {
        const candidates = source.structuredArtifacts.tables.filter(table => table.ordinal === binding.sourceTableOrdinal);
        const table = candidates[0], proof = proofs.get(binding.sourceTableOrdinal);
        if (binding.sealedPdfTableSelection !== undefined) {
            validateSavedSelectionBinding(binding, source.structuredArtifacts, proof);
            saved.getStore().selectionBindings.set(binding, JSON.stringify(binding));
            continue;
        }
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
    return legacy.withSavedPaper(paper, callback);
    });
}
function savedCellMatches(binding, cell, displayed) {
    if (!binding?.sealedPdfTableEvidence) return legacy.savedCellMatches(binding, cell, displayed);
    const context = saved.getStore(), proof = context?.proofs.get(binding.sourceTableOrdinal);
    if (!proof || binding.pdfCellConfirmation !== undefined || !isDeepStrictEqual(proof, binding.sealedPdfTableEvidence)) return false;
    const tables = context.artifacts.tables.filter(table => table.ordinal === binding.sourceTableOrdinal);
    if (tables.length !== 1) return false;
    const originals = tables[0].cells.filter(item => item.row === cell.sourceRow && item.column === cell.sourceColumn);
    const selection = binding.sealedPdfTableSelection !== undefined;
    return originals.length === 1 && originals[0].sourceDomSha256 === cell.sourceDomSha256 && originals[0].text === cell.sourceText
        && (selection ? context.selectionBindings.get(binding) === JSON.stringify(binding) && binding.cellBindings.includes(cell)
            : cell.sourceRow === cell.renderedRow && cell.sourceColumn === cell.renderedColumn)
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
module.exports = { SELECTION_CONTRACT, evidence, sealedEvidence, bindingEvidence,
    compiledSelectionEvidence, compiledSelectionDisplayMatches, displayCell, displayMatrix, displayCellMatches,
    validateSavedSelectionBinding, withArtifacts, withSavedPaper, savedCellMatches, appendSourceOriginNotes };
