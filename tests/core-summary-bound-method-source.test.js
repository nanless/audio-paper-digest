'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Config = require('../scripts/config');
const daily = require('../scripts/lib/daily-fresh-source-plan');
const fresh = require('../scripts/lib/fresh-analysis-context');
const contract = require('../scripts/analysis-contract');
const { validAnalysisText, validAnalysisPaper } = require('./valid-analysis-fixture');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
function createSample() {
    const analysis = validAnalysisText().replace('在公开测试集的相同协议下，词错误率从 12.4% 降至 9.8%，指标方向和比较对象都能由原文结果核对。', '在GTZAN数据集的相同协议下，以下拍F1为指标，测试方法为80.45%，高于比较对象Beat This!的78.28%。这些数值只对应上述测试协议，不能直接推断其他音乐类型的结果。');
    return validAnalysisPaper('2610.05336', {}, analysis);
}
async function createSealedSample(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'core-bound-method-'));
    const previous = { runs: Config.FILES.dailyFreshSourceRunsDir, data: Config.FILES.deepAnalysisResult };
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs');
    Config.FILES.deepAnalysisResult = path.join(root, 'deep.json');
    t.after(() => { Config.FILES.dailyFreshSourceRunsDir = previous.runs; Config.FILES.deepAnalysisResult = previous.data; fs.rmSync(root, { recursive: true, force: true }); });
    const paper = createSample();
    const text = 'Beat This! 在 GTZAN 下拍 F1 78.28%，测试方法80.45%。 methods data results limitations. '.repeat(150);
    const artifacts = { version: 1, source: 'html', flattenedTextSha256: sha(text), tables: [], formulas: [], figures: [] };
    artifacts.payloadSha256 = sha(JSON.stringify(artifacts));
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-12', batchId: 'core-method-source-test', papers: [paper] });
    await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: options => require('../scripts/lib/fresh-arxiv-rewrite-source').captureFreshArxivRewriteSource(options, {
        fetchText: async () => ({ text, source: 'html', sourceId: paper.arxivId, url: `https://arxiv.org/html/${paper.arxivId}`, fetchedAt: new Date().toISOString(), imageInfos: [], structuredArtifacts: artifacts, readerAuthors: { authors: [] }, htmlAvailability: 'available', htmlAttempts: 1, warnings: [] }),
        fetchPdf: async () => ({ bytes: Buffer.from('%PDF-1.7\nsealed test\n%%EOF\n'), url: `https://arxiv.org/pdf/${paper.arxivId}`, sourceId: paper.arxivId }),
        extractPdfText: async () => ({ text: 'PDF methods experiments results limitations. '.repeat(150) })
    }) });
    await daily.withDailyFreshAnalysisContext(plan, () => {
        const source = daily.readDailyFreshSource(plan, paper);
        paper.sourceSha256 = source.freshSourceDescriptor.sourceSha256;
        paper.analysisManifest.sourceAcquisition = { sourceSha256: paper.sourceSha256 };
        fresh.attachFreshSourceRecord(paper, paper.analysisManifest, source);
    });
    const data = { batchDate: plan.batchDate, papers: [paper], dailyFreshSourceRun: daily.dailyFreshSourceReference(plan) };
    fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify(data));
    return { paper, plan, text, root };
}
test('冷态最终阶段从真实封存来源核方法名，不改论文与来源字节', async t => {
    const { paper, plan } = await createSealedSample(t);
    const before = JSON.stringify(paper);
    const sourcePath = path.join(plan.sourcesDir, paper.arxivId, 'generation-000001', 'source.txt');
    const bytes = fs.readFileSync(sourcePath);
    assert.equal(contract.validateCoreSummaryStageBinding(paper), null);
    assert.equal(require('../scripts/analysis-engine').getIncompleteAnalysisContentReason(paper), null, '实际最终资格出口不得再次误拒核心摘要');
    assert.equal(JSON.stringify(paper), before);
    assert.deepEqual(fs.readFileSync(sourcePath), bytes);
    await daily.withDailyFreshAnalysisContext(plan, () => assert.equal(contract.validateCoreSummaryStageBinding(paper), null));
});
test('缺来源计划、改封存文本、错误论文绑定均拒绝最终阶段', async t => {
    const { paper, plan } = await createSealedSample(t);
    const data = fs.readFileSync(Config.FILES.deepAnalysisResult);
    fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify({ papers: [paper] }));
    assert.match(contract.validateCoreSummaryStageBinding(paper), /原封存来源未通过核验/);
    fs.writeFileSync(Config.FILES.deepAnalysisResult, data);
    const wrong = structuredClone(paper); wrong.freshRewriteProvenance.sourceSha256 = 'a'.repeat(64);
    assert.match(contract.validateCoreSummaryStageBinding(wrong), /原封存来源未通过核验/);
    fs.appendFileSync(path.join(plan.sourcesDir, paper.arxivId, 'generation-000001', 'source.txt'), 'changed');
    assert.match(contract.validateCoreSummaryStageBinding(paper), /原封存来源未通过核验/);
});
test('显式来源旧重载仍严格，普通摘要不依赖冷态来源文件', () => {
    const paper = createSample();
    assert.equal(contract.validateCoreSummaryStageBinding(paper, 'Beat This! GTZAN F1 results 80.45 78.28'), null);
    assert.match(contract.validateCoreSummaryStageBinding(paper, { sourceText: '' }), /关键定量结果/);
    assert.equal(contract.validateCoreSummaryStageBinding(validAnalysisPaper('2610.09999')), null);
});
