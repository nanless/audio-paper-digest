'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const api=require('../scripts/lib/historical-tag-checkpoint-export.js'),classify=require('../scripts/lib/historical-source-tag-assignment.js'),runner=require('../scripts/lib/historical-direct-rewrite-runner.js');
function signed(paperId) {
 const classification={paperId,fingerprint:'f'.repeat(64),proofSha256:'p',source:{paperId},concepts:[{id:'task.asr'}],primaryTaskId:'task.asr',primaryMethodId:'method.self-supervised'};
 const body={paperId,classificationRecordSha256:runner.stableHash(classification),classificationProofSha256:classification.proofSha256,requestStageFingerprint:classification.fingerprint,source:classification.source,evidence:classification.concepts,primaryTaskId:classification.primaryTaskId,primaryMethodId:classification.primaryMethodId};
 return {classification,page:{...body,proofSha256:runner.stableHash(body)}};
}
test('checkpoint subset retains original proof exactly and excludes duplicate or special identities',()=>{
 const a=signed('arxiv:2601.00001'),b=signed('arxiv:2605.12987'),records={'a.md':a.page,'b.md':b.page};
 const result=api.filterSignedRecords(records,new Map([[a.classification.paperId,a.classification],[b.classification.paperId,b.classification]]),[b.classification.paperId]);
 assert.deepEqual(result,{'a.md':a.page});assert.equal(result['a.md'],a.page);assert.equal(records['b.md'].proofSha256,b.page.proofSha256);
 const changed={...a.page,primaryTaskId:'task.other'};assert.throws(()=>api.filterSignedRecords({'a.md':changed},new Map([[a.classification.paperId,a.classification]]),[]),/differs/);
 const {proofSha256,...tampered}=a.page;tampered.classificationRecordSha256='a'.repeat(64);
 assert.throws(()=>api.verifyPageRecord({...tampered,proofSha256:runner.stableHash(tampered)},a.classification),/differs/);
});
test('resume excludes exact processed prefix only with immutable content hash and matching selection',()=>{
 const selection={contract:classify.CONTRACT+'-selection',planSha256:'plan',registrySha256:'registry',paperIds:['arxiv:2601.00001','arxiv:2601.00002','arxiv:2601.00003']};
 const checkpoint={contract:classify.CONTRACT+'-checkpoint',supplement:{contract:'historical-direct-taxonomy-supplement-v1',records:{}},processed:2,decisions:[{paperId:selection.paperIds[0],fingerprint:'f'.repeat(64)}],failures:[{paperId:selection.paperIds[1],status:'needs-review',error:'independent review rejected'}]};
 const options={planSha256:'plan',registrySha256:'registry',filename:'checkpoint-000002-'+runner.stableHash(checkpoint).slice(0,16)+'.json'};
 assert.deepEqual(classify.validateResumeCheckpoint(checkpoint,selection,options),selection.paperIds.slice(0,2));
 assert.throws(()=>classify.validateResumeCheckpoint(checkpoint,selection,{...options,filename:'checkpoint-000002-'+ 'a'.repeat(16)+'.json'}),/续跑检查点或原选择记录/);
 assert.throws(()=>classify.validateResumeCheckpoint(checkpoint,selection,{...options,registrySha256:'changed'}),/续跑检查点或原选择记录/);
 const changed=structuredClone(checkpoint);changed.failures[0].paperId=selection.paperIds[2];
 assert.throws(()=>classify.validateResumeCheckpoint(changed,selection,{...options,filename:'checkpoint-000002-'+runner.stableHash(changed).slice(0,16)+'.json'}),/已处理论文重复，或与应有的已处理集合不一致/);
});
test('CLI accepts canonical conference IDs and rejects malformed or duplicate exclusions',()=>{
 const cli=require('../scripts/historical-tag-checkpoint-export.js');
 const ids=['conference:icml:2026:openreview-forum-id:n1mAjfRDZ6','conference:icml:2026:openreview-forum-id:jfpkqjhex4'];
 assert.deepEqual(cli.parsePaperIds(ids.join(',')),ids);
 for(const raw of ['',ids[0]+','+ids[0],'https://arxiv.org/abs/2601.00001','conference:icml:2026:openreview-forum-id:../x','arxiv:2601.00001v2'])assert.throws(()=>cli.parsePaperIds(raw),/Invalid/);
 const selection={paperIds:ids},plan={queue:ids.map(paperId=>({paperId}))};
 assert.deepEqual(api.validateExcludedIds(ids,selection,plan),ids);
 assert.throws(()=>api.validateExcludedIds([ids[0],ids[0]],selection,plan),/duplicate/);
 assert.throws(()=>api.validateExcludedIds(ids,{paperIds:[ids[0]]},plan),/outside/);
 assert.throws(()=>api.validateExcludedIds(ids,selection,{queue:[]}),/outside/);
});
test('new remaining cohort accepts only an exact replay of the official checkpoint export report',()=>{
 const report={contract:classify.CONTRACT+'-checkpoint-export-report',processedPaperIds:['arxiv:2601.00001'],processed:1,acceptedCaches:1,remainingPaperIds:['arxiv:2601.00002']};
 assert.deepEqual(classify.validateResumeExportReport(report,structuredClone(report)),report.processedPaperIds);
 const changed={...report,processedPaperIds:report.remainingPaperIds};
 assert.throws(()=>classify.validateResumeExportReport(changed,report),/重新核验的来源、缓存和检查点不一致/);
});
test('parallel completion checkpoint can safely exclude out-of-order completed IDs without skipping gaps',()=>{
 const selection={contract:classify.CONTRACT+'-selection',planSha256:'plan',registrySha256:'registry',paperIds:['arxiv:2601.00001','arxiv:2601.00002','arxiv:2601.00003']};
 const checkpoint={contract:classify.CONTRACT+'-checkpoint',checkpointScheduling:'completion-set-v1',processedPaperIds:[selection.paperIds[0],selection.paperIds[2]],supplement:{contract:'historical-direct-taxonomy-supplement-v1',records:{}},processed:2,decisions:[{paperId:selection.paperIds[2],fingerprint:'f'.repeat(64)}],failures:[{paperId:selection.paperIds[0],status:'needs-review',error:'independent review rejected'}]};
 const options={planSha256:'plan',registrySha256:'registry',filename:'checkpoint-000002-'+runner.stableHash(checkpoint).slice(0,16)+'.json'};
 assert.deepEqual(classify.validateResumeCheckpoint(checkpoint,selection,options),checkpoint.processedPaperIds);
 const changed=structuredClone(checkpoint);changed.processedPaperIds.reverse();
 assert.throws(()=>classify.validateResumeCheckpoint(changed,selection,{...options,filename:'checkpoint-000002-'+runner.stableHash(changed).slice(0,16)+'.json'}),/已处理集合的格式或顺序与原选择记录不一致/);
});
test('parallel export uses the exact completion set and treats later accepted caches as pending',()=>{
 const ids=['a','b','c','d'],selection={paperIds:ids};
 const checkpoint={checkpointScheduling:'completion-set-v1',processedPaperIds:['a','c'],processed:2,decisions:[{paperId:'c'}],failures:[{paperId:'a'}]};
 const caches=new Map([['c',{proof:'signed'}],['d',{proof:'later cache'}]]);
 assert.deepEqual(api.processedIdsForExport(selection,checkpoint,caches),['a','c']);
 assert.deepEqual(ids.filter(id=>!api.processedIdsForExport(selection,checkpoint,caches).includes(id)),['b','d']);
 assert.throws(()=>api.processedIdsForExport(selection,checkpoint,new Map([['d',{}]])),/lacks replayed accepted/);
 const fifty=Array.from({length:53},(_,i)=>'p'+i),done=fifty.filter((_,i)=>i!==2&&i!==3&&i!==5);
 const big={checkpointScheduling:'completion-set-v1',processedPaperIds:done,processed:50,decisions:done.map(paperId=>({paperId})),failures:[]};
 assert.deepEqual(api.processedIdsForExport({paperIds:fifty},big,new Map(fifty.map(id=>[id,{}]))),done);
 assert.deepEqual(fifty.filter(id=>!done.includes(id)),['p2','p3','p5']);
});
function partialFixture() {
 const paperIds=['arxiv:2601.00001','arxiv:2601.00002','arxiv:2601.00003','arxiv:2601.00004'];
 const selection={contract:classify.CONTRACT+'-selection',planSha256:'plan',registrySha256:'registry',paperIds};
 const proof=signed(paperIds[2]);
 const value={contract:classify.CONTRACT+'-checkpoint',supplement:{contract:'historical-direct-taxonomy-supplement-v1',records:{'c.md':proof.page}},
  report:{contract:classify.CONTRACT+'-report',state:'partial',selected:4,processed:2,decisions:[{paperId:paperIds[2],fingerprint:'f'.repeat(64)}],
   failures:[{paperId:paperIds[0],status:'needs-review',error:'independent review rejected'}],pageCount:1,remainingPaperIds:[paperIds[1],paperIds[3]],
   stopped:{paperId:paperIds[1],status:'model-service-network-unavailable',error:'aborted'}}};
 const options=v=>({planSha256:'plan',registrySha256:'registry',filename:'partial-'+String(v.report.processed).padStart(6,'0')+'-'+runner.stableHash(v).slice(0,16)+'.json'});
 return {value,selection,proof,options};
}
test('partial exporter retains signed non-prefix completion and leaves extra caches pending',()=>{
 const {value,selection,proof,options}=partialFixture(),original=structuredClone(value);
 const normalized=api.normalizeCheckpoint(value,selection,options(value));
 assert.deepEqual(normalized.processedPaperIds,[selection.paperIds[0],selection.paperIds[2]]);
 assert.equal(normalized.supplement.records['c.md'],value.supplement.records['c.md']);
 const caches=new Map([[selection.paperIds[2],proof.classification],[selection.paperIds[3],signed(selection.paperIds[3]).classification]]);
 const completed=api.processedIdsForExport(selection,normalized,caches);
 assert.deepEqual(completed,[selection.paperIds[0],selection.paperIds[2]]);
 assert.deepEqual(selection.paperIds.filter(id=>!completed.includes(id)),value.report.remainingPaperIds);
 assert.deepEqual(api.filterSignedRecords(normalized.supplement.records,caches,[]),original.supplement.records);
 assert.deepEqual(value,original);
 assert.throws(()=>api.normalizeCheckpoint(value,selection,{...options(value),filename:'partial-000002-'+ '0'.repeat(16)+'.json'}),/partial envelope/);
 assert.throws(()=>api.normalizeCheckpoint(value,selection,{...options(value),registrySha256:'another'}),/续跑检查点或原选择记录的格式、身份、数量及文件名不符合要求/);
});
test('partial exporter rejects forged report counts, contracts, remaining closure and accepted projection',()=>{
 const {value,selection,options}=partialFixture();
 const mutations=[v=>v.contract='wrong',v=>v.report.contract='wrong',v=>v.supplement.contract='wrong',v=>v.report.state='complete',
  v=>v.report.selected=3,v=>v.report.processed=1,v=>v.report.pageCount=2,v=>v.report.remainingPaperIds.reverse(),
  v=>v.report.remainingPaperIds.push(selection.paperIds[2]),v=>v.report.decisions[0].paperId=selection.paperIds[0],
  v=>v.report.decisions[0].fingerprint='bad',v=>v.report.stopped.status='message-guessed-error',v=>v.report.stopped.error='',
  v=>v.report.stopped.paperId='outside',v=>v.supplement.records['c.md'].paperId=selection.paperIds[3]];
 for(const mutate of mutations){const changed=structuredClone(value);mutate(changed);assert.throws(()=>api.normalizeCheckpoint(changed,selection,options(changed)));}
 const changedSelection={...selection,paperIds:[selection.paperIds[0],selection.paperIds[0],selection.paperIds[2],selection.paperIds[3]]};
 assert.throws(()=>api.normalizeCheckpoint(value,changedSelection,options(value)),/partial envelope/);
});
test('partial adapter cannot replace strict accepted cache/page binding replay',()=>{
 const {value,selection,proof,options}=partialFixture(),normalized=api.normalizeCheckpoint(value,selection,options(value));
 assert.throws(()=>api.processedIdsForExport(selection,normalized,new Map()),/lacks replayed accepted/);
 const changed=structuredClone(proof.classification);changed.reviewProof={accepted:false};
 assert.throws(()=>api.filterSignedRecords(normalized.supplement.records,new Map([[changed.paperId,changed]]),[]),/differs/);
 const fifty=Array.from({length:53},(_,i)=>'arxiv:2601.'+String(i+1).padStart(5,'0'));
 const big={contract:classify.CONTRACT+'-checkpoint',supplement:{contract:'historical-direct-taxonomy-supplement-v1',records:{}},
  report:{contract:classify.CONTRACT+'-report',state:'partial',selected:53,processed:50,decisions:[],
   failures:fifty.filter((_,i)=>![1,3,5].includes(i)).map(paperId=>({paperId,status:'not-covered-by-current-taxonomy',error:'role absent'})),pageCount:0,
   remainingPaperIds:fifty.filter((_,i)=>[1,3,5].includes(i)),stopped:{status:'operator-stopped',error:'stop'}}};
 const projected=api.normalizeCheckpoint(big,{...selection,paperIds:fifty},options(big));
 assert.equal(projected.processedPaperIds.length,50);assert.equal(projected.processedPaperIds[1],fifty[2]);
});
test('defined implementation-changed stop can rescue proofs without authorizing model resume',()=>{
 const {value,selection,options}=partialFixture();value.report.stopped={status:'implementation-changed',error:'Frozen implementation changed; stopped before another model request'};
 const normalized=api.normalizeCheckpoint(value,selection,options(value));
 assert.deepEqual(normalized.processedPaperIds,[selection.paperIds[0],selection.paperIds[2]]);
 const forged=structuredClone(value);forged.report.stopped.status='unrecognized-stop';forged.report.stopped.error='implementation-changed';
 assert.throws(()=>api.normalizeCheckpoint(forged,selection,options(forged)),/partial envelope/);
 // Adaptation preserves original classification proofs; it never grants model
 // compatibility or changes the frozen producer implementation fingerprints.
 assert.equal(normalized.supplement.records['c.md'].proofSha256,value.supplement.records['c.md'].proofSha256);
});
test('selection and retained page keys bind the exact paper and frozen plan page',()=>{
 const paperId='arxiv:2601.00001',otherId='arxiv:2601.00002';
 const a=signed(paperId),b=signed(otherId);
 const page={pagePath:'content/posts/a.md',pageKey:'page-a',pageContentSha256:'a'.repeat(64)};
 const other={pagePath:'content/posts/b.md',pageKey:'page-b',pageContentSha256:'b'.repeat(64)};
 const plan={queue:[{paperId,pages:[page]},{paperId:otherId,pages:[other]}]},selection={paperIds:[paperId,otherId]};
 const items=api.validateSelectionPlan(selection,plan);
 const bind=(proof,p)=>{const {proofSha256,...body}=proof;Object.assign(body,{pageKey:p.pageKey,pageSha256:p.pageContentSha256});return {...body,proofSha256:runner.stableHash(body)};};
 const record=bind(a.page,page),otherRecord=bind(b.page,other),records={[page.pagePath]:record,[other.pagePath]:otherRecord};
 assert.equal(api.verifyRecordPlanBindings(records,items),records);
 assert.equal(api.verifyPageRecord(record,a.classification),record);
 // Moving a valid record changes no record proof bytes, but its dictionary key
 // must still be the page assigned to that exact paper in the frozen plan.
 assert.throws(()=>api.verifyRecordPlanBindings({'content/posts/forged.md':record},items),/key\/page identity/);
 assert.throws(()=>api.filterSignedRecords(api.verifyRecordPlanBindings({'content/posts/forged.md':record},items),new Map(),[paperId]),/key\/page identity/);
 assert.throws(()=>api.verifyRecordPlanBindings({[other.pagePath]:record},items),/key\/page identity/);
 assert.throws(()=>api.verifyRecordPlanBindings({[page.pagePath]:{...record,pageKey:other.pageKey}},items),/key\/page identity/);
 assert.throws(()=>api.verifyRecordPlanBindings({[page.pagePath]:{...record,pageSha256:other.pageContentSha256}},items),/key\/page identity/);
 assert.throws(()=>api.verifyRecordPlanBindings({[page.pagePath]:{...record,paperId:otherId}},items),/key\/page identity/);
 assert.throws(()=>api.verifyRecordPlanBindings({[page.pagePath]:{...record,paperId:'arxiv:2601.99999'}},items),/key\/page identity/);
 assert.throws(()=>api.validateSelectionPlan({paperIds:[paperId,'arxiv:2601.99999']},plan),/unknown plan member/);
 assert.throws(()=>api.validateSelectionPlan({paperIds:[paperId,paperId]},plan),/members differ/);
 assert.throws(()=>api.validateSelectionPlan(selection,{queue:[plan.queue[0],plan.queue[0]]}),/members differ/);
 assert.throws(()=>api.validateSelectionPlan(selection,{queue:[plan.queue[0],{paperId:otherId,pages:[page]}]}),/paths duplicate/);
 assert.throws(()=>api.validateSelectionPlan(selection,{queue:[plan.queue[0],{paperId:otherId,pages:[]}]}),/members differ/);
 assert.throws(()=>api.validateSelectionPlan(selection,{queue:[plan.queue[0],{paperId:otherId,pages:[{...other,pageKey:undefined}]}]}),/paths duplicate or differ/);
});
