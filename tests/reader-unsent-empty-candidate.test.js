'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const Config=require('../scripts/config'),daily=require('../scripts/lib/daily-fresh-source-plan'),fresh=require('../scripts/lib/fresh-analysis-context'),engine=require('../scripts/analysis-engine');
const repair=require('../scripts/lib/reader-repair'),revision=require('../scripts/lib/reader-recovery-revision'),helper=require('../scripts/lib/reader-unsent-empty-candidate');
const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600}),sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
// Constructed unit fixtures. The real saved paid drafts are separately replayed
// from immutable runtime clones; these examples never certify a real paper.
async function fixture(t,{implDifferent=false}={}) {
    const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'reader-unsent-empty-'));
    const previous={runs:Config.FILES.dailyFreshSourceRunsDir,usage:Config.FILES.llmUsageDir};
    Config.FILES.dailyFreshSourceRunsDir=path.join(root,'runs');Config.FILES.llmUsageDir=path.join(root,'usage');
    t.after(()=>{Object.assign(Config.FILES,{dailyFreshSourceRunsDir:previous.runs,llmUsageDir:previous.usage});fs.rmSync(root,{recursive:true,force:true});});
    const paper={arxivId:'2610.90119v1',title:'Constructed empty transport obstruction',analysisManifest:{stages:{}}};
    const plan=daily.createDailyFreshSourcePlan({batchDate:'2026-10-11',batchId:'unit-unsent',papers:[paper]});
    const sourceApi=require('../scripts/lib/fresh-arxiv-rewrite-source');
    await daily.captureDailyFreshSources(plan,{concurrency:1,capture:args=>sourceApi.captureFreshArxivRewriteSource(args,{
        fetchText:async id=>({text:'Official complete source evidence. '.repeat(180),source:'html',sourceId:id,url:`https://arxiv.org/html/${id}`,fetchedAt:'2026-10-11T00:00:00.000Z',imageInfos:[],warnings:[]}),
        fetchPdf:async id=>({bytes:Buffer.from(`%PDF-1.7\n${id}\n%%EOF\n`),url:`https://arxiv.org/pdf/${id}`,fetchedAt:'2026-10-11T00:00:01.000Z'})})});
    const source=daily.readDailyFreshSource(plan,paper);paper.sourceSha256=source.freshSourceDescriptor.sourceSha256;
    daily.withDailyFreshAnalysisContext(plan,()=>fresh.attachFreshSourceRecord(paper,paper.analysisManifest,source));
    const sourceIdentity=daily.withDailyFreshAnalysisContext(plan,()=>fresh.freshAnalysisIdentity(paper.arxivId));
    const base={paperId:paper.arxivId,freshAnalysis:sourceIdentity,sourceSha256:paper.sourceSha256,inputFingerprint:'same real full input',
        contentMode:'reader-source-only-v1',model:{model:'unit-model',protocol:'openai_responses',maxTokens:48000},promptSha256:'p',repairPromptSha256:'q',
        maxAttempts:6,repairMaxTokens:16000,repairImplementationSha256:'a'.repeat(64)};
    const emptyIdentity={...base,repairImplementationSha256:'b'.repeat(64)},identity=implDifferent?{...base,repairImplementationSha256:'c'.repeat(64)}:emptyIdentity;
    const draft={version:3,readerTitle:'构造测试稿',oneSentenceThesis:'原付费次数和失败保留。',sections:require('../scripts/lib/reader-draft-order').READER_SECTION_KINDS.map(kind=>({kind,heading:kind,body:kind.repeat(130)})),conceptBridges:Array.from({length:4},()=>({})),figurePlacements:[],tableBindings:[],formulaBindings:[]};
    const ephemeral={imageEvidence:[],directSupplementaryEvidence:[]};
    const paid={status:'failed',draft,rawDraft:JSON.stringify(draft),issues:[{path:null,message:'old source failure'}],attempts:3,fullAttempts:1,transportFailures:2,noProgress:2,failureSignature:'original failure',validationFailureStreak:2,validationFailureSignature:'original validation',imageEvidence:[],ephemeralImageEvidence:ephemeral,implementationRepairAllowanceProof:null};
    const empty={status:'failed',draft:null,rawDraft:'无',issues:[],attempts:0,fullAttempts:0,transportFailures:1,noProgress:0,failureSignature:'',validationFailureStreak:0,validationFailureSignature:'',imageEvidence:[],ephemeralImageEvidence:ephemeral,readerRecoveryRevisions:[],implementationRepairAllowanceProof:null};
    const paidFile=repair.saveFailedCandidate(plan.readerAttemptsDir,base,paid),emptyFile=repair.saveFailedCandidate(plan.readerAttemptsDir,emptyIdentity,empty);
    fs.mkdirSync(Config.FILES.llmUsageDir,{mode:0o700});const eventId=crypto.randomUUID();
    const usage={version:'llm-usage-v1',kind:'request',eventId,at:'2026-10-14T01:00:00.000Z',paperId:paper.arxivId,runId:plan.runId,stage:'apiReaderArticle',contentAttempt:3,protocol:base.model.protocol,model:base.model.model,outcome:'completed',transportStarted:true,statusCode:200,outputTextSha256:'f'.repeat(64),usage:{status:'reported',totalTokens:123}};
    write(path.join(Config.FILES.llmUsageDir,eventId+'.json'),usage);
    const blocked={...usage,eventId:crypto.randomUUID(),at:'2026-10-14T02:00:00.000Z',contentAttempt:1,transportAttempt:1,outcome:'blocked_before_transport',transportStarted:false,statusCode:null,outputTextSha256:null,usage:{status:'unavailable',inputTokens:null,outputTokens:null,totalTokens:null}};
    const blockedFile=path.join(Config.FILES.llmUsageDir,blocked.eventId+'.json');write(blockedFile,blocked);
    const options={allowNewImplementationAllowance:false,ephemeralImageEvidenceSha256:repair.hashDraft(ephemeral)};
    const run=(fn,refresh=true,lock=true)=>daily.withDailyFreshAnalysisContext(plan,()=>lock?engine.withPaperAnalysisLock(paper,fn):fn(),{refreshReaderDiagnostics:refresh});
    return{root,plan,paper,base,identity,emptyIdentity,paid,empty,paidFile,emptyFile,blocked,blockedFile,options,run};
}
for(const implDifferent of [false,true])test(`明确未发出的${implDifferent?'旧实现兼容':'当前exact'}空失败按原公共迁移续接，原计数与两份失败原字节保留`,async t=>{
    const f=await fixture(t,{implDifferent}),paidBytes=fs.readFileSync(f.paidFile),emptyBytes=fs.readFileSync(f.emptyFile);
    const result=await f.run(()=>revision.loadReaderRecoveryRevision(f.plan.readerAttemptsDir,f.identity,f.options));
    for(const key of ['attempts','fullAttempts','transportFailures','noProgress','failureSignature','validationFailureStreak','validationFailureSignature'])assert.deepEqual(result[key],f.paid[key]);
    assert.equal(result.implementationRepairAllowanceProof,null);assert.equal(result.readerRecoveryRevisions.at(-1).clearedNoProgress,false);
    const history=result.unfundedTransportFailureHistory[0];assert.deepEqual(fs.readFileSync(path.join(f.plan.readerAttemptsDir,history.archivedName)),emptyBytes);
    assert.deepEqual(fs.readFileSync(path.join(f.plan.readerAttemptsDir,result.readerRecoveryRevisions.at(-1).archivedName)),paidBytes);
    assert.equal(history.transportFailures,1);assert.equal(fs.existsSync(f.emptyFile),!implDifferent);
    const again=await f.run(()=>revision.loadReaderRecoveryRevision(f.plan.readerAttemptsDir,f.identity,f.options));assert.deepEqual(again,result);
    write(f.blockedFile,{...f.blocked,transportStarted:true});
    await assert.rejects(f.run(()=>revision.loadReaderRecoveryRevision(f.plan.readerAttemptsDir,f.identity,f.options)),/archived unsent event differs|证明 SHA/);
});
test('未知、网络失败、HTTP失败或缺失transportStarted不能当作零付费证据',async t=>{
    const f=await fixture(t),before=fs.readFileSync(f.emptyFile);
    for(const changed of [{outcome:'network_error'},{transportStarted:true},{transportStarted:undefined},{statusCode:500},{outputTextSha256:'a'.repeat(64)},{usage:{...f.blocked.usage,totalTokens:1}}]){
        write(f.blockedFile,{...f.blocked,...changed});await assert.rejects(f.run(()=>revision.loadReaderRecoveryRevision(f.plan.readerAttemptsDir,f.identity,f.options)),/latest real request|zero transport/);assert.deepEqual(fs.readFileSync(f.emptyFile),before);
    }
});
test('普通无flag或无锁保持原空失败；有正文、原付费次数、反馈状态都不使用例外',async t=>{
    const f=await fixture(t);
    for(const [refresh,lock] of [[false,true],[true,false]]){const result=await f.run(()=>revision.loadReaderRecoveryRevision(f.plan.readerAttemptsDir,f.identity,f.options),refresh,lock);assert.equal(result.draft,null);assert.equal(result.attempts,0);}
    for(const payload of [{...f.empty,rawDraft:'unparsed provider text'},{...f.empty,attempts:1},{...f.empty,fullAttempts:1},{...f.empty,noProgress:1}]){
        repair.saveFailedCandidate(f.plan.readerAttemptsDir,f.emptyIdentity,payload);const result=await f.run(()=>revision.loadReaderRecoveryRevision(f.plan.readerAttemptsDir,f.identity,f.options));assert.equal(result.unfundedTransportFailureHistory,undefined);
    }
});
test('不同输入或没有可选原付费稿时不归档、不放行首次full',async t=>{
    const f=await fixture(t),before=fs.readFileSync(f.emptyFile);
    const old=JSON.parse(fs.readFileSync(f.paidFile));old.identity.inputFingerprint='different source/input';fs.unlinkSync(f.paidFile);repair.saveFailedCandidate(f.plan.readerAttemptsDir,old.identity,old.payload);
    await assert.rejects(f.run(()=>revision.loadReaderRecoveryRevision(f.plan.readerAttemptsDir,f.identity,f.options)),/did not select/);assert.deepEqual(fs.readFileSync(f.emptyFile),before);
    assert.equal(fs.readdirSync(f.plan.readerAttemptsDir).some(name=>name.includes('.unsent-')),false);
});
for(const implDifferent of [false,true])test(`后续真实付费响应未保存为候选时${implDifferent?'旧实现':'exact'}空包恢复不得倒退旧稿`,async t=>{
    const f=await fixture(t,{implDifferent}),before=fs.readFileSync(f.emptyFile),eventId=crypto.randomUUID();
    write(path.join(Config.FILES.llmUsageDir,eventId+'.json'),{...f.blocked,eventId,at:'2026-10-14T01:30:00.000Z',contentAttempt:4,outcome:'completed',transportStarted:true,statusCode:200,outputTextSha256:'e'.repeat(64),usage:{status:'reported',totalTokens:999}});
    await assert.rejects(f.run(()=>revision.loadReaderRecoveryRevision(f.plan.readerAttemptsDir,f.identity,f.options)),/latest real paid attempt/);
    assert.deepEqual(fs.readFileSync(f.emptyFile),before);assert.equal(fs.readdirSync(f.plan.readerAttemptsDir).some(name=>name.includes('.unsent-')),false);
});
test('发送前起始记录缺少匹配终态时不得越过未知响应或费用',async t=>{
    const f=await fixture(t),before=fs.readFileSync(f.emptyFile);
    const pending=require('../scripts/lib/llm-pending-request').beginPendingLlmRequest({protocol:f.base.model.protocol,model:f.base.model.model,request:{messages:[]},context:{runId:f.plan.runId,paperId:f.paper.arxivId,stage:'apiReaderRepair',contentAttempt:4,transportAttempt:1}},{enabled:false}).event;
    pending.at='2026-10-14T01:30:00.000Z';write(path.join(Config.FILES.llmUsageDir,crypto.randomUUID()+'.json'),pending);
    await assert.rejects(f.run(()=>revision.loadReaderRecoveryRevision(f.plan.readerAttemptsDir,f.identity,f.options)),/unknown transport or response/);
    assert.deepEqual(fs.readFileSync(f.emptyFile),before);assert.equal(fs.readdirSync(f.plan.readerAttemptsDir).some(name=>name.includes('.unsent-')),false);
});
test('正常后续内容次数增长后，旧未发送档案按原迁移窗口冷核且无需永久等于旧次数',async t=>{
    const f=await fixture(t);const result=await f.run(()=>revision.loadReaderRecoveryRevision(f.plan.readerAttemptsDir,f.identity,f.options));
    const later={...result,attempts:4};delete later.unfundedTransportFailureHistory;
    repair.saveFailedCandidate(f.plan.readerAttemptsDir,f.identity,later);
    const again=await f.run(()=>revision.loadReaderRecoveryRevision(f.plan.readerAttemptsDir,f.identity,f.options));
    assert.equal(again.attempts,4);assert.equal(again.readerRecoveryRevisions.at(-1).unfundedTransportFailureHistory.length,1);
    const archived=again.readerRecoveryRevisions.at(-1).unfundedTransportFailureHistory[0];
    assert.equal(archived.selectedMigration.attempts,3);
});
