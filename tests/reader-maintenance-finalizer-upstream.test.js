'use strict';
// Synthetic option-wiring and protected-output tests only. Source/score admission
// is not certified here; the real saved Gonzalez evidence is recorded separately.
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const test=require('node:test'),assert=require('node:assert/strict');
const deep=require('../scripts/deep-analyzer'),sync=require('../scripts/lib/reader-resource-sync');
const maintenance=require('../scripts/lib/conference-reader-review-maintenance');
function sample(){
 const f=require('./reader-signed-draft-fixture').fixture({noFigures:true});
 f.paper.analysis='exact scientific body';f.paper.parsed={score:'8',taxonomyValidation:{original:true}};
 f.paper.analysisManifest.stages.scoringAudit={status:'complete',original:true};
 f.generated=deep.parseApiReaderArticleResult(JSON.stringify(f.draft),{requiredVersion:3,
  requireIntegratedTables:true,minimumIntegratedTables:2,requireSourceBindings:true,allowDeterministicQuoteRepair:true,
  sourceText:f.sourceDetails.text,structuredArtifacts:f.sourceDetails.structuredArtifacts,availableFigureOrdinals:[]});
 return f;
}
test('finalizer-only preserve keeps ordinary generation mode separate from read-only paid replay',async t=>{
 const calls=[];
 t.mock.method(sync,'synchronizeReaderResourceAvailability',(paper,source,options)=>{
  calls.push(options.preserveUpstream);return paper;
 });
 for(const [options,expected] of [[{},false],[{preserveScientificUpstream:true},true],
     [{preserveScientificUpstream:false},false],[{preserveReaderUpstream:true},true]]){
  const f=sample(),before=structuredClone(f.paper);
  const out=await deep.finalizeApiReaderRefresh(f.paper,f.sourceDetails,f.generated,{...options,
   readerResources:f.paper.apiReaderResources,execution:{executionKind:'api',model:'synthetic-only',protocol:'synthetic-only'}});
  assert.equal(calls.at(-1),expected);
  assert.equal(out.analysis,before.analysis);assert.deepEqual(out.parsed,before.parsed);
  assert.deepEqual(out.analysisManifest.stages.scoringAudit,before.analysisManifest.stages.scoringAudit);
 }
});
test('maintenance protected scientific comparison stays exact for body score tags stages and checkpoints',()=>{
 const parent={analysis:'original',analysisCheckpoint:'original checkpoint',parsed:{score:8,taxonomyValidation:{old:true}},
  scoringAudit:{score:8},sourceSha256:'a'.repeat(64),analysisStageCheckpoints:{scoringAudit:'original'},
  analysisManifest:{stages:{scoringAudit:{status:'complete',outputAnalysisSha256:'b'.repeat(64)}}}};
 const paper=structuredClone(parent),bound={locator:{reviewFeedbackSha256:'c'.repeat(64)}};
 paper.apiReaderArticle='new Reader';paper.analysisManifest.stages.apiReaderArticle={status:'complete',reviewFeedbackSha256:bound.locator.reviewFeedbackSha256};
 const loaded={readerReview:bound};
 assert.doesNotThrow(()=>maintenance.assertReaderOutput(loaded,paper,parent));
 for(const mutate of [p=>p.analysis+='changed',p=>p.parsed.score=9,p=>p.parsed.tagValidation={new:true},
  p=>p.analysisManifest.stages.scoringAudit.outputAnalysisSha256='d'.repeat(64),
  p=>p.analysisStageCheckpoints.scoringAudit+='changed',p=>p.scoringAudit.score=9]){
  const changed=structuredClone(paper);mutate(changed);
  assert.throws(()=>maintenance.assertReaderOutput(loaded,changed,parent),/protected scientific upstream changed/);
 }
});
