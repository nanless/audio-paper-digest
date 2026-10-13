'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const recovery = require('../scripts/lib/cancelled-reader-audit-recovery');

test('未知失败与普通Reader失败不能借取消审校跳过正常阶段', () => {
    for (const code of [undefined, 'MODEL_HTTP_TRANSIENT', 'READER_REPAIR_NO_PROGRESS']) {
        assert.equal(recovery.reusableCancelledReaderAuditResult({ latestAnalysisAttemptErrorCode: code }), null);
    }
});

test('真实取消阶段失败走公共engine和实际deep零模型收尾，原正文与请求费用不变', {
    skip: !process.env.PD_CANCELLED_AUDIT_REAL_PROJECT
}, async () => {
    const root = path.resolve(process.env.PD_CANCELLED_AUDIT_REAL_PROJECT);
    // 在生产模块加载之前封死所有传输入口，避免模块捕获未替换的请求函数。
    let networkAttempts = 0;
    const restoreNetwork = [];
    for (const [target, names] of [
        [require('node:http'), ['request', 'get']],
        [require('node:https'), ['request', 'get']],
        [require('node:net'), ['connect', 'createConnection']],
        [require('node:tls'), ['connect']],
        [globalThis, ['fetch']]
    ]) for (const name of names) {
        const original = target[name];
        restoreNetwork.push(() => { target[name] = original; });
        target[name] = () => { networkAttempts++; throw new Error('禁止测试网络请求'); };
    }
    const Config = require(path.join(root, 'scripts/config'));
    const utils = require(path.join(root, 'scripts/utils'));
    const daily = require(path.join(root, 'scripts/lib/daily-fresh-source-plan'));
    const engine = require(path.join(root, 'scripts/analysis-engine'));
    const raw = fs.readFileSync(Config.FILES.deepAnalysisResult);
    const data = JSON.parse(raw);
    const original = data.papers.find(p => p.arxivId.startsWith('2610.04690'));
    assert.equal(original.latestAnalysisAttemptErrorCode, 'READER_TABLE_AUDIT_REJECTED');
    const paper = structuredClone(original);
    const before = structuredClone(paper);
    const plan = daily.requireDailyFreshSourceRecoveryPlan(data);
    let requests = 0;
    const request = utils.requestLlmJson;
    utils.requestLlmJson = async () => { requests++; throw new Error('禁止测试请求模型'); };
    try {
        const result = await daily.withDailyFreshAnalysisContext(plan, () =>
            engine.withPaperAnalysisLock(paper, () => engine.analyzePaperWithRetry(paper, { maxRetries: 0 })));
        assert.equal(result.success, true);
        assert.equal(requests, 0);
        assert.equal(networkAttempts, 0);
        assert.equal(result.result.latestAnalysisAttemptError, undefined);
        assert.equal(result.result.analysis, before.analysis);
        assert.equal(result.result.apiReaderArticle, before.apiReaderArticle);
        for (const stage of ['primaryAnalysis', 'coreSummaryRepair', 'scoringAudit', 'apiReaderArticle', 'apiReaderTableAudit']) {
            assert.deepEqual(result.result.analysisManifest.stages[stage], before.analysisManifest.stages[stage]);
        }
        const fresh = require(path.join(root, 'scripts/lib/fresh-analysis-context'));
        await daily.withDailyFreshAnalysisContext(plan, () => {
            for (const alter of [
                p => { p.analysis = '坏主文'; },
                p => { p.analysisManifest.stages.scoringAudit.outputAnalysisSha256 = '0'.repeat(64); },
                p => { p.sourceSha256 = '0'.repeat(64); }
            ]) {
                const changed = structuredClone(original); alter(changed);
                assert.equal(recovery.reusableCancelledReaderAuditResult(changed), null);
            }
            for (const alter of [
                p => { p.analysisManifest.stages.apiReaderTableAudit.records[0].requestReceipts = []; },
                p => { p.analysisManifest.stages.apiReaderTableAudit.records[0].requestReceipts[0].unitId = '0'.repeat(64);
                    p.analysisManifest.stages.apiReaderTableAudit.records[0].requestReceipts[1].unitId = '0'.repeat(64); },
                p => { p.analysisManifest.stages.apiReaderTableAudit.records[0].rawResponse = '损坏响应'; },
                p => { p.freshRewriteProvenance.sourceManifestSha256 = '0'.repeat(64); }
            ]) {
                const changed = structuredClone(original); alter(changed);
                assert.throws(() => fresh.withFreshPaperContext(changed, () => recovery.reusableCancelledReaderAuditResult(changed)));
            }
        });
        assert.deepEqual(fs.readFileSync(Config.FILES.deepAnalysisResult), raw);
        assert.equal(networkAttempts, 0);
    } finally {
        utils.requestLlmJson = request;
        for (const restore of restoreNetwork) restore();
    }
});
