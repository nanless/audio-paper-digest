'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const repair=require('../scripts/lib/reader-repair'),order=require('../scripts/lib/reader-draft-order'),deep=require('../scripts/deep-analyzer');
function sample(){
 const signed=require('./reader-signed-draft-fixture').fixture({noFigures:true,artifactTable:true});
 signed.draft.tableBindings.push({tableIndex:3,sourceType:'source_quotes',sourceTableOrdinal:null,cellBindings:[],sourceQuotes:['This incorrect paraphrase reports an unsupported measurement of 777.']});
 return signed;
}
const issues=[{path:'/tableBindings/2',code:'reader_table_binding_order_ambiguous',message:'正文表格与来源记录不能一一对应'}];
function proposed(signed){
 const context=repair.buildRepairContext(signed.draft,issues,'sealed source',signed.sourceDetails.text);
 const patch={version:1,draftSha256:context.draftSha256,replacements:context.targets.map(target=>({path:target.path,oldSha256:target.oldSha256,value:target.path.startsWith('/sections/')?target.value+'\n\n这里对照原文相同协议报告的单一读数。\n\n| 条件 | 报告值 |\n|---|---|\n| 相同协议 | 1.0 |\n\n这个读数只报告相同协议下的测量，原文没有在这条证据中提供其他协议的对照，因此不能把结果向其他设置推广。':{...target.value,sourceQuotes:[signed.sourceDetails.text]}}))};
 return {context,patch,options:{atomicOperation:context.atomicOperation,sourceText:signed.sourceDetails.text,structuredArtifacts:signed.sourceDetails.structuredArtifacts}};
}
function bind(draft,signed){const article=order.locateReaderDraftTables(draft).map(x=>x.table.markdown).join('\n\n');return deep.bindApiReaderSourceEvidence(article,draft.tableBindings,[],{sourceText:signed.sourceDetails.text,structuredArtifacts:signed.sourceDetails.structuredArtifacts});}
test('唯一缺尾引文表明确补表并纠正引文，旧正文旧表与全部其他来源逐字保留',()=>{
 const signed=sample(),original=repair.hashDraft(signed.draft),p=proposed(signed);
 assert.equal(p.context.atomicOperation.kind,'add_existing_tail_quote_table_v1');assert.deepEqual(p.context.targets.map(t=>t.path),['/sections/7/body','/tableBindings/2']);assert.match(p.context.targetGuidance,/只缺末尾第3张/);
 const next=repair.applyReaderPatch(signed.draft,p.patch,p.context.targets.map(t=>t.path),p.options);
 assert.equal(order.locateReaderDraftTables(next).length,3);assert.deepEqual(next.tableBindings.slice(0,2),signed.draft.tableBindings.slice(0,2));assert.ok(next.sections[7].body.startsWith(signed.draft.sections[7].body+'\n\n'));
 assert.deepEqual(next.sections.slice(0,7),signed.draft.sections.slice(0,7));assert.deepEqual(next.sections.slice(8),signed.draft.sections.slice(8));assert.equal(repair.hashDraft(signed.draft),original);
 assert.doesNotThrow(()=>order.normalizeReaderDraftOrder(next,{structuredArtifacts:signed.sourceDetails.structuredArtifacts}));assert.doesNotThrow(()=>bind(next,signed));
});
test('尾表错误原句或错误数字仍拒，不能只改引文或删除旧表正文',()=>{
 const signed=sample();
 for(const change of [p=>{p.patch.replacements[1].value.sourceQuotes=['Incorrect quote with 777 unsupported'];},p=>{p.patch.replacements[0].value=signed.draft.sections[7].body;},p=>{p.patch.replacements[0].value=p.patch.replacements[0].value.replace('相同协议 | 1.0','相同协议 | 777');},p=>{p.patch.replacements[0].value=p.patch.replacements[0].value.replace('统一协议','改写旧表');},p=>{p.patch.replacements.pop();}]){
  const p=proposed(signed);change(p);assert.throws(()=>{const next=repair.applyReaderPatch(signed.draft,p.patch,p.context.targets.map(t=>t.path),p.options);bind(next,signed);});
 }
});
test('多缺表、缺中间表或前缀序号不稳定不取得唯一尾表权限',()=>{
 for(const change of [d=>d.tableBindings.push({...d.tableBindings.at(-1),tableIndex:4}),d=>d.tableBindings[0].tableIndex=2,d=>d.tableBindings[0]={tableIndex:1,selection:{sourceTableOrdinal:1,sourceRows:[0,1],sourceColumns:[0,1]}},d=>d.tableBindings.at(-1).sourceType='artifact_table']){
  const signed=sample();change(signed.draft);assert.notEqual(proposed(signed).context.atomicOperation?.kind,'add_existing_tail_quote_table_v1');
 }
});
test('正常公开生成入口下一次只请求唯一尾表补丁，并传入真实sourceText校验引文',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const signed=sample();[signed.draft.sections[7],signed.draft.sections[8]]=[signed.draft.sections[8],signed.draft.sections[7]];const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'reader-tail-entry-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const stages=[];const patch=proposed(signed).patch;
 const result=await deep.generateApiReaderArticleDetailed(signed.paper,'','sealed source',{
  sourceText:signed.sourceDetails.text,structuredArtifacts:signed.sourceDetails.structuredArtifacts,readerAttemptsDir:directory,readerMaterializeFigures:async()=>[],readerRecordDisposition(){},readerMaxAttempts:2,
  readerCallModel:async(messages,tokens,options)=>{stages.push(options.usageContext.stage);if(stages.length===1)return JSON.stringify(signed.draft);assert.match(JSON.stringify(messages),/add_existing_tail_quote_table_v1/);return JSON.stringify(patch);}
 });assert.deepEqual(stages,['apiReaderArticle','apiReaderRepair']);assert.equal(result.fullAttempts,1);assert.equal(result.plan.tableBindings.length,3);
});
