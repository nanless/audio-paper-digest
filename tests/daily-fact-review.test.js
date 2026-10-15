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

test('成功清理保留纠错所依据的真实原输入，普通旧快照仍清除，同一反馈可以再次核验', async t => {
    const f = await fixture(t);
    const bound = review.validateFeedback(f.feedback, f.plan, f.paper);
    review.withFactReview(bound, () => deep.captureStaleAnalysisSnapshot(f.paper, f.paper.analysisManifest,
        'coreSummaryRepair', bound.proof.feedbackSha256));
    const originalSnapshot = JSON.stringify(f.paper.analysisStaleSnapshots[0]);
    f.paper.analysisCheckpoint = baseline;
    deep.captureStaleAnalysisSnapshot(f.paper, f.paper.analysisManifest, 'scoringAudit', 'new-score');
    f.paper.analysisManifest.stages.coreSummaryRepair.factReview = bound.proof;
    f.paper.analysis = baseline;
    delete f.paper.analysisCheckpoint;
    assert.equal(f.paper.analysisStaleSnapshots.length, 2);
    deep.retainFinalFactReviewInputs(f.paper, f.paper.analysisManifest);
    assert.equal(f.paper.analysisStaleSnapshots.length, 1);
    assert.equal(JSON.stringify(f.paper.analysisStaleSnapshots[0]), originalSnapshot);
    assert.deepEqual(review.validateFeedback(f.feedback, f.plan, f.paper).proof, bound.proof);
    const unrelated = structuredClone(f.paper);
    delete unrelated.analysisManifest.stages.coreSummaryRepair.factReview;
    deep.retainFinalFactReviewInputs(unrelated, unrelated.analysisManifest);
    assert.equal(unrelated.analysisStaleSnapshots, undefined);
    assert.throws(() => review.validateFeedback(f.feedback, f.plan, unrelated), /绑定已过期/);
});

test('成功清理不补造丢失或被改坏的原输入，也不接受其他论文的证明', async t => {
    const f = await fixture(t);
    const bound = review.validateFeedback(f.feedback, f.plan, f.paper);
    review.withFactReview(bound, () => deep.captureStaleAnalysisSnapshot(f.paper, f.paper.analysisManifest,
        'coreSummaryRepair', bound.proof.feedbackSha256));
    f.paper.analysisManifest.stages.scoringAudit.scoringFactReview = bound.proof;
    f.paper.analysis = baseline;
    delete f.paper.analysisCheckpoint;
    f.paper.analysisStaleSnapshots[0].payload.analysisCheckpoint += '被修改';
    deep.retainFinalFactReviewInputs(f.paper, f.paper.analysisManifest);
    assert.equal(f.paper.analysisStaleSnapshots, undefined);
    assert.throws(() => review.validateFeedback(f.feedback, f.plan, f.paper), /绑定已过期/);
    deep.retainFinalFactReviewInputs(f.paper, f.paper.analysisManifest);
    assert.equal(f.paper.analysisStaleSnapshots, undefined);
    f.paper.analysisManifest.stages.scoringAudit.scoringFactReview = { ...bound.proof, paperId: '2610.90032' };
    assert.throws(() => deep.retainFinalFactReviewInputs(f.paper, f.paper.analysisManifest), /其他论文/);
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

test('批量入口读取重复事实反馈参数，缺文件路径时拒绝', () => {
    const batch = require('../scripts/batch-analyze');
    assert.deepEqual(batch.parseFactFeedbackFiles(['--refresh-reader-diagnostics',
        '--fact-feedback-file', '/tmp/第一篇.json', '--fact-feedback-file', '/tmp/第二篇.json']),
    ['/tmp/第一篇.json', '/tmp/第二篇.json']);
    assert.deepEqual(batch.parseFactFeedbackFiles([]), []);
    for (const args of [['--fact-feedback-file'], ['--fact-feedback-file', '--refresh-reader-diagnostics'],
        ['--fact-feedback-file', '']]) assert.throws(() => batch.parseFactFeedbackFiles(args), /须提供/);
});

test('批量公开入口将逐篇原付费摘要、Reader候选与自然资源参数传入实际分析回调且不串篇', async t => {
    const f = await fixture(t);
    delete require.cache[require.resolve('../scripts/batch-analyze')];
    const batch = require('../scripts/batch-analyze');
    const secondId = '2610.90032';
    const diagnosticId = '11111111-1111-4111-8111-111111111111';
    const candidate = { candidateSha256: 'c'.repeat(64), identity: { paperId: secondId } };
    const before = structuredClone(candidate), calls = [];
    await batch.main({
        coreSummaryDiagnosticIds: { [ID]: diagnosticId },
        resolvedReaderCandidates: { [secondId]: candidate },
        naturalResourceProse: true,
        analyzeFn: async (paper, options) => {
            calls.push({ id: paper.arxivId, options });
            throw Object.assign(new Error('offline parameter routing sentinel'), { retryable: false });
        }
    });
    assert.equal(calls.length, 2);
    const first = calls.find(call => call.id === ID).options;
    const second = calls.find(call => call.id === secondId).options;
    assert.equal(first.coreSummaryDiagnosticId, diagnosticId);
    assert.equal(first.resolvedReaderCandidate, undefined);
    assert.equal(second.coreSummaryDiagnosticId, undefined);
    assert.deepEqual(second.resolvedReaderCandidate, candidate);
    assert.equal(first.naturalResourceProse, true);
    assert.equal(second.naturalResourceProse, true);
    assert.deepEqual(candidate, before);
    assert.equal(f.paper.analysisCheckpoint, original);
});

test('批量公开入口恢复上游标记与逐篇来源选项同时保留且恢复标记不泄漏到另一篇', async t => {
    await fixture(t);
    delete require.cache[require.resolve('../scripts/batch-analyze')];
    const batch = require('../scripts/batch-analyze');
    const saved = require('../scripts/lib/saved-fact-feedback');
    const diagnosticId = '22222222-2222-4222-8222-222222222222';
    const calls = [];
    t.mock.method(saved, 'analyzeWithRecoveredFeedback', async (paper, plan, analyze, feedback, sourceOptions) => {
        assert.equal(sourceOptions.coreSummaryDiagnosticId, paper.arxivId === ID ? diagnosticId : undefined);
        return paper.arxivId === ID
            ? analyze({ resumeSavedReaderUpstreamOnly: true, requireCompletedPrimaryCheckpoint: true })
            : analyze();
    });
    await batch.main({
        coreSummaryDiagnosticIds: { [ID]: diagnosticId }, naturalResourceProse: true,
        analyzeFn: async (paper, options) => {
            calls.push({ id: paper.arxivId, options });
            throw Object.assign(new Error('offline saved-upstream routing sentinel'), { retryable: false });
        }
    });
    assert.equal(calls.length, 2);
    const first = calls.find(call => call.id === ID).options;
    const second = calls.find(call => call.id !== ID).options;
    assert.equal(first.coreSummaryDiagnosticId, diagnosticId);
    assert.equal(first.naturalResourceProse, true);
    assert.equal(first.resumeSavedReaderUpstreamOnly, true);
    assert.equal(first.requireCompletedPrimaryCheckpoint, true);
    assert.equal(second.naturalResourceProse, true);
    assert.equal(second.resumeSavedReaderUpstreamOnly, undefined);
    assert.equal(second.requireCompletedPrimaryCheckpoint, undefined);
});

test('批量反馈全部只读预检：重复论文、后一个坏绑定及非法列表不写文件、不开始分析', async t => {
    const f = await fixture(t);
    delete require.cache[require.resolve('../scripts/batch-analyze')];
    const batch = require('../scripts/batch-analyze');
    const secondFile = path.join(f.root, 'second-feedback.json');
    json(secondFile, { ...f.feedback, paperId: '2610.99999' });
    const files = [Config.FILES.deepAnalysisResult, Config.FILES.filteredPapers, Config.FILES.papers];
    const before = files.map(filename => fs.readFileSync(filename));
    let calls = 0;
    for (const factFeedbackFiles of [null, 'file.json', [42], [f.feedbackFile, f.feedbackFile],
        [f.feedbackFile, secondFile]]) {
        await assert.rejects(batch.main({ factFeedbackFiles,
            analyzeBatch: async () => { calls++; assert.fail('无效反馈不可开始分析'); } }));
        files.forEach((filename, index) => assert.deepEqual(fs.readFileSync(filename), before[index]));
    }
    json(secondFile, { ...f.feedback, sourceQuotes: ['编造的来源引文'] });
    await assert.rejects(batch.main({ factFeedbackFiles: [secondFile],
        analyzeBatch: async () => { calls++; } }), /逐字引文/);
    assert.equal(calls, 0);
    files.forEach((filename, index) => assert.deepEqual(fs.readFileSync(filename), before[index]));
});

test('正常批量逐篇锁内应用反馈；其他未完成论文照常分析且不收到相邻论文反馈', async t => {
    const f = await fixture(t);
    delete require.cache[require.resolve('../scripts/batch-analyze')];
    const batch = require('../scripts/batch-analyze');
    const seen = [];
    const paidInput = f.paper.analysisCheckpoint;
    const result = await batch.main({ factFeedbackFiles: [f.feedbackFile],
        analyzeFn: async paper => {
            const id = require('../scripts/utils').normalizedId(paper);
            const active = review.current(id);
            seen.push({ id, feedback: active?.feedback.paperId || null });
            assert.equal(paper.coreFeedback, undefined);
            if (id === ID) {
                assert.equal(review.reviewFeedback('coreSummaryRepair', ID).includes(quote), true);
                assert.equal(paper.analysisCheckpoint, paidInput);
            } else {
                assert.equal(active, null);
                assert.equal(review.current(ID), null);
            }
            throw Object.assign(new Error('离线检查：停止在模型请求之前'), { retryable: false });
        } });
    assert.deepEqual(seen.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        [{ id: ID, feedback: ID }, { id: '2610.90032', feedback: null }]);
    assert.equal(result.remaining, 2);
    const saved = JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult));
    assert.equal(saved.papers.length, 2);
    assert.equal(saved.papers.find(paper => paper.arxivId === ID).analysisCheckpoint, paidInput);
    assert.equal(review.current(), null);
});

test('批量反馈取得论文锁后重读正式正文，预检后出现变化须在分析器之前停止', async t => {
    const f = await fixture(t);
    delete require.cache[require.resolve('../scripts/batch-analyze')];
    const batch = require('../scripts/batch-analyze');
    let calls = 0;
    await assert.rejects(batch.main({ factFeedbackFiles: [f.feedbackFile],
        analyzeFn: async () => { calls++; }, analyzeBatch: async (papers, options) => {
            const changed = JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult));
            changed.papers[0].analysisCheckpoint += '并发修改的正文';
            json(Config.FILES.deepAnalysisResult, changed);
            options.preparePaperLocked(papers.find(paper => paper.arxivId === ID));
            assert.fail('锁内绑定过期不能进入分析器');
        } }), /当前核心摘要正文绑定/);
    assert.equal(calls, 0);
});

test('两篇反馈并发续跑，各自只接收本篇已核验的纠错内容', async t => {
    const f = await fixture(t);
    const secondId = '2610.90032';
    const secondPaper = { ...structuredClone(f.paper), arxivId: secondId };
    const details = daily.readDailyFreshSource(f.plan, secondPaper);
    daily.withDailyFreshAnalysisContext(f.plan, () => fresh.attachFreshSourceRecord(
        secondPaper, secondPaper.analysisManifest, details));
    assert.equal(daily.isPaperBoundToPlan(secondPaper, f.plan), true);
    f.payload.papers[1] = secondPaper;
    json(Config.FILES.deepAnalysisResult, f.payload);
    const secondDirectory = path.join(f.plan.sourcesDir, secondId, 'generation-000001');
    const secondFeedback = { ...f.feedback, paperId: secondId,
        sourceFiles: Object.fromEntries(Object.keys(f.feedback.sourceFiles).map(name =>
            [name, review.sha(fs.readFileSync(path.join(secondDirectory, name)))])),
        coreFeedback: '第二篇单独修正文：文本教师使用均方误差，不能写成余弦蒸馏。' };
    const secondFile = path.join(f.root, 'second-valid-feedback.json');
    json(secondFile, secondFeedback);
    delete require.cache[require.resolve('../scripts/batch-analyze')];
    const batch = require('../scripts/batch-analyze');
    const seen = [];
    await batch.main({ factFeedbackFiles: [f.feedbackFile, secondFile], analyzeFn: async paper => {
        await new Promise(resolve => setImmediate(resolve));
        const id = require('../scripts/utils').normalizedId(paper);
        const expected = id === ID ? f.feedback : secondFeedback;
        assert.deepEqual(review.current(id).feedback, expected);
        assert.equal(review.current(id === ID ? secondId : ID), null);
        seen.push(id);
        throw Object.assign(new Error('离线并发反馈检查完成，不调用模型'), { retryable: false });
    } });
    assert.deepEqual(seen.sort(), [ID, secondId]);
    assert.equal(JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult)).papers.length, 2);
    assert.equal(review.current(), null);
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


test('正常封存来源局部主文请求拒绝整篇输出并保留原付费档',async t=>{
 const http=require('node:http'),cp=require('node:child_process');const bodies=[];
 const server=http.createServer((req,res)=>{let input='';req.on('data',c=>input+=c);req.on('end',()=>{bodies.push(JSON.parse(input));res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:original},finish_reason:'stop'}]}));});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const folder=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'primary-fact-http-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 for(const dir of ['scripts','manual','prompts','config','tests'])fs.cpSync(path.resolve(__dirname,'..',dir),path.join(folder,dir),{recursive:true});
 require('./helpers/git-prompt-evidence-workspace.cjs').installFixtureGitObjectStore(folder);
 fs.symlinkSync(path.resolve(__dirname,'../node_modules'),path.join(folder,'node_modules'),'dir');
 fs.writeFileSync(path.join(folder,'.env'),`PAPER_ANALYZER_API_KEY=synthetic-local-only\nPAPER_ANALYZER_MODEL=ci-test-model\nPAPER_ANALYZER_ENDPOINT=http://127.0.0.1:${server.address().port}/v1\n`,{mode:0o600});
 const prefix=fs.readFileSync(__filename,'utf8').split("test('只读反馈严格绑定")[0].replace("imageInfos:[],structuredArtifacts:artifacts", "imageInfos:[{url:'https://example.invalid/synthetic-test.png'}],structuredArtifacts:artifacts");
 const localPrefix=prefix.replace("baseline.replace('## 核心摘要\\n', `## 核心摘要\\n${wrong}`)",
     "baseline.replace('## 实验结果\\n', `## 实验结果\\n${wrong}\\n\\n`)");
 const program=localPrefix+`
(async () => {
 const sample = await fixture({ after() {} });
 Object.assign(sample.paper.analysisManifest.sourceAcquisition, { usedTextSha256: review.sha(sourceText), sourceId: ID, analysisSource: 'html' });
 sample.feedback.coreFeedback = '';
 sample.feedback.readerFeedback = '';
 sample.feedback.rejectedCoreClaims = [];
 sample.feedback.rejectedReaderClaims = [];
 sample.feedback.primaryFeedback = '旧一轮主分析事实反馈。';
 sample.feedback.rejectedPrimaryClaims = [wrong];
 const oldBound = review.validateFeedback(sample.feedback, sample.plan, sample.paper);
 sample.paper.analysisManifest.stages.primaryAnalysis.factReview = oldBound.proof;
 review.withFactReview(oldBound, () => deep.captureStaleAnalysisSnapshot(sample.paper, sample.paper.analysisManifest, 'primaryAnalysis', oldBound.proof.feedbackSha256));
 sample.feedback.primaryFeedback = '主分析重生成全部13节：蒸馏使用MSE，实验中的旧余弦说明必须纠正。';
 const bound = review.validateFeedback(sample.feedback, sample.plan, sample.paper);
 await assert.rejects(daily.withDailyFreshAnalysisContext(sample.plan, () => daily.createDailyAnalyzeFn(sample.plan, {
     analyze: paper => review.withFactReview(bound, () => deep.analyzePaperDeep(paper))
 })(sample.paper)), /完整JSON/);
 assert.equal(sample.paper.analysisCheckpoint, original);
 assert.equal(sample.paper.analysisManifest.stages.primaryAnalysis.status, 'contract_rejected');
 assert.deepEqual(sample.paper.analysisManifest.stages.primaryAnalysis.factReview, bound.proof);
 assert.ok(sample.paper.analysisStaleSnapshots.some(snapshot => deep.validateStaleAnalysisSnapshot(snapshot)?.analysisCheckpoint === original));
 assert.ok(review.validateFeedback(sample.feedback, sample.plan, sample.paper));
 const noFeedback = structuredClone(sample.paper);
 await assert.rejects(daily.withDailyFreshAnalysisContext(sample.plan, () => daily.createDailyAnalyzeFn(sample.plan)(noFeedback)), /须重新提供同一份受控反馈/);
 console.log('NORMAL_PRIMARY_HTTP_NEGATIVE_CONFIRMED');
 fs.rmSync(sample.root, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });`;
 fs.writeFileSync(path.join(folder,'tests/primary-fact-http-child.cjs'),program);
 const result=await new Promise(resolve=>{const child=cp.spawn(process.execPath,['tests/primary-fact-http-child.cjs'],{cwd:folder});let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.on('close',status=>resolve({status,stdout,stderr}));});
 assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/NORMAL_PRIMARY_HTTP_NEGATIVE_CONFIRMED/);
 assert.equal(bodies.length,1,'旧primary必须正常请求一次，而非旧成功补签或先请求其他阶段');
 const content=JSON.stringify(bodies[0].messages);assert.match(content,/replacements/);assert.match(content,/局部/);assert.ok(content.includes(quote));
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
    require('./helpers/git-prompt-evidence-workspace.cjs').installFixtureGitObjectStore(folder);
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


test('同一已执行反馈可从保留原正文恢复，其他旧正文和篡改证明不能绕过当前检查点', async t => {
    const sample = await fixture(t);
    const accepted = review.validateFeedback(sample.feedback, sample.plan, sample.paper);
    sample.paper.analysis = original;
    sample.paper.analysisCheckpoint = baseline;
    sample.paper.analysisManifest.stages.coreSummaryRepair.factReview = accepted.proof;
    const savedPaper = JSON.stringify(sample.paper);
    const restored = review.validateFeedback(sample.feedback, sample.plan, sample.paper);
    assert.deepEqual(restored.proof, accepted.proof);
    assert.equal(JSON.stringify(sample.paper), savedPaper);
    assert.equal(sample.paper.analysisStaleSnapshots, undefined);

    const missingReceipt = structuredClone(sample.paper);
    delete missingReceipt.analysisManifest.stages.coreSummaryRepair.factReview;
    assert.throws(() => review.validateFeedback(sample.feedback, sample.plan, missingReceipt), /当前核心摘要正文绑定/);

    const changedOriginal = structuredClone(sample.paper);
    changedOriginal.analysis += '篡改旧正文';
    assert.throws(() => review.validateFeedback(sample.feedback, sample.plan, changedOriginal), /当前核心摘要正文绑定/);

    const forgedReceipt = structuredClone(sample.paper);
    forgedReceipt.analysisManifest.stages.coreSummaryRepair.factReview.feedbackSha256 = 'a'.repeat(64);
    assert.throws(() => review.validateFeedback(sample.feedback, sample.plan, forgedReceipt), /当前核心摘要正文绑定/);

    const changedSource = structuredClone(sample.feedback);
    changedSource.sourceFiles['source.pdf'] = 'a'.repeat(64);
    assert.throws(() => review.validateFeedback(changedSource, sample.plan, sample.paper), /来源SHA/);

    const inventedQuote = structuredClone(sample.feedback);
    inventedQuote.sourceQuotes = ['This sentence does not occur in the sealed source.'];
    assert.throws(() => review.validateFeedback(inventedQuote, sample.plan, sample.paper), /逐字引文/);
});

test('独立评分反馈不改变主文配方且旧主分析约束不可绕过', async t => {
    const sample = await fixture(t);
    const feedback = {
        ...sample.feedback,
        primaryFeedback: '', rejectedPrimaryClaims: [],
        coreFeedback: '', rejectedCoreClaims: [],
        readerFeedback: '', rejectedReaderClaims: [],
        scoringFeedback: '评分不得把无显著差异称为不劣。',
        rejectedScoringClaims: ['无显著差异证明不劣']
    };
    const bound = review.validateFeedback(feedback, sample.plan, sample.paper);
    review.withFactReview(bound, () => {
        assert.deepEqual(review.fingerprintFields('primaryAnalysis', {}), {});
        assert.deepEqual(review.fingerprintFields('coreSummaryRepair', {}), {});
        assert.deepEqual(review.fingerprintFields('apiReaderArticle', {}), {});
        assert.deepEqual(review.fingerprintFields('scoringAudit', {}), { scoringFactReview: bound.proof });
        review.assertScoringRequestAllowed({});
        assert.throws(() => review.assertScoringRequestAllowed({ factReview: bound.proof }), /主分析反馈/);
        assert.throws(() => review.validateRepairedClaims('scoringAudit', '无显著差异证明不劣', ID), /错误的原句/);
        review.validateRepairedClaims('primaryAnalysis', '无显著差异证明不劣', ID);
        assert.match(review.reviewFeedback('scoringAudit', ID), /评分不得/);
        assert.equal(review.reviewFeedback('primaryAnalysis', ID), '');
    });
    assert.throws(() => review.assertScoringRequestAllowed({ scoringFactReview: bound.proof }), /独立评分反馈/);
    assert.throws(() => review.validateShape({ ...feedback, rejectedScoringClaims: undefined }), /原句列表/);
    assert.throws(() => review.validateShape({ ...feedback, rejectedScoringClaims: [] }), /逐字证据/);
    assert.throws(() => review.validateShape({ ...feedback, scoreFeedback: '非法字段' }), /字段不合法/);
});

test('评分同收据恢复仍须真实原输入快照且不能信任篡改快照', async t => {
    const sample = await fixture(t);
    const feedback = {
        ...sample.feedback,
        coreFeedback: '', rejectedCoreClaims: [],
        readerFeedback: '', rejectedReaderClaims: [],
        scoringFeedback: '仅重新核对评分事实。', rejectedScoringClaims: ['旧评分错误']
    };
    const bound = review.validateFeedback(feedback, sample.plan, sample.paper);
    sample.paper.analysisManifest.stages.scoringAudit = { status: 'complete', scoringFactReview: bound.proof };
    const payload = {
        analysisCheckpoint: sample.paper.analysisCheckpoint,
        analysisStageCheckpoints: {}, stages: {}, contracts: {}
    };
    const snapshot = {
        contract: 'stale-analysis-snapshot-v1', payload,
        payloadSha256: daily.stableHash(payload)
    };
    sample.paper.analysis = sample.paper.analysisCheckpoint.replace(wrong, '新正文');
    sample.paper.analysisCheckpoint = sample.paper.analysis;
    assert.throws(() => review.validateFeedback(feedback, sample.plan, sample.paper), /正文绑定已过期/);
    sample.paper.analysisStaleSnapshots = [snapshot];
    assert.equal(deep.validateStaleAnalysisSnapshot(snapshot) !== null, true);
    assert.doesNotThrow(() => review.validateFeedback(feedback, sample.plan, sample.paper));
    snapshot.payload.analysisCheckpoint += '篡改';
    assert.throws(() => review.validateFeedback(feedback, sample.plan, sample.paper), /正文绑定已过期/);
});


test('各自合法的主分析与评分反馈仍须遵守评分组合上下文预算', async t => {
    const sample = await fixture(t);
    const feedback = {
        ...sample.feedback,
        coreFeedback: '', rejectedCoreClaims: [],
        readerFeedback: '', rejectedReaderClaims: [],
        primaryFeedback: '主'.repeat(2100), rejectedPrimaryClaims: ['主文旧错'],
        scoringFeedback: '分'.repeat(2100), rejectedScoringClaims: ['评分旧错']
    };
    assert.ok(feedback.primaryFeedback.length + quote.length + 80 < 4000);
    assert.ok(feedback.scoringFeedback.length + quote.length + 80 < 4000);
    assert.throws(() => review.validateShape(feedback), /评分组合反馈/);
    feedback.primaryFeedback = '主'.repeat(1000);
    assert.doesNotThrow(() => review.validateShape(feedback));
    const originalHash = daily.stableHash(sample.feedback);
    review.validateShape(sample.feedback);
    assert.equal(daily.stableHash(sample.feedback), originalHash);
});


test('正文重写收到主分析纠错且不能接受重新引入的错误', async t => {
    const sample = await fixture(t);
    const feedback = {
        ...sample.feedback,
        primaryFeedback: '正文各阶段保留文本教师 MSE，不得重新写成余弦蒸馏。',
        rejectedPrimaryClaims: [wrong]
    };
    const bound = review.validateFeedback(feedback, sample.plan, sample.paper);
    const corrected = original.replace(wrong, '文本教师 MSE。');
    await review.withFactReview(bound, async () => {
        let requestCount = 0;
        await assert.rejects(deep.reviseAnalysis(sample.paper, corrected, sourceText, null, {
            callModelFn: async messages => {
                requestCount += 1;
                assert.ok(messages[0].content.includes(feedback.primaryFeedback));
                assert.ok(messages[0].content.includes(quote));
                return original;
            }
        }), /模型输出仍包含/);
        assert.equal(requestCount, 1);
        for (const stage of ['openSourceScan', 'revision', 'tableRepair', 'methodRepair', 'structureRepair']) {
            assert.deepEqual(review.fingerprintFields(stage), { factReview: bound.proof });
            assert.ok(review.reviewFeedback(stage).includes(feedback.primaryFeedback));
            assert.throws(() => review.validateRepairedClaims(stage, original), /模型输出仍包含/);
        }
    });
});

test('评分前拒绝正文遗留错误且不支付评分请求', async t => {
    const sample = await fixture(t);
    const feedback = { ...sample.feedback, primaryFeedback: '修正错误蒸馏事实。', rejectedPrimaryClaims: [wrong] };
    const bound = review.validateFeedback(feedback, sample.plan, sample.paper);
    let scoringRequests = 0;
    await review.withFactReview(bound, async () => {
        await assert.rejects(deep.auditTypeAwareScoringDetailed(original, sourceText, {
            callModelFn: async () => { scoringRequests += 1; throw new Error('不应评分'); }
        }), /模型输出仍包含/);
    });
    assert.equal(scoringRequests, 0);
});

test('已缓存坏正文不能复用，旧无反馈正文阶段指纹保持兼容', async t => {
    const sample = await fixture(t);
    const before = deep.buildTextStageFingerprint('revision', original, sourceText);
    assert.deepEqual(review.fingerprintFields('revision'), {});
    const feedback = { ...sample.feedback, primaryFeedback: '保留文本教师 MSE。', rejectedPrimaryClaims: [wrong] };
    const bound = review.validateFeedback(feedback, sample.plan, sample.paper);
    review.withFactReview(bound, () => {
        const fingerprint = deep.buildTextStageFingerprint('revision', original, sourceText);
        assert.notEqual(fingerprint, before);
        sample.paper.analysisManifest.stages.revision = { status: 'complete', fingerprint, factReview: bound.proof };
        sample.paper.analysisStageCheckpoints.revision = original;
        const prepared = deep.prepareTextRecoveryStage(sample.paper, sample.paper.analysisManifest, 'revision', original, sourceText);
        assert.equal(prepared.invalidated, true);
        assert.notEqual(sample.paper.analysisManifest.stages.revision?.status, 'complete');
    });
    assert.equal(deep.buildTextStageFingerprint('revision', original, sourceText), before);
});


test('已保护主分析缺原反馈时正文重写不发请求且不改旧证明', async t => {
    const sample = await fixture(t);
    const feedback = { ...sample.feedback, primaryFeedback: '保留文本教师 MSE。', rejectedPrimaryClaims: [wrong] };
    const bound = review.validateFeedback(feedback, sample.plan, sample.paper);
    sample.paper.analysisManifest.stages.primaryAnalysis.factReview = bound.proof;
    const before = JSON.stringify(sample.paper.analysisManifest);
    let requests = 0;
    await assert.rejects(deep.reviseAnalysis(sample.paper, original, sourceText, null, {
        callModelFn: async () => { requests += 1; return original; }
    }), /缺少对应的已绑定主分析反馈/);
    assert.equal(requests, 0);
    assert.equal(JSON.stringify(sample.paper.analysisManifest), before);
});

test('独立评分双反馈保留原主分析证明，严格拒绝缺原包和越权范围', async t => {
    const sample = await fixture(t);
    const primaryFeedback = {
        ...sample.feedback,
        primaryFeedback: '只修正文原错误，保留其他来源事实。',
        rejectedPrimaryClaims: ['原主分析错误。'],
        coreFeedback: '',
        rejectedCoreClaims: [],
        readerFeedback: '',
        rejectedReaderClaims: []
    };
    const primaryBound = review.validateFeedback(primaryFeedback, sample.plan, sample.paper);
    sample.paper.analysisManifest.stages.primaryAnalysis.factReview = primaryBound.proof;
    const scoringFeedback = {
        ...primaryFeedback,
        primaryFeedback: '',
        rejectedPrimaryClaims: [],
        scoringFeedback: '统计检验缺失只归实验充分性；真实逻辑或推导错误才归技术严谨性。',
        rejectedScoringClaims: ['评分重复错误。']
    };
    const scoringBound = review.validateFeedback(scoringFeedback, sample.plan, sample.paper);
    const protectedPrimary = structuredClone(sample.paper.analysisManifest.stages.primaryAnalysis);
    let requests = 0;
    for (const invalidPrimary of [null, { ...primaryBound }]) {
        assert.throws(() => review.withScoringFactReviews(scoringBound, invalidPrimary, sample.paper, () => requests++), /尚未/);
    }
    const invalidPaper = structuredClone(sample.paper);
    invalidPaper.analysisManifest.stages.primaryAnalysis.factReview = scoringBound.proof;
    assert.throws(() => review.withScoringFactReviews(review.validateFeedback(scoringFeedback, sample.plan, invalidPaper), primaryBound, invalidPaper, () => requests++), /不对应/);
    const mixedBound = review.validateFeedback({ ...scoringFeedback, primaryFeedback: '不允许新包改正文。', rejectedPrimaryClaims: ['另一错误。'] }, sample.plan, sample.paper);
    assert.throws(() => review.withScoringFactReviews(mixedBound, primaryBound, sample.paper, () => requests++), /不能授权/);
    const firstSamplePaths = { ...Config.FILES };
    const unrelatedSample = await fixture(t);
    const unrelatedPrimary = review.validateFeedback({
        ...primaryFeedback,
        runId: unrelatedSample.plan.runId,
        sourceFiles: unrelatedSample.feedback.sourceFiles
    }, unrelatedSample.plan, unrelatedSample.paper);
    assert.throws(() => review.withScoringFactReviews(scoringBound, unrelatedPrimary, sample.paper, () => requests++), /来源身份/);
    Object.assign(Config.FILES, firstSamplePaths);
    const largePrimary = review.validateFeedback({ ...primaryFeedback, primaryFeedback: '原正文约束。'.repeat(340) }, sample.plan, sample.paper);
    const largeScoring = review.validateFeedback({ ...scoringFeedback, scoringFeedback: '独立评分约束。'.repeat(280) }, sample.plan, sample.paper);
    const largePaper = structuredClone(sample.paper);
    largePaper.analysisManifest.stages.primaryAnalysis.factReview = largePrimary.proof;
    assert.throws(() => review.withScoringFactReviews(review.validateFeedback(largeScoring.feedback, sample.plan, largePaper), largePrimary, largePaper, () => requests++), /超过4000/);
    const savedScoring = review.validateFeedback({ ...scoringFeedback, scoringFeedback: '之前的评分反馈。' }, sample.plan, sample.paper);
    sample.paper.analysisManifest.stages.scoringAudit.scoringFactReview = savedScoring.proof;
    assert.equal(requests, 0);
    await review.withScoringFactReviews(scoringBound, primaryBound, sample.paper, async () => {
        const scoringFields = review.fingerprintFields('scoringAudit', sample.paper.analysisManifest.stages.scoringAudit);
        assert.deepEqual(scoringFields.factReview, primaryBound.proof);
        assert.deepEqual(scoringFields.scoringFactReview, scoringBound.proof);
        assert.deepEqual(review.fingerprintFields('primaryAnalysis').factReview, primaryBound.proof);
        assert.throws(() => review.reviewFeedback('primaryAnalysis'), /不允许/);
        assert.throws(() => review.reviewFeedback('apiReaderArticle'), /不允许/);
        assert.throws(() => review.assertScoringOnlyModelStageAllowed('revision'), /不允许/);
        review.assertScoringOnlyModelStageAllowed('scoringAudit');
        const promptFeedback = review.reviewFeedback('scoringAudit');
        assert.ok(promptFeedback.includes(primaryFeedback.primaryFeedback));
        assert.ok(promptFeedback.includes(scoringFeedback.scoringFeedback));
        assert.ok(promptFeedback.includes(quote));
        review.assertScoringRequestAllowed({ factReview: primaryBound.proof, scoringFactReview: savedScoring.proof });
        assert.throws(() => review.assertScoringRequestAllowed({}), /原主分析证明/);
        assert.throws(() => review.assertScoringRequestAllowed({ factReview: primaryBound.proof, scoringFactReview: largeScoring.proof }), /独立评分反馈/);
        assert.throws(() => review.validateRepairedClaims('scoringAudit', '原主分析错误。'), /仍包含/);
        assert.throws(() => review.validateRepairedClaims('scoringAudit', '评分重复错误。'), /仍包含/);
        review.validateRepairedClaims('scoringAudit', '纠正后的八维评分。');
    });
    assert.deepEqual(sample.paper.analysisManifest.stages.primaryAnalysis, protectedPrimary);
    assert.throws(() => review.withFactReview(scoringBound, () => review.assertScoringRequestAllowed({ factReview: primaryBound.proof })), /主分析反馈/);
});

test('真实原输入单独核验后可保留当前主分析，原副本被改仍零请求拒绝', async t => {
    const sample = await fixture(t);
    const retainedOriginal = structuredClone(sample.paper);
    const originalFeedback = {
        ...sample.feedback,
        primaryFeedback: '主分析不能复述错误余弦蒸馏损失。',
        rejectedPrimaryClaims: [wrong],
        coreFeedback: '', rejectedCoreClaims: [],
        readerFeedback: '', rejectedReaderClaims: []
    };
    const originalBound = review.validateFeedback(originalFeedback, sample.plan, retainedOriginal);
    sample.paper.analysis = baseline;
    sample.paper.analysisCheckpoint = baseline;
    sample.paper.analysisStageCheckpoints.primaryAnalysis = baseline;
    sample.paper.analysisManifest.stages.primaryAnalysis.factReview = originalBound.proof;
    const newFeedback = {
        ...originalFeedback,
        coreAnalysisSha256: review.sha(baseline),
        coreSummarySha256: review.sha(deep.extractSectionByTitle(baseline, '核心摘要')),
        primaryFeedback: '', rejectedPrimaryClaims: [],
        scoringFeedback: '缺少统计检验只归实验充分性，不作推导错误。',
        rejectedScoringClaims: ['重复扣分原句。']
    };
    const newBound = review.validateFeedback(newFeedback, sample.plan, sample.paper);
    assert.throws(() => review.validateFeedback(originalFeedback, sample.plan, sample.paper), /正文绑定已过期/);
    let modelRequests = 0;
    review.withScoringFactReviews(newBound, originalBound, sample.paper, () => {
        review.validateRepairedClaims('primaryAnalysis', baseline);
        assert.throws(() => review.validateRepairedClaims('primaryAnalysis', wrong), /仍包含/);
        review.assertScoringOnlyModelStageAllowed('scoringAudit');
        modelRequests++;
    });
    assert.equal(modelRequests, 1);
    retainedOriginal.analysisCheckpoint += '篡改原输入';
    assert.throws(() => review.withScoringFactReviews(newBound, originalBound, sample.paper, () => modelRequests++), /正文绑定已过期/);
    assert.equal(modelRequests, 1);
    assert.equal(sample.paper.analysisStaleSnapshots, undefined);
    assert.deepEqual(sample.paper.analysisManifest.stages.primaryAnalysis.factReview, originalBound.proof);
});

test('只有已核验反馈匹配的最终正文可保留真实原输入快照', async t => {
    for (const stage of ['primaryAnalysis', 'scoringAudit']) {
        const sample = await fixture(t);
        const originalAnalysis = sample.paper.analysisCheckpoint || sample.paper.analysis;
        sample.paper.analysis = originalAnalysis;
        delete sample.paper.analysisCheckpoint;
        const bound = review.validateFeedback(sample.feedback, sample.plan, sample.paper);
        const beforeCheckpoints = structuredClone(sample.paper.analysisStageCheckpoints);
        review.withFactReview(bound, () => {
            deep.captureStaleAnalysisSnapshot(sample.paper, sample.paper.analysisManifest, stage, bound.proof.feedbackSha256);
        });
        const snapshot = sample.paper.analysisStaleSnapshots.at(-1);
        assert.equal(deep.validateStaleAnalysisSnapshot(snapshot).analysisCheckpoint, originalAnalysis);
        assert.equal(sample.paper.analysisCheckpoint, undefined);
        assert.deepEqual(sample.paper.analysisStageCheckpoints, beforeCheckpoints);
        sample.paper.analysis = baseline;
        sample.paper.analysisManifest.stages.primaryAnalysis.factReview = bound.proof;
        assert.equal(review.validateFeedback(sample.feedback, sample.plan, sample.paper).proof.feedbackSha256, bound.proof.feedbackSha256);

        const mismatchedPaper = structuredClone(sample.paper);
        delete mismatchedPaper.analysisStaleSnapshots;
        review.withFactReview(bound, () => {
            deep.captureStaleAnalysisSnapshot(mismatchedPaper, mismatchedPaper.analysisManifest, stage, bound.proof.feedbackSha256);
        });
        assert.notEqual(deep.validateStaleAnalysisSnapshot(mismatchedPaper.analysisStaleSnapshots.at(-1)).analysisCheckpoint, originalAnalysis);
        const ordinaryPaper = structuredClone(sample.paper);
        ordinaryPaper.analysis = originalAnalysis;
        delete ordinaryPaper.analysisStaleSnapshots;
        deep.captureStaleAnalysisSnapshot(ordinaryPaper, ordinaryPaper.analysisManifest, stage, 'ordinary');
        assert.notEqual(deep.validateStaleAnalysisSnapshot(ordinaryPaper.analysisStaleSnapshots.at(-1)).analysisCheckpoint, originalAnalysis);
    }
});


test('新检查点存在时同时保留已核反馈原正文与当前恢复进度', async t => {
    const sample = await fixture(t);
    const original = sample.paper.analysisCheckpoint || sample.paper.analysis;
    const bound = review.validateFeedback(sample.feedback, sample.plan, sample.paper);
    sample.paper.analysis = original;
    sample.paper.analysisCheckpoint = baseline;
    const checkpointBefore = sample.paper.analysisCheckpoint;
    const stagesBefore = structuredClone(sample.paper.analysisStageCheckpoints);
    review.withFactReview(bound, () => {
        deep.captureStaleAnalysisSnapshot(sample.paper, sample.paper.analysisManifest,
            'primaryAnalysis', bound.proof.feedbackSha256);
    });
    assert.equal(sample.paper.analysisStaleSnapshots.length, 2);
    assert.deepEqual(sample.paper.analysisStaleSnapshots.map(item =>
        deep.validateStaleAnalysisSnapshot(item).analysisCheckpoint), [original, baseline]);
    assert.equal(sample.paper.analysisCheckpoint, checkpointBefore);
    assert.deepEqual(sample.paper.analysisStageCheckpoints, stagesBefore);
    sample.paper.analysisManifest.stages.primaryAnalysis.factReview = bound.proof;
    deep.retainFinalFactReviewInputs(sample.paper, sample.paper.analysisManifest);
    assert.equal(sample.paper.analysisStaleSnapshots.length, 1);
    assert.equal(deep.validateStaleAnalysisSnapshot(sample.paper.analysisStaleSnapshots[0]).analysisCheckpoint, original);
    assert.equal(review.validateFeedback(sample.feedback, sample.plan, sample.paper).proof.feedbackSha256, bound.proof.feedbackSha256);
});
