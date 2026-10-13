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

for (const normalEntry of [
    { name: 'deep', run: options => entry.runDeepAnalysis(options) },
    { name: 'batch', run: options => {
        const file = require.resolve('../scripts/batch-analyze');
        delete require.cache[file];
        return require(file).main(options);
    } }
]) {
test(`普通 ${normalEntry.name} 自动复用已核验保存的原纠错说明，锁内重新读取且不清失败`, async t => {
    const sample = await createReviewedReaderSample(t);
    const previous = { deepAnalysisResult: Config.FILES.deepAnalysisResult,
        filteredPapers: Config.FILES.filteredPapers, papers: Config.FILES.papers };
    t.after(() => Object.assign(Config.FILES, previous));
    for (const key of Object.keys(previous)) Config.FILES[key] = path.join(sample.plan.runDir, key + '.json');
    const failed = structuredClone(sample.paper);
    failed.latestAnalysisAttemptError = '保留旧Reader失败';
    const payload = { batchDate: sample.plan.batchDate, batchId: sample.plan.batchId,
        dailyFreshSourceRun: daily.dailyFreshSourceReference(sample.plan), papers: [failed] };
    save(Config.FILES.deepAnalysisResult, payload);
    save(Config.FILES.filteredPapers, { batchDate: sample.plan.batchDate, batchId: sample.plan.batchId,
        status: 'complete', papers: [{ arxivId: failed.arxivId, title: failed.title }] });
    const input = path.join(sample.plan.runDir, 'original-feedback.json');
    save(input, sample.feedback);
    const originalBytes = fs.readFileSync(input);
    const bound = facts.validateFeedback(facts.readFeedback(input), sample.plan, failed);
    facts.withFactReview(bound, () => {});
    const stored = path.join(daily.factFeedbackDirectory(sample.plan), bound.proof.feedbackSha256 + '.json');
    assert.deepEqual(fs.readFileSync(stored), originalBytes);
    let calls = 0;
    await assert.rejects(normalEntry.run({ date: sample.plan.batchDate,
        analyzeFn: async paper => {
            calls += 1;
            assert.deepEqual(facts.current(sample.id).proof, bound.proof);
            assert.equal(paper.latestAnalysisAttemptError, '保留旧Reader失败');
            throw new Error('正常恢复已携带原说明');
        },
        analyzeBatch: async (papers, options) => {
            assert.equal(papers.length, 1);
            const locked = options.preparePaperLocked(papers[0]);
            assert.equal(locked.skip, false);
            return options.analyzeFn(locked.paper);
        }
    }), /正常恢复已携带原说明/);
    assert.equal(calls, 1);
    const saved = JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult));
    assert.deepEqual(saved.papers[0].analysisManifest, failed.analysisManifest);
    assert.equal(saved.papers[0].latestAnalysisAttemptError, failed.latestAnalysisAttemptError);
    fs.writeFileSync(stored, JSON.stringify({ ...sample.feedback, readerFeedback: '被改写的说明' }));
    await assert.rejects(normalEntry.run({ date: sample.plan.batchDate,
        analyzeBatch: async () => assert.fail('变更原包不得开始分析') }), /保存的证明不一致/);
});

test(`普通 ${normalEntry.name} 分别恢复原整篇说明与摘要说明，不混成一份新说明`, async t => {
    const sample = await createReviewedReaderSample(t);
    const policy = require('../scripts/lib/selected-full-stage-reanalysis');
    const parentBound = facts.validateFeedback(sample.feedback, sample.plan, sample.paper);
    let prepared;
    await daily.withDailyFreshAnalysisContext(sample.plan, () =>
        policy.withSelectedFullStageReanalysis({ runId: 'normal-dual-core-test',
            sourceRunId: sample.plan.runId, paperIds: [sample.id] }, () =>
            engine.withPaperAnalysisLock(sample.paper, () => facts.withFactReview(parentBound, () => {
                prepared = policy.preparePaperLocked(sample.paper);
            }))));
    // 样例表示同轮主文完成后新增摘要纠错；原费用档仍来自公共prepare函数。
    const current = { ...structuredClone(sample.paper),
        fullStageReanalysis: prepared.fullStageReanalysis,
        fullStageReanalysisHistory: prepared.fullStageReanalysisHistory,
        latestAnalysisAttemptError: '摘要尚未完成' };
    const coreFeedback = { ...sample.feedback, primaryFeedback: '', rejectedPrimaryClaims: [],
        readerFeedback: '', rejectedReaderClaims: [], coreFeedback: '依据原证据补全摘要解释。',
        rejectedCoreClaims: ['样例中被拒的摘要原句'] };
    const coreBound = facts.validateFeedback(coreFeedback, sample.plan, current);
    current.analysisManifest.stages.coreSummaryRepair.factReview = coreBound.proof;
    const previous = { deepAnalysisResult: Config.FILES.deepAnalysisResult,
        filteredPapers: Config.FILES.filteredPapers, papers: Config.FILES.papers };
    t.after(() => Object.assign(Config.FILES, previous));
    for (const key of Object.keys(previous)) Config.FILES[key] = path.join(sample.plan.runDir, 'dual-' + key + '.json');
    const payload = { batchDate: sample.plan.batchDate, batchId: sample.plan.batchId,
        dailyFreshSourceRun: daily.dailyFreshSourceReference(sample.plan), papers: [current] };
    const coreFile = path.join(daily.factFeedbackDirectory(sample.plan), coreBound.proof.feedbackSha256 + '.json');
    save(coreFile, coreFeedback);
    save(Config.FILES.filteredPapers, { batchDate: sample.plan.batchDate, batchId: sample.plan.batchId,
        status: 'complete', papers: [{ arxivId: current.arxivId, title: current.title }] });
    save(Config.FILES.deepAnalysisResult, payload);
    let calls = 0;
    await assert.rejects(normalEntry.run({ date: sample.plan.batchDate,
        analyzeFn: async paper => {
            calls += 1;
            const active = facts.current(sample.id);
            assert.equal(active.coreOnly, true);
            assert.deepEqual(active.proof, parentBound.proof);
            assert.deepEqual(active.coreBound.proof, coreBound.proof);
            assert.deepEqual(facts.fingerprintFields('coreSummaryRepair', paper.analysisManifest.stages.coreSummaryRepair),
                { factReview: coreBound.proof });
            assert.throws(() => facts.assertScoringOnlyModelStageAllowed('primaryAnalysis'), /不能调用主分析/);
            throw new Error('已有双说明正常恢复');
        }, analyzeBatch: async (papers, options) => engine.withPaperAnalysisLock(papers[0], () => {
            const locked = options.preparePaperLocked(papers[0]);
            assert.equal(locked.skip, false);
            return options.analyzeFn(locked.paper);
        }) }), /已有双说明正常恢复/);
    assert.equal(calls, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult)).papers[0].fullStageReanalysisHistory,
        current.fullStageReanalysisHistory);
    const wrong = structuredClone(payload);
    wrong.papers[0].analysisManifest.stages.methodRepair.factReview = coreBound.proof;
    save(Config.FILES.deepAnalysisResult, wrong);
    const skipped = await normalEntry.run({ date: sample.plan.batchDate,
        analyzeBatch: async () => assert.fail('摘要包不能授权其他阶段') });
    assert.notEqual(skipped.status, 'complete');
    assert.equal(skipped.remaining, 1);
    save(Config.FILES.deepAnalysisResult, payload);
    save(coreFile, { ...coreFeedback, coreFeedback: '被替换的摘要指导' });
    await assert.rejects(normalEntry.run({ date: sample.plan.batchDate,
        analyzeBatch: async () => assert.fail('改变原摘要包不能请求') }), /保存证明不同/);
});

}
