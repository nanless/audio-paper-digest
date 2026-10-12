'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../scripts/lib/reader-repair');
function createMixedSample() {
    return {version:3,readerTitle:'来源与资源说明',oneSentenceThesis:'解释证据完整的实验。',
        sections:[{kind:'reproduction',heading:'复现条件',body:'论文未绑定经校验可用的代码。\n\n下表比较设置。\n\n| 设置 | 数量 |\n| --- | --- |\n| 样本 | 7 |\n\n结果仅适用于这些样本。'}],
        tableBindings:[{tableIndex:1,sourceType:'source_quotes',sourceTableOrdinal:null,cellBindings:[],sourceQuotes:['7']}],
        formulaBindings:[],conceptBridges:[],figurePlacements:[]};
}
test('语言错误与已证引文失败同时存在时，授权对应binding和唯一正文', () => {
    const draft=createMixedSample();
    const error=Object.assign(new Error('语言检查失败'),{code:'READER_PROSE_LANGUAGE'});
    const issues=repair.collectDraftIssues(draft,error,{sourceText:'The evaluation dataset consists of 7 samples.'});
    assert.ok(issues.some(i=>i.code==='reader_invalid_source_quotes'&&i.diagnosticOnly!==true));
    const context=repair.buildRepairContext(draft,issues,'真实证据','The evaluation dataset consists of 7 samples.');
    assert.ok(context.targets.some(t=>t.path==='/tableBindings/0'));
    assert.ok(context.targets.some(t=>t.path==='/sections/0/body'));
    assert.ok(context.targets.length<=8);
    const patch={version:1,draftSha256:repair.hashDraft(draft),replacements:[{
        path:'/tableBindings/0',oldSha256:repair.hashDraft(draft.tableBindings[0]),value:{...draft.tableBindings[0],sourceQuotes:['The evaluation dataset consists of 7 samples.']}}]};
    assert.equal(repair.applyReaderPatch(draft,patch,context.targets.map(t=>t.path),{rejectUnchanged:true}).sections[0].body,draft.sections[0].body);
});
test('多处表格位置不唯一时不猜授权；八节点不能拆开来源与正文', () => {
    const draft=createMixedSample();
    const issues=[{path:'/tableBindings/0',code:'reader_invalid_source_quotes',message:'tableBindings[0] sourceQuotes 不合法'}];
    draft.sections.push({...draft.sections[0]});
    assert.deepEqual(repair.buildRepairTargets(draft,issues),[]);
    const several=createMixedSample();
    several.sections=Array.from({length:5},(_,i)=>({...several.sections[0],body:several.sections[0].body.replace('样本 | 7','样本 | '+(i+7))}));
    several.tableBindings=Array.from({length:5},(_,i)=>({...several.tableBindings[0],tableIndex:i+1}));
    const targets=repair.buildRepairTargets(several,several.tableBindings.map((_,i)=>({path:'/tableBindings/'+i,code:'reader_invalid_source_quotes',message:`tableBindings[${i}] sourceQuotes 不合法`})));
    assert.equal(targets.length,8);
    for (const t of targets.filter(t=>t.path.startsWith('/tableBindings/'))) assert.ok(targets.some(b=>b.path===`/sections/${t.path.split('/').at(-1)}/body`));
});
test('真实模型旧值补丁立即拒绝，程序清理及有实际变化的补丁保持原规则', () => {
    const draft=createMixedSample();
    const patch={version:1,draftSha256:repair.hashDraft(draft),replacements:[{path:'/sections/0/body',oldSha256:repair.hashDraft(draft.sections[0].body),value:draft.sections[0].body}]};
    assert.throws(()=>repair.applyReaderPatch(draft,patch,['/sections/0/body'],{rejectUnchanged:true}),e=>e.code==='READER_PATCH_NO_PROGRESS'&&e.retryable===false);
    assert.deepEqual(repair.applyReaderPatch(draft,patch,['/sections/0/body']),draft);
    patch.replacements[0].value=draft.sections[0].body.replace('论文未绑定经校验可用的代码。','现有证据无法确认作者是否公开代码。');
    assert.notDeepEqual(repair.applyReaderPatch(draft,patch,['/sections/0/body'],{rejectUnchanged:true}),draft);
});

test('实际生成入口首次逐字旧值补丁即停止，保留一次已收费响应与原错误', async t => {
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');
    const deep = require('../scripts/deep-analyzer');
    const {fixture:createReaderSample} = require('./reader-signed-draft-fixture');
    const sample=createReaderSample({noFigures:true});
    const draft=structuredClone(sample.draft);
    draft.sections[7].body += '\n\n论文未绑定经校验可用的代码。';
    const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'reader-no-op-boundary-'));
    t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
    let calls=0;
    await assert.rejects(deep.generateApiReaderArticleDetailed({arxivId:'2609.12345',title:'如何解释方法'},'',sample.sourceDetails.text,{
        sourceText:sample.sourceDetails.text,structuredArtifacts:sample.sourceDetails.structuredArtifacts,
        readerAttemptsDir:directory,readerMaxAttempts:6,readerMaterializeFigures:async()=>[],readerRecordDisposition:()=>{},
        readerCallModel:async messages=>{
            if (++calls===1) return JSON.stringify(draft);
            const prompt=messages[0].content[0].text;
            const request=JSON.parse(prompt.split('\n').find(line=>line.startsWith('{"draftSha256":')));
            return JSON.stringify({version:1,draftSha256:request.draftSha256,replacements:request.targets.map(target=>({path:target.path,oldSha256:target.oldSha256,value:target.value}))});
        }
    }),e=>e.code==='READER_REPAIR_NO_PROGRESS');
    assert.equal(calls,2,'一次初稿加一次无改动补丁，不能再发相同请求');
    const active=fs.readdirSync(directory).filter(name=>/^[a-f0-9]{64}\.json$/.test(name));
    assert.equal(active.length,1);
    const saved=JSON.parse(fs.readFileSync(path.join(directory,active[0]))).payload;
    assert.equal(saved.attempts,2);
    assert.equal(saved.fullAttempts,1);
    assert.ok(saved.noProgress>=2);
    assert.ok(saved.issues.some(issue=>issue.code==='reader_workflow_leakage'));
    assert.ok(saved.draft.sections[7].body.includes('论文未绑定经校验可用的代码'));
});
