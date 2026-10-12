process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
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
async function createBoundFeedbackPaperSample(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'daily-fact-review-'));
    const previous = Object.fromEntries(['dailyFreshSourceRunsDir','deepAnalysisResult','filteredPapers','papers','analysisRepairAttemptsDir'].map(key => [key, Config.FILES[key]]));
    Config.FILES.dailyFreshSourceRunsDir = path.join(root,'runs');
    Config.FILES.deepAnalysisResult = path.join(root,'current','deep-analysis-result.json');
    Config.FILES.filteredPapers = path.join(root,'current','filtered-papers.json');
    Config.FILES.papers = path.join(root,'current','papers.json');
    Config.FILES.analysisRepairAttemptsDir = path.join(root,'repair-attempts');
    t.after(() => { Object.assign(Config.FILES, previous); fs.rmSync(root,{recursive:true,force:true}); });
    const papers = [{arxivId:ID,title:'来源绑定纠错测试样本'},{arxivId:'2610.90032',title:'Unrelated paper'}];
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


const engine = require('../scripts/analysis-engine');
const originalSuccessful = engine.isSuccessfulAnalysisRecord;
let successful = true;
engine.isSuccessfulAnalysisRecord = () => successful;
const batch = require('../scripts/batch-analyze');
engine.isSuccessfulAnalysisRecord = originalSuccessful;

test('同反馈完成判定核真实四源绑定和各阶段证明，不因错句或旧证明跳过', async t => {
    const f = await createBoundFeedbackPaperSample(t);
    const bound = review.validateFeedback(f.feedback, f.plan, f.paper);
    f.paper.analysis = baseline;
    f.paper.apiReaderArticle = '已按封存原文修正并保留比较条件的读者正文。';
    f.paper.analysisManifest.stages.coreSummaryRepair = { status: 'complete', factReview: bound.proof };
    f.paper.analysisManifest.stages.apiReaderArticle = { status: 'complete', factReview: bound.proof,
        reviewFeedbackSha256: review.sha(f.feedback.readerFeedback.trim()) };
    const originalReusable = daily.isPaperReusableForAnalysis;
    let reusable = true;
    daily.isPaperReusableForAnalysis = () => reusable;
    t.after(() => { daily.isPaperReusableForAnalysis = originalReusable; });
    const before = JSON.stringify(f.paper);
    assert.equal(batch.hasCompletedBoundFactFeedback(f.paper, f.feedback, f.plan), true);
    assert.equal(JSON.stringify(f.paper), before);
    for (const change of [
        paper => { paper.apiReaderArticle += f.feedback.rejectedReaderClaims[0]; },
        paper => { paper.analysis = original; },
        paper => { delete paper.analysisManifest.stages.apiReaderArticle.factReview; },
        paper => { paper.analysisManifest.stages.apiReaderArticle.reviewFeedbackSha256 = 'a'.repeat(64); },
        paper => { paper.analysisManifest.stages.coreSummaryRepair.status = 'failed'; },
        paper => { delete paper.analysisManifest.stages.coreSummaryRepair; }
    ]) {
        const paper = structuredClone(f.paper);
        change(paper);
        assert.equal(batch.hasCompletedBoundFactFeedback(paper, f.feedback, f.plan), false);
    }
    successful = false;
    assert.equal(batch.hasCompletedBoundFactFeedback(f.paper, f.feedback, f.plan), false);
    successful = true;
    reusable = false;
    assert.equal(batch.hasCompletedBoundFactFeedback(f.paper, f.feedback, f.plan), false);
    reusable = true;
    const newFeedback = { ...f.feedback, readerFeedback: f.feedback.readerFeedback + '新纠错要求。' };
    assert.equal(batch.hasCompletedBoundFactFeedback(f.paper, newFeedback, f.plan), false);
    const badSource = { ...f.feedback, sourceFiles: { ...f.feedback.sourceFiles, 'source.pdf': 'a'.repeat(64) } };
    assert.throws(() => batch.hasCompletedBoundFactFeedback(f.paper, badSource, f.plan), /来源|SHA/);
});
test('批次初筛和锁内重读共用完成判定，保留反馈且新出现错句仍进入修复', async t => {
    const f = await createBoundFeedbackPaperSample(t);
    const bound = review.validateFeedback(f.feedback, f.plan, f.paper);
    f.paper.analysis = baseline;
    f.paper.apiReaderArticle = '当前已纠正的读者正文。';
    f.paper.analysisManifest.stages.coreSummaryRepair = { status: 'complete', factReview: bound.proof };
    f.paper.analysisManifest.stages.apiReaderArticle = { status: 'complete', factReview: bound.proof,
        reviewFeedbackSha256: review.sha(f.feedback.readerFeedback.trim()) };
    json(Config.FILES.deepAnalysisResult, f.payload);
    const previousReusable = daily.isPaperReusableForAnalysis;
    const previousSuccess = engine.isSuccessfulAnalysisRecord;
    daily.isPaperReusableForAnalysis = () => true;
    engine.isSuccessfulAnalysisRecord = paper => Boolean(paper?.analysis);
    const batchPath = require.resolve('../scripts/batch-analyze');
    const previousModule = require.cache[batchPath];
    delete require.cache[batchPath];
    const freshBatch = require('../scripts/batch-analyze');
    t.after(() => {
        daily.isPaperReusableForAnalysis = previousReusable;
        engine.isSuccessfulAnalysisRecord = previousSuccess;
        require.cache[batchPath] = previousModule;
    });
    let batches = 0;
    await freshBatch.main({ factFeedbackFiles: [f.feedbackFile], analyzeBatch: async (papers, options) => {
        batches += 1;
        assert.equal(papers.some(paper => paper.arxivId === ID), false);
        assert.equal(options.preparePaperLocked(f.paper).skip, true);
        const latest = JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult, 'utf8'));
        latest.papers[0].apiReaderArticle += f.feedback.rejectedReaderClaims[0];
        json(Config.FILES.deepAnalysisResult, latest);
        assert.equal(options.preparePaperLocked(f.paper).skip, false);
        return { stats: { success: 0, failed: papers.length, sourceCounts: {} } };
    } });
    assert.equal(batches, 1);
    assert.deepEqual(review.readFeedback(f.feedbackFile), f.feedback);
});
