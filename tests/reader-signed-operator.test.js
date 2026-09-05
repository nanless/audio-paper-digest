'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {fixture,sign}=require('./reader-signed-draft-fixture.js');
const runner=require('../scripts/lib/fresh-rewrite-run.js');
const engine=require('../scripts/analysis-engine.js');
const repair=require('../scripts/lib/reader-repair.js');
const {recoverSignedReaderDraft}=require('../scripts/lib/reader-signed-draft.js');
const {prepareSignedReaderOperatorResult,applySignedReaderOperator,acceptSignedReaderFactReview}=require('../scripts/lib/reader-signed-operator.js');

function setup(t, options={}) {
    const f=fixture({noFigures:options.noFigures!==false});
    const stage=f.paper.analysisManifest.stages.apiReaderArticle;
    Object.assign(stage,{attempts:6,fullAttempts:2,transportFailures:3,promptTemplateSha256:'e'.repeat(64),
        temperature:1,apiUsageHistory:[{requests:4,totalTokens:12345}]});sign(f.paper);
    const inverse=recoverSignedReaderDraft(f);
    const patch={version:1,draftSha256:inverse.proof.draftSha256,replacements:[{path:'/sections/0/body',
        oldSha256:repair.hashDraft(inverse.draft.sections[0].body),
        value:inverse.draft.sections[0].body+'\n\n补充核对时需要保留实验条件，不能仅凭模型名字认定指标提升。'}]};
    const request={version:1,runId:f.runId,paperId:f.paper.arxivId,parentPaperSha256:runner.stableHash(f.paper),
        parentArticleSha256:f.paper.apiReaderArticleSha256,parentPlanSha256:f.paper.apiReaderPlanSha256,
        sourceSha256:f.paper.sourceSha256,reason:'按原文补充已审查的实验条件边界。',patch};
    const rootDir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'signed-operator-'));
    t.after(()=>fs.rmSync(rootDir,{recursive:true,force:true}));
    const runDir=path.join(rootDir,f.runId);fs.mkdirSync(path.join(runDir,'patches'),{recursive:true,mode:0o700});
    const run={runId:f.runId,status:'complete',identitySha256:'a'.repeat(64),paperIds:[f.paper.arxivId],
        sourceExpectations:{[f.paper.arxivId]:{sourceSha256:f.paper.sourceSha256,
            structuredArtifactsSha256:f.sourceDetails.structuredArtifacts.payloadSha256}}};
    const other={arxivId:'2609.99999',opaqueBudget:{attempts:9,keep:'other paper untouched'}};
    const analysis={status:'complete',generation:7,papers:[f.paper,other]};
    fs.writeFileSync(path.join(runDir,'analysis.json'),JSON.stringify(analysis),{mode:0o600});
    fs.writeFileSync(path.join(runDir,'run.json'),JSON.stringify(run),{mode:0o600});
    const patchFile=path.join(runDir,'patches','reviewed.json');
    const writeRequest=()=>fs.writeFileSync(patchFile,JSON.stringify(request),{mode:0o600});writeRequest();
    const read=name=>JSON.parse(fs.readFileSync(path.join(runDir,name+'.json')));
    const reload=()=>({runDir,run:read('run'),analysis:read('analysis'),inputs:{papers:[{arxivId:f.paper.arxivId}]}});
    let paperLocked=false;
    const deps={rootDir,readFreshSource:()=>{assert(paperLocked);return f.sourceDetails;},now:()=> '2026-09-06T08:00:00Z',
        withPaperAnalysisLock:async(p,cb)=>engine.withFileLock(path.join(runDir,'test-paper-lock'),async()=>{
            assert.equal(p.arxivId,f.paper.arxivId);assert(fs.existsSync(path.join(runDir,'.operation.lock')));
            paperLocked=true;try{return await cb();}finally{paperLocked=false;}}),reload,
        updateJsonFileLocked:engine.updateJsonFileLocked,
        updateRun:changes=>engine.updateJsonFileLocked(path.join(runDir,'run.json'),current=>({...current,...changes}))};
    const apply=hooks=>engine.withFileLock(path.join(runDir,'.operation'),()=>applySignedReaderOperator(
        {loaded:reload(),patchFile:'reviewed.json'},{...deps,...hooks}));
    const accept=(request,hooks)=>engine.withFileLock(path.join(runDir,'.operation'),()=>acceptSignedReaderFactReview(
        {loaded:reload(),request},{...deps,isSuccessfulAnalysisRecord:()=>true,...hooks}));
    return {...f,request,run,rootDir,runDir,other,patchFile,writeRequest,read,reload,apply,accept};
}

test('real parser and shared sealing install operator provenance, preserve API origin and require fact review without any fetch',async t=>{
    const f=setup(t),parent=JSON.stringify(f.paper),oldFetch=global.fetch;let calls=0;
    global.fetch=async()=>{calls++;throw new Error('no network is authorized');};t.after(()=>{global.fetch=oldFetch;});
    const result=await f.apply();assert.equal(result.status,'fact_review_pending');assert.equal(calls,0);
    const analysis=f.read('analysis'),paper=analysis.papers[0],stage=paper.analysisManifest.stages.apiReaderArticle;
    assert.equal(engine.apiReaderV3BindsCanonical(paper),true);assert.equal(JSON.stringify(f.paper),parent);
    assert.equal(stage.executionKind,'operator');assert.equal(stage.model,'operator-local');
    assert.equal(stage.promptTemplateSha256,undefined);assert.equal(stage.temperature,undefined);
    assert.deepEqual(stage.originApiStage,f.paper.analysisManifest.stages.apiReaderArticle);
    assert.equal(stage.attempts,6);assert.equal(stage.fullAttempts,2);assert.equal(stage.transportFailures,3);
    assert.equal(stage.operatorProvenance.newApiRequests,0);assert(stage.operatorProvenance.implementationIdentity);
    assert.equal(paper.readerFactReview.status,'pending');assert.equal(f.read('run').status,'fact_review_pending');
    assert.equal(f.read('run').analysisSha256,runner.readRegularJson(path.join(f.runDir,'analysis.json')).sha256);
    assert.deepEqual(analysis.papers[1],f.other);
    const before=fs.readFileSync(path.join(f.runDir,'analysis.json'));
    await f.apply();assert.deepEqual(fs.readFileSync(path.join(f.runDir,'analysis.json')),before);
    const archive=path.join(f.runDir,result.archive);
    assert.deepEqual(fs.readFileSync(path.join(archive,'request.json')),fs.readFileSync(f.patchFile));
    assert.equal(fs.statSync(path.join(archive,'output.json')).mode&0o777,0o600);
});

test('durable intent/output, analysis installation and run SHA interruption recover without API or duplicate operator history',async t=>{
    for(const hook of ['afterIntent','afterOutput','afterAnalysis','afterRun']) {
        const f=setup(t);
        await assert.rejects(f.apply({[hook]:()=>{throw new Error('injected interruption');}}),/injected/);
        const result=await f.apply(),paper=f.read('analysis').papers[0];
        assert.equal(result.newApiRequests,0);assert.equal(paper.analysisManifest.stages.apiReaderArticle.operatorHistory.length,1);
        assert.equal(paper.analysisManifest.stages.apiReaderArticle.attempts,6);
        assert.equal(f.read('run').analysisSha256,runner.readRegularJson(path.join(f.runDir,'analysis.json')).sha256);
    }
});

test('stale parent, invalid source/draft/node, append and production gate failures leave analysis and archives unchanged',async t=>{
    for(const mutate of [f=>{f.request.parentPaperSha256='0'.repeat(64);},
        f=>{f.request.sourceSha256='0'.repeat(64);},f=>{f.request.patch.draftSha256='0'.repeat(64);},
        f=>{f.request.patch.replacements[0].oldSha256='0'.repeat(64);},
        f=>{f.request.patch.replacements[0].path='/sections/12';},
        f=>{f.request.patch.replacements[0]={path:'/readerTitle',oldSha256:repair.hashDraft(f.paper.apiReaderPlan.readerTitle),value:'短'};}]) {
        const f=setup(t),before=fs.readFileSync(path.join(f.runDir,'analysis.json'));mutate(f);f.writeRequest();
        await assert.rejects(f.apply());assert.deepEqual(fs.readFileSync(path.join(f.runDir,'analysis.json')),before);
        assert.equal(fs.existsSync(path.join(f.runDir,'patches','signed-operator-archive')),false);
    }
});

test('durable output corruption and competing parent installation fail closed',async t=>{
    for(const corrupt of [true,false]) {
        const f=setup(t);await assert.rejects(f.apply({afterOutput:()=>{throw new Error('stop');}}));
        if(corrupt){const archive=fs.readdirSync(path.join(f.runDir,'patches','signed-operator-archive'))[0];
            const filename=path.join(f.runDir,'patches','signed-operator-archive',archive,'output.json');
            const value=JSON.parse(fs.readFileSync(filename));value.provenance.reason+=' drift';fs.writeFileSync(filename,JSON.stringify(value));
        }else{const analysis=f.read('analysis');analysis.papers[0].newerUnrelatedFactReview='preserve';
            fs.writeFileSync(path.join(f.runDir,'analysis.json'),JSON.stringify(analysis));}
        const before=fs.readFileSync(path.join(f.runDir,'analysis.json'));
        await assert.rejects(f.apply(),/drift|CAS/);assert.deepEqual(fs.readFileSync(path.join(f.runDir,'analysis.json')),before);
    }
});

test('operator never downloads a missing or foreign signed pixel cache',async t=>{
    const f=setup(t,{noFigures:false});let fetches=0;const old=global.fetch;
    global.fetch=async()=>{fetches++;throw new Error('unexpected fetch');};t.after(()=>{global.fetch=old;});
    await assert.rejects(prepareSignedReaderOperatorResult({parent:f.paper,sourceDetails:f.sourceDetails,run:f.run,
        request:f.request,patchFileSha256:runner.sha256(fs.readFileSync(f.patchFile)),appliedAt:'2026-09-06T08:00:00Z'}),/cache|ENOENT/);
    assert.equal(fetches,0);
});

test('signed-patch CLI is explicit and rejects other-stage flags and paths',()=>{
    const id='11111111-2222-4333-8444-555555555555';
    assert.equal(runner.parseRewriteArgs(['signed-patch','--run-id',id,'--patch','reviewed.json']).action,'signed-patch');
    for(const tail of [['--ids','2609.12345'],['--concurrency','1'],['--refresh-reader-diagnostics']])
        assert.throws(()=>runner.parseRewriteArgs(['signed-patch','--run-id',id,'--patch','reviewed.json',...tail]));
    assert.throws(()=>runner.parseRewriteArgs(['signed-patch','--run-id',id,'--patch','../reviewed.json']));
});

function reportRequest(f) {
    const paper=f.read('analysis').papers[0];
    const request={runId:f.runId,paperId:paper.arxivId,parentPaperSha256:runner.stableHash(paper),
        articleSha256:paper.apiReaderArticleSha256,planSha256:paper.apiReaderPlanSha256,sourceSha256:paper.sourceSha256,
        reportFile:'independent-review.md',reportSha256:'',reviewer:'independent fixture reviewer',verdict:'pass'};
    const text=[request.paperId,request.parentPaperSha256,request.articleSha256,request.planSha256,request.sourceSha256,
        'PASS: independent source, metric direction and visual verification.'].join('\n');
    fs.mkdirSync(path.join(f.runDir,'source-audits'),{mode:0o700});
    fs.writeFileSync(path.join(f.runDir,'source-audits',request.reportFile),text,{mode:0o600});
    request.reportSha256=runner.sha256(text);return request;
}

test('explicit SHA-bound independent fact acceptance restores complete and preserves article/plan/API origin',async t=>{
    const f=setup(t);await f.apply();const request=reportRequest(f),before=f.read('analysis').papers[0];
    const result=await f.accept(request),after=f.read('analysis').papers[0];
    assert.equal(result.status,'complete');assert.equal(after.readerFactReview.status,'complete');
    assert.equal(after.apiReaderArticle,before.apiReaderArticle);assert.deepEqual(after.apiReaderPlan,before.apiReaderPlan);
    assert.deepEqual(after.analysisManifest,before.analysisManifest);
    assert.equal(after.readerFactReview.reportSha256,request.reportSha256);
    assert.equal(f.read('run').analysisSha256,runner.readRegularJson(path.join(f.runDir,'analysis.json')).sha256);
    const bytes=fs.readFileSync(path.join(f.runDir,'analysis.json'));await f.accept(request);
    assert.deepEqual(fs.readFileSync(path.join(f.runDir,'analysis.json')),bytes);
});

test('fact receipt and analysis-install interruptions recover with exact report and no duplicate mutation',async t=>{
    for(const hook of ['afterFactReceipt','afterFactAnalysis']) {
        const f=setup(t);await f.apply();const request=reportRequest(f);
        await assert.rejects(f.accept(request,{[hook]:()=>{throw new Error('fact interruption');}}),/interruption/);
        assert.equal((await f.accept(request)).status,'complete');
    }
});

test('fact acceptance rejects stale paper, report hash, cross-run, traversal, unsafe mode and report race',async t=>{
    for(const change of [r=>{r.parentPaperSha256='0'.repeat(64);},r=>{r.reportSha256='0'.repeat(64);},
        r=>{r.runId='22222222-2222-4222-8222-222222222222';},r=>{r.reportFile='../review.md';},
        r=>{r.verdict='fail';}]) {
        const f=setup(t);await f.apply();const request=reportRequest(f),before=fs.readFileSync(path.join(f.runDir,'analysis.json'));
        change(request);await assert.rejects(f.accept(request));assert.deepEqual(fs.readFileSync(path.join(f.runDir,'analysis.json')),before);
    }
    const f=setup(t);await f.apply();const request=reportRequest(f),report=path.join(f.runDir,'source-audits',request.reportFile);
    fs.chmodSync(report,0o644);await assert.rejects(f.accept(request),/0600/);fs.chmodSync(report,0o600);
    const before=fs.readFileSync(path.join(f.runDir,'analysis.json'));
    await assert.rejects(f.accept(request,{afterFactReceipt:()=>fs.appendFileSync(report,' drift')}),/bytes changed/);
    assert.deepEqual(fs.readFileSync(path.join(f.runDir,'analysis.json')),before);
});

test('single-paper fact acceptance preserves pre-existing batch review and newer external failures',async t=>{
    for(const [baseline,later] of [['fact_review_pending',null],['fact_review_revision_failed',null],['complete','fact_review_revision_failed']]) {
        const f=setup(t);
        for(const name of ['run','analysis']) {const value=f.read(name);value.status=baseline;
            fs.writeFileSync(path.join(f.runDir,name+'.json'),JSON.stringify(value));}
        await f.apply();const request=reportRequest(f);
        if(later)for(const name of ['run','analysis']) {const value=f.read(name);value.status=later;
            fs.writeFileSync(path.join(f.runDir,name+'.json'),JSON.stringify(value));}
        const result=await f.accept(request);
        assert.equal(result.status,later||baseline);assert.equal(f.read('analysis').status,later||baseline);
        assert.equal(f.read('analysis').papers[0].readerFactReview.status,'complete');
    }
});

test('run-level review failure remains authoritative when analysis was complete',async t=>{
    for(const baseline of ['fact_review_pending','fact_review_revision_failed']) {
        const f=setup(t),run=f.read('run');run.status=baseline;
        fs.writeFileSync(path.join(f.runDir,'run.json'),JSON.stringify(run));
        await f.apply();const request=reportRequest(f);
        assert.equal((await f.accept(request)).status,baseline);
        assert.equal(f.read('run').status,baseline);assert.equal(f.read('analysis').status,baseline);
    }
});
