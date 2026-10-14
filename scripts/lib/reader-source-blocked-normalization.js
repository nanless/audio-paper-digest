'use strict';

// A blocked normalization is a failed recovery input, never a validated article.
const { isDeepStrictEqual } = require('node:util');
const CONTRACT = 'reader-source-blocked-normalization-v1';
const SOURCE_CODE = 'reader_source_table_unrenderable';
const hash = value => require('./reader-repair').hashDraft(value);

function readSourceTableNormalizationError(error, draft, artifacts) {
    if (!(error instanceof Error) || error.code !== 'READER_SOURCE_TABLE_UNRENDERABLE'
        || !Array.isArray(error.readerIssues) || !error.readerIssues.length
        || !Array.isArray(draft?.sections) || !Array.isArray(draft?.tableBindings)
        || !Array.isArray(artifacts?.tables)
        || error.readerIssues.some(issue => !issue || issue.code !== SOURCE_CODE || issue.diagnosticOnly === true)) return null;
    const originalDraft = draft;
    if (error.blockedNormalizationDraft !== undefined) {
        if (error.normalizationInputSha256 !== hash(originalDraft)
            || error.blockedNormalizationDraftSha256 !== hash(error.blockedNormalizationDraft)) return null;
        let replayError;
        try { require('./reader-draft-order').normalizeReaderDraftOrder(originalDraft, { structuredArtifacts: artifacts }); }
        catch (current) { replayError = current; }
        if (!replayError || replayError.code !== 'READER_SOURCE_TABLE_UNRENDERABLE'
            || replayError.normalizationInputSha256 !== error.normalizationInputSha256
            || !isDeepStrictEqual(replayError.blockedNormalizationDraft, error.blockedNormalizationDraft)
            || !isDeepStrictEqual(replayError.readerIssues, error.readerIssues)) return null;
        draft = error.blockedNormalizationDraft;
    }
    const tables = require('./reader-tables');
    const nodes = require('./reader-draft-order').locateReaderDraftTables(draft);
    const indexes = [...new Set(error.readerIssues.flatMap(issue => {
        const match = /^\/tableBindings\/(0|[1-9]\d*)$/.exec(issue.path || '');
        return match && Number.isSafeInteger(Number(match[1])) ? [Number(match[1])] : [];
    }))];
    if (!indexes.length) return null;
    const issues = [];
    for (const index of indexes) {
        const binding = draft.tableBindings[index];
        const ordinal = binding?.completeTable?.sourceTableOrdinal ?? binding?.selection?.sourceTableOrdinal ?? binding?.sourceTableOrdinal;
        const sources = artifacts.tables.filter(table => table?.ordinal === ordinal);
        const explicitMarker = `[[TABLE_${binding?.tableIndex}]]`;
        // Missing preceding tables do not change the binding named by an exact standalone marker.
        const marked = nodes.filter(node => node.marker === explicitMarker);
        const locations = marked.length ? marked
            : nodes.filter(node => !node.marker && node.bindingIndex === index && node.tableIndex === binding?.tableIndex);
        if (binding?.tableIndex !== index + 1 || !Number.isSafeInteger(ordinal) || sources.length !== 1 || locations.length !== 1) return null;
        const location = locations[0], eligibility = tables.assessReaderCompleteTableEligibility(sources[0]);
        if (eligibility.eligible || !/^\/sections\/(0|[1-9]\d*)\/body$/.test(location.path)) return null;
        if (location.marker) {
            if (draft.sections.reduce((count, section) => count + String(section?.body || '').split(location.marker).length - 1, 0) !== 1
                || String(draft.sections[location.sectionIndex]?.body || '').split(/\n\s*\n/)
                    .filter(block => block.trim() === location.marker).length !== 1) return null;
        }
        const expected = tables.readerSourceTableError(binding.tableIndex, sources[0], eligibility).readerIssues[0];
        const exact = error.readerIssues.find(issue => issue.path === expected.path);
        if (!exact || exact.sourceTableOrdinal !== ordinal || !isDeepStrictEqual(exact.reasonCodes, eligibility.reasonCodes)
            || !isDeepStrictEqual(exact.sourceTableEligibility, eligibility)) return null;
        issues.push(expected, { ...expected, path: location.path, bindingPath: expected.path });
    }
    for (const supplied of error.readerIssues) {
        if (!issues.some(issue => issue.path === supplied.path && issue.sourceTableOrdinal === supplied.sourceTableOrdinal
            && (supplied.bindingPath === undefined || supplied.bindingPath === issue.bindingPath))) return null;
    }
    return { contract: CONTRACT, draft: structuredClone(draft), draftSha256: hash(draft),
        artifactsSha256: hash(artifacts), blockingIssues: issues };
}

function assertBlockedNormalizationResult(value, artifacts) {
    if (!value || value.contract !== CONTRACT || hash(value.draft) !== value.draftSha256
        || hash(artifacts) !== value.artifactsSha256 || !Array.isArray(value.blockingIssues)) {
        throw new Error('来源阻塞归一化记录的草稿或来源身份不同');
    }
    const error = Object.assign(new Error('Blocked source table recovery input'), {
        code: 'READER_SOURCE_TABLE_UNRENDERABLE', readerIssues: value.blockingIssues });
    const current = readSourceTableNormalizationError(error, value.draft, artifacts);
    if (!current || !isDeepStrictEqual(current.blockingIssues, value.blockingIssues)) {
        throw new Error('来源阻塞归一化记录不能由当前真实草稿和封存来源重放');
    }
    return current;
}

module.exports = { CONTRACT, readSourceTableNormalizationError, assertBlockedNormalizationResult };
