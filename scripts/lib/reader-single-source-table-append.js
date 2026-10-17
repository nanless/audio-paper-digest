'use strict';
// PURE DATA ONLY. The caller must independently hold the real registered grant,
// final failed-set admission and authenticated source/PDF scope. No capability,
// Reader qualification, paid lineage or permission is created by this helper.
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { extractMarkdownTables } = require('../analysis-contract');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const hash = value => sha(JSON.stringify(value));
function reject(message) {
    const error = new Error(`Single source-table append data rejected: ${message}`);
    error.code = 'READER_SINGLE_SOURCE_TABLE_APPEND_DATA_INVALID';
    throw error;
}
function check(value, message) { if (!value) reject(message); }
function equal(a, b, message) { check(isDeepStrictEqual(a, b), message); }
function tables(draft) { return draft.sections.flatMap(section => extractMarkdownTables(section.body)); }
function shape(draft) {
    return { sections: draft.sections.length, tables: tables(draft).length,
        bindings: draft.tableBindings.length, figures: draft.figurePlacements.length,
        formulas: draft.formulaBindings.length };
}
function markers(draft) {
    return draft.sections.flatMap(section => section.body.match(/\[\[(?:FIGURE|FORMULA|CONCEPT_BRIDGE)_[^\]]+\]\]/gu) || []);
}
function appendPinnedSingleSourceTable({ spec, specSha256, packageBytes, pdfBytes }) {
    check(spec && spec.contract === 'reader-single-source-table-append-data-v1'
        && spec.version === 1 && spec.dataValidationOnly === true, 'unknown data specification');
    check(hash(spec) === specSha256, 'append specification SHA');
    const expectedBefore = { sections: 14, tables: 1, bindings: 1, figures: 4, formulas: 0 };
    const expectedAfter = { ...expectedBefore, tables: 2, bindings: 2 };
    equal(spec.shapeBefore, expectedBefore, 'only original 1/1 shape supported');
    equal(spec.shapeAfter, expectedAfter, 'only exact 1/1 to 2/2 delta supported');
    check(spec.body?.path === '/sections/10/body' && spec.body.operation === 'append_exact_suffix_to_existing_body'
        && spec.binding?.path === '/tableBindings/1' && spec.binding.operation === 'append_one_exact_binding', 'fixed append paths');
    const paths = Object.keys(spec.originalPackageCAS || {});
    check(paths.length === 6 && packageBytes && typeof packageBytes === 'object', 'all six original files required');
    equal(Object.keys(packageBytes).sort(), [...paths].sort(), 'exact original package file set');
    for (const name of paths) {
        check(Buffer.isBuffer(packageBytes[name]) && sha(packageBytes[name]) === spec.originalPackageCAS[name], `original file CAS: ${name}`);
    }
    check(paths.includes(spec.candidatePath) && paths.includes(spec.sourceRecordPath), 'candidate/source within original package');
    const candidateBytes = packageBytes[spec.candidatePath];
    check(sha(candidateBytes) === spec.originalEnvelopeSha256, 'original candidate bytes');
    const envelope = JSON.parse(candidateBytes.toString('utf8'));
    check(hash(envelope.identity) === spec.originalIdentitySha256 && hash(envelope.payload) === spec.originalPayloadSha256
        && envelope.payloadSha256 === spec.originalPayloadSha256, 'full original candidate logical input/payload');
    check(envelope.identity.paperId === spec.paperId && envelope.identity.sourceSha256 === spec.sourceTextSha256
        && envelope.identity.contentMode === 'reader-source-only-v1'
        && envelope.identity.conferenceReaderGrant?.executionId === spec.executionId
        && envelope.identity.conferenceReaderGrant?.paperId === spec.paperId, 'original conference candidate identity');
    const before = envelope.payload.draft;
    check(before && hash(before) === spec.originalDraftSha256, 'original complete draft SHA');
    check(Array.isArray(before.sections) && Array.isArray(before.tableBindings)
        && Array.isArray(before.figurePlacements) && Array.isArray(before.formulaBindings), 'complete draft shape');
    equal(shape(before), expectedBefore, 'original shape');
    const source = JSON.parse(packageBytes[spec.sourceRecordPath].toString('utf8'));
    const text = source.sourceDetails?.text;
    check(source.paperId === spec.paperId && source.sourceSnapshotSha256 === spec.sourceSnapshotSha256
        && typeof text === 'string' && sha(text) === spec.sourceTextSha256, 'original source record/text/snapshot');
    check(Buffer.isBuffer(pdfBytes) && sha(pdfBytes) === spec.pdfSha256
        && source.sourceSnapshotBinding?.sourceBinding?.pdfSha256 === spec.pdfSha256
        && source.sourceSnapshotBinding?.sourceBinding?.textSha256 === spec.sourceTextSha256, 'original PDF bytes/source binding');
    const window = spec.sourceWindow;
    check(window && Number.isInteger(window.startCodePoint) && Number.isInteger(window.endCodePoint)
        && window.startCodePoint >= 0 && window.endCodePoint > window.startCodePoint
        && sha(window.text) === window.sha256
        && Array.from(text).slice(window.startCodePoint, window.endCodePoint).join('') === window.text
        && text.indexOf(window.text) === text.lastIndexOf(window.text), 'one exact same-source original table window');
    const binding = spec.binding.newBinding;
    check(hash(binding) === spec.binding.newBindingSha256 && binding.tableIndex === 2
        && binding.sourceType === 'source_quotes' && binding.sourceTableOrdinal === null
        && Array.isArray(binding.cellBindings) && binding.cellBindings.length === 0
        && Array.isArray(binding.sourceQuotes) && binding.sourceQuotes.length > 0, 'exact new quoted-table binding');
    for (const quote of binding.sourceQuotes) check(typeof quote === 'string' && quote.length > 0
        && window.text.includes(quote), 'every appended quote exact within original table window');
    const body = before.sections[10].body;
    check(hash(body) === spec.body.oldNodeSha256, 'original section 10 body');
    const suffix = spec.body.appendText;
    check(typeof suffix === 'string' && suffix.startsWith('\n\n')
        && !/\[\[|!\[|<\s*(?:img|svg|math)\b|\$|\\(?:\[|\(|begin\b)|^#{1,6}\s/mu.test(suffix), 'no new image/formula/bridge/section in suffix');
    const appendedTables = extractMarkdownTables(suffix);
    check(appendedTables.length === 1 && appendedTables[0].header.length === 5, 'one real five-column appended table');
    const tableText = appendedTables[0].markdown;
    const tableStart = suffix.indexOf(tableText);
    check(tableStart > 0 && suffix.slice(0, tableStart).trim().length > 0
        && suffix.slice(tableStart + tableText.length).trim().length > 0, 'lead, original table, explanation required');
    const after = structuredClone(before);
    after.sections[10].body = body + suffix;
    after.tableBindings.push(structuredClone(binding));
    check(hash(after.sections[10].body) === spec.body.newNodeSha256, 'exact appended body SHA');
    equal(shape(after), expectedAfter, 'exact final shape');
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (key !== 'sections' && key !== 'tableBindings') equal(after[key], before[key], `protected draft field ${key}`);
    }
    equal(after.tableBindings.slice(0, 1), before.tableBindings, 'old binding unchanged');
    for (let index = 0; index < before.sections.length; index++) {
        const expected = structuredClone(before.sections[index]);
        if (index === 10) expected.body += suffix;
        equal(after.sections[index], expected, `protected section ${index}`);
    }
    equal(markers(after), markers(before), 'all existing figure/formula/bridge markers preserved');
    equal(tables(after)[0], tables(before)[0], 'old complete display table unchanged');
    check(hash(after) === spec.proposedDraftSha256, 'complete proposed draft SHA');
    return { draft: after, delta: { dataValidationOnly: true, specSha256,
        originalDraftSha256: spec.originalDraftSha256, proposedDraftSha256: spec.proposedDraftSha256,
        bodyPath: spec.body.path, oldBodySha256: spec.body.oldNodeSha256,
        newBodySha256: spec.body.newNodeSha256, appendTextSha256: sha(suffix),
        newBindingPath: spec.binding.path, newBindingSha256: spec.binding.newBindingSha256,
        shapeBefore: expectedBefore, shapeAfter: expectedAfter } };
}
module.exports = { appendPinnedSingleSourceTable };
