'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const resourceBinding = require('../scripts/lib/reader-resource-binding');
const deep = require('../scripts/deep-analyzer');
const projectUrl = 'https://project.example/demo';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function createResourceSample(sourceText) {
    return {
        sourceText,
        analysis: `## 机器摘要\nhas_code: 否\nhas_model: 否\nhas_dataset: 否\n## 开源详情\n- 代码：${projectUrl}\n- 模型权重：${projectUrl}`
    };
}

async function buildSampleIdentity(sample, status = 200) {
    let requests = 0;
    const identity = await deep.buildApiReaderResourceIdentity(sample.analysis, sample.sourceText, {}, {
        validateUrlImpl: async url => new URL(url),
        requestImpl: async () => {
            requests += 1;
            return { status, headers: { get: () => null } };
        }
    });
    assert.equal(requests, 1);
    assert.equal(identity.sourceTextSha256, hash(sample.sourceText));
    for (const resource of identity.resources) {
        assert.ok(sample.sourceText.includes(resource.sourceQuote));
        assert.equal(resource.sourceQuoteSha256, hash(resource.sourceQuote));
        assert.equal(resource.originalUrl, projectUrl);
        assert.equal(resourceBinding.paperSourceQuoteBindsOriginalUrl(resource), true);
        assert.equal(resource.documentationEvidence, undefined);
    }
    return identity;
}

test('模型复数与代码同一公开声明生成两个来源类型', async () => {
    const sample = createResourceSample(`Code and models are available at ${projectUrl}.`);
    assert.deepEqual(resourceBinding.paperSourceResourceFacets(sample.sourceText, projectUrl), ['code', 'model']);
    const identity = await buildSampleIdentity(sample);
    assert.deepEqual(identity.resources.map(resource => resource.type), ['code', 'model']);
    assert.ok(identity.resources.every(resource => resource.availability === 'available'));
    assert.match(deep.applyApiReaderResourceAvailability(sample.analysis, identity), /has_code: 是/);
    assert.match(deep.applyApiReaderResourceAvailability(sample.analysis, identity), /has_model: 是/);
    assert.doesNotMatch(JSON.stringify(identity), /license|许可证|repositoryContents/);
});

test('声明归属与项目入口可达状态分别保存，失败入口不提升代码或模型资格', async () => {
    const sample = createResourceSample(`Code and models are available at ${projectUrl}.`);
    const identity = await buildSampleIdentity(sample, 404);
    assert.deepEqual(identity.resources.map(resource => resource.type), ['code', 'model']);
    assert.ok(identity.resources.every(resource => resource.availability !== 'available'));
    assert.match(deep.applyApiReaderResourceAvailability(sample.analysis, identity), /has_code: 否/);
    assert.match(deep.applyApiReaderResourceAvailability(sample.analysis, identity), /has_model: 否/);
});

test('模型单数、权重和代码数据集旧资格保持', () => {
    for (const [statement, expected] of [
        ['Model weights are available', ['model']],
        ['Our model is available', ['model']],
        ['Our models are available', ['model']],
        ['Our code, models and datasets are available', ['code', 'model', 'dataset']]
    ]) {
        assert.deepEqual(resourceBinding.classifyPaperSourceResourceFacets(statement), expected);
    }
});

test('未知软件主体和明确第三方、未来与否定不会被模型复数吞掉', async () => {
    for (const statement of [
        'ExternalLib code and models are available',
        'OtherProject code and models are available',
        'Related work quotes: Code and models are available',
        'Other authors state: Code and models are available',
        '"Code and models are available',
        '> Code and models are available',
        'The baseline code and models are available',
        'We use code and models available',
        'Code and models are not available',
        'Code and models will be released'
    ]) {
        const sample = createResourceSample(`${statement} at ${projectUrl}.`);
        assert.deepEqual(resourceBinding.paperSourceResourceFacets(sample.sourceText, projectUrl), ['third_party']);
        const identity = await buildSampleIdentity(sample);
        assert.ok(identity.resources.every(resource => resource.type === 'third_party'));
        assert.match(deep.applyApiReaderResourceAvailability(sample.analysis, identity), /has_code: 否/);
        assert.match(deep.applyApiReaderResourceAvailability(sample.analysis, identity), /has_model: 否/);
    }
});
