'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),zlib=require('node:zlib'),crypto=require('node:crypto');
const fixtureRoot=path.resolve(__dirname,'..');
const project=process.env.TEST_ORDINAL_PROJECT_ROOT||fixtureRoot;
const privateRoot=process.env.TEST_ORDINAL_PRIVATE_SOURCE_ROOT||project;
const bundle=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(fixtureRoot,'tests/fixtures/reader-target-ordinal-paid-20261027-real.json.gz'))));
const {currentInputs,retiredPrompts,fixture}=bundle;
for(const row of Object.values(retiredPrompts))assert.equal(crypto.createHash('sha256').update(Buffer.from(row.rawBase64,'base64')).digest('hex'),row.sha256);
const sourceAvailable=c=>Object.values(c.sourceFiles).every(row=>row.rawBase64||fs.existsSync(row.path));
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const req=c=>JSON.parse(Buffer.from(c.realOldRequest.rawBase64,'base64'));
const response=c=>JSON.parse(Buffer.from(c.realOldResponse.rawBase64,'base64'));
// Entire scripts tree is copied into system temp. Even the existing engine's
// hard-coded .analysis-runs lock path therefore cannot touch production data.
const workspace=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'ordinal-private-workspace-'));
const pythonExecutable=require('node:child_process').execFileSync('bash',[path.join(project,'scripts/python-runtime.sh'),'-c','import sys; print(sys.executable)'],{cwd:project,encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}).trim();
assert.ok(path.isAbsolute(pythonExecutable)&&fs.statSync(pythonExecutable).isFile());
fs.mkdirSync(path.join(workspace,'.venv/bin'),{recursive:true});
fs.writeFileSync(path.join(workspace,'.venv/bin/python'),'#!/usr/bin/env bash\nexec '+"'"+pythonExecutable.replaceAll("'","'\"'\"'")+"'"+' \"$@\"\n',{mode:0o700});
fs.cpSync(path.join(project,'scripts'),path.join(workspace,'scripts'),{recursive:true,filter:p=>!p.includes('__pycache__')});
fs.cpSync(path.join(project,'manual/scripts'),path.join(workspace,'manual/scripts'),{recursive:true});
for(const name of ['config','prompts'])fs.cpSync(path.join(project,name),path.join(workspace,name),{recursive:true});

for(const name of ['deep-analyzer.js','analysis-engine.js','publish-to-blog.py','lib/reader-repair.js','lib/reader-target-ordinal-patch.js','lib/reader-resource-claims-replay-cli.js'])fs.copyFileSync(path.join(privateRoot,'scripts',name),path.join(workspace,'scripts',name));
if(process.env.TEST_METADATA_PUBLICATION_SOURCE)fs.copyFileSync(process.env.TEST_METADATA_PUBLICATION_SOURCE,path.join(workspace,'scripts/lib/reader-request-diagnostics.js'));
process.env.NODE_PATH=path.join(project,'node_modules');require('node:module').Module._initPaths();
const guardPath=path.join(project,'tests/helpers/isolated-tmp-write-guard.cjs');
assert.equal(sha(fs.readFileSync(guardPath)),'1581c918dace28ad826f919c742d38695d583cd4b778d7bc1b5ad2e74056743c');
const oldTransport=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(project,'tests/fixtures/reader-transport-continuation-2610-34220.json.gz'))));
const originalCanonicalParent=path.join(project,'data/runtime/daily-fresh-source-runs',oldTransport.runId,'reader-attempts/explicit-retry-rounds',oldTransport.parentReceipt.basename);
const canonicalParent=fs.existsSync(originalCanonicalParent)?originalCanonicalParent:path.join(project,'tests/fixtures/reader-transport-continuation-2610-34220.json.gz');
const canonicalBefore=fs.readFileSync(canonicalParent);
const canonicalUsage=path.join(project,'data/runtime/llm-usage'),canonicalUsageMtime=fs.existsSync(canonicalUsage)?fs.statSync(canonicalUsage).mtimeMs:null;
const readOnlyPythonNames=['reader_sealed_pdf_table_evidence.py','reader_sealed_pdf_quote_evidence.py','reader_sealed_pdf_column_units.py','reader_authenticated_pdf_hierarchical_table.py','reader_authenticated_pdf_footnote_evidence.py'];
for(const name of readOnlyPythonNames)assert.equal(sha(fs.readFileSync(path.join(workspace,'scripts',name))),sha(fs.readFileSync(path.join(project,'scripts',name))));
const writeGuard=require(guardPath).installTmpOnlyWriteGuard(workspace,{readOnlyPythonScripts:readOnlyPythonNames.map(name=>path.join(workspace,'scripts',name))});
Object.assign(process.env,{TMPDIR:workspace,TMP:workspace,TEMP:workspace,PYTHONDONTWRITEBYTECODE:'1',PYTHONPYCACHEPREFIX:path.join(workspace,'pycache')});
assert.throws(()=>fs.writeFileSync(canonicalParent,canonicalBefore),/TEST_TMP_WRITE_GUARD/);
assert.deepEqual(fs.readFileSync(canonicalParent),canonicalBefore);
console.log('protected absolute original material write blocked; original SHA='+sha(canonicalBefore));
const envLoader=require(path.join(workspace,'scripts/env-loader'));
const model=req(fixture.cases[0]).identity.model;
test.mock.method(envLoader,'loadProjectEnv',()=>{const values={PAPER_ANALYZER_MODEL:model.model,PAPER_ANALYZER_ENDPOINT:model.endpoint,PAPER_ANALYZER_API_KEY:'unused-test-no-network',PAPER_ANALYZER_FALLBACK_API_KEYS:'',PAPER_ANALYZER_SECONDARY_MODEL:model.model,PAPER_ANALYZER_SECONDARY_ENDPOINT:model.endpoint,PAPER_ANALYZER_SECONDARY_API_KEY:'unused-test-no-network',PAPER_ANALYZER_SECONDARY_FALLBACK_API_KEYS:'',PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY:'',HTTPS_PROXY:'http://127.0.0.1:9',PD_API_READER_REPAIR_MAX_TOKENS:'16000'};Object.assign(process.env,values);return values;});
const noNetwork=()=>{throw Error('TEST_NETWORK_FORBIDDEN')};
for(const [proto,names]of [['node:http',['request','get']],['node:https',['request','get']],['node:net',['connect','createConnection']],['node:tls',['connect']]])for(const name of names)test.mock.method(require(proto),name,noNetwork);
globalThis.fetch=noNetwork;
require(path.join(workspace,'scripts/workspace-role')).writeWorkspaceRole('daily',{root:workspace});
require(path.join(workspace,'scripts/workspace-role')).requireWorkspaceRole('daily',workspace);
const promptEvidence=require(path.join(workspace,'scripts/lib/prompt-evidence')),readPrompt=promptEvidence.readPromptEvidenceBytes;
test.mock.method(promptEvidence,'readPromptEvidenceBytes',(relative,...args)=>retiredPrompts[relative]?Buffer.from(retiredPrompts[relative].rawBase64,'base64'):readPrompt(relative,...args));
const Config=require(path.join(workspace,'scripts/config')),daily=require(path.join(workspace,'scripts/lib/daily-fresh-source-plan')),fresh=require(path.join(workspace,'scripts/lib/fresh-analysis-context')),engine=require(path.join(workspace,'scripts/analysis-engine')),repair=require(path.join(workspace,'scripts/lib/reader-repair')),diagnostics=require(path.join(workspace,'scripts/lib/reader-request-diagnostics')),ordinal=require(path.join(workspace,'scripts/lib/reader-target-ordinal-patch'));
const deep=require(path.join(workspace,'scripts/deep-analyzer'));
test.after(()=>{assert.deepEqual(fs.readFileSync(canonicalParent),canonicalBefore);assert.equal(fs.existsSync(canonicalUsage)?fs.statSync(canonicalUsage).mtimeMs:null,canonicalUsageMtime,'canonical usage directory unchanged');fs.rmSync(workspace,{recursive:true,force:true});});
let sequence=0;
function setup(c) {
    const q=req(c),root=path.join(workspace,'case-'+sequence++),run=path.join(root,q.identity.freshAnalysis.runId);
    Config.FILES.dailyFreshSourceRunsDir=root;Config.FILES.llmUsageDir=path.join(root,'usage');fs.mkdirSync(Config.FILES.llmUsageDir,{recursive:true,mode:0o700});
    fs.mkdirSync(run,{recursive:true,mode:0o700});fs.writeFileSync(path.join(run,'run.json'),Buffer.from(fixture.runManifestRawBase64,'base64'));fs.chmodSync(path.join(run,'run.json'),0o600);
    const source=path.join(run,'sources',q.identity.freshAnalysis.paperId,'generation-000001');fs.mkdirSync(source,{recursive:true,mode:0o700});
    for(const [name,record]of Object.entries(c.sourceFiles)){const raw=record.rawBase64?Buffer.from(record.rawBase64,'base64'):fs.readFileSync(record.path);assert.equal(sha(raw),record.sha256);fs.writeFileSync(path.join(source,name),raw,{mode:0o600});}
    const plan=daily.readDailyFreshSourcePlan(daily.dailyFreshSourceReference({...JSON.parse(Buffer.from(fixture.runManifestRawBase64,'base64')),runDir:run}));
    const paper={arxivId:q.identity.paperId,analysisManifest:{stages:{}}},directory=path.join(run,'reader-attempts');
    fs.mkdirSync(directory,{mode:0o700});
    const draft=structuredClone(q.draft),identity=structuredClone(q.identity),context={draftSha256:repair.hashDraft(draft),targets:structuredClone(q.repairTargets)};
    // Explicitly synthetic candidate setup. Original paid bytes/counters/fees
    // above are read-only evidence, never treated as a new ordinal response.
    const payload={status:'failed',draft,rawDraft:JSON.stringify(draft),attempts:q.contentAttempt-1,fullAttempts:1,transportFailures:0,noProgress:1,validationFailureStreak:2,failureSignature:'synthetic protocol fixture',issues:[]};
    const candidate=path.join(directory,repair.hashDraft(identity)+'.json');repair.saveFailedCandidate(directory,identity,payload);
    const scope=fn=>daily.withDailyFreshAnalysisContext(plan,()=>{fresh.attachFreshSourceRecord(paper,paper.analysisManifest,daily.readDailyFreshSource(plan,paper));return daily.withDailyFreshPaperSource(plan,paper,()=>engine.withPaperAnalysisLock(paper,fn));},{refreshReaderDiagnostics:true});
    return{c,q,root,run,source,plan,paper,directory,draft,identity,context,candidate,scope};
}
function bind(f,cap,saveResponse=true,writeWitness=true) {
    const prompt=ordinal.renderPrompt(cap,{feedback:'Synthetic protocol test only; not a new paid success.',evidence:'Original evidence remains source bound.'}),request=ordinal.requestContract(cap);
    const images=f.q.images.map((x,index)=>{const base64=Buffer.from('synthetic image '+index).toString('base64');return{...x,mime:'image/png',base64Sha256:sha(base64),base64}});
    const messages=[{role:'user',content:[{type:'text',text:prompt},...images.map(i=>({type:'image_url',image_url:{url:'data:'+i.mime+';base64,'+i.base64}}))]}];
    const diagnostic=diagnostics.beginReaderRepairDiagnostic(f.directory,{identity:f.identity,contentAttempt:f.q.contentAttempt,prompt,visibilityNotice:'synthetic only',draftSha256:request.draftSha256,draft:f.draft,repairTargets:f.context.targets,atomicOperation:null,inputMessagesSha256:sha(JSON.stringify(messages)),images:images.map(({base64,...meta})=>meta),readerTargetOrdinalRequest:request,actualRepairPromptContract:ordinal.CONTRACT,actualRepairPromptTemplateSha256:ordinal.TEMPLATE_SHA});
    ordinal.bindDiagnostic(cap,diagnostic,messages);
    const body=require(path.join(workspace,'scripts/utils')).buildRequestBody('openai_responses',f.identity.model.model,deep.sanitizeModelMessages(messages),16000,0.1);
    const witness=writeWitness?ordinal.recordRequestWitness(cap,body,{paperId:f.identity.paperId,stage:'apiReaderRepair',unitId:sha(diagnostic.id)}):null;
    const old=JSON.parse(response(f.c).rawResponse),values=new Map(old.replacements.map(t=>[t.path,t.value]));
    const raw=JSON.stringify({contract:ordinal.CONTRACT,version:1,requestToken:request.requestToken,replacements:f.context.targets.map((t,index)=>({targetOrdinal:index+1,value:values.get(t.path)}))});
    if(saveResponse)diagnostics.saveReaderRepairResponse(diagnostic,raw);
    return{request,prompt,messages,body,witness,diagnostic,raw};
}
function usage(f,b) {
    const eventId=crypto.randomUUID(),records=[];
    for(const event of [{kind:'request_started',eventId,inputSha256:sha(JSON.stringify(b.body))},{kind:'request',eventId,outcome:'completed',statusCode:200,inputSha256:sha(JSON.stringify(b.body)),outputTextSha256:sha(b.raw)},{kind:'disposition',eventId:crypto.randomUUID(),disposition:'rejected',outputTextSha256:sha(b.raw)}]) {
        // Explicit synthetic ledger for compiler/cold tamper tests, not real fee evidence.
        const value={version:'llm-usage-v1',runId:f.identity.freshAnalysis.runId,at:new Date().toISOString(),contentAttempt:f.q.contentAttempt,transportAttempt:1,protocol:f.identity.model.protocol,model:f.identity.model.model,...event,paperId:f.identity.paperId,stage:'apiReaderRepair',unitId:sha(b.diagnostic.id),synthetic:true};
        const file=path.join(Config.FILES.llmUsageDir,crypto.randomUUID()+'.json');fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});records.push({file,sha256:sha(fs.readFileSync(file)),eventId:value.eventId,kind:value.kind});
    }return records;
}
for(const c of fixture.cases)test('pure compiler real '+c.expectedTargetCount+' targets: synthetic ACK and original wrong-SHA response remains rejected',()=>{
 const q=req(c),old=JSON.parse(response(c).rawResponse),targets=q.repairTargets.map((t,index)=>({targetOrdinal:index+1,path:t.path,oldSha256:t.oldSha256,valueType:Array.isArray(t.value)?'array':t.value===null?'null':typeof t.value}));
 const request={contract:ordinal.CONTRACT,version:1,templateSha256:ordinal.TEMPLATE_SHA,requestSalt:'a'.repeat(32),identitySha256:repair.hashDraft(q.identity),candidateEnvelopeSha256:sha('SYNTHETIC pure compiler parent; no source/dispatch permission'),draftSha256:repair.hashDraft(q.draft),targets};
 request.requestToken=sha(JSON.stringify({domain:ordinal.CONTRACT,requestSalt:request.requestSalt,identitySha256:request.identitySha256,candidateEnvelopeSha256:request.candidateEnvelopeSha256,draftSha256:request.draftSha256,orderedTargetsSha256:repair.hashDraft(targets)})).slice(0,16);
 const values=new Map(old.replacements.map(t=>[t.path,t.value])),raw=JSON.stringify({contract:ordinal.CONTRACT,version:1,requestToken:request.requestToken,replacements:targets.map(t=>({targetOrdinal:t.targetOrdinal,value:values.get(t.path)}))});
 const compiled=ordinal.compileReaderTargetOrdinalPatch(q.draft,request,raw,{});assert.equal(compiled.patch.replacements.length,c.expectedTargetCount);
 assert.throws(()=>repair.applyReaderPatch(q.draft,old,q.repairTargets.map(t=>t.path)));assert.throws(()=>ordinal.compileReaderTargetOrdinalPatch({...q.draft,oneSentenceThesis:'unauthorized parent'},request,raw,{}));
});
for(const c of fixture.cases)test('SYNTHETIC new ACK over real '+c.expectedTargetCount+' targets; old paid wrongSHA stays rejected; strict patch/cold replay only',{skip:!sourceAvailable(c)&&'Original 32310 four-file source is not present; pure compiler remains covered.'},async()=>{
    const f=setup(c),original=fs.readFileSync(f.candidate);
    await f.scope(()=>{
        const old=JSON.parse(response(c).rawResponse);assert.throws(()=>repair.applyReaderPatch(f.draft,old,f.context.targets.map(t=>t.path)));
        const cap=ordinal.prepare({...f,repairContext:f.context}),b=bind(f,cap),compiled=ordinal.compile(cap,b.raw,{});
        assert.equal(compiled.patch.replacements.length,c.expectedTargetCount);assert.equal(compiled.proof.mapping.length,c.expectedTargetCount);
        assert.equal(f.q.images.length,c.expectedTargetCount===7?2:0);assert.ok(!fs.readFileSync(b.witness.path,'utf8').includes('data:image'));
        const sealed=ordinal.seal(cap,usage(f,b));
        const pins={requestSha256:b.diagnostic.requestSha256,responseSha256:compiled.compilation.responseSha256,compilationSha256:compiled.compilation.sha256,sealSha256:sealed.sha256};
        const replay=ordinal.replay({...f,requestId:b.diagnostic.id,pins});assert.deepEqual(replay.patch,compiled.patch);assert.deepEqual(replay.after,compiled.after);
        assert.equal(replay.normalParserRequired,true);assert.deepEqual(fs.readFileSync(f.candidate),original);
        const content=fs.readFileSync(compiled.compilation.path);fs.appendFileSync(compiled.compilation.path,' ');
        assert.throws(()=>ordinal.replay({...f,requestId:b.diagnostic.id,pins}),/changed/);fs.writeFileSync(compiled.compilation.path,content);
        assert.throws(()=>ordinal.replay({...f,requestId:b.diagnostic.id,pins:{...pins,requestSha256:'0'.repeat(64)}}),/changed/);
        // Adversarial cold edit: recompute all diagnostic/compiler byte pins
        // after changing a non-target parent node, retaining actual ACK/fees.
        const qfile=path.join(b.diagnostic.directory,b.diagnostic.id+'.request.json'),rfile=path.join(b.diagnostic.directory,b.diagnostic.id+'.response.json');
        const parentfile=path.join(b.diagnostic.directory,b.diagnostic.id+'.ordinal-parent.json');
        const beforeFiles=[qfile,rfile,compiled.compilation.path,parentfile].map(file=>[file,fs.readFileSync(file)]);
        const qedit=JSON.parse(beforeFiles[0][1]),redit=JSON.parse(beforeFiles[1][1]),cedit=JSON.parse(beforeFiles[2][1]);
        qedit.draft.oneSentenceThesis+=' SYNTHETIC unauthorized parent edit';qedit.draftSha256=repair.hashDraft(qedit.draft);qedit.readerTargetOrdinalRequest.draftSha256=qedit.draftSha256;
        const pe=JSON.parse(beforeFiles[3][1]),envelope=JSON.parse(Buffer.from(pe.candidateRawBase64,'base64'));envelope.payload.draft=qedit.draft;envelope.payloadSha256=repair.hashDraft(envelope.payload);const pbytes=Buffer.from(JSON.stringify(envelope));pe.candidateRawBase64=pbytes.toString('base64');pe.candidateEnvelopeSha256=sha(pbytes);qedit.readerTargetOrdinalRequest.candidateEnvelopeSha256=pe.candidateEnvelopeSha256;fs.writeFileSync(parentfile,JSON.stringify(pe));
        fs.writeFileSync(qfile,JSON.stringify(qedit));const qsha=sha(fs.readFileSync(qfile));redit.requestSha256=qsha;fs.writeFileSync(rfile,JSON.stringify(redit));
        cedit.beforeDraft=qedit.draft;cedit.afterDraft.oneSentenceThesis=qedit.draft.oneSentenceThesis;cedit.requestSha256=qsha;cedit.responseSha256=sha(fs.readFileSync(rfile));
        cedit.standardPatch.draftSha256=qedit.draftSha256;cedit.proof.beforeDraftSha256=qedit.draftSha256;cedit.proof.afterDraftSha256=repair.hashDraft(cedit.afterDraft);cedit.proof.standardPatchSha256=repair.hashDraft(cedit.standardPatch);
        fs.writeFileSync(compiled.compilation.path,JSON.stringify(cedit));
        assert.throws(()=>ordinal.replay({...f,requestId:b.diagnostic.id,pins:{...pins,requestSha256:qsha,responseSha256:cedit.responseSha256,compilationSha256:sha(fs.readFileSync(compiled.compilation.path))}}),/invalid original request/);
        for(const[file,bytes]of beforeFiles)fs.writeFileSync(file,bytes);

    });
});
test('unmarked direct-conference and old non-daily records remain outside ordinary daily protocol',()=>{
 const paper={id:'conference:icml:2026:example',freshRewriteProvenance:{contract:'fresh-source-analysis-v1',runId:crypto.randomUUID()},analysisManifest:{contracts:{},stages:{}}};
 assert.equal(ordinal.validateCompletion(paper),true);
 const marked=structuredClone(paper);marked.analysisManifest.contracts.readerTargetOrdinalPatch=ordinal.CONTRACT;
 assert.throws(()=>ordinal.validateCompletion(marked),/canonical daily source/);
 assert.equal(ordinal.validateCompletion({arxivId:'2610.32310',analysisManifest:{stages:{}}}),true);
});
test('strict RAW rejects duplicates, unsafe keys, float/exponent ordinals, truncation and wrappers',()=>{
 const token='0123456789abcdef',good={contract:ordinal.CONTRACT,version:1,requestToken:token,replacements:[{targetOrdinal:1,value:'x'}]},raw=JSON.stringify(good);
 assert.equal(ordinal.parseAck(raw).requestToken,token);
 for(const bad of [raw.replace('"version":1','"version":1,"version":1'),raw.replace('"targetOrdinal":1','"targetOrdinal":1,"targetOrdinal":1'),raw.replace('"targetOrdinal":1','"targetOrdinal":1.0'),raw.replace('"targetOrdinal":1','"targetOrdinal":1e0'),raw.replace('"targetOrdinal":1','"\\u0074argetOrdinal":1.0'),raw.replace('"value":"x"','"value":{"__proto__":{}}'),raw.replace('"value":"x"','"value":{"constructor":{}}'),raw.replace('"value":"x"','"value":{"prototype":{}}'),raw.slice(0,-1),'```json\n'+raw+'\n```',raw+raw,JSON.stringify({...good,path:'/sections/0/body'}),JSON.stringify({...good,draftSha256:'0'.repeat(64)})])assert.throws(()=>ordinal.parseAck(bad));
});
test('private capability, request nonce, target set/type, draft/node and special-scope guards',async()=>{
 const f=setup(fixture.cases[1]);assert.throws(()=>ordinal.prepare({...f,repairContext:f.context}),/scope/);
 await f.scope(()=>{
  assert.throws(()=>ordinal.requestContract({}),/capability/);
  assert.equal(ordinal.hasActiveCompletion(f.paper),false,'old ordinary paper has no compiled completion and is not denied full requests');
  assert.throws(()=>ordinal.prepare({...f,identity:{...f.identity,model:{...f.identity.model,protocol:'openai_chat'}},repairContext:f.context}),/Responses-only/);
  const missingId=structuredClone(f.paper);delete missingId.arxivId;assert.throws(()=>ordinal.validateCompletion(missingId),/actual daily source lacks canonical paper ID/);
  for(const extra of [{metadataOperation:{}},{conceptTermsContext:{}},{readerFactLocalRevision:true},{resourceLocalRevision:true},{atomicOperation:{}}])assert.throws(()=>ordinal.prepare({...f,repairContext:f.context,options:extra}),/excluded/);
  for(const context of [{...f.context,atomicOperation:{kind:'x'}},{...f.context,sectionGroupPlanContract:'x'},{...f.context,targets:[]},{...f.context,targets:Array(9).fill(f.context.targets[0])},{...f.context,targets:[f.context.targets[0],f.context.targets[0]]},{...f.context,targets:[{...f.context.targets[0],path:'/sections'}]},{...f.context,targets:[{...f.context.targets[0],oldSha256:'0'.repeat(64)}]}])assert.throws(()=>ordinal.prepare({...f,repairContext:context}));
  assert.throws(()=>ordinal.prepare({...f,identity:{...f.identity,paperId:'2610.99999'},repairContext:f.context}),/scope/);
  assert.throws(()=>ordinal.prepare({...f,identity:{...f.identity,sourceSha256:'0'.repeat(64)},repairContext:f.context}),/scope/);
  assert.throws(()=>ordinal.prepare({...f,draft:{...f.draft,readerTitle:'changed'},repairContext:f.context}),/stale/);
  const cap=ordinal.prepare({...f,repairContext:f.context}),b=bind(f,cap),parsed=JSON.parse(b.raw);
  // A rejected nonce/type response is individually saved against a fresh
  // synthetic request, never overwrites an actual paid diagnostic.
  const altered=[{...parsed,requestToken:'f'.repeat(16)},{...parsed,replacements:[]},{...parsed,replacements:[{...parsed.replacements[0],targetOrdinal:8}]},{...parsed,replacements:[parsed.replacements[0],parsed.replacements[0]]},{...parsed,replacements:[{targetOrdinal:1,value:'wrong object node type'}]},{...parsed,replacements:[{...parsed.replacements[0],path:f.context.targets[0].path}]}];
  for(const value of altered){const cap2=ordinal.prepare({...f,repairContext:f.context}),b2=bind(f,cap2),file=path.join(b2.diagnostic.directory,b2.diagnostic.id+'.response.json');
   // Temporary synthetic response substitution, preserving the request link.
   const resp=JSON.parse(fs.readFileSync(file));const raw=JSON.stringify({...value,requestToken:value.requestToken===parsed.requestToken?b2.request.requestToken:value.requestToken});resp.rawResponse=raw;resp.outputTextSha256=sha(raw);fs.writeFileSync(file,JSON.stringify(resp));assert.throws(()=>ordinal.compile(cap2,raw,{}));}
  const wrongBody={...b.body,input:[]};assert.throws(()=>ordinal.recordRequestWitness(cap,wrongBody,{paperId:f.identity.paperId,stage:'apiReaderRepair',unitId:sha(b.diagnostic.id)}),/wire input/);
  const bytes=fs.readFileSync(f.candidate);fs.appendFileSync(f.candidate,' ');assert.throws(()=>ordinal.compile(cap,b.raw,{}),/changed/);fs.writeFileSync(f.candidate,bytes);
 });
});

test('SYNTHETIC public requestLlmJson mock transport uses real normal fsync ledger/capture and cold recomputes 7 targets with 2 images',async()=>{
 const f=setup(fixture.cases[1]);
 await f.scope(async()=>{
  const cap=ordinal.prepare({...f,repairContext:f.context}),b=bind(f,cap,false);
  const usageApi=require(path.join(workspace,'scripts/lib/llm-usage')),api=require(path.join(workspace,'scripts/utils'));let calls=0;
  const capture=await usageApi.withPersistedLlmUsageRecords(async()=>{
   const r=await api.requestLlmJson(f.identity.model.endpoint+'/responses',f.identity.model.endpoint,f.identity.model.model,b.body,{}, {
    usageDirectory:Config.FILES.llmUsageDir,
    usageContext:{paperId:f.identity.paperId,runId:f.identity.freshAnalysis.runId,stage:'apiReaderRepair',contentAttempt:f.q.contentAttempt,unitId:sha(b.diagnostic.id)},
    transportRequestFn:async()=>{calls++;return{statusCode:200,body:{status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:b.raw}]}]}};}
   });
   assert.equal(r.body.output[0].content[0].text,b.raw);diagnostics.saveReaderRepairResponse(b.diagnostic,b.raw);
   return ordinal.compile(cap,b.raw,{});
  });
  const disposition=usageApi.withPersistedLlmUsageRecords(()=>usageApi.recordLlmDisposition({paperId:f.identity.paperId,stage:'apiReaderRepair',unitId:sha(b.diagnostic.id),contentAttempt:f.q.contentAttempt,outputTextSha256:sha(b.raw),responseText:b.raw,disposition:'rejected',errorCode:'SYNTHETIC_PROTOCOL_NOT_QUALIFICATION'},{directory:Config.FILES.llmUsageDir}));
  assert.equal(calls,1);assert.equal(capture.records.length,2);assert.equal(disposition.records.length,1);
  assert.ok([...capture.records,...disposition.records].every(r=>r.file.startsWith(workspace+path.sep)));
  for(const record of [...capture.records,...disposition.records])writeGuard.assertProof(record);
  assert.ok(!fs.readFileSync(f.candidate,'utf8').includes('receiptFile'));
  assert.ok(!fs.readFileSync(f.candidate,'utf8').includes('explicitReaderRetryRound'));
  assert.ok(!Object.prototype.hasOwnProperty.call(repair.loadFailedCandidate(f.directory,f.identity),'explicitReaderRetryRound'));
  const witness=JSON.parse(fs.readFileSync(b.witness.path));
  assert.equal(witness.providerInputSha256,sha(JSON.stringify(b.body)));
  assert.notEqual(witness.providerInputSha256,b.witness.sha256,'witness own file SHA is not actual image-bearing provider body SHA');
  const terminal=JSON.parse(fs.readFileSync(capture.records.find(r=>r.kind==='request').file));
  assert.equal(terminal.inputSha256,witness.providerInputSha256);assert.notEqual(terminal.inputSha256,b.witness.sha256);
  const compiled=capture.result,seal=ordinal.seal(cap,[...capture.records,...disposition.records]);
  const pins={requestSha256:b.diagnostic.requestSha256,responseSha256:compiled.compilation.responseSha256,compilationSha256:compiled.compilation.sha256,sealSha256:seal.sha256};
  assert.deepEqual(ordinal.replay({...f,requestId:b.diagnostic.id,pins}).patch,compiled.patch);
  const e=capture.records.find(r=>r.kind==='request'),bytes=fs.readFileSync(e.file);fs.appendFileSync(e.file,' ');assert.throws(()=>ordinal.replay({...f,requestId:b.diagnostic.id,pins}),/changed/);fs.writeFileSync(e.file,bytes);
  for(const source of [f.c.realOldRequest,f.c.realOldResponse,...f.c.realOldFeeAndDisposition])if(fs.existsSync(source.path))assert.equal(sha(fs.readFileSync(source.path)),source.sha256);
  for(const file of fs.readdirSync(b.diagnostic.directory))assert.ok(!fs.readFileSync(path.join(b.diagnostic.directory,file),'utf8').includes('data:image/'));
 });
});

for(const c of fixture.cases)test('SYNTHETIC actual normal Reader loop/finalizer/cold index from real '+c.expectedTargetCount+'-target draft; no paid success',{skip:!sourceAvailable(c)&&'Original 32310 four-file source absent; local actual chain receipt retained.'},async()=>{
 const f=setup(c),current=currentInputs.papers.find(p=>p.arxivId===c.paperId);Object.assign(f.paper,structuredClone(current));
 // Real source/resources/checkpoint; only the new controlled candidate counters
 // and model image/response are synthetic. No old window or fee is rewritten.
 let calls=0,result;
 await f.scope(async()=>{
  const details=daily.readDailyFreshSource(f.plan,f.paper),evidence=deep.buildApiReaderEvidenceContext('',details.text,details.structuredArtifacts,f.paper.arxivId,null,f.paper.apiReaderResources,false);
  const canvas=require('@napi-rs/canvas').createCanvas(32,32);const context=canvas.getContext('2d');context.fillStyle='white';context.fillRect(0,0,32,32);const png=canvas.toBuffer('image/png');
  const api=require(path.join(workspace,'scripts/utils')),usageApi=require(path.join(workspace,'scripts/lib/llm-usage'));
  const options={sourceText:details.text,structuredArtifacts:details.structuredArtifacts,readerAttemptsDir:f.directory,readerMaxAttempts:3,
   readerMaterializeFigures:async figures=>figures.map(fig=>({...fig,rawBytes:png,assetSha256:sha(png),assetBytes:png.length,assetMediaType:'image/png',mediaType:'image/png'})),
   readerRecordDisposition:event=>usageApi.recordLlmDisposition(event,{directory:Config.FILES.llmUsageDir}),
   readerCallModel:async(messages,tokens,requestOptions)=>{
    assert.equal(requestOptions.usageContext.stage,'apiReaderRepair','controlled existing-node test must not request full');
    assert.ok(requestOptions.readerTargetOrdinalCapability,'normal prompt branch must mint ordinal capability');
    const request=ordinal.requestContract(requestOptions.readerTargetOrdinalCapability),old=JSON.parse(response(c).rawResponse),values=new Map(old.replacements.map(r=>[r.path,r.value]));
    assert.deepEqual(request.targets.map(t=>t.path),f.context.targets.map(t=>t.path));
    const raw=JSON.stringify({contract:ordinal.CONTRACT,version:1,requestToken:request.requestToken,replacements:request.targets.map(t=>({targetOrdinal:t.targetOrdinal,value:values.get(t.path)}))});
    return deep.callModelWithConfig(messages,tokens,1,{endpoint:f.identity.model.endpoint,model:f.identity.model.model,key:'unused-test-no-network',apiKeys:[],temperature:requestOptions.temperature,
     usageContext:requestOptions.usageContext,readerTargetOrdinalCapability:requestOptions.readerTargetOrdinalCapability,
     requestFn:(url,endpoint,model,body,headers,wireOptions)=>api.requestLlmJson(url,endpoint,model,body,{}, {...wireOptions,usageDirectory:Config.FILES.llmUsageDir,transportRequestFn:async()=>{calls++;return {statusCode:200,body:{status:'completed',usage:{input_tokens:1,output_tokens:1,total_tokens:2},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:raw}]}]}};}})});
   }};
  const prepared=await deep.prepareApiReaderRetryIdentity(f.paper,f.paper.analysisCheckpoint,evidence,options);
  const oldFile=f.candidate;f.identity=prepared.identity;f.candidate=path.join(f.directory,repair.hashDraft(f.identity)+'.json');
  const figures=[...evidence.matchAll(/^FIGURE_(\d+):\s*([^\n]*)\nFIGURE_\1_URL:\s*([^\s]+)$/gm)].map(m=>({ordinal:Number(m[1]),caption:m[2].trim(),url:m[3].trim()}));
  const preflight=await deep.preflightReaderModelImages(figures.map(fig=>({...fig,kind:'figure',inputId:`figure:${fig.ordinal}:${sha(png)}`,rawBytes:png,assetSha256:sha(png),assetBytes:png.length,mediaType:'image/png',label:fig.url})));
  assert.equal(preflight.rejected.length,0);
  const imageEvidence=preflight.ready.map(i=>({inputId:i.inputId,kind:i.kind,ordinal:i.ordinal,url:i.url,sha256:i.sourceSha256,sourceSha256:i.sourceSha256,sourceBytes:i.sourceBytes,sourceWidth:i.sourceWidth,sourceHeight:i.sourceHeight,modelPayloadSha256:i.modelPayloadSha256,modelPayloadBytes:i.modelPayloadBytes,modelPayloadWidth:i.modelPayloadWidth,modelPayloadHeight:i.modelPayloadHeight,modelPayloadTransform:i.modelPayloadTransform,status:'ready'}));
  // Synthetic F2/A2 baseline exercises normal existing-node-only admission;
  // the original real F1/A5/A3 materials remain immutable outside this case.
  const payload={status:'failed',draft:structuredClone(f.draft),rawDraft:JSON.stringify(f.draft),attempts:2,fullAttempts:2,transportFailures:0,noProgress:0,failureSignature:'',validationFailureStreak:0,issues:[],imageEvidence,ephemeralImageEvidence:{imageEvidence,directSupplementaryEvidence:[]}};
  if(oldFile!==f.candidate)fs.unlinkSync(oldFile);repair.saveFailedCandidate(f.directory,f.identity,payload);
  test.mock.method(require(path.join(workspace,'scripts/lib/direct-rewrite-analysis-context')),'directReaderCandidateCommitDeferred',()=>true);
  result=await deep.generateApiReaderArticleDetailed(f.paper,f.paper.analysisCheckpoint,evidence,options);
  assert.equal(result.ordinalPatchCompilations.length,1);console.log('ordinary normal '+c.paperId+' generator+fees+compiler+fullparse complete');
  result=await deep.generateApiReaderArticleDetailed(f.paper,f.paper.analysisCheckpoint,evidence,options);
  assert.equal(calls,1,'saved paid candidate must recover through normal first saved-success return without another request');console.log('ordinary normal '+c.paperId+' saved-zero-request replay complete');

  assert.equal(calls,1);assert.equal(result.attempts,3);assert.equal(result.fullAttempts,2);assert.equal(result.ordinalPatchCompilations.length,1);
  // Only final figure availability is mocked; all source/science/Reader parsing
  // and normal finalizer remain real. This is not publication qualification.
  test.mock.method(require(path.join(workspace,'scripts/lib/reader-paid-resolved-render')),'reuseVerifiedPaidResolvedFigures',()=>[]);
  await deep.finalizeApiReaderRefresh(f.paper,details,result,{execution:{executionKind:'synthetic_protocol_test',model:f.identity.model.model,protocol:f.identity.model.protocol,attempts:result.attempts,fullAttempts:result.fullAttempts,transportFailures:result.transportFailures},readerResources:f.paper.apiReaderResources,preserveReaderUpstream:true});
  assert.ok(f.paper.analysisManifest.stages.apiReaderArticle.ordinalCompletionProof);assert.equal(ordinal.hasActiveCompletion(f.paper),true,'successful retired candidate still has an active source-bound completion');console.log('ordinary normal '+c.paperId+' finalizer+stable-index complete');
  const changed=structuredClone(f.paper);delete changed.analysisManifest.contracts.readerTargetOrdinalPatch;
  delete changed.analysisManifest.stages.apiReaderArticle.ordinalPatchContract;delete changed.analysisManifest.stages.apiReaderArticle.ordinalPatchCompilations;delete changed.analysisManifest.stages.apiReaderArticle.ordinalCompletionProof;
  changed.apiReaderArticle+='\n';changed.apiReaderArticleSha256=sha(changed.apiReaderArticle);changed.analysisManifest.stages.apiReaderArticle.articleSha256=changed.apiReaderArticleSha256;
  assert.throws(()=>ordinal.validateCompletion(changed),/marker removed/);
  const bad=structuredClone(f.paper);bad.apiReaderArticle+=' changed';assert.throws(()=>ordinal.validateCompletion(bad),/differs/);
 });
 const diagnostic=[];assert.equal(engine.hasValidApiReaderV3Records(f.paper,{diagnostics:diagnostic}),true,JSON.stringify(diagnostic));console.log('ordinary normal '+c.paperId+' actual engine cold passed');
 const helper=require(path.join(fixtureRoot,'tests/helpers/run-publication-cli-in-process.cjs'));
 const sourceText=daily.readDailyFreshSource(f.plan,f.paper).text;
 const cliOptions={sourceFile:path.join(workspace,'scripts/lib/reader-resource-claims-replay-cli.js'),canonicalFilename:path.join(workspace,'scripts/lib/reader-resource-claims-replay-cli.js'),temporaryDirectory:workspace,
  moduleOverrides:{'./reader-target-ordinal-patch':ordinal,'./reader-request-diagnostics':diagnostics}};
 const cli=await helper.runPublicationCliInProcess({...cliOptions,input:{paper:f.paper,sourceText}});
 assert.equal(cli.actualCliSourceExecuted,true);assert.equal(cli.noChildProcess,true);assert.equal(cli.exitCode,0,cli.raw);assert.equal(cli.result.verified,true,cli.raw);
 const stripped=structuredClone(f.paper);delete stripped.analysisManifest.contracts.readerTargetOrdinalPatch;
 for(const key of ['ordinalPatchContract','ordinalPatchCompilations','ordinalCompletionProof'])delete stripped.analysisManifest.stages.apiReaderArticle[key];
 const rejected=await helper.runPublicationCliInProcess({...cliOptions,input:{paper:stripped,sourceText}});
 assert.equal(rejected.exitCode,1);assert.equal(rejected.result.verified,false);assert.match(rejected.result.message,/marker removed/);
 assert.equal(calls,1);console.log('ordinary normal '+c.paperId+' actual publication CLI cold and marker-strip rejection passed');

});
