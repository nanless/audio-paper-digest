'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const api=require('../scripts/lib/historical-source-taxonomy-checkpoint-export.js'),classify=require('../scripts/lib/historical-source-taxonomy-classification.js'),runner=require('../scripts/lib/historical-direct-rewrite-runner.js');
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
 assert.throws(()=>classify.validateResumeCheckpoint(checkpoint,selection,{...options,filename:'checkpoint-000002-'+ 'a'.repeat(16)+'.json'}),/integrity/);
 assert.throws(()=>classify.validateResumeCheckpoint(checkpoint,selection,{...options,registrySha256:'changed'}),/integrity/);
 const changed=structuredClone(checkpoint);changed.failures[0].paperId=selection.paperIds[2];
 assert.throws(()=>classify.validateResumeCheckpoint(changed,selection,{...options,filename:'checkpoint-000002-'+runner.stableHash(changed).slice(0,16)+'.json'}),/prefix/);
});
test('CLI accepts canonical conference IDs and rejects malformed or duplicate exclusions',()=>{
 const cli=require('../scripts/historical-source-taxonomy-checkpoint-export.js');
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
 assert.throws(()=>classify.validateResumeExportReport(changed,report),/exact source\/cache\/checkpoint replay/);
});
test('parallel completion checkpoint can safely exclude out-of-order completed IDs without skipping gaps',()=>{
 const selection={contract:classify.CONTRACT+'-selection',planSha256:'plan',registrySha256:'registry',paperIds:['arxiv:2601.00001','arxiv:2601.00002','arxiv:2601.00003']};
 const checkpoint={contract:classify.CONTRACT+'-checkpoint',checkpointScheduling:'completion-set-v1',processedPaperIds:[selection.paperIds[0],selection.paperIds[2]],supplement:{contract:'historical-direct-taxonomy-supplement-v1',records:{}},processed:2,decisions:[{paperId:selection.paperIds[2],fingerprint:'f'.repeat(64)}],failures:[{paperId:selection.paperIds[0],status:'needs-review',error:'independent review rejected'}]};
 const options={planSha256:'plan',registrySha256:'registry',filename:'checkpoint-000002-'+runner.stableHash(checkpoint).slice(0,16)+'.json'};
 assert.deepEqual(classify.validateResumeCheckpoint(checkpoint,selection,options),checkpoint.processedPaperIds);
 const changed=structuredClone(checkpoint);changed.processedPaperIds.reverse();
 assert.throws(()=>classify.validateResumeCheckpoint(changed,selection,{...options,filename:'checkpoint-000002-'+runner.stableHash(changed).slice(0,16)+'.json'}),/ordered selection/);
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
