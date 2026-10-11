'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');
const deep = require('../scripts/deep-analyzer');
const repair = require('../scripts/lib/reader-repair');
const order = require('../scripts/lib/reader-draft-order');
const versions = require('../scripts/lib/prompt-text-versions');

function createMissingBindingsSample() {
    const html = '<html><body>' + Array.from({ length: 3 }, (_, index) =>
        `<table><tr><th>Method</th><th>Score</th><th>Time</th><th>Task</th><th>Set</th></tr>`
        + `<tr><td>Baseline${index}</td><td>${index + 1}.5</td><td>12 ms</td><td>Speech</td><td>Test</td></tr></table>`).join('') + '</body></html>';
    const sourceText = cheerio.load(html)('body').text();
    const artifacts = deep.bindStructuredArtifactsToText(
        deep.parseArxivStructuredArtifactsFromHtml(html, '2610.90000', '2610.90000'), sourceText);
    const bindings = artifacts.tables.map((table, index) => ({ tableIndex: index + 1,
        sourceType: 'artifact_table', sourceTableOrdinal: table.ordinal, sourceQuotes: [],
        cellBindings: table.matrix.flatMap((row, rowIndex) => row.map((_, columnIndex) => ({
            renderedRow: rowIndex, renderedColumn: columnIndex, sourceRow: rowIndex, sourceColumn: columnIndex
        }))) }));
    const article = artifacts.tables.map(table => [
        `| ${table.matrix[0].join(' | ')} |`, '| --- | --- | --- | --- | --- |',
        ...table.matrix.slice(1).map(row => `| ${row.join(' | ')} |`)
    ].join('\n')).join('\n\n');
    const draft = { version: 3, sections: [{ kind: 'result', heading: '结果', body: article }],
        tableBindings: structuredClone(bindings.slice(0, 2)), conceptBridges: [], formulaBindings: [], figurePlacements: [] };
    const issues = [{ path: '/tableBindings/0', code: repair.TABLE_BINDING_ORDER_ISSUE_CODE,
        message: '正文表格与来源记录不能一一对应' }];
    const context = repair.buildRepairContext(draft, issues, '完整封存证据', sourceText);
    const patch = { version: 1, draftSha256: repair.hashDraft(draft), replacements: [{
        path: '/tableBindings', oldSha256: repair.hashDraft(draft.tableBindings), value: bindings
    }] };
    return { draft, bindings, sourceText, artifacts, article, context, patch };
}
function applySample(sample, patch = sample.patch) {
    return repair.applyReaderPatch(sample.draft, patch, sample.context.targets.map(target => target.path),
        { atomicOperation: sample.context.atomicOperation });
}

test('只补现有表的绑定且真实公共DOM来源检查通过，全文检查不能跳过', () => {
    const sample = createMissingBindingsSample();
    assert.deepEqual(sample.context.targets.map(target => target.path), ['/tableBindings']);
    assert.equal(sample.context.atomicOperation.kind, 'complete_existing_table_bindings_v1');
    assert.deepEqual(sample.context.atomicOperation.mutableBindingIndices, [0]);
    const updated = applySample(sample);
    assert.deepEqual(updated.sections, sample.draft.sections);
    assert.deepEqual(updated.tableBindings[1], sample.draft.tableBindings[1]);
    const bound = deep.bindApiReaderSourceEvidence(sample.article, updated.tableBindings, [],
        { sourceText: sample.sourceText, structuredArtifacts: sample.artifacts });
    assert.equal(bound.tableBindings.length, 3);
    assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(updated), {
        requiredVersion: 3, requireIntegratedTables: true, requireSourceBindings: true,
        sourceText: sample.sourceText, structuredArtifacts: sample.artifacts
    }), /readerTitle|至少|sections|oneSentenceThesis/);
});

test('允许明确诊断的错绑修正，未诊断旧绑定、正文、计数和旧SHA仍严格保留', () => {
    const sample = createMissingBindingsSample();
    sample.draft.tableBindings[0].sourceTableOrdinal = 99;
    sample.patch.draftSha256 = repair.hashDraft(sample.draft);
    sample.patch.replacements[0].oldSha256 = repair.hashDraft(sample.draft.tableBindings);
    const fixed = applySample(sample);
    assert.equal(fixed.tableBindings[0].sourceTableOrdinal, 1);
    for (const mutate of [
        patch => { patch.replacements[0].value[1].sourceTableOrdinal = 99; },
        patch => { patch.replacements[0].value.pop(); },
        patch => { patch.replacements[0].value.push({ ...patch.replacements[0].value[2], tableIndex: 4 }); },
        patch => { patch.replacements[0].value[2].tableIndex = 2; },
        patch => { patch.replacements[0].oldSha256 = 'a'.repeat(64); },
        patch => { patch.replacements.push({ path: '/sections/0/body', oldSha256: repair.hashDraft(sample.article), value: '' }); }
    ]) {
        const patch = structuredClone(sample.patch);
        mutate(patch);
        assert.throws(() => applySample(sample, patch));
    }
});

test('新增绑定不能绕过真实数字、单位、DOM缺格和来源SHA检查', () => {
    for (const mutate of [
        bindings => { bindings[2].cellBindings.pop(); },
        bindings => { bindings[2].cellBindings[0].sourceColumn = 99; },
        bindings => { bindings[2] = { tableIndex: 3, sourceType: 'source_quotes', sourceTableOrdinal: null,
            cellBindings: [], sourceQuotes: ['A fabricated score is 999 without any real evidence.'] }; }
    ]) {
        const sample = createMissingBindingsSample();
        mutate(sample.patch.replacements[0].value);
        const updated = applySample(sample);
        assert.throws(() => deep.bindApiReaderSourceEvidence(sample.article, updated.tableBindings, [],
            { sourceText: sample.sourceText, structuredArtifacts: sample.artifacts }));
    }
    const sample = createMissingBindingsSample();
    const updated = applySample(sample);
    for (const article of [sample.article.replace('3.5', '999'), sample.article.replace('12 ms', '12 s')]) {
        assert.throws(() => deep.bindApiReaderSourceEvidence(article, updated.tableBindings, [],
            { sourceText: sample.sourceText, structuredArtifacts: sample.artifacts }));
    }
    const badSource = structuredClone(sample.artifacts);
    badSource.payloadSha256 = 'f'.repeat(64);
    assert.throws(() => deep.bindApiReaderSourceEvidence(sample.article, updated.tableBindings, [],
        { sourceText: sample.sourceText, structuredArtifacts: badSource }));
});

test('缺口不明确或选择标记位置错误时不授权新增绑定；旧提示词保持冻结', () => {
    const sample = createMissingBindingsSample();
    assert.equal(repair.buildRepairContext(sample.draft, [], '').atomicOperation, null);
    sample.draft.sections[0].body += '\n\n[[TABLE_4]]';
    assert.equal(repair.buildRepairContext(sample.draft, sample.context.issues, '').atomicOperation, null);
    assert.equal(versions.currentPromptTextContract('apiReaderRepair'), 'analysis-prompt-text-v7');
    assert.equal(versions.currentTextStagePromptPath('apiReaderRepair'), 'prompts/api-reader-repair-v7.md');
    assert.equal(versions.promptFilePathForContract('apiReaderRepair', 'analysis-prompt-text-v5'), 'prompts/api-reader-repair-v5.md');
    assert.equal(deep.runtimePromptTemplateSha256('prompts/api-reader-repair-v5.md'),
        '89faba16d2b3af5a1549e13c85800bc7301d3a4217a1d9ae362b33c76cff9a34');
    assert.notEqual(deep.runtimePromptTemplateSha256('prompts/api-reader-repair-v6.md'),
        deep.runtimePromptTemplateSha256('prompts/api-reader-repair-v5.md'));
});

function createMixedMissingBindingsSample() {
    const sample = createMissingBindingsSample();
    const firstTable = order.locateReaderDraftTables(sample.draft)[0].table.markdown;
    sample.draft.sections[0].body = sample.draft.sections[0].body.replace(firstTable, '[[TABLE_1]]');
    const selectionBinding = { tableIndex: 1, selection: {
        sourceTableOrdinal: 1, sourceRows: [0, 1], sourceColumns: [0, 1, 2, 3, 4]
    } };
    sample.draft.tableBindings[0] = selectionBinding;
    sample.bindings[0] = structuredClone(selectionBinding);
    const issues = [{ path: '/tableBindings/0', code: repair.TABLE_BINDING_ORDER_ISSUE_CODE,
        message: '正文表格与来源记录不能一一对应' }];
    sample.context = repair.buildRepairContext(sample.draft, issues, sample.sourceText, sample.sourceText);
    sample.patch = { version: 1, draftSha256: repair.hashDraft(sample.draft), replacements: [{
        path: '/tableBindings', oldSha256: repair.hashDraft(sample.draft.tableBindings), value: sample.bindings
    }] };
    return sample;
}

test('原选择标记位置完整时只补普通表绑定，原正文和选择来源逐字保留', () => {
    const sample = createMixedMissingBindingsSample();
    assert.deepEqual(sample.context.targets.map(target => target.path), ['/tableBindings']);
    assert.equal(sample.context.atomicOperation.kind, 'complete_existing_table_bindings_v1');
    assert.deepEqual(sample.context.atomicOperation.mutableBindingIndices, []);
    const updated = applySample(sample);
    assert.deepEqual(updated.sections, sample.draft.sections);
    assert.deepEqual(updated.tableBindings[0], sample.draft.tableBindings[0]);
    const compiled = require('../scripts/lib/reader-tables').compileReaderTableSelections(
        updated.sections, updated.tableBindings, sample.artifacts);
    const article = compiled.sections.map(section => section.body).join('\n\n');
    const bound = deep.bindApiReaderSourceEvidence(article, compiled.tableBindings, [], {
        sourceText: sample.sourceText, structuredArtifacts: sample.artifacts
    });
    assert.equal(bound.tableBindings.length, 3);
    assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(updated), {
        requiredVersion: 3, requireIntegratedTables: true, requireSourceBindings: true,
        sourceText: sample.sourceText, structuredArtifacts: sample.artifacts
    }), /readerTitle|至少|sections|oneSentenceThesis/);
});

test('混排补绑定不接受旧选择来源变动、错序标记、重复标记和伪造新增来源', () => {
    const sample = createMixedMissingBindingsSample();
    const changedSelection = structuredClone(sample.patch);
    changedSelection.replacements[0].value[0].selection.sourceRows = [0, 99];
    assert.throws(() => applySample(sample, changedSelection));
    const fakeBinding = structuredClone(sample.patch);
    fakeBinding.replacements[0].value[2].cellBindings.pop();
    const updated = applySample(sample, fakeBinding);
    const compiled = require('../scripts/lib/reader-tables').compileReaderTableSelections(
        updated.sections, updated.tableBindings, sample.artifacts);
    assert.throws(() => deep.bindApiReaderSourceEvidence(compiled.sections[0].body,
        compiled.tableBindings, [], { sourceText: sample.sourceText, structuredArtifacts: sample.artifacts }));
    for (const mutate of [
        draft => { draft.sections[0].body = draft.sections[0].body.replace('[[TABLE_1]]', '[[TABLE_2]]'); },
        draft => { draft.sections[0].body += '\n\n[[TABLE_1]]'; },
        draft => { draft.sections[0].body = draft.sections[0].body.replace('[[TABLE_1]]', '正文 [[TABLE_1]]'); }
    ]) {
        const invalidDraft = structuredClone(sample.draft);
        mutate(invalidDraft);
        const context = repair.buildRepairContext(invalidDraft, sample.context.issues, sample.sourceText, sample.sourceText);
        assert.notEqual(context.atomicOperation?.kind, 'complete_existing_table_bindings_v1');
    }
});
