'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../scripts/lib/reader-repair');
const deep = require('../scripts/deep-analyzer');
function createMissingFormulaSample(count = 12) {
    const sample = require('./reader-signed-draft-fixture').fixture({ noFigures: true });
    const section = sample.draft.sections.find(section => section.kind === 'component');
    for (let ordinal = 2; ordinal <= count; ordinal += 1) section.body += `\n\n[[FORMULA_${ordinal}]]`;
    const rawArtifacts = structuredClone(sample.sourceDetails.structuredArtifacts);
    delete rawArtifacts.payloadSha256;
    rawArtifacts.formulas = Array.from({ length: count }, (_, index) => ({ ordinal: index + 1,
        latex: `y=x_${index + 1}.`, recoveryStatus: 'complete', sourceDomSha256: repair.shaText(`原始公式单元${index + 1}`) }));
    sample.artifacts = deep.bindStructuredArtifactsToText(rawArtifacts, sample.sourceDetails.text);
    return sample;
}
const issues = [{ message: 'Reader source-binding v4 formulaBindings 未覆盖正文公式占位符' }];
function applyAppend(sample) {
    const context = repair.buildRepairContext(sample.draft, issues, '完整原始公式证据');
    assert.equal(context.atomicOperation.kind, 'complete_existing_formula_bindings_v1');
    const value = [...sample.draft.formulaBindings, ...context.atomicOperation.missingBindings];
    const patch = { version: 1, draftSha256: repair.hashDraft(sample.draft), replacements: [{ path: '/formulaBindings',
        oldSha256: repair.hashDraft(sample.draft.formulaBindings), value }] };
    return { context, patch, merged: repair.applyReaderPatch(sample.draft, patch, ['/formulaBindings'], { atomicOperation: context.atomicOperation }) };
}
test('缺少七项以上公式绑定仍可在唯一数组目标内补齐，旧记录和正文保持', () => {
    const sample = createMissingFormulaSample();
    const { context, merged } = applyAppend(sample);
    assert.deepEqual(context.targets.map(target => target.path), ['/formulaBindings']);
    assert.equal(merged.formulaBindings.length, 12);
    assert.deepEqual(merged.formulaBindings.slice(0, sample.draft.formulaBindings.length), sample.draft.formulaBindings);
    for (const field of ['sections','conceptBridges','tableBindings','figurePlacements','readerTitle','oneSentenceThesis']) assert.deepEqual(merged[field], sample.draft[field]);
    const result = deep.bindApiReaderSourceEvidence(merged.formulaBindings.map(binding => binding.marker).join('\n\n'), [], merged.formulaBindings,
        { structuredArtifacts: sample.artifacts, sourceText: sample.sourceDetails.text, sections: merged.sections });
    assert.equal(result.formulaBindings.length, 12);
    const parsed = deep.parseApiReaderArticleResult(JSON.stringify(merged), { requiredVersion: 3,
        requireSourceBindings: true, structuredArtifacts: sample.artifacts,
        sourceText: sample.sourceDetails.text, availableFigureOrdinals: [] });
    assert.equal(parsed.plan.formulaBindings.length, 12);
    assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(merged), { requiredVersion: 3,
        requireSourceBindings: true, structuredArtifacts: sample.sourceDetails.structuredArtifacts,
        sourceText: sample.sourceDetails.text, availableFigureOrdinals: [] }), /来源或 marker 非法/);
    assert.throws(() => deep.bindApiReaderSourceEvidence(merged.formulaBindings.map(binding => binding.marker).join('\n\n'), [], merged.formulaBindings,
        { structuredArtifacts: sample.sourceDetails.structuredArtifacts, sourceText: sample.sourceDetails.text, sections: merged.sections }), /来源或 marker 非法/);
});
test('总数十六的上限、重复标记和旧记录错位仍拒，不能借补齐删除或重排旧前缀', () => {
    for (const mutate of [sample => { sample.draft.sections[4].body += '\n\n[[FORMULA_2]]'; }, sample => { sample.draft.formulaBindings[0].targetKind = 'result'; }]) {
        const sample = createMissingFormulaSample();
        mutate(sample);
        assert.notEqual(repair.buildRepairContext(sample.draft, issues, '原文').atomicOperation?.kind, 'complete_existing_formula_bindings_v1');
    }
    const tooMany = createMissingFormulaSample(17);
    assert.notEqual(repair.buildRepairContext(tooMany.draft, issues, '原文').atomicOperation?.kind, 'complete_existing_formula_bindings_v1');
    const sample = createMissingFormulaSample();
    const { context, patch } = applyAppend(sample);
    patch.replacements[0].value.reverse();
    assert.throws(() => repair.applyReaderPatch(sample.draft, patch, ['/formulaBindings'], { atomicOperation: context.atomicOperation }), /不能改旧记录/);
    assert.throws(() => repair.applyReaderPatch(sample.draft, patch, ['/formulaBindings']), /明确补齐授权/);
});

test('坏旧绑定不是可补齐前缀，null或异常类型只能留给严格普通修复', () => {
    for (const invalid of [null, 1, [], {}, { formulaOrdinal: 1, targetKind: 'component', marker: '[[FORMULA_1]]', unknown: '不得删除的内容' }]) {
        const sample = createMissingFormulaSample();
        sample.draft.formulaBindings[0] = invalid;
        assert.notEqual(repair.buildRepairContext(sample.draft, issues, '原文').atomicOperation?.kind,
            'complete_existing_formula_bindings_v1');
    }
});
