'use strict';
process.env.PAPER_ANALYZER_ENDPOINT = 'https://example.invalid/v1';
process.env.PAPER_ANALYZER_API_KEY = 'test-key';
process.env.PAPER_ANALYZER_MODEL = 'test-model';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const registry = require('../scripts/lib/prompt-text-versions.js');
const evidence = require('../scripts/lib/prompt-evidence');
const history = require('../scripts/lib/prompt-history.js');
const deep = require('../scripts/deep-analyzer.js');
const { validAnalysisText } = require('./valid-analysis-fixture.js');

test('主分析和评分分别读取旧 v3 与 v4，旧原字节不被当前版本替代', () => {
    const names = { primaryAnalysis: 'deep-analysis', scoringAudit: 'scoring-audit' };
    const originalV3Sha = {
        primaryAnalysis: 'ad04165708b244182d17341a682027fa055e5be121e4488bf0e17cb9a296ccd2',
        scoringAudit: 'bd64302977f6f9f7ba4290721cbf96d192100f33b9014f247f05824b3633f121'
    };
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-v3-empty-history-'));
    try {
        for (const [stage, name] of Object.entries(names)) {
            const oldPath = `prompts/${name}-v3.md`, newPath = `prompts/${name}-v4.md`;
            assert.equal(registry.promptFilePathForContract(stage, 'analysis-prompt-text-v3'), oldPath);
            assert.equal(registry.promptFilePathForContract(stage, 'analysis-prompt-text-v4'), newPath);
            assert.equal(registry.currentTextStagePromptPath(stage), `prompts/${name}-v${stage === 'primaryAnalysis' ? 6 : 5}.md`);
            assert.equal(registry.currentPromptTextContract(stage), stage === 'primaryAnalysis' ? 'analysis-prompt-text-v6' : 'analysis-prompt-text-v5');
            const oldBytes = evidence.readPromptEvidenceBytes(oldPath);
            const sha = crypto.createHash('sha256').update(oldBytes).digest('hex');
            assert.equal(sha, originalV3Sha[stage], `${stage} 已发布的 v3 原字节必须保持`);
            assert.deepEqual(history.promptBytesForSha256(stage, sha, empty), oldBytes);
            assert.notEqual(deep.runtimePromptTemplateSha256(oldPath), deep.runtimePromptTemplateSha256(newPath));
            assert.throws(() => registry.promptFilePathForContract(stage, 'analysis-prompt-text-v99'), /没有登记/);
        }
    } finally { fs.rmSync(empty, {recursive:true, force:true}); }
});

test('主分析旧 v3 与当前版本按各自声明计算指纹，读取不改写原记录', () => {
    const paper = {arxivId:'2610.90001',title:'Test paper',authors:['A'],categories:['cs.SD']};
    const manifest = {version:1,stages:{primaryAnalysis:{status:'complete',promptTextContract:'analysis-prompt-text-v3'}}};
    const before = JSON.stringify({paper,manifest});
    const old = deep.buildRecoveryFingerprints(paper,'actual full text input',paper.arxivId,manifest).primaryAnalysis;
    assert.equal(JSON.stringify({paper,manifest}),before);
    const current = deep.buildRecoveryFingerprints(paper,'actual full text input',paper.arxivId,{version:1,stages:{}}).primaryAnalysis;
    assert.notEqual(old,current);
    assert.equal(deep.buildRecoveryFingerprints(paper,'actual full text input',paper.arxivId,{version:1,stages:{primaryAnalysis:{status:'complete',promptTextContract:registry.currentPromptTextContract('primaryAnalysis')}}}).primaryAnalysis,current);
});

test('读取历史 v4 首块变化只影响 v4 指纹，旧 v3 保持原样', () => {
    const paper = {arxivId:'2610.90001',title:'Test paper',authors:['A'],categories:['cs.SD']};
    const fingerprint = contract => deep.buildRecoveryFingerprints(paper,'actual full text input',paper.arxivId,{version:1,stages:{primaryAnalysis:{status:'complete',promptTextContract:contract}}}).primaryAnalysis;
    const old = fingerprint('analysis-prompt-text-v3'), current = fingerprint('analysis-prompt-text-v4');
    const file = 'prompts/deep-analysis-v4.md';
    const bytes = evidence.readPromptEvidenceBytes(file), read = evidence.readPromptEvidenceBytes;
    // 隔离指纹计算的输入变化；真实Git证据完整性由共享读取器的独立测试覆盖。
    evidence.readPromptEvidenceBytes = function(filename,options) {
        if(String(filename) !== file) return read.apply(this,arguments);
        return Buffer.from(bytes.toString('utf8').replace('请依据下方文本分析','请认真依据下方文本分析'));
    };
    try {
        assert.equal(fingerprint('analysis-prompt-text-v3'),old);
        assert.notEqual(fingerprint('analysis-prompt-text-v4'),current);
    } finally { evidence.readPromptEvidenceBytes=read; }
    assert.deepEqual(evidence.readPromptEvidenceBytes(file),bytes);
});
