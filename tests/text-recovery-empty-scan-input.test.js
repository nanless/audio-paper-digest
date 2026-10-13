'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
let requests = [];
const sourceProject = process.env.PD_RECOVERY_SOURCE_PROJECT;
const deep = require('../scripts/deep-analyzer');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const sampleAnalysis = '# 样例论文分析\n\n## 核心摘要\n这是一份非空正文。\n\n## 评分\n评分仅用于测试正常输入。';
const sourceText = '论文来源说明实验设置与方法。'.repeat(180);
function samplePaper() {
    return { arxivId: '2610.90001', title: '正常正文恢复样例',
        analysisCheckpoint: sampleAnalysis,
        analysisManifest: { version: 1, stages: {
            primaryAnalysis: { status: 'complete' }, openSourceScan: { status: 'complete' },
            demoLinkScan: { status: 'complete' }
        } },
        analysisStageCheckpoints: { primaryAnalysis: sampleAnalysis,
            openSourceScan: sampleAnalysis, demoLinkScan: '' } };
}
test('正文审校指纹与正常请求都读取非空正文，空资源扫描不改变恢复输入', async () => {
    const paper = samplePaper();
    const stage = deep.prepareTextRecoveryStage(paper, paper.analysisManifest, 'revision', sampleAnalysis, sourceText);
    assert.equal(stage.inputAnalysis, sampleAnalysis);
    assert.equal(stage.inputAnalysisSha256, sha(sampleAnalysis));
    assert.notEqual(stage.inputAnalysisSha256, sha(''));
    requests = [];
    await assert.rejects(deep.reviseAnalysis(paper, stage.analysis, sourceText, stage.evidenceContext, {
        callModelFn: async messages => {
            requests.push(messages);
            throw new Error('测试在正式模型路由停止');
        }
    }), /正式模型路由停止/);
    assert.equal(requests.length, 1);
    assert.ok(requests[0][0].content.includes(sampleAnalysis));
    paper.analysisManifest.stages.revision = { status: 'complete',
        inputAnalysisSha256: stage.inputAnalysisSha256, evidenceSha256: stage.evidenceSha256,
        evidenceChars: stage.evidenceChars, promptTextContract: stage.promptTextContract,
        fingerprint: stage.fingerprint };
    paper.analysisStageCheckpoints.revision = sampleAnalysis + '\n已审校。';
    const restored = deep.prepareTextRecoveryStage(paper, paper.analysisManifest, 'revision', sampleAnalysis, sourceText);
    assert.equal(restored.invalidated, false);
    assert.equal(restored.fingerprint, stage.fingerprint);
    assert.equal(requests.length, 1, '恢复已保存正常阶段不再次进入模型');
});
test('实际正文或来源变化仍失效旧审校，不能用空占位跳过正常重分析', () => {
    for (const change of ['analysis', 'source']) {
        const paper = samplePaper();
        const first = deep.prepareTextRecoveryStage(paper, paper.analysisManifest, 'revision', sampleAnalysis, sourceText);
        paper.analysisManifest.stages.revision = { status: 'complete', fingerprint: first.fingerprint,
            inputAnalysisSha256: first.inputAnalysisSha256, promptTextContract: first.promptTextContract };
        paper.analysisStageCheckpoints.revision = sampleAnalysis + '\n已审校。';
        if (change === 'analysis') paper.analysisStageCheckpoints.openSourceScan += '\n真正不同的正文。';
        const next = deep.prepareTextRecoveryStage(paper, paper.analysisManifest, 'revision', sampleAnalysis,
            change === 'source' ? sourceText + '\n新来源证据。' : sourceText);
        assert.equal(next.invalidated, true, change);
        assert.equal(paper.analysisManifest.stages.revision, undefined);
    }
});

test('真实已付费新审校检查点的输入与保存指纹一致，不因空资源扫描再次失效', {
    skip: !sourceProject
}, async t => {
    const fs = require('node:fs');
    const path = require('node:path');
    const Config = require('../scripts/config');
    const daily = require('../scripts/lib/daily-fresh-source-plan');
    const facts = require('../scripts/lib/daily-fact-review');
    const fresh = require('../scripts/lib/fresh-analysis-context');
    const project = sourceProject;
    const oldRoot = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(project, 'data/runtime/daily-fresh-source-runs');
    t.after(() => { Config.FILES.dailyFreshSourceRunsDir = oldRoot; });
    const payload = JSON.parse(fs.readFileSync(path.join(project, 'data/current/deep-analysis-result.json')));
    const plan = daily.requireDailyFreshSourceRecoveryPlan(payload);
    for (const id of ['2610.03398', '2610.03017']) {
        const paper = structuredClone(payload.papers.find(p => p.arxivId.replace(/v\d+$/, '') === id));
        const saved = structuredClone(paper.analysisManifest.stages.revision);
        assert.equal(saved.status, 'complete');
        assert.notEqual(saved.inputAnalysisSha256, sha(''));
        const source = daily.readDailyFreshSource(plan, paper);
        const filename = path.join(daily.factFeedbackDirectory(plan), saved.factReview.feedbackSha256 + '.json');
        const bound = facts.validateFeedback(facts.readFeedback(filename), plan, paper);
        await daily.withDailyFreshAnalysisContext(plan, () => daily.withDailyFreshPaperSource(plan, paper,
            () => fresh.withFreshPaperContext(paper, () => facts.withFactReview(bound, () => {
                const next = deep.prepareTextRecoveryStage(paper, paper.analysisManifest, 'revision',
                    paper.analysisCheckpoint, source.text);
                assert.equal(next.inputAnalysisSha256, saved.inputAnalysisSha256, id);
                assert.equal(next.fingerprint, saved.fingerprint, id);
                assert.equal(next.invalidated, false, id);
                assert.deepEqual(paper.analysisManifest.stages.revision, saved, id);
            }))));
    }
});
