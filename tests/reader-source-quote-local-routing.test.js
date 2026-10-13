'use strict';
require('./core-diagnostics-test-isolation')();
const test = require('node:test');
const assert = require('node:assert/strict');
const deep = require('../scripts/deep-analyzer');
const repair = require('../scripts/lib/reader-repair');
function sample() {
    const data = require('./reader-signed-draft-fixture').fixture({noFigures:true});
    const draft = structuredClone(data.draft);
    draft.tableBindings.forEach(binding => { binding.sourceQuotes = ['这句话不是原论文中的实验记录。']; });
    draft.sections[7].body += '\n\n论文未绑定经校验可用的代码。';
    const issues = repair.collectDraftIssues(draft,
        Object.assign(new Error('语言检查失败'), {code:'READER_PROSE_LANGUAGE'}),
        {sourceText:data.sourceDetails.text, structuredArtifacts:data.sourceDetails.structuredArtifacts});
    const context = repair.buildRepairContext(draft, issues, data.sourceDetails.text, data.sourceDetails.text);
    return {data,draft,issues,context};
}
const requiresFull = (draft, issues, context, policy=null, figures=false) =>
    deep.readerIssuesRequireFullSourceBindingRetry(null,draft,1,issues,policy,figures,context);

test('坏引文和同段文风问题全部有唯一局部范围时不用重写整篇', () => {
    const {draft,issues,context} = sample();
    assert.equal(issues.filter(i=>i.code==='reader_invalid_source_quotes').length,2);
    assert.equal(context.targets.length,4);
    assert.equal(requiresFull(draft,issues,context),false);
    assert.equal(requiresFull(draft,issues,null),true);
    assert.equal(requiresFull(draft,issues,context,{kind:'weak'}),true);
});

test('遗漏目标、未知问题、整组操作和无法唯一定位表格均保留原流程', () => {
    const {draft,issues,context} = sample();
    for (const changed of [{...context,targets:context.targets.slice(1)},
        {...context,atomicOperation:{kind:'anything'}}, {...context,targets:[]}]) {
        assert.equal(requiresFull(draft,issues,changed),true);
    }
    assert.equal(requiresFull(draft,[...issues,{path:'/sections/7/body',message:'其他完整性问题'}],context),true);
    const duplicate = structuredClone(draft);
    duplicate.sections.push({...duplicate.sections[7]});
    const duplicateContext = repair.buildRepairContext(duplicate,issues,'','');
    assert.equal(requiresFull(duplicate,issues,duplicateContext),true);
});

test('五张表超出八字段上限时不能把未覆盖问题藏到局部修复后面', () => {
    const {draft} = sample();
    const body=draft.sections[5].body;
    draft.sections=Array.from({length:5},(_,index)=>({kind:'result',heading:'实验'+index,body}));
    draft.tableBindings=Array.from({length:5},(_,index)=>({...draft.tableBindings[0],tableIndex:index+1}));
    const issues=draft.tableBindings.map((_,index)=>({path:'/tableBindings/'+index,
        code:'reader_invalid_source_quotes',message:'tableBindings['+index+'] sourceQuotes不合法'}));
    const context=repair.buildRepairContext(draft,issues,'','');
    assert.equal(context.targets.length,8);
    assert.equal(requiresFull(draft,issues,context),true);
});

test('首次生成遇到两处坏引文实际请求局部补丁，原样补丁仍停止并保存费用', async t => {
    const {data,draft} = sample();
    const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
    const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'reader-quotes-local-'));
    t.after(()=>fs.rmSync(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100}));
    let calls=0;
    await assert.rejects(deep.generateApiReaderArticleDetailed({arxivId:'2609.12345',title:'方法与条件'},'',data.sourceDetails.text,{
        sourceText:data.sourceDetails.text,structuredArtifacts:data.sourceDetails.structuredArtifacts,
        readerAttemptsDir:directory,readerMaxAttempts:6,readerMaterializeFigures:async()=>[],readerRecordDisposition:()=>{},
        readerCallModel:async messages=>{
            if(++calls===1)return JSON.stringify(draft);
            assert.equal(calls,2);
            const prompt=messages[0].content[0].text;
            const line=prompt.split('\n').find(line=>line.startsWith('{"draftSha256":'));
            assert.ok(line,'第二次必须给局部修改清单，不能再发整篇生成');
            const request=JSON.parse(line);
            assert.equal(request.targets.length,4);
            return JSON.stringify({version:1,draftSha256:request.draftSha256,replacements:request.targets.map(target=>({path:target.path,oldSha256:target.oldSha256,value:target.value}))});
        }
    }),error=>error.code==='READER_REPAIR_NO_PROGRESS');
    assert.equal(calls,2);
    const names=fs.readdirSync(directory).filter(name=>/^[a-f0-9]{64}\.json$/.test(name));
    assert.equal(names.length,1);
    const saved=JSON.parse(fs.readFileSync(path.join(directory,names[0]))).payload;
    assert.equal(saved.attempts,2);
    assert.equal(saved.fullAttempts,1);
    assert.ok(saved.issues.some(issue=>issue.code==='reader_invalid_source_quotes'));
});
