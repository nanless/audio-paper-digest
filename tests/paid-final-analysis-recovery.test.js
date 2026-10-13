'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const sourceRoot = process.env.PD_PAID_FINAL_RECOVERY_SOURCE_PROJECT;
const testManifest = process.env.PD_PAID_FINAL_RECOVERY_TEST_MANIFEST;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
if (sourceRoot) require(path.join(sourceRoot, 'scripts/utils')).loadEnvFile();
const actualEnvironment = { ...process.env };
const Config = require('../scripts/config');
if (sourceRoot) Object.assign(process.env, actualEnvironment);
const utils = require('../scripts/utils');
let modelRequests = 0;
utils.requestLlmJson = async () => { modelRequests++; throw new Error('恢复检查禁止新增模型请求'); };
if (sourceRoot) utils.loadEnvFile = () => Object.assign(process.env, actualEnvironment);
const engine = require('../scripts/analysis-engine');
const daily = require('../scripts/lib/daily-fresh-source-plan');
const recovery = require('../scripts/lib/paid-final-analysis-recovery');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

test('没有确切原记录时拒绝恢复，普通失败不能借零模型恢复入口', async () => {
    const paper = { arxivId: '9999.00001', latestAnalysisAttemptErrorCode: 'PRIMARY_FAILURE' };
    await engine.withPaperAnalysisLock(paper, () => assert.rejects(
        recovery.restorePaidFinalAnalysis(paper, {}, { paperSha256: daily.stableHash(paper) }), /不是已核验/
    ));
    assert.equal(modelRequests, 0);
});

test('真实原付费阶段逐项重放，错记录、来源、主文指纹或新长文均拒绝', {
    skip: !sourceRoot || !testManifest ? '需明确提供真实来源项目，默认不把跳过记为实际重放通过' : false
}, async () => {
    const previous = { ...Config.FILES };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paid-final-recovery-test-'));
    try {
        Config.FILES.dailyFreshSourceRunsDir = path.join(sourceRoot, 'data/runtime/daily-fresh-source-runs');
        Config.FILES.analysisRepairAttemptsDir = path.join(sourceRoot, 'data/runtime/analysis-repair-attempts');
        const sample = JSON.parse(fs.readFileSync(testManifest, 'utf8'));
        assert.ok(sample.analysisDataFile, '须提供独立稳定的分析记录副本，避免与生产写入竞争');
        Config.FILES.deepAnalysisResult = sample.analysisDataFile.path;
        const bytes = fs.readFileSync(Config.FILES.deepAnalysisResult);
        assert.equal(hash(bytes),sample.analysisDataFile.sha256);
        const data = JSON.parse(bytes);
        const paper = data.papers.find(row => utils.normalizedId(row) === sample.paperId);
        assert.ok(paper);
        const plan = daily.requireDailyFreshSourceRecoveryPlan(data);
        const reference = file => ({ path: file, sha256: hash(fs.readFileSync(file)) });
        const expected = { ...sample, paperSha256: daily.stableHash(paper) };
        const before = JSON.stringify(paper);
        await daily.withDailyFreshAnalysisContext(plan, () => engine.withPaperAnalysisLock(paper, async () => {
            const candidate = await recovery.restorePaidFinalAnalysis(paper, plan, expected);
            assert.equal(candidate.analysisManifest.stages.primaryAnalysis.status, 'complete');
            assert.equal(candidate.analysis, paper.analysis);
            assert.equal(candidate.latestAnalysisAttemptError, paper.latestAnalysisAttemptError);
            assert.equal(candidate.apiReaderArticle, paper.apiReaderArticle);
            assert.equal(hash(candidate.analysisCheckpoint), candidate.analysisManifest.stages.scoringAudit.outputAnalysisSha256);
            assert.equal(candidate.paidFinalAnalysisRecoveries.length, 1);
            for (const field of ['sourceSha256', 'structuredArtifactsSha256', 'apiReaderArticleSha256', 'apiReaderPlanSha256']) assert.equal(candidate[field], paper[field]);
            await assert.rejects(recovery.restorePaidFinalAnalysis(paper, plan, { ...expected, paperSha256: '0'.repeat(64) }), /当前失败记录/);
            await assert.rejects(recovery.restorePaidFinalAnalysis(paper, plan, { ...expected, diagnosticId: 'wrong' }), /付费摘要/);
            const wrongReader = structuredClone(paper); wrongReader.apiReaderArticle += '\n改变';
            await assert.rejects(recovery.restorePaidFinalAnalysis(wrongReader, plan, { ...expected, paperSha256: daily.stableHash(wrongReader) }), /已付费长文/);
            const wrongSource = structuredClone(paper); wrongSource.sourceSha256 = '0'.repeat(64);
            await assert.rejects(recovery.restorePaidFinalAnalysis(wrongSource, plan, { ...expected, paperSha256: daily.stableHash(wrongSource) }), /sourceSha256/);
            const original = JSON.parse(fs.readFileSync(expected.completedSnapshot.path));
            const originalPaper = (Array.isArray(original) ? original : original.papers).find(row => utils.normalizedId(row) === sample.paperId);
            originalPaper.analysisManifest.stages.primaryAnalysis.fingerprint = '0'.repeat(64);
            const bad = path.join(directory, 'wrong-primary.json'); fs.writeFileSync(bad, JSON.stringify(original));
            await assert.rejects(recovery.restorePaidFinalAnalysis(paper, plan, { ...expected, completedSnapshot: reference(bad) }), /主分析检查记录/);
        }), { refreshReaderDiagnostics: true });
        assert.equal(JSON.stringify(paper), before);
        assert.equal(hash(fs.readFileSync(Config.FILES.deepAnalysisResult)), hash(bytes));
        assert.equal(modelRequests, 0);
    } finally {
        Object.assign(Config.FILES, previous);
        fs.rmSync(directory, { recursive: true, force: true });
    }
});


test('无需本机来源也能拒绝无锁、错误文件哈希和错论文记录', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paid-final-invalid-'));
    const paper = { arxivId: '9999.00002', latestAnalysisAttemptErrorCode: 'ZERO_MODEL_ROUTE_GUARD',
        latestAnalysisAttemptError: '已付费恢复禁止新增模型请求',
        analysisManifest: { stages: { primaryAnalysis: { status: 'transient_failure', error: '已付费恢复禁止新增模型请求' } } } };
    const expected = { paperSha256: daily.stableHash(paper) };
    try {
        await assert.rejects(recovery.restorePaidFinalAnalysis(paper, {}, expected), /须持有论文锁/);
        const file = path.join(directory, 'original.json'); fs.writeFileSync(file, JSON.stringify([{ arxivId: '9999.00003' }]));
        const ref = { path: file, sha256: hash(fs.readFileSync(file)) };
        await engine.withPaperAnalysisLock(paper, async () => {
            await assert.rejects(recovery.restorePaidFinalAnalysis(paper, {}, { ...expected, inputSnapshot: { ...ref, sha256: '0'.repeat(64) } }), /原记录文件已改变/);
            await assert.rejects(recovery.restorePaidFinalAnalysis(paper, {}, { ...expected, inputSnapshot: ref }), /原论文缺失/);
        });
        assert.equal(modelRequests, 0);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
