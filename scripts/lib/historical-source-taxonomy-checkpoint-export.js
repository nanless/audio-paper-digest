'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const io=require('./historical-conference-page-projections.js'),runner=require('./historical-direct-rewrite-runner.js');
const api=require('./historical-source-taxonomy-classification.js'),writer=require('./historical-direct-taxonomy-supplement.js');
const snippets=require('./source-evidence-snippets.js');
const digest=v=>crypto.createHash('sha256').update(v).digest('hex');
const fail=m=>{throw new Error('Source taxonomy checkpoint export rejected: '+m);};
function validateExcludedIds(ids,selection,plan) {
 if(!Array.isArray(ids)||new Set(ids).size!==ids.length||ids.some(id=>!selection.paperIds.includes(id)||!plan.queue.some(item=>item.paperId===id)))fail('excluded IDs duplicate or outside original selection/plan');
 return ids;
}
function validateSelectionPlan(selection,plan) {
 if(!Array.isArray(plan?.queue)||!Array.isArray(selection?.paperIds)
  ||new Set(selection.paperIds).size!==selection.paperIds.length)fail('selection/plan members differ');
 const items=new Map(),pagePaths=new Set();
 for(const item of plan.queue) {
  if(!item||typeof item.paperId!=='string'||!item.paperId||items.has(item.paperId)||!Array.isArray(item.pages)||!item.pages.length)fail('selection/plan members differ');
  for(const page of item.pages) {
   if(!page||typeof page.pagePath!=='string'||!page.pagePath||pagePaths.has(page.pagePath)
    ||typeof page.pageKey!=='string'||!page.pageKey||!/^[a-f0-9]{64}$/.test(page.pageContentSha256||''))fail('plan page paths duplicate or differ');
   pagePaths.add(page.pagePath);
  }
  items.set(item.paperId,item);
 }
 if(selection.paperIds.some(id=>!items.has(id)))fail('selection includes unknown plan member');
 return items;
}
function verifyRecordPlanBindings(records,items) {
 for(const[key,record]of Object.entries(records)) {
  const item=items.get(record?.paperId),page=item?.pages.find(p=>p.pagePath===key);
  if(!page||record.pageKey!==page.pageKey||record.pageSha256!==page.pageContentSha256)fail('signed record key/page identity differs from plan');
 }
 return records;
}
function verifyPageRecord(record,classification) {
 const {proofSha256,...body}=record;
 if(proofSha256!==runner.stableHash(body)||record.classificationRecordSha256!==runner.stableHash(classification)
  ||record.classificationProofSha256!==classification.proofSha256||record.requestStageFingerprint!==classification.fingerprint
  ||record.paperId!==classification.paperId||runner.stableHash(record.source)!==runner.stableHash(classification.source)
  ||runner.stableHash(record.evidence)!==runner.stableHash(classification.concepts)
  ||record.primaryTaskId!==classification.primaryTaskId||record.primaryMethodId!==classification.primaryMethodId)fail('signed page/classification differs');
 return record;
}
function filterSignedRecords(records,classifications,excludePaperIds) {
 const result={};
 for(const[key,r]of Object.entries(records)) {
  if(excludePaperIds.includes(r.paperId))continue;
  if(!classifications.has(r.paperId))fail('page lacks replayed classification');
  result[key]=verifyPageRecord(r,classifications.get(r.paperId));
 }
 return result;
}
function projectPage(item,page,loaded,record,runtime) {
 if(loaded.fileSha256!==page.pageContentSha256||record.paperId!==item.paperId)fail('frozen page/paper differs');
 const body={paperId:item.paperId,runId:record.runId,pageKey:page.pageKey,pageSha256:loaded.fileSha256,
  bodySha256:digest(writer.pageBody(loaded.bytes)),registrySha256:runtime.registrySha256,registryVersion:runtime.registryVersion,
  concepts:record.concepts.map(({id,facet,label})=>({id,facet,label})),primaryTaskId:record.primaryTaskId,primaryTaskLabel:record.primaryTaskLabel,
  primaryMethodId:record.primaryMethodId,primaryMethodLabel:record.primaryMethodLabel,evidenceType:'source-only-taxonomy',classificationContract:api.CONTRACT,
  classificationRecordSha256:runner.stableHash(record),classificationProofSha256:record.proofSha256,source:record.source,evidence:record.concepts,
  evidenceSelectionContract:record.evidenceSelectionContract,quoteSelections:record.quoteSelections,requestStageFingerprint:record.fingerprint,
  reviewProof:record.reviewProof,reviewProofSha256:record.reviewProofSha256};
 return {...body,proofSha256:runner.stableHash(body)};
}
function processedIdsForExport(selection,checkpoint,classifications) {
 if(checkpoint.checkpointScheduling==='completion-set-v1') {
  const accepted=new Set(checkpoint.decisions.map(d=>d.paperId));
  if([...accepted].some(id=>!classifications.has(id)))fail('completed checkpoint lacks replayed accepted caches');
  return [...checkpoint.processedPaperIds];
 }
 const failures=new Set(checkpoint.failures.map(f=>f.paperId)),processed=[];
 for(const id of selection.paperIds){if(!classifications.has(id)&&!failures.has(id))break;processed.push(id);}
 if(processed.length<checkpoint.processed||[...classifications.keys()].some(id=>!processed.includes(id)))fail('accepted caches extend beyond a replayable sequential completion prefix');
 return processed;
}
function normalizeCheckpoint(value,selection,options) {
 if(!Object.hasOwn(value||{},'report')) {
  api.validateResumeCheckpoint(value,selection,options);
  return value;
 }
 // A partial is a distinct immutable transport envelope. Verify its own bytes
 // before adapting its exact completed set to the existing checkpoint verifier.
 const report=value.report,records=value.supplement?.records;
 const statuses=new Set(['operator-stopped','implementation-changed','local-integrity-failure','account-pool-exhausted','account-authentication-failed','account-service-unavailable',
  'model-service-timeout','model-service-network-unavailable','model-service-http-unavailable','model-service-configuration-unavailable',
  'model-account-state-unavailable','model-service-response-unavailable']);
 if(value.contract!==api.CONTRACT+'-checkpoint'||value.supplement?.contract!==writer.CONTRACT
   ||!records||typeof records!=='object'||Array.isArray(records)||report?.contract!==api.CONTRACT+'-report'||report.state!=='partial'
   ||!Number.isSafeInteger(report.selected)||report.selected<1||report.selected!==selection?.paperIds?.length
   ||!Number.isSafeInteger(report.processed)||report.processed<1||report.processed>report.selected
   ||!Array.isArray(report.decisions)||!Array.isArray(report.failures)||report.processed!==report.decisions.length+report.failures.length
   ||report.pageCount!==Object.keys(records).length||!Array.isArray(report.remainingPaperIds)
   ||!Array.isArray(selection.paperIds)||new Set(selection.paperIds).size!==selection.paperIds.length
   ||!report.stopped||!statuses.has(report.stopped.status)||typeof report.stopped.error!=='string'||!report.stopped.error
   ||(report.stopped.paperId!==undefined&&!selection.paperIds.includes(report.stopped.paperId))
   ||path.basename(options.filename)!=='partial-'+String(report.processed).padStart(6,'0')+'-'+runner.stableHash(value).slice(0,16)+'.json')fail('partial envelope/report integrity differs');
 const done=[...report.decisions,...report.failures].map(r=>r.paperId),set=new Set(done);
 const remaining=selection.paperIds.filter(id=>!set.has(id));
 if(set.size!==done.length||done.some(id=>!selection.paperIds.includes(id))
   ||JSON.stringify(report.remainingPaperIds)!==JSON.stringify(remaining))fail('partial completion/remaining closure differs');
 const normalized={contract:value.contract,checkpointScheduling:'completion-set-v1',
  processedPaperIds:selection.paperIds.filter(id=>set.has(id)),supplement:value.supplement,processed:report.processed,
  decisions:report.decisions,failures:report.failures};
 api.validateResumeCheckpoint(normalized,selection,{...options,
  filename:'checkpoint-'+String(normalized.processed).padStart(6,'0')+'-'+runner.stableHash(normalized).slice(0,16)+'.json'});
 return normalized;
}
async function exportCheckpoint(options) {
 const config=require('../config.js'),{plan}=writer.readPlanRegistry(options);
 const runtime=require('./taxonomy-runtime.js').createTaxonomyRuntime({registryPath:options.registrySnapshot});
 const directory=path.dirname(options.checkpointFile),original=io.readStableJson(options.checkpointFile,'original immutable classifier checkpoint');
 const selection=io.readStableJson(path.join(directory,'selection.json'),'original immutable selection');
 const checkpoint={...original,value:normalizeCheckpoint(original.value,selection.value,
  {planSha256:plan.planSha256,registrySha256:runtime.registrySha256,filename:options.checkpointFile})};
 const items=validateSelectionPlan(selection.value,plan),classifications=new Map(),excluded=validateExcludedIds(options.excludePaperIds||[],selection.value,plan);
 const completeSet=checkpoint.value.checkpointScheduling==='completion-set-v1';
 const checkpointCacheNames=new Set(checkpoint.value.decisions.map(d=>'decision-'+digest(d.paperId).slice(0,16)+'-'+d.fingerprint+'.json'));
 for(const filename of fs.readdirSync(directory).filter(n=>n.startsWith('decision-')&&n.endsWith('.json')).sort()) {
  // Parallel caches may finish beyond this immutable checkpoint. Such work is
  // deliberately pending for this export, regardless of its cached response.
  if(completeSet&&!checkpointCacheNames.has(filename))continue;
  const record=io.readStableJson(path.join(directory,filename),'accepted classifier cache').value;
  if(filename!=='decision-'+digest(record.paperId).slice(0,16)+'-'+record.fingerprint+'.json'||!selection.value.paperIds.includes(record.paperId)||classifications.has(record.paperId))fail('cache name/cohort duplicates or differs');
  const source=await api.loadSource(items.get(record.paperId),config,1);
  // Old completion is retained only as a processed item for these two exact
  // identities. Its pre-disclosure classification is deliberately not exported.
  if(excluded.includes(record.paperId)&&['arxiv:2605.12987','arxiv:2606.01009'].includes(record.paperId)
      &&source.source.pdfVersionBinding&&!Object.hasOwn(record.source,'pdfVersionBinding')) {
    delete source.source.pdfVersionBinding;delete source.source.sourceVersionWarning;
  }
  api.validateCachedDecision(record,{fingerprint:record.fingerprint,runtime,bundle:snippets.buildSnippets(source.text),source});
  classifications.set(record.paperId,record);
 }
 const processedPaperIds=processedIdsForExport(selection.value,checkpoint.value,classifications);
 // Bind every original dictionary key before exclusions can hide an invalid
 // page assignment. Excluded identities remain omitted from the export.
 const records=filterSignedRecords(verifyRecordPlanBindings(checkpoint.value.supplement.records,items),classifications,excluded);
 const retainedKeys=Object.keys(records),replayedKeys=new Set();
 for(const id of processedPaperIds) {
  if(!classifications.has(id)||excluded.includes(id))continue;
  const item=items.get(id),record=classifications.get(id);
  for(const page of item.pages) {
   const loaded=io.readStableFile(path.join(options.blogRoot,page.pagePath),'original classified frozen page');
   if(/^paper_digest_taxonomy_contract:\s*["']?paper-taxonomy-flat-tags-compat-v1/m.test(loaded.bytes.toString('utf8').split('---',3)[1]||'')) {
    if(Object.hasOwn(records,page.pagePath))fail('signed production page unexpectedly retained in checkpoint');
    continue;
   }
   const projected=projectPage(item,page,loaded,record,runtime);
   if(records[page.pagePath]&&runner.stableHash(records[page.pagePath])!==runner.stableHash(projected))fail('reconstructed signed page bytes differ');
   records[page.pagePath]=projected;
   replayedKeys.add(page.pagePath);
  }
 }
 if(retainedKeys.some(key=>!replayedKeys.has(key)))fail('retained record lacks exact frozen page replay');
 const supplement={contract:writer.CONTRACT,records};
 const report={contract:api.CONTRACT+'-checkpoint-export-report',checkpointFileSha256:checkpoint.fileSha256,selectionFileSha256:selection.fileSha256,
  selected:selection.value.paperIds.length,processed:processedPaperIds.length,processedPaperIds,acceptedCaches:classifications.size,
  rejected:checkpoint.value.failures.length,excludedPaperIds:excluded,exportedPaperCount:new Set(Object.values(records).map(r=>r.paperId)).size,
  pageCount:Object.keys(records).length,remainingPaperIds:selection.value.paperIds.filter(id=>!processedPaperIds.includes(id)),failures:checkpoint.value.failures};
 return {supplement,report};
}
module.exports={validateExcludedIds,validateSelectionPlan,verifyRecordPlanBindings,verifyPageRecord,filterSignedRecords,projectPage,processedIdsForExport,normalizeCheckpoint,exportCheckpoint};
