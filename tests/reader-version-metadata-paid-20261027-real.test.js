'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const os=require('node:os'),zlib=require('node:zlib'),crypto=require('node:crypto'),Module=require('node:module');
const ROOT=path.resolve(__dirname,'..'),sha=x=>crypto.createHash('sha256').update(x).digest('hex');
// This paid compatibility case keeps its actual v9 prompt. Read only its
// pinned Git blob before installing the no-child-process/write guard.
const originalArticlePath='prompts/api-reader-article-v9.md';
const originalArticleSha='a2630453bfbd506619b7b3e80ece91ffc9f53951b80bab043cc6d889731d7ff8';
const originalArticleOid='2dc5d6d8348a960bd272415fb861aa48e88b7609';
const originalArticleBytes=require('node:child_process').execFileSync('git',
 ['--no-lazy-fetch','--no-replace-objects','-C',ROOT,'cat-file','blob',originalArticleOid],
 {env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0'},
 timeout:10000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']});
assert.equal(sha(originalArticleBytes),originalArticleSha);
const originalRepairPath='prompts/api-reader-repair-v13.md';
const originalRepairSha='e8bfdff8a12a27d3960cfe11187d87c4e3a4df2f3518bcb8bbd93c0cd86a6ab4';
const originalRepairOid='1e81231bf1fb053d4b4953c966156ccd7efbb694';
const originalRepairBytes=require('node:child_process').execFileSync('git',
 ['--no-lazy-fetch','--no-replace-objects','-C',ROOT,'cat-file','blob',originalRepairOid],
 {env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0'},
 timeout:10000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']});
assert.equal(sha(originalRepairBytes),originalRepairSha);
const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'version-metadata-cold-private-'));
// Install before the first project import or compiled private source.
const guard=require('./helpers/isolated-tmp-write-guard.cjs').installTmpOnlyWriteGuard(temp,{readOnlyPythonScripts:[
 'reader_sealed_pdf_quote_evidence.py','reader_pdf_quote_projection.py','reader_sealed_pdf_column_units.py','reader_pdf_column_unit_projection.py','reader_authenticated_pdf_hierarchical_table.py',
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
const originalArticleIndex=JSON.parse(fs.readFileSync(path.join(ROOT,'scripts/lib/git-prompt-evidence-index.json')));
assert.equal(originalArticleIndex.retiredPaths[originalArticlePath],originalArticleSha);
assert.equal(originalArticleIndex.blobs[originalArticleSha].blobOid,originalArticleOid);
historicalPrompts.set(originalArticlePath,{bytes:originalArticleBytes,sha256:originalArticleSha});
assert.equal(originalArticleIndex.retiredPaths[originalRepairPath],originalRepairSha);
assert.equal(originalArticleIndex.blobs[originalRepairSha].blobOid,originalRepairOid);
historicalPrompts.set(originalRepairPath,{bytes:originalRepairBytes,sha256:originalRepairSha});
const promptEvidence=require(path.join(ROOT,'scripts/lib/prompt-evidence')),normalPromptRead=promptEvidence.readPromptEvidenceBytes;
promptEvidence.readPromptEvidenceBytes=function(relative,options={}){const original=historicalPrompts.get(relative);if(!original)return normalPromptRead(relative,options);
 if(options.expectedSha256!==undefined&&options.expectedSha256!==null)assert.equal(options.expectedSha256,original.sha256);return Buffer.from(original.bytes);};
const versions=require(path.join(ROOT,'scripts/lib/prompt-contracts'));
const currentArticlePath=versions.currentTextStagePromptPath('apiReaderArticle');
const normalPromptPath=versions.currentTextStagePromptPath,normalPromptContract=versions.currentPromptTextContract;
assert.equal(require(path.join(ROOT,'scripts/lib/prompt-history')).promptTemplateSha256(originalArticleBytes.toString()),current.identity.promptSha256);
assert.equal(require(path.join(ROOT,'scripts/lib/prompt-history')).promptTemplateSha256(originalRepairBytes.toString()),current.identity.repairPromptSha256);
let historicalArticleContext=true;
// Test-process-only historical writing context, not a production migration
// allowance. The real current registry remains covered by the refusal below.
test.mock.method(versions,'currentTextStagePromptPath',stage=>historicalArticleContext&&stage==='apiReaderArticle'?originalArticlePath:
 historicalArticleContext&&stage==='apiReaderRepair'?originalRepairPath:normalPromptPath(stage));
test.mock.method(versions,'currentPromptTextContract',stage=>historicalArticleContext&&stage==='apiReaderArticle'?'analysis-prompt-text-v9':
 historicalArticleContext&&stage==='apiReaderRepair'?'analysis-prompt-text-v13':normalPromptContract(stage));
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
