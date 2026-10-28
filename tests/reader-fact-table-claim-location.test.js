'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),zlib=require('node:zlib'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..'),tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'reader-fact-location-tests-')));
const fixture=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname,'fixtures/reader-fact-table-claim-location-real.json.gz'))));
// Dedicated-root mutation guard is installed before every production import.
require('./helpers/isolated-tmp-write-guard.cjs').installTmpOnlyWriteGuard(tmp,{readOnlyPythonScripts:[path.join(tmp,'scripts/reader_sealed_pdf_quote_evidence.py'),path.join(tmp,'scripts/reader_sealed_pdf_table_evidence.py'),path.join(tmp,'scripts/reader_pdf_cell_evidence.py')],readOnlyPythonStdinScripts:[path.join(tmp,'scripts/reader_pdf_cell_evidence.py')],readOnlyGitBlobOids:Object.keys(fixture.promptGitBlobs),readOnlyNodeScripts:[path.join(tmp,'scripts/lib/reader-resource-claims-replay-cli.js')]});
function write(file,bytes){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,bytes,{mode:0o600});}
function copy(source,dest){const st=fs.lstatSync(source);if(st.isDirectory()){fs.mkdirSync(dest,{recursive:true});for(const name of fs.readdirSync(source))copy(path.join(source,name),path.join(dest,name));}else if(st.isFile())write(dest,fs.readFileSync(source));}
for(const name of ['scripts','manual','config','prompts'])if(fs.existsSync(path.join(ROOT,name)))copy(path.join(ROOT,name),path.join(tmp,name));
for(const[oid,encoded]of Object.entries(fixture.promptGitBlobs)){const bytes=Buffer.from(encoded,'base64'),object=Buffer.concat([Buffer.from('blob '+bytes.length+'\0'),bytes]);assert.equal(crypto.createHash('sha1').update(object).digest('hex'),oid);write(path.join(tmp,'.git/objects',oid.slice(0,2),oid.slice(2)),zlib.deflateSync(object));}
write(path.join(tmp,'.git/HEAD'),'ref: refs/heads/test\n');write(path.join(tmp,'.git/config'),'[core]\nrepositoryformatversion = 0\nbare = false\n');fs.mkdirSync(path.join(tmp,'.git/refs/heads'),{recursive:true});
write(path.join(tmp,'package.json'),JSON.stringify({type:'commonjs'}));
write(path.join(tmp,'.paper-digest-workspace-role.json'),JSON.stringify({contract:'paper-digest-workspace-role-v1',version:1,role:'daily',workspaceRealpath:tmp}));
write(path.join(tmp,'.env'),'PAPER_ANALYZER_MODEL=muse-spark-1.3-contributor\nPAPER_ANALYZER_API_KEY=unused-no-network\nPAPER_ANALYZER_ENDPOINT=https://invalid.example/v1\nHTTPS_PROXY=http://127.0.0.1:9\nHTTP_PROXY=http://127.0.0.1:9\n');
// The copied extractor must use the same supported interpreter selection as the
// actual project, including setup-python's PATH on CI when ROOT has no .venv.
const shellQuote=value=>"'"+String(value).replace(/'/g,"'\\''")+"'";
write(path.join(tmp,'.venv/bin/python'),'#!/bin/sh\ncd '+shellQuote(ROOT)+'\nexec bash '+shellQuote(path.join(ROOT,'scripts/python-runtime.sh'))+' "$@"\n');fs.chmodSync(path.join(tmp,'.venv/bin/python'),0o700);
process.env.NODE_PATH=[path.join(ROOT,'node_modules'),process.env.NODE_PATH].filter(Boolean).join(path.delimiter);require('node:module').Module._initPaths();
process.env.TMPDIR=tmp;process.env.TMP=tmp;process.env.TEMP=tmp;process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';process.env.PYTHONDONTWRITEBYTECODE='1';
const deny=()=>{throw Error('test forbids network/model requests');};require('node:net').Socket.prototype.connect=deny;require('node:tls').connect=deny;for(const n of ['node:http','node:https']){require(n).request=deny;require(n).get=deny;}globalThis.fetch=deny;
const load=n=>require(path.join(tmp,'scripts',n)),Config=load('config'),daily=load('lib/daily-fresh-source-plan'),facts=load('lib/daily-fact-review'),engine=load('analysis-engine'),helper=load('lib/reader-fact-table-claim-location'),repair=load('lib/reader-repair'),deep=load('deep-analyzer'),fresh=load('lib/fresh-analysis-context'),saved=load('lib/saved-fact-feedback');
load('utils').requestLlmJson=deny;
const clone=structuredClone,sha=x=>crypto.createHash('sha256').update(x).digest('hex');
let seq=0;
function sample(){
 const root=path.join(tmp,'case-'+(++seq));const paper=clone(fixture.parent);
 Config.FILES.dailyFreshSourceRunsDir=path.join(root,'runs');Config.FILES.deepAnalysisResult=path.join(root,'formal.json');
 const runDir=path.join(Config.FILES.dailyFreshSourceRunsDir,paper.freshRewriteProvenance.runId);write(path.join(runDir,'run.json'),fixture.runBytes);
 for(const[n,b]of Object.entries(fixture.sourceFiles))write(path.join(runDir,'sources','2610.34408','generation-000001',n),Buffer.from(b,'base64'));
 const run=JSON.parse(fixture.runBytes),plan=daily.readDailyFreshSourcePlan(daily.dailyFreshSourceReference({...run,runDir}));
 const candidate=JSON.parse(fixture.candidateBytes),candidateFile=path.join(plan.readerAttemptsDir,repair.hashDraft(candidate.identity)+'.json');write(candidateFile,fixture.candidateBytes);
 write(path.join(runDir,'fact-feedback',paper.analysisFactReviewObligation.feedbackSha256+'.json'),fixture.feedbackBytes);
 const formal=JSON.stringify({papers:[paper]});write(Config.FILES.deepAnalysisResult,formal);
 write(path.join(plan.readerAttemptsDir,'request-diagnostics',fixture.paidRequestId+'.request.json'),fixture.paidRequestBytes);write(path.join(plan.readerAttemptsDir,'request-diagnostics',fixture.paidRequestId+'.response.json'),fixture.paidResponseBytes);
 const args={paper,plan,candidateFile,claimIndex:1,wrongSectionIndex:9,keeperSectionIndex:11,wrongTableIndex:1,keeperTableIndex:4,formalFileSha256:sha(formal)};
 const record=()=>JSON.parse(fs.readFileSync(path.join(runDir,'reader-feedback-corrections',paper[helper.FIELD].recordSha256+'.record.json')));
 return {root,paper,plan,candidate,candidateFile,args,record};
}
async function installed(s,fn){return daily.withDailyFreshAnalysisContext(s.plan,()=>engine.withPaperAnalysisLock(s.paper,()=>engine.analyzePaperWithRetry(s.paper,{maxRetries:0,onCheckpoint:p=>write(Config.FILES.deepAnalysisResult,JSON.stringify({papers:[p]})),analyzeFn:async p=>{assert.equal(engine.paperAnalysisLockHeld(p),true);assert.equal(typeof p[Symbol.for('audio-paper-digest.analysisCheckpointCallback')],'function');const h=helper.prepare(s.args);helper.install(h);return fn(p);}})));}
let actualCompleted,actualRecord;
test('真实锁/checkpoint→prepare/install→正常savedFacts刷新→完整parser/finalizer；零模型且原pending只由引擎清除',async()=>{
 const s=sample(),before=clone(s.paper.analysisFactReviewObligation),payload=clone(s.candidate.payload);let refreshed;
 const request=JSON.parse(fixture.paidRequestBytes),response=JSON.parse(fixture.paidResponseBytes);
 const paidDraft=repair.applyReaderPatch(request.draft,JSON.parse(response.rawResponse),request.repairTargets.map(t=>t.path));deep.normalizeReaderSourceQuotes(paidDraft,daily.readDailyFreshSource(s.plan,s.paper).text);
 assert.deepEqual(paidDraft,s.candidate.payload.draft,'actual paid patch + normal quote mapping yields exact retained candidate');
 const result=await installed(s,async p=>{
   assert.deepEqual(p.analysisFactReviewObligation,before);
   let out;try{out=await saved.analyzeWithRecoveredFeedback(p,s.plan,deny,JSON.parse(fixture.feedbackBytes));}catch(e){console.error(e.stack);throw e;}
   refreshed=clone(out);assert.equal(out.analysisManifest.stages.apiReaderArticle.savedClaimLocationReplay.newReaderApiRequests,0);
   assert.deepEqual(out.analysisFactReviewObligation,before);assert.ok(out.analysisManifest.stages.apiReaderArticle[helper.STAGE_FIELD]);
   return out;
 });
 assert.ok(refreshed,'normal refresh was reached: '+result.error);assert.equal(result.success,true,JSON.stringify(result));
 actualCompleted=clone(result.result);actualRecord=s.record();assert.equal(result.result.analysisFactReviewObligation,undefined);assert.deepEqual(s.paper.analysisFactReviewObligation,before);
 assert.deepEqual(JSON.parse(fs.readFileSync(s.candidateFile)).payload,payload);assert.deepEqual(s.record().pendingProof,before);
 assert.doesNotThrow(()=>helper.validatePublication(result.result));
 assert.deepEqual(result.result.apiReaderFigures,fixture.parent.apiReaderFigures);
});
test('真实付费候选和原source验真；缺锁、伪能力、候选CAS变化均拒绝',async()=>{
 const s=sample();assert.throws(()=>helper.prepare(s.args),/论文锁/);assert.throws(()=>helper.install({}),/缺少真实/);
 await daily.withDailyFreshAnalysisContext(s.plan,()=>engine.withPaperAnalysisLock(s.paper,async()=>{
  const h=helper.prepare(s.args);write(s.candidateFile,fixture.candidateBytes+' ');
  // A real engine callback is absent; install must reject before writing.
  assert.throws(()=>helper.install(h),/正常引擎检查点/);
  write(s.candidateFile,fixture.candidateBytes);const bad=JSON.parse(fixture.candidateBytes);bad.payload.attempts=0.5;bad.payloadSha256=repair.hashDraft(bad.payload);write(s.candidateFile,JSON.stringify(bad));
  assert.throws(()=>helper.prepare(s.args),/candidate refused/i);
 }));
});
test('原真实draft的错误intro/结果、错表返回、keeper移位改值或第三处均拒绝且mutation有效',async()=>{
 const s=sample();await installed(s,p=>{const record=s.record(),feedback=JSON.parse(record.feedbackBytes);
 const changes=[d=>d.sections[9].body+='\n\n'+feedback.rejectedReaderClaims[0],d=>d.sections[9].body+='\n\n'+feedback.rejectedReaderClaims[2],d=>{const tables=load('analysis-contract').extractMarkdownTables(d.sections[9].body);d.sections[9].body=d.sections[9].body.replace(tables[0].markdown,feedback.rejectedReaderClaims[1]);},d=>d.sections[11].heading+=' changed',d=>d.sections[11].body=d.sections[11].body.replace('3.7466','3.7467'),d=>d.sections[10].body+='\n\n'+feedback.rejectedReaderClaims[1],d=>d.tableBindings[3].cellBindings[0].sourceRow=99];
 for(const mutate of changes){const draft=clone(s.candidate.payload.draft);mutate(draft);assert.notDeepEqual(draft,s.candidate.payload.draft);assert.throws(()=>helper.inspectLocations(record,draft));}throw Object.assign(Error('test stops before qualification'),{retryable:false});});
});
test('反馈proof精确绑定；superset/新包/异步关闭后不能借旧豁免，普通路径不变',async()=>{
 const s=sample();await installed(s,async p=>{
  const claims=JSON.parse(fixture.feedbackBytes).rejectedReaderClaims;
  helper.withVerified(p,s.plan,()=>{assert.deepEqual(helper.effectiveClaims(claims),claims.filter((_,i)=>i!==1));assert.throws(()=>helper.effectiveClaims([...claims,'new obligation']),/不能遗漏/);});
  const proof=clone(p.analysisFactReviewObligation);proof.feedbackSha256='0'.repeat(64);assert.throws(()=>helper.withVerified(p,s.plan,()=>{}, {feedbackProof:proof}),/当前反馈/);
  let escaped;helper.withVerified(p,s.plan,()=>{escaped=Promise.resolve().then(()=>assert.throws(()=>helper.effectiveClaims(claims),/作用域已关闭/));});await escaped;
  // Capability callbacks cannot escape their ALS lifetime.
  await helper.withVerified(p,s.plan,async()=>{assert.deepEqual(helper.effectiveClaims(claims),claims.filter((_,i)=>i!==1));});
  assert.deepEqual(helper.effectiveClaims(claims),claims);assert.equal(helper.reuseVerifiedCorrectionFigures([],p),null);
  throw Object.assign(Error('test stops before qualification'),{retryable:false});
 });
});
test('真实历史direct稿与原run contract无标记正常退出；同稿带marker跨源拒绝',()=>{
 const s=sample(),paper=clone(fixture.historicalDirectPaper),run=JSON.parse(fixture.historicalDirectRunBytes);
 assert.equal(paper.freshRewriteProvenance.contract,'fresh-source-analysis-v1');assert.equal(run.contract,'fresh-rewrite-run-v1');
 assert.ok(paper.apiReaderPlan);assert.equal(paper.freshRewriteProvenance.runId,run.runId);
 // Normal absent daily index and an actual historical run with the same ID are both non-daily.
 assert.doesNotThrow(()=>helper.validatePublication(paper));
 const runFile=path.join(Config.FILES.dailyFreshSourceRunsDir,run.runId,'run.json');write(runFile,fixture.historicalDirectRunBytes);
 assert.doesNotThrow(()=>helper.validatePublication(paper));paper[helper.FIELD]={contract:helper.CONTRACT};assert.throws(()=>helper.validatePublication(paper),/非日更/);
});
test('actual normal completed稿冷核拒绝篡改与两个真实binding变化',()=>{
 assert.ok(actualCompleted,'requires first actual normal pipeline, no hand-filled stage');
 const s=sample();s.paper=clone(actualCompleted);s.args.paper=s.paper;
 const dir=path.join(s.plan.runDir,'reader-feedback-corrections'),pointer=s.paper[helper.FIELD];
 write(path.join(dir,pointer.recordSha256+'.record.json'),JSON.stringify(actualRecord,null,2)+'\n');write(path.join(dir,'2610.34408.json'),JSON.stringify(pointer,null,2)+'\n');
 write(path.join(dir,actualRecord.candidateIdentitySha256,actualRecord.candidateFile),actualRecord.candidateBytes);
 write(path.join(dir,actualRecord.candidateIdentitySha256,'request-diagnostics',fixture.paidRequestId+'.request.json'),fixture.paidRequestBytes);write(path.join(dir,actualRecord.candidateIdentitySha256,'request-diagnostics',fixture.paidRequestId+'.response.json'),fixture.paidResponseBytes);
 assert.doesNotThrow(()=>helper.validatePublication(s.paper));
 const changes=[p=>delete p[helper.FIELD],p=>delete p.analysisManifest.stages.apiReaderArticle[helper.STAGE_FIELD],p=>p.apiReaderArticle=p.apiReaderArticle.replace('3.7466','3.7467'),p=>{p.apiReaderArticle+='\n\n追加未授权内容。';p.apiReaderArticleSha256=sha(p.apiReaderArticle);p.analysisManifest.stages.apiReaderArticle.articleSha256=p.apiReaderArticleSha256;},p=>p.latestAnalysisAttemptError='new failure',p=>p.apiReaderPlan.tableBindings[0].sourceTableOrdinal=99,p=>p.analysisManifest.stages.apiReaderArticle.factReview.feedbackSha256='0'.repeat(64)];
 for(const mutate of changes){const bad=clone(s.paper);mutate(bad);assert.notDeepEqual(bad,s.paper);assert.throws(()=>helper.validatePublication(bad));}
 const source=path.join(s.plan.sourcesDir,'2610.34408/generation-000001/source.txt');fs.appendFileSync(source,' changed');assert.throws(()=>helper.validatePublication(s.paper));
});

test('原已付response归档变更或错误像素SHA只阻断零请求路径，不能回落网络',async()=>{
 const s=sample();let called=false;
 const result=await installed(s,async p=>{
   const file=path.join(s.plan.runDir,'reader-feedback-corrections',p[helper.FIELD].recordSha256+'.record.json');
   const archive=JSON.parse(fs.readFileSync(file));const responseFile=path.join(path.dirname(file),archive.candidateIdentitySha256,'request-diagnostics',fixture.paidRequestId+'.response.json');
   fs.appendFileSync(responseFile,' ');called=true;
   return saved.analyzeWithRecoveredFeedback(p,s.plan,deny,JSON.parse(fixture.feedbackBytes));
 });assert.equal(called,true);assert.equal(result.success,false);assert.match(result.error,/付费诊断归档变化/);
 const other=sample();const bad=JSON.parse(fixture.candidateBytes);bad.payload.imageEvidence[0].sha256='0'.repeat(64);bad.payloadSha256=repair.hashDraft(bad.payload);write(other.candidateFile,JSON.stringify(bad));
 const rejected=await installed(other,p=>saved.analyzeWithRecoveredFeedback(p,other.plan,deny,JSON.parse(fixture.feedbackBytes)));
 assert.equal(rejected.success,false);assert.match(rejected.error,/图证据/);assert.deepEqual(other.paper.analysisFactReviewObligation,fixture.parent.analysisFactReviewObligation);
 assert.equal(JSON.parse(fs.readFileSync(other.candidateFile)).payload.attempts,2);
});

test('真实出版共享CLI冷重放实际完成稿通过、原keeper改值拒绝；Python强制无缓存路由存在',()=>{
 assert.ok(actualCompleted);const s=sample(),paper=clone(actualCompleted),dir=path.join(s.plan.runDir,'reader-feedback-corrections'),pointer=paper[helper.FIELD];
 write(path.join(dir,pointer.recordSha256+'.record.json'),JSON.stringify(actualRecord,null,2)+'\n');write(path.join(dir,'2610.34408.json'),JSON.stringify(pointer,null,2)+'\n');
 write(path.join(dir,actualRecord.candidateIdentitySha256,actualRecord.candidateFile),actualRecord.candidateBytes);
 write(path.join(dir,actualRecord.candidateIdentitySha256,'request-diagnostics',fixture.paidRequestId+'.request.json'),fixture.paidRequestBytes);write(path.join(dir,actualRecord.candidateIdentitySha256,'request-diagnostics',fixture.paidRequestId+'.response.json'),fixture.paidResponseBytes);
 const defaultRuns=path.join(tmp,'data/runtime/daily-fresh-source-runs');copy(s.plan.runDir,path.join(defaultRuns,s.plan.runId));
 const invoke=p=>{const file=path.join(tmp,'cli-input.json');write(file,JSON.stringify({paper:p,sourceText:daily.readDailyFreshSource(s.plan,s.paper).text}));const fd=fs.openSync(file,'r');try{return require('node:child_process').execFileSync(process.execPath,[path.join(tmp,'scripts/lib/reader-resource-claims-replay-cli.js'),'3'],{cwd:tmp,stdio:['ignore','pipe','pipe',fd],timeout:60000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONPYCACHEPREFIX:path.join(tmp,'pycache')}}).toString();}finally{fs.closeSync(fd);}};
 assert.equal(invoke(paper),'{"verified":true}');const bad=clone(paper);bad.apiReaderArticle=bad.apiReaderArticle.replace('3.7466','3.7467');assert.notEqual(bad.apiReaderArticle,paper.apiReaderArticle);assert.throws(()=>invoke(bad));
 const publisher=fs.readFileSync(path.join(tmp,'scripts/publish-to-blog.py'),'utf8');assert.ok(publisher.includes("'apiReaderFactFeedbackCorrection' in paper"));assert.ok(publisher.includes('not authenticated_footnotes and not bound_patch_completion and key in _READER_RESOURCE_CLAIM_REPLAY_CACHE'));assert.ok(publisher.includes("correction_index = correction_directory / (paper_id + '.json')"));
});

test('独立继承proof的同串碰撞即使Set union与原claims相同也拒绝',async()=>{
 const s=sample();let checked=false;
 await installed(s,p=>{
  const claims=JSON.parse(fixture.feedbackBytes).rejectedReaderClaims,claim=claims[1],other=clone(p.analysisFactReviewObligation);other.feedbackSha256='1'.repeat(64);
  assert.deepEqual([...new Set([...claims,claim])],claims);
  assert.throws(()=>helper.withVerified(p,s.plan,()=>assert.fail('must not open exemption'),{feedbackProof:p.analysisFactReviewObligation,inheritedObligations:[{proof:other,claims:[claim]}]}),/独立父反馈/);
  helper.withVerified(p,s.plan,()=>assert.deepEqual(helper.effectiveClaims(claims),claims.filter((_,i)=>i!==1)),{feedbackProof:p.analysisFactReviewObligation,inheritedObligations:[{proof:other,claims:[claims[0]]}]});
  checked=true;throw Object.assign(Error('test stops before qualification'),{retryable:false});
 });assert.equal(checked,true);
});
test('真实strict Reader-only父包省略optional primary字段：普通及location路径可进入，独立同串仍拒绝',async()=>{
 const feedback=JSON.parse(fixture.feedbackBytes);assert.equal(Object.hasOwn(feedback,'rejectedPrimaryClaims'),false);
 const ordinary=sample();let ordinaryEntered=false;
 await daily.withDailyFreshAnalysisContext(ordinary.plan,()=>engine.withPaperAnalysisLock(ordinary.paper,()=>{
  const bound=facts.validateFeedback(feedback,ordinary.plan,ordinary.paper);
  return facts.withFactReview(bound,()=>facts.withReaderFactReview(bound,ordinary.paper,()=>{ordinaryEntered=true;assert.deepEqual(facts.readerRejectedClaims(ordinary.paper.arxivId),feedback.rejectedReaderClaims);}));
 }));assert.equal(ordinaryEntered,true);
 const corrected=sample();let correctedEntered=false,collisionRefused=false;
 await installed(corrected,p=>{
  const child=facts.validateFeedback(feedback,corrected.plan,p);
  facts.withFactReview(child,()=>facts.withReaderFactReview(child,p,()=>{correctedEntered=true;assert.deepEqual(facts.readerRejectedClaims(p.arxivId),feedback.rejectedReaderClaims.filter((_,i)=>i!==1));}));
  const inherited=clone(feedback);inherited.readerFeedback=feedback.readerFeedback.slice(0,20);inherited.rejectedReaderClaims=[feedback.rejectedReaderClaims[1]];
  const parent=facts.validateFeedback(inherited,corrected.plan,p);assert.notDeepEqual(parent.proof,child.proof);
  facts.withFactReview(parent,()=>assert.throws(()=>facts.withReaderFactReview(child,p,()=>assert.fail('independent obligation must survive')),/独立父反馈/));collisionRefused=true;
  throw Object.assign(Error('test stops before qualification'),{retryable:false});
 });assert.equal(correctedEntered,true);assert.equal(collisionRefused,true);
});
