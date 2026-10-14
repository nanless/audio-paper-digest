'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { buildRequestBody } = require('../scripts/utils.js');
const analyzer = require('../scripts/deep-analyzer.js');

test('局部修复请求通过公共路由发送实际推理参数，其余阶段不发送', async t => {
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
    for (const stage of ['coreSummaryRepair', 'structureRepair', 'tableRepair', 'primaryAnalysis', 'revision']) {
        assert.equal(await analyzer.callModelWithConfig([{ role: 'user', content: '本地请求' }], 100, 1, {
            model: 'mimo-v2.6-flash', endpoint, key: 'synthetic',
            repairThinkingMode: 'disabled', usageContext: { stage }, usageSink() {}
        }), '本地响应');
    }
    for (const body of bodies.slice(0, 3)) assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(Object.hasOwn(bodies[3], 'thinking'), false);
    assert.deepEqual(bodies[4].thinking, { type: 'disabled' });
    assert.equal(bodies.length, 5);
});

test('推理参数只适用准确模型和协议，非法值不能进入请求', () => {
    const messages = [{ role: 'user', content: '请求' }];
    assert.deepEqual(buildRequestBody('openai', 'mimo-v2.6-flash', messages, 100, 0,
        { repairThinkingMode: 'enabled' }).thinking, { type: 'enabled' });
    for (const [protocol, model] of [['unknown', 'mimo-v2.6-flash'], ['anthropic', 'mimo-v2.6-flash'],
        ['openai', 'other-model'], ['openai_responses', 'mimo-v2.6-flash']]) {
        assert.equal(Object.hasOwn(buildRequestBody(protocol, model, messages, 100, 0,
            { repairThinkingMode: 'disabled' }), 'thinking'), false);
    }
    assert.equal(Object.hasOwn(buildRequestBody('openai', 'mimo-v2.6-flash', messages, 100, 0), 'thinking'), false);
    assert.throws(() => buildRequestBody('openai', 'mimo-v2.6-flash', messages, 100, 0,
        { repairThinkingMode: 'invalid' }), /推理模式/);
    assert.throws(() => buildRequestBody('openai', 'mimo-v2.6-flash', messages, 100, 0,
        { readerThinkingMode: 'enabled', repairThinkingMode: 'disabled' }), error => error.code === 'REQUEST_THINKING_POLICY_CONFLICT');
});

test('局部修复旧完成指纹保留，失效后新策略进入实际修复请求', t => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const cp = require('node:child_process');
    const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repair-policy-public-')));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const project = path.resolve(__dirname, '..');
    for (const name of ['scripts', 'manual', 'prompts', 'config', 'tests']) fs.cpSync(path.join(project, name), path.join(folder, name), { recursive: true });
    require('./helpers/git-prompt-evidence-workspace.cjs').installFixtureGitObjectStore(folder, project);
    fs.symlinkSync(path.join(project, 'node_modules'), path.join(folder, 'node_modules'), 'dir');
    fs.writeFileSync(path.join(folder, '.env'), 'PAPER_ANALYZER_API_KEY=synthetic\nPAPER_ANALYZER_MODEL=mimo-v2.6-flash\nPAPER_ANALYZER_ENDPOINT=http://127.0.0.1:9/v1\n', { mode: 0o600 });
    const program = `
const assert = require('node:assert/strict');
const deep = require('./scripts/deep-analyzer.js');
const Config = require('./scripts/config.js');
const input = require('./tests/valid-analysis-fixture.js').validAnalysisText();
(async () => {
for (const stage of ['coreSummaryRepair','structureRepair','tableRepair']) {
 const contract = deep.currentPromptTextContract(stage);
 const fp = declared => deep.buildTextStageFingerprint(stage,input,'证据',contract,declared);
 const legacy = fp(undefined);
 assert.equal(fp({status:'complete'}),legacy);
 assert.equal(fp({status:'not_needed'}),legacy);
 const policy = deep.resolveRepairRequestPolicy(stage);
 assert.equal(policy.thinkingMode,'disabled');
 const current = fp({});
 assert.notEqual(current,legacy);
 assert.equal(fp({status:'complete',repairRequestPolicy:policy}),current);
 Config.ANALYSIS_CONFIG.repairThinkingMode='enabled';
 assert.notEqual(fp({}),current);
 assert.notEqual(fp({status:'complete',repairRequestPolicy:policy}),current);
 assert.equal(fp({status:'complete'}),legacy);
 Config.ANALYSIS_CONFIG.repairThinkingMode='disabled';
 for(const bad of [{...policy,contract:'bad'},{...policy,model:'bad'},{...policy,thinkingMode:'bad'},{...policy,extra:true}]) assert.throws(()=>fp({repairRequestPolicy:bad}),/策略不安全/);
}
assert.equal(deep.resolveRepairRequestPolicy('revision'),null);
const stage='structureRepair';
const paper={arxivId:'2610.90001',title:'正常修复',analysisStageCheckpoints:{primaryAnalysis:input}};
const evidence=deep.buildStageEvidenceContext(stage,input,'旧来源');
const old=deep.buildTextStageFingerprint(stage,input,evidence,'analysis-prompt-text-v2');
const manifest={version:1,stages:{structureRepair:{status:'complete',fingerprint:old,promptTextContract:'analysis-prompt-text-v2'}}};
paper.analysisManifest=manifest;
assert.equal(deep.prepareTextRecoveryStage(paper,manifest,stage,input,'旧来源').invalidated,false);
const prepared=deep.prepareTextRecoveryStage(paper,manifest,stage,input,'新的来源确实不同');
assert.equal(prepared.invalidated,true);
assert.deepEqual(prepared.repairRequestPolicy,deep.resolveRepairRequestPolicy(stage));
assert.equal(prepared.fingerprint,deep.buildTextStageFingerprint(stage,prepared.inputAnalysis,prepared.evidenceContext,prepared.promptTextContract,{}));
let calls=0;
const normalized=input.replace('## 毒舌点评\\n','## 论文评价\\n');
const result=await deep.repairMissingAnalysisSections(paper,input,'新的来源确实不同',prepared.evidenceContext,{requireCurrentEvaluationTitle:true,callModelFn:async(messages,budget,options)=>{calls++;assert.equal(options.repairThinkingMode,'disabled');assert.equal(options.usageContext.stage,stage);return normalized;}});
for (const status of ['complete','not_needed']) {
 const stored={version:1,stages:{structureRepair:{status,fingerprint:prepared.fingerprint,promptTextContract:prepared.promptTextContract,repairRequestPolicy:prepared.repairRequestPolicy}}};
 const savedPaper={...paper,analysisManifest:stored,analysisStageCheckpoints:{primaryAnalysis:input}};
 const again=deep.prepareTextRecoveryStage(savedPaper,stored,stage,input,'新的来源确实不同');
 assert.equal(again.invalidated,false);
 assert.equal(again.fingerprint,prepared.fingerprint);
 Config.ANALYSIS_CONFIG.repairThinkingMode='enabled';
 const mismatch=deep.prepareTextRecoveryStage(savedPaper,stored,stage,input,'新的来源确实不同');
 assert.equal(mismatch.compatibilityReused,false);
 assert.equal(mismatch.invalidated,true);
 assert.equal(mismatch.repairRequestPolicy.thinkingMode,'enabled');
 Config.ANALYSIS_CONFIG.repairThinkingMode='disabled';
}
assert.equal(calls,1);
assert.equal(result,deep.normalizeAnalysisStructure(normalized));
})().catch(error=>{console.error(error);process.exitCode=1});
`;
    const result = cp.spawnSync(process.execPath, ['-e', program], { cwd: folder, encoding: 'utf8' });
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
        fs.writeFileSync(path.join(folder, '.env'), mode ? `PD_ANALYSIS_REPAIR_THINKING_MODE=${mode}\n` : '', { mode: 0o600 });
        const env = { ...process.env };
        if (mode) env.PD_ANALYSIS_REPAIR_THINKING_MODE = mode;
        else delete env.PD_ANALYSIS_REPAIR_THINKING_MODE;
        const result = childProcess.spawnSync(process.execPath, ['-e',
            `process.stdout.write(require(${JSON.stringify(configPath)}).ANALYSIS_CONFIG.repairThinkingMode)`],
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
