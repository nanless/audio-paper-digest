'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fixture=require('./fixtures/workflow-body-path-paid.json');
const repair=require('../scripts/lib/reader-repair');
const error=prefix=>new Error('读者文章泄漏了流程或证据元话语：'+prefix);
const make=body=>({...structuredClone(fixture.draft),sections:fixture.draft.sections.map((s,i)=>({...s,body:i===12?body:s.body.replaceAll('图后解释需要','普通解释')}))});
function issuePath(draft,err){return repair.collectDraftIssues(draft,err).find(i=>i.message===err.message)?.path;}
test('真实付费稿只有唯一已拒正文获得局部路径，严格预算谓词仍原样核验',()=>{
    const before=repair.hashDraft(fixture),draft=structuredClone(fixture.draft),issues=repair.collectDraftIssues(draft,new Error(fixture.parserError));
    assert.deepEqual(issues.map(i=>i.path),['/sections/12/body']);
    const context=repair.buildRepairContext(draft,issues,'real input kept unchanged by the diagnostic');
    assert.deepEqual(context.targets.map(t=>t.path),['/sections/12/body']);
    assert.equal(context.targets[0].oldSha256,repair.hashDraft(draft.sections[12].body));
    assert.equal(repair.isSafeExistingReaderPatchContext(draft,context,false,issues),true);
    assert.equal(repair.isSafeExistingReaderPatchContext(draft,context,false,[{...issues[0],path:null}]),false);
    assert.equal(repair.isSafeExistingReaderPatchContext(draft,context,true,issues),false);
    assert.equal(repair.hashDraft(fixture),before);
    assert.deepEqual(fixture.originalBudget,{attempts:4,fullAttempts:2,noProgress:1,validationFailureStreak:2});
    assert.ok(fixture.originalFailureSignatures.failureSignature);
    assert.ok(fixture.originalFailureSignatures.validationFailureSignature);
});
test('仅既有三个精确拒绝前缀可定位，未知错误或伪Error不增加范围',()=>{
    for(const prefix of ['图后解释需要','图后解释必须','图后解释紧扣'])assert.equal(issuePath(make(prefix+'说明结果。'),error(prefix)),'/sections/12/body');
    for(const err of [error('未知流程词'),error('图后解释需要；另有错误'),{message:error('图后解释需要').message}])assert.equal(issuePath(fixture.draft,err),null);
});
test('零命中、同body多次、双body或仅概念桥命中保持未知路径',()=>{
    assert.equal(issuePath(make('正常结果解释。'),error('图后解释需要')),null);
    assert.equal(issuePath(make('图后解释需要说明；图后解释需要区分。'),error('图后解释需要')),null);
    const multiple=make('图后解释需要说明。');multiple.sections[10].body+='图后解释需要';assert.equal(issuePath(multiple,error('图后解释需要')),null);
    const concept=make('正常结果解释。');concept.conceptBridges[0].explanation+='图后解释需要';assert.equal(issuePath(concept,error('图后解释需要')),null);
});
