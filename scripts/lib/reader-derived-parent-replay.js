'use strict';
// Compare authenticated producer outputs. This module creates no parent, stage,
// model allowance or replay capability; callers authenticate paid/Git/CAS first.
const { isDeepStrictEqual: same } = require('node:util');
const daily = require('./daily-fresh-source-plan');
const repair = require('./reader-repair');
const sha = require('./daily-fact-review').sha;
const exact = (o, keys) => o && Object.keys(o).sort().join(',') === keys.slice().sort().join(',');
function quotesValid(quotes, text) {
    return Array.isArray(quotes) && quotes.length <= 256 && quotes.every(q => exact(q, ['quote', 'sourceQuoteSha256'])
        && typeof q.quote === 'string' && !!q.quote.trim() && q.quote.length <= 180000
        && text.includes(q.quote) && q.sourceQuoteSha256 === sha(q.quote));
}
function bindingWithDerivedQuotes(before, after, raw, text) {
    if (same(before, after)) return true;
    if (!before || !after || raw?.sourceType !== 'source_quotes'
        || !quotesValid(before.sourceQuotes, text) || !quotesValid(after.sourceQuotes, text)) return false;
    const declared = [...new Set(raw.sourceQuotes || [])];
    if (declared.some(q => typeof q !== 'string' || !q.trim() || !text.includes(q))) return false;
    const explicit = list => list.filter(q => declared.includes(q.quote)).map(q => q.quote);
    if (!same(explicit(before.sourceQuotes), declared) || !same(explicit(after.sourceQuotes), declared)) return false;
    return same(before, { ...after, sourceQuotes: before.sourceQuotes });
}
function planWithDerivedQuotes(draft, before, after, text, scoped = new Map()) {
    if (!before || !after || !Array.isArray(before.tableBindings) || !Array.isArray(after.tableBindings)
        || before.tableBindings.length !== after.tableBindings.length
        || before.sourceBindingsSha256 !== daily.stableHash({ tableBindings: before.tableBindings, formulaBindings: before.formulaBindings })
        || after.sourceBindingsSha256 !== daily.stableHash({ tableBindings: after.tableBindings, formulaBindings: after.formulaBindings })) return false;
    const compared = structuredClone(after);
    for (let i = 0; i < before.tableBindings.length; i++) {
        if (scoped.has(i)) {
            const a = { ...after.tableBindings[i] }, b = { ...before.tableBindings[i] };
            if (!quotesValid(a.sourceQuotes, text) || !quotesValid(b.sourceQuotes, text)) return false;
            delete a.sourceQuotes; delete b.sourceQuotes;
            delete a.renderedTableSha256; delete b.renderedTableSha256;
            if (!same(a, b)) return false;
        } else if (!bindingWithDerivedQuotes(before.tableBindings[i], after.tableBindings[i], draft.tableBindings?.[i], text)) return false;
        compared.tableBindings[i] = before.tableBindings[i];
    }
    compared.sourceBindingsSha256 = before.sourceBindingsSha256;
    return same(compared, before);
}
function parentHashesValid(parent, source) {
    const stage = parent?.analysisManifest?.stages?.apiReaderArticle;
    return !!stage && stage.status === 'complete'
        && sha(parent.apiReaderArticle) === parent.apiReaderArticleSha256
        && daily.stableHash(parent.apiReaderPlan) === parent.apiReaderPlanSha256
        && stage.articleSha256 === parent.apiReaderArticleSha256 && stage.planSha256 === parent.apiReaderPlanSha256
        && stage.sourceBindingsSha256 === parent.apiReaderPlan.sourceBindingsSha256
        && stage.sourceBindingsSourceTextSha256 === sha(source.text)
        && daily.stableHash(parent.apiReaderFigures) === stage.figuresSha256;
}
function orderedProjection(before, after) {
    const columns = after.header.map(value => before.header.reduce((a, h, i) => h === value ? [...a, i] : a, []));
    if (columns.some(c => c.length !== 1)) return false;
    const indices = columns.map(c => c[0]);
    if (indices.some((v, i) => i && v <= indices[i - 1])) return false;
    let cursor = -1;
    for (const row of after.rows) {
        const matches = before.rows.map((r, i) => same(indices.map(j => r[j]), row) ? i : -1).filter(i => i > cursor);
        if (matches.length !== 1) return false;
        cursor = matches[0];
    }
    return after.header.length < before.header.length || after.rows.length < before.rows.length;
}
function scopedPrunedTables(draft, record, parent, current, source) {
    const result = new Map();
    if (!record || record.contract !== 'daily-reader-signed-correction-v2'
        || !same(record.parentPaper, parent) || record.parentPaperSha256 !== daily.stableHash(parent)
        || record.parentArticleSha256 !== parent.apiReaderArticleSha256 || record.parentPlanSha256 !== parent.apiReaderPlanSha256) return result;
    const targets = require('./reader-signed-table-targets'), extract = require('../analysis-contract').extractMarkdownTables;
    const old = extract(parent.apiReaderArticle), now = extract(current.article), slots = targets.readerTableSlots(draft);
    if (old.length !== now.length || slots.length !== old.length) return result;
    for (const proof of record.tableCorrections || []) {
        if (proof.bindingOnly || !/^\/tableBindings\/(?:0|[1-9]\d*)$/.test(proof.path)) continue;
        const index = Number(proof.path.split('/').at(-1)), slot = slots[index];
        if (!slot || slot.kind !== 'inline' || slot.tableIndex !== draft.tableBindings?.[index]?.tableIndex
            || slot.sectionPath !== proof.sectionPath || repair.hashDraft(slot.table.markdown) !== proof.oldTableSha256
            || old.filter(t => t.markdown === old[index]?.markdown).length !== 1
            || now.filter(t => t.markdown === now[index]?.markdown).length !== 1
            || slots.filter(s => s.table?.markdown === slot.table.markdown).length !== 1) continue;
        const rawNode = draft.sections[Number(slot.sectionPath.split('/')[2])]?.body;
        const projected = require('../deep-analyzer').normalizeApiReaderTablePasteArtifacts(
            require('./reader-signed-raw-claim-display').normalizeSignedReaderClaim(slot.table.markdown, rawNode));
        if (projected !== old[index].markdown || !orderedProjection(old[index], now[index])
            || parent.apiReaderPlan.tableBindings[index]?.renderedTableSha256 !== sha(old[index].markdown)
            || current.plan.tableBindings[index]?.renderedTableSha256 !== sha(now[index].markdown)) continue;
        const tables = (source.structuredArtifacts?.tables || []).filter(t => t.ordinal === proof.sourceTableOrdinal
            && t.sourceDomSha256 === proof.sourceDomSha256 && t.recoveryStatus === 'complete');
        if (tables.length !== 1 || repair.hashDraft(tables[0]) !== proof.sourceTableSha256) continue;
        const target = targets.renderSignedTableTarget(record, proof, source), cells = target.binding.cellBindings;
        if (target.tableIndex !== index + 1 || cells.length !== tables[0].matrix.reduce((n, r) => n + r.length, 0)
            || cells.some(c => c.renderedRow !== c.sourceRow || c.renderedColumn !== c.sourceColumn)) continue;
        result.set(index, { before: old[index].markdown, current: now[index].markdown });
    }
    return result;
}
function parentReplayMatches({ draft, record, parent, current, source, allowScopedTables = false }) {
    if (!parentHashesValid(parent, source) || !same(current.figures, parent.apiReaderFigures)) return false;
    const scoped = allowScopedTables ? scopedPrunedTables(draft, record, parent, current, source) : new Map();
    let article = current.article;
    for (const { before, current: table } of scoped.values()) {
        if (article.split(table).length !== 2) return false;
        article = article.replace(table, before);
    }
    return article === parent.apiReaderArticle
        && planWithDerivedQuotes(draft, parent.apiReaderPlan, current.plan, source.text, scoped);
}
module.exports = { bindingWithDerivedQuotes, planWithDerivedQuotes, parentReplayMatches };
