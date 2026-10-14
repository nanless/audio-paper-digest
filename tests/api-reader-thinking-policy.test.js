'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { buildRequestBody } = require('../scripts/utils.js');
const analyzer = require('../scripts/deep-analyzer.js');

test('长文请求通过公共路由发送实际推理参数，其余阶段不发送', async t => {
    const bodies = [];
    const server = http.createServer((request, response) => {
        let text = '';
        request.on('data', chunk => { text += chunk; });
        request.on('end', () => {
            bodies.push(JSON.parse(text));
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ choices: [{ message: { content: '本地响应' }, finish_reason: 'stop' }] }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
    for (const stage of ['apiReaderArticle', 'apiReaderRepair', 'apiReaderImageProbe', 'primaryAnalysis']) {
        assert.equal(await analyzer.callModelWithConfig([{ role: 'user', content: '本地请求' }], 100, 1, {
            model: 'mimo-v2.6-flash', endpoint, key: 'synthetic',
            readerThinkingMode: 'disabled', usageContext: { stage }, usageSink() {}
        }), '本地响应');
    }
    for (const body of bodies.slice(0, 3)) assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(Object.hasOwn(bodies[3], 'thinking'), false);
    assert.equal(bodies.length, 4);
});

test('推理参数只适用准确模型和协议，非法值不能进入请求', () => {
    const messages = [{ role: 'user', content: '请求' }];
    assert.deepEqual(buildRequestBody('openai', 'mimo-v2.6-flash', messages, 100, 0,
        { readerThinkingMode: 'enabled' }).thinking, { type: 'enabled' });
    for (const [protocol, model] of [['unknown', 'mimo-v2.6-flash'], ['anthropic', 'mimo-v2.6-flash'],
        ['openai', 'other-model'], ['openai_responses', 'mimo-v2.6-flash']]) {
        assert.equal(Object.hasOwn(buildRequestBody(protocol, model, messages, 100, 0,
            { readerThinkingMode: 'disabled' }), 'thinking'), false);
    }
    assert.equal(Object.hasOwn(buildRequestBody('openai', 'mimo-v2.6-flash', messages, 100, 0), 'thinking'), false);
    assert.throws(() => buildRequestBody('openai', 'mimo-v2.6-flash', messages, 100, 0,
        { readerThinkingMode: 'invalid' }), /推理模式/);
});

test('当前长文策略改变指纹，旧完整阶段不补策略，伪声明拒绝', t => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const childProcess = require('node:child_process');
    const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reader-policy-public-')));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const project = path.resolve(__dirname, '..');
    for (const directory of ['scripts', 'manual', 'prompts', 'config']) {
        fs.cpSync(path.join(project, directory), path.join(folder, directory), { recursive: true });
    }
    require('./helpers/git-prompt-evidence-workspace.cjs').installFixtureGitObjectStore(folder, project);
    fs.symlinkSync(path.join(project, 'node_modules'), path.join(folder, 'node_modules'), 'dir');
    fs.writeFileSync(path.join(folder, '.env'), 'PAPER_ANALYZER_API_KEY=synthetic\nPAPER_ANALYZER_MODEL=mimo-v2.6-flash\nPAPER_ANALYZER_ENDPOINT=http://127.0.0.1:9/v1\n', { mode: 0o600 });
    const program = `
const assert = require('node:assert/strict');
const analyzer = require('./scripts/deep-analyzer.js');
const Config = require('./scripts/config.js');
const { currentPromptTextContract } = require('./scripts/lib/prompt-text-versions.js');
    const paper = { id: '2610.90001', title: '实际策略测试' };
    const fingerprint = stage => analyzer.buildRecoveryFingerprints(paper, '来源', paper.id,
        { stages: { apiReaderArticle: stage } }).apiReaderArticle;
    const original = Config.ANALYSIS_CONFIG.apiReaderThinkingMode;
    try {
        Config.ANALYSIS_CONFIG.apiReaderThinkingMode = 'disabled';
        const oldStage = { status: 'complete' };
        const oldBytes = JSON.stringify(oldStage);
        const oldFingerprint = fingerprint(oldStage);
        const current = fingerprint({ status: 'pending' });
        const currentContracts = { promptTextContract: currentPromptTextContract('apiReaderArticle'),
            repairPromptTextContract: currentPromptTextContract('apiReaderRepair') };
        const policy = { contract: 'api-reader-thinking-policy-v1', model: 'mimo-v2.6-flash', thinkingMode: 'disabled' };
        const jsonPolicy = { contract: 'api-reader-json-request-policy-v1', model: 'mimo-v2.6-flash', responseFormat: 'json_object' };
        const oldThinkingOnly = { status: 'complete', ...currentContracts, readerRequestPolicy: policy };
        const oldThinkingBytes = JSON.stringify(oldThinkingOnly);
        const oldThinkingFingerprint = fingerprint(oldThinkingOnly);
        assert.notEqual(oldThinkingFingerprint, current);
        assert.equal(fingerprint(oldThinkingOnly), oldThinkingFingerprint);
        assert.equal(JSON.stringify(oldThinkingOnly), oldThinkingBytes);
        assert.equal(fingerprint({ status: 'complete', ...currentContracts, readerRequestPolicy: policy, readerJsonRequestPolicy: jsonPolicy }), current);
        Config.ANALYSIS_CONFIG.apiReaderThinkingMode = 'enabled';
        assert.notEqual(fingerprint({ status: 'pending' }), current);
        assert.notEqual(fingerprint({ status: 'complete', ...currentContracts, readerRequestPolicy: policy, readerJsonRequestPolicy: jsonPolicy }), current);
        assert.notEqual(fingerprint(oldThinkingOnly), oldThinkingFingerprint);
        assert.equal(JSON.stringify(oldThinkingOnly), oldThinkingBytes);
        assert.equal(fingerprint(oldStage), oldFingerprint);
        assert.equal(JSON.stringify(oldStage), oldBytes);
        for (const invalid of [{ ...policy, contract: 'other' }, { ...policy, model: 'other' },
            { ...policy, thinkingMode: 'bad' }, { ...policy, extra: true }]) {
            assert.throws(() => fingerprint({ status: 'complete', readerRequestPolicy: invalid }), /策略不安全/);
        }
    } finally { Config.ANALYSIS_CONFIG.apiReaderThinkingMode = original; }
`;
    const result = childProcess.spawnSync(process.execPath, ['-e', program], { cwd: folder, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('推理模式默认关闭，项目环境覆写只接受两个明确值', t => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-thinking-config-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    fs.cpSync(path.resolve(__dirname, '../scripts'), path.join(folder, 'scripts'), { recursive: true });
    const childProcess = require('node:child_process');
    const configPath = path.join(folder, 'scripts/config.js');
    for (const mode of ['', 'enabled', 'disabled', 'invalid']) {
        fs.writeFileSync(path.join(folder, '.env'), mode ? `PD_API_READER_THINKING_MODE=${mode}\n` : '', { mode: 0o600 });
        const env = { ...process.env };
        if (mode) env.PD_API_READER_THINKING_MODE = mode;
        else delete env.PD_API_READER_THINKING_MODE;
        const result = childProcess.spawnSync(process.execPath, ['-e',
            `process.stdout.write(require(${JSON.stringify(configPath)}).ANALYSIS_CONFIG.apiReaderThinkingMode)`],
        { env, encoding: 'utf8' });
        if (mode === 'invalid') {
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /enabled.*disabled/);
        } else {
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stdout, mode || 'disabled');
        }
    }
});
