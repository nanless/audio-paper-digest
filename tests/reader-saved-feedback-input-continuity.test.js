'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const Config = require('../scripts/config'), daily = require('../scripts/lib/daily-fresh-source-plan');
const fresh = require('../scripts/lib/fresh-analysis-context'), engine = require('../scripts/analysis-engine');
const deep = require('../scripts/deep-analyzer'), repair = require('../scripts/lib/reader-repair');
const resources = require('../scripts/lib/reader-failed-bundle-resource-replay');
const continuity = require('../scripts/lib/reader-saved-feedback-input-continuity');
const facts = require('../scripts/lib/daily-fact-review');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
async function fixture(t, failureState = {}) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'resource-input-admission-'));
    const previous = { runs: Config.FILES.dailyFreshSourceRunsDir, usage: Config.FILES.llmUsageDir };
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs'); Config.FILES.llmUsageDir = path.join(root, 'usage');
    t.after(() => { Object.assign(Config.FILES, { dailyFreshSourceRunsDir: previous.runs, llmUsageDir: previous.usage }); fs.rmSync(root, { recursive: true, force: true }); });
    const paper = require('./valid-analysis-fixture').validAnalysisPaper('2610.90152v1');
    const quote = 'The benchmark uses https://example.com/baseline as a third-party baseline.';
    const text = quote + '\n' + 'Official methodology and same-protocol numerical evaluation evidence. '.repeat(180);
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-11', batchId: 'generic-resource-transition', papers: [paper] });
    await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: args => require('../scripts/lib/fresh-arxiv-rewrite-source').captureFreshArxivRewriteSource(args, {
        fetchText: async id => ({ text, source: 'html', sourceId: id, url: `https://arxiv.org/html/${id}`, fetchedAt: '2026-10-11T00:00:00.000Z', imageInfos: [], warnings: [] }),
        fetchPdf: async id => ({ bytes: Buffer.from(`%PDF-1.7\n${id}\n%%EOF\n`), url: `https://arxiv.org/pdf/${id}`, fetchedAt: '2026-10-11T00:00:01.000Z' })
    }) });
    const source = daily.readDailyFreshSource(plan, paper); paper.sourceSha256 = source.freshSourceDescriptor.sourceSha256;
    paper.analysisManifest.sourceAcquisition = { sourceSha256: paper.sourceSha256,
        structuredArtifactsSha256: source.freshSourceDescriptor.structuredArtifactsSha256,
        modelTextSanitizationContract: require('../scripts/lib/model-text-sanitization').MODEL_TEXT_SANITIZATION_CONTRACT,
        promptRenderingContract: require('../scripts/lib/prompt-rendering-contract').PROMPT_RENDERING_CONTRACT };
    daily.withDailyFreshAnalysisContext(plan, () => fresh.attachFreshSourceRecord(paper, paper.analysisManifest, source));
    const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: paper.sourceSha256, resources: [{
        type: 'third_party', origin: 'paper_source', sourceQuote: quote, sourceQuoteSha256: sha(quote),
        originalUrl: 'https://example.com/baseline', finalUrl: 'https://example.com/baseline', redirects: [],
        availability: 'available', status: 200, retryable: false }] };
    const oldResources = { ...body, identitySha256: daily.stableHash(body) };
    const changed = structuredClone(body); Object.assign(changed.resources[0], { availability: 'temporarily_unreachable', status: null, retryable: true, failureCode: 'PUBLIC_RESOURCE_DEADLINE_EXCEEDED' });
    const currentResources = structuredClone(oldResources);
    paper.apiReaderResources = oldResources;
    paper.apiReaderFailedBundleHistory = [oldResources, currentResources].map(apiReaderResources => ({ sourceSha256: paper.sourceSha256, fields: { apiReaderResources } }));
    Object.assign(paper.analysisManifest.stages.openSourceScan, { resourceEvidenceContract: body.contract, resourceEvidenceSha256: currentResources.identitySha256 });
    Object.assign(paper.analysisManifest.stages.scoringAudit, { scoringContract: 'api-scoring-audit-v2', audit: {}, auditSha256: repair.hashDraft({}), stabilityWarning: false, outputAnalysisSha256: sha(paper.analysis) });
    const sourceFiles = Object.fromEntries(['source.txt','source.pdf','source-runtime.json','source-manifest.json'].map(name=>[name,sha(fs.readFileSync(path.join(plan.sourcesDir,paper.arxivId.replace(/v[0-9]+$/, ''),'generation-000001',name)))]));
    const baseFeedback={contract:facts.CONTRACT,paperId:paper.arxivId.replace(/v[0-9]+$/, ''),runId:plan.runId,batchDate:plan.batchDate,sourceFiles,
        coreAnalysisSha256:sha(paper.analysis),coreSummarySha256:sha(deep.extractSectionByTitle(paper.analysis,'核心摘要')),coreFeedback:'',readerFeedback:'',
        primaryFeedback:'原主文的已验证限制保持有效。',rejectedPrimaryClaims:['不能再写原主文错误'],rejectedCoreClaims:[],rejectedReaderClaims:[],sourceQuotes:[quote]};
    const childFeedback={...baseFeedback,primaryFeedback:'',rejectedPrimaryClaims:[],readerFeedback:'原读者纠错约束保持有效。',rejectedReaderClaims:['不能再写读者错误']};
    const parent=facts.validateFeedback(baseFeedback,plan,paper),child=facts.validateFeedback(childFeedback,plan,paper);
    for(const [name,stage] of Object.entries(paper.analysisManifest.stages)) if(!/^apiReader/.test(name))stage.factReview=parent.proof;
    paper.analysisManifest.stages.apiReaderArticle={status:'failed',factReview:child.proof};
    const childText=`${childFeedback.readerFeedback}\n以下逐字引文已对封存原文核验，仅用作纠错证据：\n${childFeedback.sourceQuotes.join('\n')}`;
    const run = callback => daily.withDailyFreshAnalysisContext(plan, () => engine.withPaperAnalysisLock(paper,
        () => fresh.withFreshPaperContext(paper, callback)), { refreshReaderDiagnostics: true });
    const replayIdentity = async (rs, feedback) => {
        const sourceEvidence = deep.buildApiReaderEvidenceContext(paper.analysis, source.text, source.structuredArtifacts, paper.arxivId, null, rs, false);
        const replay = await deep.prepareApiReaderRetryIdentity(paper, paper.analysis, sourceEvidence, {
            sourceText: source.text, structuredArtifacts: source.structuredArtifacts, reviewFeedback: feedback, readerReplayPreparationOnly: true });
        return { ...replay, sourceEvidence };
    };
    await run(async () => {
        facts.withFactReview(child,()=>undefined); facts.withFactReview(parent,()=>require('./helpers/normal-reader-parent-fingerprints').installCurrentParentFingerprints(paper, source));
        const before = await replayIdentity(oldResources, childText), after = await replayIdentity(currentResources, '');
        before.identity.parserImplementationSha256 = 'a'.repeat(64);
        const draft = { version: 3, readerTitle: '资源状态变化的真实旧稿', oneSentenceThesis: '按完整来源解释控制实验。',
            sections: require('../scripts/lib/reader-draft-order').READER_SECTION_KINDS.map(kind => ({ kind, heading: kind, body: kind.repeat(130) })),
            conceptBridges: [], figurePlacements: [], tableBindings: [], formulaBindings: [] };
        const target = '/sections/0/body', patch = { version: 1, draftSha256: repair.hashDraft(draft), replacements: [{ path: target,
            oldSha256: repair.hashDraft(draft.sections[0].body), value: draft.sections[0].body + '真实已付费修补' }] };
        const fixed = repair.applyReaderPatch(structuredClone(draft), patch, [target]);
        const normalized = before.normalizeReplayDraft(fixed, [], []);
        const payload = { status: 'failed', draft: normalized.draft || normalized, rawDraft: JSON.stringify(normalized.draft || normalized),
            issues: [], attempts: 4, fullAttempts: 2, transportFailures: 1, noProgress: 2, failureSignature: 'old failure', validationFailureStreak: 2,
            validationFailureSignature: 'old validation', implementationRepairAllowanceProof: null,
            imageEvidence: [], ephemeralImageEvidence: { imageEvidence: [], directSupplementaryEvidence: [] } };
        Object.assign(payload, failureState);
        const directory = plan.readerAttemptsDir, candidateFile = repair.saveFailedCandidate(directory, before.identity, payload);
        const diagnosticId = crypto.randomUUID(), eventId = crypto.randomUUID();
        const prompt = `上一轮只读发布审查发现以下事实或图文对应问题，请逐项修正，不能只复述问题而不修改内容：${childText}\n本轮局部修复只返回提示要求的补丁 JSON\n与目标相关的论文证据：\n${before.sourceEvidence}\n\n没有明确的原子操作时，只输出下面的JSON结构，不输出完整文章：\nfixture patch schema`;
        const request = { contract: 'reader-repair-request-diagnostics-v1', id: diagnosticId, at: '2026-10-14T00:00:00.000Z',
            identity: before.identity, contentAttempt: 4, prompt, promptSha256: sha(prompt), draft, draftSha256: repair.hashDraft(draft),
            repairTargets: [{ path: target, oldSha256: repair.hashDraft(draft.sections[0].body), value: draft.sections[0].body }], images: [] };
        const requestFile = path.join(directory, 'request-diagnostics', diagnosticId + '.request.json');
        fs.mkdirSync(path.dirname(requestFile), { mode: 0o700 }); write(requestFile, request);
        const rawResponse = JSON.stringify(patch), responseFile = requestFile.replace('.request.json', '.response.json');
        write(responseFile, { contract: request.contract, id: diagnosticId, at: '2026-10-14T00:00:01.000Z', requestSha256: sha(fs.readFileSync(requestFile)), rawResponse, outputTextSha256: sha(rawResponse) });
        fs.mkdirSync(Config.FILES.llmUsageDir, { mode: 0o700 }); const usageFile = path.join(Config.FILES.llmUsageDir, crypto.randomUUID() + '.json');
        write(usageFile, { version: 'llm-usage-v1', kind: 'request', eventId, at: '2026-10-14T00:00:00.999Z', paperId: paper.arxivId,
            runId: plan.runId, stage: 'apiReaderRepair', contentAttempt: 4, outcome: 'completed', statusCode: 200,
            protocol: before.identity.model.protocol, model: before.identity.model.model, usage: { status: 'reported', totalTokens: 1200 }, outputTextSha256: sha(rawResponse) });
        Object.assign(paper, { admissionFixture: { directory, before, after, candidateFile, requestFile, responseFile, usageFile, payload } });
    });
    const f = paper.admissionFixture; delete paper.admissionFixture;
    const options = async () => ({ directory: f.directory, paper, source, resourceRecoveryHandle: resources.prepareRecoveryReaderResources(paper, source, {reviewFeedback:facts.reviewFeedback('apiReaderArticle',paper.arxivId).trim()}),
        reviewFeedback: facts.reviewFeedback('apiReaderArticle',paper.arxivId).trim(), replayIdentity, parentUpstreamProof: activeParentProof });
    let activeParentProof;
    const runSaved=callback=>run(()=>facts.withFactReview(parent,()=>{
        activeParentProof=require('../scripts/lib/reader-parent-upstream-preflight').inspectSavedReaderParentUpstream(paper,source);
        assert.equal(activeParentProof.current,true); return facts.withSavedReaderFactReview(child,paper,callback);
    }));
    return { ...f, paper, plan, source, run:runSaved, options, oldResources, currentResources, replayIdentity, parent, child, childText };
}

test('同原两反馈包的机械合并复用真实paid输入，保留所有计数费用和当前父约束',async t=>{
 const f=await fixture(t),before=fs.readFileSync(f.candidateFile),fee=fs.readFileSync(f.usageFile);
 await f.run(async()=>{const active=facts.current(f.paper.arxivId),opt=await f.options(),handle=await continuity.prepareSavedReaderInputContinuity(opt);
 assert.ok(handle);assert.equal(handle.modelFeedback,f.childText);assert.ok(handle.validationFeedback.includes('原主文'));assert.equal(facts.current(f.paper.arxivId),active);
 assert.equal(handle.identity.inputFingerprint,f.before.identity.inputFingerprint);assert.equal(handle.proof.retainedAttempts,4);assert.equal(handle.proof.retainedFullAttempts,2);assert.equal(handle.proof.retainedNoProgress,2);
 assert.equal(continuity.readSavedReaderInputContinuity(handle,f.paper,f.source,handle.identity).proof.contract,continuity.CONTRACT);
 assert.throws(()=>continuity.readSavedReaderInputContinuity(structuredClone(handle),f.paper,f.source),/opaque/);
 handle.modelFeedback+='changed';assert.throws(()=>continuity.readSavedReaderInputContinuity(handle,f.paper,f.source),/opaque/);
 });assert.deepEqual(fs.readFileSync(f.candidateFile),before);assert.deepEqual(fs.readFileSync(f.usageFile),fee);
});
test('伪造同次数稿、错fee/response和不匹配完整输入不得续用paid输入',async t=>{
 const f=await fixture(t),original=fs.readFileSync(f.candidateFile),fee=fs.readFileSync(f.usageFile),res=fs.readFileSync(f.responseFile);
 await f.run(async()=>{
 const forged=structuredClone(f.payload);forged.draft.sections[0].body+='forged';repair.saveFailedCandidate(f.directory,f.before.identity,forged);
 assert.equal(await continuity.prepareSavedReaderInputContinuity(await f.options()),null);fs.writeFileSync(f.candidateFile,original);
 const bad=JSON.parse(fee);bad.outputTextSha256='f'.repeat(64);write(f.usageFile,bad);assert.equal(await continuity.prepareSavedReaderInputContinuity(await f.options()),null);fs.writeFileSync(f.usageFile,fee);
 const wrong=JSON.parse(res);wrong.rawResponse+='tamper';write(f.responseFile,wrong);assert.equal(await continuity.prepareSavedReaderInputContinuity(await f.options()),null);fs.writeFileSync(f.responseFile,res);
 const opt=await f.options();opt.replayIdentity=async(rs,text)=>({...await f.replayIdentity(rs,text),sourceEvidence:'not real context'});
 assert.equal(await continuity.prepareSavedReaderInputContinuity(opt),null);
 });
});
test('来源、原反馈archive和实际当前作用域变化后opaque续跑证明失效',async t=>{
 const f=await fixture(t);await f.run(async()=>{const opt=await f.options(),h=await continuity.prepareSavedReaderInputContinuity(opt);assert.ok(h);
 assert.throws(()=>continuity.readSavedReaderInputContinuity(h,f.paper,{...f.source,text:f.source.text+'changed'}),/scope|来源|Source|source/);
 const file=path.join(daily.factFeedbackDirectory(f.plan),f.child.proof.feedbackSha256+'.json'),bytes=fs.readFileSync(file);fs.appendFileSync(file,' ');
 assert.throws(()=>continuity.readSavedReaderInputContinuity(h,f.paper,f.source),/SHA/);fs.writeFileSync(file,bytes);
 await assert.rejects(facts.withFactReview(f.child,()=>continuity.prepareSavedReaderInputContinuity(opt)),/dual-feedback/);
 });
});
test('真实同输入实现迁移不新增allowance，也不清原NP和费用次数',async t=>{
 const f=await fixture(t),old=fs.readFileSync(f.candidateFile),fee=fs.readFileSync(f.usageFile);
 await f.run(async()=>{const handle=await continuity.prepareSavedReaderInputContinuity(await f.options());assert.ok(handle);
 const checked=repair.readFailedCandidateEnvelope(f.directory,f.before.identity),one=[{name:path.basename(f.candidateFile),identity:checked.envelope.identity,payload:checked.envelope.payload,envelopeSha256:checked.envelopeSha256}];
 assert.equal(require('../scripts/lib/reader-compatible-candidate-replay').resolveCompatibleCandidates(f.directory,handle.identity,one,{
    normalizeReplayDraft:(await f.replayIdentity(handle.resources,handle.modelFeedback)).normalizeReplayDraft}),null,'default resolver still requires multiple candidates');
 const result=require('../scripts/lib/reader-recovery-revision').loadReaderRecoveryRevision(f.directory,handle.identity,{
    savedReaderInputContinuity:handle,paper:f.paper,normalizeReplayDraft:(await f.replayIdentity(handle.resources,handle.modelFeedback)).normalizeReplayDraft});
 assert.equal(result.attempts,4);assert.equal(result.fullAttempts,2);assert.equal(result.noProgress,2);assert.equal(result.validationFailureStreak,2);
 assert.equal(result.implementationRepairAllowanceProof,null);assert.equal(result.readerRecoveryRevisions.at(-1).clearedNoProgress,false);
 assert.deepEqual(fs.readFileSync(path.join(f.directory,result.readerRecoveryRevisions.at(-1).archivedName)),old);
 const repeated=await continuity.prepareSavedReaderInputContinuity(await f.options());assert.ok(repeated);
 assert.equal(repeated.proof.compatibleCandidateReplay.mode,'latest-real-paid-response');
 assert.equal(repeated.proof.compatibleCandidateReplay.archivedMigrationEdges.length,1);
 assert.equal(repeated.proof.retainedAttempts,4);assert.equal(repeated.proof.retainedNoProgress,2);
 const ancestor=path.join(f.directory,repeated.proof.compatibleCandidateReplay.archivedMigrationEdges[0].archivedName),ancestorBytes=fs.readFileSync(ancestor);
 fs.appendFileSync(ancestor,' ');assert.throws(()=>continuity.readSavedReaderInputContinuity(repeated,f.paper,f.source),/SHA/);fs.writeFileSync(ancestor,ancestorBytes);
 const exact=require('../scripts/lib/reader-recovery-revision').loadReaderRecoveryRevision(f.directory,repeated.identity,{
    savedReaderInputContinuity:repeated,paper:f.paper});assert.equal(exact.attempts,4);assert.equal(exact.fullAttempts,2);
 assert.equal(exact.noProgress,2);assert.equal(exact.validationFailureStreak,2);
 });assert.deepEqual(fs.readFileSync(f.usageFile),fee);
});
test('公共刷新沿原paidinput仅走repair，真实请求携带完整当前父子反馈',async t=>{
 const f=await fixture(t,{noProgress:0,validationFailureStreak:1}),old=fs.readFileSync(f.candidateFile),fee=fs.readFileSync(f.usageFile);
 const Module=require('node:module'),filename=require.resolve('../scripts/deep-analyzer'),compiled=new Module(filename,module);
 compiled.filename=filename;compiled.paths=Module._nodeModulePaths(path.dirname(filename));
 compiled._compile(fs.readFileSync(filename,'utf8')+'\nmodule.exports.__testSetContinuityModel=fn=>{callModel=fn;};\n',filename);
 let calls=0;
 compiled.exports.__testSetContinuityModel(async(messages,maxTokens,options)=>{
   const prompt=messages[0].content.find(item=>item.type==='text').text;
   calls++;assert.equal(options.usageContext.stage,'apiReaderRepair');assert.ok(prompt.includes('原主文的已验证限制保持有效'));assert.ok(prompt.includes('原读者纠错约束保持有效'));
   throw Object.assign(new Error('test account boundary; no network request'),{code:'LLM_ACCOUNT_AUTH_ERROR',category:'config',retryable:false,scope:'run',modelRequestClassified:true});
 });
 await f.run(async()=>{const options=await f.options();await assert.rejects(compiled.exports.refreshApiReaderArticleFromSource(f.paper,f.source,{
   resumeSavedSourceReader:true,reviewFeedback:options.reviewFeedback,parentUpstreamProof:options.parentUpstreamProof,recoveryReaderResources:options.resourceRecoveryHandle
 }),/test account boundary/);assert.equal(calls,1);
 const files=fs.readdirSync(f.directory).filter(n=>/^[a-f0-9]{64}\.json$/.test(n));assert.equal(files.length,1);
 const retained=JSON.parse(fs.readFileSync(path.join(f.directory,files[0]))).payload;assert.equal(retained.attempts,4);assert.equal(retained.fullAttempts,2);
 assert.equal(retained.readerRecoveryRevisions.at(-1).clearedNoProgress,false);assert.equal(retained.implementationRepairAllowanceProof,null);
 assert.deepEqual(fs.readFileSync(path.join(f.directory,retained.readerRecoveryRevisions.at(-1).archivedName)),old);
 });assert.deepEqual(fs.readFileSync(f.usageFile),fee);
});
test('同URL的资源状态事实冲突不能借机械反馈复用旧输入',async t=>{
 const f=await fixture(t);await f.run(async()=>{const options=await f.options(),body=structuredClone(f.paper.apiReaderResources);
 Object.assign(body.resources[0],{availability:'temporarily_unreachable',status:null,retryable:true,failureCode:'PUBLIC_RESOURCE_DEADLINE_EXCEEDED'});
 delete body.identitySha256;f.paper.apiReaderResources={...body,identitySha256:daily.stableHash(body)};
 await assert.rejects(continuity.prepareSavedReaderInputContinuity(options),/different resource facts/);
 });
});
