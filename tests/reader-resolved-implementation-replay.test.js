const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Config = require('../scripts/config.js');
const { withFreshAnalysisContext } = require('../scripts/lib/fresh-analysis-context.js');
const { loadReaderRecoveryRevision } = require('../scripts/lib/reader-recovery-revision.js');
const { saveFailedCandidate, loadFailedCandidate, hashDraft,
    TABLE_COUNT_ISSUE_CODE, collectDraftIssues } = require('../scripts/lib/reader-repair.js');
const { READER_SECTION_KINDS, normalizeReaderDraftOrder } = require('../scripts/lib/reader-draft-order.js');
const directContext = require('../scripts/lib/direct-rewrite-analysis-context.js');
const conferenceContext = require('../scripts/lib/conference-analysis-context.js');

function createSample(t, requestedPaperId = '2609.99971') {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-revision-'));
    const previous = Config.FILES.freshRewriteRunsDir; Config.FILES.freshRewriteRunsDir = root;
    t.after(() => { Config.FILES.freshRewriteRunsDir = previous; fs.rmSync(root, { recursive: true, force: true }); });
    const runId = crypto.randomUUID(), runDir = path.join(root, runId), paperId = requestedPaperId;
    fs.mkdirSync(runDir, { mode: 0o700 });
    const sourceExpectations = { [paperId]: { sourceSha256: 'a'.repeat(64), structuredArtifactsSha256: 'b'.repeat(64) } };
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ version: 1, contract: 'fresh-rewrite-run-v1',
        runId, paperIds: [paperId], sourceExpectations }), { mode: 0o600 });
    const context = { runId, runDir, sourceExpectations, refreshReaderDiagnostics: true };
    const directory = path.join(runDir, 'reader-attempts');
    const oldIdentity = { paperId, freshAnalysis: { runId, paperId, ...sourceExpectations[paperId] },
        sourceSha256: 'a'.repeat(64), inputFingerprint: 'same input', model: { model: 'muse-spark-1.3-contributor', maxTokens: 48000 },
        promptSha256: 'p', repairPromptSha256: 'q', maxAttempts: 6, repairMaxTokens: 8000,
        repairImplementationSha256: 'c'.repeat(64) };
    const identity = { ...oldIdentity, repairImplementationSha256: 'd'.repeat(64),
        draftOrderContract: 'reader-draft-order-v1', draftOrderImplementationSha256: 'e'.repeat(64),
        sourceDiagnosticsImplementationSha256: 'f'.repeat(64),
        parserImplementationSha256: '1'.repeat(64), editorialImplementationSha256: '2'.repeat(64),
        mechanicalContractSha256: '3'.repeat(64) };
    const draft = { version: 3, readerTitle: '只读恢复测试正文', oneSentenceThesis: '保持所有来源和调用预算不变。',
        sections: READER_SECTION_KINDS.map(kind => ({ kind, heading: kind, body: kind.repeat(130) })),
        conceptBridges: Array.from({ length: 4 }, () => ({})), figurePlacements: [], tableBindings: [], formulaBindings: [] };
    [draft.sections[6], draft.sections[7]] = [draft.sections[7], draft.sections[6]];
    const payload = { status: 'failed', draft, rawDraft: JSON.stringify(draft),
        issues: [{ path: null, message: 'old diagnostic' }], attempts: 4, fullAttempts: 1,
        transportFailures: 2, noProgress: 2, failureSignature: 'old failure',
        validationFailureStreak: 2, validationFailureSignature: 'old normalized failure', imageEvidence: [] };
    return { root, context, directory, oldIdentity, identity, payload,
        enabled: fn => withFreshAnalysisContext(context, fn) };
}


function createResolvedSample(t, withAllowance = false) {
    const sample=createSample(t);
    sample.oldIdentity={...sample.identity,parserImplementationSha256:'9'.repeat(64),model:{...sample.identity.model,protocol:'openai_responses'}};
    sample.identity={...sample.oldIdentity,parserImplementationSha256:'1'.repeat(64)};
    sample.payload.ephemeralImageEvidence={imageEvidence:[],directSupplementaryEvidence:[]};
    if (withAllowance) {
        const beforeIdentity={...sample.oldIdentity,parserImplementationSha256:'8'.repeat(64)};
        saveFailedCandidate(sample.directory,beforeIdentity,sample.payload);
        sample.payload=sample.enabled(()=>loadReaderRecoveryRevision(sample.directory,sample.oldIdentity));
        assert.ok(sample.payload.implementationRepairAllowanceProof);
    } else saveFailedCandidate(sample.directory,sample.oldIdentity,sample.payload);
    const filename=require('../scripts/lib/reader-repair').retireFailedCandidate(sample.directory,sample.oldIdentity);
    const bytes=fs.readFileSync(filename);
    sample.resolvedFile=filename;
    sample.original=bytes;
    const article='原读者正文。',plan={version:3,sections:[]};
    const articleSha=crypto.createHash('sha256').update(article).digest('hex'),planSha=require('../scripts/lib/fresh-rewrite-run').stableHash(plan);
    sample.options={resolvedReaderCandidate:{basename:path.basename(filename),
        envelopeSha256:crypto.createHash('sha256').update(bytes).digest('hex'),
        readerArticleSha256:articleSha,readerPlanSha256:planSha},
        paper:{arxivId:sample.identity.paperId,sourceSha256:sample.identity.sourceSha256,latestAnalysisAttemptError:'original final quality failure',apiReaderArticle:article,apiReaderPlan:plan,apiReaderArticleSha256:articleSha,
            apiReaderPlanSha256:planSha,analysisManifest:{stages:{apiReaderArticle:{qualityMetrics:{blockingIssueCount:1},sourceBindingsSourceTextSha256:sample.identity.sourceSha256,model:sample.identity.model.model,protocol:sample.identity.model.protocol,promptTemplateSha256:sample.identity.promptSha256,repairPromptTemplateSha256:sample.identity.repairPromptSha256,imageEvidenceSha256:hashDraft([]),modelImagePreflightEvidenceSha256:hashDraft(sample.payload.ephemeralImageEvidence)}}}},
        pixelEvidenceSha256:hashDraft([])};
    return sample;
}

test('显式原resolved仅实现变化可只读复验，原字节和次数不变且无新额度',t=>{
    const s=createResolvedSample(t);
    const restored=s.enabled(()=>loadReaderRecoveryRevision(s.directory,s.identity,s.options));
    assert.equal(restored.attempts,s.payload.attempts);
    assert.equal(restored.fullAttempts,s.payload.fullAttempts);
    assert.deepEqual(restored.draft,s.payload.draft);
    assert.equal(restored.implementationRepairAllowanceProof,s.payload.implementationRepairAllowanceProof);
    assert.deepEqual(fs.readFileSync(s.resolvedFile),s.original);
    assert.equal(loadFailedCandidate(s.directory,s.identity),null);
    const again=s.enabled(()=>loadReaderRecoveryRevision(s.directory,s.identity,s.options));
    assert.deepEqual(again,restored);
});

for (const name of ['input','model','prompt','repair','pixels','sha','success','paper','outside']) {
    test(`显式resolved拒绝${name}漂移且不建立新候选`,t=>{
        const s=createResolvedSample(t),identity=structuredClone(s.identity),options=structuredClone(s.options);
        if(name==='input')identity.inputFingerprint='changed';
        if(name==='model')identity.model.model='another-model';
        if(name==='prompt')identity.promptSha256='changed';
        if(name==='repair')identity.repairImplementationSha256='7'.repeat(64);
        if(name==='pixels')options.pixelEvidenceSha256='7'.repeat(64);
        if(name==='sha')options.resolvedReaderCandidate.envelopeSha256='7'.repeat(64);
        if(name==='success')delete options.paper.latestAnalysisAttemptError;
        if(name==='paper')options.paper.apiReaderPlanSha256='7'.repeat(64);
        if(name==='outside')options.resolvedReaderCandidate.basename='../outside.resolved.json';
        assert.throws(()=>s.enabled(()=>loadReaderRecoveryRevision(s.directory,identity,options)));
        assert.equal(loadFailedCandidate(s.directory,identity),null);
        assert.deepEqual(fs.readFileSync(s.resolvedFile),s.original);
    });
}


test('真实生成入口复验resolved完整稿零模型通过，解析拒绝不偷偷发新请求', async t => {
    const utils = require('../scripts/utils');
    const previousLoad = utils.loadEnvFile;
    const oldEnv = { ...process.env };
    utils.loadEnvFile = () => {
        process.env.PAPER_ANALYZER_MODEL = 'muse-spark-1.3-contributor';
        process.env.PAPER_ANALYZER_API_KEY = 'dummy-test-key';
        process.env.PAPER_ANALYZER_ENDPOINT = 'https://example.invalid/v1';
        process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
    };
    const deep = require('../scripts/deep-analyzer');
    utils.loadEnvFile = previousLoad;
    t.after(() => { for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]; Object.assign(process.env, oldEnv); });
    const example = require('./reader-signed-draft-fixture').fixture({ noFigures: true, sourceText: 'The source reports a controlled measurement of 1.0 under the same protocol. The recorded outputs are compared with a matched baseline under the stated data conditions. '.repeat(80) });
    const sample = createSample(t, example.paper.arxivId.replace(/v[1-9]\d*$/, ''));
    const oldDailyRoot=Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir=sample.root; Config.FILES.freshRewriteRunsDir=path.join(sample.root,'other');
    t.after(()=>{Config.FILES.dailyFreshSourceRunsDir=oldDailyRoot;});
    const expectation = { sourceSha256: crypto.createHash('sha256').update(example.sourceDetails.text).digest('hex'),
        structuredArtifactsSha256: example.sourceDetails.structuredArtifacts.payloadSha256 };
    sample.context.sourceExpectations = { [sample.oldIdentity.paperId]: expectation };
    fs.writeFileSync(path.join(sample.context.runDir, 'run.json'), JSON.stringify({version:1,contract:'daily-fresh-source-run-v1',
        runId:sample.context.runId,paperIds:[sample.oldIdentity.paperId],sourceExpectations:sample.context.sourceExpectations}),{mode:0o600});
    const options = { sourceText:example.sourceDetails.text,structuredArtifacts:example.sourceDetails.structuredArtifacts,
        readerAttemptsDir:sample.directory, readerMaterializeFigures:async()=>[], readerRecordDisposition() {} };
    const snapshot={...example.sourceDetails,source:'html',sourceId:sample.oldIdentity.paperId}; delete snapshot.freshSourceDescriptor;
    const sourceBytes=JSON.stringify(snapshot);
    const sourceRoot=path.join(sample.context.runDir,'sources',sample.oldIdentity.paperId);
    fs.mkdirSync(sourceRoot,{recursive:true,mode:0o700});
    const descriptor={version:1,contract:'fresh-source-cache-v1',runId:sample.context.runId,paperId:sample.oldIdentity.paperId,
        ...expectation,sourceSnapshotSha256:crypto.createHash('sha256').update(sourceBytes).digest('hex')};
    fs.writeFileSync(path.join(sourceRoot,'source.json'),JSON.stringify(descriptor),{mode:0o600});
    fs.writeFileSync(path.join(sourceRoot,'source-details.json'),sourceBytes,{mode:0o600});
    fs.writeFileSync(path.join(sourceRoot,'source.txt'),snapshot.text,{mode:0o600});
    fs.writeFileSync(path.join(sourceRoot,'artifacts.json'),JSON.stringify(snapshot.structuredArtifacts),{mode:0o600});
    const paper = example.paper;
    const fresh=require('../scripts/lib/fresh-analysis-context');
    sample.enabled(()=>fresh.attachFreshSourceRecord(paper,paper.analysisManifest,fresh.readFreshSource(sample.context.runDir,paper,sample.context)));
    const prepared = await sample.enabled(()=>deep.prepareApiReaderRetryIdentity(paper, paper.analysis, '', options));
    const oldIdentity = {...prepared.identity,parserImplementationSha256:'9'.repeat(64)};
    const payload = {...sample.payload,draft:example.draft,rawDraft:JSON.stringify(example.draft),
        ephemeralImageEvidence:{imageEvidence:[],directSupplementaryEvidence:[]}};
    saveFailedCandidate(sample.directory,oldIdentity,payload);
    const filename = require('../scripts/lib/reader-repair').retireFailedCandidate(sample.directory,oldIdentity);
    const original = fs.readFileSync(filename);
    const stage = paper.analysisManifest.stages.apiReaderArticle;
    Object.assign(stage,{model:oldIdentity.model.model,protocol:oldIdentity.model.protocol,promptTemplateSha256:oldIdentity.promptSha256,
        repairPromptTemplateSha256:oldIdentity.repairPromptSha256,imageEvidenceSha256:hashDraft([]),
        modelImagePreflightEvidenceSha256:hashDraft(payload.ephemeralImageEvidence),qualityMetrics:{blockingIssueCount:1}});
    paper.latestAnalysisAttemptError='真实最终质量计数拒绝';
    options.resolvedReaderCandidate={basename:path.basename(filename),envelopeSha256:crypto.createHash('sha256').update(original).digest('hex'),
        readerArticleSha256:paper.apiReaderArticleSha256,readerPlanSha256:paper.apiReaderPlanSha256};
    let calls=0;options.readerCallModel=async()=>{calls++;throw new Error('不得请求模型');};
    const result = await sample.enabled(()=>deep.generateApiReaderArticleDetailed(paper,paper.analysis,'',options));
    assert.equal(result.qualityMetrics.blockingIssueCount,0);
    assert.equal(result.attempts,payload.attempts);assert.equal(result.fullAttempts,payload.fullAttempts);
    assert.equal(calls,0);assert.deepEqual(fs.readFileSync(filename),original);
    assert.equal(fs.readdirSync(sample.directory).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).length,0);
    const bad=JSON.parse(JSON.stringify(payload));bad.draft.sections[7].body+='\n\n表后解释必须补充比较。';
    bad.rawDraft=JSON.stringify(bad.draft);
    saveFailedCandidate(sample.directory,oldIdentity,bad);
    const badFile=require('../scripts/lib/reader-repair').retireFailedCandidate(sample.directory,oldIdentity);
    options.resolvedReaderCandidate={...options.resolvedReaderCandidate,basename:path.basename(badFile),
        envelopeSha256:crypto.createHash('sha256').update(fs.readFileSync(badFile)).digest('hex')};
    await assert.rejects(sample.enabled(()=>deep.generateApiReaderArticleDetailed(paper,paper.analysis,'',options)),
        error=>error.code==='RESOLVED_READER_REVALIDATION_REJECTED' && error.retryable===false);
    assert.equal(calls,0);
});


test('已有有效未用实现许可按原身份复验且原证明原额度不变',t=>{
    const s=createResolvedSample(t,true);
    const proof=structuredClone(s.payload.implementationRepairAllowanceProof);
    const result=s.enabled(()=>loadReaderRecoveryRevision(s.directory,s.identity,s.options));
    assert.deepEqual(result.implementationRepairAllowanceProof,proof);
    assert.deepEqual(result.implementationRepairAllowanceLineage,s.payload.implementationRepairAllowanceLineage);
    assert.equal(result.attempts,s.payload.attempts);assert.equal(result.fullAttempts,s.payload.fullAttempts);
    assert.deepEqual(fs.readFileSync(s.resolvedFile),s.original);
    assert.equal(loadFailedCandidate(s.directory,s.identity),null);
});

for(const defect of ['许可篡改','原身份不匹配','正文自证','计划自证']){
    test(`已有许可归档拒绝${defect}`,t=>{
        const s=createResolvedSample(t,true);
        if(defect==='正文自证')s.options.paper.apiReaderArticle+='改写';
        else if(defect==='计划自证')s.options.paper.apiReaderPlan.sections.push({heading:'改写'});
        else {
            const envelope=JSON.parse(s.original);
            if(defect==='许可篡改')envelope.payload.implementationRepairAllowanceProof.allowanceSha256='7'.repeat(64);
            else envelope.payload.implementationRepairAllowanceProof.toIdentitySha256='7'.repeat(64);
            envelope.payloadSha256=hashDraft(envelope.payload);
            const bytes=Buffer.from(JSON.stringify(envelope));
            fs.writeFileSync(s.resolvedFile,bytes,{mode:0o600});
            s.options.resolvedReaderCandidate.envelopeSha256=crypto.createHash('sha256').update(bytes).digest('hex');
        }
        assert.throws(()=>s.enabled(()=>loadReaderRecoveryRevision(s.directory,s.identity,s.options)));
        assert.equal(loadFailedCandidate(s.directory,s.identity),null);
    });
}
