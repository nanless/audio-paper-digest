'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Config = require('../scripts/config');
const daily = require('../scripts/lib/daily-fresh-source-plan');
const sourceApi = require('../scripts/lib/fresh-arxiv-rewrite-source');
const fresh = require('../scripts/lib/fresh-analysis-context');
const deep = require('../scripts/deep-analyzer');
const review = require('../scripts/lib/daily-fact-review');
const { validAnalysisText } = require('./valid-analysis-fixture');
const ID = '2610.90031', DATE = '2026-10-11';
const quote = 'TT-MSE uses mean squared error against the frozen text teacher.';
const baseline = validAnalysisText();
const wrong = '错误余弦蒸馏损失。';
const original = baseline.replace('## 核心摘要\n', `## 核心摘要\n${wrong}`);
const sourceText = quote + '\nExperiment results on the public test set report baseline WER 12.4% and our method WER 9.8%.\n' + 'Official methods and limitations. '.repeat(200);
function json(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); }
async function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'daily-fact-review-'));
    const previous = Object.fromEntries(['dailyFreshSourceRunsDir','deepAnalysisResult','filteredPapers','papers','analysisRepairAttemptsDir'].map(key => [key, Config.FILES[key]]));
    Config.FILES.dailyFreshSourceRunsDir = path.join(root,'runs');
    Config.FILES.deepAnalysisResult = path.join(root,'current','deep-analysis-result.json');
    Config.FILES.filteredPapers = path.join(root,'current','filtered-papers.json');
    Config.FILES.papers = path.join(root,'current','papers.json');
    Config.FILES.analysisRepairAttemptsDir = path.join(root,'repair-attempts');
    t.after(() => { Object.assign(Config.FILES, previous); fs.rmSync(root,{recursive:true,force:true}); });
    const papers = [{arxivId:ID,title:'Synthetic fact feedback fixture'},{arxivId:'2610.90032',title:'Unrelated paper'}];
    const plan = daily.createDailyFreshSourcePlan({batchDate:DATE,batchId:'fact-review',papers});
    await daily.captureDailyFreshSources(plan,{concurrency:1,capture: options => sourceApi.captureFreshArxivRewriteSource(options,{
        fetchText: async id => { const artifacts={version:1,source:'html',flattenedTextSha256:review.sha(sourceText),tables:[],formulas:[],figures:[]};artifacts.payloadSha256=review.sha(JSON.stringify(artifacts));return {text:sourceText,source:'html',sourceId:id,url:`https://arxiv.org/html/${id}`,fetchedAt:'2026-10-11T00:00:00.000Z',imageInfos:[],structuredArtifacts:artifacts,readerAuthors:{authors:[]},htmlAvailability:'available',htmlAttempts:1,warnings:[]}; },
        fetchPdf: async id => ({bytes:Buffer.from(`%PDF-1.7\n${id}\n%%EOF\n`),url:`https://arxiv.org/pdf/${id}`,fetchedAt:'2026-10-11T00:00:01.000Z'})
    })});
    const paper={...papers[0],analysisCheckpoint:original,analysisStageCheckpoints:{primaryAnalysis:original,tagSelection:original,coreSummaryRepair:original,scoringAudit:original},analysisManifest:{version:1,stages:{primaryAnalysis:{status:'complete',fingerprint:'paid-primary'},coreSummaryRepair:{status:'not_needed',fingerprint:'old-core'},scoringAudit:{status:'complete',fingerprint:'old-scoring'},apiReaderArticle:{status:'complete',fingerprint:'old-reader'}},contracts:{}}};
    const details=daily.readDailyFreshSource(plan,paper);
    paper.sourceSha256=details.freshSourceDescriptor.sourceSha256;
    paper.analysisManifest.sourceAcquisition={sourceSha256:paper.sourceSha256};
    daily.withDailyFreshAnalysisContext(plan,()=>fresh.attachFreshSourceRecord(paper,paper.analysisManifest,details));
    assert.equal(daily.isPaperBoundToPlan(paper,plan),true);
    const directory=path.join(plan.sourcesDir,ID,'generation-000001');
    const feedback={contract:review.CONTRACT,paperId:ID,batchDate:DATE,runId:plan.runId,sourceFiles:Object.fromEntries(['source.txt','source.pdf','source-runtime.json','source-manifest.json'].map(name=>[name,review.sha(fs.readFileSync(path.join(directory,name)))])),coreAnalysisSha256:review.sha(original),coreSummarySha256:review.sha(deep.extractSectionByTitle(original,'核心摘要')),coreFeedback:'将错误余弦蒸馏解释改成原文的文本教师MSE；只改核心摘要。',readerFeedback:'修复GLAP从零训练无据、AT各metric并非全低以及29→29.9方向错误。',rejectedCoreClaims:[wrong],rejectedReaderClaims:['GLAP从零训练','29.0% 降到 29.9%'],sourceQuotes:[quote]};
    const feedbackFile=path.join(root,'feedback.json');json(feedbackFile,feedback);
    const payload={batchDate:DATE,batchId:plan.batchId,status:'failed',dailyFreshSourceRun:daily.dailyFreshSourceReference(plan),papers:[paper,papers[1]]};
    json(Config.FILES.deepAnalysisResult,payload);json(Config.FILES.filteredPapers,{batchDate:DATE,batchId:plan.batchId,status:'complete',papers});json(Config.FILES.papers,{generation:0,papers:{}});
    return {root,plan,paper,feedback,feedbackFile,directory,payload};
}

test('只读反馈严格绑定日期run四份来源及当前core；坏绑定不发请求、不写正式文件',async t=>{
    const f=await fixture(t);const entry=require('../scripts/deep-analysis-only');
    const before=fs.readFileSync(Config.FILES.deepAnalysisResult);
    let calls=0;
    for(const change of [{runId:'11111111-1111-4111-8111-111111111111'},{batchDate:'2026-10-10'},{paperId:'2610.90032'},{coreAnalysisSha256:'a'.repeat(64)},{coreSummarySha256:'b'.repeat(64)},{sourceFiles:{...f.feedback.sourceFiles,'source.pdf':'c'.repeat(64)}},{sourceQuotes:['invented evidence']}]){
        json(f.feedbackFile,{...f.feedback,...change});
        await assert.rejects(entry.runDeepAnalysis({date:DATE,id:ID,coreFeedbackFile:f.feedbackFile,analyzeFn:async()=>{calls++;}}),/事实反馈绑定/);
        assert.ok(before.equals(fs.readFileSync(Config.FILES.deepAnalysisResult)));
    }
    assert.equal(calls,0);
    json(f.feedbackFile,f.feedback);
    fs.appendFileSync(path.join(f.directory,'source.pdf'),'tamper');
    await assert.rejects(entry.runDeepAnalysis({date:DATE,id:ID,coreFeedbackFile:f.feedbackFile,analyzeFn:async()=>{calls++;}}),/来源/);
    assert.equal(calls,0);assert.ok(before.equals(fs.readFileSync(Config.FILES.deepAnalysisResult)));
});

test('反馈不可用临时论文假字段；core新指纹正常失效保留原付费stage和SHA快照',async t=>{
    const f=await fixture(t);const bound=review.validateFeedback(f.feedback,f.plan,f.paper);
    assert.throws(()=>review.withFactReview({feedback:f.feedback,proof:review.proofFor(f.feedback)},()=>{}),/尚未/);
    const oldFields=review.fingerprintFields('coreSummaryRepair',{});assert.deepEqual(oldFields,{});
    await review.withFactReview(bound,async()=>{
        deep.captureStaleAnalysisSnapshot(f.paper,f.paper.analysisManifest,'coreSummaryRepair',bound.proof.feedbackSha256);
        const before=JSON.stringify(f.paper.analysisManifest.stages.primaryAnalysis);
        const prepared=deep.prepareTextRecoveryStage(f.paper,f.paper.analysisManifest,'coreSummaryRepair',original,sourceText);
        assert.equal(prepared.invalidated,true);
        assert.equal(f.paper.analysisManifest.stages.coreSummaryRepair,undefined);
        assert.equal(f.paper.analysisManifest.stages.scoringAudit,undefined);
        assert.equal(JSON.stringify(f.paper.analysisManifest.stages.primaryAnalysis),before);
        assert.equal(f.paper.analysisStageCheckpoints.primaryAnalysis,original);
        assert.ok(f.paper.analysisStaleSnapshots.some(snapshot=>deep.validateStaleAnalysisSnapshot(snapshot)?.analysisCheckpoint===original));
        const fields=review.fingerprintFields('coreSummaryRepair');assert.deepEqual(fields.factReview,bound.proof);
        assert.notEqual(prepared.fingerprint,'old-core');
        assert.throws(()=>review.validateRepairedClaims('apiReaderArticle','GLAP从零训练',ID),/仍包含/);
    });
    assert.deepEqual(review.fingerprintFields('coreSummaryRepair',{factReview:bound.proof}).factReview,bound.proof,'无反馈续跑保留真实已执行配方');
    assert.deepEqual(review.fingerprintFields('primaryAnalysis',{factReview:bound.proof}).factReview,bound.proof);
});

test('事实反馈强制正常core模型修复，保护其他章节，模型复述错误或抛错不会冒成功',async t=>{
    const f=await fixture(t);const bound=review.validateFeedback(f.feedback,f.plan,f.paper);
    await review.withFactReview(bound,async()=>{
        let calls=0;
        const result=await deep.repairCoreSummarySection(f.paper,original,sourceText,sourceText,{reviewFeedback:review.reviewFeedback('coreSummaryRepair',ID),callModelFn:async messages=>{
            calls++;assert.ok(JSON.stringify(messages).includes(quote));
            return `## 核心摘要\n${deep.extractSectionByTitle(baseline,'核心摘要')}`;
        }});
        assert.equal(calls,1);assert.equal(result,baseline);
        assert.equal(result.replace(deep.extractSectionByTitle(result,'核心摘要'),''),original.replace(deep.extractSectionByTitle(original,'核心摘要'),''));
        calls=0;
        await assert.rejects(deep.repairCoreSummarySection(f.paper,original,sourceText,sourceText,{reviewFeedback:review.reviewFeedback('coreSummaryRepair',ID),callModelFn:async()=>{calls++;return `## 核心摘要\n${deep.extractSectionByTitle(original,'核心摘要')}`;}}),/仍包含/);
        assert.equal(calls,3);
        await assert.rejects(deep.repairCoreSummarySection(f.paper,original,sourceText,sourceText,{reviewFeedback:review.reviewFeedback('coreSummaryRepair',ID),callModelFn:async()=>{throw new Error('synthetic request failure');}}),/synthetic request failure/);
        assert.equal(f.paper.analysisCheckpoint,original);
    });
    await assert.rejects(deep.repairCoreSummarySection(f.paper,baseline,sourceText,sourceText,{reviewFeedback:'未绑定事实反馈',callModelFn:async()=>{assert.fail('不得请求');}}),/尚未绑定/);
});

test('单ID正常deep路由完整源计划，锁内重读后才传反馈；无关论文保持原字节',async t=>{
    const f=await fixture(t);const entry=require('../scripts/deep-analysis-only');
    const unrelated=JSON.stringify(f.payload.papers[1]);let calls=0;
    await entry.runDeepAnalysis({date:DATE,id:ID,coreFeedbackFile:f.feedbackFile,analyzeFn:async paper=>{
        calls++;assert.equal(paper.arxivId,ID);assert.ok(review.current(ID));assert.equal(review.current('2610.90032'),null);
        assert.equal(paper.coreFeedback,undefined);assert.equal(paper.reviewFeedback,undefined);
        assert.ok(review.reviewFeedback('apiReaderArticle',ID).includes('29→29.9'));
        throw Object.assign(new Error('synthetic stopped after routing'), {retryable:false});
    }});
    assert.equal(calls,1);
    const saved=JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult));
    assert.equal(JSON.stringify(saved.papers.find(p=>p.arxivId==='2610.90032')),unrelated);
    assert.equal(saved.papers.length,2);
});

test('CLI拒绝重复/未知参数与无明确日期或ID的反馈',()=>{
    const entry=require('../scripts/deep-analysis-only');
    assert.deepEqual(entry.parseDeepCliArgs(['--date',DATE,'--id',ID,'--core-feedback-file','/tmp/review.json']),{date:DATE,id:ID,coreFeedbackFile:'/tmp/review.json'});
    for(const args of [['--date',DATE,'--date',DATE],['--unknown','x'],['--core-feedback-file','x'],['--id',ID,'--core-feedback-file','x'],['--date',DATE,'--id','2610.90031v1']]) assert.throws(()=>entry.parseDeepCliArgs(args));
});


test('相同反馈失败或完成后凭真实原输入快照续跑，篡改快照不能借receipt绕过当前core绑定',async t=>{
    const f=await fixture(t);const bound=review.validateFeedback(f.feedback,f.plan,f.paper);
    review.withFactReview(bound,()=>deep.captureStaleAnalysisSnapshot(f.paper,f.paper.analysisManifest,'coreSummaryRepair',bound.proof.feedbackSha256));
    f.paper.analysisCheckpoint=baseline;f.paper.analysisManifest.stages.coreSummaryRepair={status:'transient_failure',factReview:bound.proof};
    assert.ok(review.validateFeedback(f.feedback,f.plan,f.paper));
    f.paper.analysisStaleSnapshots[0].payload.analysisCheckpoint+='tamper';
    assert.throws(()=>review.validateFeedback(f.feedback,f.plan,f.paper),/当前核心摘要正文绑定/);
});

test('Reader单独反馈不强制core再付费，不影响其他stage配方',async t=>{
    const f=await fixture(t);f.feedback.coreFeedback='';f.feedback.rejectedCoreClaims=[];
    const bound=review.validateFeedback(f.feedback,f.plan,f.paper);
    review.withFactReview(bound,()=>{
        assert.deepEqual(review.fingerprintFields('coreSummaryRepair',{}),{});
        assert.equal(review.reviewFeedback('coreSummaryRepair',ID),'');
        assert.deepEqual(review.fingerprintFields('primaryAnalysis',{}),{});
        assert.deepEqual(review.fingerprintFields('apiReaderArticle',{}).factReview,bound.proof);
    });
});

test('有反馈的新已执行证明可在无外部文件时复用，无反馈请求不混入证明',async t=>{
    const registry=require('../scripts/lib/prompt-text-versions');
    const contract=registry.currentPromptTextContract('coreSummaryRepair');
    const oldCore=deep.buildTextStageFingerprint('coreSummaryRepair',original,sourceText,contract,{});
    const oldReader=deep.buildApiReaderExecutionFingerprint('configuration',sourceText,{},null,{});
    const f=await fixture(t);const bound=review.validateFeedback(f.feedback,f.plan,f.paper);let coreFingerprint,readerFingerprint;
    review.withFactReview(bound,()=>{
        coreFingerprint=deep.buildTextStageFingerprint('coreSummaryRepair',original,sourceText,contract,{});
        readerFingerprint=deep.buildApiReaderExecutionFingerprint('configuration',sourceText,{},null,{});
        assert.notEqual(readerFingerprint,oldReader);
        assert.notEqual(coreFingerprint,oldCore);
    });
    assert.equal(deep.buildTextStageFingerprint('coreSummaryRepair',original,sourceText,contract,{}),oldCore);
    assert.equal(deep.buildApiReaderExecutionFingerprint('configuration',sourceText,{},null,{}),oldReader);
    assert.equal(deep.buildTextStageFingerprint('coreSummaryRepair',original,sourceText,contract,{factReview:bound.proof}),coreFingerprint);
    assert.equal(deep.buildApiReaderExecutionFingerprint('configuration',sourceText,{},null,{factReview:bound.proof}),readerFingerprint);
    assert.throws(()=>deep.buildApiReaderExecutionFingerprint('configuration',sourceText,{},null,{factReview:{...bound.proof,sourceFiles:{}}}),/保存的反馈证明/);
});

test('锁内重读看见core改变时阻断，不能用预检的旧对象发模型请求',async t=>{
    const f=await fixture(t);const entry=require('../scripts/deep-analysis-only');let calls=0;
    await assert.rejects(entry.runDeepAnalysis({date:DATE,id:ID,coreFeedbackFile:f.feedbackFile,analyzeFn:async()=>{calls++;},analyzeBatch:async(papers,options)=>{
        const changed=JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult));changed.papers[0].analysisCheckpoint+='concurrent change';json(Config.FILES.deepAnalysisResult,changed);
        options.preparePaperLocked(papers[0]);
        assert.fail('过期反馈不可继续');
    }}),/当前核心摘要正文绑定/);
    assert.equal(calls,0);
});


test('有效旧成功Reader在早期迁移中不能改签外部事实反馈；必须失效并调用正常Reader生成',async t=>{
    const f=await fixture(t);f.feedback.coreFeedback='';f.feedback.rejectedCoreClaims=[];
    const bound=review.validateFeedback(f.feedback,f.plan,f.paper);
    const engine=require('../scripts/analysis-engine');
    const legacy=require('./valid-analysis-fixture').validLegacyApiAnalysisPaper(ID);
    assert.equal(engine.hasValidApiReaderV3Records(legacy),true);
    const artifacts={tables:[],formulas:[],figures:[]};
    const evidence=deep.buildApiReaderEvidenceContext(legacy.analysis,sourceText,artifacts,ID);
    const legacyFingerprint=deep.buildLegacyAnalysisBoundApiReaderFingerprint(
        deep.buildLegacyApiReaderV3ConfigurationFingerprint(ID),legacy.analysis,evidence,artifacts);
    const base=deep.buildRecoveryFingerprints(legacy,sourceText,ID,legacy.analysisManifest).apiReaderArticle;
    legacy.analysisManifest.stages.apiReaderArticle.fingerprint=legacyFingerprint;
    const normal=structuredClone(legacy);
    assert.equal(deep.migrateSealedSourceOnlyReaderBeforeAnalysis(normal,normal.analysisManifest,base,sourceText,artifacts,ID),true,'真正有效的旧Reader无反馈时原迁移仍正常');
    const before=JSON.stringify(legacy);let requests=0;
    await review.withFactReview(bound,async()=>{
        assert.equal(deep.migrateSealedSourceOnlyReaderBeforeAnalysis(legacy,legacy.analysisManifest,base,sourceText,artifacts,ID),false);
        assert.equal(JSON.stringify(legacy),before,'不把旧成功正文改签为已执行反馈');
        const fingerprint=deep.buildApiReaderExecutionFingerprint(base,evidence,artifacts,null,legacy.analysisManifest.stages.apiReaderArticle);
        assert.equal(deep.invalidateRecoveryStageIfChanged(legacy,legacy.analysisManifest,'apiReaderArticle',fingerprint),true);
        assert.equal(legacy.analysisManifest.stages.apiReaderArticle,undefined);
        const attempts=path.join(f.root,'reader-captured');
        await assert.rejects(deep.generateApiReaderArticleDetailed(legacy,legacy.analysis,evidence,{sourceText,structuredArtifacts:artifacts,reviewFeedback:review.reviewFeedback('apiReaderArticle',ID),readerAttemptsDir:attempts,readerMaxAttempts:1,readerMaterializeFigures:async()=>[],readerRecordDisposition:()=>{},readerCallModel:async messages=>{
            requests++;assert.ok(JSON.stringify(messages).includes('29→29.9'));throw new Error('controlled regular Reader request reached');
        }}),/controlled regular Reader request reached/);
        assert.equal(requests,1);
    });
    const saved=structuredClone(normal);saved.analysisManifest.stages.apiReaderArticle.factReview=bound.proof;
    const savedBefore=JSON.stringify(saved);
    assert.equal(deep.migrateSealedSourceOnlyReaderBeforeAnalysis(saved,saved.analysisManifest,base,sourceText,artifacts,ID),false);
    assert.equal(JSON.stringify(saved),savedBefore);
});

test('可选标签反馈绑定现有来源并独立触发标签修复，原核心和Reader配方不混入', async t => {
    const data = await fixture(t);
    data.feedback.coreFeedback = '';
    data.feedback.readerFeedback = '';
    data.feedback.rejectedCoreClaims = [];
    data.feedback.rejectedReaderClaims = [];
    data.feedback.tagFeedback = '按原文纠正标签，不能因为目录有子任务强制改变研究任务。';
    data.feedback.rejectedTagClaims = ['#语音识别'];
    const bound = review.validateFeedback(data.feedback, data.plan, data.paper);
    await review.withFactReview(bound, async () => {
        assert.deepEqual(review.fingerprintFields('coreSummaryRepair', {}), {});
        assert.deepEqual(review.fingerprintFields('apiReaderArticle', {}), {});
        assert.deepEqual(review.fingerprintFields('tagSelection', {}).factReview, bound.proof);
        assert.match(review.reviewFeedback('tagSelection', ID), /目录有子任务/);
        let calls = 0;
        const repaired = await deep.repairTagSelection(data.paper, original, sourceText,
            review.reviewFeedback('tagSelection', ID), { callModelFn: async messages => {
                calls++;
                assert.match(JSON.stringify(messages), /目录有子任务/);
                return JSON.stringify({ primaryTaskId: 'task.audio-classification', primaryMethodId: 'method.cnn', conceptIds: ['task.audio-classification', 'method.cnn', 'setting.low-resource'] });
            }});
        assert.equal(calls, 1);
        assert.equal(deep.maskClassificationFields(repaired), deep.maskClassificationFields(original));
        assert.throws(() => review.validateRepairedClaims('tagSelection', '#语音识别', ID), /仍包含/);
    });
    assert.throws(() => review.validateShape({ ...data.feedback, tagFeedback: 5 }), /tagFeedback/);
    const missingClaims = { ...data.feedback }; delete missingClaims.rejectedTagClaims;
    assert.throws(() => review.validateShape(missingClaims), /同时声明/);
});


test('主分析反馈独立绑定配方，正常失效全下游且完整保留付费正文，坏字段和残留claim拒绝',async t=>{
 const f=await fixture(t);
 f.feedback.coreFeedback='';f.feedback.readerFeedback='';f.feedback.rejectedCoreClaims=[];f.feedback.rejectedReaderClaims=[];
 f.feedback.primaryFeedback='根据逐字来源重新生成全部13节，纠正实验节中错误的余弦损失解释。';
 f.feedback.rejectedPrimaryClaims=[wrong];
 const bound=review.validateFeedback(f.feedback,f.plan,f.paper);
 const contract=require('../scripts/lib/prompt-text-versions').currentPromptTextContract('primaryAnalysis');
 const old=deep.buildPrimaryAnalysisBaseFingerprint(contract,f.paper,sourceText,ID,f.paper.analysisManifest.stages.primaryAnalysis);
 const oldBytes=JSON.stringify(f.paper.analysisManifest.stages);
 let updated;
 review.withFactReview(bound,()=>{
  updated=deep.buildPrimaryAnalysisBaseFingerprint(contract,f.paper,sourceText,ID,f.paper.analysisManifest.stages.primaryAnalysis);
  assert.notEqual(updated,old);
  assert.deepEqual(review.fingerprintFields('coreSummaryRepair',{}),{});
  assert.deepEqual(review.fingerprintFields('apiReaderArticle',{}).factReview,bound.proof);
  assert.match(review.reviewFeedback('apiReaderArticle',ID),/重新生成全部13节/);
  assert.match(review.reviewFeedback('primaryAnalysis',ID),/重新生成全部13节/);
  assert.match(review.reviewFeedback('primaryAnalysis',ID),/TT-MSE uses/);
  assert.throws(()=>review.validateRepairedClaims('primaryAnalysis',original,ID),/仍包含/);
  review.validateRepairedClaims('primaryAnalysis',baseline,ID);
  assert.equal(deep.invalidateRecoveryStageIfChanged(f.paper,f.paper.analysisManifest,'primaryAnalysis',updated),true);
  for(const stage of ['primaryAnalysis','coreSummaryRepair','scoringAudit'])assert.equal(f.paper.analysisManifest.stages[stage],undefined);
  assert.equal(f.paper.analysisCheckpoint,undefined);
  const readerFp=deep.buildApiReaderExecutionFingerprint('configuration',sourceText,{},null,f.paper.analysisManifest.stages.apiReaderArticle);
  assert.equal(deep.invalidateRecoveryStageIfChanged(f.paper,f.paper.analysisManifest,'apiReaderArticle',readerFp),true);
  assert.equal(f.paper.analysisManifest.stages.apiReaderArticle,undefined);
  const paid=f.paper.analysisStaleSnapshots.map(deep.validateStaleAnalysisSnapshot).find(x=>x?.analysisCheckpoint===original);
  assert.ok(paid);assert.equal(JSON.stringify(paid.stages),oldBytes);
 });
 assert.equal(deep.buildPrimaryAnalysisBaseFingerprint(contract,{title:f.paper.title,analysisStageCheckpoints:{primaryAnalysis:original}},sourceText,ID,{status:'complete',fingerprint:'paid-primary'}),old);
 const saved={status:'complete',factReview:bound.proof};
 assert.deepEqual(review.fingerprintFields('primaryAnalysis',saved).factReview,bound.proof);
 const bad={...f.feedback};delete bad.rejectedPrimaryClaims;assert.throws(()=>review.validateShape(bad),/同时声明/);
 assert.throws(()=>review.validateShape({...f.feedback,primaryFeedback:4}),/primaryFeedback/);
 assert.throws(()=>review.validateShape({...f.feedback,rejectedPrimaryClaims:[]}),/rejectedPrimaryClaims/);
 assert.throws(()=>review.validateShape({...f.feedback,sourceQuotes:['x'.repeat(3000)],primaryFeedback:'x'.repeat(1200)}),/超过4000/);
});


test('正常封存来源主分析真实HTTP请求带绑定纠错，旧成功checkpoint不可复用，失败保留原付费档',async t=>{
 const http=require('node:http'),cp=require('node:child_process');const bodies=[];
 const server=http.createServer((req,res)=>{let input='';req.on('data',c=>input+=c);req.on('end',()=>{bodies.push(JSON.parse(input));res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:original},finish_reason:'stop'}]}));});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const folder=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'primary-fact-http-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 for(const dir of ['scripts','manual','prompts','config','tests'])fs.cpSync(path.resolve(__dirname,'..',dir),path.join(folder,dir),{recursive:true});
 fs.symlinkSync(path.resolve(__dirname,'../node_modules'),path.join(folder,'node_modules'),'dir');
 fs.writeFileSync(path.join(folder,'.env'),`PAPER_ANALYZER_API_KEY=synthetic-local-only\nPAPER_ANALYZER_MODEL=ci-test-model\nPAPER_ANALYZER_ENDPOINT=http://127.0.0.1:${server.address().port}/v1\n`,{mode:0o600});
 const prefix=fs.readFileSync(__filename,'utf8').split("test('只读反馈严格绑定")[0].replace("imageInfos:[],structuredArtifacts:artifacts", "imageInfos:[{url:'https://example.invalid/synthetic-test.png'}],structuredArtifacts:artifacts");
 const program=prefix+`
(async()=>{const f=await fixture({after:()=>{}});Object.assign(f.paper.analysisManifest.sourceAcquisition,{usedTextSha256:review.sha(sourceText),sourceId:ID,analysisSource:'html'});f.feedback.coreFeedback='';f.feedback.readerFeedback='';f.feedback.rejectedCoreClaims=[];f.feedback.rejectedReaderClaims=[];f.feedback.primaryFeedback='旧一轮主分析事实反馈。';f.feedback.rejectedPrimaryClaims=[wrong];const oldBound=review.validateFeedback(f.feedback,f.plan,f.paper);f.paper.analysisManifest.stages.primaryAnalysis.factReview=oldBound.proof;review.withFactReview(oldBound,()=>deep.captureStaleAnalysisSnapshot(f.paper,f.paper.analysisManifest,'primaryAnalysis',oldBound.proof.feedbackSha256));f.feedback.primaryFeedback='主分析重生成全部13节：蒸馏使用MSE，实验中的旧余弦说明必须纠正。';f.feedback.rejectedPrimaryClaims=[wrong];const bound=review.validateFeedback(f.feedback,f.plan,f.paper);const result=await daily.withDailyFreshAnalysisContext(f.plan,()=>daily.createDailyAnalyzeFn(f.plan,{analyze:paper=>review.withFactReview(bound,()=>deep.analyzePaperDeep(paper))})(f.paper));assert.equal(result.analysis,null);assert.match(result.error,/仍包含/);assert.equal(result.analysisManifest.stages.primaryAnalysis.status,'transient_failure');assert.deepEqual(result.analysisManifest.stages.primaryAnalysis.factReview,bound.proof);assert.ok(result.analysisStaleSnapshots.some(x=>deep.validateStaleAnalysisSnapshot(x)?.analysisCheckpoint===original));assert.ok(review.validateFeedback(f.feedback,f.plan,result));const noFeedback=structuredClone(result);await assert.rejects(daily.withDailyFreshAnalysisContext(f.plan,()=>daily.createDailyAnalyzeFn(f.plan)(noFeedback)),/须重新提供同一份受控反馈/);console.log('NORMAL_PRIMARY_HTTP_NEGATIVE_CONFIRMED');fs.rmSync(f.root,{recursive:true,force:true});})().catch(e=>{console.error(e);process.exitCode=1;});`;
 fs.writeFileSync(path.join(folder,'tests/primary-fact-http-child.cjs'),program);
 const result=await new Promise(resolve=>{const child=cp.spawn(process.execPath,['tests/primary-fact-http-child.cjs'],{cwd:folder});let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.on('close',status=>resolve({status,stdout,stderr}));});
 assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/NORMAL_PRIMARY_HTTP_NEGATIVE_CONFIRMED/);
 assert.equal(bodies.length,1,'旧primary必须正常请求一次，而非旧成功补签或先请求其他阶段');
 const content=JSON.stringify(bodies[0].messages);assert.match(content,/主分析重生成全部13节/);assert.ok(content.includes(quote));
});


test('纠错主分析完成而评分缺失时正常入口两次无反馈恢复在任何模型请求前阻断且保留证明', async t => {
    const http = require('node:http'), cp = require('node:child_process');
    let calls = 0;
    const server = http.createServer((req, res) => {
        calls++;
        req.resume();
        res.writeHead(500);
        res.end('unexpected model request');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const folder = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'scoring-resume-http-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    for (const dir of ['scripts', 'manual', 'prompts', 'config', 'tests']) {
        fs.cpSync(path.resolve(__dirname, '..', dir), path.join(folder, dir), { recursive: true });
    }
    fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(folder, 'node_modules'), 'dir');
    fs.writeFileSync(path.join(folder, '.env'), `PAPER_ANALYZER_API_KEY=synthetic-local-only\nPAPER_ANALYZER_MODEL=ci-test-model\nPAPER_ANALYZER_ENDPOINT=http://127.0.0.1:${server.address().port}/v1\n`, { mode: 0o600 });
    const prefix = fs.readFileSync(__filename, 'utf8').split("test('只读反馈严格绑定")[0];
    const program = prefix + `
(async () => {
    const f = await fixture({ after: () => {} });
    try {
        f.feedback.coreFeedback = '';
        f.feedback.readerFeedback = '';
        f.feedback.rejectedCoreClaims = [];
        f.feedback.rejectedReaderClaims = [];
        f.feedback.primaryFeedback = '主分析纠正蒸馏事实，评分理由不得重新引入错误余弦损失。';
        f.feedback.rejectedPrimaryClaims = [wrong];
        const bound = review.validateFeedback(f.feedback, f.plan, f.paper);
        review.withFactReview(bound, () => deep.captureStaleAnalysisSnapshot(f.paper, f.paper.analysisManifest, 'primaryAnalysis', bound.proof.feedbackSha256));
        f.paper.analysisCheckpoint = baseline;
        f.paper.analysisStageCheckpoints.primaryAnalysis = baseline;
        const primary = f.paper.analysisManifest.stages.primaryAnalysis;
        primary.factReview = bound.proof;
        primary.promptTextContract = require('../scripts/lib/prompt-text-versions').currentPromptTextContract('primaryAnalysis');
        primary.fingerprint = deep.buildPrimaryAnalysisBaseFingerprint(primary.promptTextContract, f.paper, sourceText, ID, primary);
        delete f.paper.analysisManifest.stages.scoringAudit;
        delete f.paper.analysisStageCheckpoints.scoringAudit;
        const beforePrimary = JSON.stringify(primary);
        const beforeSnapshots = JSON.stringify(f.paper.analysisStaleSnapshots);
        const beforeOfficial = fs.readFileSync(Config.FILES.deepAnalysisResult);
        for (let attempt = 0; attempt < 2; attempt++) {
            await assert.rejects(daily.withDailyFreshAnalysisContext(f.plan, () => daily.createDailyAnalyzeFn(f.plan)(f.paper)), /评分纠错的新请求缺少对应的已绑定主分析反馈/);
            assert.equal(JSON.stringify(f.paper.analysisManifest.stages.primaryAnalysis), beforePrimary);
            assert.equal(JSON.stringify(f.paper.analysisStaleSnapshots), beforeSnapshots);
            assert.equal(f.paper.analysisStageCheckpoints.primaryAnalysis, baseline);
            assert.equal(f.paper.analysisManifest.stages.scoringAudit, undefined);
            assert.ok(beforeOfficial.equals(fs.readFileSync(Config.FILES.deepAnalysisResult)));
        }
        console.log('NORMAL_SCORING_RESUME_ZERO_REQUEST_PROOF_RETAINED');
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });`;
    fs.writeFileSync(path.join(folder, 'tests/scoring-resume-child.cjs'), program);
    const result = await new Promise(resolve => {
        const child = cp.spawn(process.execPath, ['tests/scoring-resume-child.cjs'], { cwd: folder });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('close', status => resolve({ status, stdout, stderr }));
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /NORMAL_SCORING_RESUME_ZERO_REQUEST_PROOF_RETAINED/);
    assert.equal(calls, 0, '正常入口两次恢复均不得发出任何模型请求');
});
