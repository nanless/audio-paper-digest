'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const os=require('node:os'),zlib=require('node:zlib'),crypto=require('node:crypto'),Module=require('node:module');
const ROOT=path.resolve(__dirname,'..'),sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'version-metadata-cold-private-'));
// Install before the first project import or compiled private source.
const guard=require('./helpers/isolated-tmp-write-guard.cjs').installTmpOnlyWriteGuard(temp,{readOnlyPythonScripts:[
 'reader_sealed_pdf_quote_evidence.py','reader_sealed_pdf_column_units.py','reader_authenticated_pdf_hierarchical_table.py',
 'reader_authenticated_pdf_footnote_evidence.py'].map(name=>path.join(ROOT,'scripts',name))});
Object.assign(process.env,{TMPDIR:temp,TMP:temp,TEMP:temp,PYTHONDONTWRITEBYTECODE:'1',PYTHONPYCACHEPREFIX:path.join(temp,'pycache')});
const noNetwork=()=>{throw Object.assign(Error('TEST_NETWORK_FORBIDDEN'),{code:'TEST_NETWORK_FORBIDDEN'});};
for(const [name,methods]of [['http',['request','get']],['https',['request','get']],['net',['connect','createConnection']],['tls',['connect']]])
 for(const method of methods)require('node:'+name)[method]=noNetwork;
globalThis.fetch=noNetwork;
const real=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT,'tests/fixtures/reader-version4-2610-34220.real.json.gz'))));
const sourceFixture=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT,real.sourceFixtureReference.file))));
const decode=record=>{const bytes=Buffer.from(record.rawBase64,'base64');assert.equal(sha(bytes),record.sha256);return bytes;};
const current=JSON.parse(decode(real.candidate)),raw=current.payload.rawDraft;
const canonicalUsage=path.join(ROOT,'data/runtime/llm-usage');
const protectedFiles=[real.candidate.file,real.parent.file,real.sidecar.file,...real.usage.map(x=>x.file),
 path.join(ROOT,'data/current/deep-analysis-result.json'),...Object.keys(sourceFixture.sourceFiles).map(name=>
 path.join(ROOT,'data/runtime/daily-fresh-source-runs',sourceFixture.runId,'sources/2610.34220/generation-000001',name))];
const beforeProtected=new Map(protectedFiles.filter(file=>fs.existsSync(file)).map(file=>[file,sha(fs.readFileSync(file))]));
const beforeUsage=fs.existsSync(canonicalUsage)?fs.statSync(canonicalUsage).mtimeMs:null;
test.after(()=>{for(const[file,digest]of beforeProtected)assert.equal(sha(fs.readFileSync(file)),digest,'protected original material '+file);
 assert.equal(fs.existsSync(canonicalUsage)?fs.statSync(canonicalUsage).mtimeMs:null,beforeUsage,'canonical usage directory unchanged');
 fs.rmSync(temp,{recursive:true,force:true});});
// Test route only: no real credential/.env load and no change to parent process.
for(const key of Object.keys(process.env))if(key.startsWith('PAPER_ANALYZER_'))delete process.env[key];
Object.assign(process.env,{PAPER_ANALYZER_API_KEY:'isolated-test-unused',PAPER_ANALYZER_MODEL:current.identity.model.model,
 PAPER_ANALYZER_ENDPOINT:current.identity.model.endpoint,PAPER_ANALYZER_SECONDARY_API_KEY:'isolated-test-unused',
 PAPER_ANALYZER_SECONDARY_MODEL:current.identity.model.model,PAPER_ANALYZER_SECONDARY_ENDPOINT:current.identity.model.endpoint,
 PD_API_READER_REPAIR_MAX_TOKENS:String(current.identity.repairMaxTokens),HTTPS_PROXY:'http://127.0.0.1:7897'});
require(path.join(ROOT,'scripts/env-loader')).loadProjectEnv=()=>({});
const Config=require(path.join(ROOT,'scripts/config'));
Config.FILES.dailyFreshSourceRunsDir=path.join(temp,'runs');Config.FILES.llmUsageDir=path.join(temp,'usage');
fs.mkdirSync(Config.FILES.llmUsageDir,{recursive:true,mode:0o700});
Config.FILES.llmAccountPoolState=path.join(temp,'account-pool.json');
const isBadAck=process.env.TEST_METADATA_BAD_ACK==='1',withRetry=process.env.TEST_METADATA_TRANSPORT_RETRY==='1';
let transportCalls=0;
const utils=require(path.join(ROOT,'scripts/utils')),realRequest=utils.requestLlmJson;
// Compiled private files retain production __filename for relative imports.
// Fingerprint reads must still see the actual private implementation bytes on
// every normal call, not only during the initial identity preparation.
const reflectedSourceFiles=new Map(['scripts/lib/reader-repair.js','scripts/lib/reader-request-diagnostics.js','scripts/lib/llm-usage.js',
 'scripts/deep-analyzer.js','scripts/analysis-engine.js','scripts/lib/reader-transport-continuation.js']
 .map(file=>[path.join(ROOT,file),path.join(ROOT,file)]));
const guardedRead=fs.readFileSync;
fs.readFileSync=function(file,...args){return guardedRead.call(fs,typeof file==='string'?(reflectedSourceFiles.get(path.resolve(file))||file):file,...args);};
utils.requestLlmJson=(url,endpoint,model,body,headers,options)=>realRequest(url,endpoint,model,body,headers,{...options,
 transportRequestFn:async(_url,actualBody,_headers,transportOptions)=>{
  transportCalls++;assert.equal(actualBody.max_output_tokens,16000);assert.doesNotMatch(JSON.stringify(actualBody),/input_image|image_url/);
  assert.equal(transportOptions.usageContext.stage,'apiReaderRepair');assert.equal(transportOptions.usageContext.contentAttempt,2);
  assert.match(transportOptions.usageContext.unitId,/^[a-f0-9]{64}$/);
  await new Promise(resolve=>setTimeout(resolve,3));
  if(withRetry&&transportCalls===1)throw Object.assign(Error('Synthetic isolated transport reset'),{code:'ECONNRESET'});
  const ack=JSON.stringify({version:1,rawSha256:isBadAck?'0'.repeat(64):sha(raw),fromVersion:4,toVersion:3});
  const response={id:'synthetic-metadata-response',object:'response',status:'completed',model,
   output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:ack}]}],
   usage:{input_tokens:100,output_tokens:20,total_tokens:120}};
  return{statusCode:200,body:response,raw:JSON.stringify(response)};
 }});
const promptBytes=fs.readFileSync(path.join(ROOT,'tests/fixtures/reader-version-metadata-retired-prompt-bytes.json'));
assert.equal(sha(promptBytes),'359415b9b35ba1f94d3a5288f22abba444dd7cc80c62287f3595554b2dec8ac9');
const historicalPrompts=new Map(JSON.parse(promptBytes).rows.map(row=>{const bytes=Buffer.from(row.rawBase64,'base64');assert.equal(sha(bytes),row.sha256);
 const index=JSON.parse(fs.readFileSync(path.join(ROOT,'scripts/lib/git-prompt-evidence-index.json')));
 assert.equal(index.retiredPaths[row.relative],row.sha256);assert.equal(index.blobs[row.sha256].blobOid,row.blobOid);return[row.relative,{bytes,sha256:row.sha256}];}));
const promptEvidence=require(path.join(ROOT,'scripts/lib/prompt-evidence')),normalPromptRead=promptEvidence.readPromptEvidenceBytes;
promptEvidence.readPromptEvidenceBytes=function(relative,options={}){const original=historicalPrompts.get(relative);if(!original)return normalPromptRead(relative,options);
 if(options.expectedSha256!==undefined&&options.expectedSha256!==null)assert.equal(options.expectedSha256,original.sha256);return Buffer.from(original.bytes);};
function compile(relative){const file=path.join(ROOT,relative);let source=fs.readFileSync(path.join(ROOT,relative),'utf8');
 if(relative==='scripts/analysis-engine.js')source=source.replace("return path.join(__dirname, '..', 'data', 'current', '.analysis-runs', id);",`return path.join(${JSON.stringify(temp)}, '.analysis-runs', id);`);
if(relative==='scripts/deep-analyzer.js'){
 // Test-only image I/O adapter: replay the pinned original preflight hashes.
 // There are no pixels/base64 here and the new metadata HTTP body MUST be 0-image.
 const begin=source.indexOf('    const materializedReaderImages = figureEvidenceEntries.length > 0');
 const endText='    const modelImagePreflightEvidenceSha256 = repair.hashDraft(ephemeralImageEvidence);';
 const end=source.indexOf(endText,begin);assert.ok(begin>0&&end>begin);
 source=source.slice(0,begin)+'    const materializedReaderImages = [];\n    const ephemeralImageEvidence = '+JSON.stringify(current.payload.ephemeralImageEvidence)
  +';\n    const allImageInputs = ephemeralImageEvidence.imageEvidence;\n'+endText+source.slice(end+endText.length);
 source+='\nmaterializeApiReaderFigures=async()=>[];\nmodule.exports._testNormalCallModel=callModel;\n';
 }
const m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));require.cache[file]=m;m._compile(source,file);m.loaded=true;return m.exports;}
const usage=compile('scripts/lib/llm-usage.js'),repair=compile('scripts/lib/reader-repair.js'),diagnostics=compile('scripts/lib/reader-request-diagnostics.js');
const transportContinuation=compile('scripts/lib/reader-transport-continuation.js');
const deep=compile('scripts/deep-analyzer.js'),engine=compile('scripts/analysis-engine.js');
const daily=require(path.join(ROOT,'scripts/lib/daily-fresh-source-plan'));
let activeIdentity=current.identity,activeCandidateFile;
const runDir=path.join(Config.FILES.dailyFreshSourceRunsDir,sourceFixture.runId),attempts=path.join(runDir,'reader-attempts');
function put(file,bytes){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,bytes,{mode:0o600});}
put(path.join(runDir,'run.json'),decode(sourceFixture.runManifest));
for(const [name,record]of Object.entries(sourceFixture.sourceFiles))put(path.join(runDir,'sources','2610.34220','generation-000001',name),decode(record));
const candidateFile=path.join(attempts,repair.hashDraft(current.identity)+'.json');put(candidateFile,decode(real.candidate));
activeCandidateFile=candidateFile;
// Synthetic path relocation in isolated control records only. Real fixture
// bytes above stay checked; these relocated envelopes are not original paid
// records and never touch production. Preserve the real raw/model/fee bytes.
const originalParent=JSON.parse(decode(real.parent)),oldAttempts=path.dirname(path.dirname(originalParent.archivedFile));
function relocate(v){if(typeof v==='string')return v.replaceAll(oldAttempts,attempts);if(Array.isArray(v))return v.map(relocate);
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,item])=>[k,relocate(item)]));return v;}
const archives=new Map();
for(const audit of current.payload.readerRecoveryRevisions||[]){const archived=relocate(JSON.parse(decode(sourceFixture.candidate)));archived.payloadSha256=repair.hashDraft(archived.payload);
 const bytes=Buffer.from(JSON.stringify(archived));archives.set(audit.archivedName,{bytes,value:archived});put(path.join(attempts,audit.archivedName),bytes);}
function relocateEnvelope(v){v=relocate(v);for(const audit of v.payload.readerRecoveryRevisions||[]){const archived=archives.get(audit.archivedName);
 if(archived){audit.oldEnvelopeSha256=sha(archived.bytes);audit.oldPayloadSha256=repair.hashDraft(archived.value.payload);}}
 v.payloadSha256=repair.hashDraft(v.payload);return v;}
const relocatedParent=relocate(originalParent),parentBytes=Buffer.from(JSON.stringify(relocatedParent));
const relocatedCurrent=relocateEnvelope(current);put(candidateFile,Buffer.from(JSON.stringify(relocatedCurrent)));
guard.assertProof(relocatedCurrent);
const relocatedSidecar=relocate(JSON.parse(decode(real.sidecar)));
const snapshotCandidate=relocateEnvelope(JSON.parse(Buffer.from(relocatedSidecar.candidateSnapshot.rawBase64,'base64')));
const snapshotBytes=Buffer.from(JSON.stringify(snapshotCandidate));
relocatedSidecar.parentSnapshot={rawBase64:parentBytes.toString('base64'),sha256:sha(parentBytes)};
relocatedSidecar.candidateSnapshot={rawBase64:snapshotBytes.toString('base64'),sha256:sha(snapshotBytes)};
relocatedSidecar.grant.parentReceiptSha256=sha(parentBytes);relocatedSidecar.grant.candidateEnvelopeSha256=sha(snapshotBytes);
relocatedSidecar.grant.payloadSha256=repair.hashDraft(snapshotCandidate.payload);
const sidecarBytes=Buffer.from(JSON.stringify(relocatedSidecar));
put(path.join(attempts,'explicit-retry-rounds','d1befe86-db14-4c74-8615-9888cccc3654.json'),parentBytes);
put(path.join(attempts,'explicit-retry-rounds','d1befe86-db14-4c74-8615-9888cccc3654.transport-continuation.json'),sidecarBytes);
put(path.join(attempts,'explicit-retry-rounds','d1befe86-db14-4c74-8615-9888cccc3654.original.json'),decode(sourceFixture.originalArchive));
const originalFees=real.usage.map(record=>{const file=path.join(Config.FILES.llmUsageDir,path.basename(record.file));put(file,decode(record));return {file,sha256:record.sha256};});
for(const record of sourceFixture.usage)put(path.join(Config.FILES.llmUsageDir,record.basename),decode(record));
const plan=daily.readDailyFreshSourcePlan(sourceFixture.reference),paper=structuredClone(sourceFixture.paper);
const whole=paper.analysisCheckpoint||paper.analysis||'';
let origin,pending,finalPaper;
function inSource(callback){return daily.withDailyFreshAnalysisContext(plan,()=>daily.withDailyFreshPaperSource(plan,paper,details=>
 engine.withPaperAnalysisLock(paper,()=>callback(details))),{refreshReaderDiagnostics:true});}

test('capture exposes only fsync persisted original writer records and stays isolated for sync/async calls',async()=>{
 const plain={version:'llm-usage-v1',kind:'disposition',eventId:crypto.randomUUID(),at:new Date().toISOString()};
 const captured=usage.withPersistedLlmUsageRecords(()=>usage.writeLlmUsageEvent(plain,{directory:Config.FILES.llmUsageDir}));
 assert.equal(captured.result,true);assert.equal(captured.records.length,1);
 assert.equal(sha(fs.readFileSync(captured.records[0].file)),captured.records[0].sha256);
 const asyncCaptured=await usage.withPersistedLlmUsageRecords(async()=>{await Promise.resolve();return 7;});
 assert.equal(asyncCaptured.result,7);assert.deepEqual(asyncCaptured.records,[]);
 assert.throws(()=>usage.withPersistedLlmUsageRecords(()=>usage.writeLlmUsageEvent(plain,{directory:'/dev/null/no-such-directory'})));
});

test('original canonical receipt pointer is rejected before any budget dispatch; original bytes remain exact',()=>{
 if(beforeProtected.has(real.parent.file))assert.equal(sha(fs.readFileSync(real.parent.file)),beforeProtected.get(real.parent.file));
 assert.throws(()=>guard.assertProof(current.payload.explicitReaderRetryRound),/TEST_TMP_WRITE_GUARD/);
 assert.throws(()=>fs.writeFileSync(current.payload.explicitReaderRetryRound.receiptFile,'synthetic must never write'),/TEST_TMP_WRITE_GUARD/);
 if(beforeProtected.has(real.parent.file))assert.equal(sha(fs.readFileSync(real.parent.file)),beforeProtected.get(real.parent.file));
 guard.assertProof(relocatedCurrent.payload.explicitReaderRetryRound);
});

test('real four sources and source/paper lock bind a create-only origin; missing actual scope refuses',async()=>{
 assert.throws(()=>diagnostics.prepareReaderVersionMetadataOrigin({directory:attempts,paper,identity:current.identity,candidateFile,usageFiles:originalFees}));
});

test('real public implementation migration preserves original v4/counters/parent/sidecar before current-CAS origin creation',async()=>{
 await inSource(async details=>{
  // Reflect the private implementation bytes for fingerprints only. All
  // source/fee reads remain actual isolated files; no production code is edited.
  const oldRead=fs.readFileSync;const privateFiles=new Map(['scripts/lib/reader-repair.js','scripts/lib/reader-request-diagnostics.js','scripts/lib/llm-usage.js','scripts/deep-analyzer.js','scripts/analysis-engine.js']
   .concat(['scripts/lib/reader-transport-continuation.js']).map(file=>[path.join(ROOT,file),path.join(ROOT,file)]));
  fs.readFileSync=function(file,...args){return oldRead.call(fs,privateFiles.get(path.resolve(String(file)))||file,...args);};
  try{const evidence=deep.buildApiReaderEvidenceContext(whole,details.text,details.structuredArtifacts,paper.arxivId,null,paper.apiReaderResources,false);
   activeIdentity=(await deep.prepareApiReaderRetryIdentity(paper,whole,evidence,{sourceText:details.text,structuredArtifacts:details.structuredArtifacts})).identity;
  }finally{fs.readFileSync=oldRead;}
  const changes=[...new Set([...Object.keys(current.identity),...Object.keys(activeIdentity)])].filter(key=>JSON.stringify(current.identity[key])!==JSON.stringify(activeIdentity[key]));
  console.log('PRIVATE_MIGRATION_FIELDS',changes.join(','));
  assert.ok(changes.includes('parserImplementationSha256'));assert.ok(changes.includes('repairImplementationSha256'));
  assert.ok(changes.every(key=>require(path.join(ROOT,'scripts/lib/reader-recovery-revision')).ALLOWED_FIELDS.includes(key)));
  const revision=require(path.join(ROOT,'scripts/lib/reader-recovery-revision'));
  assert.throws(()=>revision.loadReaderRecoveryRevision(attempts,activeIdentity,{allowNewImplementationAllowance:false,ephemeralImageEvidenceSha256:repair.hashDraft(current.payload.ephemeralImageEvidence)}));
  const anchor=transportContinuation.prepareConsumedPaidAnchor({directory:attempts,identity:current.identity,paper,usageFiles:originalFees});
  assert.equal(anchor.newBudget,0);assert.equal(anchor.newRequests,0);
  const migrated=revision.loadReaderRecoveryRevision(attempts,activeIdentity,{allowNewImplementationAllowance:false,ephemeralImageEvidenceSha256:repair.hashDraft(current.payload.ephemeralImageEvidence)});
  assert.ok(migrated);assert.equal(migrated.rawDraft,raw);assert.equal(migrated.draft,null);
  for(const key of ['attempts','fullAttempts','transportFailures','noProgress','validationFailureStreak'])assert.equal(migrated[key],current.payload[key]);
  activeCandidateFile=path.join(attempts,repair.hashDraft(activeIdentity)+'.json');assert.ok(fs.existsSync(activeCandidateFile));
  assert.equal(sha(fs.readFileSync(path.join(attempts,'explicit-retry-rounds','d1befe86-db14-4c74-8615-9888cccc3654.json'))),sha(parentBytes));
  assert.equal(sha(fs.readFileSync(path.join(attempts,'explicit-retry-rounds','d1befe86-db14-4c74-8615-9888cccc3654.transport-continuation.json'))),sha(sidecarBytes));
  origin=diagnostics.prepareReaderVersionMetadataOrigin({directory:attempts,paper,identity:activeIdentity,candidateFile:activeCandidateFile,usageFiles:originalFees});
  assert.ok(fs.existsSync(origin.path));const re=diagnostics.prepareReaderVersionMetadataOrigin({directory:attempts,paper,identity:activeIdentity,candidateFile:activeCandidateFile,usageFiles:originalFees});
  assert.equal(re.sha256,origin.sha256);
 });
});

test('actual normal generator/begin/callModel/requestLlmJson mock transport/fees/apply/fullparse/finalizer/cold; synthetic ACK only',async()=>{
 await inSource(async details=>{
  const evidence=deep.buildApiReaderEvidenceContext(whole,details.text,details.structuredArtifacts,paper.arxivId,null,paper.apiReaderResources,false);
  const beforeParent=JSON.parse(fs.readFileSync(path.join(attempts,'explicit-retry-rounds/d1befe86-db14-4c74-8615-9888cccc3654.json')));
  const direct=require(path.join(ROOT,'scripts/lib/direct-rewrite-analysis-context')),previousDeferred=direct.directReaderCandidateCommitDeferred,
   previousMaterializer=direct.directReaderMaterializer;
  direct.directReaderCandidateCommitDeferred=()=>true;
  direct.directReaderMaterializer=()=>async()=>[];
  try{
   const invoke=()=>deep.generateApiReaderArticleDetailed(paper,whole,evidence,{sourceText:details.text,structuredArtifacts:details.structuredArtifacts,
    readerCallModel:(messages,maxTokens,options)=>deep._testNormalCallModel(messages,maxTokens,{...options,usageDirectory:Config.FILES.llmUsageDir}),
    readerRecordDisposition:input=>usage.recordLlmDisposition(input,{directory:Config.FILES.llmUsageDir})});
   if(isBadAck){
    await assert.rejects(invoke,{code:'READER_VERSION_METADATA_SINGLE_ACK_EXHAUSTED'});
    assert.equal(transportCalls,1);const failed=repair.loadFailedCandidate(attempts,activeIdentity);
    assert.equal(failed.attempts,2);assert.equal(failed.fullAttempts,1);assert.equal(failed.rawDraft,raw);assert.equal(failed.draft,null);
    assert.equal(failed.metadataRecoveryProof,undefined);
    const after=JSON.parse(fs.readFileSync(path.join(attempts,'explicit-retry-rounds/d1befe86-db14-4c74-8615-9888cccc3654.json')));
    assert.equal(after.physicalRequests,beforeParent.physicalRequests+1);assert.equal(after.reservedOutputTokens,beforeParent.reservedOutputTokens+16000);
    await assert.rejects(invoke,{code:'READER_VERSION_METADATA_SINGLE_ACK_EXHAUSTED'});assert.equal(transportCalls,1);
    return;
   }
   const generated=await invoke();pending=generated.metadataRecoveryProof;
   assert.ok(pending);assert.equal(transportCalls,withRetry?2:1);assert.equal(generated.attempts,2);assert.equal(generated.fullAttempts,1);
   // A successful logical response retains the old logical transport-failure
   // count; each physical transport is charged separately in the parent ledger.
   assert.equal(generated.transportFailures,1);
   const working=structuredClone(paper);
   finalPaper=await deep.finalizeApiReaderRefresh(working,details,generated,{readerResources:paper.apiReaderResources,preserveReaderUpstream:true,
    execution:{attempts:generated.attempts,fullAttempts:generated.fullAttempts,transportFailures:generated.transportFailures,
     model:activeIdentity.model.model,protocol:activeIdentity.model.protocol,repairMaxTokens:activeIdentity.repairMaxTokens,
     contentMode:generated.contentMode,executionKind:'synthetic-test-normal-finalizer'}});
   assert.equal(finalPaper.analysisManifest.stages.apiReaderArticle.status,'complete');
   assert.equal(diagnostics.validateReaderVersionMetadataCompletion(finalPaper),true);
   assert.equal(sha(finalPaper.apiReaderArticle),finalPaper.analysisManifest.stages.apiReaderArticle.articleSha256);
   const after=JSON.parse(fs.readFileSync(path.join(attempts,'explicit-retry-rounds/d1befe86-db14-4c74-8615-9888cccc3654.json')));
   assert.equal(after.physicalRequests,beforeParent.physicalRequests+transportCalls);
   assert.equal(after.reservedOutputTokens,beforeParent.reservedOutputTokens+16000*transportCalls);
   assert.equal(sha(fs.readFileSync(path.join(attempts,'explicit-retry-rounds/d1befe86-db14-4c74-8615-9888cccc3654.transport-continuation.json'))),sha(sidecarBytes));
  }finally{direct.directReaderCandidateCommitDeferred=previousDeferred;direct.directReaderMaterializer=previousMaterializer;}
 });
});

test('cold refuses proof/marker double stripping, wrong article/plan/stage/source and mutated paid records',{skip:isBadAck},async()=>{
 await inSource(()=>{
  const stripped=structuredClone(finalPaper);delete stripped.analysisManifest.contracts.readerVersionMetadataRecovery;
  delete stripped.analysisManifest.stages.apiReaderArticle.versionMetadataRecoveryContract;delete stripped.analysisManifest.stages.apiReaderArticle.versionMetadataRecoveryProof;
  assert.throws(()=>diagnostics.validateReaderVersionMetadataCompletion(stripped),/removed or changed/);
  stripped.apiReaderArticle+='\n';stripped.apiReaderArticleSha256=sha(stripped.apiReaderArticle);
  stripped.analysisManifest.stages.apiReaderArticle.articleSha256=stripped.apiReaderArticleSha256;
  assert.throws(()=>diagnostics.validateReaderVersionMetadataCompletion(stripped),/removed or changed/);
  for(const mutate of [p=>p.analysisManifest.stages.apiReaderArticle.attempts++,p=>p.apiReaderPlan.readerTitle+='bad',
   p=>p.analysisManifest.stages.apiReaderArticle.versionMetadataRecoveryProof.sha256='a'.repeat(64),p=>p.analysisManifest.contracts.readerVersionMetadataRecovery='other']){
   const changed=structuredClone(finalPaper);mutate(changed);assert.throws(()=>diagnostics.validateReaderVersionMetadataCompletion(changed));
  }
  const original=fs.readFileSync(pending.response.file);fs.writeFileSync(pending.response.file,Buffer.concat([original,Buffer.from(' ')]));
  assert.throws(()=>diagnostics.validateReaderVersionMetadataCompletion(finalPaper));fs.writeFileSync(pending.response.file,original);
 });
});


test('publication CLI outside all fresh/source ALS replays actual sealed source closures; synthetic metadata completion only',{skip:isBadAck},async()=>{
 assert.equal(require(path.join(ROOT,'scripts/lib/fresh-analysis-context')).getFreshAnalysisContext(),null);
 assert.equal(require(path.join(ROOT,'scripts/lib/direct-rewrite-analysis-context')).getDirectRewriteAnalysisContext(),null);
 const ordinary={exports:require(path.join(ROOT,'scripts/lib/reader-target-ordinal-patch'))};
 const runCli=require('./helpers/run-publication-cli-in-process.cjs').runPublicationCliInProcess;
 const sourceFile=path.join(ROOT,'scripts/lib/reader-resource-claims-replay-cli.js');
 const call=paper=>runCli({sourceFile,canonicalFilename:path.join(ROOT,'scripts/lib/reader-resource-claims-replay-cli.js'),
  temporaryDirectory:temp,input:{paper,sourceText:decode(sourceFixture.sourceFiles['source.txt']).toString('utf8')},
  moduleOverrides:{'./reader-target-ordinal-patch':ordinary.exports}});
 const positive=await call(finalPaper);assert.equal(positive.exitCode,0,positive.raw);assert.equal(positive.result.verified,true,positive.raw);
 console.log('ACTUAL_PUBLICATION_CLI_POSITIVE',JSON.stringify({sourceSha256:positive.sourceSha256,exitCode:positive.exitCode,actualCliSourceExecuted:positive.actualCliSourceExecuted,noChildProcess:positive.noChildProcess}));
 const stripped=structuredClone(finalPaper);delete stripped.analysisManifest.contracts.readerVersionMetadataRecovery;
 delete stripped.analysisManifest.stages.apiReaderArticle.versionMetadataRecoveryContract;
 delete stripped.analysisManifest.stages.apiReaderArticle.versionMetadataRecoveryProof;
 const denied=await call(stripped);assert.equal(denied.exitCode,1);assert.equal(denied.result.verified,false);assert.match(denied.result.message,/removed or changed/);
 stripped.apiReaderArticle+='\n';stripped.apiReaderArticleSha256=sha(stripped.apiReaderArticle);stripped.analysisManifest.stages.apiReaderArticle.articleSha256=sha(stripped.apiReaderArticle);
 const changed=await call(stripped);assert.equal(changed.exitCode,1);assert.equal(changed.result.verified,false);assert.match(changed.result.message,/removed or changed/);
 const noId=structuredClone(stripped);delete noId.arxivId;
 const noIdResult=await call(noId);assert.equal(noIdResult.exitCode,1);assert.equal(noIdResult.result.verified,false);assert.match(noIdResult.result.message,/canonical paper identity/);
 const wrongSource=structuredClone(finalPaper);wrongSource.sourceSha256='f'.repeat(64);
 const mismatch=await call(wrongSource);assert.equal(mismatch.exitCode,1);assert.equal(mismatch.result.verified,false);assert.match(mismatch.result.message,/authenticated source bytes/);
 const changedWhole=structuredClone(finalPaper);changedWhole.analysisCheckpoint+=' ';
 const mainMismatch=await call(changedWhole);assert.equal(mainMismatch.exitCode,1);assert.equal(mainMismatch.result.verified,false);
 const responseBytes=fs.readFileSync(pending.response.file);
 try{fs.writeFileSync(pending.response.file,Buffer.concat([responseBytes,Buffer.from(' ')]));
  const badPaid=await call(finalPaper);assert.equal(badPaid.exitCode,1);assert.equal(badPaid.result.verified,false);
 }finally{fs.writeFileSync(pending.response.file,responseBytes);}
 const runtimeFile=path.join(runDir,'sources/2610.34220/generation-000001/source-runtime.json'),runtimeBytes=fs.readFileSync(runtimeFile);
 try{fs.writeFileSync(runtimeFile,Buffer.concat([runtimeBytes,Buffer.from(' ')]));
  const badSealedSource=await call(finalPaper);assert.equal(badSealedSource.exitCode,1);assert.equal(badSealedSource.result.verified,false);
 }finally{fs.writeFileSync(runtimeFile,runtimeBytes);}
});

test('publication metadata wrapper preserves non-daily no-arxiv legacy input and refuses crossed metadata markers',()=>{
 const foreign={id:'conference:synthetic:foreign',freshRewriteProvenance:{contract:'fresh-source-analysis-v1',runId:'11111111-1111-4111-8111-111111111111'},analysisManifest:{stages:{}}};
 assert.equal(diagnostics.validateReaderVersionMetadataPublicationCompletion(foreign),true);
 const foreignRun=path.join(Config.FILES.dailyFreshSourceRunsDir,foreign.freshRewriteProvenance.runId);
 fs.mkdirSync(path.join(foreignRun,'reader-attempts'),{recursive:true,mode:0o700});
 fs.writeFileSync(path.join(foreignRun,'run.json'),JSON.stringify({contract:'synthetic-non-daily-run',runId:foreign.freshRewriteProvenance.runId}),{mode:0o600});
 assert.equal(diagnostics.validateReaderVersionMetadataPublicationCompletion(foreign),true);
 foreign.analysisManifest.contracts={readerVersionMetadataRecovery:'reader-paid-version-metadata-proof-v1'};
 assert.throws(()=>diagnostics.validateReaderVersionMetadataPublicationCompletion(foreign),/outside its actual daily run/);
});
