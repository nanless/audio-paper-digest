'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const actualDrafts=process.env.PD_READER_OPERATOR_REAL_DRAFTS;
const actualFeedbackDirectory=process.env.PD_READER_OPERATOR_FEEDBACK_AUDIT_DIR;
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const operator=require('../scripts/lib/daily-reader-operator-correction');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
test('人工修正没有显式scope时不会进入普通Reader',()=>{
 assert.equal(operator.current({arxivId:'2610.09334v1'},{}),null);assert.deepEqual(operator.execution(null),{});
});
test('新Reader反馈失败不能被保留的旧成功稿冒充完成，成功稿与坏反馈仍拒',
 {skip:!actualFeedbackDirectory},()=>{
 const daily=require('../scripts/lib/daily-fresh-source-plan'),facts=require('../scripts/lib/daily-fact-review');
 const formal=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/current/deep-analysis-result.json')));
 const plan=daily.readDailyFreshSourcePlan(formal.dailyFreshSourceRun);
 const directory=actualFeedbackDirectory;
 const ids=['2610.07426','2610.07047','2610.03078','2610.11787','2610.04706','2610.06672'];
 for(const paperId of ids){
  const paper=formal.papers.find(p=>p.arxivId.replace(/v\d+$/,'')===paperId);
  const file=path.join(directory,paperId+'.reader-feedback.json'),bytes=fs.readFileSync(file);
  const feedback=facts.readFeedback(file),map=new Map([[paperId,feedback]]);
  assert(paper.latestAnalysisAttemptError,'must be an actual failed correction, never a fabricated fixture');
  assert.equal(operator.isCurrentFailedPaper(paper,plan,map),true);
  // Removing the actual failure cannot admit an otherwise complete retained
  // Reader merely because a caller supplies new, not-yet-executed feedback.
  const clean=structuredClone(paper);delete clean.latestAnalysisAttemptError;
  if(require('../scripts/analysis-engine').isSuccessfulAnalysisRecord(clean)
    && daily.isPaperReusableForAnalysis(clean,plan))assert.equal(operator.isCurrentFailedPaper(clean,plan,map),false);
  const bad=structuredClone(feedback);bad.sourceFiles['source.pdf']='a'.repeat(64);
  assert.throws(()=>operator.isCurrentFailedPaper(paper,plan,new Map([[paperId,bad]])));
  assert.equal(sha(fs.readFileSync(file)),sha(bytes));
 }
 const passedId='2610.09225',passed=formal.papers.find(p=>p.arxivId.replace(/v\d+$/,'')===passedId);
 const done=facts.readFeedback(path.join(directory,passedId+'.reader-feedback.json'));
 assert.equal(operator.isCurrentFailedPaper(passed,plan,new Map([[passedId,done]])),false);
});
test('真实两稿的人工入口只读原源和账，精确重建并拒越权', {skip:!actualDrafts},async t=>{
 const Config=require('../scripts/config'),daily=require('../scripts/lib/daily-fresh-source-plan'),repair=require('../scripts/lib/reader-repair');
 // Explicit retry proofs bind the original candidate directory. Copying and
 // re-signing those proofs is forbidden. All original files remain read-only;
 // only this private correction manifest fixture is mutated by negative tests.
 const root=fs.mkdtempSync(path.join(path.dirname(Config.FILES.dailyFreshSourceRunsDir),'operator-test-fixture-'));
 fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const feeFile=path.join(root,'fee-sentinel.json'),feeBytes=Buffer.from('{"totalTokens":12345}');fs.writeFileSync(feeFile,feeBytes,{mode:0o600});
 const originals=new Map(),records=['2610.09334','2610.09701'].map(id=>{
  const file=path.join(actualDrafts,id+'.operator.json'),bytes=fs.readFileSync(file);originals.set(file,sha(bytes));return JSON.parse(bytes);
 });
 const formal=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/current/deep-analysis-result.json')));
 const plan=daily.readDailyFreshSourcePlan(formal.dailyFreshSourceRun);
 const papers=records.map(record=>structuredClone(formal.papers.find(paper=>paper.arxivId===record.paperId)));
 const success=structuredClone(formal.papers.find(paper=>paper.arxivId==='2610.07338v1'));
 for(const record of records){originals.set(record.baselineCandidateFile,sha(fs.readFileSync(record.baselineCandidateFile)));
  for(const name of ['source.txt','source.pdf','source-runtime.json','source-manifest.json']){
   const file=path.join(plan.sourcesDir,record.paperId.replace(/v\d+$/,''),'generation-000001',name);originals.set(file,sha(fs.readFileSync(file)));
  }
 }
 const files=records.map((record,index)=>path.join(root,index+'.json')),manifestFile=path.join(root,'manifest.json');
 const reset=()=>{records.forEach((record,index)=>fs.writeFileSync(files[index],JSON.stringify(record),{mode:0o600}));
  fs.writeFileSync(manifestFile,JSON.stringify({contract:operator.CONTRACT,runId:plan.runId,batchDate:plan.batchDate,
   authorization:'Explicit human source correction preserving the original ledger.',correctionFiles:files}),{mode:0o600});};reset();
 const run=callback=>daily.withDailyFreshAnalysisContext(plan,()=>operator.withCorrections(manifestFile,plan,papers,callback));
 await t.test('正常scope重建完整人工稿，所有费用次数NP原样，修改返回副本不能修改原档',async()=>{
  await run(()=>{records.forEach((record,index)=>{
   const env=JSON.parse(fs.readFileSync(record.baselineCandidateFile)),got=operator.current(papers[index],env.identity);
   assert.deepEqual(got.payload.draft,record.draft);
   for(const key of ['attempts','fullAttempts','transportFailures','noProgress','validationFailureStreak'])assert.equal(got.payload[key],env.payload[key]);
   assert.equal(got.proof.newReaderApiRequests,0);assert.equal(got.proof.executionKind,'operator');
   assert.equal(got.proof.beforeDraftSha256,record.baselineDraftSha256);assert.equal(got.proof.afterDraftSha256,repair.hashDraft(record.draft));
   assert.equal(got.proof.originalIdentitySha256,repair.hashDraft(env.identity));
   assert.equal(operator.execution(got.proof).model,'operator-local');assert.equal(operator.execution(got.proof).protocol,'local_operator');
   got.payload.attempts=0;got.payload.draft.sections[0].body+=' caller mutation';
   assert.deepEqual(operator.current(papers[index],env.identity).payload.draft,record.draft);
   assert.equal(operator.current(papers[index],env.identity).payload.attempts,env.payload.attempts);
  });});
  assert.equal(operator.current(papers[0],records[0].baselineIdentity),null);
  await assert.rejects(operator.withCorrections(manifestFile,plan,papers,()=>operator.current(papers[0],records[0].baselineIdentity)),/actual daily source scope/);
 });
 await t.test('来源声明、原档SHA、old节点SHA、越权路径、重叠patch和额外未声明改稿拒绝',async()=>{
  const mutators=[r=>r.sourceDescriptor.sourceSnapshotSha256='a'.repeat(64),r=>r.baselineCandidateEnvelopeSha256='a'.repeat(64),
   r=>r.patch.replacements[0].oldSha256='a'.repeat(64),r=>r.patch.replacements[0].path='/analysis',
   r=>r.patch.replacements.push(structuredClone(r.patch.replacements[0])),r=>r.draft.sections[0].body+=' unpatched edit'];
  for(const mutate of mutators){const bad=structuredClone(records[0]);mutate(bad);fs.writeFileSync(files[0],JSON.stringify(bad),{mode:0o600});
   await assert.rejects(run(()=>assert.fail('invalid correction admitted')));reset();}
 });
 await t.test('读取间manifest/correction变字节或当前sourceSHA错即拒，原candidate不改',async()=>{
  await run(()=>{const env=JSON.parse(fs.readFileSync(records[0].baselineCandidateFile));
   for(const file of [manifestFile,files[0]]){const bytes=fs.readFileSync(file);fs.appendFileSync(file,' ');
    assert.throws(()=>operator.current(papers[0],env.identity),/bytes changed/);fs.writeFileSync(file,bytes,{mode:0o600});}
   assert.throws(()=>operator.current(papers[0],{...env.identity,sourceSha256:'a'.repeat(64)}),/source or input changed/);
   assert.throws(()=>operator.current(papers[0],{...env.identity,paperId:'2610.09701v1'}),/source or input changed/);
  });
 });
 await t.test('真实已经成功且绑定同封存源的论文不能被作为失败稿修正',async()=>{
  assert(success,'actual completed round9 fixture required');assert.equal(require('../scripts/analysis-engine').isSuccessfulAnalysisRecord(success),true);
  assert.equal(daily.isPaperReusableForAnalysis(success,plan),true);
  const bad={...structuredClone(records[0]),paperId:success.arxivId};fs.writeFileSync(files[0],JSON.stringify(bad),{mode:0o600});
  await assert.rejects(daily.withDailyFreshAnalysisContext(plan,()=>operator.withCorrections(manifestFile,plan,[success,papers[1]],()=>assert.fail('success target admitted'))),/distinct failed paper/);reset();
 });
 for(const [file,digest]of originals)assert.equal(sha(fs.readFileSync(file)),digest);
 assert.deepEqual(fs.readFileSync(feeFile),feeBytes);
});
