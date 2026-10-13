'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const Config = require('../scripts/config');
const engine = require('../scripts/analysis-engine');
const daily = require('../scripts/lib/daily-fresh-source-plan');
const fresh = require('../scripts/lib/fresh-analysis-context');
const status = require('../scripts/digest-status');
const utils = require('../scripts/utils');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
const { attachValidReaderTableAudit: completeLocalTableAudit } = require('./fixtures/local-reader-table-audit.cjs');

async function createSample(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'completed-status-sync-'));
    const keys = ['dailyFreshSourceRunsDir', 'deepAnalysisResult', 'filteredPapers', 'papers', 'papersLegacy', 'llmUsageDir'];
    const previous = Object.fromEntries(keys.map(key => [key, Config.FILES[key]]));
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'sources');
    for (const key of keys.slice(1)) Config.FILES[key] = path.join(root, key + '.json');
    t.after(() => { Object.assign(Config.FILES, previous); fs.rmSync(root, { recursive: true, force: true }); });
    const signed = require('./reader-signed-draft-fixture').fixture({ noFigures: true });
    const papers = ['2610.90003', '2610.90001', '2610.90002'].map(id => {
        const base = require('./valid-analysis-fixture').validAnalysisPaper(id);
        const paper = { ...base, ...structuredClone(signed.paper), arxivId: id, title: '正常成功状态同步样例' };
        paper.analysisManifest.version = base.analysisManifest.version;
        paper.analysisManifest.contracts = { ...base.analysisManifest.contracts, ...paper.analysisManifest.contracts };
        paper.analysisManifest.stages = { ...base.analysisManifest.stages, ...paper.analysisManifest.stages };
        const scoring = paper.analysisManifest.stages.scoringAudit;
        Object.assign(scoring, { scoringContract: 'api-scoring-audit-v2', audit: {}, stabilityWarning: false,
            auditSha256: require('../scripts/deep-analyzer').stableFingerprint({}), outputAnalysisSha256: sha(paper.analysis) });
        paper.analysisManifest.stages.openSourceScan.status = 'complete';
        paper.analysisManifest.sourceAcquisition.modelTextSanitizationContract =
            require('../scripts/lib/model-text-sanitization').MODEL_TEXT_SANITIZATION_CONTRACT;
        paper.analysisManifest.sourceAcquisition.promptRenderingContract =
            require('../scripts/lib/prompt-rendering-contract').PROMPT_RENDERING_CONTRACT;
        return paper;
    });
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-11', batchId: 'status-sync', papers });
    await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: options =>
        require('../scripts/lib/fresh-arxiv-rewrite-source').captureFreshArxivRewriteSource(options, {
            fetchText: async id => ({ ...signed.sourceDetails, source: 'html', sourceId: id,
                htmlAvailability: 'available', htmlAttempts: 1, warnings: [],
                url: 'https://arxiv.org/html/' + id, fetchedAt: '2026-10-11T00:00:00.000Z' }),
            fetchPdf: async id => ({ bytes: Buffer.from('%PDF-1.7\n' + id + '\n%%EOF\n'),
                url: 'https://arxiv.org/pdf/' + id, fetchedAt: '2026-10-11T00:00:00.000Z' })
        }) });
    await daily.withDailyFreshAnalysisContext(plan, () => {
        for (const paper of papers) fresh.attachFreshSourceRecord(paper, paper.analysisManifest, daily.readDailyFreshSource(plan, paper));
    });
    for (const paper of papers) {
        await completeLocalTableAudit(paper, daily.readDailyFreshSource(plan, paper));
        assert.equal(engine.isSuccessfulAnalysisRecord(paper), true, engine.getIncompleteAnalysisContentReason(paper));
        assert.equal(daily.isPaperReusableForAnalysis(paper, plan), true);
    }
    papers[2].latestAnalysisAttemptError = '本次Reader真实失败';
    papers[2].error = '本次Reader真实失败';
    const payload = { batchDate: plan.batchDate, batchId: plan.batchId,
        dailyFreshSourceRun: daily.dailyFreshSourceReference(plan), papers };
    write(Config.FILES.deepAnalysisResult, payload);
    write(Config.FILES.filteredPapers, { batchDate: plan.batchDate, batchId: plan.batchId, status: 'complete', papers });
    const database = { generation: 7, papers: Object.fromEntries(papers.map(paper => [paper.arxivId,
        { arxivId: paper.arxivId, unrelated: '保留原论文库字段', digestStatus: {
            status: 'analysis_failed', latestAttemptStatus: 'analysis_failed', batchDate: plan.batchDate
        } }])) };
    write(Config.FILES.papers, database);
    return { plan: daily.requireDailyFreshSourceRecoveryPlan(payload), payload, database };
}
test('混合旧成功与新失败：规范ID顺序真实持锁，只保存一次且不请求API', async t => {
    const sample = await createSample(t);
    let apiCalls = 0;
    t.mock.method(utils, 'requestLlmJson', async () => { apiCalls++; assert.fail('同步状态不允许API请求'); });
    const acquire = engine.withPaperAnalysisLock;
    const order = [];
    t.mock.method(engine, 'withPaperAnalysisLock', (paper, callback, options) => acquire(paper, () => {
        assert.equal(engine.paperAnalysisLockHeld(paper), true);
        order.push(paper.arxivId);
        return callback();
    }, options));
    const sourceBytes = fs.readFileSync(Config.FILES.deepAnalysisResult);
    const result = await status.synchronizeCompletedAnalysisDigestStatuses(Config.FILES.deepAnalysisResult, sample.plan, { batchDate: sample.plan.batchDate });
    assert.equal(result.updated, 2);
    assert.deepEqual(order, ['2610.90001', '2610.90003']);
    const saved = JSON.parse(fs.readFileSync(Config.FILES.papers));
    assert.equal(saved.generation, 8, '一次论文库保存只递增一次');
    for (const id of order) {
        assert.equal(saved.papers[id].digestStatus.status, 'analyzed');
        assert.equal(saved.papers[id].digestStatus.latestAttemptStatus, 'analyzed');
        assert.equal(saved.papers[id].digestStatus.batchDate, sample.plan.batchDate);
        assert.equal(saved.papers[id].unrelated, '保留原论文库字段');
    }
    assert.deepEqual(saved.papers['2610.90002'], sample.database.papers['2610.90002']);
    assert.deepEqual(fs.readFileSync(Config.FILES.deepAnalysisResult), sourceBytes);
    assert.equal(apiCalls, 0);
    const beforeRepeat = fs.readFileSync(Config.FILES.papers);
    const repeat = await status.synchronizeCompletedAnalysisDigestStatuses(Config.FILES.deepAnalysisResult, sample.plan);
    assert.equal(repeat.updated, 0);
    assert.deepEqual(fs.readFileSync(Config.FILES.papers), beforeRepeat);
});
test('取得锁前成功变为最新失败，不用旧成功覆盖新失败', async t => {
    const sample = await createSample(t);
    const acquire = engine.withPaperAnalysisLock;
    let switched = false;
    t.mock.method(engine, 'withPaperAnalysisLock', (paper, callback, options) => acquire(paper, () => {
        if (!switched) {
            switched = true;
            const latest = JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult));
            for (const current of latest.papers) current.latestAnalysisAttemptError = '等待锁期间的新失败';
            write(Config.FILES.deepAnalysisResult, latest);
        }
        return callback();
    }, options));
    const before = fs.readFileSync(Config.FILES.papers);
    const result = await status.synchronizeCompletedAnalysisDigestStatuses(Config.FILES.deepAnalysisResult, sample.plan, { batchDate: sample.plan.batchDate });
    assert.equal(result.updated, 0);
    assert.deepEqual(fs.readFileSync(Config.FILES.papers), before);
});
test('等待锁期间封存来源被替换，在论文库写入前停止', async t => {
    const sample = await createSample(t);
    const acquire = engine.withPaperAnalysisLock;
    let switched = false;
    t.mock.method(engine, 'withPaperAnalysisLock', (paper, callback, options) => acquire(paper, () => {
        if (!switched) {
            switched = true;
            const filename = path.join(sample.plan.sourcesDir, '2610.90001', 'generation-000001', 'source.txt');
            fs.appendFileSync(filename, 'changed source');
        }
        return callback();
    }, options));
    const before = fs.readFileSync(Config.FILES.papers);
    await assert.rejects(status.synchronizeCompletedAnalysisDigestStatuses(Config.FILES.deepAnalysisResult, sample.plan), /SHA|来源|source/i);
    assert.deepEqual(fs.readFileSync(Config.FILES.papers), before);
});
test('正常deep非零工作收尾同步跳过的旧成功，保留本次失败', async t => {
    const sample = await createSample(t);
    let apiCalls = 0;
    t.mock.method(utils, 'requestLlmJson', async () => { apiCalls++; assert.fail('状态测试不允许API请求'); });
    let attempted = 0;
    const result = await require('../scripts/deep-analysis-only').runDeepAnalysis({
        date: sample.plan.batchDate,
        analyzeBatch: async (papers, options) => {
            assert.deepEqual(papers.map(paper => paper.arxivId), ['2610.90002']);
            attempted = papers.length;
            const failed = sample.payload.papers.find(paper => paper.arxivId === '2610.90002');
            await options.onPaperResultLocked(failed, { success: false, result: {
                ...failed, analysis: null, parsed: null, error: '本次Reader真实失败',
                latestAnalysisAttemptStatus: 'failed', latestAnalysisAttemptError: '本次Reader真实失败'
            } });
            return { stats: { success: 0, failed: 1, skipped: 0, sourceCounts: {} } };
        }
    });
    assert.equal(attempted, 1);
    assert.equal(result.remaining, 1);
    const saved = JSON.parse(fs.readFileSync(Config.FILES.papers));
    for (const id of ['2610.90001', '2610.90003']) {
        assert.equal(saved.papers[id].digestStatus.status, 'analyzed');
        assert.equal(saved.papers[id].digestStatus.latestAttemptStatus, 'analyzed');
        assert.equal(saved.papers[id].digestStatus.batchDate, sample.plan.batchDate);
    }
    assert.equal(saved.papers['2610.90002'].digestStatus.latestAttemptStatus, 'analysis_failed');
    assert.equal(apiCalls, 0);
});
