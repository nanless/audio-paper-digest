'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const registry = require('../scripts/lib/prompt-text-versions.js');
const evidence = require('../scripts/lib/prompt-evidence');
const history = require('../scripts/lib/prompt-history.js');
const utils = require('../scripts/utils.js');
let capturedRequest;
// 只捕获正式评分入口构造的参数，返回认证拒绝；不连接模型服务。
utils.requestLlmJson = async (_url, _endpoint, _model, body) => {
    capturedRequest = body;
    return { statusCode: 401, body: { error: { message: 'synthetic request capture stop' } } };
};
const deep = require('../scripts/deep-analyzer.js');
const { validAnalysisText } = require('./valid-analysis-fixture.js');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => evidence.readPromptEvidenceBytes(file);

const originalV4Sha = {
    primaryAnalysis: '5aaf208891833809e7cb01a43342a2ef289d6b7a265b9819cca99edc32c2c600',
    scoringAudit: '2950f487c529718ff3b67dae19adcead074c0e9418e3ea3a371e758fe29a6902'
};

test('评分保持 v5，写作新提示使用主分析 v6 与 Reader v9/v13，旧 v4 仍按原 SHA 读取', () => {
    assert.equal(registry.currentPromptTextContract('scoringAudit'), 'analysis-prompt-text-v5');
    assert.equal(registry.currentTextStagePromptPath('scoringAudit'), 'prompts/scoring-audit-v5.md');
    assert.equal(registry.currentPromptTextContract('primaryAnalysis'), 'analysis-prompt-text-v6');
    for (const stage of ['apiReaderArticle', 'apiReaderRepair']) {
        assert.equal(registry.currentPromptTextContract(stage), stage === 'apiReaderRepair' ? 'analysis-prompt-text-v13' : 'analysis-prompt-text-v9');
        assert.equal(registry.promptFilePathForContract(stage, 'analysis-prompt-text-v4'), `prompts/${stage === 'apiReaderArticle' ? 'api-reader-article' : 'api-reader-repair'}-v4.md`);
        assert.equal(registry.promptFilePathForContract(stage, 'analysis-prompt-text-v5'), `prompts/${stage === 'apiReaderArticle' ? 'api-reader-article' : 'api-reader-repair'}-v5.md`);
    }
    assert.throws(() => registry.promptFilePathForContract('primaryAnalysis', 'analysis-prompt-text-v99'), /没有登记/);
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
