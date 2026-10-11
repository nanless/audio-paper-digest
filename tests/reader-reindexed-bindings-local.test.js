'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');
const deep = require('../scripts/deep-analyzer');
const repair = require('../scripts/lib/reader-repair');
const tables = require('../scripts/lib/reader-tables');

function createReindexedBindingsSample() {
    const html = '<html><body>' + [1, 2, 3].map(value =>
        `<table><tr><th>Method</th><th>Score</th></tr><tr><td>Model${value}</td><td>${value}.5</td></tr></table>`
    ).join('') + '</body></html>';
    const sourceText = cheerio.load(html)('body').text();
    const structuredArtifacts = deep.bindStructuredArtifactsToText(
        deep.parseArxivStructuredArtifactsFromHtml(html, '2610.90002', '2610.90002'), sourceText);
    const bindings = structuredArtifacts.tables.map((table, index) => ({
        tableIndex: index + 1,
        sourceType: 'artifact_table',
        sourceTableOrdinal: table.ordinal,
        sourceQuotes: [],
        cellBindings: table.matrix.flatMap((row, rowIndex) => row.map((_, columnIndex) => ({
            renderedRow: rowIndex,
            renderedColumn: columnIndex,
            sourceRow: rowIndex,
            sourceColumn: columnIndex
        })))
    }));
    const bodies = structuredArtifacts.tables.slice(0, 2).map(table =>
        `| ${table.matrix[0].join(' | ')} |\n| --- | --- |\n| ${table.matrix[1].join(' | ')} |`);
    const oldSelection = { tableIndex: 2, selection: {
        sourceTableOrdinal: 3, sourceRows: [0, 1], sourceColumns: [0, 1]
    } };
    const draft = {
        sections: [{ kind: 'result', body: bodies.join('\n\n') + '\n\n[[TABLE_2]]\n\n解释保留' }],
        tableBindings: [bindings[0], oldSelection]
    };
    const issues = [{ code: repair.TABLE_BINDING_ORDER_ISSUE_CODE, path: null,
        message: '正文表格与来源记录不能一一对应' }];
    const context = repair.buildRepairContext(draft, issues, sourceText, sourceText);
    const patch = {
        version: 1,
        draftSha256: repair.hashDraft(draft),
        replacements: [
            { path: '/tableBindings', oldSha256: repair.hashDraft(draft.tableBindings),
                value: [bindings[0], bindings[1], { ...oldSelection, tableIndex: 3 }] },
            { path: '/sections/0/body', oldSha256: repair.hashDraft(draft.sections[0].body),
                value: draft.sections[0].body.replace('[[TABLE_2]]', '[[TABLE_3]]') }
        ]
    };
    return { draft, issues, context, patch, structuredArtifacts, sourceText };
}

function applySample(sample, patch = sample.patch) {
    return repair.applyReaderPatch(sample.draft, patch, sample.context.targets.map(target => target.path), {
        atomicOperation: sample.context.atomicOperation,
        structuredArtifacts: sample.structuredArtifacts
    });
}

test('错序原选择只改标记编号并原样移动，现有普通表补齐完整DOM来源', () => {
    const sample = createReindexedBindingsSample();
    assert.equal(sample.context.atomicOperation.kind, 'complete_reindexed_table_bindings_v1');
    assert.deepEqual(sample.context.targets.map(target => target.path), ['/tableBindings', '/sections/0/body']);
    const updated = applySample(sample);
    assert.deepEqual(updated.tableBindings[2].selection, sample.draft.tableBindings[1].selection);
    assert.deepEqual(updated.tableBindings[0], sample.draft.tableBindings[0]);
    assert.equal(updated.sections[0].body.replace('[[TABLE_3]]', '[[TABLE_2]]'), sample.draft.sections[0].body);
    const compiled = tables.compileReaderTableSelections(updated.sections, updated.tableBindings, sample.structuredArtifacts);
    const bound = deep.bindApiReaderSourceEvidence(compiled.sections[0].body, compiled.tableBindings, [], {
        sourceText: sample.sourceText, structuredArtifacts: sample.structuredArtifacts
    });
    assert.equal(bound.tableBindings.length, 3);
});

test('移位补绑定拒绝删改旧选择、错序、正文变化、重复标记和伪造新来源', () => {
    const sample = createReindexedBindingsSample();
    for (const mutate of [
        patch => { patch.replacements[0].value.pop(); },
        patch => { patch.replacements[0].value.reverse(); },
        patch => { patch.replacements[0].value[2].selection.sourceRows = [0, 99]; },
        patch => { patch.replacements[0].value[0].sourceTableOrdinal = 3; },
        patch => { patch.replacements[1].value += '\n删除解释'; },
        patch => { patch.replacements[1].value = patch.replacements[1].value.replace('TABLE_3', 'TABLE_4'); }
    ]) {
        const invalidPatch = structuredClone(sample.patch);
        mutate(invalidPatch);
        assert.throws(() => applySample(sample, invalidPatch));
    }
    const duplicateDraft = structuredClone(sample.draft);
    duplicateDraft.sections[0].body += '\n\n[[TABLE_2]]';
    assert.notEqual(repair.buildRepairContext(duplicateDraft, sample.issues, '').atomicOperation?.kind,
        'complete_reindexed_table_bindings_v1');
    const unsupportedDraft = structuredClone(sample.draft);
    unsupportedDraft.tableBindings[1] = { tableIndex: 2, sourceType: 'source_quotes', sourceQuotes: ['A quoted source without selection'] };
    assert.notEqual(repair.buildRepairContext(unsupportedDraft, sample.issues, '').atomicOperation?.kind,
        'complete_reindexed_table_bindings_v1');
    const fakePatch = structuredClone(sample.patch);
    fakePatch.replacements[0].value[1].cellBindings.pop();
    const updated = applySample(sample, fakePatch);
    const compiled = tables.compileReaderTableSelections(updated.sections, updated.tableBindings, sample.structuredArtifacts);
    assert.throws(() => deep.bindApiReaderSourceEvidence(compiled.sections[0].body, compiled.tableBindings, [], {
        sourceText: sample.sourceText, structuredArtifacts: sample.structuredArtifacts
    }));
});
