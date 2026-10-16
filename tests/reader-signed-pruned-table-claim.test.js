'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const bridge = require('../scripts/lib/reader-signed-pruned-table-claim');
const daily = require('../scripts/lib/daily-fresh-source-plan');
const repair = require('../scripts/lib/reader-repair');
const fixture = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/reader-signed-pruned-table-real-paid.json')));
const recas = x => {
    const p = x.record.parentPaper;
    p.apiReaderArticleSha256 = require('../scripts/lib/daily-fact-review').sha(p.apiReaderArticle);
    x.record.parentArticleSha256 = p.apiReaderArticleSha256;
    x.record.parentPaperSha256 = daily.stableHash(p);
};
const parentTable = x => require('../scripts/analysis-contract').extractMarkdownTables(x.record.parentPaper.apiReaderArticle)[2];
function changeParentTable(x, transform) {
    const before = parentTable(x).markdown, after = transform(before);
    x.record.parentPaper.apiReaderArticle = x.record.parentPaper.apiReaderArticle.replace(before, after);
    x.claim = after; recas(x);
}
test('真实paid与实际normal显示投影：唯一同序原表仅删一行，完整DOM24格目标可结构映射', () => {
    const x = fixture();
    assert.equal(x.notCanonicalCompletion, true);
    assert.equal(x.actualNormalArticleSha256, '52a5c7a1b30fda7eb078bb8c8efc00e54e80379609ea8de6a60304e10800a919');
    assert(x.rawClaim.includes('| 2 秒历史 |'));
    assert(!x.claim.includes('| 2 秒历史 |'));
    assert.equal(x.record.draft.tableBindings[2].cellBindings.length, 24);
    assert.equal(bridge.prunedTableProjectionMatches(x), true);
    // A display projection is not a paid replay or permission to apply it.
    for (const handle of [undefined, null, true, {}, Object.freeze({}), { normalProducerProof: true }])
        assert.equal(bridge.matchesPrunedTableClaim({ ...x, handle }), false);
    const signed = require('../scripts/lib/daily-reader-signed-correction');
    for (const handle of [undefined, {}, true]) assert.throws(() => signed.applyBoundedFactPatch(
        x.original, x.record, { readerFeedback: '受拒原表', rejectedReaderClaims: x.record.rangeCorrections
            .flatMap(r => r.edits).map(e => e.rawClaim || e.from), rejectedCoreClaims: [] }, x.source, handle));
});
test('父CAS、raw/table/node范围、非表文本、邻表、多表、表头、值和顺序均不能借删行映射', () => {
    const mutations = [
        x => { x.record.parentPaperSha256 = 'a'.repeat(64); },
        x => { x.record.parentArticleSha256 = 'a'.repeat(64); },
        x => { x.record.parentPlanSha256 = 'a'.repeat(64); },
        x => { x.record.tableCorrections[0].oldTableSha256 = 'a'.repeat(64); },
        x => { x.edit.start--; },
        x => { x.edit.end--; },
        x => { x.edit.from = '| 高召回点 |'; },
        x => { x.rawClaim = x.original.sections[10].body; },
        x => { x.range.path = '/sections/9/body'; },
        x => { x.original.sections.push({ body: x.rawClaim }); },
        x => { x.record.parentPaper.apiReaderArticle += '\n\n' + x.claim; recas(x); },
        x => { changeParentTable(x, text => text.replace('Conformer 覆盖', '错误表头')); },
        x => { changeParentTable(x, text => text.replace('58.6%', '58.7%')); },
        x => { changeParentTable(x, text => { const lines = text.split('\n'); return [...lines.slice(0, 2), ...lines.slice(2).reverse()].join('\n'); }); },
        x => { x.claim = require('../scripts/analysis-contract').extractMarkdownTables(x.record.parentPaper.apiReaderArticle)[1].markdown; },
        x => { x.record.tableCorrections.push(structuredClone(x.record.tableCorrections[0])); },
        x => { x.record.tableCorrections = []; },
        x => { x.record.tableCorrections[0].sourceDomSha256 = 'a'.repeat(64); },
        x => { x.record.tableCorrections[0].sourceTableSha256 = 'a'.repeat(64); },
    ];
    for (const [i, mutate] of mutations.entries()) {
        const x = fixture(); mutate(x);
        assert.equal(bridge.prunedTableProjectionMatches(x), false, 'mutation ' + i);
    }
});
test('目标只可为完整同DOM逐格矩阵：缺行、改cell、混坐标和改源DOM拒绝', () => {
    const mutations = [
        x => { x.record.draft.sections[10].body = x.record.draft.sections[10].body.replace('.604/.074', '.605/.074'); },
        x => { x.record.patch.replacements.find(r => r.path === '/tableBindings/2').value.cellBindings.pop(); },
        x => { x.record.patch.replacements.find(r => r.path === '/tableBindings/2').value.cellBindings[4].sourceRow++; },
        x => { x.source.structuredArtifacts.tables.find(t => t.ordinal === 3).cells[4].text = 'wrong'; },
        x => { const p = x.record.patch.replacements.find(r => r.path === '/tableBindings/2'); p.value.sourceTableOrdinal = 2; },
    ];
    for (const [i, mutate] of mutations.entries()) {
        const x = fixture(); mutate(x);
        let result = false; try { result = bridge.prunedTableProjectionMatches(x); } catch { /* strict DOM refusal */ }
        assert.equal(result, false, 'target mutation ' + i);
    }
    const x = fixture(), t = x.source.structuredArtifacts.tables.find(t => t.ordinal === 3);
    const body = x.record.draft.sections[10].body, old = require('../scripts/lib/reader-signed-table-targets').readerTableSlots(x.record.draft)[2].table.markdown;
    const shorter = old.split('\n').slice(0, -1).join('\n');
    x.record.draft.sections[10].body = body.replace(old, shorter);
    x.record.patch.replacements.find(r => r.path === '/tableBindings/2').value.cellBindings = x.record.patch.replacements.find(r => r.path === '/tableBindings/2').value.cellBindings.filter(c => c.sourceRow < t.matrix.length - 1);
    x.edit.to = shorter;
    assert.equal(bridge.prunedTableProjectionMatches(x), false);
    assert.equal(repair.hashDraft(x.original), x.record.baselineDraftSha256);
});
test('真实Table1显示不变，仅原quotes升级完整DOM25格，恰八节点且不借假受拒句', () => {
    const x = fixture(); x.proof = x.record.tableCorrections.find(p => p.bindingOnly === true);
    assert(x.proof);
    assert.equal(Object.hasOwn(x.proof, 'claimIndex'), false);
    assert.equal(x.record.patch.replacements.length, 8);
    assert.equal(new Set(x.record.patch.replacements.map(r => r.path)).size, 8);
    assert.equal(x.record.patch.replacements.some(r => r.path === x.proof.sectionPath), false);
    assert.equal(x.record.draft.sections[8].body, x.original.sections[8].body);
    assert.equal(x.record.draft.tableBindings[0].cellBindings.length, 25);
    assert.equal(bridge.identicalTableBindingProjectionMatches(x), true);
    for (const handle of [undefined, null, {}, true, { bindingOnly: true }])
        assert.equal(bridge.matchesIdenticalTableBinding({ ...x, handle }), false);
});
test('binding-only不接受正文授权/编辑、虚假claim、少行、错表、改数或非quotes原绑定', () => {
    const mutations = [
        x => { x.proof.bindingOnly = false; },
        x => { x.proof.claimIndex = 0; },
        x => { x.proof.path = '/tableBindings/1'; },
        x => { x.proof.oldTableSha256 = 'a'.repeat(64); },
        x => { x.original.tableBindings[0].sourceType = 'artifact_table'; },
        x => { x.original.tableBindings[0].sourceQuotes = []; },
        x => { x.record.draft.sections[8].body += '新正文。'; },
        x => { x.record.rangeCorrections.push({ path: x.proof.sectionPath, oldSha256: repair.hashDraft(x.original.sections[8].body), edits: [] }); },
        x => { x.record.patch.replacements.push({ path: x.proof.sectionPath, oldSha256: repair.hashDraft(x.original.sections[8].body), value: x.original.sections[8].body }); },
        x => { x.record.draft.sections[8].body = x.record.draft.sections[8].body.replace('0.0522', '0.0523'); },
        x => { x.proof.sourceTableOrdinal = 2; },
        x => { x.proof.sourceDomSha256 = 'a'.repeat(64); },
        x => { x.proof.sourceTableSha256 = 'a'.repeat(64); },
        x => { x.record.patch.replacements.find(r => r.path === '/tableBindings/0').value.cellBindings.pop(); },
        x => { x.record.parentPaper.apiReaderArticle = x.record.parentPaper.apiReaderArticle.replace('1.06×', '1.07×'); recas(x); },
        x => { x.original.sections.push({ body: require('../scripts/lib/reader-signed-table-targets').readerTableSlots(x.original)[0].table.markdown }); },
    ];
    for (const [i, mutate] of mutations.entries()) {
        const x = fixture(); x.proof = x.record.tableCorrections.find(p => p.bindingOnly === true); mutate(x);
        let result = false; try { result = bridge.identicalTableBindingProjectionMatches(x); } catch { /* strict source refusal */ }
        assert.equal(result, false, 'binding-only mutation ' + i);
    }
});
