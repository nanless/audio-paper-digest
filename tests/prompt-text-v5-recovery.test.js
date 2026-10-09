'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const registry = require('../scripts/lib/prompt-text-versions.js');
const history = require('../scripts/lib/prompt-history.js');
const utils = require('../scripts/utils.js');
let capturedRequest;
// 只捕获正式评分入口构造的参数，返回认证拒绝；不连接模型服务。
utils.requestLlmJson = async (_url, _endpoint, _model, body) => {
    capturedRequest = body;
    return { statusCode: 401, body: { error: { message: 'synthetic request capture stop' } } };
};
const deep = require('../scripts/deep-analyzer.js');
const manual = require('../manual/scripts/manual-deep-analysis.js');
const { validAnalysisText } = require('./valid-analysis-fixture.js');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => fs.readFileSync(path.join(root, file));

const originalV4Sha = {
    primaryAnalysis: '5aaf208891833809e7cb01a43342a2ef289d6b7a265b9819cca99edc32c2c600',
    scoringAudit: '2950f487c529718ff3b67dae19adcead074c0e9418e3ea3a371e758fe29a6902'
};

test('评分新请求只选 v5，主分析保持 v4，Reader 保持 v3，旧 v4 原文件仍可按 SHA 读取', () => {
    assert.equal(registry.currentPromptTextContract('scoringAudit'), 'analysis-prompt-text-v5');
    assert.equal(registry.currentTextStagePromptPath('scoringAudit'), 'prompts/scoring-audit-v5.md');
    assert.equal(registry.currentPromptTextContract('primaryAnalysis'), 'analysis-prompt-text-v4');
    for (const stage of ['apiReaderArticle', 'apiReaderRepair']) {
        assert.equal(registry.currentPromptTextContract(stage), 'analysis-prompt-text-v3');
        assert.throws(() => registry.promptFilePathForContract(stage, 'analysis-prompt-text-v5'), /没有登记/);
    }
    assert.throws(() => registry.promptFilePathForContract('primaryAnalysis', 'analysis-prompt-text-v5'), /没有登记/);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'scoring-v4-empty-history-'));
    try {
        for (const [stage, expected] of Object.entries(originalV4Sha)) {
            const bytes = read(registry.promptFilePathForContract(stage, 'analysis-prompt-text-v4'));
            assert.equal(sha(bytes), expected);
            assert.deepEqual(history.promptBytesForSha256(stage, expected, empty), bytes);
        }
        assert.equal(history.promptBytesForSha256('scoringAudit', '0'.repeat(64), empty), null);
    } finally { fs.rmSync(empty, {recursive:true, force:true}); }
});

test('评分恢复读取声明的 v4 首块 SHA，不把旧版本核验成当前 v5', () => {
    const declared = '104ee6be726c03c270978912c7da93eb3226f08f87008857c3788c0a0487dc36';
    const saved = {promptTextContract:'analysis-prompt-text-v4',promptTemplateSha256:declared};
    const before = JSON.stringify(saved);
    const originalPath = registry.promptFilePathForContract('scoringAudit',saved.promptTextContract);
    assert.equal(deep.resolvedRuntimePromptTemplateSha256(saved.promptTemplateSha256,originalPath),declared);
    assert.equal(JSON.stringify(saved),before);
    assert.notEqual(deep.runtimePromptTemplateSha256(registry.currentTextStagePromptPath('scoringAudit')),declared);
    assert.notEqual(deep.resolvedRuntimePromptTemplateSha256('0'.repeat(64),originalPath),'0'.repeat(64));
});

test('Manual 旧主分析 v4 和评分 v4 的完整组合只读核验，混入旧 v3 评分或缺字段仍拒绝', () => {
    const current = manual.buildStagePromptBindings();
    const old = structuredClone(current);
    old.scoringAudit = {source:'prompts/scoring-audit-v4.md',sha256:originalV4Sha.scoringAudit};
    assert.equal(old.primaryAnalysis.sha256,originalV4Sha.primaryAnalysis);
    const spec = {version:6,modelPolicy:'manual-agents-sol-high-v2',promptSha256:old.primaryAnalysis.sha256,
        manualAuthoringPromptPath:'manual/prompts/manual-analysis-record-v2.md',
        manualAuthoringPromptSha256:sha(read('manual/prompts/manual-analysis-record-v2.md')),
        stagePromptSha256:Object.fromEntries(Object.entries(old).map(([stage,item])=>[stage,item.sha256]))};
    const before = JSON.stringify(spec);
    assert.deepEqual(manual.resolveManualSpecPromptBindings(spec),old);
    assert.equal(JSON.stringify(spec),before);
    const mixed = structuredClone(spec);
    mixed.stagePromptSha256.scoringAudit = sha(read('prompts/scoring-audit-v3.md'));
    assert.throws(()=>manual.resolveManualSpecPromptBindings(mixed), /SHA/);
    const missing = structuredClone(spec); delete missing.stagePromptSha256.revision;
    assert.throws(()=>manual.resolveManualSpecPromptBindings(missing), /SHA/);
    const unknown = structuredClone(spec); unknown.stagePromptSha256.scoringAudit='a'.repeat(64);
    assert.throws(()=>manual.resolveManualSpecPromptBindings(unknown), /SHA/);
    const extra = structuredClone(spec); extra.stagePromptSha256.unknownStage='a'.repeat(64);
    assert.throws(()=>manual.resolveManualSpecPromptBindings(extra), /SHA/);
    const fresh = structuredClone(spec);
    fresh.stagePromptSha256 = Object.fromEntries(Object.entries(current).map(([stage,item])=>[stage,item.sha256]));
    assert.deepEqual(manual.resolveManualSpecPromptBindings(fresh),current);
});

test('正式评分入口实际构造的新请求使用 v5 白话并保留工程分上限', async () => {
    capturedRequest = null;
    await assert.rejects(deep.auditTypeAwareScoringDetailed(validAnalysisText(), 'Synthetic source evidence.'), /synthetic request capture stop/);
    assert.ok(capturedRequest);
    const text = JSON.stringify(capturedRequest);
    assert.match(text,/仅用文字描述工程上的价值，或只给出间接指标/);
    assert.match(text,/只声称有工程上的价值、没有测量结果或可复用的研究材料时，工程\/实践价值最高 1\.0/);
    assert.doesNotMatch(text,/只有工程叙述或间接指标/);
    assert.equal(capturedRequest.max_tokens ?? capturedRequest.max_output_tokens,16000);
});
