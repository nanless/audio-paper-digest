'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const childProcess = require('node:child_process');
const deep = require('../scripts/deep-analyzer.js');
const utils = require('../scripts/utils.js');
const usage = require('../scripts/lib/llm-usage.js');

test('主分析实际请求关闭思考并记录同一策略，其他阶段和模型不发送该设置', async t => {
    const bodies = [];
    const server = http.createServer((request, response) => {
        let input = '';
        request.on('data', chunk => { input += chunk; });
        request.on('end', () => {
            bodies.push(JSON.parse(input));
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ choices: [{ message: { content: '收到' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const events = [];
    const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
    const config = { endpoint, key: 'synthetic-primary-policy', apiKeys: ['synthetic-primary-policy'], model: 'mimo-v2.6-flash', usageContext: { stage: 'primaryAnalysis' }, primaryThinkingMode: 'disabled', usageSink: event => events.push(event) };
    assert.equal(await deep.callModelWithConfig([{ role: 'user', content: '收到' }], 128, 1, config), '收到');
    assert.deepEqual(bodies[0].thinking, { type: 'disabled' });
    assert.deepEqual(events[0].primaryRequestPolicy, { contract: 'analysis-primary-thinking-policy-v1', model: 'mimo-v2.6-flash', thinkingMode: 'disabled' });
    for (const change of [{ usageContext: { stage: 'revision' } }, { model: 'other-model' }]) {
        await deep.callModelWithConfig([{ role: 'user', content: '收到' }], 128, 1, { ...config, ...change });
        assert.deepEqual(bodies.at(-1).thinking, change.model ? undefined : { type: 'disabled' });
        assert.equal(events.at(-1).primaryRequestPolicy, undefined);
    }
    assert.equal(utils.buildRequestBody('anthropic', 'mimo-v2.6-flash', [{ role: 'user', content: '收到' }], 128, 0.7, { usageContext: { stage: 'primaryAnalysis' }, primaryThinkingMode: 'disabled' }).thinking, undefined);
    assert.throws(() => utils.buildRequestBody('openai', 'mimo-v2.6-flash', [], 128, 0.7, { usageContext: { stage: 'primaryAnalysis' }, primaryThinkingMode: 'invalid' }), /推理模式/);
    assert.throws(() => utils.buildRequestBody('openai', 'mimo-v2.6-flash', [], 128, 0.7, { usageContext: { stage: 'primaryAnalysis' }, primaryThinkingMode: 'disabled', readerThinkingMode: 'enabled' }), /冲突/);
});

test('旧完整检查点按原配方保留，新声明与指纹不符及缺检查点不能复用', t => {
    const folder = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'primary-policy-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    for (const directory of ['scripts', 'manual', 'prompts', 'config']) {
        fs.cpSync(path.resolve(__dirname, '..', directory), path.join(folder, directory), { recursive: true });
    }
    fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(folder, 'node_modules'), 'dir');
    fs.writeFileSync(path.join(folder, '.env'), 'PAPER_ANALYZER_API_KEY=synthetic-primary-policy\nPAPER_ANALYZER_MODEL=mimo-v2.6-flash\nPAPER_ANALYZER_ENDPOINT=http://127.0.0.1:9/v1\n', { mode: 0o600 });
    const program = `
const assert = require('node:assert/strict');
const deep = require('./scripts/deep-analyzer.js');
const registry = require('./scripts/lib/prompt-text-versions.js');
const contract = registry.currentPromptTextContract('primaryAnalysis');
const paper = { arxivId: '2610.90091', title: '语音方法', authors: ['A'], categories: ['cs.SD'], analysisCheckpoint: '真实已保存正文', analysisStageCheckpoints: { primaryAnalysis: '真实已保存正文' } };
const oldFingerprint = deep.buildPrimaryAnalysisBaseFingerprint(contract, paper, '原来源', paper.arxivId);
const manifest = { stages: { primaryAnalysis: { status: 'complete', promptTextContract: contract, fingerprint: oldFingerprint }, revision: { status: 'complete', fingerprint: '旧下游' } } };
const original = JSON.stringify({ paper, manifest });
const expected = deep.buildRecoveryFingerprints(paper, '原来源', paper.arxivId, manifest).primaryAnalysis;
assert.equal(expected, oldFingerprint);
assert.equal(deep.invalidateRecoveryStageIfChanged(paper, manifest, 'primaryAnalysis', expected), false);
assert.equal(JSON.stringify({ paper, manifest }), original);
const policy = deep.resolvePrimaryRequestPolicy();
assert.deepEqual(policy, { contract: 'analysis-primary-thinking-policy-v1', model: 'mimo-v2.6-flash', thinkingMode: 'disabled' });
const current = deep.buildPrimaryAnalysisBaseFingerprint(contract, paper, '原来源', paper.arxivId, {});
assert.notEqual(current, oldFingerprint);
assert.equal(deep.buildRecoveryFingerprints(paper, '原来源', paper.arxivId, { stages: { primaryAnalysis: { status: 'complete', promptTextContract: contract, fingerprint: current, primaryRequestPolicy: policy } } }).primaryAnalysis, current);
const forged = JSON.parse(original);
forged.manifest.stages.primaryAnalysis.primaryRequestPolicy = policy;
assert.equal(deep.invalidateRecoveryStageIfChanged(forged.paper, forged.manifest, 'primaryAnalysis', deep.buildRecoveryFingerprints(forged.paper, '原来源', paper.arxivId, forged.manifest).primaryAnalysis), true);
assert.equal(forged.manifest.stages.primaryAnalysis, undefined);
const absent = { ...paper, analysisCheckpoint: '', analysisStageCheckpoints: {} };
assert.notEqual(deep.buildRecoveryFingerprints(absent, '原来源', paper.arxivId, manifest).primaryAnalysis, oldFingerprint);
assert.notEqual(deep.buildRecoveryFingerprints(paper, '不同来源', paper.arxivId, manifest).primaryAnalysis, oldFingerprint);
for (const bad of [{ ...policy, thinkingMode: 'bad' }, { ...policy, extra: true }, null]) {
    assert.throws(() => deep.buildRecoveryFingerprints(paper, '原来源', paper.arxivId, { stages: { primaryAnalysis: { status: 'complete', primaryRequestPolicy: bad } } }), /请求推理设置无效/);
}
console.log('primary-policy-assertions-completed');
`;
    const result = childProcess.spawnSync(process.execPath, ['-e', program], { cwd: folder, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /primary-policy-assertions-completed/);
});
