'use strict';
// A display bridge for one authenticated inline table, never a prose allowance.
const { isDeepStrictEqual: same } = require('node:util');
const repair = require('./reader-repair');
const targets = require('./reader-signed-table-targets');
function parentMatches(record) {
    const daily = require('./daily-fresh-source-plan'), parent = record.parentPaper;
    return !!parent && daily.stableHash(parent) === record.parentPaperSha256
        && parent.apiReaderArticleSha256 === record.parentArticleSha256
        && parent.apiReaderPlanSha256 === record.parentPlanSha256
        && require('./daily-fact-review').sha(parent.apiReaderArticle) === record.parentArticleSha256
        && daily.stableHash(parent.apiReaderPlan) === record.parentPlanSha256;
}
function completeTarget(record, proof, source, tableIndex) {
    const sourceTables = (source.structuredArtifacts?.tables || []).filter(t => t.ordinal === proof.sourceTableOrdinal
        && t.sourceDomSha256 === proof.sourceDomSha256 && t.recoveryStatus === 'complete');
    if (sourceTables.length !== 1 || repair.hashDraft(sourceTables[0]) !== proof.sourceTableSha256) return null;
    const replacement = record.patch?.replacements?.find(r => r.path === proof.path)?.value;
    if (!targets.signedTableReplacementMatches(replacement, tableIndex, proof.sourceTableOrdinal)) return null;
    const target = targets.renderSignedTableTarget(record, proof, source);
    const table = require('../analysis-contract').extractMarkdownTables(target.markdown)[0];
    if (!table) return null;
    const matrix = [table.header, ...table.rows], coordinates = target.binding.cellBindings;
    if (matrix.length !== sourceTables[0].matrix.length
        || matrix.some((r, i) => r.length !== sourceTables[0].matrix[i].length)
        || coordinates.length !== sourceTables[0].matrix.reduce((n, r) => n + r.length, 0)
        || coordinates.some(c => c.renderedRow !== c.sourceRow || c.renderedColumn !== c.sourceColumn)) return null;
    return target;
}
function matchesPrunedTableClaim({ handle, original, record, source, range, edit, claim, rawClaim }) {
    if (!require('./daily-reader-signed-correction').authenticatedTableProjection(handle, original, record, source)) return false;
    return prunedTableProjectionMatches({ original, record, source, range, edit, claim, rawClaim });
}
// Pure structural predicate for regression fixtures. Calling it grants no
// capability; only matchesPrunedTableClaim is used by the range validator.
function prunedTableProjectionMatches({ original, record, source, range, edit, claim, rawClaim }) {
    const parent = record.parentPaper;
    if (!parentMatches(record) || !/^\/sections\/(?:0|[1-9]\d*)\/body$/.test(range.path)
        || range.oldSha256 !== repair.hashDraft(original.sections[Number(range.path.split('/')[2])]?.body)) return false;
    const proofs = (record.tableCorrections || []).filter(p => p.sectionPath === range.path && p.claimIndex === edit.claimIndex);
    if (proofs.length !== 1) return false;
    const proof = proofs[0], oldSlots = targets.readerTableSlots(original);
    const binding = original.tableBindings?.[Number(proof.path.split('/').at(-1))];
    const slot = oldSlots[(binding?.tableIndex || 0) - 1];
    const extract = require('../analysis-contract').extractMarkdownTables;
    const parentTables = extract(parent.apiReaderArticle);
    if (!slot || slot.kind !== 'inline' || slot.sectionPath !== range.path
        || oldSlots.length !== parentTables.length
        || oldSlots.filter(s => s.table?.markdown === slot.table.markdown).length !== 1
        || rawClaim !== slot.table.markdown || edit.from !== rawClaim
        || edit.claimStart !== slot.offset || edit.start !== slot.offset
        || edit.end !== slot.offset + rawClaim.length
        || proof.oldTableSha256 !== repair.hashDraft(rawClaim)) return false;
    const table = parentTables[binding.tableIndex - 1];
    if (!table || claim !== table.markdown
        || parentTables.filter(t => t.markdown === claim).length !== 1) return false;
    // Normal pruning may remove rows, but cannot explain a changed header/cell,
    // reordered rows, an inserted row, or an adjacent table being substituted.
    const normalized = extract(require('../deep-analyzer').normalizeApiReaderTablePasteArtifacts(rawClaim));
    if (normalized.length !== 1 || !same(normalized[0].header, table.header)
        || normalized[0].rows.length <= table.rows.length) return false;
    let cursor = 0;
    for (const row of table.rows) {
        while (cursor < normalized[0].rows.length && !same(normalized[0].rows[cursor], row)) cursor++;
        if (cursor === normalized[0].rows.length) return false;
        cursor++;
    }
    const target = completeTarget(record, proof, source, binding.tableIndex);
    return !!target && require('../deep-analyzer').normalizeApiReaderTablePasteArtifacts(edit.to) === target.markdown;
}
function matchesIdenticalTableBinding({ handle, original, record, source, proof }) {
    if (!require('./daily-reader-signed-correction').authenticatedTableProjection(handle, original, record, source)) return false;
    return identicalTableBindingProjectionMatches({ original, record, source, proof });
}
function identicalTableBindingProjectionMatches({ original, record, source, proof }) {
    if (!parentMatches(record) || proof.bindingOnly !== true || Object.hasOwn(proof, 'claimIndex')
        || !/^\/tableBindings\/(?:0|[1-9]\d*)$/.test(proof.path)) return false;
    const index = Number(proof.path.split('/').at(-1)), before = original.tableBindings?.[index];
    const slots = targets.readerTableSlots(original), afterSlots = targets.readerTableSlots(record.draft);
    const slot = slots[(before?.tableIndex || 0) - 1], after = afterSlots[(before?.tableIndex || 0) - 1];
    const parentTables = require('../analysis-contract').extractMarkdownTables(record.parentPaper.apiReaderArticle);
    if (!before || before.sourceType !== 'source_quotes' || !Array.isArray(before.sourceQuotes) || !before.sourceQuotes.length
        || !slot || slot.kind !== 'inline' || slot.sectionPath !== proof.sectionPath
        || slots.length !== parentTables.length || slots.length !== afterSlots.length
        || !after || after.kind !== 'inline' || after.sectionPath !== slot.sectionPath
        || after.table.markdown !== slot.table.markdown
        || slots.filter(s => s.table?.markdown === slot.table.markdown).length !== 1
        || repair.hashDraft(slot.table.markdown) !== proof.oldTableSha256
        || (record.rangeCorrections || []).some(r => r.path === proof.sectionPath)
        || record.patch.replacements.some(r => r.path === proof.sectionPath)) return false;
    const sectionIndex = Number(proof.sectionPath.split('/')[2]);
    if (original.sections[sectionIndex]?.body !== record.draft.sections[sectionIndex]?.body) return false;
    const target = completeTarget(record, proof, source, before.tableIndex);
    const normalize = require('../deep-analyzer').normalizeApiReaderTablePasteArtifacts;
    const parentTable = parentTables[before.tableIndex - 1];
    return !!target && !!parentTable && parentTables.filter(t => t.markdown === parentTable.markdown).length === 1
        && normalize(slot.table.markdown) === target.markdown && parentTable.markdown === target.markdown;
}
module.exports = { matchesPrunedTableClaim, prunedTableProjectionMatches,
    matchesIdenticalTableBinding, identicalTableBindingProjectionMatches };
