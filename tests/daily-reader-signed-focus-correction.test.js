'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const repair = require('../scripts/lib/reader-repair');
const facts = require('../scripts/lib/daily-fact-review');
const signed = require('../scripts/lib/daily-reader-signed-correction');
const codec = require('../scripts/lib/protocol-codec');
function sample() {
    const bodyClaim = '绿色为调用率，紫色为条件成功率。', focusClaim = '对比绿色调用率与紫色条件成功率。';
    const body = bodyClaim + '\n\n[[FIGURE_4]]\n\n解释保持。';
    const original = { sections: [{ kind: 'result', body }], conceptBridges: [],
        figurePlacements: [{ figureOrdinal: 4, targetKind: 'result', marker: '[[FIGURE_4]]', focusPoints: [focusClaim, '其余要点保持。'] }],
        tableBindings: [], formulaBindings: [] };
    const source = { text: 'Figure 4: Call and conditional pass rate.', freshSourceDescriptor: { runId: 'same-real-run' },
        structuredArtifacts: { figures: [{ ordinal: 4, sourceDomSha256: 'a'.repeat(64), recoveryStatus: 'complete',
            images: [{ url: 'https://example.org/figure4.svg' }] }] } };
    const feedback = { readerFeedback: '同一图的正文和要点颜色对应应交换。', coreFeedback: '', rejectedCoreClaims: [],
        rejectedReaderClaims: [bodyClaim, focusClaim] };
    const edits = (value, claimIndex) => [
        { claimIndex, claimStart: 0, start: value.indexOf('绿色'), end: value.indexOf('绿色') + 2, from: '绿色', to: '紫色' },
        { claimIndex, claimStart: 0, start: value.indexOf('紫色'), end: value.indexOf('紫色') + 2, from: '紫色', to: '绿色' }
    ];
    const swap = value => value.replace('绿色', '暂存').replace('紫色', '绿色').replace('暂存', '紫色');
    const draft = structuredClone(original); draft.sections[0].body = swap(body); draft.figurePlacements[0].focusPoints[0] = swap(focusClaim);
    const record = { ...codec.recordHeader(signed.FACT_CONTRACT, signed.FACT_CONTRACT),
        parentPaper: { apiReaderArticle: body, apiReaderPlan: { figurePlacements: original.figurePlacements.map(figure => ({
            ...structuredClone(figure), leadQuote: bodyClaim, explanationQuote: '解释保持。' })) },
            apiReaderFigures: [{ ordinal: 4, sourceDomSha256: 'a'.repeat(64), assetSha256: 'b'.repeat(64), url: 'https://example.org/figure4.svg' }] },
        sourceDescriptor: structuredClone(source.freshSourceDescriptor), sourceFiles: { 'source.txt': facts.sha(source.text) }, draft,
        rangeCorrections: [{ path: '/sections/0/body', oldSha256: repair.hashDraft(body), edits: edits(body, 0) },
            { path: '/figurePlacements/0/focusPoints/0', oldSha256: repair.hashDraft(focusClaim), edits: edits(focusClaim, 1) }],
        focusCorrections: [{ path: '/figurePlacements/0/focusPoints/0', sectionPath: '/sections/0/body', bodyClaimIndex: 0,
            figureOrdinal: 4, sourceDomSha256: 'a'.repeat(64), assetSha256: 'b'.repeat(64) }], tableCorrections: [],
        patch: { version: 1, draftSha256: repair.hashDraft(original), replacements: [
            { path: '/sections/0/body', oldSha256: repair.hashDraft(body), value: draft.sections[0].body },
            { path: '/figurePlacements/0/focusPoints/0', oldSha256: repair.hashDraft(focusClaim), value: draft.figurePlacements[0].focusPoints[0] }] } };
    return { original, record, feedback, source };
}
test('only an existing source-bound focus leaf can follow its actually corrected same-figure body claim', () => {
    const x = sample(), before = structuredClone(x.original);
    assert.equal(x.record.parentPaper.apiReaderArticle.includes(x.feedback.rejectedReaderClaims[1]), false);
    assert.deepEqual(signed.applyBoundedFactPatch(x.original, x.record, x.feedback, x.source), x.record.draft);
    assert.deepEqual(x.original, before);
    assert.deepEqual(x.record.draft.figurePlacements[0].focusPoints.slice(1), x.original.figurePlacements[0].focusPoints.slice(1));
});
test('missing, duplicate, unused, cross-figure or non-source focus permissions all fail closed', () => {
    for (const mutate of [
        x => { delete x.record.focusCorrections; },
        x => { x.record.focusCorrections.push(structuredClone(x.record.focusCorrections[0])); },
        x => { x.record.focusCorrections[0].path = '/figurePlacements/0/focusPoints/1'; },
        x => { x.record.focusCorrections[0].extra = true; },
        x => { x.record.focusCorrections[0].figureOrdinal = 3; },
        x => { x.record.focusCorrections[0].bodyClaimIndex = 1; },
        x => { x.record.focusCorrections[0].sourceDomSha256 = 'c'.repeat(64); },
        x => { x.record.focusCorrections[0].assetSha256 = 'c'.repeat(64); },
        x => { x.record.parentPaper.apiReaderPlan.figurePlacements[0].focusPoints[0] += 'changed'; },
        x => { x.record.parentPaper.apiReaderPlan.figurePlacements[0].leadQuote = '同一小节中另一张图片的导读。'; },
        x => { x.record.parentPaper.apiReaderFigures[0].url += '.wrong'; },
        x => { x.source.structuredArtifacts.figures[0].sourceDomSha256 = 'c'.repeat(64); },
        x => { x.source.text += 'changed'; },
        x => { x.source.freshSourceDescriptor.runId = 'foreign-run'; },
        x => { x.original.sections[0].kind = 'limitation'; },
        x => { x.original.sections[0].body += '\n\n[[FIGURE_4]]'; },
        x => { x.record.rangeCorrections.shift(); x.record.patch.replacements.shift(); },
        x => { x.record.rangeCorrections[0].edits = []; },
        x => { x.record.rangeCorrections[1].edits[0].rawClaim = x.feedback.rejectedReaderClaims[1]; },
        x => { x.record.rangeCorrections[1].edits[0].claimIndex = 0; },
        x => { x.record.rangeCorrections[1].oldSha256 = 'c'.repeat(64); }
    ]) {
        const x = sample(); mutate(x);
        assert.throws(() => signed.applyBoundedFactPatch(x.original, x.record, x.feedback, x.source));
    }
});
test('focus authority cannot edit a group, reorder points, alter image identity or inject another node', () => {
    for (const mutate of [
        x => { x.record.patch.replacements[1].path = '/figurePlacements/0'; },
        x => { x.record.draft.figurePlacements[0].focusPoints.reverse(); },
        x => { x.record.draft.figurePlacements[0].focusPoints.push('新增要点。'); },
        x => { x.record.draft.figurePlacements[0].figureOrdinal = 5; },
        x => { x.record.draft.figurePlacements[0].marker = '[[FIGURE_5]]'; },
        x => { x.record.draft.figurePlacements[0].targetKind = 'limitation'; },
        x => { x.record.draft.figurePlacements[0].leadQuote = '新增导读。'; },
        x => { x.record.rangeCorrections[1].path = '/figurePlacements/0/focusPoints/2'; }
    ]) {
        const x = sample(); mutate(x);
        assert.throws(() => signed.applyBoundedFactPatch(x.original, x.record, x.feedback, x.source));
    }
});
test('records without focus authorization keep the previous body-only path and terminology cannot carry it', () => {
    const x = sample(); delete x.record.focusCorrections;
    x.record.rangeCorrections.pop(); x.record.patch.replacements.pop();
    x.record.draft.figurePlacements = structuredClone(x.original.figurePlacements);
    assert.deepEqual(signed.applyBoundedFactPatch(x.original, x.record, x.feedback, x.source), x.record.draft);
    assert.throws(() => signed.applyBoundedTextPatch(x.original, { focusCorrections: [] }), /只允许来源绑定事实修正/);
});
