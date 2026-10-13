'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const prose = require('../scripts/lib/reader-resource-prose');
const environment = { PAPER_ANALYZER_MODEL: 'muse-spark-1.3-contributor', PAPER_ANALYZER_ENDPOINT: 'https://example.invalid/v1', PAPER_ANALYZER_API_KEY: 'test-never-sent', HTTPS_PROXY: 'http://127.0.0.1:1' };
Object.assign(process.env, environment);
const utils = require('../scripts/utils');
utils.loadEnvFile = () => Object.assign(process.env, environment);
utils.requestLlmJson = () => { throw new Error('本测试禁止网络'); };
const deep = require('../scripts/deep-analyzer');
const { stableHash, sha256 } = require('../scripts/lib/fresh-rewrite-run');

const source = 'Official source text and method evidence. '.repeat(200);
function resources(availability) {
    const quote = 'Our code is available at https://example.org/code';
    const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha256(source),
        resources: availability ? [{ type: 'third_party', origin: 'paper_source',
            originalUrl: 'https://example.org/code', finalUrl: 'https://example.org/code',
            availability, status: availability === 'available' ? 200 : null,
            sourceQuote: quote, sourceQuoteSha256: sha256(quote) }] : [] };
    return { ...body, identitySha256: stableHash(body) };
}
function evidence(identity, mode) {
    return deep.buildApiReaderEvidenceContext('', source, null, '2609.12345', null, identity, mode);
}
test('默认与显式关闭保持原证据字节，开关只改变真实新输入', () => {
    const identity = resources();
    const old = evidence(identity);
    assert.equal(old, evidence(identity, false));
    assert.match(old, /NONE: 未发现来源绑定且完成 HTTPS/);
    const natural = evidence(identity, true);
    assert.doesNotMatch(natural, /NONE:|不得声称|只有归属明确/);
    assert.match(natural, /代码、模型权重与完整系统的公开情况尚无法确认/);
    assert.notEqual(sha256(old), sha256(natural));
    assert.deepEqual(prose.fields(false), {});
    assert.throws(() => prose.enabled({}, { resourceProsePolicySha256: prose.POLICY_SHA }));
    assert.equal(prose.enabled({}, prose.fields(true)), true);
    assert.throws(() => prose.enabled({}, { ...prose.fields(true), resourceProsePolicySha256: '0'.repeat(64) }));
});
test('自然资源状态仍严核实际可达性及原引文身份，不推断作者开源或镜像', () => {
    const available = evidence(resources('available'), true);
    assert.match(available, /论文提到的外部链接当前可以访问/);
    assert.doesNotMatch(available, /已开源|镜像|权重可下载/);
    assert.match(evidence(resources('unavailable'), true), /当前无法访问/);
    assert.match(evidence(resources('temporarily_unreachable'), true), /当前可达情况尚无法确认/);
    for (const mutation of [body => { body.resources[0].availability = 'invented'; },
        body => { body.resources[0].sourceQuoteSha256 = '0'.repeat(64); },
        body => { body.resources[0].originalUrl = 'https://example.org/another'; }]) {
        const identity = resources('available');
        const { identitySha256, ...body } = identity;
        mutation(body);
        assert.throws(() => evidence({ ...body, identitySha256: stableHash(body) }, true));
    }
});
test('实际新提示覆盖有固定SHA，旧模板原文不变，v7指令不进入新渲染提示', () => {
    const old = '前文。代码开源、权重可下载、系统可运行是三件事，要分开说。后文。';
    assert.equal(prose.renderPrompt(old, false), old);
    const natural = prose.renderPrompt(old, true);
    assert.doesNotMatch(natural, /三件事，要分开说/);
    assert.match(natural, /分别陈述代码、权重和完整系统目前可确认/);
    assert.notEqual(sha256(natural), sha256(old));
    assert.match(prose.POLICY_SHA, /^[0-9a-f]{64}$/);
});

test('真实生成器身份保持旧缺省等同关闭，新实际输入和规则使身份改变且预算不变', async () => {
    const paper = { arxivId: '2609.12345', title: 'Resource evidence test' };
    const identity = resources();
    const legacyEvidence = evidence(identity);
    const old = (await deep.prepareApiReaderRetryIdentity(paper, '', legacyEvidence, {
        sourceText: source, readerResources: identity
    })).identity;
    const disabled = (await deep.prepareApiReaderRetryIdentity(paper, '', legacyEvidence, {
        sourceText: source, readerResources: identity, naturalResourceProse: false
    })).identity;
    assert.deepEqual(old, disabled);
    const natural = (await deep.prepareApiReaderRetryIdentity(paper, '', evidence(identity, true), {
        sourceText: source, readerResources: identity, naturalResourceProse: true
    })).identity;
    assert.notEqual(natural.inputFingerprint, old.inputFingerprint);
    assert.equal(natural.resourceProseContract, prose.CONTRACT);
    assert.equal(natural.resourceProsePolicySha256, prose.POLICY_SHA);
    assert.deepEqual(natural.model, old.model);
    assert.equal(natural.epoch, old.epoch);
    assert.equal(natural.promptSha256, old.promptSha256, '原v7模板文件未变，实际覆盖规则独立记SHA');
});

test('没有资源证据时执行指纹仍绑定实际提示覆盖，声明的新阶段可准确重算', () => {
    const old = deep.buildApiReaderExecutionFingerprint('base', '', null);
    assert.equal(old, deep.buildApiReaderExecutionFingerprint('base', '', null, null, undefined, false));
    const natural = deep.buildApiReaderExecutionFingerprint('base', '', null, null, undefined, true);
    assert.notEqual(natural, old);
    assert.equal(natural, deep.buildApiReaderExecutionFingerprint('base', '', null, null, prose.fields(true)));
    assert.throws(() => deep.buildApiReaderExecutionFingerprint('base', '', null, null,
        { ...prose.fields(true), resourceProsePolicySha256: '0'.repeat(64) }));
});

test('真实新正文写入分支与落盘后普通恢复指纹一致，不丢新资源阶段', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const Module = require('node:module');
    const filename = require.resolve('../scripts/deep-analyzer');
    const code = fs.readFileSync(filename, 'utf8');
    const begin = code.indexOf('            const apiReaderWriteContract = currentPromptTextContract');
    const end = code.indexOf("            markRecoveryStage(analysisManifest, 'apiReaderArticle'", begin);
    assert.ok(begin > 0 && end > begin);
    // 执行实际落盘分支的完整指纹表达式；不另写一个近似实现或替换参数。
    const writeCode = code.slice(begin, end);
    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    loaded._compile(code + `\nmodule.exports.__writeResourceFingerprint = function(analysisManifest, apiReaderEvidenceContext, sourceDetails, readerCapabilityPolicy, arxivId, naturalResourceProse) {\n${writeCode}\nreturn apiReaderWriteFingerprint;\n};`, filename);
    const manifest = { version: 1, stages: {} };
    const fingerprint = loaded.exports.__writeResourceFingerprint(manifest, '', { structuredArtifacts: null }, null, '2609.12345', true);
    deep.markRecoveryStage(manifest, 'apiReaderArticle', 'complete', {
        fingerprint, ...prose.fields(true), attempts: 1, model: 'muse-spark-1.3-contributor'
    });
    const saved = JSON.parse(JSON.stringify(manifest));
    const restored = loaded.exports.__writeResourceFingerprint(saved, '', { structuredArtifacts: null }, null, '2609.12345', false);
    assert.equal(restored, fingerprint, '退出显式opt-in后按阶段声明恢复仍须同一实际写入指纹');
    assert.equal(saved.stages.apiReaderArticle.status, 'complete');
    assert.equal(saved.stages.apiReaderArticle.attempts, 1);
    assert.deepEqual(saved, manifest);
});
