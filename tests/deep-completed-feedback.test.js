process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Config = require('../scripts/config');
const daily = require('../scripts/lib/daily-fresh-source-plan');
const fresh = require('../scripts/lib/fresh-analysis-context');
const sourceApi = require('../scripts/lib/fresh-arxiv-rewrite-source');
const facts = require('../scripts/lib/daily-fact-review');
const deep = require('../scripts/deep-analyzer');
const engine = require('../scripts/analysis-engine');
const { validAnalysisPaper } = require('./valid-analysis-fixture');

const failure = '局部事实纠错没有当前错误原句，也没有同反馈已完成证明；不能扩大为完整主文请求';

async function createReviewedReaderSample(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reviewed-reader-seed-'));
    const previous = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs');
    t.after(() => {
        Config.FILES.dailyFreshSourceRunsDir = previous;
        fs.rmSync(root, { recursive: true, force: true });
    });
    const signed = require('./reader-signed-draft-fixture').fixture({ noFigures: true });
    const id = signed.paper.arxivId.replace(/v\d+$/, '');
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-11', batchId: 'reader-seed',
        papers: [{ arxivId: signed.paper.arxivId, title: '正文已纠正的修订参考', authors: signed.paper.authors }] });
    await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: options =>
        sourceApi.captureFreshArxivRewriteSource(options, {
            fetchText: async sourceId => ({ ...signed.sourceDetails, source: 'html',
                htmlAvailability: 'available', htmlAttempts: 1, warnings: [], sourceId,
                url: `https://arxiv.org/html/${sourceId}`, fetchedAt: '2026-10-11T00:00:00.000Z' }),
            fetchPdf: async sourceId => ({ bytes: Buffer.from('%PDF-1.7\n%%EOF\n'),
                url: `https://arxiv.org/pdf/${sourceId}`, fetchedAt: '2026-10-11T00:00:00.000Z' })
        }) });
    const paper = { ...validAnalysisPaper(signed.paper.arxivId), ...signed.paper };
    const validManifest = validAnalysisPaper(signed.paper.arxivId).analysisManifest;
    paper.analysisManifest.version = validManifest.version;
    paper.analysisManifest.contracts = { ...validManifest.contracts, ...paper.analysisManifest.contracts };
    paper.analysisManifest.stages = { ...validManifest.stages, ...paper.analysisManifest.stages };
    paper.analysisManifest.stages.scoringAudit.scoringContract = 'api-scoring-audit-v2';
    paper.analysisManifest.stages.scoringAudit.audit = {};
    paper.analysisManifest.stages.scoringAudit.stabilityWarning = false;
    paper.analysisManifest.stages.scoringAudit.auditSha256 = deep.stableFingerprint({});
    paper.analysisManifest.stages.scoringAudit.outputAnalysisSha256 = facts.sha(paper.analysis);
    paper.analysisManifest.stages.openSourceScan.status = 'complete';
    paper.analysisManifest.sourceAcquisition.modelTextSanitizationContract = require('../scripts/lib/model-text-sanitization').MODEL_TEXT_SANITIZATION_CONTRACT;
    paper.analysisManifest.sourceAcquisition.promptRenderingContract = require('../scripts/lib/prompt-rendering-contract').PROMPT_RENDERING_CONTRACT;
    const source = daily.readDailyFreshSource(plan, paper);
    await daily.withDailyFreshAnalysisContext(plan, () => fresh.attachFreshSourceRecord(paper, paper.analysisManifest, source));
    const folder = path.join(plan.sourcesDir, id, 'generation-000001');
    const feedback = { contract: facts.CONTRACT, paperId: id, runId: plan.runId, batchDate: plan.batchDate,
        sourceFiles: Object.fromEntries(['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json']
            .map(name => [name, facts.sha(fs.readFileSync(path.join(folder, name)))])),
        coreAnalysisSha256: facts.sha(paper.analysis), coreSummarySha256: facts.sha(deep.extractSectionByTitle(paper.analysis, '核心摘要')),
        primaryFeedback: '保留已经纠正的主文，只按原证据解释。', coreFeedback: '', readerFeedback: '只修本次明确的读者文章问题。',
        rejectedPrimaryClaims: ['原来的错误已消失'], rejectedCoreClaims: [], rejectedReaderClaims: ['已纠正的旧Reader错误'],
        sourceQuotes: [source.text.slice(0, 100)] };
    const bound = facts.validateFeedback(feedback, plan, paper);
    paper.analysisManifest.stages.apiReaderArticle.factReview = bound.proof;
    paper.analysisManifest.stages.apiReaderArticle.reviewFeedbackSha256 = facts.sha(feedback.readerFeedback.trim());
    feedback.primaryFeedback = '';
    const finalBound = facts.validateFeedback(feedback, plan, paper);
    paper.analysisManifest.stages.apiReaderArticle.factReview = finalBound.proof;
    return { paper, plan, source, feedback, bound, id };
}


const entry = require('../scripts/deep-analysis-only');
const completed = require('../scripts/lib/completed-bound-fact-feedback');
function save(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));}
test('deep 公共入口真实合格同反馈零请求，新反馈仍进入且锁内重新核验',async t=>{
 const f=await createReviewedReaderSample(t);
 const previous={deepAnalysisResult:Config.FILES.deepAnalysisResult,filteredPapers:Config.FILES.filteredPapers,papers:Config.FILES.papers};
 t.after(()=>Object.assign(Config.FILES,previous));
 Config.FILES.deepAnalysisResult=path.join(f.plan.runDir,'current/result.json');
 Config.FILES.filteredPapers=path.join(f.plan.runDir,'current/filtered.json');
 Config.FILES.papers=path.join(f.plan.runDir,'current/papers.json');
 const feedbackFile=path.join(f.plan.runDir,'feedback.json');save(feedbackFile,f.feedback);
 const payload={batchDate:f.plan.batchDate,batchId:f.plan.batchId,dailyFreshSourceRun:daily.dailyFreshSourceReference(f.plan),papers:[f.paper]};
 save(Config.FILES.deepAnalysisResult,payload);save(Config.FILES.filteredPapers,{batchDate:f.plan.batchDate,batchId:f.plan.batchId,status:'complete',papers:[{arxivId:f.paper.arxivId,title:f.paper.title}]});save(Config.FILES.papers,{generation:0,papers:{}});
 assert.equal(engine.isSuccessfulAnalysisRecord(f.paper),true);
 assert.equal(daily.isPaperReusableForAnalysis(f.paper,f.plan),true);
 assert.equal(completed.hasCompletedBoundFactFeedback(f.paper,f.feedback,f.plan),true);
 let batches=0;
 const options={date:f.plan.batchDate,id:f.id,coreFeedbackFile:feedbackFile,analyzeBatch:async()=>{batches++;throw new Error('SAME_FEEDBACK_MUST_SKIP');}};
 const result=await entry.runDeepAnalysis(options);
 assert.equal(result.status,'complete');assert.equal(batches,0);
 const feedbackBytes=fs.readFileSync(feedbackFile);const checkpoints=JSON.stringify(f.paper.analysisStageCheckpoints);
 assert.deepEqual(fs.readFileSync(feedbackFile),feedbackBytes);
 const changed={...f.feedback,readerFeedback:f.feedback.readerFeedback+'新的有证据纠错要求。'};save(feedbackFile,changed);
 await assert.rejects(entry.runDeepAnalysis({...options,analyzeBatch:async(papers,opts)=>{
  batches++;assert.equal(papers.length,1);assert.equal(opts.preparePaperLocked(papers[0]).skip,false);
  const latest=JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult));
  const bound=facts.validateFeedback(changed,f.plan,latest.papers[0]);
  latest.papers[0].analysisManifest.stages.apiReaderArticle.factReview=bound.proof;
  latest.papers[0].analysisManifest.stages.apiReaderArticle.reviewFeedbackSha256=facts.sha(changed.readerFeedback.trim());
  save(Config.FILES.deepAnalysisResult,latest);
  assert.equal(opts.preparePaperLocked(papers[0]).skip,true);
  latest.papers[0].apiReaderArticle += changed.rejectedReaderClaims[0];save(Config.FILES.deepAnalysisResult,latest);
  assert.equal(opts.preparePaperLocked(papers[0]).skip,false);
  throw new Error('NEW_FEEDBACK_REACHED_LOCKED_ENTRY');
 }}),/NEW_FEEDBACK_REACHED_LOCKED_ENTRY/);
 assert.equal(batches,1);assert.equal(JSON.stringify(f.paper.analysisStageCheckpoints),checkpoints);
});

test('正常长文入口早期事实范围拒绝保留已付阶段的真实检查点和Reader字节',async t=>{
 const f=await createReviewedReaderSample(t);
 assert.equal(engine.isSuccessfulAnalysisRecord(f.paper),true);
 assert.equal(f.paper.analysisCheckpoint,undefined);
 const feedback={...f.feedback,primaryFeedback:'原错误已修正，仅请求受控复核。'};
 const bound=facts.validateFeedback(feedback,f.plan,f.paper);
 const checkpointBytes=JSON.stringify(f.paper.analysisStageCheckpoints);
 const readerBytes=JSON.stringify(Object.fromEntries(Object.entries(f.paper).filter(([key])=>key.startsWith('apiReader'))));
 const manifestBytes=JSON.stringify(f.paper.analysisManifest);
 await assert.rejects(daily.withDailyFreshAnalysisContext(f.plan,()=>daily.withDailyFreshPaperSource(f.plan,f.paper,
  ()=>facts.withFactReview(bound,()=>deep.analyzePaperDeep(f.paper)))),/局部事实纠错没有当前错误原句/);
 assert.equal(JSON.stringify(f.paper.analysisStageCheckpoints),checkpointBytes);
 assert.equal(JSON.stringify(f.paper.analysisManifest),manifestBytes);
 assert.equal(JSON.stringify(Object.fromEntries(Object.entries(f.paper).filter(([key])=>key.startsWith('apiReader')))),readerBytes);
 assert.equal(engine.isSuccessfulAnalysisRecord(f.paper),true);
});

test('预检拒绝经正常论文锁与中央保存后仍保留原合格正文和真实检查点',async t=>{
 const f=await createReviewedReaderSample(t);
 const previous=Object.fromEntries(['deepAnalysisResult','filteredPapers','papers'].map(key=>[key,Config.FILES[key]]));
 t.after(()=>Object.assign(Config.FILES,previous));
 for(const key of Object.keys(previous))Config.FILES[key]=path.join(f.plan.runDir,'current',key+'.json');
 const feedback={...f.feedback,primaryFeedback:'仅复核原已纠正错误，不允许全文重生。'};
 const feedbackFile=path.join(f.plan.runDir,'early-failure-feedback.json');save(feedbackFile,feedback);
 save(Config.FILES.deepAnalysisResult,{batchDate:f.plan.batchDate,batchId:f.plan.batchId,dailyFreshSourceRun:daily.dailyFreshSourceReference(f.plan),papers:[f.paper]});
 save(Config.FILES.filteredPapers,{batchDate:f.plan.batchDate,batchId:f.plan.batchId,status:'complete',papers:[{arxivId:f.paper.arxivId,title:f.paper.title}]});save(Config.FILES.papers,{generation:0,papers:{}});
 const checkpoints=JSON.stringify(f.paper.analysisStageCheckpoints),reader=f.paper.apiReaderArticle,body=f.paper.analysis;
 const result=await entry.runDeepAnalysis({date:f.plan.batchDate,id:f.id,coreFeedbackFile:feedbackFile});
 assert.equal(result.stats.failed,1);
 const stored=JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult)).papers[0];
 assert.match(stored.latestAnalysisAttemptError,/局部事实纠错没有当前错误原句/);
 assert.equal(stored.analysis,body);assert.equal(stored.apiReaderArticle,reader);
 assert.equal(JSON.stringify(stored.analysisStageCheckpoints),checkpoints);
 assert.equal(engine.isSuccessfulAnalysisRecord(stored),false);
});

test('deep 最后一篇真实合格结果保存后传播停止，不进入后续生成发布流程', async t => {
    const f = await createReviewedReaderSample(t);
    const previous = Object.fromEntries(['deepAnalysisResult', 'filteredPapers', 'papers'].map(key => [key, Config.FILES[key]]));
    t.after(() => Object.assign(Config.FILES, previous));
    for (const key of Object.keys(previous)) Config.FILES[key] = path.join(f.plan.runDir, 'stop-current', key + '.json');
    f.paper.latestAnalysisAttemptError = '测试所需的上一轮中断';
    const feedbackFile = path.join(f.plan.runDir, 'stop-feedback.json'); save(feedbackFile, f.feedback);
    save(Config.FILES.deepAnalysisResult, { batchDate: f.plan.batchDate, batchId: f.plan.batchId,
        dailyFreshSourceRun: daily.dailyFreshSourceReference(f.plan), papers: [f.paper] });
    save(Config.FILES.filteredPapers, { batchDate: f.plan.batchDate, batchId: f.plan.batchId, status: 'complete',
        papers: [{ arxivId: f.paper.arxivId, title: f.paper.title }] });
    save(Config.FILES.papers, { generation: 0, papers: {} });
    const stop = require('../scripts/lib/analysis-stop-control');
    const utils = require('../scripts/utils');
    let requests = 0, following = 0;
    await assert.rejects(entry.runDeepAnalysis({ date: f.plan.batchDate, id: f.id, coreFeedbackFile: feedbackFile,
        analyzeFn: async paper => {
            const endpoint = 'http://127.0.0.1:9/v1', model = 'ci-test-model';
            await utils.requestLlmJson(utils.buildApiUrl(utils.detectApiType(endpoint, model), endpoint), endpoint, model,
                { model, max_tokens: 16, messages: [{ role: 'user', content: '本地最后响应测试' }] }, {},
                { recordUsage: false, timeoutMs: 1000, transportRequestFn: async () => {
                    requests++; stop.requestAnalysisStop();
                    return { statusCode: 200, body: { choices: [{ message: { content: '本地返回结果' } }] } };
                } });
            const result = { ...paper };
            for (const key of Object.keys(result)) if (key.startsWith('latestAnalysisAttempt')) delete result[key];
            return result;
        }
    }).then(() => { following++; }), error => error.code === stop.CODE && error.stats.success === 1);
    assert.equal(requests, 1); assert.equal(following, 0);
    const saved = JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult)).papers[0];
    assert.equal(engine.isSuccessfulAnalysisRecord(saved), true);
    assert.equal(saved.analysis, f.paper.analysis);
    assert.equal(saved.apiReaderArticle, f.paper.apiReaderArticle);
});
