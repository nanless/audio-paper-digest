'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../scripts/lib/reader-repair');
const sha = 'a'.repeat(64);
function source(matrix, ordinal) {
    return { ordinal, caption: 'Actual comparison', recoveryStatus: 'complete', sourceDomSha256: sha,
        matrix, headerRows: [0], bodyRows: matrix.slice(1).map((_, i) => i + 1),
        cells: matrix.flatMap((row, r) => row.map((text, c) => ({ row: r, column: c, text,
            header: r === 0, rowspan: 1, colspan: 1, sourceDomSha256: sha }))) };
}
function input(binding, body = 'Compare the systems.\n\n[[TABLE_1]]\n\nKeep the limitations.') {
    return { sections: [{kind: 'result', heading: 'Results', body}], tableBindings: [binding],
        conceptBridges: [], figurePlacements: [], formulaBindings: [] };
}
const issue = { path: '/tableBindings/0', code: 'reader_source_table_unrenderable', message: 'source_table cannot be rendered' };
const targets = [{ path: '/tableBindings/0' }, { path: '/sections/0/body' }];
function packet(guidance) {
    const line = guidance.split('\n').find(line => line.startsWith('当前封存来源'));
    return JSON.parse(line.slice(line.indexOf('：') + 1));
}
test('合法完整原表及真实能力进入局部反馈，坏格不能冒充可用候选', () => {
    const draft = input({tableIndex: 1, completeTable: {sourceTableOrdinal: 1}});
    const artifacts = {tables: [source([['Method','Score'], ['Alpha','0.10.1']], 1),
        source([['','PCC','RMSE'], ['A','0.934','5.21']], 2)]};
    const before = JSON.stringify({draft, artifacts});
    const originalText = 'Alpha measured original result is 0.10.1 exactly, with the duplicated number preserved.';
    const result = repair.repairTableEvidenceGuidance(draft, [issue], targets, originalText, {structuredArtifacts: artifacts});
    const rows = packet(result);
    assert.equal(rows[0].diagnosticOnly, true);
    assert.equal(rows[0].originalCompleteTableEligibility.eligible, false);
    assert.deepEqual(rows[0].usableSourceTables.map(t => t.sourceTableOrdinal), [2]);
    assert.deepEqual(rows[0].usableSourceTables[0].matrix, artifacts.tables[1].matrix);
    assert.equal(rows[0].usableSourceTables[0].selectionEligibility.eligible, false);
    assert.equal(rows[0].usableSourceTables[0].completeTableEligibility.eligible, true);
    assert.equal(rows[0].sourceQuoteCoverageAttested, false);
    assert.ok(rows[0].originalSourceQuoteWindows.length > 0);
    assert.ok(rows[0].originalSourceQuoteWindows.every(row => originalText.includes(row.quote)));
    assert.equal(JSON.stringify({draft, artifacts}), before);
});
test('反馈只在唯一承载正文成对授权时产生，诊断不能扩大局部范围', () => {
    const draft = input({tableIndex: 1, completeTable: {sourceTableOrdinal: 1}});
    const options = {structuredArtifacts: {tables: [source([['A','B'],['x','1']], 1)]}};
    assert.equal(repair.repairTableEvidenceGuidance(draft, [issue], targets.slice(0, 1), 'Original evidence text.', options), '');
    assert.equal(repair.repairTableEvidenceGuidance(draft, [issue], targets.slice(1), 'Original evidence text.', options), '');
    const before = repair.buildRepairTargets(draft, [issue], options).map(t => t.path);
    repair.repairTableEvidenceGuidance(draft, [issue], targets, 'Original evidence text.', options);
    assert.deepEqual(repair.buildRepairTargets(draft, [issue], options).map(t => t.path), before);
});
test('非逐字引文明确提示失败、真实原句保留裸双写，不能认可猜半值', () => {
    const clean = 'Original experimental comparison reports PCC values of 0.88 and 0.89.';
    const raw = 'Original experimental comparison reports PCC values of 0.880.88 and 0.890.89.';
    const body = '| Method | PCC |\n| --- | --- |\n| A | 0.88 |\n| B | 0.89 |';
    const draft = input({tableIndex:1,sourceType:'source_quotes',sourceTableOrdinal:null,cellBindings:[],sourceQuotes:[clean]},body);
    const options = {structuredArtifacts:{tables:[]}};
    const result = repair.repairTableEvidenceGuidance(draft, [{path:null,message:'读者文章宽表不足'}],targets,raw,options);
    const row = packet(result)[0];
    assert.equal(row.declaredQuotes[0].exact,false);
    assert.deepEqual(row.missingCells.map(c=>c.missingTokens),[['0.88'],['0.89']]);
    assert.equal(row.rawQuoteWindows[0].quote,raw);
    assert.equal(row.rawQuoteWindows[0].coverageAttested,false);
    assert.match(result,/不得删副本、猜半值/);
    assert.equal(repair.repairTableEvidenceGuidance(draft,[],targets,raw,options),'');
    const exactDraft = structuredClone(draft); exactDraft.tableBindings[0].sourceQuotes=[clean];
    assert.equal(packet(repair.repairTableEvidenceGuidance(exactDraft,[{message:'宽表'}],targets,clean,options))[0].missingCells.length,0);
});
test('完整再生反馈只解释真实请求授权，大表不会截取部分却冒称完整候选', () => {
    const draft=input({tableIndex:1,completeTable:{sourceTableOrdinal:1}});
    const large=source([['A','B'],...Array.from({length:50},(_,i)=>[`system${i}${'x'.repeat(130)}`,'1'])],1);
    const result=repair.repairTableEvidenceGuidance(draft,[issue],targets,'Original evidence text.',
        {structuredArtifacts:{tables:[large]},fullDraftRegenerationDiagnostics:true});
    assert.match(result,/本次完整再生的范围由真实请求单独授权/);
    assert.equal(packet(result)[0].usableSourceTables.length,0);
    assert.equal(packet(result)[0].omittedCompleteSourceTableCount,1);
});
