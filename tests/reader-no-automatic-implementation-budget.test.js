'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const deep=require('../scripts/deep-analyzer'),repair=require('../scripts/lib/reader-repair');
const revision=require('../scripts/lib/reader-recovery-revision');
const Config=require('../scripts/config');
const counters=['attempts','fullAttempts','transportFailures','noProgress','failureSignature','validationFailureStreak','validationFailureSignature'];
async function fixture(t,route='daily') {
    const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'reader-no-auto-budget-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const sample=require('./reader-signed-draft-fixture').fixture({noFigures:true});
    const draft=structuredClone(sample.draft);
    draft.formulaBindings=[];draft.sections[4].body=draft.sections[4].body.replace('\n\n[[FORMULA_1]]','');
    const text=sample.sourceDetails.text,runId=crypto.randomUUID();
    const body={version:1,parserVersion:route==='conference'?'conference-pdf-structure-v2-visual-only-math-tables':'budget-policy-fixture-v1',tables:[],formulas:[],figures:[],flattenedTextSha256:repair.shaText(text),
        ...(route==='conference'?{sourceKind:'conference_pdf'}:{})};
    const artifacts={...body,payloadSha256:deep.stableFingerprint(body)};
    let paper={arxivId:'2610.99083v1',title:'原预算守卫离线验证',analysis:'unchanged paid main'},run,directory;
    let source={source:'html',sourceId:'2610.99083',text,structuredArtifacts:artifacts};
    if(route==='daily') {
        const daily=require('../scripts/lib/daily-fresh-source-plan'),sourceApi=require('../scripts/lib/fresh-arxiv-rewrite-source');
        const previous=Config.FILES.dailyFreshSourceRunsDir;Config.FILES.dailyFreshSourceRunsDir=path.join(root,'daily');
        t.after(()=>{Config.FILES.dailyFreshSourceRunsDir=previous;});
        const plan=daily.createDailyFreshSourcePlan({batchDate:'2026-10-16',batchId:'no-auto-budget',papers:[paper]});
        await daily.captureDailyFreshSources(plan,{concurrency:1,capture:options=>sourceApi.captureFreshArxivRewriteSource(options,{
            fetchText:async id=>({text,source:'html',sourceId:id,url:'https://arxiv.org/html/'+id,fetchedAt:'2026-10-16T00:00:00.000Z',imageInfos:[],warnings:[],structuredArtifacts:artifacts}),
            fetchPdf:async id=>({bytes:Buffer.from('%PDF-1.7\n'+id+'\n%%EOF\n'),url:'https://arxiv.org/pdf/'+id,fetchedAt:'2026-10-16T00:00:01.000Z'})
        })});
        source=daily.readDailyFreshSource(plan,paper);directory=plan.readerAttemptsDir;
        paper.analysisManifest={stages:{}};
        daily.withDailyFreshAnalysisContext(plan,()=>require('../scripts/lib/fresh-analysis-context').attachFreshSourceRecord(paper,paper.analysisManifest,source));
        run=fn=>daily.withDailyFreshAnalysisContext(plan,()=>daily.withDailyFreshPaperSource(plan,paper,()=>fn()),{refreshReaderDiagnostics:true});
    } else if(route==='conference') {
        const id='conference:interspeech:2026:conference-paper-id:no_auto_budget';
        paper={id,source:'conference',title:paper.title,analysis:paper.analysis};
        source={...source,source:'conference_pdf_text',sourceId:id,
            conferenceCapabilities:{fullText:'full',tables:'unavailable',formulas:'unavailable',figures:'available'}};
        const executionDir=path.join(root,runId);fs.mkdirSync(executionDir);directory=path.join(executionDir,'reader-attempts');
        run=fn=>require('../scripts/lib/conference-analysis-context').withConferenceAnalysisSource({
            executionId:runId,executionDir,paperId:id,sourceDetails:source,readerRetryEpoch:1},fn);
    } else {
        paper.arxivId='2610.99083';
        directory=path.join(root,'reader-attempts');
        run=fn=>require('../scripts/lib/direct-rewrite-analysis-context').withDirectRewriteAnalysisSource({
            paperId:'arxiv:2610.99083',runId,route:'arxiv-fresh-fetch',sourceDetails:source,
            sourceSha256:repair.shaText(text),structuredArtifactsSha256:artifacts.payloadSha256,
            sourceSnapshotSha256:'a'.repeat(64),sourceGeneration:1,sourceManifestSha256:'b'.repeat(64),readerAttemptsDir:directory},fn);
    }
    const rb={contract:'api-reader-resource-identity-v1',sourceTextSha256:repair.shaText(text),resources:[]};
    paper.apiReaderResources={...rb,identitySha256:deep.stableFingerprint(rb)};
    const evidence=deep.buildApiReaderEvidenceContext(paper.analysis,text,source.structuredArtifacts,paper.arxivId||paper.id,null,paper.apiReaderResources);
    const options={sourceText:text,structuredArtifacts:source.structuredArtifacts,readerResources:paper.apiReaderResources,
        readerAttemptsDir:directory,readerMaxAttempts:6,readerMaterializeFigures:async()=>[],readerRecordDisposition(){}};
    const {identity}=await run(()=>deep.prepareApiReaderRetryIdentity(paper,paper.analysis,evidence,options));
    const oldIdentity={...identity,parserImplementationSha256:'0'.repeat(64)};
    const payload={status:'failed',draft,rawDraft:JSON.stringify(draft),issues:[{path:'/sections/0/body',message:'original unresolved gate'}],
        attempts:6,fullAttempts:2,noProgress:0,failureSignature:'original failure',transportFailures:2,
        validationFailureStreak:0,validationFailureSignature:'original validation',imageEvidence:[],
        ephemeralImageEvidence:{imageEvidence:[],directSupplementaryEvidence:[]}};
    const generate=extra=>run(()=>deep.generateApiReaderArticleDetailed(paper,paper.analysis,evidence,{...options,...extra}));
    return {run,runId:identity.freshAnalysis?.runId||runId,paper,source,evidence,options,directory,identity,oldIdentity,payload,generate};
}
for(const route of ['daily','conference','history']) {
    test(route+': parser migration cannot grant seventh response or clear original state',async t=>{
        const f=await fixture(t,route);f.payload.draft.sections[0].body='本段尚未完成。';f.payload.rawDraft=JSON.stringify(f.payload.draft);
        repair.saveFailedCandidate(f.directory,f.oldIdentity,f.payload);let calls=0;
        await assert.rejects(f.generate({allowNewImplementationAllowance:true,readerCallModel:async()=>{calls++;throw Error('unexpected model');}}),
            e=>e.code==='READER_REPAIR_ATTEMPTS_EXHAUSTED');
        assert.equal(calls,0);
        const migrated=await f.run(()=>repair.loadFailedCandidate(f.directory,f.identity));
        for(const key of counters)assert.equal(migrated[key],f.payload[key],key);
        assert.equal(migrated.implementationRepairAllowanceProof,null);
        assert.equal(migrated.readerRecoveryRevisions.at(-1).clearedNoProgress,false);
    });
    test(route+': same failed rule stops at streak two even with original response slots',async t=>{
        const f=await fixture(t,route);f.payload.attempts=3;f.payload.fullAttempts=1;
        f.payload.noProgress=2;f.payload.validationFailureStreak=2;
        f.payload.draft.sections[0].body='本段尚未完成。';f.payload.rawDraft=JSON.stringify(f.payload.draft);
        repair.saveFailedCandidate(f.directory,f.oldIdentity,f.payload);let calls=0;
        await assert.rejects(f.generate({readerCallModel:async()=>{calls++;throw Error('unexpected model');}}),
            e=>e.code==='READER_REPAIR_ATTEMPTS_EXHAUSTED');
        assert.equal(calls,0);
        const migrated=await f.run(()=>repair.loadFailedCandidate(f.directory,f.identity));
        for(const key of counters)assert.equal(migrated[key],f.payload[key],key);
    });
    test(route+': current parser accepts exhausted real saved shape without a new response',async t=>{
        const f=await fixture(t,route);repair.saveFailedCandidate(f.directory,f.oldIdentity,f.payload);let calls=0;
        const result=await f.generate({readerCallModel:async()=>{calls++;throw Error('unexpected model');}});
        assert.equal(calls,0);assert.equal(result.resumedCandidate,true);assert.equal(result.attempts,6);
        assert.equal(typeof result.article,'string');assert(result.article.length>5000);
    });
    test(route+': verified unused legacy proof cannot authorize an extra paid response',async t=>{
        const f=await fixture(t,route);f.payload.draft.sections[0].body='本段尚未完成。';f.payload.rawDraft=JSON.stringify(f.payload.draft);
        const legacy=await f.run(()=>require('./helpers/synthetic-legacy-reader-allowance').saveSyntheticLegacyAllowance({
            directory:f.directory,fromIdentity:f.oldIdentity,toIdentity:f.identity,payload:f.payload,runId:f.runId,
            scope:route==='daily'?'fresh-run':route==='conference'?'conference-process':'historical-direct'}));
        assert.equal(repair.hasUnusedImplementationAllowance(legacy.payload),true);
        const filename=path.join(f.directory,repair.hashDraft(f.identity)+'.json'),bytes=fs.readFileSync(filename);let calls=0;
        await assert.rejects(f.generate({readerCallModel:async()=>{calls++;throw Error('unexpected model');}}),e=>e.code==='READER_REPAIR_ATTEMPTS_EXHAUSTED');
        assert.equal(calls,0);assert.deepEqual(fs.readFileSync(filename),bytes);
    });
    test(route+': legacy proof never reopens the stopped rule group or third full response',async t=>{
        for(const fullStop of [false,true]){
            const f=await fixture(t,route);f.payload.attempts=3;
            if(fullStop){f.payload.draft=null;f.payload.rawDraft='invalid prior full JSON';}
            else{f.payload.fullAttempts=1;f.payload.noProgress=2;f.payload.validationFailureStreak=2;
                f.payload.draft.sections[0].body='本段尚未完成。';f.payload.rawDraft=JSON.stringify(f.payload.draft);}
            await f.run(()=>require('./helpers/synthetic-legacy-reader-allowance').saveSyntheticLegacyAllowance({
                directory:f.directory,fromIdentity:f.oldIdentity,toIdentity:f.identity,payload:f.payload,runId:f.runId,
                scope:route==='daily'?'fresh-run':route==='conference'?'conference-process':'historical-direct'}));
            let calls=0;await assert.rejects(f.generate({readerCallModel:async()=>{calls++;throw Error('unexpected model');}}),
                e=>e.code===(fullStop?'READER_FULL_ATTEMPTS_EXHAUSTED':'READER_REPAIR_ATTEMPTS_EXHAUSTED'));
            assert.equal(calls,0);
            const saved=await f.run(()=>repair.loadFailedCandidate(f.directory,f.identity));
            for(const key of counters)assert.equal(saved[key],f.payload[key],key);
            assert(saved.implementationRepairAllowanceProof);
        }
    });
}
test('public migration rejects a boolean grant before reading or writing',()=>{
    assert.throws(()=>revision.loadReaderRecoveryRevision('/does-not-exist',{}, {allowNewImplementationAllowance:true}),/retired.*explicit paid round/);
});
test('an exactly truncated patch cannot add a response or bypass the stopped rule group',async t=>{
    const previous=Config.ANALYSIS_CONFIG.apiReaderRepairMaxTokens;
    Config.ANALYSIS_CONFIG.apiReaderRepairMaxTokens=8000;
    t.after(()=>{Config.ANALYSIS_CONFIG.apiReaderRepairMaxTokens=previous;});
    for(const stoppedGroup of [false,true]){
        const f=await fixture(t,'conference');assert.equal(f.identity.repairMaxTokens,8000);
        f.payload.draft.sections[0].body='本段尚未完成。';f.payload.rawDraft=JSON.stringify(f.payload.draft);
        if(stoppedGroup){f.payload.attempts=3;f.payload.fullAttempts=1;f.payload.noProgress=2;f.payload.validationFailureStreak=2;}
        f.payload.lastContentError={code:'MODEL_OUTPUT_TRUNCATED',requestKind:'patch',outputTokens:8000,maxOutputTokens:8000};
        repair.saveFailedCandidate(f.directory,f.oldIdentity,f.payload);let calls=0;
        await assert.rejects(f.generate({readerCallModel:async()=>{calls++;throw Error('unexpected model');}}),e=>e.code==='READER_REPAIR_ATTEMPTS_EXHAUSTED');
        assert.equal(calls,0);
        const saved=await f.run(()=>repair.loadFailedCandidate(f.directory,f.identity));
        for(const key of counters)assert.equal(saved[key],f.payload[key],key);
        assert.deepEqual(saved.lastContentError,f.payload.lastContentError);
    }
});
