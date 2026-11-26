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
  fs.writeFileSync(manifestFile,JSON.stringify({...require('../scripts/lib/protocol-codec').recordHeader(operator.CONTRACT, operator.CONTRACT),runId:plan.runId,batchDate:plan.batchDate,
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

test('matchesPaidOrdinalEndpoint 支持多轮累积 draftOrderMappings 与零请求显式新轮原档回溯，并拒绝非零请求或篡改原档', async t => {
 const os = require('node:os');
 const Config = require('../scripts/config');
 const codec = require('../scripts/lib/protocol-codec');
 const daily = require('../scripts/lib/daily-fresh-source-plan');
 const fresh = require('../scripts/lib/fresh-analysis-context');
 const sourceApi = require('../scripts/lib/fresh-arxiv-rewrite-source');
 const engine = require('../scripts/analysis-engine');
 const deep = require('../scripts/deep-analyzer');
 const repair = require('../scripts/lib/reader-repair');
 const retry = require('../scripts/lib/explicit-reader-retry-round');
 const { READER_SECTION_KINDS } = require('../scripts/lib/reader-draft-order');

 const previousRoot = Config.FILES.dailyFreshSourceRunsDir;
 const fixtureRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'operator-ordinal-endpoint-'));
 fs.chmodSync(fixtureRoot, 0o700);
 Config.FILES.dailyFreshSourceRunsDir = path.join(fixtureRoot, 'runs');
 t.after(() => {
  Config.FILES.dailyFreshSourceRunsDir = previousRoot;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
 });

 const paper = {
  arxivId: '2611.99001v1',
  title: 'Operator ordinal endpoint fixture',
  analysisCheckpoint: '原主文正确且完整保留。',
  analysisManifest: { stages: { apiReaderArticle: { status: 'failed' } } },
  fullTextAvailable: true
 };
 const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-11-19', batchId: 'operator-ordinal-endpoint', papers: [paper] });
 const text = 'Official controlled source methods and experimental limitations. '.repeat(100);
 await daily.captureDailyFreshSources(plan, {
  concurrency: 1,
  capture: options => sourceApi.captureFreshArxivRewriteSource(options, {
   fetchText: async id => ({
    text,
    source: 'html',
    sourceId: id,
    url: `https://arxiv.org/html/${id}`,
    fetchedAt: '2026-11-19T00:00:00.000Z',
    imageInfos: [],
    warnings: []
   }),
   fetchPdf: async id => ({
    bytes: Buffer.from(`%PDF-1.7\n${id}\n%%EOF\n`),
    url: `https://arxiv.org/pdf/${id}`,
    fetchedAt: '2026-11-19T00:00:01.000Z'
   })
  })
 });
 const source = daily.readDailyFreshSource(plan, paper);
 paper.sourceSha256 = source.freshSourceDescriptor.sourceSha256;
 const resourceIdentity = {
  contract: 'api-reader-resource-identity-v1',
  sourceTextSha256: sha(source.text),
  resources: []
 };
 paper.apiReaderResources = {
  ...resourceIdentity,
  identitySha256: require('../scripts/lib/fresh-rewrite-run').stableHash(resourceIdentity)
 };
 daily.withDailyFreshAnalysisContext(plan, () => fresh.attachFreshSourceRecord(paper, paper.analysisManifest, source));
 const sourceIdentity = daily.withDailyFreshAnalysisContext(plan, () => fresh.freshAnalysisIdentity(paper.arxivId));

 const readerFormat = require('../scripts/lib/reader-record-format');
 const canonicalDraft = {
  ...codec.historicalHeader('reader-draft', readerFormat.INTEGRATED, readerFormat.OLD_DRAFT_FP),
  readerTitle: '多轮顺序映射与显式新轮端点核验测试',
  oneSentenceThesis: '验证多轮累积顺序映射及零请求显式新轮归档候选均可精确回放付费 ordinal 终点。',
  sections: READER_SECTION_KINDS.map((kind, i) => ({
   kind,
   heading: `小节 ${i + 1}`,
   body: i < 4 ? `这是第 ${i + 1} 节正文段落。\n\n[[CONCEPT_BRIDGE_${i + 1}]]` : `这是第 ${i + 1} 节正文段落。`
  })),
  conceptBridges: [0, 1, 2, 3].map(i => ({
   term: `核心概念${i + 1}`,
   sectionKind: READER_SECTION_KINDS[i],
   marker: `[[CONCEPT_BRIDGE_${i + 1}]]`,
   explanation: `核心概念 ${i + 1} 的初学者通俗解释。`
  })),
  figurePlacements: [],
  tableBindings: [],
  formulaBindings: []
 };
 assert.ok(repair.parseRepairableDraft(canonicalDraft), 'synthetic canonical draft must be a valid repairable draft');

 // Construct paid ordinal output `lastPaidAfter` with swapped sections 0 & 1 so
 // normalizeApiReaderRecoveryDraftForSource deterministically emits 1 changed reader-draft-order mapping M
 // for historical legacy-integrated drafts, while cohesive-functional-v4 preserves original section order.
 const lastPaidAfter = structuredClone(canonicalDraft);
 [lastPaidAfter.sections[0], lastPaidAfter.sections[1]] = [lastPaidAfter.sections[1], lastPaidAfter.sections[0]];
 const v4NoResortDraft = {
  ...structuredClone(lastPaidAfter),
  ...codec.recordHeader('reader-draft', 'reader-draft'),
  sections: lastPaidAfter.sections.slice(0, 6)
 };
 const v4NormState = {}, v4EmittedMappings = [];
 deep.normalizeApiReaderRecoveryDraftForSource(structuredClone(v4NoResortDraft), [], {
  paperId: paper.arxivId,
  sourceText: source.text,
  structuredArtifacts: source.structuredArtifacts,
  pixelFigureOrdinals: [],
  draftOrderMappings: v4EmittedMappings
 }, v4NormState);
 assert.equal(v4EmittedMappings.length, 0);
 assert.deepEqual(
  v4NormState.draft.sections.map(s => s.kind),
  v4NoResortDraft.sections.map(s => s.kind)
 );

 const normState = {}, emittedMappings = [];
 deep.normalizeApiReaderRecoveryDraftForSource(structuredClone(lastPaidAfter), [], {
  paperId: paper.arxivId,
  sourceText: source.text,
  structuredArtifacts: source.structuredArtifacts,
  pixelFigureOrdinals: [],
  draftOrderMappings: emittedMappings
 }, normState);
 assert.equal(emittedMappings.length, 1);
 assert.equal(emittedMappings[0].changed, true);
 assert.deepEqual(normState.draft, canonicalDraft);

 const olderMapping = {
  ...structuredClone(emittedMappings[0]),
  inputSha256: '1'.repeat(64),
  outputSha256: '2'.repeat(64)
 };
 const trailingMapping = emittedMappings[0];
 const identity = {
  paperId: paper.arxivId,
  maxAttempts: 6,
  freshAnalysis: sourceIdentity,
  sourceSha256: paper.sourceSha256,
  inputFingerprint: sha(source.text)
 };
 const ordinalCompilationStub = [{ requestId: 'req-ordinal-1', identity, pins: { sealSha256: '3'.repeat(64) } }];
 const basePayload = {
  status: 'failed',
  draft: structuredClone(canonicalDraft),
  rawDraft: JSON.stringify(canonicalDraft),
  draftOrderMappings: [olderMapping, trailingMapping],
  ordinalPatchCompilations: ordinalCompilationStub,
  issues: [{ path: '/sections/0/body', message: 'controlled fixture issue' }],
  imageEvidence: [],
  attempts: 6,
  fullAttempts: 2,
  noProgress: 3,
  failureSignature: 'sig-fixture',
  validationFailureSignature: 'val-sig-fixture',
  validationFailureStreak: 3,
  transportFailures: 0,
  implementationRepairAllowanceProof: null
 };

 const directory = plan.readerAttemptsDir;
 repair.saveFailedCandidate(directory, identity, basePayload);
 const candFile = path.join(directory, `${repair.hashDraft(identity)}.json`);
 const savedBeforeRound = JSON.parse(fs.readFileSync(candFile));
 assert.equal(savedBeforeRound.payload.draftOrderMappings.length, 2);

 const record = {
  baselineCandidateFile: candFile,
  baselineDraftSha256: repair.hashDraft(canonicalDraft)
 };

 // 1. Multi-mapping state (draftOrderMappings.length === 2) succeeds, and tampered header on older entry fails.
 assert.equal(
  operator.matchesPaidOrdinalEndpoint({ after: lastPaidAfter }, savedBeforeRound.payload, record, paper, source, identity),
  true
 );
 const badHeaderPayload = structuredClone(savedBeforeRound.payload);
 badHeaderPayload.draftOrderMappings[0].schemaFingerprint = '0'.repeat(64);
 assert.equal(
  operator.matchesPaidOrdinalEndpoint({ after: lastPaidAfter }, badHeaderPayload, record, paper, source, identity),
  false
 );

 // 2. Explicit round state (draftOrderMappings reset to [] with physicalRequests === 0, backed by .original.json).
 const sourceDirectory = path.join(plan.sourcesDir, '2611.99001', 'generation-000001');
 const sourceFiles = Object.fromEntries(
  ['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json'].map(name => [
   name,
   sha(fs.readFileSync(path.join(sourceDirectory, name)))
  ])
 );
 const grant = {
  ...codec.recordHeader(retry.CONTRACT, retry.CONTRACT),
  batchDate: plan.batchDate,
  runId: plan.runId,
  sourceFiles,
  originalIdentitySha256: repair.hashDraft(identity),
  paperId: '2611.99001',
  roundId: crypto.randomUUID(),
  identitySha256: repair.hashDraft(identity),
  envelopeSha256: sha(fs.readFileSync(candFile)),
  payloadSha256: repair.hashDraft(savedBeforeRound.payload),
  wholeSha256: sha(paper.analysisCheckpoint),
  maxResponses: 3,
  maxFullResponses: 1,
  maxPhysicalRequests: 6,
  maxReservedOutputTokens: 80000
 };
 const locked = callback =>
  daily.withDailyFreshAnalysisContext(plan, () =>
   daily.withDailyFreshPaperSource(plan, paper, () => engine.withPaperAnalysisLock(paper, callback))
  );

 let explicitPayload;
 await locked(() =>
  retry.withExplicitRound(paper, grant, () => {
   explicitPayload = retry.beginExplicitRound(directory, identity, savedBeforeRound.payload, paper);
  })
 );
 assert.equal(explicitPayload.draftOrderMappings ?? undefined, undefined);
 assert.equal(explicitPayload.attempts, 0);

 // Simulate deep-analyzer saving the post-round candidate preserving ordinalPatchCompilations and resetting draftOrderMappings to [] (exact 2611.24249v1 state), plus test undefined draftOrderMappings.
 const postRoundWithOrdinal = {
  ...explicitPayload,
  draftOrderMappings: [],
  ordinalPatchCompilations: savedBeforeRound.payload.ordinalPatchCompilations,
  transportFailures: 2,
  lastTransportError: '明确 Reader 新轮实际请求或输出预算耗尽'
 };
 repair.saveFailedCandidate(directory, identity, postRoundWithOrdinal);
 const persistedPostRound = JSON.parse(fs.readFileSync(candFile)).payload;
 assert.deepEqual(persistedPostRound.draftOrderMappings, []);
 assert.equal(persistedPostRound.ordinalPatchCompilations.length, 1);
 assert.equal(persistedPostRound.transportFailures, 2);

 // 2a. operator.execution(proof) inside withCorrections preserves fullAttempts and transportFailures onto stage.
 const patchedDraft = structuredClone(canonicalDraft);
 patchedDraft.sections[0].body += ' 已按原封存文本补充条件边界。';
 const editRecord = {
  ...codec.recordHeader('reader-human-source-edit', 'reader-human-source-edit'),
  notLlmResponse: true,
  runId: plan.runId,
  batchDate: plan.batchDate,
  paperId: '2611.99001',
  baselineCandidateFile: candFile,
  baselineCandidateEnvelopeSha256: sha(fs.readFileSync(candFile)),
  baselineDraftSha256: repair.hashDraft(canonicalDraft),
  sourceDescriptor: source.freshSourceDescriptor,
  patch: {
   version: 1,
   draftSha256: repair.hashDraft(canonicalDraft),
   replacements: [{
    path: '/sections/0/body',
    oldSha256: repair.hashDraft(canonicalDraft.sections[0].body),
    value: patchedDraft.sections[0].body
   }]
  },
  draft: patchedDraft
 };
 const editFile = path.join(plan.runDir, 'operator-edit-2611.99001.json');
 const batchManifestFile = path.join(plan.runDir, 'operator-manifest.json');
 fs.writeFileSync(editFile, JSON.stringify(editRecord), { mode: 0o600 });
 fs.writeFileSync(
  batchManifestFile,
  JSON.stringify({
   ...codec.recordHeader(operator.CONTRACT, operator.CONTRACT),
   runId: plan.runId,
   batchDate: plan.batchDate,
   authorization: 'Controlled unit test preserving transportFailures and fullAttempts.',
   correctionFiles: [editFile]
  }),
  { mode: 0o600 }
 );
 await operator.withCorrections(batchManifestFile, plan, [paper], () =>
  daily.withDailyFreshAnalysisContext(plan, () =>
   fresh.withFreshPaperContext(paper, () => {
    const active = operator.current(paper, identity, paper.analysisCheckpoint);
    const execFields = operator.execution(active.proof);
    assert.equal(execFields.executionKind, 'operator');
    assert.equal(execFields.fullAttempts, 0);
    assert.equal(execFields.transportFailures, 2);
   })
  )
 );

 const snapshots = [];
 assert.equal(
  operator.matchesPaidOrdinalEndpoint({ after: lastPaidAfter }, persistedPostRound, record, paper, source, identity, snapshots),
  true
 );
 assert.equal(snapshots.length, 2);
 assert.equal(
  operator.matchesPaidOrdinalEndpoint(
   { after: lastPaidAfter },
   { ...explicitPayload, ordinalPatchCompilations: savedBeforeRound.payload.ordinalPatchCompilations },
   record,
   paper,
   source,
   identity
  ),
  true
 );

 // 3a. Mismatched ordinalPatchCompilations between active payload and archived original fails.
 const mismatchedOrdinalPayload = structuredClone(persistedPostRound);
 mismatchedOrdinalPayload.ordinalPatchCompilations = [];
 assert.equal(
  operator.matchesPaidOrdinalEndpoint({ after: lastPaidAfter }, mismatchedOrdinalPayload, record, paper, source, identity),
  false
 );

 // 3b. Tampered archivedFile bytes fail envelopeSha256 verification.
 const receiptFile = persistedPostRound.explicitReaderRetryRound.receiptFile;
 const receiptObj = JSON.parse(fs.readFileSync(receiptFile));
 const origArchivedBytes = fs.readFileSync(receiptObj.archivedFile);
 fs.writeFileSync(receiptObj.archivedFile, Buffer.concat([origArchivedBytes, Buffer.from(' ')]), { mode: 0o600 });
 assert.equal(
  operator.matchesPaidOrdinalEndpoint({ after: lastPaidAfter }, persistedPostRound, record, paper, source, identity),
  false
 );
 fs.writeFileSync(receiptObj.archivedFile, origArchivedBytes, { mode: 0o600 });
 assert.equal(
  operator.matchesPaidOrdinalEndpoint({ after: lastPaidAfter }, persistedPostRound, record, paper, source, identity),
  true
 );

 // 3c. Non-empty receipt.requests (physicalRequests > 0) is rejected.
 await locked(() =>
  retry.withPhysicalBudget(persistedPostRound.explicitReaderRetryRound, paper, () => {
   retry.consumePhysicalRequest(
    { max_output_tokens: 1024 },
    { usageContext: { paperId: paper.arxivId, stage: 'apiReaderRepair' } }
   );
  })
 );
 const receiptAfterReq = JSON.parse(fs.readFileSync(receiptFile));
 assert.equal(receiptAfterReq.requests.length, 1);
 assert.equal(
  operator.matchesPaidOrdinalEndpoint({ after: lastPaidAfter }, persistedPostRound, record, paper, source, identity),
  false
 );
});

test('replayPaidFingerprint 同时支持历史 OLD_DRAFT_FP 与当前 NEW_DRAFT_FP 的已付指纹修正重放，并拒绝跨指纹伪造', t => {
 const codec = require('../scripts/lib/protocol-codec');
 const readerFormat = require('../scripts/lib/reader-record-format');
 const candidateFormat = require('../scripts/lib/reader-candidate-format');
 const repair = require('../scripts/lib/reader-repair');
 const diagnostics = require('../scripts/lib/reader-request-diagnostics');
 t.mock.method(diagnostics, 'validatePaidDraftFingerprintFees', () => true);

 const makeCase = ({ targetDraftHeader, targetPlanHeader, sectionCount }) => {
  const correctedObj = {
   ...targetDraftHeader,
   readerTitle: '已付全稿指纹单字符脱落冷重放验证',
   oneSentenceThesis: '验证新旧两代 reader-draft 结构指纹均可在严格近邻与费用绑定下精确重放。',
   sections: Array.from({ length: sectionCount }, (_, i) => ({
    kind: i === 0 ? 'problem' : i === 1 ? 'method_overview' : i === sectionCount - 1 ? 'limitation' : 'result',
    heading: `功能定位：第 ${i + 1} 节核心机制判断`,
    body: `这是第 ${i + 1} 节完整正文段落，包含充足长度以通过可修复草稿结构核验。`
   })),
   conceptBridges: targetDraftHeader.schemaFingerprint === readerFormat.OLD_DRAFT_FP
    ? [0, 1, 2, 3].map(i => ({
       terms: [`术语A${i}`, `术语B${i}`],
       sectionKind: 'method_overview',
       marker: `[[CONCEPT_BRIDGE_${i + 1}]]`,
       explanation: `术语A${i}与术语B${i}在历史契约下的组合说明。`
      }))
    : [],
   figurePlacements: [],
   tableBindings: [],
   formulaBindings: []
  };
  const correctedRaw = JSON.stringify(correctedObj);
  // Drop 1 middle hex char of schemaFingerprint (keeping first/last 16 chars intact) within Levenshtein <= 8
  const typoFp = targetDraftHeader.schemaFingerprint.slice(0, 32) + targetDraftHeader.schemaFingerprint.slice(33);
  const rawDraft = correctedRaw.replace(
   JSON.stringify(targetDraftHeader.schemaFingerprint),
   JSON.stringify(typoFp)
  );
  const baseId = candidateFormat.identityFields();
  const identity = {
   paperId: '2611.99002',
   readerIdentity: { ...baseId.readerIdentity, article: targetPlanHeader }
  };
  const candidate = {
   identity,
   payload: {
    status: 'failed',
    draft: null,
    rawDraft,
    attempts: 1,
    fullAttempts: 1,
    issues: [{ path: null, message: '读者文章格式头未登记或字段混用' }]
   }
  };
  const record = {
   ...codec.recordHeader('reader-human-paid-draft-fingerprint-edit', 'reader-human-paid-draft-fingerprint-edit'),
   notLlmResponse: true,
   paperId: '2611.99002',
   runId: '11111111-2222-4333-8444-555555555555',
   batchDate: '2026-11-19',
   baselineCandidateFile: `/tmp/${repair.hashDraft(identity)}.json`,
   baselineCandidateEnvelopeSha256: 'a'.repeat(64),
   baselineDraftSha256: repair.hashDraft(null),
   sourceDescriptor: { contract: 'fresh-source-cache-v1' },
   rawDraftSha256: sha(rawDraft),
   correctedRawSha256: sha(correctedRaw),
   wholeSha256: 'b'.repeat(64),
   currentInputIdentity: identity,
   feeFiles: [
    { file: '/tmp/fee1.json', sha256: '1'.repeat(64) },
    { file: '/tmp/fee2.json', sha256: '2'.repeat(64) },
    { file: '/tmp/fee3.json', sha256: '3'.repeat(64) }
   ]
  };
  return { correctedObj, candidate, record };
 };

 // 1. 历史 OLD_DRAFT_FP / OLD_PLAN_FP 重放通过
 const oldCase = makeCase({
  targetDraftHeader: codec.historicalHeader('reader-draft', readerFormat.INTEGRATED, readerFormat.OLD_DRAFT_FP),
  targetPlanHeader: codec.historicalHeader('beginner-researcher', readerFormat.INTEGRATED, readerFormat.OLD_PLAN_FP),
  sectionCount: 10
 });
 assert.deepEqual(operator.replay(oldCase.record, oldCase.candidate), oldCase.correctedObj);

 // 2. 当前 NEW_DRAFT_FP / NEW_PLAN_FP 重放通过
 const newCase = makeCase({
  targetDraftHeader: codec.recordHeader('reader-draft', 'reader-draft'),
  targetPlanHeader: codec.recordHeader('beginner-researcher', 'beginner-researcher'),
  sectionCount: 6
 });
 assert.deepEqual(operator.replay(newCase.record, newCase.candidate), newCase.correctedObj);

 // 3. 若候选身份声明为 NEW_PLAN_FP，不能借用 OLD_DRAFT_FP 的近邻记录跨代重放
 const crossCandidate = structuredClone(oldCase.candidate);
 crossCandidate.identity.readerIdentity.article = codec.recordHeader('beginner-researcher', 'beginner-researcher');
 const crossRecord = {
  ...oldCase.record,
  baselineCandidateFile: `/tmp/${repair.hashDraft(crossCandidate.identity)}.json`
 };
 assert.throws(() => operator.replay(crossRecord, crossCandidate), /not a bounded malformed current header/);

 // 4. 末位缺字（前 32 位精确锚定、编辑距离 1）与首位缺字（后 32 位精确锚定、编辑距离 1）均可通过重放；未锚定远邻仍拒绝
 const targetDraftHeader = codec.recordHeader('reader-draft', 'reader-draft');
 const targetPlanHeader = codec.recordHeader('beginner-researcher', 'beginner-researcher');
 const makeVariant = mutatedFp => {
  const base = makeCase({ targetDraftHeader, targetPlanHeader, sectionCount: 6 });
  const correctedRaw = JSON.stringify(base.correctedObj);
  const rawDraft = correctedRaw.replace(
   JSON.stringify(targetDraftHeader.schemaFingerprint),
   JSON.stringify(mutatedFp)
  );
  base.candidate.payload.rawDraft = rawDraft;
  base.record.rawDraftSha256 = sha(rawDraft);
  return base;
 };
 const trailingDrop = makeVariant(targetDraftHeader.schemaFingerprint.slice(0, -1));
 assert.deepEqual(operator.replay(trailingDrop.record, trailingDrop.candidate), trailingDrop.correctedObj);
 const leadingDrop = makeVariant(targetDraftHeader.schemaFingerprint.slice(1));
 assert.deepEqual(operator.replay(leadingDrop.record, leadingDrop.candidate), leadingDrop.correctedObj);
 const unanchored = makeVariant('f'.repeat(63));
 assert.throws(() => operator.replay(unanchored.record, unanchored.candidate), /not a bounded malformed current header/);

 // 5. 带 explicitReaderRetryRound 的已付指纹候选：回执核验通过时允许重放，核验失败时拒绝
 const retryMod = require('../scripts/lib/explicit-reader-retry-round');
 const withRetry = makeVariant(targetDraftHeader.schemaFingerprint.slice(0, -1));
 withRetry.candidate.payload.explicitReaderRetryRound = { roundId: '11111111-2222-4333-8444-555555555555' };
 const validateMock = t.mock.method(retryMod, 'validatePersistedRound', () => true);
 assert.deepEqual(operator.replay(withRetry.record, withRetry.candidate), withRetry.correctedObj);
 assert.equal(validateMock.mock.callCount(), 1);
 validateMock.mock.mockImplementation(() => { throw new Error('round receipt corrupted'); });
 assert.throws(() => operator.replay(withRetry.record, withRetry.candidate), /round receipt corrupted/);
 validateMock.mock.restore();

 // 6. 末位缺字且混入旧整合版整数 version:3 时可严格剥离 version:3 并恢复；version:2/4/"3" 必须拒绝
 const makeMixedVersion = versionValue => {
  const base = makeCase({ targetDraftHeader, targetPlanHeader, sectionCount: 6 });
  const correctedObj = structuredClone(base.correctedObj);
  const mixedObj = {
   contract: targetDraftHeader.contract,
   schemaFingerprint: targetDraftHeader.schemaFingerprint.slice(0, -1),
   version: versionValue,
   ...Object.fromEntries(Object.entries(correctedObj).filter(([k]) => !['contract', 'schemaFingerprint'].includes(k)))
  };
  const rawDraft = JSON.stringify(mixedObj);
  const expectedRaw = JSON.stringify(correctedObj);
  base.candidate.payload.rawDraft = rawDraft;
  base.record.rawDraftSha256 = sha(rawDraft);
  base.record.correctedRawSha256 = sha(expectedRaw);
  return { ...base, correctedObj };
 };
 const mixedV3 = makeMixedVersion(3);
 assert.deepEqual(operator.replay(mixedV3.record, mixedV3.candidate), mixedV3.correctedObj);
 for (const badVersion of [2, 4, '3', null]) {
  const bad = makeMixedVersion(badVersion);
  assert.throws(() => operator.replay(bad.record, bad.candidate), /not a bounded malformed current header/);
 }

 // 7. 已付指纹修正可串联 1-8 个获准节点补丁（含 /implementationSpecs）；半对字段、未授权路径或无变更补丁均拒绝
 const withPatchBase = makeVariant(targetDraftHeader.schemaFingerprint.slice(0, -1));
 const specsBefore = {
  trainingData: 'orig data', computeHardware: 'orig hw', keyHyperparams: 'orig hp',
  inferenceCost: 'orig cost', openSourceArtifacts: '本次核验404', appendixHighlights: 'orig app'
 };
 withPatchBase.correctedObj.implementationSpecs = specsBefore;
 const correctedWithSpecsRaw = JSON.stringify(withPatchBase.correctedObj);
 const rawWithSpecs = correctedWithSpecsRaw.replace(
  JSON.stringify(targetDraftHeader.schemaFingerprint),
  JSON.stringify(targetDraftHeader.schemaFingerprint.slice(0, -1))
 );
 withPatchBase.candidate.payload.rawDraft = rawWithSpecs;
 withPatchBase.record.rawDraftSha256 = sha(rawWithSpecs);
 withPatchBase.record.correctedRawSha256 = sha(correctedWithSpecsRaw);
 const specsAfter = { ...specsBefore, openSourceArtifacts: '论文给出仓库链接，当前无法访问' };
 const patchObj = {
  ...codec.recordHeader('reader-node-patch', 'reader-node-patch'),
  draftSha256: repair.hashDraft(withPatchBase.correctedObj),
  replacements: [{ path: '/implementationSpecs', oldSha256: repair.hashDraft(specsBefore), value: specsAfter }]
 };
 const patchedDraft = repair.applyReaderPatch(structuredClone(withPatchBase.correctedObj), patchObj, ['/implementationSpecs']);
 withPatchBase.record.patch = patchObj;
 withPatchBase.record.draft = patchedDraft;
 assert.deepEqual(operator.replay(withPatchBase.record, withPatchBase.candidate), patchedDraft);

 const halfPair = structuredClone(withPatchBase.record);
 delete halfPair.draft;
 assert.throws(() => operator.replay(halfPair, withPatchBase.candidate), /original or scope differs/);

 const badPath = structuredClone(withPatchBase.record);
 badPath.patch.replacements[0].path = '/contract';
 assert.throws(() => operator.replay(badPath, withPatchBase.candidate), /unauthorized node/);
});
test('已付指纹修正上下文允许定向Reader事实反馈接替旧ordinal历史，但普通阶段仍拒绝保留ordinal历史',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../scripts/lib/daily-reader-operator-correction.js'),'utf8');
 assert(source.includes('const hasDisallowedOrdinalHistory = !(readerFactRevision && !(candidate.payload?.ordinalPatchCompilations?.length))'));
});
test('人工修正冷核重放先做与在线一致的确定性归一化再完整解析，避免需合并超额小节的稿被误拒',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../scripts/lib/daily-reader-operator-correction.js'),'utf8');
 const start=source.indexOf('function validateSavedCompletionUnchecked');
 const body=source.slice(start);
 const normalizeAt=body.indexOf('normalizeApiReaderRecoveryDraftForSource(structuredClone(draft), payload.issues || []');
 const parseAt=body.indexOf('deep.parseApiReaderArticleResult(JSON.stringify(normalizationState.draft || draft)');
 assert(normalizeAt>0,'cold replay must normalize the bounded patch endpoint with the retained original issues');
 assert(parseAt>normalizeAt,'the full parse must consume the normalized draft, not the raw patch endpoint');
 assert(body.includes("pixelFigureOrdinals: readyFigureOrdinals"),'normalization must use the paid ready figure ordinals');
});
test('零序号补丁人工修正接替已重做普通完成时经 verifiedSupersededCompletionPointer 继承旧证明指针',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../scripts/deep-analyzer.js'),'utf8');
 const start=source.indexOf('async function finalizeApiReaderRefresh(');
 const slice=source.slice(start,start+1400);
 assert(slice.includes("|| previousSupersededOrdinalProof\n            || require('./lib/reader-target-ordinal-patch').verifiedSupersededCompletionPointer(paper)"),
  'finalizeApiReaderRefresh must verify superseded completion pointer for zero-record operator completions');
 const ordinal=require('../scripts/lib/reader-target-ordinal-patch');
 // Negative: tampered readerRevisionHistory context is still rejected fail-closed.
 assert.throws(()=>ordinal.verifiedSupersededCompletionPointer({
  readerRevisionHistory:{contract:'daily-reader-revision-history-v1',reason:'stage-invalidated',
   completionProof:{path:'/tmp/fake.json',sha256:'not-a-sha'}},
  analysisManifest:{contracts:{},stages:{apiReaderArticle:{status:'complete'}}}
 }),/invalid superseded revision pointer context/);
 // Positive baseline: absent revision pointer cleanly returns null.
 assert.equal(ordinal.verifiedSupersededCompletionPointer({analysisManifest:{contracts:{},stages:{}}}),null);
});
