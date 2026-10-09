'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const deep = require('../scripts/deep-analyzer.js');
const contract = require('../scripts/lib/model-text-sanitization.js');
const engine = require('../scripts/analysis-engine.js');
const conference = require('../scripts/lib/conference-analysis-context.js');

// 旧实现没有这项指纹字段。只移除新增字段，在真实阶段构造器中生成旧检查点。
function legacyDeep() {
    const filename = require.resolve('../scripts/deep-analyzer.js');
    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    const originalRequire = loaded.require.bind(loaded);
    loaded.require = name => name === './lib/model-text-sanitization.js'
        ? { ...contract, modelTextFingerprintFields: () => ({}) }
        : originalRequire(name);
    loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
    return loaded.exports;
}

const legacy = legacyDeep();

test('旧文本阶段仅在真实合法非 BMP 输入时失效，恢复保留前阶段输入', () => {
    for (const text of ['数学 𝑥，作者𠮷田 😀', '普通中文 x', '孤立\ud800及\udc00', '字面量 \\uD835\\uDC65']) {
        const source = `Evidence: ${text}. `.repeat(100);
        const evidence = legacy.buildStageEvidenceContext('revision', text, source);
        const oldFingerprint = legacy.buildTextStageFingerprint('revision', text, evidence);
        const paper = { analysisCheckpoint: text, analysisStageCheckpoints: { demoLinkScan: text } };
        const manifest = { version: 1, stages: { demoLinkScan: { status: 'complete' },
            revision: { status: 'complete', fingerprint: oldFingerprint } } };
        const result = deep.prepareTextRecoveryStage(paper, manifest, 'revision', text, source);
        const affected = text.includes('𝑥');
        assert.equal(result.invalidated, affected, text);
        assert.equal(manifest.stages.revision?.status === 'complete', !affected, text);
        assert.equal(result.analysis, text);
        assert.equal(manifest.stages.demoLinkScan.status, 'complete');
    }
});

test('Unicode 迁移先保留正文、阶段和原来源 SHA，再清除恢复入口', () => {
    const paper = { analysis: '旧结果', analysisCheckpoint: '旧主分析检查点',
        analysisStageCheckpoints: { primaryAnalysis: '旧主分析检查点', revision: '旧审校' },
        analysisManifest: { version: 1, sourceAcquisition: { sourceSha256: 'a'.repeat(64) },
            stages: { primaryAnalysis: { status: 'complete', fingerprint: 'old-primary' },
                revision: { status: 'complete', fingerprint: 'old-revision' } }, contracts: { sample: 'old' } } };
    const original = structuredClone(paper);
    assert.equal(deep.resetLegacyModelTextRecovery(paper, paper.analysisManifest, { text: '原文 𝑥 = 𝑦' }), true);
    assert.deepEqual(paper.analysisManifest.stages, {});
    assert.equal(paper.analysisCheckpoint, undefined);
    const payload = deep.validateStaleAnalysisSnapshot(paper.analysisStaleSnapshots[0]);
    assert.deepEqual(payload.stages, original.analysisManifest.stages);
    assert.deepEqual(payload.sourceAcquisition, original.analysisManifest.sourceAcquisition);
    assert.deepEqual(payload.analysisStageCheckpoints, original.analysisStageCheckpoints);
    assert.equal(paper.analysisManifest.sourceAcquisition.sourceSha256, 'a'.repeat(64));
    assert.equal(paper.analysis, original.analysis);
});

test('生产复用需要已核验来源或新清洗记录，缺来源不能默认为安全', () => {
    const paper = { title: '普通标题', analysis: '普通结果', analysisManifest: { sourceAcquisition: {} } };
    assert.equal(contract.canReuseModelTextInputs(paper), false);
    assert.equal(contract.canReuseModelTextInputs(paper, { text: '普通全文' }), true);
    assert.equal(contract.canReuseModelTextInputs(paper, { text: '原文 𝑥' }), false);
    assert.equal(contract.canReuseModelTextInputs({ ...paper, analysis: '旧草稿 𠮷' }, { text: '普通全文' }), false);
    paper.analysisManifest.sourceAcquisition.modelTextSanitizationContract = contract.MODEL_TEXT_SANITIZATION_CONTRACT;
    assert.equal(contract.canReuseModelTextInputs(paper, { text: '原文 𝑥' }), true);
});

test('引擎两处快跳都会读取当前来源，旧数学输入进入重分析，新记录仍跳过', async () => {
    for (const locked of [false, true]) {
        for (const kind of ['unknown', 'bmp', 'supplementary', 'current']) {
            const id = `conference:test:2026:paper:${locked ? 'locked' : 'early'}-${kind}`;
            const paper = { id, title: 'test', analysisManifest: { sourceAcquisition: {},
                stages: { primaryAnalysis: { status: 'complete' } } } };
            if (kind === 'current') paper.analysisManifest.sourceAcquisition.modelTextSanitizationContract
                = contract.MODEL_TEXT_SANITIZATION_CONTRACT;
            let calls = 0;
            const run = () => engine.analyzeBatch([paper], {
                maxRetries: 0,
                shouldSkip: locked ? null : () => true,
                preparePaperLocked: locked ? value => ({ paper: value, skip: true }) : null,
                analyzeFn: async () => {
                    calls++;
                    const error = new Error('测试替身在任何模型调用前停止');
                    error.retryable = false;
                    throw error;
                }
            });
            const result = kind === 'unknown' ? await run() : await conference.withConferenceAnalysisSource({
                paperId: id, executionDir: path.resolve('/tmp/unicode-engine-source'),
                sourceDetails: { source: 'conference_pdf_text', text: kind === 'supplementary' ? '𝑥' : '普通原文' }
            }, run);
            const shouldRun = ['unknown', 'supplementary'].includes(kind);
            assert.equal(calls, shouldRun ? 1 : 0, `${locked}/${kind}`);
            assert.equal(result.stats.skipped, shouldRun ? 0 : 1, `${locked}/${kind}`);
        }
    }
});

test('主分析只给受影响输入加入清洗版本，旧结构成功状态保持只读', () => {
    for (const text of ['普通数学 x', '数学 𝑥']) {
        const paper = { arxivId: '2610.12345', title: text, authors: ['作者'], categories: ['cs.SD'] };
        const oldFingerprint = legacy.buildRecoveryFingerprints(paper, text, paper.arxivId).primaryAnalysis;
        const current = deep.buildRecoveryFingerprints(paper, text, paper.arxivId).primaryAnalysis;
        assert.equal(oldFingerprint === current, !text.includes('𝑥'));
    }
    const paper = require('./valid-analysis-fixture.js').validAnalysisPaper('2610.12345');
    const before = JSON.stringify(paper);
    assert.equal(engine.isSuccessfulAnalysisRecord(paper), true);
    assert.equal(contract.canReuseModelTextInputs(paper, { text: '旧来源 𝑥' }), false);
    assert.equal(engine.isSuccessfulAnalysisRecord(paper), true);
    assert.equal(JSON.stringify(paper), before);
});
