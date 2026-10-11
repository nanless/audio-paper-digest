'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../scripts/lib/reader-repair');

function createMissingFormulaBindingsSample() {
    const draft = {
        sections: [
            { kind: 'component', body: '[[FORMULA_1]]' },
            { kind: 'training', body: '导读\n\n[[FORMULA_7]]\n\n解释' }
        ],
        formulaBindings: [
            { formulaOrdinal: 1, targetKind: 'component', marker: '[[FORMULA_1]]' }
        ]
    };
    const issues = [{
        path: null,
        message: 'Reader source-binding v4 formulaBindings 未覆盖正文公式占位符'
    }];
    const context = repair.buildRepairContext(draft, issues, 'FORMULA_ORDINALS_AVAILABLE: [1,7]');
    const patch = {
        version: 1,
        draftSha256: repair.hashDraft(draft),
        replacements: [{
            path: '/formulaBindings',
            oldSha256: repair.hashDraft(draft.formulaBindings),
            value: [
                ...draft.formulaBindings,
                { formulaOrdinal: 7, targetKind: 'training', marker: '[[FORMULA_7]]' }
            ]
        }]
    };
    return { draft, issues, context, patch };
}

test('原正文缺一条公式来源时明确授权补齐，正文与旧记录保持不变', () => {
    const sample = createMissingFormulaBindingsSample();
    assert.deepEqual(sample.context.targets.map(target => target.path), ['/formulaBindings']);
    assert.equal(sample.context.atomicOperation.kind, 'complete_existing_formula_bindings_v1');
    const updated = repair.applyReaderPatch(sample.draft, sample.patch, ['/formulaBindings'], {
        atomicOperation: sample.context.atomicOperation
    });
    assert.deepEqual(updated.sections, sample.draft.sections);
    assert.deepEqual(updated.formulaBindings[0], sample.draft.formulaBindings[0]);
    assert.equal(updated.formulaBindings.length, 2);
});

test('补公式来源不接受改旧记录、伪编号、缺记录、改正文或无明确授权', () => {
    const sample = createMissingFormulaBindingsSample();
    for (const mutate of [
        patch => { patch.replacements[0].value[0].formulaOrdinal = 2; },
        patch => { patch.replacements[0].value[1].formulaOrdinal = 8; },
        patch => { patch.replacements[0].value.pop(); },
        patch => {
            patch.replacements.push({
                path: '/sections/1/body',
                oldSha256: repair.hashDraft(sample.draft.sections[1].body),
                value: '删除公式'
            });
        }
    ]) {
        const invalidPatch = structuredClone(sample.patch);
        mutate(invalidPatch);
        assert.throws(() => repair.applyReaderPatch(sample.draft, invalidPatch,
            ['/formulaBindings', '/sections/1/body'], {
                atomicOperation: sample.context.atomicOperation
            }));
    }
    assert.throws(() => repair.applyReaderPatch(sample.draft, sample.patch, ['/formulaBindings']));
    for (const mutate of [
        draft => { draft.sections[1].body += '\n\n[[FORMULA_7]]'; },
        draft => { draft.sections[1].body = '正文 [[FORMULA_7]]'; },
        draft => { draft.formulaBindings[0].marker = '[[FORMULA_2]]'; }
    ]) {
        const invalidDraft = structuredClone(sample.draft);
        mutate(invalidDraft);
        const invalidContext = repair.buildRepairContext(invalidDraft, sample.issues, '');
        assert.notEqual(invalidContext.atomicOperation?.kind, 'complete_existing_formula_bindings_v1');
    }
});

test('补齐公式后仍须绑定真实原始 TeX，缺来源和截断公式继续拒绝', () => {
    const cheerio = require('cheerio');
    const deep = require('../scripts/deep-analyzer');
    for (const lastLatex of ['x=7', 'x=']) {
        const html = '<html><body>' + Array.from({ length: 7 }, (_, index) => {
            const latex = index === 6 ? lastLatex : `x=${index + 1}`;
            return `<div class="ltx_equation" id="E${index + 1}"><math display="block"><semantics>`
                + `<mtext>${latex}</mtext><annotation encoding="application/x-tex">${latex}</annotation>`
                + '</semantics></math></div>';
        }).join('') + '</body></html>';
        const sourceText = cheerio.load(html)('body').text();
        const structuredArtifacts = deep.bindStructuredArtifactsToText(
            deep.parseArxivStructuredArtifactsFromHtml(html, '2601.90011', '2601.90011'), sourceText
        );
        const sample = createMissingFormulaBindingsSample();
        const updated = repair.applyReaderPatch(sample.draft, sample.patch, ['/formulaBindings'], {
            atomicOperation: sample.context.atomicOperation
        });
        const bind = () => deep.bindApiReaderSourceEvidence('[[FORMULA_1]]\n\n[[FORMULA_7]]', [],
            updated.formulaBindings, { sourceText, structuredArtifacts, sections: updated.sections });
        if (lastLatex === 'x=7') {
            const result = bind();
            assert.equal(result.formulaBindings[1].latex, 'x=7');
            assert.equal(result.formulaBindings[1].sourceDomSha256, structuredArtifacts.formulas[6].sourceDomSha256);
            assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(updated), {
                requiredVersion: 3, requireSourceBindings: true, sourceText, structuredArtifacts
            }), /readerTitle|oneSentenceThesis|sections/);
        } else {
            assert.throws(bind, /截断|不能猜补/);
        }
        assert.throws(() => deep.bindApiReaderSourceEvidence('[[FORMULA_1]]\n\n[[FORMULA_7]]', [],
            updated.formulaBindings, { sourceText, structuredArtifacts: {}, sections: updated.sections }));
    }
});


test('缺失的小编号公式只在末尾追加，动态指导完整保留原绑定前缀', () => {
    const sample = createMissingFormulaBindingsSample();
    sample.draft.formulaBindings = [sample.patch.replacements[0].value[1]];
    const context = repair.buildRepairContext(sample.draft, sample.issues, 'FORMULA_ORDINALS_AVAILABLE: [1,7]');
    const expectedBindings = [...sample.draft.formulaBindings, ...context.atomicOperation.missingBindings];
    assert.deepEqual(expectedBindings.map(binding => binding.formulaOrdinal), [7, 1]);
    assert.ok(context.targetGuidance.includes(`原记录前缀：${JSON.stringify(sample.draft.formulaBindings)}`));
    assert.ok(context.targetGuidance.includes(`完整数组：${JSON.stringify(expectedBindings)}`));
    assert.match(context.targetGuidance, /不要按公式编号排序/);
    const patch = {
        version: 1,
        draftSha256: repair.hashDraft(sample.draft),
        replacements: [{ path: '/formulaBindings', oldSha256: repair.hashDraft(sample.draft.formulaBindings), value: expectedBindings }]
    };
    const updated = repair.applyReaderPatch(sample.draft, patch, ['/formulaBindings'], { atomicOperation: context.atomicOperation });
    assert.deepEqual(updated.sections, sample.draft.sections);
    assert.deepEqual(updated.formulaBindings, expectedBindings);
    const sortedPatch = structuredClone(patch);
    sortedPatch.replacements[0].value.sort((left, right) => left.formulaOrdinal - right.formulaOrdinal);
    assert.throws(() => repair.applyReaderPatch(sample.draft, sortedPatch, ['/formulaBindings'], { atomicOperation: context.atomicOperation }));
    const unauthorizedContext = repair.buildRepairContext(sample.draft, [], '');
    assert.doesNotMatch(unauthorizedContext.targetGuidance, /完整数组：/);
});
