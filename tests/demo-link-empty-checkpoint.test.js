'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const deep = require('../scripts/deep-analyzer');
function sample(demo = '') {
    return { arxivId: '2610.03381v1', title: '资源扫描不改正文', authors: [], categories: [],
        analysisCheckpoint: '最终已审正文', analysisStageCheckpoints: {
            primaryAnalysis: '主分析正文', openSourceScan: '开源扫描后的真实正文', demoLinkScan: demo,
        }, analysisManifest: { version: 1, stages: {}, contracts: {} } };
}
test('资源扫描空占位回到前一真实正文，原revision指纹不变；非空扫描仍采用', () => {
    const source = '封存原文包含方法与实验设置。'.repeat(100);
    const warm = sample('开源扫描后的真实正文');
    const a = deep.prepareTextRecoveryStage(warm, warm.analysisManifest, 'revision', warm.analysisCheckpoint, source);
    const cold = sample();
    const b = deep.prepareTextRecoveryStage(cold, cold.analysisManifest, 'revision', cold.analysisCheckpoint, source);
    assert.equal(b.inputAnalysis, '开源扫描后的真实正文');
    assert.equal(b.fingerprint, a.fingerprint);
    const changed = sample('合法的非空扫描后正文');
    const c = deep.prepareTextRecoveryStage(changed, changed.analysisManifest, 'revision', changed.analysisCheckpoint, source);
    assert.equal(c.inputAnalysis, '合法的非空扫描后正文');
    assert.notEqual(c.fingerprint, a.fingerprint);
    const other = sample(); other.analysisStageCheckpoints.openSourceScan = '';
    const d = deep.prepareTextRecoveryStage(other, other.analysisManifest, 'revision', other.analysisCheckpoint, source);
    assert.equal(d.inputAnalysis, ''); // 不能把其他文本阶段的空输出普遍视为有效正文。
    assert.notEqual(d.fingerprint, a.fingerprint);
});
test('revision真正失效时不会回退到资源扫描空占位', () => {
    const paper = sample(); paper.analysisManifest.stages.revision = { status: 'complete', fingerprint: '旧指纹' };
    assert.equal(deep.invalidateRecoveryStageIfChanged(paper, paper.analysisManifest, 'revision', '新指纹'), true);
    assert.equal(paper.analysisCheckpoint, '开源扫描后的真实正文');
});
