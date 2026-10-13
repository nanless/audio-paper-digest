'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const utils = require('../scripts/utils'); utils.loadEnvFile = () => {};
process.env.PAPER_ANALYZER_MODEL = 'test-model'; process.env.PAPER_ANALYZER_ENDPOINT = 'https://example.invalid/v1';
process.env.PAPER_ANALYZER_API_KEY = 'test-only';
const requests = [];
utils.requestLlmJson = async (url, endpoint, model, request, headers, options) => {
    assert.equal(options.usageContext.stage, 'apiReaderTableAudit'); requests.push(options.usageContext.stage);
    const text = require('./fixtures/local-llm-response.cjs').requestText(request);
    const input = JSON.parse(text.slice(text.lastIndexOf('待审输入：') + '待审输入：'.length).trim());
    const raw = JSON.stringify({ version: 1, inputSha256: input.inputSha256,
        tables: input.tables.map(table => ({ tableIndex: table.tableIndex, issues: [] })) });
    const response = require('./fixtures/local-llm-response.cjs').localLlmResponse(endpoint, model, raw);
    options.usageSink(require('../scripts/lib/llm-usage').buildLlmUsageEvent({ model,
        protocol: utils.detectApiType(endpoint, model), request, response: response.body, statusCode: 200,
        outputText: raw, context: options.usageContext }));
    return response;
};
const Config = require('../scripts/config'); const deep = require('../scripts/deep-analyzer');
const engine = require('../scripts/analysis-engine'); const daily = require('../scripts/lib/daily-fresh-source-plan');
const fresh = require('../scripts/lib/fresh-analysis-context'); const sourceApi = require('../scripts/lib/fresh-arxiv-rewrite-source');
const facts = require('../scripts/lib/daily-fact-review'); const audit = require('../scripts/lib/reader-table-semantic-audit');
async function sample(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'normal-table-audit-'));
    const original = { daily: Config.FILES.dailyFreshSourceRunsDir, locks: Config.FILES.paperAnalysisLocksDir };
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs'); Config.FILES.paperAnalysisLocksDir = path.join(root, 'locks');
    t.after(() => { Config.FILES.dailyFreshSourceRunsDir = original.daily; Config.FILES.paperAnalysisLocksDir = original.locks; fs.rmSync(root,{recursive:true,force:true}); });
    const signed = require('./reader-signed-draft-fixture').fixture({ noFigures: true,
        sourceText: 'The source reports a controlled measurement of 1.0 under the same protocol. '.repeat(80) });
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-11', batchId: 'normal-audit-test',
        papers: [{ arxivId: signed.paper.arxivId, title: '受控测量', authors: signed.paper.authors }] });
    await daily.captureDailyFreshSources(plan, { capture: options => sourceApi.captureFreshArxivRewriteSource(options, {
        fetchText: async id => ({ ...signed.sourceDetails, source:'html', htmlAvailability:'available', htmlAttempts:1,
            sourceId:id, url:`https://arxiv.org/html/${id}`, fetchedAt:'2026-10-11T00:00:00.000Z', warnings:[] }),
        fetchPdf: async id => ({ bytes:Buffer.from('%PDF-1.7\n%%EOF\n'), url:`https://arxiv.org/pdf/${id}`, fetchedAt:'2026-10-11T00:00:00.000Z' }) }) });
    const valid = require('./valid-analysis-fixture').validAnalysisPaper(signed.paper.arxivId);
    const paper = { ...valid, ...signed.paper };
    paper.parsed = utils.parseAnalysis(paper.analysis);
    paper.analysisManifest.version = valid.analysisManifest.version;
    paper.analysisManifest.contracts = { ...valid.analysisManifest.contracts, ...paper.analysisManifest.contracts };
    paper.analysisManifest.stages = { ...valid.analysisManifest.stages, ...paper.analysisManifest.stages };
    Object.assign(paper.analysisManifest.stages.scoringAudit, { scoringContract:'api-scoring-audit-v2', audit:{},
        auditSha256:deep.stableFingerprint({}), outputAnalysisSha256:facts.sha(paper.analysis), stabilityWarning:false });
    paper.analysisManifest.stages.openSourceScan.status='complete';
    const source = daily.readDailyFreshSource(plan,paper);
    await daily.withDailyFreshAnalysisContext(plan,()=>fresh.attachFreshSourceRecord(paper,paper.analysisManifest,source));
    assert.equal(engine.getIncompleteAnalysisContentReason(paper),audit.PENDING_REASON);
    return { paper,plan,source };
}
test('正常deep完整旧稿无主文检查点时只审校，绝不重跑主文或Reader', async t => {
    const f = await sample(t); requests.length=0;
    assert.equal(f.paper.analysisCheckpoint,undefined);
    const stages=structuredClone(f.paper.analysisManifest.stages); const article=f.paper.apiReaderArticle;
    const result=await daily.withDailyFreshAnalysisContext(f.plan,()=>deep.analyzePaperDeep(f.paper));
    assert.deepEqual(requests,['apiReaderTableAudit']); assert.equal(result.apiReaderArticle,article);
    for(const [name,stage] of Object.entries(stages)) assert.deepEqual(result.analysisManifest.stages[name],stage);
    assert.equal(engine.getIncompleteAnalysisContentReason(result),null);
});
test('日更夹带历史身份不能免审校，来源恢复在模型请求前拒绝', async t => {
    const f = await sample(t);
    f.paper.directPaperId = `arxiv:${f.paper.arxivId}`;
    assert.equal(audit.requiresAudit(f.paper), true);
    assert.throws(() => daily.readDailyFreshSource(f.plan, f.paper), /日更论文不能夹带历史直改身份/);
    assert.equal(engine.getIncompleteAnalysisContentReason(f.paper), audit.PENDING_REASON);
    assert.throws(() => daily.requireDailyFreshSourceRecoveryPlan({
        batchDate: f.plan.batchDate, dailyFreshSourceRun: daily.dailyFreshSourceReference(f.plan),
        papers: [f.paper]
    }), /日更论文不能夹带历史直改身份/);
    delete f.paper.directPaperId;
    f.paper.freshRewriteProvenance.runId = '../../missing';
    f.paper.directPaperId = `arxiv:${f.paper.arxivId}`;
    assert.equal(audit.requiresAudit(f.paper), true, '坏运行身份不能获得历史兼容');
    f.paper.freshRewriteProvenance.runId = '00000000-0000-4000-8000-000000000099';
    f.paper.directPaperId = 'arxiv:2610.99999';
    assert.equal(audit.requiresAudit(f.paper), true, '另一篇历史身份不能豁免当前论文');
    f.paper.directPaperId = `arxiv:${f.paper.arxivId}`;
    assert.equal(audit.requiresAudit(f.paper), false, '未登记的合法历史身份仅保留旧校验范围');
});
test('正常deep已核父说明与独立核心说明保持原绑定，仅追加审校', async t => {
    const f=await sample(t); requests.length=0;
    const folder=path.join(f.plan.sourcesDir,f.paper.arxivId,'generation-000001');
    const feedback={contract:facts.CONTRACT,paperId:f.paper.arxivId,runId:f.plan.runId,batchDate:f.plan.batchDate,
        sourceFiles:Object.fromEntries(['source.txt','source.pdf','source-runtime.json','source-manifest.json'].map(name=>[name,facts.sha(fs.readFileSync(path.join(folder,name)))])),
        coreAnalysisSha256:facts.sha(f.paper.analysis),coreSummarySha256:facts.sha(deep.extractSectionByTitle(f.paper.analysis,'核心摘要')),
        primaryFeedback:'保留原文真实受控测量结论。',coreFeedback:'',readerFeedback:'保留真实比较条件，不猜测未测指标。',
        rejectedPrimaryClaims:['已修正的旧主文错误'],rejectedCoreClaims:[],rejectedReaderClaims:['已修正的旧Reader错误'],sourceQuotes:['The source reports a controlled measurement of 1.0 under the same protocol.']};
    const parent=facts.validateFeedback(feedback,f.plan,f.paper);
    const core=facts.validateFeedback({...feedback,primaryFeedback:'',readerFeedback:'',coreFeedback:'保留真实核心摘要的结论和限制。',rejectedPrimaryClaims:[],rejectedReaderClaims:[],rejectedCoreClaims:['已修正的旧核心错误']},f.plan,f.paper);
    for(const name of ['primaryAnalysis','openSourceScan','revision','tableRepair','methodRepair','structureRepair','scoringAudit','apiReaderArticle']) f.paper.analysisManifest.stages[name].factReview=parent.proof;
    f.paper.analysisManifest.stages.coreSummaryRepair.factReview=core.proof;
    const before=structuredClone(f.paper.analysisManifest.stages);
    const result=await daily.withDailyFreshAnalysisContext(f.plan,()=>engine.withPaperAnalysisLock(f.paper,()=>facts.withFactReview(parent,()=>facts.withCoreSummaryFactReview(core,f.paper,()=>deep.analyzePaperDeep(f.paper)))));
    assert.deepEqual(requests,['apiReaderTableAudit']);
    for(const [name,stage] of Object.entries(before)) assert.deepEqual(result.analysisManifest.stages[name],stage);
    assert.equal(engine.getIncompleteAnalysisContentReason(result),null);
});
test('正常batch通过日更来源恢复函数只追加Audit，保留上游与原Reader', async t => {
    const f=await sample(t); requests.length=0;
    const before=structuredClone(f.paper.analysisManifest.stages); const article=f.paper.apiReaderArticle;
    const result=await engine.analyzeBatch([f.paper],{ concurrency:10,maxRetries:1,retryDelayMs:0,
        analyzeFn:daily.createDailyAnalyzeFn(f.plan),onPaperCheckpointLocked(){} });
    assert.deepEqual(requests,['apiReaderTableAudit']);
    assert.equal(result.results[0].apiReaderArticle,article);
    assert.equal(engine.getIncompleteAnalysisContentReason(result.results[0]),null);
    for(const [name,stage] of Object.entries(before)) assert.deepEqual(result.results[0].analysisManifest.stages[name],stage);
});
