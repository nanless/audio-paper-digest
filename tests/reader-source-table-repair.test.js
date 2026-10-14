'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tables = require('../scripts/lib/reader-tables');
const repair = require('../scripts/lib/reader-repair');
const deep = require('../scripts/deep-analyzer');
function sample(count = 1) {
    const sources = Array.from({length:count}, (_, index) => ({ ordinal:index + 1, caption:'Main results',
        recoveryStatus:'complete', sourceDomSha256:'a'.repeat(64), matrix:[['Method','SDR'],['Ours','0.10.1']],
        headerRows:[0], bodyRows:[1], cells:[['Method','SDR'],['Ours','0.10.1']].flatMap((row,r) =>
            row.map((text,c) => ({row:r,column:c,text,header:r === 0,rowspan:1,colspan:1,sourceDomSha256:'a'.repeat(64)}))) }));
    const draft = { sections:sources.map(source => ({kind:'result',heading:'Results',
        body:`Comparison and limits.\n\n[[TABLE_${source.ordinal}]]\n\nKeep all correct results.`})),
        tableBindings:sources.map(source => ({tableIndex:source.ordinal,completeTable:{sourceTableOrdinal:source.ordinal}})),
        conceptBridges:[],figurePlacements:[],formulaBindings:[] };
    const issues = sources.flatMap(source => {
        try { tables.renderReaderCompleteTable(draft.tableBindings[source.ordinal - 1], {tables:sources}); }
        catch (error) { return error.readerIssues; }
        return [];
    });
    return {sources,draft,issues};
}
test('原表显示错误仅成对授权唯一绑定与正文，在八节点上限中保持完整对', () => {
    const {sources,draft,issues} = sample(5);
    const before = structuredClone(draft);
    const targets = repair.buildRepairTargets(draft, issues, {structuredArtifacts:{tables:sources}});
    assert.deepEqual(targets.map(target => target.path), Array.from({length:4}, (_,index) =>
        [`/tableBindings/${index}`,`/sections/${index}/body`]).flat());
    assert.ok(targets.every(target => target.oldSha256 === repair.hashDraft(target.value)));
    assert.deepEqual(draft, before);
    assert.equal(deep.readerIssuesRequireFullSourceBindingRetry(null, draft, 1, issues), false,
        '坏原格的可定位成对修复不能被TABLE文字扩大为新的全文请求');
});
test('纯诊断、坏来源身份、重复标记及fact-local范围不扩大修复许可', () => {
    const {sources,draft,issues} = sample();
    const options = {structuredArtifacts:{tables:sources}};
    assert.deepEqual(repair.buildRepairTargets(draft, issues.map(issue => ({...issue,diagnosticOnly:true})), options), []);
    assert.deepEqual(repair.buildRepairTargets(draft, issues.map(issue => ({...issue,sourceTableOrdinal:99})), options), []);
    const duplicate = structuredClone(draft); duplicate.sections[0].body += '\n\n[[TABLE_1]]';
    assert.deepEqual(repair.buildRepairTargets(duplicate, issues, options), []);
    assert.deepEqual(repair.buildRepairTargets(draft, issues, {...options,readerFactLocalPaths:['/sections/0/body'],readerFactLocalClaims:[]}), []);
    assert.deepEqual(repair.buildRepairTargets(draft, issues, {}), []);
});
test('新增来源诊断不能凭同code篡改正文路径或授权安全原表', () => {
    const {sources,draft,issues} = sample();
    assert.deepEqual(repair.buildRepairTargets(draft, [...issues,{...issues[0],path:'/sections/8/body',bindingPath:'/tableBindings/0'}],
        {structuredArtifacts:{tables:sources}}), []);
    const safe = structuredClone(sources); safe[0].matrix[1][1] = '0.1'; safe[0].cells[3].text = '0.1';
    assert.deepEqual(repair.buildRepairTargets(draft, issues, {structuredArtifacts:{tables:safe}}), []);
});
test('生成证据保持原输入字节，正常修复诊断提供最新完整表能力并覆盖旧说明', () => {
    const {sources} = sample();
    const safe = structuredClone(sources[0]); safe.ordinal = 2; safe.matrix[0][0] = ''; safe.cells[0].text = '';
    safe.matrix[1][1] = '0.1'; safe.cells[3].text = '0.1';
    const evidence = deep.buildApiReaderArtifactEvidence({tables:[sources[0],safe]});
    assert.match(evidence, /^TABLE_ORDINALS_AVAILABLE: \[\]$/m);
    assert.doesNotMatch(evidence, /COMPLETE_TABLE_ORDINALS_AVAILABLE|_COMPLETE_TABLE:/);
    const entries = Object.fromEntries(evidence.split('\n').filter(line => /_SELECTION:/.test(line)).map(line => {
        const at=line.indexOf(':');return [line.slice(0,at),JSON.parse(line.slice(at+1))];
    }));
    for(const value of Object.values(entries)){
        assert.deepEqual(Object.keys(value),['contract','eligible','reasonCodes','reasonCount','examples','action']);
        assert.match(value.action,/旧说明中的“eligible=false 时只能使用 source_quotes”/);
    }
    const {draft,issues}=sample();
    const error=Object.assign(new Error('source_table 无法安全显示完整原表'),{
        code:'READER_SOURCE_TABLE_UNRENDERABLE',readerIssues:issues});
    const diagnostics=require('../scripts/lib/reader-source-diagnostics').buildReaderSourceDiagnostics({
        draft,sourceText:'Main results\nMethod\nSDR\nOurs\n0.10.1',structuredArtifacts:{tables:[sources[0],safe]},parserError:error});
    assert.equal(diagnostics[0].sourceTableEligibility.eligible,false);
    assert.equal(diagnostics[0].usableSourceTables[0].completeTableEligibility.eligible,true);
    assert.match(deep.buildApiReaderValidationFeedback(error),/旧_SELECTION说明仅保留原输入兼容视图/);
});
