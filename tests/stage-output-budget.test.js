'use strict';

require('./core-diagnostics-test-isolation')();

const test = require('node:test');
const assert = require('node:assert/strict');
const Config = require('../scripts/config.js');
const deep = require('../scripts/deep-analyzer.js');
const { validAnalysisText } = require('./valid-analysis-fixture.js');

test('摘要与整篇结构修复使用各自容量，截断原错误直接传出', async () => {
    const paper = { arxivId: '2610.02582', title: '受控测试论文' };
    const analysis = validAnalysisText().replace(/## 核心摘要\n[\s\S]*?(?=\n## 方法概述和架构)/,
        '## 核心摘要\n摘要仍需展开。\n');
    for (const [stage, repair, budget] of [
        ['coreSummaryRepair', deep.repairCoreSummarySection, Config.ANALYSIS_CONFIG.coreSummaryRepairMaxTokens],
        ['structureRepair', deep.repairMissingAnalysisSections, Config.ANALYSIS_CONFIG.structureMaxTokens]
    ]) {
        const calls = [];
        const failure = Object.assign(new Error('本地响应未输出完'), { code: 'MODEL_OUTPUT_TRUNCATED' });
        await assert.rejects(repair(paper, stage === 'structureRepair' ? '缺少正式章节' : analysis,
            '原文证据', '本次受控证据', { callModelFn: async (messages, requestedBudget, options) => {
                calls.push({ messages, requestedBudget, options });
                throw failure;
            } }), error => error === failure);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].requestedBudget, budget);
        assert.equal(calls[0].options.usageContext.stage, stage);
        assert.match(calls[0].messages[0].content, /本次受控证据/);
    }
});

test('独立容量只改变新版本阶段，旧版本及主分析预算保持', () => {
    const modulePath = require.resolve('../scripts/deep-analyzer.js');
    const originalModule = require.cache[modulePath];
    const original = {
        coreSummaryRepairMaxTokens: Config.ANALYSIS_CONFIG.coreSummaryRepairMaxTokens,
        structureMaxTokens: Config.ANALYSIS_CONFIG.structureMaxTokens
    };
    const values = analyzer => Object.fromEntries(['coreSummaryRepair', 'structureRepair'].map(stage => [stage, {
        current: analyzer.buildTextStageFingerprint(stage, '同一输入', '同一证据', analyzer.currentPromptTextContract(stage)),
        old: ['', 'analysis-prompt-text-v1', 'analysis-prompt-text-v2'].map(contract =>
            analyzer.buildTextStageFingerprint(stage, '同一输入', '同一证据', contract)),
        migrated: analyzer.buildLegacyCoreSummaryV2TextFingerprint(stage, '同一输入', '同一证据')
    }]));
    const unrelated = analyzer => ({
        primary: analyzer.buildRecoveryFingerprints({ arxivId: '2610.02582', title: '同一论文', authors: [], categories: [] },
            '同一来源', '2610.02582').primaryAnalysis,
        revision: analyzer.buildTextStageFingerprint('revision', '同一输入', '同一证据', analyzer.currentPromptTextContract('revision')),
        table: analyzer.buildTextStageFingerprint('tableRepair', '同一输入', '同一证据', analyzer.currentPromptTextContract('tableRepair'))
    });
    const before = values(deep);
    const otherBefore = unrelated(deep);
    try {
        Config.ANALYSIS_CONFIG.coreSummaryRepairMaxTokens += 1000;
        Config.ANALYSIS_CONFIG.structureMaxTokens += 1000;
        delete require.cache[modulePath];
        const changed = require(modulePath);
        const after = values(changed);
        assert.deepEqual(unrelated(changed), otherBefore);
        for (const stage of Object.keys(before)) {
            assert.notEqual(after[stage].current, before[stage].current);
            assert.deepEqual(after[stage].old, before[stage].old);
            assert.equal(after[stage].migrated, before[stage].migrated);
        }
    } finally {
        Object.assign(Config.ANALYSIS_CONFIG, original);
        require.cache[modulePath] = originalModule;
    }
});

test('旧完整阶段原样复用，证据变化后用当前版本和实际请求容量重建', async () => {
    const stage = 'structureRepair';
    const input = validAnalysisText();
    const source = '旧官方证据。';
    const paper = { arxivId: '2610.02582', title: '同一论文', analysisStageCheckpoints: { primaryAnalysis: input } };
    const evidence = deep.buildStageEvidenceContext(stage, input, source);
    const oldFingerprint = deep.buildTextStageFingerprint(stage, input, evidence, 'analysis-prompt-text-v2');
    const manifest = { version: 1, stages: { structureRepair: {
        status: 'complete', fingerprint: oldFingerprint, promptTextContract: 'analysis-prompt-text-v2'
    } } };
    paper.analysisManifest = manifest;
    const reused = deep.prepareTextRecoveryStage(paper, manifest, stage, input, source);
    assert.equal(reused.invalidated, false);
    assert.equal(reused.fingerprint, oldFingerprint);
    const changed = deep.prepareTextRecoveryStage(paper, manifest, stage, input, '新的官方证据，内容确实变化。');
    assert.equal(changed.invalidated, true);
    assert.equal(changed.promptTextContract, deep.currentPromptTextContract(stage));
    assert.equal(changed.fingerprint, deep.buildTextStageFingerprint(stage,
        changed.inputAnalysis, changed.evidenceContext, changed.promptTextContract, {}));
    let actualBudget;
    const current = input.replace('## 毒舌点评\n', '## 论文评价\n');
    const repaired = await deep.repairMissingAnalysisSections(paper, input, '新的官方证据，内容确实变化。',
        changed.evidenceContext, { requireCurrentEvaluationTitle: true,
            callModelFn: async (messages, budget) => { actualBudget = budget; return current; } });
    assert.equal(actualBudget, Config.ANALYSIS_CONFIG.structureMaxTokens);
    assert.equal(repaired, deep.normalizeAnalysisStructure(current));
});
